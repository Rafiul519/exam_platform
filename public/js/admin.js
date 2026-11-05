// ============================================================================
// FILE: public/js/admin.js
// PURPOSE: Admin Dashboard logic with direct mobile-safe login & management
// ============================================================================

let adminToken = localStorage.getItem('admin_jwt_token') || '';

document.addEventListener('DOMContentLoaded', () => {
  // Set default datetime-local picker to current time + 2 minutes
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset() + 2);
  const dtInput = document.getElementById('examDateTimeInput');
  if (dtInput) dtInput.value = now.toISOString().slice(0, 16);

  // Bind Listeners
  const logoutBtn = document.getElementById('logoutAdminBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', handleAdminLogout);

  const fileInput = document.getElementById('jsonFileInput');
  if (fileInput) fileInput.addEventListener('change', handleFileSelect);

  const importBtn = document.getElementById('importJsonBtn');
  if (importBtn) importBtn.addEventListener('click', handleImportQuestions);

  const refreshBundlesBtn = document.getElementById('refreshBundlesBtn');
  if (refreshBundlesBtn) refreshBundlesBtn.addEventListener('click', loadChapterBundles);

  const createExamForm = document.getElementById('createExamForm');
  if (createExamForm) createExamForm.addEventListener('submit', handleCreateLiveExam);

  const stopExamBtn = document.getElementById('stopExamBtn');
  if (stopExamBtn) stopExamBtn.addEventListener('click', handleStopLiveExam);

  const refreshResultsBtn = document.getElementById('refreshResultsBtn');
  if (refreshResultsBtn) refreshResultsBtn.addEventListener('click', loadStudentResults);

  if (adminToken) {
    unlockDashboard();
  }
});

/**
 * DIRECT MOBILE-SAFE ADMIN LOGIN FUNCTION
 */
async function directAdminLogin() {
  const passwordInput = document.getElementById('adminPasswordInput');
  const errEl = document.getElementById('loginErrorMsg');
  if (errEl) {
    errEl.style.display = 'none';
    errEl.textContent = '';
  }

  const password = passwordInput ? passwordInput.value.trim() : '';

  if (!password) {
    if (errEl) {
      errEl.textContent = 'Please enter password!';
      errEl.style.display = 'block';
    }
    return;
  }

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    const data = await res.json();

    if (!data.success || !data.token) {
      if (errEl) {
        errEl.textContent = data.error || 'Incorrect Admin Password';
        errEl.style.display = 'block';
      }
      return;
    }

    adminToken = data.token;
    localStorage.setItem('admin_jwt_token', adminToken);
    unlockDashboard();
  } catch (err) {
    if (errEl) {
      errEl.textContent = 'Network/Server error: ' + err.message;
      errEl.style.display = 'block';
    }
  }
}

/**
 * UNLOCKS THE ADMIN DASHBOARD UPON SUCCESSFUL LOGIN
 */
function unlockDashboard() {
  const loginCard = document.getElementById('adminLoginCard');
  const dashboard = document.getElementById('adminDashboardWrapper');
  const logoutBtn = document.getElementById('logoutAdminBtn');

  if (loginCard) loginCard.style.display = 'none';
  if (dashboard) dashboard.style.display = 'block';
  if (logoutBtn) logoutBtn.style.display = 'inline-flex';

  loadChapterBundles();
  loadChapterManagement();
  loadStudentResults();
}

function handleAdminLogout() {
  adminToken = '';
  localStorage.removeItem('admin_jwt_token');
  location.reload();
}

function handleFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (evt) => {
    const textarea = document.getElementById('jsonTextarea');
    if (textarea) textarea.value = evt.target.result;
  };
  reader.readAsText(file);
}

async function handleImportQuestions() {
  const textarea = document.getElementById('jsonTextarea');
  const rawText = textarea ? textarea.value.trim() : '';
  const statusBox = document.getElementById('importStatusBox');

  if (!rawText) {
    if (statusBox) statusBox.innerHTML = `<span style="color:var(--rose);">Please select a JSON file or paste JSON array first.</span>`;
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    if (statusBox) statusBox.innerHTML = `<span style="color:var(--rose);">Invalid JSON syntax!</span>`;
    return;
  }

  if (statusBox) statusBox.innerHTML = `<span style="color:#38bdf8;">Uploading questions...</span>`;

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
      if (statusBox) statusBox.innerHTML = `<span style="color:var(--rose);">${escapeHtml(data.error)}</span>`;
      return;
    }

    if (statusBox) statusBox.innerHTML = `<span style="color:var(--emerald);">✅ ${escapeHtml(data.message)}</span>`;
    loadChapterBundles();
    loadChapterManagement();
  } catch (err) {
    if (statusBox) statusBox.innerHTML = `<span style="color:var(--rose);">Upload failed.</span>`;
  }
}

async function loadChapterBundles() {
  const container = document.getElementById('chapterBundlesList');
  if (!container) return;
  container.innerHTML = `<span style="font-size:0.85rem; color:var(--text-muted);">Loading bundles...</span>`;

  try {
    const res = await fetch('/api/admin/bundles', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (res.status === 401 || res.status === 403) return handleAdminLogout();
    const data = await res.json();

    if (!data.bundles || data.bundles.length === 0) {
      container.innerHTML = `<span style="font-size:0.85rem; color:var(--amber);">No questions found. Import JSON first!</span>`;
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

async function loadChapterManagement() {
  const container = document.getElementById('chapterManagementList');
  if (!container) return;

  try {
    const res = await fetch('/api/admin/bundles', { headers: { Authorization: `Bearer ${adminToken}` } });
    const data = await res.json();
    if (!data.bundles || data.bundles.length === 0) {
      container.innerHTML = `<p style="color:var(--text-muted); font-size:0.88rem;">No chapters available.</p>`;
      return;
    }

    container.innerHTML = data.bundles.map(b => `
      <div style="display:flex; align-items:center; justify-content:space-files; padding:10px; background:rgba(15,23,42,0.6); border:1px solid var(--border-subtle); border-radius:10px; margin-bottom:8px; justify-content: space-between;">
        <div>
          <strong>${escapeHtml(b.chapter)}</strong>
          <span class="badge badge-live" style="margin-left:8px;">${b.question_count} Qs</span>
        </div>
        <button type="button" class="btn btn-rose" style="padding:6px 12px; font-size:0.8rem;" onclick="deleteEntireChapter('${escapeHtml(b.chapter)}')">
          🗑️ Delete Chapter
        </button>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<p style="color:var(--rose);">Failed to load chapter management.</p>`;
  }
}

window.deleteEntireChapter = async function(chapterName) {
  if (!confirm(`⚠️ Are you sure you want to delete all questions in chapter "${chapterName}"?`)) return;
  try {
    const res = await fetch(`/api/admin/chapters/${encodeURIComponent(chapterName)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (data.success) {
      alert(data.message);
      loadChapterBundles();
      loadChapterManagement();
    } else {
      alert(data.error || 'Failed.');
    }
  } catch (err) {
    alert('Network error.');
  }
};

async function handleCreateLiveExam(e) {
  e.preventDefault();
  const statusEl = document.getElementById('examScheduleStatus');
  const examName = document.getElementById('examNameInput').value.trim();
  const dateVal = document.getElementById('examDateTimeInput').value;

  const checkedBoxes = Array.from(document.querySelectorAll('input[name="chapterBundle"]:checked'));
  const selectedChapters = checkedBoxes.map((cb) => cb.value);

  if (selectedChapters.length === 0) {
    statusEl.innerHTML = `<span style="color:var(--rose);">Select at least one chapter!</span>`;
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
    statusEl.innerHTML = `<span style="color:var(--rose);">Failed to schedule exam.</span>`;
  }
}

async function handleStopLiveExam() {
  if (!confirm('Stop active live exam?')) return;
  const res = await fetch('/api/admin/stop-exam', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const data = await res.json();
  const statusEl = document.getElementById('examScheduleStatus');
  if (statusEl) statusEl.innerHTML = `<span style="color:var(--amber);">${escapeHtml(data.message)}</span>`;
}

async function loadStudentResults() {
  const tbody = document.getElementById('adminResultsTableBody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" style="color:var(--text-muted);">Loading results...</td></tr>`;

  try {
    const res = await fetch('/api/admin/results', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const data = await res.json();

    if (!data.results || data.results.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="color:var(--text-muted);">No submissions yet.</td></tr>`;
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
                <a href="/result.html?id=${encodeURIComponent(r.id)}" class="btn" style="padding:6px 10px; font-size:0.78rem;">View</a>
                <button type="button" class="btn btn-rose" style="padding:6px 10px; font-size:0.78rem;" onclick="deleteStudentResult('${escapeHtml(r.id)}', '${escapeHtml(r.student_name)}')">Delete</button>
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
  if (!confirm(`Delete result for "${studentName}"?`)) return;

  try {
    const res = await fetch(`/api/admin/results/${encodeURIComponent(submissionId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const data = await res.json();
    if (data.success) {
      loadStudentResults();
    } else {
      alert(data.error || 'Could not delete.');
    }
  } catch (err) {
    alert('Network error.');
  }
};

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
  
