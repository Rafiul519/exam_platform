// ============================================================================
// FILE: src/utils/scoring.js
// PURPOSE: Deterministic shuffle, server-side grading, topic analytics & anti-cheat
// ============================================================================

export function shuffleQuestionsForSession(questions, sessionId) {
  if (!Array.isArray(questions) || questions.length <= 1) {
    return questions || [];
  }

  const list = [...questions].sort((a, b) =>
    String(a.id).localeCompare(String(b.id))
  );

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

  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom() * (i + 1));
    const temp = list[i];
    list[i] = list[j];
    list[j] = temp;
  }

  return list;
}

export function evaluateSubmission(dbQuestions, studentResponses, serverElapsedSec, sessionId = '') {
  const responseMap = new Map();
  const submittedOrderIds = [];

  if (Array.isArray(studentResponses)) {
    for (const item of studentResponses) {
      if (item && item.question_id) {
        const qId = String(item.question_id);
        submittedOrderIds.push(qId);
        responseMap.set(qId, {
          selected_option: ['A', 'B', 'C', 'D'].includes(item.selected_option)
            ? item.selected_option
            : null,
          time_spent_sec: Math.max(0, Number(item.time_spent_sec) || 0),
          option_changes: Math.max(0, Number(item.option_changes) || 0),
          tab_switches: Math.max(0, Number(item.tab_switches) || 0)
        });
      }
    }
  }

  let orderedQuestions = shuffleQuestionsForSession(dbQuestions || [], sessionId);

  if (submittedOrderIds.length > 0) {
    const dbMap = new Map(orderedQuestions.map((q) => [String(q.id), q]));
    const reordered = [];
    const seen = new Set();

    for (const id of submittedOrderIds) {
      if (dbMap.has(id) && !seen.has(id)) {
        reordered.push(dbMap.get(id));
        seen.add(id);
      }
    }
    for (const q of orderedQuestions) {
      if (!seen.has(String(q.id))) {
        reordered.push(q);
      }
    }
    orderedQuestions = reordered;
  }

  let totalSelected = 0;
  let totalSkipped = 0;
  let totalRight = 0;
  let totalWrong = 0;
  let reportedTimeSum = 0;

  const topicStats = {};
  const paperReview = [];

  let impossibleFastHardCount = 0;
  let totalTabSwitches = 0;
  let roboticTimingTimes = [];
  let zeroExplorationAnsweredCount = 0;

  for (let index = 0; index < orderedQuestions.length; index++) {
    const q = orderedQuestions[index];
    const studentAns = responseMap.get(q.id) || {
      selected_option: null,
      time_spent_sec: 0,
      option_changes: 0,
      tab_switches: 0
    };

    const selected = studentAns.selected_option;
    const timeSpent = Math.round(studentAns.time_spent_sec);
    reportedTimeSum += timeSpent;
    totalTabSwitches += studentAns.tab_switches;

    let status = 'SKIPPED';

    if (!selected) {
      totalSkipped++;
    } else {
      totalSelected++;
      roboticTimingTimes.push(timeSpent);

      if (studentAns.option_changes === 0 && timeSpent < 4) {
        zeroExplorationAnsweredCount++;
      }

      if (selected === q.correct_option) {
        totalRight++;
        status = 'RIGHT';

        const wordCount = (q.question_text || '').split(/\s+/).length;
        if ((q.difficulty === 'Hard' || wordCount > 25) && timeSpent < 5) {
          impossibleFastHardCount++;
        }
      } else {
        totalWrong++;
        status = 'WRONG';
      }
    }

    const topicKey = q.chapter + ' - ' + q.topic;
    if (!topicStats[topicKey]) {
      topicStats[topicKey] = {
        chapter: q.chapter,
        topic: q.topic,
        total: 0,
        selected: 0,
        skipped: 0,
        right: 0,
        wrong: 0,
        total_time_sec: 0
      };
    }

    const tStat = topicStats[topicKey];
    tStat.total++;
    tStat.total_time_sec += timeSpent;
    if (status === 'SKIPPED') tStat.skipped++;
    if (status === 'RIGHT') {
      tStat.selected++;
      tStat.right++;
    }
    if (status === 'WRONG') {
      tStat.selected++;
      tStat.wrong++;
    }

    paperReview.push({
      question_number: index + 1,
      question_id: q.id,
      question_text: q.question_text,
      options: {
        A: q.option_a,
        B: q.option_b,
        C: q.option_c,
        D: q.option_d
      },
      selected_option: selected,
      correct_option: q.correct_option,
      status: status,
      time_spent_sec: timeSpent,
      chapter: q.chapter,
      topic: q.topic,
      difficulty: q.difficulty,
      source: q.source,
      explanation: q.explanation
    });
  }

  const topicBreakdown = [];
  const strongTopics = [];
  const weakTopics = [];

  for (const key of Object.keys(topicStats)) {
    const item = topicStats[key];
    const accuracy = item.total > 0 ? Math.round((item.right / item.total) * 100) : 0;
    const avgTime = item.total > 0 ? Number((item.total_time_sec / item.total).toFixed(1)) : 0;

    const summary = {
      chapter: item.chapter,
      topic: item.topic,
      total: item.total,
      selected: item.selected,
      skipped: item.skipped,
      right: item.right,
      wrong: item.wrong,
      total_time_sec: item.total_time_sec,
      accuracy_percent: accuracy,
      avg_time_sec: avgTime
    };
    topicBreakdown.push(summary);

    if (accuracy >= 70) {
      strongTopics.push({
        chapter: item.chapter,
        topic: item.topic,
        accuracy_percent: accuracy,
        avg_time_sec: avgTime
      });
    } else {
      weakTopics.push({
        chapter: item.chapter,
        topic: item.topic,
        accuracy_percent: accuracy,
        wrong: item.wrong,
        skipped: item.skipped,
        avg_time_sec: avgTime
      });
    }
  }

  let cheatingRiskScore = 0;
  const cheatingFlags = [];

  if (impossibleFastHardCount >= 2) {
    cheatingRiskScore += 40;
    cheatingFlags.push('Answered ' + impossibleFastHardCount + ' complex/hard questions correctly in under 5 seconds.');
  }

  if (totalTabSwitches >= 3) {
    cheatingRiskScore += Math.min(35, totalTabSwitches * 10);
    cheatingFlags.push('Switched tabs or minimized browser ' + totalTabSwitches + ' times during the exam.');
  }

  if (roboticTimingTimes.length >= 5) {
    const mean = roboticTimingTimes.reduce((a, b) => a + b, 0) / roboticTimingTimes.length;
    const variance = roboticTimingTimes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / roboticTimingTimes.length;
    const stdDev = Math.sqrt(variance);

    if (mean >= 10 && mean <= 25 && stdDev < 2.5) {
      cheatingRiskScore += 30;
      cheatingFlags.push('Robotic secondary-device timing pattern detected (StdDev: ' + stdDev.toFixed(1) + 's).');
    }
  }

  if (totalSelected >= 5 && zeroExplorationAnsweredCount / totalSelected >= 0.7) {
    cheatingRiskScore += 30;
    cheatingFlags.push('Ballistic clicking: ' + zeroExplorationAnsweredCount + '/' + totalSelected + ' answers selected in under 4s.');
  }

  cheatingRiskScore = Math.min(100, cheatingRiskScore);

  const totalTimeSec = reportedTimeSum > 0 ? reportedTimeSum : Math.max(1, serverElapsedSec);
  const totalQuestions = orderedQuestions.length;
  const scorePercentage = totalQuestions > 0 ? Number(((totalRight / totalQuestions) * 100).toFixed(2)) : 0;
  const avgTimePerQ = totalSelected > 0 ? Number((totalTimeSec / totalSelected).toFixed(1)) : 0;

  return {
    totalQuestions: totalQuestions,
    totalSelected: totalSelected,
    totalSkipped: totalSkipped,
    totalRight: totalRight,
    totalWrong: totalWrong,
    scorePercentage: scorePercentage,
    totalTimeSec: totalTimeSec,
    avgTimePerQ: avgTimePerQ,
    strongTopics: strongTopics,
    weakTopics: weakTopics,
    topicBreakdown: topicBreakdown,
    paperReview: paperReview,
    cheatingRiskScore: cheatingRiskScore,
    cheatingFlags: cheatingFlags
  };
      }
      
