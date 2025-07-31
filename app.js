// server.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all origins (adjust for production)
app.use(cors());
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
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});
