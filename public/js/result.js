
// ============================================================================
// FILE: public/js/result.js
// PURPOSE:
// 1. Loads student result from /api/result/:id.
// 2. If 2-minute lock is active, shows live countdown and auto-loads when done.
// 3. Selects motivational sentence from HTML <template> based on score.
// 4. Renders Topic-wise Right/Wrong/Time analysis & full downloadable PDF paper.
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const submissionId = params.get('id');

  if (!submissionId) {
    window.location.href = '/';
    return;
  }

  document.getElementById('downloadPdfBtn').addEventListener('click', () => {
    window.print();
  });

  fetchResultData(submissionId);
});

async function fetchResultData(submissionId) {
  try {
    // If Admin is logged in on this browser, send Admin token so Admin can view immediately
    const adminToken = localStorage.getItem('admin_jwt_token');
    const headers = {};
    if (adminToken) {
      headers['Authorization'] = `Bearer ${adminToken}`;
    }

    const res = await fetch(`/api/result/${encodeURIComponent(submissionId)}`, { headers });
    const data = await res.json();

    // Handle 2-minute (120s) Result Quarantine Lock
    if (res.status === 425 || data.locked) {
      showQuarantineCountdown(submissionId, data.unlock_at, data.server_time);
      return;
    }

    if (!data.success || !data.result) {
      alert(data.error || 'Result not found.');
      window.location.href = '/';
      return;
    }

    renderFullResult(data.result);
  } catch (err) {
    alert('Failed to load result from server.');
  }
}

/**
 * 1. If student visits before 2 minutes pass, show countdown and auto-refresh
 */
function showQuarantineCountdown(submissionId, unlockAtSec, serverNowSec) {
  const lockedBox = document.getElementById('lockedResultBox');
  const contentBox = document.getElementById('resultContentWrapper');
  const timerEl = document.getElementById('lockedCountdownTimer');

  lockedBox.style.display = 'block';
  contentBox.style.display = 'none';

  const clientNow = Math.floor(Date.now() / 1000);
  const offset = (serverNowSec || clientNow) - clientNow;

  const interval = setInterval(() => {
    const now = Math.floor(Date.now() / 1000) + offset;
    const rem = unlockAtSec - now;

    if (rem <= 0) {
      clearInterval(interval);
      lockedBox.style.display = 'none';
      fetchResultData(submissionId);
      return;
    }

    const mins = Math.floor(rem / 60);
    const secs = rem % 60;
    timerEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }, 1000);
}

/**
 * 2. Renders the complete Result Page, Motivational Quote, Topic Tables & Paper
 */
function renderFullResult(r) {
  document.getElementById('lockedResultBox').style.display = 'none';
  document.getElementById('resultContentWrapper').style.display = 'block';

  document.getElementById('resExamName').textContent = r.exam_name;
  document.getElementById('resStudentName').textContent = r.student_name;
  document.getElementById('resSubmittedDate').textContent =
    `Submitted on ${new Date(r.submitted_at * 1000).toLocaleString()}`;
  document.getElementById('resScorePercent').textContent = `${r.score_percentage}%`;

  // Pick Motivational Sentence from HTML <template id="motivationalQuotesTemplate">
  const template = document.getElementById('motivationalQuotesTemplate');
  const quoteNodes = template.content.querySelectorAll('div[data-min]');
  let chosenQuote = 'Keep practicing and analyzing your performance!';
  quoteNodes.forEach((node) => {
    const min = parseFloat(node.getAttribute('data-min'));
    const max = parseFloat(node.getAttribute('data-max'));
    if (r.score_percentage >= min && r.score_percentage <= max) {
      chosenQuote = node.textContent.trim();
    }
  });
  document.getElementById('motivationalText').textContent = chosenQuote;

  // Core Counts
  document.getElementById('statSelected').textContent = `${r.total_selected} / ${r.total_questions}`;
  document.getElementById('statSkipped').textContent = r.total_skipped;
  document.getElementById('statRight').textContent = r.total_right;
  document.getElementById('statWrong').textContent = r.total_wrong;

  // Time Metrics
  const mins = Math.floor(r.total_time_sec / 60);
  const secs = r.total_time_sec % 60;
  document.getElementById('statTotalTime').textContent = `${mins}m ${secs}s`;
  document.getElementById('statAvgTime').textContent = `${r.avg_time_per_q}s`;

  const attemptAccuracy =
    r.total_selected > 0 ? Math.round((r.total_right / r.total_selected) * 100) : 0;
  document.getElementById('statAccuracy').textContent = `${attemptAccuracy}%`;

  // Render Strong Topics ("You Do Better In")
  const strongEl = document.getElementById('strongTopicsList');
  if (!r.strong_topics || r.strong_topics.length === 0) {
    strongEl.innerHTML = `<p style="font-size:0.88rem; color:var(--text-muted);">No chapters crossed 70% accuracy in this test yet. Focus on the weak topics to build mastery!</p>`;
  } else {
    strongEl.innerHTML = r.strong_topics
      .map(
        (t) => `
        <div style="padding:10px 12px; border-radius:10px; background:rgba(16,185,129,0.1); border:1px solid rgba(16,185,129,0.3); margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:700; font-size:0.92rem;">${escapeHtml(t.chapter)}</div>
            <div style="font-size:0.8rem; color:var(--text-muted);">Topic: ${escapeHtml(t.topic)} • ⌚ Avg ${t.avg_time_sec}s</div>
          </div>
          <span class="badge badge-live">${t.accuracy_percent}% Right</span>
        </div>`
      )
      .join('');
  }

  // Render Weak Topics ("Needs More Focus")
  const weakEl = document.getElementById('weakTopicsList');
  if (!r.weak_topics || r.weak_topics.length === 0) {
    weakEl.innerHTML = `<p style="font-size:0.88rem; color:var(--emerald);">Awesome! You scored above 70% across every single chapter and topic!</p>`;
  } else {
    weakEl.innerHTML = r.weak_topics
      .map(
        (t) => `
        <div style="padding:10px 12px; border-radius:10px; background:rgba(245,158,11,0.1); border:1px solid rgba(245,158,11,0.3); margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:700; font-size:0.92rem;">${escapeHtml(t.chapter)}</div>
            <div style="font-size:0.8rem; color:var(--text-muted);">Topic: ${escapeHtml(t.topic)} • Wrong: ${t.wrong}, Skipped: ${t.skipped}</div>
          </div>
          <span class="badge badge-wait">${t.accuracy_percent}% Accuracy</span>
        </div>`
      )
      .join('');
  }

  // Render Topic Breakdown Table
  const tbody = document.getElementById('topicBreakdownTableBody');
  tbody.innerHTML = (r.topic_breakdown || [])
    .map(
      (row) => `
      <tr>
        <td>
          <div style="font-weight:700;">${escapeHtml(row.chapter)}</div>
          <div style="font-size:0.78rem; color:var(--text-muted);">${escapeHtml(row.topic)}</div>
        </td>
        <td>${row.total}</td>
        <td style="color:var(--emerald); font-weight:700;">${row.right}</td>
        <td style="color:var(--rose); font-weight:700;">${row.wrong}</td>
        <td style="color:var(--amber);">${row.skipped}</td>
        <td>${row.avg_time_sec}s</td>
        <td><strong>${row.accuracy_percent}%</strong></td>
      </tr>`
    )
    .join('');

  // Render Admin Anti-Cheat Box if Admin is viewing
  if (typeof r.cheating_risk_score === 'number') {
    const adminBox = document.getElementById('adminAntiCheatBox');
    adminBox.style.display = 'block';
    document.getElementById('cheatScoreBadge').textContent = `Risk Score: ${r.cheating_risk_score}/100`;
    const flags = r.cheating_flags || [];
    document.getElementById('cheatFlagsList').innerHTML =
      flags.length === 0
        ? '✅ Clean session: No suspicious timing or tab-switching anomalies detected.'
        : flags.map((f) => `<div>⚠️ ${escapeHtml(f)}</div>`).join('');
  }

  // Render Full Question Paper Review
  const paperEl = document.getElementById('paperReviewContainer');
  paperEl.innerHTML = (r.paper_review || [])
    .map((q) => {
      let badgeHtml = `<span class="badge badge-wait">Skipped</span>`;
      if (q.status === 'RIGHT') badgeHtml = `<span class="badge badge-live">✓ Correct</span>`;
      if (q.status === 'WRONG')
        badgeHtml = `<span class="badge" style="background:rgba(239,68,68,0.2); color:#f87171;">✗ Wrong</span>`;

      const optionsHtml = ['A', 'B', 'C', 'D']
        .map((opt) => {
          const isCorrect = q.correct_option === opt;
          const isSelected = q.selected_option === opt;
          let borderStyle = 'border: 1px solid var(--border-subtle);';
          let tag = '';

          if (isCorrect) {
            borderStyle = 'border: 1.5px solid var(--emerald); background: rgba(16,185,129,0.1);';
            tag = ' <strong style="color:var(--emerald); font-size:0.78rem;">(Correct Answer)</strong>';
          } else if (isSelected && !isCorrect) {
            borderStyle = 'border: 1.5px solid var(--rose); background: rgba(239,68,68,0.1);';
            tag = ' <strong style="color:var(--rose); font-size:0.78rem;">(Your Choice)</strong>';
          }

          return `
            <div style="padding:8px 12px; border-radius:8px; margin-bottom:6px; font-size:0.9rem; ${borderStyle}">
              <strong>${opt}.</strong> ${escapeHtml(q.options[opt])} ${tag}
            </div>`;
        })
        .join('');

      return `
        <div style="padding:16px; border-radius:12px; background:rgba(15,23,42,0.55); border:1px solid var(--border-subtle); margin-bottom:14px;">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:8px;">
            <div>
              <strong style="color:#38bdf8;">Q${q.question_number}.</strong>
              <span style="font-size:0.78rem; color:var(--text-muted); margin-left:6px;">
                [${escapeHtml(q.chapter)} • ${escapeHtml(q.topic)} • ${escapeHtml(q.difficulty)}]
              </span>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-size:0.8rem; color:var(--text-muted);">⌚ Time: <strong>${q.time_spent_sec}s</strong></span>
              ${badgeHtml}
            </div>
          </div>

          <div style="font-weight:600; font-size:0.98rem; margin-bottom:12px;">
            ${escapeHtml(q.question_text)}
          </div>

          <div>${optionsHtml}</div>

          <div style="margin-top:10px; padding:10px; border-radius:8px; background:rgba(30,41,59,0.7); font-size:0.85rem; color:#cbd5e1;">
            <strong>💡 Explanation (${escapeHtml(q.source || 'Standard')}):</strong>
            ${escapeHtml(q.explanation || 'No additional explanation provided.')}
          </div>
        </div>
      `;
    })
    .join('');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
    }
                
