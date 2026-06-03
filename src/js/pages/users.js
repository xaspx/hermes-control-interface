import { state, t } from '../core/state.js';;
import { customAlert, customConfirm } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { api } from '../core/api.js';
import { hasPerm } from '../core/permissions.js';
import { escapeHtml } from '../core/utils.js';

async function loadUsersPage(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title" data-i18n="auto.userManagement">User Management</div>
        <div class="page-subtitle" data-i18n="auto.manageUsersRolesAndPermissions">Manage users, roles, and permissions</div>
      </div>
    </div>
    <div class="card-grid">
      <div class="card">
        <div class="card-title" data-i18n="auto.users">Users</div>
        <div id="users-page-list"><div class="loading" data-i18n="auto.loadingUsers">Loading users...</div></div>
        <div class="card-actions" style="margin-top:8px;">
          <button class="btn btn-ghost" onclick="showCreateUser()" data-i18n="auto.createUser2">+ Create User</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title" data-i18n="auto.auditLog">Audit Log</div>
        <div id="audit-log-page"><div class="loading" data-i18n="auto.loadingAudit">Loading audit...</div></div>
      </div>
    </div>
  `;

  // Load users for the page
  try {
    const res = await api('/api/users');
    const el = document.getElementById('users-page-list');
    if (res.ok && res.users) {
      el.innerHTML = res.users.map(u => {
        const canManage = hasPerm('users.manage');
        const permCount = u.permissions ? Object.values(u.permissions).filter(Boolean).length : 0;
        const roleBadge = u.role === 'admin' ? '🟢' : u.role === 'viewer' ? '🔵' : '🟡';
        return `<div class="stat-row">
          <span class="stat-label">${roleBadge} ${u.username} <span class="badge">${u.role}</span> <span style="color:var(--fg-subtle);font-size:10px;">${permCount} perms</span></span>
          <span class="stat-value" style="display:flex;gap:4px;align-items:center;">
            ${u.last_login ? new Date(u.last_login).toLocaleDateString() : 'never'}
            ${canManage ? `<button class="btn btn-ghost btn-sm" onclick="showEditUser('${u.username}')" title="Edit permissions">⚙</button>
            ${res.users.length > 1 ? `<button class="btn btn-ghost btn-sm btn-danger" onclick="deleteUser('${u.username}')">✕</button>` : ''}` : ''}
          </span>
        </div>`;
      }).join('');
    } else {
      el.innerHTML = '<div class="stat-row"><span class="stat-label" data-i18n="auto.noUsers">No users</span></div>';
    }
  } catch (e) {
    document.getElementById('users-page-list').innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
  }

  // Load audit log for the page
  loadAuditLogPage();
}

async function loadAuditLogPage() {
  try {
    const res = await fetch('/api/audit');
    const data = await res.json();
    const el = document.getElementById('audit-log-page');
    if (data.ok && data.entries) {
      const limit = state.auditDisplayLimit;
      const all = data.entries.slice(0, limit);
      let html = all.map(e => {
        const m = e.match(/\[(.+?)\]\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)/);
        if (m) {
          const [, ts, user, role, action, detail] = m;
          const actionColors = {
            'LOGIN': '#34d399', 'LOGOUT': '#fbbf24', 'USER_CREATE': '#4ecdc4',
            'USER_DELETE': '#ff6b6b', 'USER_UPDATE': '#a78bfa', 'PASSWORD_RESET': '#ff6b6b',
            'PASSWORD_CHANGE': '#fbbf24', 'CONFIG_UPDATE': '#a78bfa', 'KEY_REVEAL': '#ff6b6b',
            'BACKUP_CREATE': '#34d399', 'BACKUP_IMPORT': '#4ecdc4', 'UPDATE': '#4ecdc4',
            'RESTART': '#fbbf24', 'DOCTOR': '#a78bfa',
          };
          const color = actionColors[action] || '#4ecdc4';
          return `<div style="font-size:11px;padding:4px 0;border-bottom:1px solid var(--border);font-family:var(--font);">
            <span style="color:var(--fg-subtle);">[${new Date(ts).toLocaleString()}]</span>
            <span style="color:var(--gold,#ffac02);font-weight:600;">${escapeHtml(user)}</span>
            <span style="color:var(--fg-subtle);font-size:10px;">${escapeHtml(role)}</span>
            <span style="color:${color};font-weight:600;">${escapeHtml(action)}</span>
            <span style="color:var(--fg-muted);">${escapeHtml(detail)}</span>
          </div>`;
        }
        return `<div style="font-size:11px;padding:4px 0;border-bottom:1px solid var(--border);color:var(--fg-muted);font-family:var(--font);">${escapeHtml(e)}</div>`;
      }).join('');
      // Load more button
      if (data.entries.length > limit) {
        const remaining = data.entries.length - limit;
        html += `<div style="padding:8px;text-align:center;"><button class="btn btn-ghost btn-sm" onclick="loadMoreAudit()" style="font-size:11px;">Load more (${remaining} remaining)</button></div>`;
      }
      el.innerHTML = html;
    } else {
      el.innerHTML = '<div class="stat-row"><span class="stat-label" data-i18n="auto.noAuditEntries">No audit entries</span></div>';
    }
  } catch (e) {
    document.getElementById('audit-log-page').innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
  }
}

async function loadUsers() {
  try {
    const res = await api('/api/users');
    const el = document.getElementById('users-list');
    if (!el) return; // Users page might be active, no maintenance panel
    if (res.ok && res.users) {
      el.innerHTML = res.users.map(u => {
        const canManage = hasPerm('users.manage');
        const permCount = u.permissions ? Object.values(u.permissions).filter(Boolean).length : 0;
        return `<div class="stat-row">
          <span class="stat-label">${u.username} <span class="badge">${u.role}</span> <span style="color:var(--fg-subtle);font-size:10px;">${permCount} perms</span></span>
          <span class="stat-value" style="display:flex;gap:4px;align-items:center;">
            ${u.last_login ? new Date(u.last_login).toLocaleDateString() : 'never'}
            ${canManage ? `<button class="btn btn-ghost btn-sm" onclick="showEditUser('${u.username}')" title="Edit permissions">⚙</button>
            ${res.users.length > 1 ? `<button class="btn btn-ghost btn-sm btn-danger" onclick="deleteUser('${u.username}')">×</button>` : ''}` : ''}
          </span>
        </div>`;
      }).join('');
    } else {
      el.innerHTML = '<div class="stat-row"><span class="stat-label" data-i18n="auto.noUsers">No users</span></div>';
    }
  } catch (e) {
    const el = document.getElementById('users-list');
    if (el) el.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
  }
}

function refreshUsersEverywhere() {
  loadUsers();
  if (state.page === 'users') loadUsersPage(document.getElementById('page-users'));
}

async function deleteUser(username) {
  if (!await customConfirm(`Delete user "${username}"?`, 'Delete User')) return;
  try {
    const csrfToken = state.csrfToken || '';
    const res = await api(`/api/users/${encodeURIComponent(username)}`, {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': csrfToken },
    });
    if (res.ok) {
      showToast(`User ${username} deleted`, 'success');
      refreshUsersEverywhere();
    } else {
      await customAlert(res.error || 'Failed', 'Error');
    }
  } catch (e) {
    await customAlert(e.message, 'Error');
  }
}

async function showCreateUser() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  // Permission groups (same as edit user)
  const permGroups = [
    { label: 'Sessions', perms: ['sessions.view', 'sessions.messages', 'sessions.delete'] },
    { label: 'Chat', perms: ['chat.use', 'chat.manage'] },
    { label: 'Logs & Usage', perms: ['logs.view', 'usage.view', 'usage.export'] },
    { label: 'Gateway', perms: ['gateway.view', 'gateway.control'] },
    { label: 'Config', perms: ['config.view', 'config.edit'] },
    { label: 'Secrets', perms: ['secrets.view', 'secrets.reveal', 'secrets.edit'] },
    { label: 'Skills', perms: ['skills.browse', 'skills.install'] },
    { label: 'Cron', perms: ['cron.view', 'cron.manage'] },
    { label: 'Files', perms: ['files.read', 'files.write'] },
    { label: 'Terminal', perms: ['terminal'] },
    { label: 'Users', perms: ['users.view', 'users.manage'] },
    { label: 'System', perms: ['system.update', 'system.backup', 'system.doctor', 'system.restart'] },
  ];

  overlay.innerHTML = `
    <div class="modal-card" style="max-width:600px;max-height:85vh;overflow-y:auto;">
      <div class="modal-title" data-i18n="auto.createUser">Create User</div>
      <form id="create-user-form">
        <div style="margin-bottom:10px;">
          <label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;" data-i18n="auto.username">Username</label>
          <input class="modal-input" name="username" placeholder="e.g. alice" autocomplete="off" required />
        </div>
        <div style="margin-bottom:10px;">
          <label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;" data-i18n="auto.password">Password</label>
          <div style="position:relative;">
            <input class="modal-input" name="password" type="password" placeholder="Min 8 characters" autocomplete="new-password" required style="padding-right:36px;" />
            <button type="button" onclick="togglePwVis(this)" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--fg-muted);cursor:pointer;font-size:14px;">👁</button>
          </div>
        </div>
        <div style="margin-bottom:10px;">
          <label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;" data-i18n="auto.confirmPassword">Confirm Password</label>
          <div style="position:relative;">
            <input class="modal-input" name="confirm" type="password" placeholder="Re-enter password" autocomplete="new-password" required style="padding-right:36px;" />
            <button type="button" onclick="togglePwVis(this)" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--fg-muted);cursor:pointer;font-size:14px;">👁</button>
          </div>
          <div id="pw-match-msg" style="font-size:11px;margin-top:4px;min-height:16px;"></div>
        </div>
        <div style="font-size:10px;color:var(--fg-subtle);margin-bottom:10px;padding:6px 8px;background:var(--bg-input);border-radius:var(--radius);" data-i18n="auto.passwordRulesMin8CharsNoSpaces">Password rules: min 8 chars, no spaces</div>
        <div style="margin-bottom:10px;">
          <label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:6px;" data-i18n="auto.role">Role</label>
          <div style="display:flex;gap:6px;margin-bottom:10px;">
            <button type="button" class="btn btn-ghost btn-sm" onclick="applyCreatePreset('admin', this)" data-i18n="auto.admin">Admin</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="applyCreatePreset('viewer', this)" data-i18n="auto.viewer">Viewer</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="applyCreatePreset('custom', this)" data-i18n="auto.custom">Custom</button>
          </div>
          <input type="hidden" name="role" value="viewer" />
          <div id="perm-custom-list" style="display:none;">
            <div style="font-size:11px;color:var(--fg-muted);margin-bottom:6px;" data-i18n="auto.permissions">Permissions:</div>
            <div style="max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius);padding:8px;background:var(--bg-input);">
              ${permGroups.map(g => `
                <div style="margin-bottom:8px;">
                  <div style="font-size:10px;font-weight:600;color:var(--gold,#ffac02);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">${g.label}</div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px;font-size:11px;">
                    ${g.perms.map(p => `
                      <label style="display:flex;align-items:center;gap:4px;cursor:pointer;padding:2px 4px;border-radius:3px;" onmouseover="this.style.background='var(--bg-panel-hover)'" onmouseout="this.style.background='transparent'">
                        <input type="checkbox" name="perm" value="${p}" /> ${p}
                      </label>
                    `).join('')}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()" data-i18n="auto.cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" data-i18n="auto.createUser">Create User</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  // Apply preset for create user modal
  const form = overlay.querySelector('#create-user-form');
  window.applyCreatePreset = function(role, btn) {
    form.querySelector('[name=role]').value = role;
    const customList = document.getElementById('perm-custom-list');
    const checkboxes = customList.querySelectorAll('input[name="perm"]');
    if (role === 'admin') {
      checkboxes.forEach(cb => cb.checked = true);
      customList.style.display = 'none';
    } else if (role === 'viewer') {
      const viewerPerms = ['sessions.view','sessions.messages','chat.use','logs.view','usage.view','skills.browse','files.read'];
      checkboxes.forEach(cb => cb.checked = viewerPerms.includes(cb.value));
      customList.style.display = 'none';
    } else {
      customList.style.display = 'block';
    }
    // Highlight active button
    form.querySelectorAll('[onclick^="applyCreatePreset"]').forEach(b => b.classList.remove('btn-primary'));
    btn.classList.add('btn-primary');
  };

  // Set default viewer preset as active
  const viewerBtn = overlay.querySelector('[onclick="applyCreatePreset(\'viewer\', this)"]');
  if (viewerBtn) viewerBtn.classList.add('btn-primary');

  // Password match check
  const pwInput = form.querySelector('[name=password]');
  const confInput = form.querySelector('[name=confirm]');
  const msgEl = overlay.querySelector('#pw-match-msg');
  const checkMatch = () => {
    if (!confInput.value) { msgEl.textContent = ''; return; }
    msgEl.textContent = pwInput.value === confInput.value ? '✓ Passwords match' : '✗ Passwords do not match';
    msgEl.style.color = pwInput.value === confInput.value ? 'var(--green)' : 'var(--red)';
  };
  pwInput.addEventListener('input', checkMatch);
  confInput.addEventListener('input', checkMatch);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const username = (fd.get('username') || '').trim();
    const password = fd.get('password') || '';
    const confirm = fd.get('confirm') || '';
    const role = fd.get('role') || 'viewer';
    if (!username) return showToast(t('toast.usernameRequired'), 'error');
    if (password.length < 8) return showToast(t('toast.passwordTooShort'), 'error');
    if (password !== confirm) return showToast(t('toast.passwordsDontMatch'), 'error');
    if (/\s/.test(password)) return showToast(t('toast.passwordNoSpaces'), 'error');
    // Collect custom permissions if role is custom
    let perms = {};
    if (role === 'custom') {
      const checked = overlay.querySelectorAll('input[name="perm"]:checked');
      checked.forEach(cb => { perms[cb.value] = true; });
    }
    createUser(username, password, role, perms);
    overlay.remove();
  });
}

async function createUser(username, password, role, permissions) {
  try {
    const csrfToken = state.csrfToken || '';
    const body = { username, password, role };
    if (role === 'custom' && permissions) body.permissions = permissions;
    const res = await api('/api/users', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      showToast(`User ${username} created`, 'success');
      refreshUsersEverywhere();
    } else {
      showToast(`Failed: ${res.error}`, 'error');
    }
  } catch (e) {
    showToast(`Failed: ${e.message}`, 'error');
  }
}

async function showEditUser(username) {
  const usersRes = await api('/api/users');
  const user = usersRes.users?.find(u => u.username === username);
  if (!user) return showToast(t('toast.userNotFound'), 'error');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  // Permission groups from PERMISSIONS.md v2
  const permGroups = [
    { label: 'Sessions', perms: ['sessions.view', 'sessions.messages', 'sessions.delete'] },
    { label: 'Chat', perms: ['chat.use', 'chat.manage'] },
    { label: 'Logs & Usage', perms: ['logs.view', 'usage.view', 'usage.export'] },
    { label: 'Gateway', perms: ['gateway.view', 'gateway.control'] },
    { label: 'Config', perms: ['config.view', 'config.edit'] },
    { label: 'Secrets', perms: ['secrets.view', 'secrets.reveal', 'secrets.edit'] },
    { label: 'Skills', perms: ['skills.browse', 'skills.install'] },
    { label: 'Cron', perms: ['cron.view', 'cron.manage'] },
    { label: 'Files', perms: ['files.read', 'files.write'] },
    { label: 'Terminal', perms: ['terminal'] },
    { label: 'Users', perms: ['users.view', 'users.manage'] },
    { label: 'System', perms: ['system.update', 'system.backup', 'system.doctor', 'system.restart'] },
  ];

  const userPerms = user.permissions || {};
  const isCustom = user.role === 'custom';

  overlay.innerHTML = `
    <div class="modal-card" style="max-width:600px;max-height:85vh;overflow-y:auto;">
      <div class="modal-title">Edit User: ${escapeHtml(username)}</div>
      <div style="font-size:11px;color:var(--fg-muted);margin-bottom:12px;">
        Created: ${user.created_at ? new Date(user.created_at).toLocaleString() : '—'} ·
        Last login: ${user.last_login ? new Date(user.last_login).toLocaleString() : 'never'}
      </div>
      <form id="edit-user-form">
        <div style="margin-bottom:12px;">
          <label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:6px;" data-i18n="auto.role">Role</label>
          <div style="display:flex;gap:6px;margin-bottom:8px;">
            <button type="button" class="btn btn-ghost btn-sm" onclick="applyPreset('admin', this)" data-i18n="auto.admin">Admin</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="applyPreset('viewer', this)" data-i18n="auto.viewer">Viewer</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="applyPreset('custom', this)" data-i18n="auto.custom">Custom</button>
          </div>
          <input type="hidden" name="role" id="edit-user-role" value="${user.role}" />
          <div id="edit-perm-custom-list" style="${isCustom ? '' : 'display:none;'}">
            <div style="font-size:11px;color:var(--fg-muted);margin-bottom:6px;" data-i18n="auto.permissions">Permissions:</div>
            <div style="max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius);padding:8px;background:var(--bg-input);">
              ${permGroups.map(g => `
                <div style="margin-bottom:8px;">
                  <div style="font-size:10px;font-weight:600;color:var(--gold,#ffac02);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">${g.label}</div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px;font-size:11px;">
                    ${g.perms.map(p => `
                      <label style="display:flex;align-items:center;gap:4px;cursor:pointer;padding:2px 4px;border-radius:3px;" onmouseover="this.style.background='var(--bg-panel-hover)'" onmouseout="this.style.background='transparent'">
                        <input type="checkbox" name="perm" value="${p}" ${userPerms[p] ? 'checked' : ''} /> ${p}
                      </label>
                    `).join('')}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
        <div style="margin-bottom:12px;">
          <button type="button" class="btn btn-ghost btn-sm" onclick="showResetPassword('${escapeHtml(username)}')" style="color:var(--coral,#ff6b6b);" data-i18n="auto.resetPassword">🔑 Reset Password</button>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()" data-i18n="auto.cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" data-i18n="auto.saveChanges">Save Changes</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  // Apply preset helper — updates checkboxes based on preset
  window.applyPreset = function(role, btn) {
    document.getElementById('edit-user-role').value = role;
    const customList = document.getElementById('edit-perm-custom-list');
    const checkboxes = customList.querySelectorAll('input[name="perm"]');
    if (role === 'admin') {
      checkboxes.forEach(cb => cb.checked = true);
      customList.style.display = 'none';
    } else if (role === 'viewer') {
      const viewerPerms = ['sessions.view','sessions.messages','chat.use','logs.view','usage.view','skills.browse','files.read'];
      checkboxes.forEach(cb => cb.checked = viewerPerms.includes(cb.value));
      customList.style.display = 'none';
    } else {
      customList.style.display = 'block';
    }
    // Highlight active button
    customList.parentElement.querySelectorAll('[onclick^="applyPreset"]').forEach(b => b.classList.remove('btn-primary'));
    btn.classList.add('btn-primary');
  };

  // Init: highlight the current role button
  const currentRoleBtn = overlay.querySelector(`[onclick="applyPreset('${user.role}', this)"]`);
  if (currentRoleBtn) currentRoleBtn.classList.add('btn-primary');

  document.getElementById('edit-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const role = document.getElementById('edit-user-role').value;
    let permissions = null;
    if (role === 'custom') {
      const checked = overlay.querySelectorAll('input[name="perm"]:checked');
      permissions = {};
      checked.forEach(cb => { permissions[cb.value] = true; });
    }
    try {
      const csrfToken = state.csrfToken || '';
      const res = await api(`/api/users/${encodeURIComponent(username)}`, {
        method: 'PUT',
        headers: { 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ role, permissions }),
      });
      if (res.ok) {
        showToast(`User ${username} updated`, 'success');
        overlay.remove();
        refreshUsersEverywhere();
      } else {
        showToast(`Failed: ${res.error}`, 'error');
      }
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
  });
}

async function showResetPassword(username) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="modal-card" style="max-width:400px;">
      <div class="modal-title">Reset Password: ${escapeHtml(username)}</div>
      <form id="reset-pw-form">
        <div style="margin-bottom:10px;">
          <label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;" data-i18n="auto.newPassword">New Password</label>
          <div style="position:relative;">
            <input class="modal-input" name="password" type="password" placeholder="Min 8 characters" autocomplete="new-password" required style="padding-right:36px;" />
            <button type="button" onclick="togglePwVis(this)" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--fg-muted);cursor:pointer;font-size:14px;">👁</button>
          </div>
        </div>
        <div style="margin-bottom:10px;">
          <label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;" data-i18n="auto.confirmPassword">Confirm Password</label>
          <div style="position:relative;">
            <input class="modal-input" name="confirm" type="password" placeholder="Re-enter password" autocomplete="new-password" required style="padding-right:36px;" />
            <button type="button" onclick="togglePwVis(this)" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--fg-muted);cursor:pointer;font-size:14px;">👁</button>
          </div>
          <div id="reset-pw-match-msg" style="font-size:11px;margin-top:4px;min-height:16px;"></div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()" data-i18n="auto.cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" style="color:var(--coral,#ff6b6b);" data-i18n="auto.resetPassword2">Reset Password</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  // Password match check
  const form = overlay.querySelector('#reset-pw-form');
  const pwInput = form.querySelector('[name=password]');
  const confInput = form.querySelector('[name=confirm]');
  const msgEl = overlay.querySelector('#reset-pw-match-msg');
  const checkMatch = () => {
    if (!confInput.value) { msgEl.textContent = ''; return; }
    msgEl.textContent = pwInput.value === confInput.value ? '✓ Passwords match' : '✗ Passwords do not match';
    msgEl.style.color = pwInput.value === confInput.value ? 'var(--green)' : 'var(--red)';
  };
  pwInput.addEventListener('input', checkMatch);
  confInput.addEventListener('input', checkMatch);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newPw = pwInput.value;
    const confirmPw = confInput.value;
    if (newPw.length < 8) return showToast(t('toast.passwordTooShort'), 'error');
    if (newPw !== confirmPw) return showToast(t('toast.passwordsDontMatch'), 'error');
    try {
      const csrfToken = state.csrfToken || '';
      const res = await api(`/api/users/${encodeURIComponent(username)}/reset-password`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_password: newPw }),
      });
      if (res.ok) {
        showToast(`Password reset for ${username}`, 'success');
        overlay.remove();
      } else {
        showToast(`Failed: ${res.error}`, 'error');
      }
    } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
  });
}

export { loadUsersPage, loadAuditLogPage, loadUsers, refreshUsersEverywhere, deleteUser, showCreateUser, createUser, showEditUser, showResetPassword };
