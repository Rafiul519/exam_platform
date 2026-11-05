// ============================================================================
// FILE: src/routes/admin.js
// PURPOSE:
// 1. Admin Login (Issues Admin JWT token).
// 2. Import Questions JSON (Auto-groups by Chapter & blocks duplicates via SHA-256).
// 3. Get Chapter Bundles (Shows how many questions exist per chapter).
// 4. Create/Schedule Live Exam (Locks questions for the exam).
// 5. View all Student Results & Delete individual Student Result (Anti-IDOR).
// ============================================================================

import { Hono } from 'hono';
import { signToken, requireAdminAuth } from '../middleware/auth.js';
import { generateQuestionHash, generateSecureId } from '../utils/hash.js';

const adminRoutes = new Hono();

/**
 * ROUTE 1: POST /api/admin/login
 * Verifies admin password and returns a signed JWT token.
 */
adminRoutes.post('/login', async (c) => {
  try {
    const body = await c.req.json();
    const password = body?.password || '';

    // Compare with ADMIN_PASSWORD from wrangler.toml
    if (password !== c.env.ADMIN_PASSWORD) {
      return c.json({ success: false, error: 'Incorrect Admin Password' }, 401);
    }

    // Issue Admin JWT valid for 12 hours (43200 seconds)
    const token = await signToken({ role: 'admin' }, c.env.JWT_SECRET, 43200);
    return c.json({ success: true, token });
  } catch (err) {
    return c.json({ success: false, error: 'Invalid login request format' }, 400);
  }
});

// ============================================================================
// APPLY ADMIN AUTH GUARD TO ALL ROUTES BELOW THIS LINE
// ============================================================================
adminRoutes.use('/*', requireAdminAuth);

/**
 * ROUTE 2: POST /api/admin/import-questions
 * Accepts a JSON array of questions.
 * Automatically blocks duplicate questions using SHA-256 hash and groups by chapter.
 */
adminRoutes.post('/import-questions', async (c) => {
  try {
    const body = await c.req.json();
    const questionsList = Array.isArray(body) ? body : body.questions;

    if (!Array.isArray(questionsList) || questionsList.length === 0) {
      return c.json({ success: false, error: 'Please upload a valid JSON array of questions.' }, 400);
    }

    let insertedCount = 0;
    let duplicateSkippedCount = 0;
    let invalidCount = 0;
    const now = Math.floor(Date.now() / 1000);

    for (const q of questionsList) {
      // Validate required fields so broken JSON never crashes the exam
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

      // Generate unique SHA-256 fingerprint of the cleaned question text
      const qHash = await generateQuestionHash(qText);
      const qId = generateSecureId('q');

      // INSERT OR IGNORE automatically skips if question_hash already exists in D1!
      const result = await c.env.DB.prepare(
        `INSERT OR IGNORE INTO questions 
        (id, question_hash, question_text, option_a, option_b, option_c, option_d, correct_option, explanation, source, chapter, topic, difficulty, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          qId,
          qHash,
          qText,
          optA,
          optB,
          optC,
          optD,
          ans,
          (q.explanation || '').trim(),
          (q.source || 'Standard').trim(),
          chapter,
          topic,
          (q.difficulty || 'Medium').trim(),
          now
        )
        .run();

      // Check if D1 inserted the row (changes === 1) or ignored it as a duplicate (changes === 0)
      if (result.meta?.changes > 0) {
        insertedCount++;
      } else {
        duplicateSkippedCount++;
      }
    }

    return c.json({
      success: true,
      message: `Import complete! Added ${insertedCount} new questions. Blocked ${duplicateSkippedCount} duplicates.`,
      stats: { insertedCount, duplicateSkippedCount, invalidCount },
    });
  } catch (err) {
    return c.json({ success: false, error: 'Failed to import questions: ' + err.message }, 500);
  }
});

/**
 * ROUTE 3: GET /api/admin/bundles
 * Returns all available Chapter Bundles automatically grouped from the database.
 */
adminRoutes.get('/bundles', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT chapter, COUNT(*) as question_count 
     FROM questions 
     GROUP BY chapter 
     ORDER BY chapter ASC`
  ).all();

  return c.json({ success: true, bundles: results || [] });
});

/**
 * ROUTE 4: POST /api/admin/create-exam
 * Schedules a Live Exam using selected Chapter Bundles.
 */
adminRoutes.post('/create-exam', async (c) => {
  try {
    const { exam_name, scheduled_at, chapters } = await c.req.json();

    if (!exam_name || !scheduled_at || !Array.isArray(chapters) || chapters.length === 0) {
      return c.json({
        success: false,
        error: 'Exam name, schedule date/time, and at least one chapter bundle are required.',
      }, 400);
    }

    // Build placeholders (?, ?, ?) for selected chapters
    const placeholders = chapters.map(() => '?').join(',');
    const { results: matchedQuestions } = await c.env.DB.prepare(
      `SELECT id FROM questions WHERE chapter IN (${placeholders})`
    )
      .bind(...chapters)
      .all();

    if (!matchedQuestions || matchedQuestions.length === 0) {
      return c.json({ success: false, error: 'No questions found in the selected chapter bundles.' }, 400);
    }

    // Extract unique question IDs
    const questionIds = matchedQuestions.map((q) => q.id);

    // Deactivate previous active exams so the new live exam takes priority on Home Page
    await c.env.DB.prepare(`UPDATE exams SET is_active = 0 WHERE is_active = 1`).run();

    const examId = generateSecureId('exam');
    const now = Math.floor(Date.now() / 1000);

    await c.env.DB.prepare(
      `INSERT INTO exams (id, exam_name, scheduled_at, chapters_json, question_ids_json, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    )
      .bind(
        examId,
        exam_name.trim(),
        Number(scheduled_at),
        JSON.stringify(chapters),
        JSON.stringify(questionIds),
        now
      )
      .run();

    return c.json({
      success: true,
      message: `Live Exam "${exam_name}" scheduled with ${questionIds.length} questions!`,
      exam_id: examId,
      total_questions: questionIds.length,
    });
  } catch (err) {
    return c.json({ success: false, error: 'Failed to schedule exam: ' + err.message }, 500);
  }
});

/**
 * ROUTE 5: POST /api/admin/stop-exam
 * Allows Admin to close the currently active live exam at any time.
 */
adminRoutes.post('/stop-exam', async (c) => {
  await c.env.DB.prepare(`UPDATE exams SET is_active = 0 WHERE is_active = 1`).run();
  return c.json({ success: true, message: 'All live exams have been marked as closed.' });
});

/**
 * ROUTE 6: GET /api/admin/results
 * Lists all student submissions with score, time taken, and anti-cheat risk score.
 */
adminRoutes.get('/results', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT 
      s.id, s.exam_id, e.exam_name, s.student_name, s.submitted_at,
      s.total_questions, s.total_selected, s.total_skipped, s.total_right, s.total_wrong,
      s.score_percentage, s.total_time_sec, s.cheating_risk_score, s.cheating_flags_json
     FROM submissions s
     LEFT JOIN exams e ON s.exam_id = e.id
     ORDER BY s.submitted_at DESC`
  ).all();

  return c.json({ success: true, results: results || [] });
});

/**
 * ROUTE 7: DELETE /api/admin/results/:id
 * Deletes an individual student's result by their secure submission ID.
 */
adminRoutes.delete('/results/:id', async (c) => {
  const submissionId = c.req.param('id');
  const res = await c.env.DB.prepare(`DELETE FROM submissions WHERE id = ?`)
    .bind(submissionId)
    .run();

  if (res.meta?.changes === 0) {
    return c.json({ success: false, error: 'Result not found.' }, 404);
  }
  return c.json({ success: true, message: 'Student result deleted successfully.' });
});

export default adminRoutes;
        
