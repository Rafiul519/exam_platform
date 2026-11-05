
// ============================================================================
// FILE: public/js/test.js
// PURPOSE:
// 1. Loads sanitized questions from /api/exam/questions using Student JWT.
// 2. Runs the Upward Stopwatch (⌚) + records exact seconds spent on EACH question.
// 3. Renders one question at a time + color-coded Question Sheet (1, 2, 3, 4...).
// 4. Handles Submit Confirmation Modal & 2-Minute Post-Submit Countdown.
// ============================================================================

let questions = [];
let currentIndex = 0;

// Stores student state per question:
// { selected_option: null|'A'|'B'|'C'|'D', visited: bool, time_spent_sec: 0, option_changes: 0, tab_switches: 0 }
let questionStates = [];

let totalSecondsElapsed = 0;
let mainTimerInterval = null;

document.addEventListener('DOMContentLoaded', () => {
  const token = sessionStorage.getItem('exam_session_token');
  const studentName = sessionStorage.getItem('exam_student_name') || 'Student';

  // If student opened test.html directly without entering name on Home Page, redirect home
  if (!token) {
    window.location.href = '/';
    return;
  }

  document.getElementById('studentNameBadge').textContent = studentName;

  // Track tab switches for anti-cheat telemetry
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && questionStates[currentIndex]) {
      questionStates[currentIndex].tab_switches += 1;
    }
  });

  // Bind navigation & submit buttons
  document.getElementById('prevBtn').addEventListener('click', () => goToQuestion(currentIndex - 1));
  document.getElementById('nextBtn').addEventListener('click', () => goToQuestion(currentIndex + 1));
  document.getElementById('clearSelectionBtn').addEventListener('click', handleClearOrSkip);
  document.getElementById('openSubmitModalBtn').addEventListener('click', openConfirmModal);
  document.getElementById('cancelSubmitBtn').addEventListener('click', closeConfirmModal);
  document.getElementById('confirmFinalSubmitBtn').addEventListener('click', submitExamToServer);

  loadLiveQuestions(token);
});

/**
 * 1. Fetches sanitized questions from backend
 */
async function loadLiveQuestions(token) {
  try {
    const res = await fetch('/api/exam/questions', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();

    if (!data.success || !Array.isArray(data.questions) || data.questions.length === 0) {
      alert(data.error || 'Could not load exam questions.');
      window.location.href = '/';
      return;
    }

    questions = data.questions;
    document.getElementById('topExamName').textContent = data.exam_name || 'Live Test';

    // Initialize state tracker for every question
    questionStates = questions.map((q) => ({
      question_id: q.id,
      selected_option: null,
      visited: false,
      time_spent_sec: 0,
      option_changes: 0,
      tab_switches: 0,
    }));

    // Start upward stopwatch (⌚)
    startUpwardStopwatch();

    // Render first question & palette
    goToQuestion(0);
  } catch (err) {
    alert('Network error while loading questions.');
  }
}

/**
 * 2. Upward Stopwatch (Unlimited time mode — tracks total time & per-question time)
 */
function startUpwardStopwatch() {
  if (mainTimerInterval) clearInterval(mainTimerInterval);

  mainTimerInterval = setInterval(() => {
    totalSecondsElapsed += 1;

    // Increment time spent on the currently active question
    if (questionStates[currentIndex]) {
      questionStates[currentIndex].time_spent_sec += 1;
      document.getElementById('qCurrentTimer').textContent =
        `${questionStates[currentIndex].time_spent_sec}s`;
    }

    // Format MM:SS or HH:MM:SS for topbar
    const hrs = Math.floor(totalSecondsElapsed / 3600);
    const mins = Math.floor((totalSecondsElapsed % 3600) / 60);
    const secs = totalSecondsElapsed % 60;

    const formatted =
      hrs > 0
        ? `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
        : `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    document.getElementById('upwardTimer').textContent = formatted;
  }, 1000);
}

/**
 * 3. Renders a single question and updates the Question Sheet Palette
 */
function goToQuestion(index) {
  if (index < 0 || index >= questions.length) return;

  currentIndex = index;
  const q = questions[currentIndex];
  const state = questionStates[currentIndex];

  // Mark as visited so if left blank, it shows as Skipped (Amber)
  state.visited = true;

  // Update Header Meta
  document.getElementById('qNumberDisplay').textContent =
    `Question ${currentIndex + 1} of ${questions.length}`;
  document.getElementById('qChapterBadge').textContent = `${q.chapter} • ${q.topic}`;
  document.getElementById('qCurrentTimer').textContent = `${state.time_spent_sec}s`;
  document.getElementById('questionText').textContent = q.question_text;

  // Render Options A, B, C, D
  const optionsContainer = document.getElementById('optionsContainer');
  optionsContainer.innerHTML = ['A', 'B', 'C', 'D']
    .map((letter) => {
      const isSelected = state.selected_option === letter;
      return `
        <button
          type="button"
          class="option-btn ${isSelected ? 'selected' : ''}"
          onclick="selectOption('${letter}')"
        >
          <span class="opt-letter">${letter}</span>
          <span>${escapeHtml(q.options[letter])}</span>
        </button>
      `;
    })
    .join('');

  // Enable/disable Previous & Next buttons appropriately
  document.getElementById('prevBtn').disabled = currentIndex === 0;
  const nextBtn = document.getElementById('nextBtn');
  if (currentIndex === questions.length - 1) {
    nextBtn.textContent = 'Review & Submit →';
    nextBtn.onclick = openConfirmModal;
  } else {
    nextBtn.textContent = 'Save & Next →';
    nextBtn.onclick = () => goToQuestion(currentIndex + 1);
  }

  renderPalette();
}

/**
 * 4. Handles clicking Option A, B, C, or D
 */
window.selectOption = function (letter) {
  const state = questionStates[currentIndex];
  if (state.selected_option !== letter) {
    if (state.selected_option !== null) {
      state.option_changes += 1;
    }
    state.selected_option = letter;
  }
  goToQuestion(currentIndex);
};

/**
 * 5. Clears selection and moves to next question as Skipped
 */
function handleClearOrSkip() {
  const state = questionStates[currentIndex];
  state.selected_option = null;
  state.visited = true;

  if (currentIndex < questions.length - 1) {
    goToQuestion(currentIndex + 1);
  } else {
    goToQuestion(currentIndex);
  }
}

/**
 * 6. Renders the Color-Coded Question Sheet Palette (1, 2, 3, 4...)
 */
function renderPalette() {
  let selectedCount = 0;
  let skippedCount = 0;
  let unvisitedCount = 0;

  const grid = document.getElementById('paletteGrid');
  grid.innerHTML = questionStates
    .map((st, idx) => {
      let statusClass = '';
      if (st.selected_option) {
        statusClass = 'answered'; // Green
        selectedCount++;
      } else if (st.visited) {
        statusClass = 'skipped'; // Amber
        skippedCount++;
      } else {
        unvisitedCount++; // Slate Grey
      }

      const currentClass = idx === currentIndex ? 'current' : '';
      return `
        <button
          type="button"
          class="q-sheet-btn ${statusClass} ${currentClass}"
          onclick="goToQuestion(${idx})"
        >
          ${idx + 1}
        </button>
      `;
    })
    .join('');

  document.getElementById('countSelected').textContent = selectedCount;
  document.getElementById('countSkipped').textContent = skippedCount;
  document.getElementById('countUnvisited').textContent = unvisitedCount;
}

/**
 * 7. Opens Confirmation Modal before submitting
 */
function openConfirmModal() {
  const selectedCount = questionStates.filter((s) => s.selected_option !== null).length;
  const skippedCount = questions.length - selectedCount;

  document.getElementById('modalSelectedCount').textContent = selectedCount;
  document.getElementById('modalSkippedCount').textContent = skippedCount;
  document.getElementById('confirmSubmitModal').classList.add('active');
}

function closeConfirmModal() {
  document.getElementById('confirmSubmitModal').classList.remove('active');
}

/**
 * 8. Submits answers + question codes + timings to /api/exam/submit
 */
async function submitExamToServer() {
  const btn = document.getElementById('confirmFinalSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  const token = sessionStorage.getItem('exam_session_token');

  try {
    const res = await fetch('/api/exam/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ responses: questionStates }),
    });

    const data = await res.json();
    if (!data.success) {
      alert(data.error || 'Failed to submit test.');
      btn.disabled = false;
      btn.textContent = 'Yes, Submit Now';
      return;
    }

    // Stop upward timer
    if (mainTimerInterval) clearInterval(mainTimerInterval);
    closeConfirmModal();

    // Show 2-Minute Result Quarantine Modal
    startTwoMinuteResultTimer(data.submission_id, data.student_name, data.unlock_at, data.server_time);
  } catch (err) {
    alert('Network error while submitting. Please tap Submit again.');
    btn.disabled = false;
    btn.textContent = 'Yes, Submit Now';
  }
}

/**
 * 9. Runs the 2-Minute Countdown before opening the Result Page
 */
function startTwoMinuteResultTimer(submissionId, studentName, unlockAtSec, serverNowSec) {
  const modal = document.getElementById('postSubmitModal');
  const timerDisplay = document.getElementById('twoMinCountdown');
  const viewBtn = document.getElementById('viewResultNowBtn');

  document.getElementById('submittedStudentName').textContent = studentName || 'your name';
  modal.classList.add('active');

  const clientNow = Math.floor(Date.now() / 1000);
  const offset = (serverNowSec || clientNow) - clientNow;

  const interval = setInterval(() => {
    const now = Math.floor(Date.now() / 1000) + offset;
    const remaining = unlockAtSec - now;

    if (remaining <= 0) {
      clearInterval(interval);
      timerDisplay.textContent = '00:00';
      viewBtn.disabled = false;
      viewBtn.textContent = '📊 View Result Now';
      viewBtn.onclick = () => {
        window.location.href = `/result.html?id=${encodeURIComponent(submissionId)}`;
      };
      // Automatically take student to their Result Page!
      window.location.href = `/result.html?id=${encodeURIComponent(submissionId)}`;
      return;
    }

    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    timerDisplay.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    viewBtn.textContent = `Ready in ${remaining}s...`;
  }, 1000);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
        }
      
