// Direct function jo button click hote hi chal padegi aur server tak request legi
async function directAdminLogin() {
  const passwordInput = document.getElementById('adminPasswordInput');
  const errEl = document.getElementById('loginErrorMsg');
  errEl.style.display = 'none';
  errEl.textContent = '';

  const password = passwordInput ? passwordInput.value.trim() : '';

  if (!password) {
    errEl.textContent = 'Please enter password!';
    errEl.style.display = 'block';
    return;
  }

  try {
    // Yehi URL batayega ki request server tak gayi ya nahi
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    const data = await res.json();

    if (!data.success || !data.token) {
      errEl.textContent = data.error || 'Incorrect Admin Password';
      errEl.style.display = 'block';
      return;
    }

    // Success! Save token and unlock dashboard
    adminToken = data.token;
    localStorage.setItem('admin_jwt_token', adminToken);
    unlockDashboard();
  } catch (err) {
    errEl.textContent = 'Network/Server connection failed: ' + err.message;
    errEl.style.display = 'block';
  }
}


// Add inside loadChapterBundlebs or as a dedicated render function for chapter deletion:
async function loadChapterManagement() {
  const container = document.getElementById('chapterManagementList');
  try {
    const res = await fetch('/api/admin/bundles', { headers: { Authorization: `Bearer ${adminToken}` } });
    const data = await res.json();
    if (!data.bundles || data.bundles.length === 0) {
      container.innerHTML = `<p style="color:var(--text-muted); font-size:0.88rem;">No chapters found.</p>`;
      return;
    }

    container.innerHTML = data.bundles.map(b => `
      <div style="display:flex; align-items:center; justify-content:space-between; padding:10px; background:rgba(15,23,42,0.6); border:1px solid var(--border-subtle); border-radius:10px; margin-bottom:8px;">
        <div>
          <strong>${escapeHtml(b.chapter)}</strong>
          <span class="badge badge-live" style="margin-left:8px;">${b.question_count} Questions</span>
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
  if (!confirm(`⚠️ WARNING: Are you sure you want to delete all questions belonging to chapter "${chapterName}"? This cannot be undone.`)) {
    return;
  }
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
      alert(data.error || 'Failed to delete chapter.');
    }
  } catch (err) {
    alert('Network error while deleting chapter.');
  }
};
