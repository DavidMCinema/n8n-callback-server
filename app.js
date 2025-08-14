// server.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const stripe = require('stripe')(process.env.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);

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all origins (adjust for production)
app.use(cors());

// Raw body needed for Stripe webhook signature verification
app.use('/api/stripe-webhook-to-clerk', bodyParser.raw({type: 'application/json'}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// In-memory storage (use Redis or a database for production)
const sessions = new Map();

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Endpoint to receive callback from n8n (handles both initial and regenerated images)
app.post('/api/callback/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const imageData = req.body;

    console.log(`Received callback for session ${sessionId}:`, imageData);

    // Get existing session data
    const existingSession = sessions.get(sessionId);

    // Check if this is a regeneration callback (session already exists and completed)
    if (existingSession && existingSession.status === 'completed') {
        // This is a regeneration - store all 4 images as regenerated
        console.log(`Regeneration callback for session ${sessionId}`);

        // Update all image URLs (n8n sends all 4, even unchanged ones)
        existingSession.hook_image_url = imageData.hook_image_url;
        existingSession.agitation_image_url = imageData.agitation_image_url;
        existingSession.solution_image_url = imageData.solution_image_url;
        existingSession.cta_image_url = imageData.cta_image_url;

        // Mark as regenerated so frontend knows to check
        existingSession.regenerated = true;
        existingSession.regeneratedAt = new Date().toISOString();

        sessions.set(sessionId, existingSession);

        console.log(`Updated session ${sessionId} with regenerated images`);
    } else {
        // This is the initial callback with all images
        if (!imageData.hook_image_url || !imageData.agitation_image_url || 
            !imageData.solution_image_url || !imageData.cta_image_url) {
            return res.status(400).json({ error: 'Missing required image URLs for initial callback' });
        }

        // Store the complete session data
        sessions.set(sessionId, {
            ...imageData,
            timestamp: new Date().toISOString(),
            status: 'completed'
        });

        console.log(`Created new session ${sessionId} with all images`);
    }

    // Clean up old sessions (older than 2 hours)
    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
    sessions.forEach((value, key) => {
        const sessionTime = new Date(value.timestamp).getTime();
        if (sessionTime < twoHoursAgo) {
            sessions.delete(key);
            console.log(`Cleaned up old session: ${key}`);
        }
    });

    res.json({ 
        success: true, 
        message: 'Images received successfully',
        sessionId: sessionId 
    });
});

// Endpoint for frontend to check for initial images
app.get('/api/check-images/:sessionId', (req, res) => {
    const { sessionId } = req.params;

    console.log(`Checking images for session ${sessionId}`);

    const sessionData = sessions.get(sessionId);

    if (!sessionData || sessionData.status !== 'completed') {
        // Return empty response if not ready yet
        return res.json({ status: 'pending' });
    }

    // Return the image data
    res.json({
        status: 'completed',
        hook_image_url: sessionData.hook_image_url,
        agitation_image_url: sessionData.agitation_image_url,
        solution_image_url: sessionData.solution_image_url,
        cta_image_url: sessionData.cta_image_url
    });
});

// Endpoint for frontend to check for regenerated images
app.get('/api/check-regenerated-images/:sessionId', (req, res) => {
    const { sessionId } = req.params;

    console.log(`Checking regenerated images for session ${sessionId}`);

    const sessionData = sessions.get(sessionId);

    if (!sessionData || !sessionData.regenerated) {
        // No regenerated images yet
        return res.json({ status: 'pending' });
    }

    // Return all current images with regenerated flag
    res.json({
        status: 'regenerated',
        hook_image_url: sessionData.hook_image_url,
        agitation_image_url: sessionData.agitation_image_url,
        solution_image_url: sessionData.solution_image_url,
        cta_image_url: sessionData.cta_image_url
    });

    // Clear the regenerated flag after sending
    delete sessionData.regenerated;
    sessions.set(sessionId, sessionData);
});

// NEW ROUTE: BrandVoice user check proxy to n8n
app.post('/api/check-user', async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }
        
        console.log(`Checking user in Airtable for email: ${email}`);
        
        // Import fetch if Node.js version < 18
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
        
        // Forward to n8n webhook
        const response = await fetch('https://davidmcinema.app.n8n.cloud/webhook/bvcc-user-id-check', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email })
        });
        
        if (!response.ok) {
            throw new Error(`n8n webhook returned ${response.status}`);
        }
        
        const data = await response.json();
        console.log(`User check result for ${email}:`, data);
        
        res.json(data);
    } catch (error) {
        console.error('Error checking user:', error);
        res.status(500).json({ error: 'Failed to check user in Airtable' });
    }
});

// Stripe webhook that updates Clerk user metadata
app.post('/api/stripe-webhook-to-clerk', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.whsec_SgJAkR6EThNrYlSDTjTdJGFtGeg6V13l;

    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.error('Webhook signature verification failed:', err);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Map price IDs to tier info
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
            case 'checkout.session.completed':
                // New subscription
                const session = event.data.object;
                clerkUserId = session.metadata.clerk_user_id || session.client_reference_id;
                
                // Get the price ID from line items
                const expandedSession = await stripe.checkout.sessions.retrieve(session.id, {
                    expand: ['line_items']
                });
                const priceId = expandedSession.line_items.data[0].price.id;
                const tierInfo = TIER_MAP[priceId];

                updateData = {
                    stripeCustomerId: session.customer,
                    subscriptionTier: tierInfo.tier,
                    subscriptionStatus: 'active',
                    creditsRemaining: tierInfo.credits,
                    monthlyCredits: tierInfo.credits,
                    brandLimit: tierInfo.brandLimit
                };
                break;

            case 'customer.subscription.updated':
                // Plan change
                const subscription = event.data.object;
                clerkUserId = subscription.metadata.clerk_user_id;
                
                const newPriceId = subscription.items.data[0].price.id;
                const newTierInfo = TIER_MAP[newPriceId];

                updateData = {
                    subscriptionTier: newTierInfo.tier,
                    monthlyCredits: newTierInfo.credits,
                    brandLimit: newTierInfo.brandLimit,
                    subscriptionStatus: subscription.status
                };
                break;

            case 'customer.subscription.deleted':
                // Cancellation
                const cancelledSub = event.data.object;
                clerkUserId = cancelledSub.metadata.clerk_user_id;

                updateData = {
                    subscriptionTier: 'Free',
                    subscriptionStatus: 'cancelled',
                    monthlyCredits: 0,
                    creditsRemaining: 0,
                    brandLimit: 1
                };
                break;

            case 'invoice.payment_succeeded':
                // Monthly renewal - reset credits
                const invoice = event.data.object;
                const subId = invoice.subscription;
                const activeSub = await stripe.subscriptions.retrieve(subId);
                clerkUserId = activeSub.metadata.clerk_user_id;
                
                const currentPriceId = activeSub.items.data[0].price.id;
                const currentTierInfo = TIER_MAP[currentPriceId];

                updateData = {
                    creditsRemaining: currentTierInfo.credits,
                    lastPaymentDate: new Date().toISOString()
                };
                break;
        }

        // Update Clerk user metadata
        if (clerkUserId && Object.keys(updateData).length > 0) {
            // Import fetch for Node.js < 18
            const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
            
            const clerkResponse = await fetch(`https://api.clerk.dev/v1/users/${clerkUserId}/metadata`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${process.env.sk_test_xDrduBx4e2SxW0JG6jmkEXbdj4XT0ja5kITkQAzp3p}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    public_metadata: updateData
                })
            });

            if (!clerkResponse.ok) {
                throw new Error(`Failed to update Clerk: ${clerkResponse.statusText}`);
            }

            console.log(`Updated Clerk user ${clerkUserId} with:`, updateData);
        }

        res.json({ received: true });

    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).json({ error: error.message });
    }
});

// Create Stripe checkout session
app.post('/api/create-checkout', async (req, res) => {
    try {
        const { priceId, customerEmail, clerkUserId, successUrl, cancelUrl } = req.body;

        // IMPORTANT: Add metadata that links to Clerk
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price: priceId,
                quantity: 1,
            }],
            mode: 'subscription',
            success_url: successUrl,
            cancel_url: cancelUrl,
            customer_email: customerEmail,
            client_reference_id: clerkUserId,
            metadata: {
                clerk_user_id: clerkUserId
            },
            subscription_data: {
                metadata: {
                    clerk_user_id: clerkUserId
                }
            }
        });

        res.json({ sessionId: session.id });
    } catch (error) {
        console.error('Checkout session error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Cancel subscription
app.post('/api/cancel-subscription', async (req, res) => {
    try {
        const { customerId } = req.body;

        // Get customer's subscriptions
        const subscriptions = await stripe.subscriptions.list({
            customer: customerId,
            status: 'active',
            limit: 1
        });

        if (subscriptions.data.length === 0) {
            throw new Error('No active subscription found');
        }

        // Cancel at period end (user keeps access until end of billing period)
        const subscription = await stripe.subscriptions.update(
            subscriptions.data[0].id,
            { cancel_at_period_end: true }
        );

        res.json({ success: true, subscription });
    } catch (error) {
        console.error('Cancel subscription error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Create billing portal session
app.post('/api/create-portal-session', async (req, res) => {
    try {
        const { customerId, returnUrl } = req.body;

        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: returnUrl,
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Portal session error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint to manually clear a session (useful for testing)
app.delete('/api/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    sessions.delete(sessionId);
    res.json({ success: true, message: 'Session cleared' });
});

// Endpoint to view all sessions (for debugging - remove in production)
app.get('/api/sessions', (req, res) => {
    const sessionList = Array.from(sessions.entries()).map(([key, value]) => ({
        sessionId: key,
        timestamp: value.timestamp,
        status: value.status,
        hasAllImages: !!(value.hook_image_url && value.agitation_image_url && 
                         value.solution_image_url && value.cta_image_url),
        hasRegenerated: !!value.regenerated,
        regeneratedAt: value.regeneratedAt
    }));
    res.json({ sessions: sessionList, count: sessionList.length });
});

// Endpoint to get detailed session info (for debugging)
app.get('/api/session/:sessionId/details', (req, res) => {
    const { sessionId } = req.params;
    const sessionData = sessions.get(sessionId);

    if (!sessionData) {
        return res.status(404).json({ error: 'Session not found' });
    }

    res.json(sessionData);
});

// Start the server
app.listen(PORT, () => {
    console.log(`Callback server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`n8n should POST to: http://localhost:${PORT}/api/callback/[sessionId]`);
    console.log(`Frontend polls: http://localhost:${PORT}/api/check-images/[sessionId]`);
    console.log(`Frontend polls regenerated: http://localhost:${PORT}/api/check-regenerated-images/[sessionId]`);
    console.log(`BrandVoice user check: http://localhost:${PORT}/api/check-user`);
    console.log(`Stripe webhook: http://localhost:${PORT}/api/stripe-webhook-to-clerk`);
    console.log(`Create checkout: http://localhost:${PORT}/api/create-checkout`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});
