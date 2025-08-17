// app.js (CommonJS)
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Stripe = require('stripe');

// ===== ENV =====
// Set these in Render → Environment
const {
  STRIPE_SECRET_KEY,          // sk_test_... or sk_live_...
  STRIPE_WEBHOOK_SECRET,      // whsec_...
  CLERK_API_KEY,              // sk_test_... or sk_live_... (Clerk API key)
  N8N_USER_CHECK_WEBHOOK,     // https://davidmcinema.app.n8n.cloud/webhook/bvcc-user-id-check
  ALLOWED_ORIGINS,            // comma-separated origins, optional
  PORT = 3000
} = process.env;

if (!STRIPE_SECRET_KEY) {
  console.error('Missing STRIPE_SECRET_KEY');
  process.exit(1);
}
const stripe = new Stripe(STRIPE_SECRET_KEY);

const app = express();

// ===== CORS =====
const allowList = (ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowList.length === 0) return cb(null, true);
    if (allowList.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin ${origin}`));
  }
}));

// Stripe webhook needs raw body
app.use('/api/stripe-webhook-to-clerk', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== In-memory sessions (as you had) =====
const sessions = new Map();

// ===== Health =====
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ===== n8n callback: initial/regenerated images (UNCHANGED behavior) =====
app.post('/api/callback/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const imageData = req.body;
  const existingSession = sessions.get(sessionId);

  if (existingSession && existingSession.status === 'completed') {
    existingSession.hook_image_url = imageData.hook_image_url;
    existingSession.agitation_image_url = imageData.agitation_image_url;
    existingSession.solution_image_url = imageData.solution_image_url;
    existingSession.cta_image_url = imageData.cta_image_url;
    existingSession.regenerated = true;
    existingSession.regeneratedAt = new Date().toISOString();
    sessions.set(sessionId, existingSession);
  } else {
    if (!imageData.hook_image_url || !imageData.agitation_image_url ||
        !imageData.solution_image_url || !imageData.cta_image_url) {
      return res.status(400).json({ error: 'Missing required image URLs for initial callback' });
    }
    sessions.set(sessionId, { ...imageData, timestamp: new Date().toISOString(), status: 'completed' });
  }

  // cleanup (2h)
  const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
  sessions.forEach((value, key) => {
    const t = new Date(value.timestamp).getTime();
    if (t < twoHoursAgo) sessions.delete(key);
  });

  return res.json({ success: true, message: 'Images received successfully', sessionId });
});

// ===== Polling endpoints (UNCHANGED behavior) =====
app.get('/api/check-images/:sessionId', (req, res) => {
  const s = sessions.get(req.params.sessionId);
  if (!s || s.status !== 'completed') return res.json({ status: 'pending' });
  res.json({
    status: 'completed',
    hook_image_url: s.hook_image_url,
    agitation_image_url: s.agitation_image_url,
    solution_image_url: s.solution_image_url,
    cta_image_url: s.cta_image_url
  });
});
app.get('/api/check-regenerated-images/:sessionId', (req, res) => {
  const s = sessions.get(req.params.sessionId);
  if (!s || !s.regenerated) return res.json({ status: 'pending' });
  const payload = {
    status: 'regenerated',
    hook_image_url: s.hook_image_url,
    agitation_image_url: s.agitation_image_url,
    solution_image_url: s.solution_image_url,
    cta_image_url: s.cta_image_url
  };
  delete s.regenerated;
  sessions.set(req.params.sessionId, s);
  res.json(payload);
});

// ===== BrandVoice user check proxy (uses env URL) =====
app.post('/api/check-user', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const fetchImpl = global.fetch || (await import('node-fetch')).default;
    const resp = await fetchImpl(N8N_USER_CHECK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    if (!resp.ok) throw new Error(`n8n webhook returned ${resp.status}`);
    const data = await resp.json();
    return res.json(data);
  } catch (err) {
    console.error('Error checking user:', err);
    return res.status(500).json({ error: 'Failed to check user in Airtable' });
  }
});

// ===== Stripe webhook → update Clerk metadata =====
app.post('/api/stripe-webhook-to-clerk', async (req, res) => {
  let event;
  try {
    if (!STRIPE_WEBHOOK_SECRET) throw new Error('Missing STRIPE_WEBHOOK_SECRET');
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Map price IDs to tier info (KEEP your mapping)
  const TIER_MAP = {
    'price_1Rw3Am09B4tvq6CDhYHJ1Tl0': { tier: 'Essential', credits: 350, brandLimit: 1 },
    'price_1Rw3BL09B4tvq6CDYgOfacYx': { tier: 'Growth', credits: 1050, brandLimit: 3 },
    'price_1Rw3CB09B4tvq6CDFSp6F3pP': { tier: 'Creator', credits: 2500, brandLimit: 5 },
    'price_1Rw3Cd09B4tvq6CDuZ9Z9x4h': { tier: 'Professional', credits: 5200, brandLimit: 7 },
    'price_1Rw3DN09B4tvq6CDWhcrlYoc': { tier: 'Enterprise', credits: 10750, brandLimit: 10 }
  };

  try {
    let clerkUserId;
    let updateData = {};

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        clerkUserId = session.metadata?.clerk_user_id || session.client_reference_id;

        const expanded = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items'] });
        const priceId = expanded.line_items.data[0].price.id;
        const tier = TIER_MAP[priceId];

        updateData = {
          stripeCustomerId: session.customer,
          subscriptionTier: tier?.tier || 'Unknown',
          subscriptionStatus: 'active',
          creditsRemaining: tier?.credits ?? 0,
          monthlyCredits: tier?.credits ?? 0,
          brandLimit: tier?.brandLimit ?? 1
        };
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        clerkUserId = sub.metadata?.clerk_user_id;
        const priceId = sub.items.data[0].price.id;
        const tier = TIER_MAP[priceId];
        updateData = {
          subscriptionTier: tier?.tier || 'Unknown',
          monthlyCredits: tier?.credits ?? 0,
          brandLimit: tier?.brandLimit ?? 1,
          subscriptionStatus: sub.status
        };
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        clerkUserId = sub.metadata?.clerk_user_id;
        updateData = {
          subscriptionTier: 'Free',
          subscriptionStatus: 'cancelled',
          monthlyCredits: 0,
          creditsRemaining: 0,
          brandLimit: 1
        };
        break;
      }
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const activeSub = await stripe.subscriptions.retrieve(invoice.subscription);
        clerkUserId = activeSub.metadata?.clerk_user_id;
        const priceId = activeSub.items.data[0].price.id;
        const tier = TIER_MAP[priceId];
        updateData = {
          creditsRemaining: tier?.credits ?? 0,
          lastPaymentDate: new Date().toISOString()
        };
        break;
      }
      default:
        // ignore
    }

    if (clerkUserId && Object.keys(updateData).length > 0) {
      const fetchImpl = global.fetch || (await import('node-fetch')).default;
      const resp = await fetchImpl(`https://api.clerk.dev/v1/users/${clerkUserId}/metadata`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${CLERK_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ public_metadata: updateData })
      });
      if (!resp.ok) throw new Error(`Failed to update Clerk: ${resp.status} ${await resp.text()}`);
      console.log(`Updated Clerk user ${clerkUserId}`, updateData);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('Error processing webhook:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ===== Create Checkout Session (FIXED names + returns {url}) =====
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { priceId, userId, userEmail, airtableUserId, successUrl, cancelUrl } = req.body;
    if (!priceId) return res.status(400).json({ error: 'Missing priceId' });
    if (!successUrl || !cancelUrl) return res.status(400).json({ error: 'Missing success/cancel URL' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: userEmail,
      client_reference_id: userId || airtableUserId || undefined,
      metadata: { clerk_user_id: userId || '' },
      subscription_data: { metadata: { clerk_user_id: userId || '' } },
      allow_promotion_codes: true
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error('Checkout session error:', error);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// ===== Cancel subscription (UNCHANGED) =====
app.post('/api/cancel-subscription', async (req, res) => {
  try {
    const { customerId } = req.body;
    const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });
    if (subs.data.length === 0) throw new Error('No active subscription found');
    const subscription = await stripe.subscriptions.update(subs.data[0].id, { cancel_at_period_end: true });
    res.json({ success: true, subscription });
  } catch (err) {
    console.error('Cancel subscription error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Billing portal (UNCHANGED) =====
app.post('/api/create-portal-session', async (req, res) => {
  try {
    const { customerId, returnUrl } = req.body;
    const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal session error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Debug endpoints (UNCHANGED) =====
app.delete('/api/session/:sessionId', (req, res) => {
  sessions.delete(req.params.sessionId);
  res.json({ success: true, message: 'Session cleared' });
});
app.get('/api/sessions', (req, res) => {
  const list = Array.from(sessions.entries()).map(([key, v]) => ({
    sessionId: key,
    timestamp: v.timestamp,
    status: v.status,
    hasAllImages: !!(v.hook_image_url && v.agitation_image_url && v.solution_image_url && v.cta_image_url),
    hasRegenerated: !!v.regenerated,
    regeneratedAt: v.regeneratedAt
  }));
  res.json({ sessions: list, count: list.length });
});
app.get('/api/session/:sessionId/details', (req, res) => {
  const data = sessions.get(req.params.sessionId);
  if (!data) return res.status(404).json({ error: 'Session not found' });
  res.json(data);
});

// ===== Start =====
app.listen(PORT, () => {
  console.log(`Callback server running on port ${PORT}`);
});
