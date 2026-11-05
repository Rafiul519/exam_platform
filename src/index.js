
// ============================================================================
// FILE: src/index.js
// PURPOSE:
// Main Cloudflare Worker entry point. Connects CORS security headers,
// mounts Admin, Exam, and Result routes, and serves static HTML frontend assets.
// ============================================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import adminRoutes from './routes/admin.js';
import examRoutes from './routes/exam.js';
import resultRoutes from './routes/result.js';

const app = new Hono();

// Enable CORS and security headers for all API endpoints
app.use('/api/*', cors());

// Health-check endpoint to verify backend is live from mobile browser
app.get('/api/health', (c) => {
  return c.json({
    success: true,
    status: 'Online Examination Backend is Live & Healthy!',
    timestamp: Math.floor(Date.now() / 1000),
  });
});

// Mount separated route files
app.route('/api/admin', adminRoutes);
app.route('/api/exam', examRoutes);
app.route('/api/result', resultRoutes);

// Catch-all for unknown /api/* routes
app.all('/api/*', (c) => {
  return c.json({ success: false, error: 'API route not found' }, 404);
});

// Serve static Frontend HTML/CSS/JS files from the /public folder
app.get('*', async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.text('Frontend assets not found. Please add files to /public folder.', 404);
});

export default app;
