
// ============================================================================
// FILE: src/utils/scoring.js
// PURPOSE:
// 1. Grades the student's exam strictly on the server (Never trust frontend).
// 2. Computes Topic-wise & Chapter-wise Right/Wrong/Time analytics.
// 3. Identifies "You Did Better In" vs "Needs More Focus" topics.
// 4. Runs Universe-Grade Anti-Cheat Telemetry analysis.
// ============================================================================

/**
 * Evaluates a student's submission against the official database questions.
 *
 * @param {Array} dbQuestions - Official question rows from Cloudflare D1
 * @param {Array} studentResponses - Array from frontend: [{ question_id, selected_option, time_spent_sec, option_changes, tab_switches }]
 * @param {number} serverElapsedSec - Actual seconds between Start API and Submit API on server
 */
export function evaluateSubmission(dbQuestions, studentResponses, serverElapsedSec) {
  // Map student responses by question_id for O(1) instant lookup
  const responseMap = new Map();
  if (Array.isArray(studentResponses)) {
    for (const item of studentResponses) {
      if (item && item.question_id) {
        responseMap.set(String(item.question_id), {
          selected_option: ['A', 'B', 'C', 'D'].includes(item.selected_option)
            ? item.selected_option
            : null,
          // Prevent negative or fake NaN numbers from buggy/tampered requests
          time_spent_sec: Math.max(0, Number(item.time_spent_sec) || 0),
          option_changes: Math.max(0, Number(item.option_changes) || 0),
          tab_switches: Math.max(0, Number(item.tab_switches) || 0),
        });
      }
    }
  }

  let totalSelected = 0;
  let totalSkipped = 0;
  let totalRight = 0;
  let totalWrong = 0;
  let reportedTimeSum = 0;

  // Objects to group performance by Topic and Chapter
  const topicStats = {};
  const paperReview = [];

  // Anti-cheat telemetry counters
  let impossibleFastHardCount = 0;
  let totalTabSwitches = 0;
  let roboticTimingTimes = [];
  let zeroExplorationAnsweredCount = 0;

  for (let index = 0; index < dbQuestions.length; index++) {
    const q = dbQuestions[index];
    const studentAns = responseMap.get(q.id) || {
      selected_option: null,
      time_spent_sec: 0,
      option_changes: 0,
      tab_switches: 0,
    };

    const selected = studentAns.selected_option;
    const timeSpent = Math.round(studentAns.time_spent_sec);
    reportedTimeSum += timeSpent;
    totalTabSwitches += studentAns.tab_switches;

    let status = 'SKIPPED'; // 'RIGHT', 'WRONG', or 'SKIPPED'

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

        // ANTI-CHEAT CHECK 1: Cognitive Velocity Trap
        // If a student gets a long/Hard question right in under 5 seconds
        const wordCount = (q.question_text || '').split(/\s+/).length;
        if ((q.difficulty === 'Hard' || wordCount > 25) && timeSpent < 5) {
          impossibleFastHardCount++;
        }
      } else {
        totalWrong++;
        status = 'WRONG';
      }
    }

    // Initialize Topic/Chapter tracker if not seen yet
    const topicKey = `${q.chapter} - ${q.topic}`;
    if (!topicStats[topicKey]) {
      topicStats[topicKey] = {
        chapter: q.chapter,
        topic: q.topic,
        total: 0,
        selected: 0,
        skipped: 0,
        right: 0,
        wrong: 0,
        total_time_sec: 0,
      };
    }

    // Update Topic/Chapter counters
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

    // Add full details for the downloadable Result Paper
    paperReview.push({
      question_number: index + 1,
      question_id: q.id,
      question_text: q.question_text,
      options: {
        A: q.option_a,
        B: q.option_b,
        C: q.option_c,
        D: q.option_d,
      },
      selected_option: selected,
      correct_option: q.correct_option,
      status, // 'RIGHT', 'WRONG', 'SKIPPED'
      time_spent_sec: timeSpent,
      chapter: q.chapter,
      topic: q.topic,
      difficulty: q.difficulty,
      source: q.source,
      explanation: q.explanation,
    });
  }

  // Calculate Topic Accuracy & Categorize into "Better In" vs "Needs More Focus"
  const topicBreakdown = [];
  const strongTopics = [];
  const weakTopics = [];

  for (const key of Object.keys(topicStats)) {
    const item = topicStats[key];
    const accuracy = item.total > 0 ? Math.round((item.right / item.total) * 100) : 0;
    const avgTime = item.total > 0 ? Number((item.total_time_sec / item.total).toFixed(1)) : 0;

    const summary = {
      ...item,
      accuracy_percent: accuracy,
      avg_time_sec: avgTime,
    };
    topicBreakdown.push(summary);

    // If accuracy >= 70%, mark as Strong ("You do better in this chapter/topic")
    // Otherwise mark as Weak ("Needs more focus")
    if (accuracy >= 70) {
      strongTopics.push({
        chapter: item.chapter,
        topic: item.topic,
        accuracy_percent: accuracy,
        avg_time_sec: avgTime,
      });
    } else {
      weakTopics.push({
        chapter: item.chapter,
        topic: item.topic,
        accuracy_percent: accuracy,
        wrong: item.wrong,
        skipped: item.skipped,
        avg_time_sec: avgTime,
      });
    }
  }

  // ==========================================================================
  // ANTI-CHEAT TELEMETRY SCORING ENGINE
  // ==========================================================================
  let cheatingRiskScore = 0;
  const cheatingFlags = [];

  // Flag 1: Impossible Reading + Solving Speed on Hard Questions
  if (impossibleFastHardCount >= 2) {
    cheatingRiskScore += 40;
    cheatingFlags.push(
      `Answered ${impossibleFastHardCount} complex/hard questions correctly in under 5 seconds (Faster than human reading speed).`
    );
  }

  // Flag 2: Tab Switching / App Minimizing
  if (totalTabSwitches >= 3) {
    cheatingRiskScore += Math.min(35, totalTabSwitches * 10);
    cheatingFlags.push(
      `Switched tabs or minimized browser ${totalTabSwitches} times during the exam.`
    );
  }

  // Flag 3: Flatline "Photo-Solver" Rhythm (Every question takes ~12-22s with low variance)
  if (roboticTimingTimes.length >= 5) {
    const mean =
      roboticTimingTimes.reduce((a, b) => a + b, 0) / roboticTimingTimes.length;
    const variance =
      roboticTimingTimes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) /
      roboticTimingTimes.length;
    const stdDev = Math.sqrt(variance);

    if (mean >= 10 && mean <= 25 && stdDev < 2.5) {
      cheatingRiskScore += 30;
      cheatingFlags.push(
        `Robotic secondary-device timing pattern detected (StdDev: ${stdDev.toFixed(1)}s across questions).`
      );
    }
  }

  // Flag 4: Ballistic Clicking (Answering almost everything in <4s with 0 option changes)
  if (totalSelected >= 5 && zeroExplorationAnsweredCount / totalSelected >= 0.7) {
    cheatingRiskScore += 30;
    cheatingFlags.push(
      `Ballistic clicking: ${zeroExplorationAnsweredCount}/${totalSelected} answers selected in under 4s with zero hesitation.`
    );
  }

  cheatingRiskScore = Math.min(100, cheatingRiskScore);

  // Use server-verified elapsed time if client time is tampered with
  const totalTimeSec =
    reportedTimeSum > 0 ? reportedTimeSum : Math.max(1, serverElapsedSec);
  const totalQuestions = dbQuestions.length;
  const scorePercentage =
    totalQuestions > 0 ? Number(((totalRight / totalQuestions) * 100).toFixed(2)) : 0;
  const avgTimePerQ =
    totalSelected > 0 ? Number((totalTimeSec / totalSelected).toFixed(1)) : 0;

  return {
    totalQuestions,
    totalSelected,
    totalSkipped,
    totalRight,
    totalWrong,
    scorePercentage,
    totalTimeSec,
    avgTimePerQ,
    strongTopics,
    weakTopics,
    topicBreakdown,
    paperReview,
    cheatingRiskScore,
    cheatingFlags,
  };
          }
    
