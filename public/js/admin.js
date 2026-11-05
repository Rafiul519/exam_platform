// ============================================================================
// FILE: public/js/admin.js
// PURPOSE:
// 1. Authenticates Admin & stores JWT in localStorage.
// 2. Reads uploaded .json file or pasted JSON & sends to /api/admin/import-questions.
// 3. Loads Chapter Bundles from backend and schedules Live Exam with countdown timestamp.
// 4. Lists all student results with one-tap View Result and Delete Result buttons.
// ============================================================================

let adminToken = localStorage.getItem('admin_jwt_token') || '';

document.addEventListener('DOMContentLoaded', () => {
  // Set default datetime-local picker to current time + 2 minutes
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset() + 2);
  document.getElementById('examDateTimeInput').value = now.toISOString().slice(0, 16);

  // Bind Listeners
  document.getElementById('adminLoginForm').addEventListener('submit', handleAdminLogin);
  document.getElementById('logoutAdminBtn').addEventListener('click', handleAdminLogout);
  document.getElementById('jsonFileInput').addEventListener('change', handleFileSelect);
  document.getElementById('importJsonBtn').addEventListener('click', handleImportQuestions);
  document.getElementById('refreshBundlesBtn').addEventListener('click', loadChapterBundles);
  document.getElementById('createExamForm').addEventListener('submit', handleCreateLiveExam);
  document.getElementById('stopExamBtn').addEventListener('click', handleStopLiveExam);
  document.getElementById('refreshResultsBtn').addEventListener('click', loadStudentResults);

  if (adminToken) {
    unlockDashboard();
  }
});

/**
 * 1. Admin Login
 */
async function handleAdminLogin(e) {
  e.preventDefault();
  const password = document.getElementById('adminPasswordInput').value;
  const errEl = document.getElementById('loginErrorMsg');
  errEl.style.display = 'none';

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();

    if (!data.success || !data.token) {
      errEl.textContent = data.error || 'Invalid Admin Password';
      errEl.style.display = 'block';
      return;
    }

    adminToken = data.token;
    localStorage.setItem('admin_jwt_token', adminToken);
    unlockDashboard();
  } catch (err) {
    errEl.textContent = 'Network error. Please try again.';
    errEl.style.display = 'block';
  }
}

function unlockDashboard() {
  document.getElementById('adminLoginCard').style.display = 'none';
  document.getElementById('adminDashboardWrapper').style.display = 'block';
  document.getElementById('logoutAdminBtn').style.display = 'inline-flex';
  loadChapterBundles();
  loadStudentResults();
}

function handleAdminLogout() {
  adminToken = '';
  localStorage.removeItem('admin_jwt_token');
  location.reload();
}

/**
 * 2. Read uploaded .json file into the textarea automatically
 */
function handleFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (evt) => {
    document.getElementById('jsonTextarea').value = evt.target.result;
  };
  reader.readAsText(file);
}

/**
 * 3. Import Questions JSON with Duplicate Restriction
 */
async function handleImportQuestions() {
  const rawText = document.getElementById('jsonTextarea').value.trim();
  const statusBox = document.getElementById('importStatusBox');

  if (!rawText) {
    statusBox.innerHTML = `<span style="color:var(--rose);">Please select a JSON file or paste JSON array first.</span>`;
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    statusBox.innerHTML = `<span style="color:var(--rose);">Invalid JSON syntax! Please check commas and brackets.</span>`;
    return;
  }

  statusBox.innerHTML = `<span style="color:#38bdf8;">Uploading & checking for duplicates...</span>`;

  try {
    const res = await fetch('/api/admin/import-questions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ questions: Array.isArray(parsed) ? parsed : parsed.questions }),
    });

    if (res.status === 401 || res.status === 403) return handleAdminLogout();
    const data = await res.json();

    if (!data.success) {
      statusBox.innerHTML = `<span style="color:var(--rose);">${escapeHtml(data.error)}</span>`;
      return;
    }

    statusBox.innerHTML = `<span style="color:var(--emerald);">✅ ${escapeHtml(data.message)}</span>`;
    loadChapterBundles();
  } catch (err) {
    statusBox.innerHTML = `<span style="color:var(--rose);">Upload failed. Please try again.</span>`;
  }
}

/**
 * 4. Load Auto-Grouped Chapter Question Bundles
 */
async function loadChapterBundles() {
  const container = document.getElementById('chapterBundlesList');
  container.innerHTML = `<span style="font-size:0.85rem; color:var(--text-muted);">Loading chapter bundles...</span>`;

  try {
    const res = await fetch('/api/admin/bundles', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (res.status === 401 || res.status === 403) return handleAdminLogout();
    const data = await res.json();

    if (!data.bundles || data.bundles.length === 0) {
      container.innerHTML = `<span style="font-size:0.85rem; color:var(--amber);">No questions in database yet. Import a JSON file first!</span>`;
      return;
    }

    container.innerHTML = data.bundles
      .map(
        (b) => `
        <label style="display:flex; align-items:center; justify-content:space-between; padding:8px 6px; border-bottom:1px solid var(--border-subtle); cursor:pointer; font-size:0.9rem;">
          <span style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" name="chapterBundle" value="${escapeHtml(b.chapter)}" checked style="width:18px; height:18px;" />
            <strong>${escapeHtml(b.chapter)}</strong>
          </span>
          <span class="badge badge-live">${b.question_count} Qs</span>
        </label>`
      )
      .join('');
  } catch (err) {
    container.innerHTML = `<span style="color:var(--rose);">Failed to load bundles.</span>`;
  }
}

/**
 * 5. Schedule & Launch Live Exam
 */
async function handleCreateLiveExam(e) {
  e.preventDefault();
  const statusEl = document.getElementById('examScheduleStatus');
  const examName = document.getElementById('examNameInput').value.trim();
  const dateVal = document.getElementById('examDateTimeInput').value;

  const checkedBoxes = Array.from(document.querySelectorAll('input[name="chapterBundle"]:checked'));
  const selectedChapters = checkedBoxes.map((cb) => cb.value);

  if (selectedChapters.length === 0) {
    statusEl.innerHTML = `<span style="color:var(--rose);">Please select at least one Chapter Bundle!</span>`;
    return;
  }

  const scheduledAtSec = Math.floor(new Date(dateVal).getTime() / 1000);

  try {
    const res = await fetch('/api/admin/create-exam', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        exam_name: examName,
        scheduled_at: scheduledAtSec,
        chapters: selectedChapters,
      }),
    });

    const data = await res.json();
    if (!data.success) {
      statusEl.innerHTML = `<span style="color:var(--rose);">${escapeHtml(data.error)}</span>`;
      return;
    }

    statusEl.innerHTML = `<span style="color:var(--emerald);">✅ ${escapeHtml(data.message)}</span>`;
  } catch (err) {
    statusEl.innerHTML = `<span style="color:var(--rose);">Failed to schedule live exam.</span>`;
  }
}

async function handleStopLiveExam() {
  if (!confirm('Stop the currently active live exam on the Home page?')) return;
  const res = await fetch('/api/admin/stop-exam', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const data = await res.json();
  document.getElementById('examScheduleStatus').innerHTML =
    `<span style="color:var(--amber);">${escapeHtml(data.message)}</span>`;
}

/**
 * 6. Load All Student Results & Individual Delete Option
 */
async function loadStudentResults() {
  const tbody = document.getElementById('adminResultsTableBody');
  tbody.innerHTML = `<tr><td colspan="7" style="color:var(--text-muted);">Loading student results...</td></tr>`;

  try {
    const res = await fetch('/api/admin/results', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const data = await res.json();

    if (!data.results || data.results.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="color:var(--text-muted);">No student submissions yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.results
      .map((r) => {
        const mins = Math.floor(r.total_time_sec / 60);
        const secs = r.total_time_sec % 60;
        const riskBadge =
          r.cheating_risk_score >= 40
            ? `<span class="badge" style="background:rgba(239,68,68,0.2); color:#f87171;">⚠️ High (${r.cheating_risk_score})</span>`
            : `<span class="badge badge-live">Clean (${r.cheating_risk_score})</span>`;

        return `
          <tr>
            <td><strong>${escapeHtml(r.student_name)}</strong></td>
            <td>${escapeHtml(r.exam_name || 'Live Exam')}</td>
            <td><strong style="color:#38bdf8;">${r.score_percentage}%</strong></td>
            <td>
              <span style="color:var(--emerald);">${r.total_right}✓</span> /
              <span style="color:var(--rose);">${r.total_wrong}✗</span> /
              <span style="color:var(--amber);">${r.total_skipped}⏭</span>
            </td>
            <td>${mins}m ${secs}s</td>
            <td>${riskBadge}</td>
            <td>
              <div style="display:flex; gap:6px;">
                <a href="/result.html?id=${encodeURIComponent(r.id)}" class="btn" style="padding:6px 10px; font-size:0.78rem;">
                  View
                </a>
                <button
                  type="button"
                  class="btn btn-rose"
                  style="padding:6px 10px; font-size:0.78rem;"
                  onclick="deleteStudentResult('${escapeHtml(r.id)}', '${escapeHtml(r.student_name)}')"
                >
                  Delete
                </button>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--rose);">Failed to load results.</td></tr>`;
  }
}

window.deleteStudentResult = async function (submissionId, studentName) {
  if (!confirm(`Are you sure you want to permanently delete the result for "${studentName}"?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/admin/results/${encodeURIComponent(submissionId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const data = await res.json();
    if (data.success) {
      loadStudentResults();
    } else {
      alert(data.error || 'Could not delete result.');
    }
  } catch (err) {
    alert('Network error while deleting result.');
  }
};

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  }
