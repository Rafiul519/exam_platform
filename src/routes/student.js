
// ============================================================================
// FILE: src/routes/student.jsh
// PURPOSE: Student Profile & Aggregated Analytics API
// ============================================================================

import { Hono } from 'hono';

const studentRoutes = new Hono();

studentRoutes.get('/profile', async (c) => {
  const nameQuery = (c.req.query('name') || '').trim().toLowerCase();
  if (!nameQuery) {
    return c.json({ success: false, error: 'Student name query required.' }, 400);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT s.*, e.exam_name FROM submissions s 
     LEFT JOIN exams e ON s.exam_id = e.id 
     WHERE s.student_name_lower = ? 
     ORDER BY s.submitted_at DESC`
  ).bind(nameQuery).all();

  if (!results || results.length === 0) {
    return c.json({ success: false, error: 'No profile history found for this student name.' }, 404);
  }

  const studentName = results[0].student_name;
  let totalExams = results.length;
  let highestScore = 0;
  let scoreSum = 0;
  const examHistory = [];
  const topicMasteryMap = {};

  for (const r of results) {
    const score = r.score_percentage;
    if (score > highestScore) highestScore = score;
    scoreSum += score;

    examHistory.push({
      submission_id: r.id,
      exam_name: r.exam_name || 'Live Exam',
      submitted_at: r.submitted_at,
      score_percentage: score,
      total_right: r.total_right,
      total_wrong: r.total_wrong,
      total_questions: r.total_questions,
      total_time_sec: r.total_time_sec,
    });

    // Aggregate topic performance
    const breakdown = JSON.parse(r.topic_breakdown_json || '[]');
    for (const t of breakdown) {
      const key = `${t.chapter} - ${t.topic}`;
      if (!topicMasteryMap[key]) {
        topicMasteryMap[key] = { chapter: t.chapter, topic: t.topic, total_right: 0, total_asked: 0 };
      }
      topicMasteryMap[key].total_right += t.right;
      topicMasteryMap[key].total_asked += t.total;
    }
  }

  const averageScore = Number((scoreSum / totalExams).toFixed(1));
  const aggregatedStrong = [];
  const aggregatedWeak = [];

  for (const key of Object.keys(topicMasteryMap)) {
    const item = topicMasteryMap[key];
    const acc = item.total_asked > 0 ? Math.round((item.total_right / item.total_asked) * 100) : 0;
    if (acc >= 70) {
      aggregatedStrong.push({ chapter: item.chapter, topic: item.topic, accuracy: acc });
    } else {
      aggregatedWeak.push({ chapter: item.chapter, topic: item.topic, accuracy: acc });
    }
  }

  return c.json({
    success: true,
    profile: {
      student_name: studentName,
      total_exams_attempted: totalExams,
      highest_score: highestScore,
      average_score: averageScore,
      exam_history: examHistory,
      strong_topics: aggregatedStrong,
      weak_topics: aggregatedWeak,
    },
  });
});

export default studentRoutes;
  
