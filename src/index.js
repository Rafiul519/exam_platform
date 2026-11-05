// ============================================================================
// FILE: src/index.js
// PURPOSE: Main Worker Entry Point
// ============================================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import adminRoutes from './routes/admin.js';
import examRoutes from './routes/exam.js';
import resultRoutes from './routes/result.js';
import studentRoutes from './routes/student.js';

const app = new Hono();

app.use('/api/*', cors());

app.get('/api/health', (c) => {
  return c.json({ success: true, status: 'Online Examination Backend is Live', timestamp: Math.floor(Date.now() / 1000) });
});

app.route('/api/admin', adminRoutes);
app.route('/api/exam', examRoutes);
app.route('/api/result', resultRoutes);
app.route('/api/student', studentRoutes);

app.all('/api/*', (c) => {
  return c.json({ success: false, error: 'API route not found' }, 404);
});

app.get('*', async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.text('Frontend assets not found.', 404);
});

export default app;
