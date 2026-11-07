// ============================================================================
// FILE: src/routes/exam.js
// PURPOSE: Live exam status, session start, 50-50 chunked zero-duplicate question delivery & grading
// ============================================================================

import { Hono } from 'hono';
import { signToken, requireStudentSession } from '../middleware/auth.js';
import { generateSecureId, watermarkQuestionText } from '../utils/hash.js';
import { evaluateSubmission, shuffleQuestionsForSession } from '../utils/scoring.js';
import { rateLimiter } from '../middleware/rateLimit.js';

const examRoutes = new Hono();

/**
 * Fetches questions from Cloudflare D1 in safe chunks of 50 IDs
 * Preserves the exact order of `orderedIds` and never hits D1's 100-variable limit.
 */
async function fetchQuestionsByExactOrder(db, orderedIds, columns) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return [];
  }

  const CHUNK_SIZE = 50;
  const statements = [];

  for (let i = 0; i < orderedIds.length; i += CHUNK_SIZE) {
    const chunk = orderedIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    statements.push(
      db
        .prepare('SELECT ' + columns + ' FROM questions WHERE id IN (' + placeholders + ')')
        .bind(...chunk)
    );
  }

  const batchResults = await db.batch(statements);
  const rowMap = new Map();

  for (const res of batchResults) {
    if (res && Array.isArray(res.results)) {
      for (const row of res.results) {
        rowMap.set(String(row.id), row);
      }
    }
  }

  // Reconstruct array in the exact shuffled sequence (prevents SQLite IN() reordering)
  const orderedRows = [];
  for (const id of orderedIds) {
    const found = rowMap.get(String(id));
    if (found) {
      orderedRows.push(found);
    }
  }

  return orderedRows;
}

examRoutes.get('/status', rateLimiter('exam-status', 60, 60), async (c) => {
  const exam = await c.env.DB.prepare(
    'SELECT id, exam_name, scheduled_at, chapters_json, question_ids_json FROM exams WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1'
  ).first();

  const serverNow = Math.floor(Date.now() / 1000);
  if (!exam) return c.json({ success: true, available: false, server_time: serverNow });

  const rawIds = JSON.parse(exam.question_ids_json || '[]');
  const uniqueIds = Array.from(new Set(rawIds.map((id) => String(id))));

  return c.json({
    success: true,
    available: true,
    exam: {
      id: exam.id,
      exam_name: exam.exam_name,
      scheduled_at: exam.scheduled_at,
      can_enter_now: serverNow >= exam.scheduled_at,
      total_questions: uniqueIds.length,
      chapters: JSON.parse(exam.chapters_json || '[]')
    },
    server_time: serverNow
  });
});

examRoutes.post('/start', rateLimiter('exam-start', 15, 60), async (c) => {
  try {
    const { student_name } = await c.req.json();
    const cleanName = (student_name || '').trim();

    if (cleanName.length < 2 || cleanName.length > 60) {
      return c.json({ success: false, error: 'Enter a valid student name (2-60 chars).' }, 400);
    }

    const exam = await c.env.DB.prepare(
      'SELECT id, exam_name, scheduled_at FROM exams WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1'
    ).first();

    if (!exam) return c.json({ success: false, error: 'No active live exam.' }, 404);

    const serverNow = Math.floor(Date.now() / 1000);
    if (serverNow < exam.scheduled_at) {
      return c.json({ success: false, error: 'Exam starts in ' + (exam.scheduled_at - serverNow) + ' seconds.' }, 403);
    }

    const sessionId = generateSecureId('sub');
    const token = await signToken(
      { role: 'student', sessionId: sessionId, examId: exam.id, studentName: cleanName, startedAt: serverNow },
      c.env.JWT_SECRET,
      28800
    );

    return c.json({
      success: true,
      session_token: token,
      submission_id: sessionId,
      student_name: cleanName,
      exam_name: exam.exam_name
    });
  } catch (err) {
    return c.json({ success: false, error: 'Could not start session.' }, 500);
  }
});

examRoutes.get('/questions', requireStudentSession, async (c) => {
  try {
    const session = c.get('studentSession');
    const exam = await c.env.DB.prepare('SELECT exam_name, question_ids_json FROM exams WHERE id = ?')
      .bind(session.examId)
      .first();

    if (!exam) return c.json({ success: false, error: 'Exam not found.' }, 404);

    // 1. Get deduplicated master list of question IDs
    const rawIds = JSON.parse(exam.question_ids_json || '[]');
    const uniqueIds = Array.from(new Set(rawIds.map((id) => String(id))));
    const totalQuestions = uniqueIds.length;

    if (totalQuestions === 0) {
      return c.json({
        success: true,
        exam_name: exam.exam_name,
        student_name: session.studentName,
        total_questions: 0,
        offset: 0,
        has_more: false,
        questions: []
      });
    }

    // 2. Deterministically shuffle the full ID list using session.sessionId
    // Because sessionId is constant for this student, every 50-chunk call gets the exact same master order!
    const idObjects = uniqueIds.map((id) => ({ id: id }));
    const shuffledIdObjects = shuffleQuestionsForSession(idObjects, session.sessionId);
    const masterShuffledIds = shuffledIdObjects.map((item) => item.id);

    // 3. Read optional offset & limit for 50-50-50 progressive loading
    const offsetParam = c.req.query('offset');
    const limitParam = c.req.query('limit');

    let offset = 0;
    let limit = totalQuestions;

    if (offsetParam !== undefined || limitParam !== undefined) {
      offset = Math.max(0, parseInt(offsetParam || '0', 10) || 0);
      limit = Math.min(50, Math.max(1, parseInt(limitParam || '50', 10) || 50));
    }

    const targetIds = masterShuffledIds.slice(offset, offset + limit);

    // 4. Fetch only the requested slice (in safe 50-ID D1 batches) in exact order
    const rows = await fetchQuestionsByExactOrder(
      c.env.DB,
      targetIds,
      'id, question_text, option_a, option_b, option_c, option_d, chapter, topic, difficulty'
    );

    const sanitized = rows.map((q, idx) => ({
      question_number: offset + idx + 1,
      id: q.id,
      question_text: watermarkQuestionText(q.question_text, session.sessionId),
      options: { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d },
      chapter: q.chapter,
      topic: q.topic,
      difficulty: q.difficulty
    }));

    return c.json({
      success: true,
      exam_name: exam.exam_name,
      student_name: session.studentName,
      total_questions: totalQuestions,
      offset: offset,
      loaded_count: sanitized.length,
      has_more: offset + sanitized.length < totalQuestions,
      questions: sanitized
    });
  } catch (err) {
    return c.json({ success: false, error: 'Failed to load questions: ' + err.message }, 500);
  }
});

examRoutes.post('/submit', requireStudentSession, rateLimiter('exam-submit', 10, 60), async (c) => {
  try {
    const session = c.get('studentSession');
    const body = await c.req.json();
    const responses = body && Array.isArray(body.responses) ? body.responses : [];

    // Idempotency check: if network dropped right after submit succeeded, return existing result!
    const existing = await c.env.DB.prepare('SELECT id, submitted_at FROM submissions WHERE id = ?')
      .bind(session.sessionId)
      .first();

    if (existing) {
      const nowSec = Math.floor(Date.now() / 1000);
      return c.json({
        success: true,
        already_submitted: true,
        submission_id: existing.id,
        student_name: session.studentName,
        submitted_at: existing.submitted_at,
        unlock_at: existing.submitted_at + 120,
        server_time: nowSec
      });
    }

    const exam = await c.env.DB.prepare('SELECT question_ids_json FROM exams WHERE id = ?')
      .bind(session.examId)
      .first();
    if (!exam) return c.json({ success: false, error: 'Exam not found.' }, 404);

    const rawIds = JSON.parse(exam.question_ids_json || '[]');
    const uniqueIds = Array.from(new Set(rawIds.map((id) => String(id))));

    // Fetch all exam questions in safe 50-ID chunks for grading
    const dbQuestions = await fetchQuestionsByExactOrder(c.env.DB, uniqueIds, '*');

    const serverNow = Math.floor(Date.now() / 1000);
    const serverElapsedSec = Math.max(1, serverNow - session.startedAt);
    const evaluation = evaluateSubmission(dbQuestions || [], responses, serverElapsedSec, session.sessionId);

    await c.env.DB.prepare(
      'INSERT INTO submissions (' +
        'id, exam_id, student_name, student_name_lower, started_at, submitted_at, ' +
        'total_questions, total_selected, total_skipped, total_right, total_wrong, ' +
        'score_percentage, total_time_sec, avg_time_per_q, ' +
        'strong_topics_json, weak_topics_json, topic_breakdown_json, paper_review_json, ' +
        'cheating_risk_score, cheating_flags_json' +
      ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      session.sessionId,
      session.examId,
      session.studentName,
      session.studentName.toLowerCase(),
      session.startedAt,
      serverNow,
      evaluation.totalQuestions,
      evaluation.totalSelected,
      evaluation.totalSkipped,
      evaluation.totalRight,
      evaluation.totalWrong,
      evaluation.scorePercentage,
      evaluation.totalTimeSec,
      evaluation.avgTimePerQ,
      JSON.stringify(evaluation.strongTopics),
      JSON.stringify(evaluation.weakTopics),
      JSON.stringify(evaluation.topicBreakdown),
      JSON.stringify(evaluation.paperReview),
      evaluation.cheatingRiskScore,
      JSON.stringify(evaluation.cheatingFlags)
    ).run();

    return c.json({
      success: true,
      submission_id: session.sessionId,
      student_name: session.studentName,
      submitted_at: serverNow,
      unlock_at: serverNow + 120,
      server_time: serverNow
    });
  } catch (err) {
    return c.json({ success: false, error: 'Submission failed: ' + err.message }, 500);
  }
});

export default examRoutes;
      
