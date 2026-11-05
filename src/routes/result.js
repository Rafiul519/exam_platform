// ============================================================================
// FILE: src/routes/result.js
// PURPOSE:
// 1. Searches results by Student Name from the Home Page.
// 2. Fetches full Result Analytics & Question Paper by secure Submission ID.
// 3. Enforces the 2-Minute (120s) Result Quarantine countdown for students,
//    while allowing Admin instant access if they pass their Admin JWT.
// ============================================================================

import { Hono } from 'hono';
import { verifyToken } from '../middleware/auth.js';

const resultRoutes = new Hono();

/**
 * ROUTE 1: GET /api/result/search?name=StudentName
 * Used on the Home Page "Find the Result" search box.
 */
resultRoutes.get('/search', async (c) => {
  const queryName = (c.req.query('name') || '').trim().toLowerCase();

  if (queryName.length < 2) {
    return c.json({ success: false, error: 'Please enter at least 2 characters to search.' }, 400);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT 
      s.id, s.student_name, s.submitted_at, s.score_percentage, 
      s.total_right, s.total_questions, e.exam_name
     FROM submissions s
     LEFT JOIN exams e ON s.exam_id = e.id
     WHERE s.student_name_lower LIKE ?
     ORDER BY s.submitted_at DESC
     LIMIT 20`
  )
    .bind(`%${queryName}%`)
    .all();

  const serverNow = Math.floor(Date.now() / 1000);

  // Tell frontend whether each result's 2-minute countdown has finished
  const formatted = (results || []).map((r) => {
    const unlockAt = r.submitted_at + 120;
    const isReady = serverNow >= unlockAt;
    return {
      submission_id: r.id,
      student_name: r.student_name,
      exam_name: r.exam_name || 'Live Practice Test',
      submitted_at: r.submitted_at,
      unlock_at: unlockAt,
      is_ready: isReady,
      wait_seconds: isReady ? 0 : unlockAt - serverNow,
      // Only show preview score once 2 minutes have passed!
      score_percentage: isReady ? r.score_percentage : null,
    };
  });

  return c.json({
    success: true,
    server_time: serverNow,
    results: formatted,
  });
});

/**
 * ROUTE 2: GET /api/result/:id
 * Fetches the full analytical report and question paper for a specific submission ID.
 * IDOR SAFE: Submission IDs are 32-char cryptographic UUIDs, not sequential numbers.
 */
resultRoutes.get('/:id', async (c) => {
  const submissionId = c.req.param('id');

  const record = await c.env.DB.prepare(
    `SELECT s.*, e.exam_name 
     FROM submissions s
     LEFT JOIN exams e ON s.exam_id = e.id
     WHERE s.id = ?`
  )
    .bind(submissionId)
    .first();

  if (!record) {
    return c.json({ success: false, error: 'Result not found.' }, 404);
  }

  // Check if requester is an Admin (Admins can view immediately without waiting 2 mins)
  let isAdmin = false;
  const authHeader = c.req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    const payload = await verifyToken(token, c.env.JWT_SECRET);
    if (payload && payload.role === 'admin') {
      isAdmin = true;
    }
  }

  const serverNow = Math.floor(Date.now() / 1000);
  const unlockAt = record.submitted_at + 120;

  // Enforce 2-minute quarantine for students
  if (!isAdmin && serverNow < unlockAt) {
    return c.json({
      success: false,
      locked: true,
      wait_seconds: unlockAt - serverNow,
      unlock_at: unlockAt,
      server_time: serverNow,
      student_name: record.student_name,
      error: `Your result is being analyzed! Please wait ${unlockAt - serverNow} seconds.`,
    }, 425);
  }

  // Parse JSON columns safely
  return c.json({
    success: true,
    result: {
      submission_id: record.id,
      exam_name: record.exam_name || 'Live Exam',
      student_name: record.student_name,
      started_at: record.started_at,
      submitted_at: record.submitted_at,
      total_questions: record.total_questions,
      total_selected: record.total_selected,
      total_skipped: record.total_skipped,
      total_right: record.total_right,
      total_wrong: record.total_wrong,
      score_percentage: record.score_percentage,
      total_time_sec: record.total_time_sec,
      avg_time_per_q: record.avg_time_per_q,
      strong_topics: JSON.parse(record.strong_topics_json || '[]'),
      weak_topics: JSON.parse(record.weak_topics_json || '[]'),
      topic_breakdown: JSON.parse(record.topic_breakdown_json || '[]'),
      paper_review: JSON.parse(record.paper_review_json || '[]'),
      // Only send anti-cheat telemetry details if Admin is viewing
      cheating_risk_score: isAdmin ? record.cheating_risk_score : undefined,
      cheating_flags: isAdmin ? JSON.parse(record.cheating_flags_json || '[]') : undefined,
    },
  });
});

export default resultRoutes;
  
