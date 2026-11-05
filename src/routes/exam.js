// ============================================================================
// FILE: src/routes/exam.js
// PURPOSE: Live exam status, session creation, sanitized question delivery & grading
// ============================================================================

import { Hono } from 'hono';
import { signToken, requireStudentSession } from '../middleware/auth.js';
import { generateSecureId, watermarkQuestionText } from '../utils/hash.js';
import { evaluateSubmission } from '../utils/scoring.js';
import { rateLimiter } from '../middleware/rateLimit.js';

const examRoutes = new Hono();

examRoutes.get('/status', rateLimiter('exam-status', 60, 60), async (c) => {
  const exam = await c.env.DB.prepare(
    `SELECT id, exam_name, scheduled_at, chapters_json, question_ids_json FROM exams WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1`
  ).first();

  const serverNow = Math.floor(Date.now() / 1000);
  if (!exam) return c.json({ success: true, available: false, server_time: serverNow });

  return c.json({
    success: true,
    available: true,
    exam: {
      id: exam.id,
      exam_name: exam.exam_name,
      scheduled_at: exam.scheduled_at,
      can_enter_now: serverNow >= exam.scheduled_at,
      total_questions: JSON.parse(exam.question_ids_json || '[]').length,
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
  const session = c.get('studentSession');
  const exam = await c.env.DB.prepare(`SELECT exam_name, question_ids_json FROM exams WHERE id = ?`).bind(session.examId).first();

  if (!exam) return c.json({ success: false, error: 'Exam not found.' }, 404);

  const questionIds = JSON.parse(exam.question_ids_json || '[]');
  if (questionIds.length === 0) return c.json({ success: true, questions: [] });

  const placeholders = questionIds.map(() => '?').join(',');
  const { results } = await c.env.DB.prepare(
    `SELECT id, question_text, option_a, option_b, option_c, option_d, chapter, topic, difficulty FROM questions WHERE id IN (${placeholders})`
  ).bind(...questionIds).all();

  const sanitized = (results || []).map((q, idx) => ({
    question_number: idx + 1,
    id: q.id,
    question_text: watermarkQuestionText(q.question_text, session.sessionId),
    options: { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d },
    chapter: q.chapter,
    topic: q.topic,
    difficulty: q.difficulty,
  }));

  return c.json({ success: true, exam_name: exam.exam_name, student_name: session.studentName, questions: sanitized });
});

examRoutes.post('/submit', requireStudentSession, rateLimiter('exam-submit', 5, 60), async (c) => {
  try {
    const session = c.get('studentSession');
    const body = await c.req.json();
    const responses = body?.responses || [];

    const existing = await c.env.DB.prepare(`SELECT id, submitted_at FROM submissions WHERE id = ?`).bind(session.sessionId).first();
    if (existing) {
      return c.json({ success: true, already_submitted: true, submission_id: existing.id, unlock_at: existing.submitted_at + 120 });
    }

    const exam = await c.env.DB.prepare(`SELECT question_ids_json FROM exams WHERE id = ?`).bind(session.examId).first();
    if (!exam) return c.json({ success: false, error: 'Exam not found.' }, 404);

    const questionIds = JSON.parse(exam.question_ids_json || '[]');
    const placeholders = questionIds.map(() => '?').join(',');
    const { results: dbQuestions } = await c.env.DB.prepare(`SELECT * FROM questions WHERE id IN (${placeholders})`).bind(...questionIds).all();

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
      session.sessionId, session.examId, session.studentName, session.studentName.toLowerCase(),
      session.startedAt, serverNow, evaluation.totalQuestions, evaluation.totalSelected,
      evaluation.totalSkipped, evaluation.totalRight, evaluation.totalWrong,
      evaluation.scorePercentage, evaluation.totalTimeSec, evaluation.avgTimePerQ,
      JSON.stringify(evaluation.strongTopics), JSON.stringify(evaluation.weakTopics),
      JSON.stringify(evaluation.topicBreakdown), JSON.stringify(evaluation.paperReview),
      evaluation.cheatingRiskScore, JSON.stringify(evaluation.cheatingFlags)
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
               
