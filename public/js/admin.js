// ============================================================================
// FILE: src/routes/admin.js
// PURPOSE: Admin Authentication, Question Import, Deletion & Live Exam Management
// ============================================================================

import { Hono } from 'hono';
import { signToken, requireAdminAuth } from '../middleware/auth.js';
import { generateQuestionHash, generateSecureId } from '../utils/hash.js';
import { rateLimiter } from '../middleware/rateLimit.js';

const adminRoutes = new Hono();

// Rate limit admin login to prevent brute force
adminRoutes.post('/login', rateLimiter('admin-login', 10, 60), async (c) => {
  try {
    const body = await c.req.json();
    const password = body?.password || '';

    if (password !== c.env.ADMIN_PASSWORD) {
      return c.json({ success: false, error: 'Incorrect Admin Password' }, 401);
    }

    const token = await signToken({ role: 'admin' }, c.env.JWT_SECRET, 43200);
    return c.json({ success: true, token });
  } catch (err) {
    return c.json({ success: false, error: 'Invalid login request' }, 400);
  }
});

// Apply Admin Auth guard to all routes below
adminRoutes.use('/*', requireAdminAuth);

adminRoutes.post('/import-questions', async (c) => {
  try {
    const body = await c.req.json();
    const questionsList = Array.isArray(body) ? body : body.questions;

    if (!Array.isArray(questionsList) || questionsList.length === 0) {
      return c.json({ success: false, error: 'Valid JSON question array required.' }, 400);
    }

    let insertedCount = 0;
    let duplicateSkippedCount = 0;
    let invalidCount = 0;
    const now = Math.floor(Date.now() / 1000);

    for (const q of questionsList) {
      const qText = (q.question || q.question_text || '').trim();
      const optA = (q.option_a || q.options?.A || '').trim();
      const optB = (q.option_b || q.options?.B || '').trim();
      const optC = (q.option_c || q.options?.C || '').trim();
      const optD = (q.option_d || q.options?.D || '').trim();
      const ans = (q.answer || q.correct_option || '').trim().toUpperCase();
      const chapter = (q.chapter || 'Uncategorized').trim();
      const topic = (q.topic || 'General').trim();

      if (!qText || !optA || !optB || !optC || !optD || !['A', 'B', 'C', 'D'].includes(ans)) {
        invalidCount++;
        continue;
      }

      const qHash = await generateQuestionHash(qText);
      const qId = generateSecureId('q');

      const result = await c.env.DB.prepare(
        `INSERT OR IGNORE INTO questions 
        (id, question_hash, question_text, option_a, option_b, option_c, option_d, correct_option, explanation, source, chapter, topic, difficulty, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          qId, qHash, qText, optA, optB, optC, optD, ans,
          (q.explanation || '').trim(), (q.source || 'Standard').trim(),
          chapter, topic, (q.difficulty || 'Medium').trim(), now
        )
        .run();

      if (result.meta?.changes > 0) {
        insertedCount++;
      } else {
        duplicateSkippedCount++;
      }
    }

    return c.json({
      success: true,
      message: `Imported ${insertedCount} new questions. Skipped ${duplicateSkippedCount} duplicates.`,
      stats: { insertedCount, duplicateSkippedCount, invalidCount },
    });
  } catch (err) {
    return c.json({ success: false, error: 'Import failed: ' + err.message }, 500);
  }
});

adminRoutes.get('/bundles', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT chapter, COUNT(*) as question_count FROM questions GROUP BY chapter ORDER BY chapter ASC`
  ).all();
  return c.json({ success: true, bundles: results || [] });
});

/**
 * DELETE INDIVIDUAL QUESTION
 */
adminRoutes.delete('/questions/:id', async (c) => {
  const qId = c.req.param('id');
  const res = await c.env.DB.prepare(`DELETE FROM questions WHERE id = ?`).bind(qId).run();

  if (res.meta?.changes === 0) {
    return c.json({ success: false, error: 'Question not found.' }, 404);
  }
  return c.json({ success: true, message: 'Question deleted successfully.' });
});

/**
 * DELETE ENTIRE CHAPTER
 */
adminRoutes.delete('/chapters/:chapter', async (c) => {
  const chapterName = decodeURIComponent(c.req.param('chapter'));
  const res = await c.env.DB.prepare(`DELETE FROM questions WHERE chapter = ?`).bind(chapterName).run();

  return c.json({
    success: true,
    message: `Deleted all questions belonging to chapter "${chapterName}".`,
    changes: res.meta?.changes || 0,
  });
});

adminRoutes.post('/create-exam', async (c) => {
  try {
    const { exam_name, scheduled_at, chapters } = await c.req.json();
    if (!exam_name || !scheduled_at || !Array.isArray(chapters) || chapters.length === 0) {
      return c.json({ success: false, error: 'Exam name, date, and chapters are required.' }, 400);
    }

    const placeholders = chapters.map(() => '?').join(',');
    const { results: matchedQuestions } = await c.env.DB.prepare(
      `SELECT id FROM questions WHERE chapter IN (${placeholders})`
    ).bind(...chapters).all();

    if (!matchedQuestions || matchedQuestions.length === 0) {
      return c.json({ success: false, error: 'No questions found in selected chapters.' }, 400);
    }

    const questionIds = matchedQuestions.map((q) => q.id);
    await c.env.DB.prepare(`UPDATE exams SET is_active = 0 WHERE is_active = 1`).run();

    const examId = generateSecureId('exam');
    const now = Math.floor(Date.now() / 1000);

    await c.env.DB.prepare(
      `INSERT INTO exams (id, exam_name, scheduled_at, chapters_json, question_ids_json, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    ).bind(examId, exam_name.trim(), Number(scheduled_at), JSON.stringify(chapters), JSON.stringify(questionIds), now).run();

    return c.json({
      success: true,
      message: `Exam "${exam_name}" published with ${questionIds.length} questions!`,
      exam_id: examId,
    });
  } catch (err) {
    return c.json({ success: false, error: 'Failed to create exam: ' + err.message }, 500);
  }
});

adminRoutes.post('/stop-exam', async (c) => {
  await c.env.DB.prepare(`UPDATE exams SET is_active = 0 WHERE is_active = 1`).run();
  return c.json({ success: true, message: 'All live exams closed.' });
});

adminRoutes.get('/results', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.exam_id, e.exam_name, s.student_name, s.submitted_at,
      s.total_questions, s.total_selected, s.total_skipped, s.total_right, s.total_wrong,
      s.score_percentage, s.total_time_sec, s.cheating_risk_score, s.cheating_flags_json
     FROM submissions s LEFT JOIN exams e ON s.exam_id = e.id ORDER BY s.submitted_at DESC`
  ).all();
  return c.json({ success: true, results: results || [] });
});

adminRoutes.delete('/results/:id', async (c) => {
  const submissionId = c.req.param('id');
  const res = await c.env.DB.prepare(`DELETE FROM submissions WHERE id = ?`).bind(submissionId).run();
  if (res.meta?.changes === 0) return c.json({ success: false, error: 'Result not found.' }, 404);
  return c.json({ success: true, message: 'Student result deleted.' });
});

export default adminRoutes;
      
