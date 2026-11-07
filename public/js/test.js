// ============================================================================
// FILE: public/js/test.js
// PURPOSE: 50-50-50 Chunk Loader, Mobile LocalStorage Offline Backup & Safe Submit
// ============================================================================

let questions = [];
let currentIndex = 0;
let questionStates = [];
let totalSecondsElapsed = 0;
let mainTimerInterval = null;
let examTitle = 'Live Test';
let storageKey = 'exam_offline_backup_default';
let isLoadingPaper = false;

document.addEventListener('DOMContentLoaded', () => {
  // Read token from sessionStorage or fallback to localStorage if mobile browser killed tab
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

  // Keep active token backed up in localStorage until exam is successfully submitted
  sessionStorage.setItem('exam_session_token', token);
  sessionStorage.setItem('exam_student_name', studentName);
  localStorage.setItem('active_exam_session_token', token);
  localStorage.setItem('active_exam_student_name', studentName);

  // Create a unique storage key for this specific student exam session
  storageKey = getSessionStorageKey(token);

  const badgeEl = document.getElementById('studentNameBadge');
  if (badgeEl) badgeEl.textContent = studentName;

  // Track tab switches & immediately save state to mobile storage
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && questionStates[currentIndex]) {
      questionStates[currentIndex].tab_switches += 1;
      saveExamStateToLocal();
    }
  });

  // Bind navigation & modal buttons
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

  // Initialize exam paper (from LocalStorage if reloaded, otherwise 50-50-50 chunk download)
  initExamPaper(token);
});

/**
 * Extracts unique sessionId from JWT so each exam attempt has its own clean storage key
 */
function getSessionStorageKey(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length >= 2) {
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(base64));
      if (payload && payload.sessionId) {
        return 'exam_backup_' + payload.sessionId;
      }
    }
  } catch (e) {
    // Fallback to token suffix
  }
  return 'exam_backup_' + String(token).slice(-24);
}

/**
 * Saves full questions, selected options, current question index, and timers to mobile localStorage
 */
function saveExamStateToLocal() {
  if (!questions || questions.length === 0) return;
  try {
    const payload = {
      examTitle: examTitle,
      questions: questions,
      questionStates: questionStates,
      currentIndex: currentIndex,
      totalSecondsElapsed: totalSecondsElapsed,
      savedAt: Date.now()
    };
    localStorage.setItem(storageKey, JSON.stringify(payload));
  } catch (err) {
    // Ignore storage quota warnings
  }
}

/**
 * Loads cached exam paper & student answers from mobile localStorage if available
 */
function loadExamStateFromLocal() {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (
      data &&
      Array.isArray(data.questions) &&
      data.questions.length > 0 &&
      Array.isArray(data.questionStates) &&
      data.questionStates.length === data.questions.length
    ) {
      examTitle = data.examTitle || 'Live Test';
      questions = data.questions;
      questionStates = data.questionStates;
      currentIndex =
        typeof data.currentIndex === 'number' &&
        data.currentIndex >= 0 &&
        data.currentIndex < questions.length
          ? data.currentIndex
          : 0;
      totalSecondsElapsed = Number(data.totalSecondsElapsed) || 0;
      return true;
    }
  } catch (err) {
    return false;
  }
  return false;
}

/**
 * Removes old exam caches from localStorage to keep phone memory clean
 */
function cleanupOldExamBackups(keepKey) {
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf('exam_backup_') === 0 && k !== keepKey) {
        keysToRemove.push(k);
      }
    }
    for (let i = 0; i < keysToRemove.length; i++) {
      localStorage.removeItem(keysToRemove[i]);
    }
  } catch (e) {}
}

/**
 * Helper: Fetch with automatic retries so temporary mobile network drops never fail
 */
async function fetchWithRetry(url, options, maxRetries) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      const data = await res.json();
      return { res: res, data: data };
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
      }
    }
  }
  throw lastError || new Error('Network connection failed');
}

/**
 * Step 1: Restore instantly from phone storage on reload, OR download in 50-50-50 chunks
 */
async function initExamPaper(token) {
  // 1. Check if paper + answers are already saved in mobile localStorage
  if (loadExamStateFromLocal()) {
    document.getElementById('topExamName').textContent = examTitle;
    startUpwardStopwatch();
    goToQuestion(currentIndex);
    return;
  }

  // 2. Otherwise download in safe 50-50-50 chunks from server
  isLoadingPaper = true;
  setNavigationDisabled(true);
  cleanupOldExamBackups(storageKey);

  const qTextEl = document.getElementById('questionText');
  const qNumEl = document.getElementById('qNumberDisplay');

  const CHUNK_SIZE = 50;
  let offset = 0;
  let hasMore = true;
  let totalExpected = 0;
  const allLoadedQuestions = [];
  const seenQuestionIds = new Set();

  try {
    while (hasMore) {
      if (qNumEl) {
        qNumEl.textContent =
          totalExpected > 0
            ? 'Loading (' + allLoadedQuestions.length + ' / ' + totalExpected + ')'
            : 'Preparing Exam...';
      }
      if (qTextEl) {
        qTextEl.textContent =
          totalExpected > 0
            ? 'Downloading exam paper in safe chunks... (' +
              allLoadedQuestions.length +
              ' / ' +
              totalExpected +
              ' questions saved to phone)'
            : 'Connecting to exam server & downloading first 50 questions...';
      }

      const url = '/api/exam/questions?offset=' + offset + '&limit=' + CHUNK_SIZE;
      const result = await fetchWithRetry(
        url,
        { headers: { Authorization: 'Bearer ' + token } },
        4
      );
      const data = result.data;

      if (!data || !data.success || !Array.isArray(data.questions)) {
        throw new Error((data && data.error) || 'Failed to load question chunk.');
      }

      if (data.exam_name) {
        examTitle = data.exam_name;
        document.getElementById('topExamName').textContent = examTitle;
      }

      if (typeof data.total_questions === 'number' && data.total_questions > 0) {
        totalExpected = data.total_questions;
      }

      // Add chunk questions with strict client-side duplicate ID filter
      for (let i = 0; i < data.questions.length; i++) {
        const q = data.questions[i];
        const qId = String(q.id);
        if (!seenQuestionIds.has(qId)) {
          seenQuestionIds.add(qId);
          allLoadedQuestions.push(q);
        }
      }

      // Check if server ran in legacy mode (returned all questions at once) or chunked mode
      if (data.has_more === undefined) {
        hasMore = false;
      } else {
        hasMore = Boolean(data.has_more) && data.questions.length > 0;
        offset += data.questions.length;
      }

      // Safety break if all expected questions are already downloaded
      if (totalExpected > 0 && allLoadedQuestions.length >=
