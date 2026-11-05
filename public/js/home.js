// ============================================================================
// FILE: public/js/home.js
// PURPOSE:
// 1. Fetches live exam schedule from /api/exam/status.
// 2. Runs an accurate countdown synced with the Cloudflare Server's clock.
// 3. Unlocks the "Enter Name" box automatically when countdown hits 00:00:00.
// 4. Searches student results by name via /api/result/search (shows 2-min timer if still processing).
// ============================================================================

let countdownInterval = null;
let serverTimeOffsetSec = 0; // Difference between server clock and phone clock

document.addEventListener('DOMContentLoaded', () => {
  checkLiveExamStatus();

  // Attach form listeners
  document.getElementById('startExamForm').addEventListener('submit', handleStartExam);
  document.getElementById('searchResultForm').addEventListener('submit', handleResultSearch);

  // If redirected with ?search=Name in URL, auto-run result search
  const params = new URLSearchParams(window.location.search);
  const prefillName = params.get('search');
  if (prefillName) {
    document.getElementById('searchNameInput').value = prefillName;
    runResultSearch(prefillName);
  }
});

/**
 * 1. Fetches whether a Live Exam is available from the backend
 */
async function checkLiveExamStatus() {
  const badge = document.getElementById('examStatusBadge');
  const subtitle = document.getElementById('examSubtitle');
  const noExamBox = document.getElementById('noExamBox');
  const liveExamBox = document.getElementById('liveExamBox');

  try {
    const res = await fetch('/api/exam/status');
    const data = await res.json();

    if (!data.success || !data.available) {
      badge.textContent = 'Not Available';
      badge.className = 'badge badge-closed';
      subtitle.textContent = 'Currently there is no active live examination.';
      noExamBox.style.display = 'block';
      liveExamBox.style.display = 'none';
      return;
    }

    // Calculate clock offset so student cannot cheat by changing their phone's time
    const clientNow = Math.floor(Date.now() / 1000);
    serverTimeOffsetSec = (data.server_time || clientNow) - clientNow;

    const exam = data.exam;
    liveExamBox.style.display = 'block';
    noExamBox.style.display = 'none';

    document.getElementById('liveExamTitle').textContent = exam.exam_name;
    const scheduleDateStr = new Date(exam.scheduled_at * 1000).toLocaleString();
    document.getElementById('liveExamMeta').textContent =
      `Scheduled: ${scheduleDateStr} • Total Questions: ${exam.total_questions} • No Time Tilme Limit⌚`;

    // Start countdown or immediately show Name Input if time has arrived
    startExamCountdown(exam.scheduled_at);
  } catch (err) {
    badge.textContent = 'Connection Error';
    subtitle.textContent = 'Unable to reach server. Please refresh the page.';
  }
}

/**
 * 2. Runs the live countdown and reveals the "Enter Name" form once time arrives
 */
function startExamCountdown(scheduledAtSec) {
  const badge = document.getElementById('examStatusBadge');
  const subtitle = document.getElementById('examSubtitle');
  const countdownWrapper = document.getElementById('countdownWrapper');
  const startExamForm = document.getElementById('startExamForm');

  if (countdownInterval) clearInterval(countdownInterval);

  function tick() {
    const syncedServerNow = Math.floor(Date.now() / 1000) + serverTimeOffsetSec;
    const remaining = scheduledAtSec - syncedServerNow;

    if (remaining <= 0) {
      // Countdown finished! Unlock the Enter Name form
      clearInterval(countdownInterval);
      badge.textContent = '● Live Now';
      badge.className = 'badge badge-live';
      subtitle.textContent = 'Exam is open! Enter your name below to begin.';
      countdownWrapper.style.display = 'none';
      startExamForm.style.display = 'block';
      return;
    }

    // Still counting down
    badge.textContent = 'Upcoming';
    badge.className = 'badge badge-wait';
    subtitle.textContent = 'Test is scheduled. Waiting for countdown to finish...';
    countdownWrapper.style.display = 'block';
    startExamForm.style.display = 'none';

    const days = Math.floor(remaining / 86400);
    const hours = Math.floor((remaining % 86400) / 3600);
    const mins = Math.floor((remaining % 3600) / 60);
    const secs = remaining % 60;

    document.getElementById('cdDays').textContent = String(days).padStart(2, '0');
    document.getElementById('cdHours').textContent = String(hours).padStart(2, '0');
    document.getElementById('cdMins').textContent = String(mins).padStart(2, '0');
    document.getElementById('cdSecs').textContent = String(secs).padStart(2, '0');
  }

  tick();
  countdownInterval = setInterval(tick, 1000);
}

/**
 * 3. Starts the student session when they enter their name and tap Start
 */
async function handleStartExam(e) {
  e.preventDefault();
  const nameInput = document.getElementById('studentNameInput');
  const btn = document.getElementById('startExamBtn');
  const errBox = document.getElementById('startExamError');

  const studentName = nameInput.value.trim();
  if (!studentName) return;

  btn.disabled = true;
  btn.textContent = 'Starting Session...';
  errBox.style.display = 'none';

  try {
    const res = await fetch('/api/exam/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_name: studentName }),
    });
    const data = await res.json();

    if (!data.success) {
      errBox.textContent = data.error || 'Could not start exam.';
      errBox.style.display = 'block';
      btn.disabled = false;
      btn.textContent = '🚀 Enter Live Test Now';
      return;
    }

    // Store Student Session JWT in sessionStorage for test.html
    sessionStorage.setItem('exam_session_token', data.session_token);
    sessionStorage.setItem('exam_submission_id', data.submission_id);
    sessionStorage.setItem('exam_student_name', data.student_name);

    // Redirect to the Live Test Page
    window.location.href = '/test.html';
  } catch (err) {
    errBox.textContent = 'Network error. Please try again.';
    errBox.style.display = 'block';
    btn.disabled = false;
    btn.textContent = '🚀 Enter Live Test Now';
  }
}

/**
 * 4. Searches student results by Name
 */
async function handleResultSearch(e) {
  e.preventDefault();
  const query = document.getElementById('searchNameInput').value.trim();
  if (query.length < 2) return;
  await runResultSearch(query);
}

async function runResultSearch(query) {
  const container = document.getElementById('searchResultsList');
  container.innerHTML = `<p style="color:var(--text-muted); font-size:0.9rem;">Searching results for "${escapeHtml(query)}"...</p>`;

  try {
    const res = await fetch(`/api/result/search?name=${encodeURIComponent(query)}`);
    const data = await res.json();

    if (!data.success || !data.results || data.results.length === 0) {
      container.innerHTML = `
        <div style="padding:14px; border-radius:12px; background:rgba(15,23,42,0.6); border:1px solid var(--border-subtle); font-size:0.9rem; color:var(--text-muted);">
          No result found for <strong>"${escapeHtml(query)}"</strong>. Please check the spelling of your name.
        </div>`;
      return;
    }

    container.innerHTML = data.results
      .map((item) => {
        const dateStr = new Date(item.submitted_at * 1000).toLocaleString();
        const statusBadge = item.is_ready
          ? `<span class="badge badge-live">Score: ${item.score_percentage}%</span>`
          : `<span class="badge badge-wait">⏳ Ready in ${item.wait_seconds}s</span>`;

        return `
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px; border-radius:12px; background:rgba(15,23,42,0.75); border:1px solid var(--border-subtle); margin-bottom:10px;">
            <div>
              <div style="font-weight:700; font-size:0.98rem;">${escapeHtml(item.student_name)}</div>
              <div style="font-size:0.8rem; color:var(--text-muted);">${escapeHtml(item.exam_name)} • ${dateStr}</div>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              ${statusBadge}
              <a href="/result.html?id=${encodeURIComponent(item.submission_id)}" class="btn" style="padding:8px 12px; font-size:0.82rem;">
                View Result
              </a>
            </div>
          </div>
        `;
      })
      .join('');
  } catch (err) {
    container.innerHTML = `<p style="color:var(--rose); font-size:0.9rem;">Failed to search results. Please try again.</p>`;
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  }
      
