// ============================================================================
// FILE: src/routes/exam.js
// PURPOSE: Live exam status, session start, 50-50 chunked delivery, shuffle & grading
// ============================================================================

import { Hono } from 'hono';
import { signToken, requireStudentSession } from '../middleware/auth.js';
import { generateSecureId, watermarkQuestionText } from '../utils/hash.js';
import { evaluateSubmission } from '../utils/scoring.js';
import { rateLimiter } from '../middleware/rateLimit.js';

const examRoutes = new Hono();

/**
 * Deterministic Seeded Shuffle (Built directly inside exam.js so imports never fail)
 * Mixes question IDs uniquely per student sessionId, while keeping the exact same
 * sequence across all 50-50-50 chunk calls and page reloads.
 */
function shuffleIdsForSession(questionIds, sessionId) {
  if (!Array.isArray(questionIds) || questionIds.length <= 1) {
    return questionIds ? [...questionIds] : [];
  }

  // Deduplicate and sort first so base order is 100% consistent
  const uniqueList = Array.from(new Set(questionIds.map((id) => String(id)))).sort();

  const seedStr = String(sessionId || 'default_seed');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let seed = h >>> 0;

  function nextRandom() {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  for (let i = uniqueList.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom() * (i + 1));
    const temp = uniqueList[i];
    uniqueList[i] = uniqueList[j];
    uniqueList[j] = temp;
  }

  return uniqueList;
}

/**
 * Fetches questions from D1 in safe 50-ID chunks using standard .all()
 * Bypasses Cloudflare D1's 100 SQL variable limit and preserves exact order.
 */
async function fetchQuestionsSafeChunks(db, orderedIds, columns) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return [];
  }

  const CHUNK_SIZE = 50;
  const rowMap = new Map();

  for (let i = 0; i < orderedIds.length; i += CHUNK_SIZE) {
    const chunk = orderedIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const query = `SELECT ${columns} FROM questions WHERE id IN (${placeholders})`;
    const { results } = await db.prepare(query).bind(...chunk).all();

    if (Array.isArray(results)) {
      for (const row of results) {
        rowMap.set(String(row.id), row);
      }
    }
  }

  const orderedRows = [];
  for (const id of orderedIds) {
    const row = rowMap.get(String(id));
    if (row) {
      orderedRows.push(row);
    }
  }

  return orderedRows;
}

examRoutes.get('/status', rateLimiter('exam-status', 60, 60), async (c) => {
  const exam = await c.env.DB.prepare(
    `SELECT id, exam_name, scheduled_at, chapters_json, question_ids_json FROM exams WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1`
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
      chapters: JSON.parse(exam.chapters_json || '[]'),
    },
    server_time: serverNow,
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
      `SELECT id, exam_name, scheduled_at FROM exams WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1`
    ).first();

    if (!exam) return c.json({ success: false, error: 'No active live exam.' }, 404);

    const serverNow = Math.floor(Date.now() / 1000);
    if (serverNow < exam.scheduled_at) {
      return c.json({ success: false, error: `Exam starts in ${exam.scheduled_at - serverNow} seconds.` }, 403);
    }

    const sessionId = generateSecureId('sub');
    const token = await signToken(
      { role: 'student', sessionId, examId: exam.id, studentName: cleanName, startedAt: serverNow },
      c.env.JWT_SECRET,
      28800
    );

    return c.json({
      success: true,
      session_token: token,
      submission_id: sessionId,
      student_name: cleanName,
      exam_name: exam.exam_name,
    });
  } catch (err) {
    return c.json({ success: false, error: 'Could not start session.' }, 500);
  }
});

examRoutes.get('/questions', requireStudentSession, async (c) => {
  try {
    const session = c.get('studentSession');
    const exam = await c.env.DB.prepare(`SELECT exam_name, question_ids_json FROM exams WHERE id = ?`)
      .bind(session.examId)
      .first();

    if (!exam) return c.json({ success: false, error: 'Exam not found.' }, 404);

    const rawIds = JSON.parse(exam.question_ids_json || '[]');
    if (rawIds.length === 0) {
      return c.json({
        success: true,
        exam_name: exam.exam_name,
        student_name: session.studentName,
        total_questions: 0,
        offset: 0,
        has_more: false,
        questions: [],
      });
    }

    // 1. Shuffle all question IDs deterministically for this student session
    const shuffledIds = shuffleIdsForSession(rawIds, session.sessionId);
    const totalQuestions = shuffledIds.length;

    // 2. Check if frontend requested a 50-question chunk (?offset=0&limit=50)
    const offsetQuery = c.req.query('offset');
    const limitQuery = c.req.query('limit');

    let offset = 0;
    let limit = totalQuestions;

    if (offsetQuery !== undefined || limitQuery !== undefined) {
      offset = Math.max(0, parseInt(offsetQuery || '0', 10) || 0);
      limit = Math.min(50, Math.max(1, parseInt(limitQuery || '50', 10) || 50));
    }

    const sliceIds = shuffledIds.slice(offset, offset + limit);

    // 3. Fetch questions from D1 in safe 50-ID chunks
    const results = await fetchQuestionsSafeChunks(
      c.env.DB,
      sliceIds,
      'id, question_text, option_a, option_b, option_c, option_d, chapter, topic, difficulty'
    );

    const sanitized = results.map((q, idx) => ({
      question_number: offset + idx + 1,
      id: q.id,
      question_text: watermarkQuestionText(q.question_text, session.sessionId),
      options: { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d },
      chapter: q.chapter,
      topic: q.topic,
      difficulty: q.difficulty,
    }));

    return c.json({
      success: true,
      exam_name: exam.exam_name,
      student_name: session.studentName,
      total_questions: totalQuestions,
      offset,
      has_more: offset + sanitized.length < totalQuestions,
      questions: sanitized,
    });
  } catch (err) {
    return c.json({ success: false, error: 'Failed to load questions: ' + err.message }, 500);
  }
});

examRoutes.post('/submit', requireStudentSession, rateLimiter('exam-submit', 10, 60), async (c) => {
  try {
    const session = c.get('studentSession');
    const body = await c.req.json();
    const responses = body?.responses || [];

    const existing = await c.env.DB.prepare(`SELECT id, submitted_at FROM submissions WHERE id = ?`)
      .bind(session.sessionId)
      .first();
    if (existing) {
      return c.json({
        success: true,
        already_submitted: true,
        submission_id: existing.id,
        unlock_at: existing.submitted_at + 120,
      });
    }

    const exam = await c.env.DB.prepare(`SELECT question_ids_json FROM exams WHERE id = ?`)
      .bind(session.examId)
      .first();
    if (!exam) return c.json({ success: false, error: 'Exam not found.' }, 404);

    const rawIds = JSON.parse(exam.question_ids_json || '[]');

    // Use the exact same shuffled ID order for this student so paperReview matches Q1..QN on screen
    const shuffledIds = shuffleIdsForSession(rawIds, session.sessionId);

    // Fetch all full questions in safe 50-ID chunks (never hits D1 100-variable limit)
    const dbQuestions = await fetchQuestionsSafeChunks(c.env.DB, shuffledIds, '*');

    const serverNow = Math.floor(Date.now() / 1000);
    const serverElapsedSec = Math.max(1, serverNow - session.startedAt);
    const evaluation = evaluateSubmission(dbQuestions || [], responses, serverElapsedSec);

    await c.env.DB.prepare(
      `INSERT INTO submissions (
        id, exam_id, student_name, student_name_lower, started_at, submitted_at,
        total_questions, total_selected, total_skipped, total_right, total_wrong,
        score_percentage, total_time_sec, avg_time_per_q,
        strong_topics_json, weak_topics_json, topic_breakdown_json, paper_review_json,
        cheating_risk_score, cheating_flags_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    });
  } catch (err) {
    return c.json({ success: false, error: 'Submission failed: ' + err.message }, 500);
  }
});

export default examRoutes;
                              
