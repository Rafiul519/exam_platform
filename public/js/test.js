// ============================================================================
// FILE: public/js/test.js
// PURPOSE: Live exam runner, upward stopwatch, clean sequential navigation & submission
// ============================================================================

let questions = [];
let currentIndex = 0;
let questionStates = [];
let totalSecondsElapsed = 0;
let mainTimerInterval = null;

document.addEventListener('DOMContentLoaded', () => {
  const token = sessionStorage.getItem('exam_session_token');
  const studentName = sessionStorage.getItem('exam_student_name') || 'Student';

  if (!token) {
    window.location.href = '/';
    return;
  }

  document.getElementById('studentNameBadge').textContent = studentName;

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && questionStates[currentIndex]) {
      questionStates[currentIndex].tab_switches += 1;
    }
  });

  // FIXED: Single clean event binding to prevent double-incrementing navigation bug
  document.getElementById('prevBtn').addEventListener('click', () => goToQuestion(currentIndex - 1));
  document.getElementById('nextBtn').addEventListener('click', handleNextButton);
  document.getElementById('clearSelectionBtn').addEventListener('click', handleClearOrSkip);
  document.getElementById('openSubmitModalBtn').addEventListener('click', openConfirmModal);
  document.getElementById('cancelSubmitBtn').addEventListener('click', closeConfirmModal);
  document.getElementById('confirmFinalSubmitBtn').addEventListener('click', submitExamToServer);

  loadLiveQuestions(token);
});

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

    questionStates = questions.map((q) => ({
      question_id: q.id,
      selected_option: null,
      visited: false,
      time_spent_sec: 0,
      option_changes: 0,
      tab_switches: 0,
    }));

    startUpwardStopwatch();
    goToQuestion(0);
  } catch (err) {
    alert('Network error while loading questions.');
  }
}

function startUpwardStopwatch() {
  if (mainTimerInterval) clearInterval(mainTimerInterval);

  mainTimerInterval = setInterval(() => {
    totalSecondsElapsed += 1;
    if (questionStates[currentIndex]) {
      questionStates[currentIndex].time_spent_sec += 1;
      document.getElementById('qCurrentTimer').textContent = `${questionStates[currentIndex].time_spent_sec}s`;
    }

    const mins = Math.floor(totalSecondsElapsed / 60);
    const secs = totalSecondsElapsed % 60;
    document.getElementById('upwardTimer').textContent =
      `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }, 1000);
}

function goToQuestion(index) {
  if (index < 0 || index >= questions.length) return;

  currentIndex = index;
  const q = questions[currentIndex];
  const state = questionStates[currentIndex];
  state.visited = true;

  document.getElementById('qNumberDisplay').textContent = `Question ${currentIndex + 1} of ${questions.length}`;
  document.getElementById('qChapterBadge').textContent = `${q.chapter} • ${q.topic}`;
  document.getElementById('qCurrentTimer').textContent = `${state.time_spent_sec}s`;
  document.getElementById('questionText').textContent = q.question_text;

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

  document.getElementById('prevBtn').disabled = currentIndex === 0;
  const nextBtn = document.getElementById('nextBtn');
  if (currentIndex === questions.length - 1) {
    nextBtn.textContent = 'Review & Submit →';
  } else {
    nextBtn.textContent = 'Save & Next →';
  }

  renderPalette();
}

/**
 * FIXED: Handles Next button click sequentially without skipping
 */
function handleNextButton() {
  if (currentIndex === questions.length - 1) {
    openConfirmModal();
  } else {
    goToQuestion(currentIndex + 1);
  }
}

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

function renderPalette() {
  let selectedCount = 0;
  let skippedCount = 0;
  let unvisitedCount = 0;

  const grid = document.getElementById('paletteGrid');
  grid.innerHTML = questionStates
    .map((st, idx) => {
      let statusClass = '';
      if (st.selected_option) {
        statusClass = 'answered';
        selectedCount++;
      } else if (st.visited) {
        statusClass = 'skipped';
        skippedCount++;
      } else {
        unvisitedCount++;
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

    if (mainTimerInterval) clearInterval(mainTimerInterval);
    closeConfirmModal();
    window.location.href = `/result.html?id=${encodeURIComponent(data.submission_id)}`;
  } catch (err) {
    alert('Network error while submitting.');
    btn.disabled = false;
    btn.textContent = 'Yes, Submit Now';
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  }
