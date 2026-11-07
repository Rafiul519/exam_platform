// ============================================================================
// FILE: public/js/test.js
// PURPOSE: 50-50-50 Chunk Loader, Mobile LocalStorage Offline Persistence & Safe Submit
// ============================================================================

let questions = [];
let currentIndex = 0;
let questionStates = [];
let totalSecondsElapsed = 0;
let mainTimerInterval = null;
let examTitle = 'Live Test';
let storageKey = 'exam_offline_default';
let isLoadingPaper = false;

document.addEventListener('DOMContentLoaded', () => {
  const token =
    sessionStorage.getItem('exam_session_token') ||
    localStorage.getItem('active_exam_session_token');
  const studentName =
    sessionStorage.getItem('exam_student_name') ||
    localStorage.getItem('active_exam_student_name') ||
    'Student';

  if (!token) {
    window.location.href = '/';
    return;
  }

  // Backup session token in localStorage so page reload or tab close never logs out student
  sessionStorage.setItem('exam_session_token', token);
  sessionStorage.setItem('exam_student_name', studentName);
  localStorage.setItem('active_exam_session_token', token);
  localStorage.setItem('active_exam_student_name', studentName);

  storageKey = 'exam_state_' + token.slice(-24);

  document.getElementById('studentNameBadge').textContent = studentName;

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && questionStates[currentIndex]) {
      questionStates[currentIndex].tab_switches += 1;
      saveStateToPhone();
    }
  });

  document.getElementById('prevBtn').addEventListener('click', () => {
    if (!isLoadingPaper) goToQuestion(currentIndex - 1);
  });
  document.getElementById('nextBtn').addEventListener('click', () => {
    if (!isLoadingPaper) handleNextButton();
  });
  document.getElementById('clearSelectionBtn').addEventListener('click', () => {
    if (!isLoadingPaper) handleClearOrSkip();
  });
  document.getElementById('openSubmitModalBtn').addEventListener('click', () => {
    if (!isLoadingPaper) openConfirmModal();
  });
  document.getElementById('cancelSubmitBtn').addEventListener('click', closeConfirmModal);
  document.getElementById('confirmFinalSubmitBtn').addEventListener('click', submitExamToServer);

  loadLiveQuestions(token);
});

function saveStateToPhone() {
  if (!questions || questions.length === 0) return;
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        examTitle,
        questions,
        questionStates,
        currentIndex,
        totalSecondsElapsed,
      })
    );
  } catch (e) {}
}

function restoreStateFromPhone() {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (
      saved &&
      Array.isArray(saved.questions) &&
      saved.questions.length > 0 &&
      Array.isArray(saved.questionStates) &&
      saved.questionStates.length === saved.questions.length
    ) {
      examTitle = saved.examTitle || 'Live Test';
      questions = saved.questions;
      questionStates = saved.questionStates;
      currentIndex =
        typeof saved.currentIndex === 'number' &&
        saved.currentIndex >= 0 &&
        saved.currentIndex < questions.length
          ? saved.currentIndex
          : 0;
      totalSecondsElapsed = Number(saved.totalSecondsElapsed) || 0;
      return true;
    }
  } catch (e) {}
  return false;
}

async function fetchChunkWithRetry(url, token, retries = 3) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      return data;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr || new Error('Network error');
}

async function loadLiveQuestions(token) {
  // 1. Instant offline restore if already saved in phone localStorage (reload / tab switch safe)
  if (restoreStateFromPhone()) {
    document.getElementById('topExamName').textContent = examTitle;
    startUpwardStopwatch();
    goToQuestion(currentIndex);
    return;
  }

  // 2. Progressive 50-50-50 chunk download
  isLoadingPaper = true;
  const CHUNK_SIZE = 50;
  let offset = 0;
  let hasMore = true;
  const loadedQuestions = [];
  const seenIds = new Set();

  try {
    while (hasMore) {
      document.getElementById('questionText').textContent =
        loadedQuestions.length > 0
          ? `Loading questions into phone memory... (${loadedQuestions.length} loaded)`
          : 'Loading live questions (Batch 1)...';

      const data = await fetchChunkWithRetry(
        `/api/exam/questions?offset=${offset}&limit=${CHUNK_SIZE}`,
        token,
        3
      );

      if (!data || !data.success || !Array.isArray(data.questions)) {
        alert((data && data.error) || 'Could not load exam questions.');
        window.location.href = '/';
        return;
      }

      if (data.exam_name) {
        examTitle = data.exam_name;
        document.getElementById('topExamName').textContent = examTitle;
      }

      for (const q of data.questions) {
        const idStr = String(q.id);
        if (!seenIds.has(idStr)) {
          seenIds.add(idStr);
          loadedQuestions.push(q);
        }
      }

      if (data.has_more === true && data.questions.length > 0) {
        offset += data.questions.length;
        hasMore = true;
      } else {
        hasMore = false;
      }
    }

    if (loadedQuestions.length === 0) {
      alert('No questions found in this exam.');
      window.location.href = '/';
      return;
    }

    questions = loadedQuestions;
    questionStates = questions.map((q) => ({
      question_id: q.id,
      selected_option: null,
      visited: false,
      time_spent_sec: 0,
      option_changes: 0,
      tab_switches: 0,
    }));

    isLoadingPaper = false;
    saveStateToPhone();
    startUpwardStopwatch();
    goToQuestion(0);
  } catch (err) {
    isLoadingPaper = false;
    document.getElementById('questionText').innerHTML = `
      <div style="color: #f87171; margin-bottom: 12px;">Network slow while loading questions.</div>
      <button type="button" class="btn" onclick="location.reload()">🔄 Tap to Retry</button>
    `;
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

    if (totalSecondsElapsed % 3 === 0) {
      saveStateToPhone();
    }
  }, 1000);
}

function goToQuestion(index) {
  if (index < 0 || index >= questions.length) return;

  currentIndex = index;
  const q = questions[currentIndex];
  const state = questionStates[currentIndex];
  state.visited = true;

  saveStateToPhone();

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

function handleNextButton() {
  if (currentIndex === questions.length - 1) {
    openConfirmModal();
  } else {
    goToQuestion(currentIndex + 1);
  }
}

window.selectOption = function (letter) {
  if (isLoadingPaper || !questionStates[currentIndex]) return;
  const state = questionStates[currentIndex];
  if (state.selected_option !== letter) {
    if (state.selected_option !== null) {
      state.option_changes += 1;
    }
    state.selected_option = letter;
  }
  saveStateToPhone();
  goToQuestion(currentIndex);
};

function handleClearOrSkip() {
  if (!questionStates[currentIndex]) return;
  const state = questionStates[currentIndex];
  state.selected_option = null;
  state.visited = true;
  saveStateToPhone();

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
  saveStateToPhone();
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

  saveStateToPhone();

  const token =
    sessionStorage.getItem('exam_session_token') ||
    localStorage.getItem('active_exam_session_token');

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
      alert((data.error || 'Failed to submit test.') + ' Your answers are safe on your phone.');
      btn.disabled = false;
      btn.textContent = 'Retry Submit (Answers Safe)';
      return;
    }

    if (mainTimerInterval) clearInterval(mainTimerInterval);
    localStorage.removeItem(storageKey);
    localStorage.removeItem('active_exam_session_token');
    localStorage.removeItem('active_exam_student_name');
    sessionStorage.removeItem('exam_session_token');

    closeConfirmModal();
    window.location.href = `/result.html?id=${encodeURIComponent(data.submission_id)}`;
  } catch (err) {
    alert('Network weak while submitting! All your selected answers are 100% safe on your phone. Tap Retry Submit.');
    btn.disabled = false;
    btn.textContent = 'Retry Submit (Answers Safe)';
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
  
