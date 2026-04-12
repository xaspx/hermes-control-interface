/* ============================================
   HCI Main Entry Point
   ============================================ */

// State
const state = {
  user: null,
  page: 'home',
  theme: localStorage.getItem('hci-theme') || 'dark',
  notifications: [],
  notifInterval: null,
};

// ============================================
// Theme
// ============================================
function initTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  updateThemeIcon();
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', state.theme);
  localStorage.setItem('hci-theme', state.theme);
  updateThemeIcon();
}

function updateThemeIcon() {
  const icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = state.theme === 'dark' ? '🌙' : '☀️';
}

// ============================================
// Auth
// ============================================
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      state.user = data.user;
      state.csrfToken = data.csrfToken;
      showApp();
      return true;
    }
  } catch {}

  // Check if first run (no rate limit)
  try {
    const statusRes = await fetch('/api/auth/status');
    const statusData = await statusRes.json();
    if (statusData.first_run) {
      showSetup();
      return false;
    }
  } catch {}

  showLogin();
  return false;
}

function showLogin() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('login-form').style.display = 'flex';
  document.getElementById('setup-form').style.display = 'none';
  document.getElementById('app').style.display = 'none';
}

function showSetup() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('setup-form').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-sub').textContent = 'First run — create admin account';
}

function showApp() {
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('app').style.display = 'block';
  updateUserMenu();
  navigate(state.page);
  startNotifPolling();
}

function updateUserMenu() {
  if (!state.user) return;
  document.getElementById('user-name').textContent = state.user.username;
  document.getElementById('user-role').textContent = state.user.role;
}

// Login form
document.getElementById('login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      credentials: 'include',
    });
    const data = await res.json();
    if (data.ok) {
      state.user = data.user;
      state.csrfToken = data.csrfToken || '';
      errorEl.textContent = '';
      showApp();
    } else if (data.error === 'first_run') {
      // No users exist — show setup form
      showSetup();
    } else {
      errorEl.textContent = data.error || 'Login failed';
    }
  } catch (err) {
    errorEl.textContent = 'Connection error';
  }
});

// Setup form (first run)
document.getElementById('setup-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('setup-username').value;
  const password = document.getElementById('setup-password').value;
  const confirm = document.getElementById('setup-password-confirm').value;
  const errorEl = document.getElementById('login-error');

  if (password !== confirm) {
    errorEl.textContent = 'Passwords do not match';
    return;
  }
  if (password.length < 8) {
    errorEl.textContent = 'Password must be at least 8 characters';
    return;
  }

  try {
    const res = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      credentials: 'include',
    });
    const data = await res.json();
    if (data.ok) {
      state.user = data.user;
      state.csrfToken = data.csrfToken || '';
      errorEl.textContent = '';
      showApp();
    } else {
      errorEl.textContent = data.error || 'Setup failed';
    }
  } catch (err) {
    errorEl.textContent = 'Connection error';
  }
});

// ============================================
// Navigation
// ============================================
function navigate(page, params = {}) {
  state.page = page;

  // Update nav active state
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.classList.toggle('active', link.dataset.page === page);
  });

  // Show/hide pages
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  const target = document.getElementById(`page-${page}`);
  if (target) target.classList.add('active');

  // Load page content
  loadPage(page, params);
}

async function loadPage(page, params = {}) {
  const container = document.getElementById(`page-${page}`);
  if (!container) return;

  // Show loading
  container.innerHTML = '<div class="loading">Loading</div>';

  try {
    switch (page) {
      case 'home':
        await loadHome(container);
        break;
      case 'agents':
        await loadAgents(container);
        break;
      case 'agent-detail':
        await loadAgentDetail(container, params);
        break;
      case 'monitor':
        await loadMonitor(container);
        break;
      case 'skills':
        await loadSkills(container);
        break;
      case 'maintenance':
        await loadMaintenance(container);
        break;
      default:
        container.innerHTML = `<div class="empty">Page not found</div>`;
    }
  } catch (err) {
    container.innerHTML = `<div class="empty">Error loading page: ${err.message}</div>`;
  }
}

// ============================================
// Page Loaders (stubs — will implement per module)
// ============================================
async function loadHome(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Home</div>
        <div class="page-subtitle">System overview</div>
      </div>
      <button class="btn btn-ghost" onclick="loadHome(document.querySelector('.page.active'))">↻ Refresh</button>
    </div>
    <div class="card-grid" id="home-cards">
      <div class="card"><div class="card-title">System Health</div><div class="loading">Loading</div></div>
      <div class="card"><div class="card-title">Hermes</div><div class="loading">Loading</div></div>
      <div class="card"><div class="card-title">Services</div><div class="loading">Loading</div></div>
    </div>
    <div class="card-grid" id="home-quick" style="margin-top:16px;">
      <div class="card"><div class="card-title">Quick Stats</div><div class="loading">Loading</div></div>
      <div class="card"><div class="card-title">Token Usage (7d)</div><div class="loading">Loading</div></div>
    </div>
  `;

  // Fetch system health + profiles in parallel
  try {
    const [healthRes, profilesRes] = await Promise.all([
      api('/api/system/health'),
      api('/api/profiles'),
    ]);

    // System Health card
    const cardsEl = document.getElementById('home-cards');
    if (healthRes.ok) {
      cardsEl.innerHTML = `
        <div class="card">
          <div class="card-title">System Health</div>
          <div class="stat-row"><span class="stat-label">CPU</span><span class="stat-value">${healthRes.cpu || 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">RAM</span><span class="stat-value">${healthRes.ram || 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">Disk</span><span class="stat-value">${healthRes.disk || 'N/A'}</span></div>
        </div>
        <div class="card">
          <div class="card-title">Hermes</div>
          <div class="stat-row"><span class="stat-label">Version</span><span class="stat-value">${healthRes.hermes_version || 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">Agents</span><span class="stat-value">${healthRes.agents || 0}</span></div>
          <div class="stat-row"><span class="stat-label">Sessions</span><span class="stat-value">${healthRes.sessions || 0}</span></div>
        </div>
        <div class="card">
          <div class="card-title">Services</div>
          <div class="stat-row"><span class="stat-label">Nginx</span><span class="stat-value status-ok">● active</span></div>
          <div class="stat-row"><span class="stat-label">Fail2ban</span><span class="stat-value status-ok">● active</span></div>
          <div class="stat-row"><span class="stat-label">Docker</span><span class="stat-value status-ok">● active</span></div>
        </div>
      `;
    }

    // Quick Stats + Profiles
    const quickEl = document.getElementById('home-quick');
    if (profilesRes.ok && profilesRes.profiles) {
      const profiles = profilesRes.profiles;
      const running = profiles.filter(p => p.gateway === 'running').length;
      const profilesHtml = profiles.map(p => {
        const statusClass = p.gateway === 'running' ? 'status-ok' : 'status-off';
        const statusText = p.gateway === 'running' ? '● on' : '○ off';
        return `<div class="stat-row"><span class="stat-label">${p.name}</span><span class="stat-value ${statusClass}">${statusText} · ${p.model || '—'}</span></div>`;
      }).join('');

      quickEl.innerHTML = `
        <div class="card">
          <div class="card-title">Quick Stats</div>
          <div class="stat-row"><span class="stat-label">Agents</span><span class="stat-value">${profiles.length} total · ${running} running</span></div>
          ${profilesHtml}
        </div>
        <div class="card">
          <div class="card-title">Token Usage (7d)</div>
          <div id="home-token-usage"><div class="loading">Loading...</div></div>
        </div>
      `;
      // Fetch token usage
      loadTokenUsage('home-token-usage', 7);
    } else {
      quickEl.innerHTML = `
        <div class="card">
          <div class="card-title">Quick Stats</div>
          <div class="stat-row"><span class="stat-label">Agents</span><span class="stat-value">${healthRes.agents || 0}</span></div>
        </div>
        <div class="card">
          <div class="card-title">Token Usage (7d)</div>
          <div id="home-token-usage-2"><div class="loading">Loading...</div></div>
        </div>
      `;
      loadTokenUsage('home-token-usage-2', 7);
    }
  } catch (e) {
    document.getElementById('home-cards').innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${e.message}</div></div>`;
  }
}

async function loadTokenUsage(elementId, days = 7) {
  const el = document.getElementById(elementId);
  if (!el) return;
  try {
    const res = await api(`/api/usage/${days}`);
    if (res.ok) {
      const d = res;
      el.innerHTML = `
        <div class="stat-row"><span class="stat-label">Sessions</span><span class="stat-value">${d.sessions}</span></div>
        <div class="stat-row"><span class="stat-label">Messages</span><span class="stat-value">${d.messages?.toLocaleString() || 0}</span></div>
        <div class="stat-row"><span class="stat-label">Input tokens</span><span class="stat-value">${formatNumber(d.inputTokens)}</span></div>
        <div class="stat-row"><span class="stat-label">Output tokens</span><span class="stat-value">${formatNumber(d.outputTokens)}</span></div>
        <div class="stat-row"><span class="stat-label">Total tokens</span><span class="stat-value">${formatNumber(d.totalTokens)}</span></div>
        <div class="stat-row"><span class="stat-label">Est. cost</span><span class="stat-value">${d.cost || '$0.00'}</span></div>
        <div class="stat-row"><span class="stat-label">Active time</span><span class="stat-value">${d.activeTime || '—'}</span></div>
        ${d.topTools && d.topTools.length > 0 ? `
          <div style="margin-top:8px;font-size:10px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:0.06em;">Top Tools</div>
          ${d.topTools.slice(0, 3).map(t => `
            <div class="stat-row">
              <span class="stat-label">${t.name}</span>
              <span class="stat-value">${t.calls} (${t.pct})</span>
            </div>
          `).join('')}
        ` : ''}
      `;
    } else {
      el.innerHTML = '<div class="stat-row"><span class="stat-label">No data</span></div>';
    }
  } catch {
    el.innerHTML = '<div class="stat-row"><span class="stat-label">Unavailable</span></div>';
  }
}

function formatNumber(n) {
  if (!n) return '0';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

async function loadAgents(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Agents</div>
        <div class="page-subtitle">Manage your Hermes profiles</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-primary" onclick="showCreateAgent()">+ Create Agent</button>
        <button class="btn btn-ghost" onclick="loadAgents(document.querySelector('.page.active'))">↻ Refresh</button>
      </div>
    </div>
    <div class="card-grid" id="agents-grid">
      <div class="loading">Loading agents</div>
    </div>
  `;

  try {
    const res = await api('/api/profiles');
    const grid = document.getElementById('agents-grid');

    if (res.ok && res.profiles && res.profiles.length > 0) {
      grid.innerHTML = res.profiles.map(p => {
        const statusClass = p.gateway === 'running' ? 'status-ok' : 'status-off';
        const statusText = p.gateway === 'running' ? '● Running' : '○ Stopped';
        return `
          <div class="card agent-card" data-profile="${p.name}">
            <div class="card-title">${p.name} ${p.active ? '<span class="badge">default</span>' : ''}</div>
            <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value ${statusClass}">${statusText}</span></div>
            <div class="stat-row"><span class="stat-label">Model</span><span class="stat-value">${p.model || '—'}</span></div>
            ${p.alias ? `<div class="stat-row"><span class="stat-label">Alias</span><span class="stat-value">${p.alias}</span></div>` : ''}
            <div class="card-actions">
              <button class="btn btn-ghost btn-sm" onclick="navigate('agent-detail', {name:'${p.name}'})">Open</button>
              ${!p.active ? `<button class="btn btn-ghost btn-sm" onclick="setAgentDefault('${p.name}')">Set Default</button>` : ''}
              ${p.name !== 'default' ? `<button class="btn btn-ghost btn-sm btn-danger" onclick="deleteAgent('${p.name}')">Delete</button>` : ''}
            </div>
          </div>
        `;
      }).join('');
    } else {
      grid.innerHTML = '<div class="card"><div class="card-title">No agents found</div><div class="stat-row"><span class="stat-label">Create your first agent profile to get started.</span></div></div>';
    }
  } catch (e) {
    document.getElementById('agents-grid').innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${e.message}</div></div>`;
  }
}

async function deleteAgent(name) {
  if (!await customConfirm(`Delete agent "${name}"? This cannot be undone.`, 'Delete Agent')) return;
  try {
    const csrfToken = state.csrfToken || '';
    const res = await api(`/api/profiles/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': csrfToken },
    });
    if (res.ok) {
      showToast(`Agent ${name} deleted`, 'success');
      loadAgents(document.querySelector('.page.active'));
    } else {
      await customAlert(res.error || 'Failed to delete', 'Error');
    }
  } catch (e) {
    await customAlert(e.message, 'Error');
  }
}

async function setAgentDefault(name) {
  try {
    const csrfToken = state.csrfToken || '';
    await api('/api/profiles/use', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ profile: name }),
    });
    loadAgents(document.querySelector('.page.active'));
  } catch (e) {
    customAlert(e.message, 'Error');
  }
}

async function loadAgentDetail(container, params) {
  const name = params?.name || 'unknown';
  state.currentAgent = name;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Agent: ${name}</div>
        <div class="page-subtitle">Agent detail</div>
      </div>
      <button class="btn btn-ghost" onclick="navigate('agents')">← Back to Agents</button>
    </div>
    <div class="tabs" id="agent-tabs">
      <button class="tab active" data-tab="dashboard">Dashboard</button>
      <button class="tab" data-tab="sessions">Sessions</button>
      <button class="tab" data-tab="gateway">Gateway</button>
      <button class="tab" data-tab="config">Config</button>
      <button class="tab" data-tab="memory">Memory</button>
    </div>
    <div id="agent-tab-content">
      <div class="loading">Loading</div>
    </div>
  `;

  // Tab switching
  document.getElementById('agent-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    document.querySelectorAll('#agent-tabs .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    loadAgentTab(tab.dataset.tab, name);
  });

  // Load default tab
  loadAgentTab('dashboard', name);
}

async function loadAgentTab(tabName, profileName) {
  const content = document.getElementById('agent-tab-content');
  content.innerHTML = '<div class="loading">Loading</div>';

  switch (tabName) {
    case 'dashboard': await loadAgentDashboard(content, profileName); break;
    case 'sessions': await loadAgentSessions(content, profileName); break;
    case 'gateway': await loadAgentGateway(content, profileName); break;
    case 'config': await loadAgentConfig(content, profileName); break;
    case 'memory': await loadAgentMemory(content, profileName); break;
    default: content.innerHTML = '<div class="empty">Unknown tab</div>';
  }
}

async function loadAgentDashboard(container, name) {
  container.innerHTML = '<div class="loading">Loading dashboard</div>';

  try {
    const [gatewayRes, profilesRes] = await Promise.all([
      api(`/api/gateway/${name}`),
      api('/api/profiles'),
    ]);

    const profile = profilesRes.ok ? profilesRes.profiles.find(p => p.name === name) : null;
    const gatewayOk = gatewayRes.ok;

    container.innerHTML = `
      <div class="card-grid">
        <div class="card">
          <div class="card-title">Identity</div>
          <div class="stat-row"><span class="stat-label">Profile</span><span class="stat-value">${name}</span></div>
          <div class="stat-row"><span class="stat-label">Model</span><span class="stat-value">${profile?.model || '—'}</span></div>
          <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value ${gatewayOk && gatewayRes.active ? 'status-ok' : 'status-off'}">${gatewayOk && gatewayRes.active ? '● Active' : '○ Inactive'}</span></div>
          ${profile?.alias ? `<div class="stat-row"><span class="stat-label">Alias</span><span class="stat-value">${profile.alias}</span></div>` : ''}
          ${profile?.active ? `<div class="stat-row"><span class="stat-label">Default</span><span class="stat-value status-ok">Yes</span></div>` : ''}
        </div>
        <div class="card">
          <div class="card-title">Gateway</div>
          <div class="stat-row"><span class="stat-label">Service</span><span class="stat-value">${gatewayRes.service || '—'}</span></div>
          <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value ${gatewayOk && gatewayRes.active ? 'status-ok' : 'status-off'}">${gatewayOk && gatewayRes.active ? '● Running' : '○ Stopped'}</span></div>
          <div class="stat-row"><span class="stat-label">Enabled</span><span class="stat-value">${gatewayRes.enabled ? 'Yes' : 'No'}</span></div>
        </div>
        <div class="card">
          <div class="card-title">Token Usage (today)</div>
          <div id="agent-token-${name}"><div class="loading">Loading...</div></div>
        </div>
      </div>
    `;
    loadTokenUsage(`agent-token-${name}`, 1);
  } catch (e) {
    container.innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${e.message}</div></div>`;
  }
}

// Agent tab stubs (will implement per module)
async function loadAgentSessions(container, name) {
  container.innerHTML = `
    <div class="card-grid" style="margin-bottom:16px;">
      <div class="card" id="session-stats-${name}">
        <div class="card-title">Session Stats</div>
        <div class="loading">Loading stats...</div>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:16px;align-items:center;">
      <input type="text" id="session-search" placeholder="Search sessions..." style="flex:1;" />
      <button class="btn btn-ghost" onclick="loadAgentSessions(document.getElementById('agent-tab-content'), '${name}')">↻ Refresh</button>
    </div>
    <div id="sessions-table">
      <div class="loading">Loading sessions for ${name}...</div>
    </div>
  `;

  // Load session stats
  loadSessionStats(name);

  try {
    const res = await api(`/api/all-sessions?profile=${encodeURIComponent(name)}`);
    const tableEl = document.getElementById('sessions-table');

    if (!res.ok || !res.sessions || res.sessions.length === 0) {
      tableEl.innerHTML = '<div class="card"><div class="card-title">No sessions found</div></div>';
      return;
    }

    // Filter by profile if sessions have profile info, otherwise show all
    const sessions = res.sessions;

    function renderSessions(filter = '') {
      const filtered = filter
        ? sessions.filter(s =>
            (s.title || '').toLowerCase().includes(filter) ||
            (s.id || '').toLowerCase().includes(filter) ||
            (s.source || '').toLowerCase().includes(filter)
          )
        : sessions;

      if (filtered.length === 0) {
        tableEl.innerHTML = '<div class="card"><div class="card-title">No matching sessions</div></div>';
        return;
      }

      tableEl.innerHTML = `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Session ID</th>
                <th>Title</th>
                <th>Source</th>
                <th>Messages</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${filtered.slice(0, 100).map(s => `
                <tr>
                  <td class="mono" style="font-size:11px;">${s.id || '—'}</td>
                  <td>${s.title || 'Untitled'}</td>
                  <td><span class="badge">${s.source || '—'}</span></td>
                  <td>${s.message_count ?? '—'}</td>
                  <td style="font-size:11px;color:var(--fg-muted);">${s.updated_at ? new Date(s.updated_at).toLocaleDateString() : '—'}</td>
                  <td>
                    <div style="display:flex;gap:4px;">
                      <button class="btn btn-ghost btn-sm" onclick="resumeSession('${s.id}')" title="Resume in CLI">▶</button>
                      <button class="btn btn-ghost btn-sm" onclick="renameSession('${s.id}', '${(s.title || '').replace(/'/g, "\\'")}')" title="Rename">✎</button>
                      <button class="btn btn-ghost btn-sm" onclick="exportSession('${s.id}')" title="Export">↓</button>
                      <button class="btn btn-ghost btn-sm btn-danger" onclick="deleteSession('${s.id}', '${name}')" title="Delete">×</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div style="margin-top:8px;font-size:11px;color:var(--fg-muted);">
          Showing ${Math.min(filtered.length, 100)} of ${filtered.length} sessions
        </div>
      `;
    }

    renderSessions();

    // Search handler
    document.getElementById('session-search')?.addEventListener('input', (e) => {
      renderSessions(e.target.value.toLowerCase());
    });

  } catch (e) {
    container.innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${e.message}</div></div>`;
  }
}

async function loadSessionStats(name) {
  const el = document.getElementById(`session-stats-${name}`);
  if (!el) return;
  try {
    const res = await api('/api/sessions/stats');
    if (res.ok && res.stats) {
      // Parse stats output
      const raw = res.stats;
      const totalMatch = raw.match(/Total sessions:\s+(\d+)/);
      const messagesMatch = raw.match(/Total messages:\s+([\d,]+)/);
      const dbMatch = raw.match(/Database size:\s+(.+)/);
      const cliMatch = raw.match(/cli:\s+(\d+)\s+sessions/);
      const tgMatch = raw.match(/telegram:\s+(\d+)\s+sessions/);
      const waMatch = raw.match(/whatsapp:\s+(\d+)\s+sessions/);

      el.innerHTML = `
        <div class="card-title">Session Stats</div>
        <div class="stat-row"><span class="stat-label">Total sessions</span><span class="stat-value">${totalMatch?.[1] || '—'}</span></div>
        <div class="stat-row"><span class="stat-label">Total messages</span><span class="stat-value">${messagesMatch?.[1]?.toLocaleString() || '—'}</span></div>
        <div class="stat-row"><span class="stat-label">DB size</span><span class="stat-value">${dbMatch?.[1] || '—'}</span></div>
        <div style="margin-top:6px;font-size:10px;color:var(--fg-subtle);text-transform:uppercase;">By Platform</div>
        ${cliMatch ? `<div class="stat-row"><span class="stat-label">CLI</span><span class="stat-value">${cliMatch[1]} sessions</span></div>` : ''}
        ${tgMatch ? `<div class="stat-row"><span class="stat-label">Telegram</span><span class="stat-value">${tgMatch[1]} sessions</span></div>` : ''}
        ${waMatch ? `<div class="stat-row"><span class="stat-label">WhatsApp</span><span class="stat-value">${waMatch[1]} sessions</span></div>` : ''}
      `;
    } else {
      el.innerHTML = '<div class="card-title">Session Stats</div><div class="stat-row"><span class="stat-label">No stats available</span></div>';
    }
  } catch {
    el.innerHTML = '<div class="card-title">Session Stats</div><div class="error-msg">Failed to load stats</div>';
  }
}

async function resumeSession(sessionId) {
  const agent = state.currentAgent || 'david';
  const cmd = `hermes -p ${agent} -r ${sessionId}`;
  openTerminalPanel(`Resume: ${sessionId}`, cmd);
}

function openTerminalPanel(title, command) {
  // Remove existing panel
  document.querySelector('.terminal-panel')?.remove();

  const panel = document.createElement('div');
  panel.className = 'terminal-panel';
  panel.innerHTML = `
    <div class="terminal-header">
      <span class="terminal-title">${escapeHtml(title)}</span>
      <span class="terminal-close" onclick="document.getElementById('main').style.bottom='0'; this.closest('.terminal-panel').remove()">×</span>
    </div>
    <div class="terminal-body" id="terminal-body"></div>
  `;
  document.body.appendChild(panel);

  // Adjust main content
  document.getElementById('main').style.bottom = '45vh';

  // Load xterm and connect
  loadXtermAndConnect(command);
}

async function loadXtermAndConnect(command) {
  const bodyEl = document.getElementById('terminal-body');
  if (!bodyEl) return;

  // Load xterm CSS
  if (!document.querySelector('link[href*="xterm"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/vendor/xterm/css/xterm.css';
    document.head.appendChild(link);
  }

  // Load xterm JS dynamically
  const loadScript = (src) => new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

  try {
    await loadScript('/vendor/xterm/lib/xterm.js');
    await loadScript('/vendor/xterm-addon-fit/lib/xterm-addon-fit.js');

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', monospace",
      theme: {
        background: '#062e27',
        foreground: '#e8f5f0',
        cursor: '#67f0a2',
        selectionBackground: 'rgba(103, 240, 162, 0.3)',
      },
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(bodyEl);
    fitAddon.fit();

    // Connect WebSocket
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProtocol}//${location.host}/ws`);
    ws.onopen = () => {
      // Wait for terminal to be ready, then send command
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'terminal-input', data: command + '\r' }));
      }, 500);
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'terminal-output' && msg.chunk) {
          term.write(msg.chunk);
        }
        if (msg.type === 'terminal-transcript' && msg.buffer) {
          term.write(msg.buffer);
        }
      } catch {}
    };
    ws.onclose = () => {
      term.write('\r\n[Connection closed]');
    };

    // Send user input
    term.onData((data) => {
      ws.send(JSON.stringify({ type: 'terminal-input', data }));
    });

    // Resize
    const resizeHandler = () => {
      fitAddon.fit();
      ws.send(JSON.stringify({ type: 'terminal-resize', cols: term.cols, rows: term.rows }));
    };
    window.addEventListener('resize', resizeHandler);

    // Cleanup on panel close
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.terminal-panel')) {
        ws.close();
        window.removeEventListener('resize', resizeHandler);
        observer.disconnect();
        document.getElementById('main').style.bottom = '0';
      }
    });
    observer.observe(document.body, { childList: true });

  } catch (e) {
    bodyEl.innerHTML = `<div style="color:var(--red);padding:20px;">Failed to load terminal: ${e.message}</div>`;
  }
}

async function renameSession(sessionId, currentTitle) {
  const newTitle = await customPrompt('New session title:', currentTitle);
  if (newTitle === null || newTitle === currentTitle) return;
  try {
    const csrfToken = state.csrfToken || '';
    await api(`/api/sessions/${sessionId}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ title: newTitle }),
    });
    showToast('Session renamed', 'success');
    loadAgentSessions(document.getElementById('agent-tab-content'), state.currentAgent);
  } catch (e) {
    showToast('Rename failed: ' + e.message, 'error');
  }
}

async function exportSession(sessionId) {
  try {
    const res = await api(`/api/sessions/${sessionId}/export`);
    if (res.ok) {
      // Download as JSON
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-${sessionId}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Session exported', 'success');
    }
  } catch (e) {
    showToast('Export failed: ' + e.message, 'error');
  }
}

async function deleteSession(sessionId, profileName) {
  if (!await customConfirm(`Delete session ${sessionId}?`)) return;
  try {
    const csrfToken = state.csrfToken || '';
    await api(`/api/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': csrfToken },
    });
    showToast('Session deleted', 'success');
    loadAgentSessions(document.getElementById('agent-tab-content'), profileName);
  } catch (e) {
    showToast('Delete failed: ' + e.message, 'error');
  }
}

async function loadAgentGateway(container, name) {
  container.innerHTML = `<div class="loading">Loading gateway for ${name}...</div>`;

  try {
    const res = await api(`/api/gateway/${name}`);
    const ok = res.ok;
    const active = ok && res.active;

    container.innerHTML = `
      <div class="card-grid">
        <div class="card">
          <div class="card-title">Gateway Service</div>
          <div class="stat-row"><span class="stat-label">Service</span><span class="stat-value">${res.service || '—'}</span></div>
          <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value ${active ? 'status-ok' : 'status-off'}">${active ? '● Running' : '○ Stopped'}</span></div>
          <div class="stat-row"><span class="stat-label">Enabled</span><span class="stat-value">${res.enabled ? 'Yes' : 'No'}</span></div>
          <div class="card-actions" style="margin-top:12px;">
            <button class="btn btn-ghost" onclick="gatewayAction('${name}', 'start')" ${active ? 'disabled' : ''}>Start</button>
            <button class="btn btn-ghost" onclick="gatewayAction('${name}', 'stop')" ${!active ? 'disabled' : ''}>Stop</button>
            <button class="btn btn-ghost" onclick="gatewayAction('${name}', 'restart')">Restart</button>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Connections</div>
          <div id="gateway-connections-${name}">
            <div class="loading">Loading connections...</div>
          </div>
        </div>
      </div>
      <div style="margin-top:16px;">
        <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center;">
          <div class="tabs" id="log-tabs" style="margin:0;">
            <button class="tab active" data-log="agent">Agent</button>
            <button class="tab" data-log="gateway">Gateway</button>
            <button class="tab" data-log="errors">Errors</button>
          </div>
          <select id="log-level" style="margin-left:auto;">
            <option value="">All levels</option>
            <option value="WARNING">WARNING+</option>
            <option value="ERROR">ERROR+</option>
          </select>
          <button class="btn btn-ghost" onclick="loadGatewayLogs('${name}')">↻ Refresh</button>
        </div>
        <div class="log-viewer" id="log-viewer">
          <div class="loading">Loading logs...</div>
        </div>
      </div>
    `;

    // Load connections
    loadGatewayConnections(name);

    // Load logs
    loadGatewayLogs(name);

    // Log tab switching
    document.getElementById('log-tabs')?.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      document.querySelectorAll('#log-tabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      loadGatewayLogs(name);
    });

  } catch (e) {
    container.innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${e.message}</div></div>`;
  }
}

async function loadGatewayConnections(name) {
  const el = document.getElementById(`gateway-connections-${name}`);
  if (!el) return;
  try {
    const statusRes = await api(`/api/gateway/${name}`);
    // Parse connections from status — for now show basic info
    el.innerHTML = `
      <div class="stat-row"><span class="stat-label">WhatsApp</span><span class="stat-value ${statusRes.active ? 'status-ok' : 'status-off'}">${statusRes.active ? '● connected' : '○ disconnected'}</span></div>
      <div class="stat-row"><span class="stat-label">Telegram</span><span class="stat-value status-off">○ not configured</span></div>
      <div class="stat-row"><span class="stat-label">Discord</span><span class="stat-value status-off">○ not configured</span></div>
    `;
  } catch {
    el.innerHTML = '<div class="stat-row"><span class="stat-label">Error loading connections</span></div>';
  }
}

async function loadGatewayLogs(name) {
  const viewer = document.getElementById('log-viewer');
  if (!viewer) return;
  viewer.innerHTML = '<div class="loading">Loading logs...</div>';

  const activeTab = document.querySelector('#log-tabs .tab.active')?.dataset.log || 'agent';
  const level = document.getElementById('log-level')?.value || '';

  try {
    const url = `/api/gateway/${name}/logs?log=${activeTab}&lines=100${level ? '&level=' + level : ''}`;
    const res = await api(url);
    if (res.ok) {
      viewer.innerHTML = `<pre style="margin:0;font-size:11px;white-space:pre-wrap;word-break:break-all;max-height:400px;overflow-y:auto;color:var(--fg-muted);">${escapeHtml(res.logs || 'No logs')}</pre>`;
    } else {
      viewer.innerHTML = '<div class="empty">No logs available</div>';
    }
  } catch (e) {
    viewer.innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
}

async function gatewayAction(profile, action) {
  if (action === 'stop' && !await customConfirm(`Stop gateway for ${profile}?`)) return;
  try {
    const csrfToken = state.csrfToken || '';
    const res = await api(`/api/gateway/${profile}/${action}`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
    });
    if (res.ok) {
      showToast(`Gateway ${action} successful`, 'success');
      loadAgentGateway(document.getElementById('agent-tab-content'), profile);
    } else {
      showToast(`Gateway ${action} failed: ${res.error || 'Unknown error'}`, 'error');
    }
  } catch (e) {
    showToast(`Gateway ${action} failed: ${e.message}`, 'error');
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function loadAgentConfig(container, name) {
  container.innerHTML = `<div class="loading">Loading config for ${name}...</div>`;

  try {
    const res = await api(`/api/config/${name}`);
    if (!res.ok) {
      container.innerHTML = `<div class="card"><div class="card-title">Config</div><div class="error-msg">${res.error || 'Failed to load config'}</div></div>`;
      return;
    }

    const config = res.config || {};
    const categories = [
      { key: 'model', label: 'Model & Provider', icon: '⚡' },
      { key: 'agent', label: 'Agent Behavior', icon: '🤖' },
      { key: 'terminal', label: 'Terminal', icon: '💻' },
      { key: 'display', label: 'Display & Streaming', icon: '🖥' },
      { key: 'compression', label: 'Context & Compression', icon: '📦' },
      { key: 'mcp', label: 'MCP Servers', icon: '🔌' },
    ];

    container.innerHTML = `
      <div style="margin-bottom:12px;">
        <div class="tabs" id="config-tabs" style="margin:0;">
          ${categories.map((c, i) => `<button class="tab ${i === 0 ? 'active' : ''}" data-cat="${c.key}">${c.icon} ${c.label}</button>`).join('')}
          <button class="tab" data-cat="raw">📋 Raw YAML</button>
        </div>
      </div>
      <div id="config-content">
        <div class="loading">Loading...</div>
      </div>
    `;

    function renderCategory(catKey) {
      const contentEl = document.getElementById('config-content');
      if (catKey === 'raw') {
        contentEl.innerHTML = `
          <div class="card">
            <div class="card-title">Raw Config (read-only)</div>
            <pre style="font-size:11px;white-space:pre-wrap;max-height:500px;overflow-y:auto;color:var(--fg-muted);">${escapeHtml(JSON.stringify(config, null, 2))}</pre>
          </div>
        `;
        return;
      }

      const data = config[catKey] || {};
      const entries = Object.entries(data);

      if (entries.length === 0) {
        contentEl.innerHTML = `<div class="card"><div class="card-title">${catKey}</div><div class="stat-row"><span class="stat-label">No settings configured</span></div></div>`;
        return;
      }

      contentEl.innerHTML = `
        <div class="card">
          <div class="card-title">${categories.find(c => c.key === catKey)?.label || catKey}</div>
          ${entries.map(([k, v]) => {
            const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
            const isBool = typeof v === 'boolean';
            const isNum = typeof v === 'number';
            return `
              <div class="stat-row">
                <span class="stat-label">${k}</span>
                <span class="stat-value">${isBool ? (v ? '✓ enabled' : '✗ disabled') : escapeHtml(val)}</span>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    renderCategory(categories[0].key);

    // Tab switching
    document.getElementById('config-tabs')?.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      document.querySelectorAll('#config-tabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderCategory(tab.dataset.cat);
    });

  } catch (e) {
    container.innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${e.message}</div></div>`;
  }
}

async function loadAgentMemory(container, name) {
  container.innerHTML = `<div class="loading">Loading memory for ${name}...</div>`;

  try {
    const [memoryRes, configRes] = await Promise.all([
      api(`/api/memory/${name}`),
      api(`/api/config/${name}`),
    ]);

    const provider = configRes.ok ? (configRes.config?.memory?.provider || 'built-in') : 'built-in';
    const memory = memoryRes.ok ? memoryRes : {};

    // Build provider-specific section
    let providerSection = '';
    if (provider === 'honcho') {
      providerSection = `
        <div class="card">
          <div class="card-title">Honcho Memory</div>
          <div class="stat-row"><span class="stat-label">Provider</span><span class="stat-value status-ok">honcho</span></div>
          <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value ${memory.honcho_connected ? 'status-ok' : 'status-off'}">${memory.honcho_connected ? '● Connected' : '○ Disconnected'}</span></div>
          ${memory.peers ? `<div class="stat-row"><span class="stat-label">Peers</span><span class="stat-value">${memory.peers}</span></div>` : ''}
          ${memory.sessions ? `<div class="stat-row"><span class="stat-label">Sessions</span><span class="stat-value">${memory.sessions}</span></div>` : ''}
        </div>
      `;
    } else if (provider !== 'built-in') {
      providerSection = `
        <div class="card">
          <div class="card-title">${provider} Memory</div>
          <div class="stat-row"><span class="stat-label">Provider</span><span class="stat-value">${provider}</span></div>
          <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value">${memory.connected ? '● Connected' : '○ Unknown'}</span></div>
        </div>
      `;
    } else {
      providerSection = `
        <div class="card">
          <div class="card-title">External Provider</div>
          <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value">Built-in only (MEMORY.md + USER.md)</span></div>
        </div>
      `;
    }

    container.innerHTML = `
      <div class="card-grid">
        <div class="card">
          <div class="card-title">Built-in Memory</div>
          <div class="stat-row"><span class="stat-label">MEMORY.md</span><span class="stat-value">${memory.memory_chars || 0} / ${memory.memory_max || 2200} chars</span></div>
          <div style="margin-top:8px;">
            <div class="progress-bar">
              <div class="progress-fill ${((memory.memory_chars || 0) / (memory.memory_max || 2200)) > 0.9 ? 'red' : 'green'}" style="width:${Math.min(100, ((memory.memory_chars || 0) / (memory.memory_max || 2200)) * 100)}%;"></div>
            </div>
          </div>
          <div class="stat-row" style="margin-top:8px;"><span class="stat-label">USER.md</span><span class="stat-value">${memory.user_chars || 0} / ${memory.user_max || 1375} chars</span></div>
          <div class="stat-row"><span class="stat-label">SOUL.md</span><span class="stat-value">${memory.soul_chars || 0} chars</span></div>
        </div>
        ${providerSection}
      </div>
      <div style="margin-top:16px;">
        <div class="card">
          <div class="card-title">Context Compression</div>
          <div class="stat-row"><span class="stat-label">Enabled</span><span class="stat-value">${configRes.config?.compression?.enabled ? '✓ Yes' : '✗ No'}</span></div>
          <div class="stat-row"><span class="stat-label">Threshold</span><span class="stat-value">${configRes.config?.compression?.threshold || '—'}</span></div>
          <div class="stat-row"><span class="stat-label">Summary Model</span><span class="stat-value">${configRes.config?.compression?.summary_model || '—'}</span></div>
        </div>
      </div>
    `;
  } catch (e) {
    container.innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${e.message}</div></div>`;
  }
}

async function loadMonitor(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">System Monitor</div>
        <div class="page-subtitle">System resources and services</div>
      </div>
      <button class="btn btn-ghost" onclick="loadMonitor(document.querySelector('.page.active'))">↻ Refresh</button>
    </div>
    <div class="card-grid" id="monitor-resources">
      <div class="card"><div class="card-title">CPU / RAM / Disk</div><div class="loading">Loading</div></div>
      <div class="card"><div class="card-title">Services</div><div class="loading">Loading</div></div>
      <div class="card"><div class="card-title">Gateways</div><div class="loading">Loading</div></div>
    </div>
    <div class="card-grid" style="margin-top:16px;" id="monitor-extras">
      <div class="card"><div class="card-title">Cron Jobs</div><div class="loading">Loading</div></div>
      <div class="card"><div class="card-title">Token Usage (30d)</div><div class="loading">Loading</div></div>
      <div class="card"><div class="card-title">Errors</div><div class="loading">Loading</div></div>
    </div>
  `;

  try {
    const [healthRes, profilesRes] = await Promise.all([
      api('/api/system/health'),
      api('/api/profiles'),
    ]);

    // Resources card
    const resourcesEl = document.getElementById('monitor-resources');
    resourcesEl.innerHTML = `
      <div class="card">
        <div class="card-title">Resources</div>
        <div class="stat-row"><span class="stat-label">CPU</span><span class="stat-value">${healthRes.cpu || 'N/A'}</span></div>
        <div class="stat-row"><span class="stat-label">RAM</span><span class="stat-value">${healthRes.ram || 'N/A'}</span></div>
        <div class="stat-row"><span class="stat-label">Disk</span><span class="stat-value">${healthRes.disk || 'N/A'}</span></div>
        <div class="stat-row"><span class="stat-label">Uptime</span><span class="stat-value">${healthRes.uptime || 'N/A'}</span></div>
      </div>
      <div class="card">
        <div class="card-title">Services</div>
        <div class="stat-row"><span class="stat-label">Nginx</span><span class="stat-value ${healthRes.nginx === 'active' ? 'status-ok' : 'status-off'}">● ${healthRes.nginx || 'unknown'}</span></div>
        <div class="stat-row"><span class="stat-label">Fail2ban</span><span class="stat-value ${healthRes.fail2ban === 'active' ? 'status-ok' : 'status-off'}">● ${healthRes.fail2ban || 'unknown'}</span></div>
        <div class="stat-row"><span class="stat-label">Docker</span><span class="stat-value ${healthRes.docker === 'active' ? 'status-ok' : 'status-off'}">● ${healthRes.docker || 'unknown'}</span></div>
      </div>
      <div class="card">
        <div class="card-title">Gateways</div>
        ${profilesRes.ok && profilesRes.profiles ? profilesRes.profiles.map(p => `
          <div class="stat-row">
            <span class="stat-label">${p.name}</span>
            <span class="stat-value ${p.gateway === 'running' ? 'status-ok' : 'status-off'}">${p.gateway === 'running' ? '● running' : '○ stopped'}</span>
          </div>
        `).join('') : '<div class="stat-row"><span class="stat-label">No profiles</span></div>'}
      </div>
    `;

    // Extras
    const extrasEl = document.getElementById('monitor-extras');
    extrasEl.innerHTML = `
      <div class="card">
        <div class="card-title">Cron Jobs</div>
        <div class="stat-row"><span class="stat-label">Total</span><span class="stat-value">${healthRes.cron_total || 0}</span></div>
        <div class="stat-row"><span class="stat-label">Active</span><span class="stat-value">${healthRes.cron_active || 0}</span></div>
      </div>
      <div class="card">
        <div class="card-title">Token Usage (30d)</div>
        <div id="monitor-token-usage"><div class="loading">Loading...</div></div>
      </div>
      <div class="card">
        <div class="card-title">Errors</div>
        <div class="stat-row"><span class="stat-label">Error count</span><span class="stat-value ${healthRes.error_count > 0 ? '' : 'status-ok'}">${healthRes.error_count || 0}</span></div>
      </div>
    `;
    loadTokenUsage('monitor-token-usage', 30);

  } catch (e) {
    document.getElementById('monitor-resources').innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${e.message}</div></div>`;
  }
}

async function loadSkills(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Skills Marketplace</div>
        <div class="page-subtitle">Browse and manage installed skills</div>
      </div>
      <div style="display:flex;gap:8px;">
        <input type="text" id="skills-search" placeholder="Search skills..." style="width:200px;" />
        <button class="btn btn-ghost" onclick="loadSkills(document.querySelector('.page.active'))">↻ Refresh</button>
      </div>
    </div>
    <div id="skills-list">
      <div class="loading">Loading skills...</div>
    </div>
  `;

  try {
    const res = await api('/api/skills');
    const listEl = document.getElementById('skills-list');

    if (!res.ok || !res.skills || res.skills.length === 0) {
      listEl.innerHTML = '<div class="card"><div class="card-title">No skills installed</div></div>';
      return;
    }

    const skills = res.skills;

    function renderSkills(filter = '') {
      const filtered = filter
        ? skills.filter(s =>
            (s.name || '').toLowerCase().includes(filter) ||
            (s.description || '').toLowerCase().includes(filter) ||
            (s.category || '').toLowerCase().includes(filter)
          )
        : skills;

      if (filtered.length === 0) {
        listEl.innerHTML = '<div class="card"><div class="card-title">No matching skills</div></div>';
        return;
      }

      // Group by category
      const grouped = {};
      filtered.forEach(s => {
        const cat = s.category || 'uncategorized';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(s);
      });

      listEl.innerHTML = Object.entries(grouped).map(([cat, items]) => `
        <div style="margin-bottom:16px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--fg-muted);margin-bottom:8px;">${cat}</div>
          <div class="card-grid">
            ${items.map(s => `
              <div class="card">
                <div class="card-title">${s.name || 'Unknown'}</div>
                <div style="font-size:11px;color:var(--fg-muted);margin-top:4px;">${s.description || 'No description'}</div>
                <div style="margin-top:8px;display:flex;gap:8px;">
                  ${s.enabled ? '<span class="badge status-ok">enabled</span>' : '<span class="badge status-off">disabled</span>'}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('');
    }

    renderSkills();

    document.getElementById('skills-search')?.addEventListener('input', (e) => {
      renderSkills(e.target.value.toLowerCase());
    });

  } catch (e) {
    document.getElementById('skills-list').innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${e.message}</div></div>`;
  }
}

async function loadMaintenance(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Maintenance</div>
        <div class="page-subtitle">System tools, diagnostics, and user management</div>
      </div>
    </div>
    <div class="card-grid" id="maintenance-grid">
      <div class="card">
        <div class="card-title">Doctor</div>
        <div class="stat-row"><span class="stat-label">Run diagnostics</span></div>
        <div class="card-actions" style="margin-top:8px;">
          <button class="btn btn-ghost" onclick="runDoctor()">Run Diagnose</button>
          <button class="btn btn-ghost" onclick="runDoctor(true)">Auto-fix</button>
        </div>
        <div id="doctor-result" style="margin-top:8px;"></div>
      </div>
      <div class="card">
        <div class="card-title">Dump</div>
        <div class="stat-row"><span class="stat-label">Setup summary for debugging</span></div>
        <div class="card-actions" style="margin-top:8px;">
          <button class="btn btn-ghost" onclick="runDump()">Generate Dump</button>
        </div>
        <div id="dump-result" style="margin-top:8px;"></div>
      </div>
      <div class="card">
        <div class="card-title">Hermes Update</div>
        <div class="stat-row"><span class="stat-label">Version</span><span class="stat-value" id="update-version">—</span></div>
        <div class="card-actions" style="margin-top:8px;">
          <button class="btn btn-ghost" onclick="runUpdate()">Update Hermes</button>
        </div>
        <div id="update-result" style="margin-top:8px;"></div>
      </div>
    </div>
    <div class="card-grid" style="margin-top:16px;" id="maintenance-users">
      <div class="card">
        <div class="card-title">HCI Users</div>
        <div id="users-list"><div class="loading">Loading users...</div></div>
        <div class="card-actions" style="margin-top:8px;">
          <button class="btn btn-ghost" onclick="showCreateUser()">+ Create User</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Hermes Auth</div>
        <div id="auth-list"><div class="loading">Loading auth...</div></div>
      </div>
      <div class="card">
        <div class="card-title">Audit Log</div>
        <div id="audit-log"><div class="loading">Loading audit...</div></div>
      </div>
    </div>
  `;

  // Load users
  loadUsers();

  // Load auth
  loadAuth();

  // Load audit
  loadAudit();

  // Load version
  try {
    const healthRes = await api('/api/system/health');
    if (healthRes.ok) {
      document.getElementById('update-version').textContent = healthRes.hermes_version || '—';
    }
  } catch {}
}

async function loadUsers() {
  try {
    const res = await api('/api/users');
    const el = document.getElementById('users-list');
    if (res.ok && res.users) {
      el.innerHTML = res.users.map(u => `
        <div class="stat-row">
          <span class="stat-label">${u.username} <span class="badge">${u.role}</span></span>
          <span class="stat-value">
            ${u.last_login ? new Date(u.last_login).toLocaleDateString() : 'never'}
            ${res.users.length > 1 ? `<button class="btn btn-ghost btn-sm btn-danger" onclick="deleteUser('${u.username}')" style="margin-left:8px;">×</button>` : ''}
          </span>
        </div>
      `).join('');
    } else {
      el.innerHTML = '<div class="stat-row"><span class="stat-label">No users</span></div>';
    }
  } catch (e) {
    document.getElementById('users-list').innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
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
      loadUsers();
    } else {
      await customAlert(res.error || 'Failed', 'Error');
    }
  } catch (e) {
    await customAlert(e.message, 'Error');
  }
}

async function loadAuth() {
  try {
    const res = await api('/api/auth/providers');
    const el = document.getElementById('auth-list');
    if (res.ok && res.providers) {
      el.innerHTML = res.providers.map(p => `
        <div class="stat-row">
          <span class="stat-label">${p.name}</span>
          <span class="stat-value ${p.set ? 'status-ok' : 'status-off'}">${p.set ? '● set' : '○ not set'}</span>
        </div>
      `).join('');
    } else {
      el.innerHTML = '<div class="stat-row"><span class="stat-label">Auth info unavailable</span></div>';
    }
  } catch {
    document.getElementById('auth-list').innerHTML = '<div class="stat-row"><span class="stat-label">Auth info unavailable</span></div>';
  }
}

async function loadAudit() {
  try {
    const res = await api('/api/audit');
    const el = document.getElementById('audit-log');
    if (res.ok && res.entries) {
      el.innerHTML = res.entries.slice(0, 10).map(e => `
        <div style="font-size:10px;color:var(--fg-muted);padding:2px 0;">[${e.timestamp}] ${e.user}: ${e.action}</div>
      `).join('') || '<div class="stat-row"><span class="stat-label">No audit entries</span></div>';
    } else {
      el.innerHTML = '<div class="stat-row"><span class="stat-label">No audit entries</span></div>';
    }
  } catch {
    document.getElementById('audit-log').innerHTML = '<div class="stat-row"><span class="stat-label">Audit unavailable</span></div>';
  }
}

async function runDoctor(fix = false) {
  const el = document.getElementById('doctor-result');
  el.innerHTML = '<div class="loading">Running diagnostics...</div>';
  try {
    const csrfToken = state.csrfToken || '';
    const res = await api('/api/doctor', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ fix }),
    });
    if (res.ok && res.output) {
      // Style the output
      const styled = escapeHtml(res.output)
        .replace(/✓/g, '<span style="color:var(--green);">✓</span>')
        .replace(/✗/g, '<span style="color:var(--red);">✗</span>')
        .replace(/◆/g, '<span style="color:var(--yellow);">◆</span>')
        .replace(/(🩺.*?)(?=<)/g, '<strong style="color:var(--fg);">$1</strong>');
      el.innerHTML = `<div style="font-size:11px;line-height:1.8;max-height:400px;overflow-y:auto;padding:8px;">${styled}</div>`;
    } else {
      el.innerHTML = `<div class="error-msg">${res.output || 'No output'}</div>`;
    }
  } catch (e) {
    el.innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
}

async function runDump() {
  const el = document.getElementById('dump-result');
  el.innerHTML = '<div class="loading">Generating dump...</div>';
  try {
    const res = await api('/api/dump');
    el.innerHTML = `<pre style="font-size:10px;white-space:pre-wrap;max-height:300px;overflow-y:auto;color:var(--fg-muted);">${escapeHtml(res.output || 'No output')}</pre>`;
  } catch (e) {
    el.innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
}

async function runUpdate() {
  if (!await customConfirm('Update Hermes? This may take a minute.')) return;
  const el = document.getElementById('update-result');
  el.innerHTML = '<div class="loading">Updating...</div>';
  try {
    const csrfToken = state.csrfToken || '';
    const res = await api('/api/update', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
    });
    el.innerHTML = `<pre style="font-size:11px;white-space:pre-wrap;color:var(--fg-muted);">${escapeHtml(res.output || 'Update started')}</pre>`;
    showToast('Hermes update started', 'success');
  } catch (e) {
    el.innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
}

async function showCreateAgent() {
  const result = await showModal({
    title: 'Create Agent',
    message: 'Create a new Hermes profile.',
    inputs: [
      { placeholder: 'Agent name (e.g. worker, analyst)', type: 'text' },
    ],
    buttons: [
      { text: 'Cancel', value: null },
      { text: 'Create Fresh', primary: true, value: 'fresh' },
      { text: 'Clone From...', value: 'clone_from' },
    ],
  });

  if (!result || result.action === null) return;

  const name = result.inputs[0] || '';
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
  if (!safeName) {
    await customAlert('Invalid name. Use letters, numbers, hyphens, underscores.', 'Error');
    return;
  }

  let body = { name: safeName };

  if (result.action === 'clone_from') {
    const sourceResult = await showModal({
      title: 'Clone From',
      message: 'Enter profile name to clone from:',
      inputs: [{ placeholder: 'Source profile (e.g. david)', value: 'david' }],
      buttons: [
        { text: 'Cancel', value: null },
        { text: 'Clone', primary: true, value: 'ok' },
      ],
    });
    if (!sourceResult || sourceResult.action === null) return;
    const source = sourceResult.inputs[0] || 'david';
    body.cloneArg = '--clone-from';
    body.cloneSource = source;
  }

  try {
    const csrfToken = state.csrfToken || '';
    const res = await api('/api/profiles/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      showToast(`Agent ${safeName} created!`, 'success');
      loadAgents(document.querySelector('.page.active'));
    } else {
      await customAlert(res.error || 'Failed to create agent', 'Error');
    }
  } catch (e) {
    await customAlert(e.message, 'Error');
  }
}

async function showCreateUser() {
  const result = await showModal({
    title: 'Create User',
    message: 'Create a new HCI user account.',
    inputs: [
      { placeholder: 'Username' },
      { placeholder: 'Password (min 8 chars)', type: 'password' },
      { placeholder: 'Role (admin/viewer)', value: 'viewer' },
    ],
    buttons: [
      { text: 'Cancel', value: null },
      { text: 'Create', primary: true, value: 'ok' },
    ],
  });
  if (!result || result.action === null) return;
  const [username, password, role] = result.inputs;
  if (!username || !password || !role) {
    await customAlert('All fields required', 'Error');
    return;
  }
  createUser(username, password, role);
}

async function createUser(username, password, role) {
  try {
    const csrfToken = state.csrfToken || '';
    const res = await api('/api/users', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ username, password, role }),
    });
    if (res.ok) {
      showToast(`User ${username} created`, 'success');
      loadUsers();
    } else {
      showToast(`Failed: ${res.error}`, 'error');
    }
  } catch (e) {
    showToast(`Failed: ${e.message}`, 'error');
  }
}

// ============================================
// Notifications
// ============================================
async function fetchNotifications() {
  try {
    const res = await api('/api/notifications');
    if (res.ok && res.notifications) {
      state.notifications = res.notifications;
      updateNotifBadge();
    }
  } catch {}
}

function updateNotifBadge() {
  const badge = document.getElementById('notif-badge');
  const unread = state.notifications.filter((n) => !n.dismissed).length;
  if (unread > 0) {
    badge.textContent = unread > 99 ? '99+' : unread;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function startNotifPolling() {
  if (state.notifInterval) clearInterval(state.notifInterval);
  fetchNotifications();
  state.notifInterval = setInterval(fetchNotifications, 30000);
}

// ============================================
// API Helper
// ============================================
async function api(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  return res.json();
}

// ============================================
// Toast Notifications
// ============================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container') || createToastContainer();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function createToastContainer() {
  const el = document.createElement('div');
  el.id = 'toast-container';
  el.style.cssText = 'position:fixed;top:70px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;';
  document.body.appendChild(el);
  return el;
}

// ============================================
// Event Listeners
// ============================================
function init() {
  // Theme
  initTheme();
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);

  // Nav
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(link.dataset.page);
    });
  });

  // User menu
  document.getElementById('user-btn')?.addEventListener('click', () => {
    const dropdown = document.getElementById('user-dropdown');
    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
  });

  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    state.user = null;
    if (state.notifInterval) clearInterval(state.notifInterval);
    showLogin();
  });

  // Password modal
  document.getElementById('change-password-btn')?.addEventListener('click', () => {
    document.getElementById('user-dropdown').style.display = 'none';
    document.getElementById('password-modal').style.display = 'flex';
  });

  document.getElementById('password-cancel')?.addEventListener('click', () => {
    document.getElementById('password-modal').style.display = 'none';
    document.getElementById('password-error').textContent = '';
  });

  document.getElementById('password-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const current = document.getElementById('current-password').value;
    const newPass = document.getElementById('new-password').value;
    const confirm = document.getElementById('confirm-new-password').value;
    const errorEl = document.getElementById('password-error');

    if (newPass !== confirm) {
      errorEl.textContent = 'Passwords do not match';
      return;
    }
    if (newPass.length < 8) {
      errorEl.textContent = 'Password must be at least 8 characters';
      return;
    }

    try {
      const res = await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password: current, new_password: newPass }),
      });
      if (res.ok) {
        document.getElementById('password-modal').style.display = 'none';
        errorEl.textContent = '';
        document.getElementById('current-password').value = '';
        document.getElementById('new-password').value = '';
        document.getElementById('confirm-new-password').value = '';
      } else {
        errorEl.textContent = res.error || 'Failed to change password';
      }
    } catch {
      errorEl.textContent = 'Connection error';
    }
  });

  // Notifications
  document.getElementById('notif-btn')?.addEventListener('click', () => {
    const dropdown = document.getElementById('notif-dropdown');
    const isVisible = dropdown.style.display !== 'none';
    dropdown.style.display = isVisible ? 'none' : 'block';

    if (!isVisible) {
      // Render notifications
      const listEl = document.getElementById('notif-list');
      const unread = state.notifications.filter(n => !n.dismissed);
      if (unread.length === 0) {
        listEl.innerHTML = '<div class="notif-empty">No notifications</div>';
      } else {
        listEl.innerHTML = unread.map(n => `
          <div class="notif-item notif-${n.type || 'info'}" style="padding:8px;border-bottom:1px solid var(--border);font-size:11px;">
            <div style="color:var(--fg);">${escapeHtml(n.message || '')}</div>
            <div style="color:var(--fg-subtle);font-size:10px;margin-top:2px;">${n.timestamp ? new Date(n.timestamp).toLocaleString() : ''}</div>
          </div>
        `).join('');
      }
    }
  });

  document.getElementById('notif-clear')?.addEventListener('click', async () => {
    await api('/api/notifications/clear', { method: 'POST' });
    state.notifications = [];
    updateNotifBadge();
    document.getElementById('notif-list').innerHTML = '<div class="notif-empty">No notifications</div>';
  });

  // Close dropdowns on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.user-menu')) {
      document.getElementById('user-dropdown').style.display = 'none';
    }
    if (!e.target.closest('#notif-btn') && !e.target.closest('#notif-dropdown')) {
      document.getElementById('notif-dropdown').style.display = 'none';
    }
  });

  // Hash routing
  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.slice(1) || 'home';
    const [page, ...rest] = hash.split('/');
    const params = rest.length ? { name: rest[0] } : {};
    navigate(page, params);
  });

  // Init
  checkAuth();
}

// ============================================
// Custom Modals (replace browser alert/confirm/prompt)
// ============================================
function showModal({ title, message, inputs = [], buttons = [] }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } };

    let inputsHtml = inputs.map((inp, i) =>
      `<input class="modal-input" id="modal-input-${i}" type="${inp.type || 'text'}" placeholder="${inp.placeholder || ''}" value="${inp.value || ''}" autocomplete="off" />`
    ).join('');

    let buttonsHtml = buttons.map((btn, i) =>
      `<button class="btn ${btn.primary ? 'btn-primary' : 'btn-ghost'}" id="modal-btn-${i}">${btn.text}</button>`
    ).join('');

    overlay.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${title}</div>
        ${message ? `<div class="modal-message">${message}</div>` : ''}
        ${inputsHtml}
        <div class="modal-actions">${buttonsHtml}</div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Focus first input
    const firstInput = overlay.querySelector('.modal-input');
    if (firstInput) setTimeout(() => firstInput.focus(), 50);

    // Handle buttons — capture input values before closing
    buttons.forEach((btn, i) => {
      document.getElementById(`modal-btn-${i}`)?.addEventListener('click', () => {
        const inputValues = inputs.map((_, j) => document.getElementById(`modal-input-${j}`)?.value || '');
        overlay.remove();
        resolve({
          action: btn.value !== undefined ? btn.value : true,
          inputs: inputValues,
        });
      });
    });
  });
}

async function customAlert(message, title = 'Notice') {
  await showModal({ title, message, buttons: [{ text: 'OK', primary: true }] });
}

async function customConfirm(message, title = 'Confirm') {
  const result = await showModal({
    title,
    message,
    buttons: [
      { text: 'Cancel', value: false },
      { text: 'Confirm', primary: true, value: true },
    ],
  });
  return result?.action === true;
}

async function customPrompt(message, defaultValue = '', title = 'Input') {
  const result = await showModal({
    title,
    message,
    inputs: [{ placeholder: message, value: defaultValue }],
    buttons: [
      { text: 'Cancel', value: null },
      { text: 'OK', primary: true, value: 'ok' },
    ],
  });
  if (!result || result.action === null) return null;
  return result.inputs[0] || '';
}

// ============================================
// Export functions to window for onclick handlers
// ============================================
Object.assign(window, {
  navigate,
  toggleTheme,
  loadHome,
  loadAgents,
  loadAgentDetail,
  loadAgentSessions,
  loadAgentGateway,
  loadAgentConfig,
  loadAgentMemory,
  loadMonitor,
  loadSkills,
  loadMaintenance,
  setAgentDefault,
  resumeSession,
  openTerminalPanel,
  renameSession,
  exportSession,
  deleteSession,
  gatewayAction,
  loadGatewayLogs,
  loadSessionStats,
  runDoctor,
  runDump,
  runUpdate,
  showCreateAgent,
  showCreateUser,
  createUser,
  deleteUser,
  deleteAgent,
  loadUsers,
  loadAuth,
  loadAudit,
  showToast,
  escapeHtml,
  customAlert,
  customConfirm,
  customPrompt,
  showModal,
});

// Start
init();
