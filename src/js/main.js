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
  notifFailCount: 0,
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
    // First check auth status (no 401 — public endpoint)
    const statusRes = await fetch('/api/auth/status');
    const statusData = await statusRes.json();

    if (statusData.first_run) {
      showSetup();
      return false;
    }

    // If not first run, try authenticated endpoint
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      state.user = data.user;
      state.csrfToken = data.csrfToken;
      showApp();
      return true;
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
      case 'usage':
        await loadUsage(container);
        break;
      case 'skills':
        await loadSkills(container);
        break;
      case 'maintenance':
        await loadMaintenance(container);
        break;
      case 'files':
        await loadFileExplorer(container);
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
      <div style="display:flex;gap:8px;">
        <button class="btn btn-primary" onclick="openTerminalPanel('Hermes CLI', '')">⌘ Terminal</button>
        <button class="btn btn-ghost" onclick="loadHome(document.querySelector('.page.active'))">↻ Refresh</button>
      </div>
    </div>
    <div class="card-grid" id="home-cards">
      <div class="card"><div class="card-title">System Health</div><div class="loading">Loading</div></div>
      <div class="card"><div class="card-title">Agent Overview</div><div class="loading">Loading</div></div>
    </div>
    <div class="card-grid" id="home-bottom" style="margin-top:16px;">
      <div class="card"><div class="card-title">Gateways</div><div class="loading">Loading</div></div>
      <div class="card"><div class="card-title">Token Usage (7d)</div><div class="loading">Loading</div></div>
    </div>
  `;

  try {
    const [healthRes, profilesRes, agentRes, cronRes] = await Promise.all([
      api('/api/system/health'),
      api('/api/profiles'),
      api('/api/agent/status'),
      api('/api/cron/list', { method: 'POST', body: '{}' }),
    ]);

    // Row 1: System Health + Agent Overview (merged)
    const cardsEl = document.getElementById('home-cards');
    if (healthRes.ok) {
      cardsEl.innerHTML = `
        <div class="card">
          <div class="card-title">System Health</div>
          <div class="stat-row"><span class="stat-label">CPU</span><span class="stat-value">${healthRes.cpu || 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">RAM</span><span class="stat-value">${healthRes.ram || 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">Disk</span><span class="stat-value">${healthRes.disk || 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">Uptime</span><span class="stat-value">${healthRes.uptime || 'N/A'}</span></div>
        </div>
        <div class="card">
          <div class="card-title">Agent Overview</div>
          <div class="stat-row"><span class="stat-label">Model</span><span class="stat-value">${agentRes.ok ? (agentRes.model || 'N/A') : 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">Provider</span><span class="stat-value">${agentRes.ok ? (agentRes.provider || 'N/A') : 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">Gateway</span><span class="stat-value ${agentRes.ok && agentRes.gatewayStatus?.includes('running') ? 'status-ok' : 'status-off'}">${agentRes.ok ? (agentRes.gatewayStatus || 'N/A') : 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">API Keys</span><span class="stat-value">${agentRes.ok ? `${agentRes.apiKeys?.active || 0}/${agentRes.apiKeys?.total || 0} active` : 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">Platforms</span><span class="stat-value">${agentRes.ok ? (agentRes.platforms?.filter(p => p.configured).map(p => p.name).join(', ') || 'None') : 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">Cron</span><span class="stat-value">${cronRes?.jobs?.length || 0} jobs</span></div>
          <div class="stat-row"><span class="stat-label">Sessions</span><span class="stat-value">${agentRes.ok ? `${agentRes.activeSessions || 0} active` : 'N/A'}</span></div>
        </div>
      `;
    }

    // Row 2: Gateways + Token Usage
    const bottomEl = document.getElementById('home-bottom');
    const profiles = profilesRes.ok && profilesRes.profiles ? profilesRes.profiles : [];
    const gwHtml = profiles.map(p => {
      const cls = p.gateway === 'running' ? 'status-ok' : 'status-off';
      const txt = p.gateway === 'running' ? '● running' : '○ stopped';
      return `<div class="stat-row"><span class="stat-label">${p.name}</span><span class="stat-value ${cls}">${txt}</span></div>`;
    }).join('');

    bottomEl.innerHTML = `
      <div class="card">
        <div class="card-title">Gateways</div>
        ${gwHtml || '<div class="stat-row"><span class="stat-label">No profiles</span></div>'}
      </div>
      <div class="card">
        <div class="card-title">Token Usage (7d)</div>
        <div id="home-token-usage"><div class="loading">Loading...</div></div>
      </div>
    `;
    loadTokenUsage('home-token-usage', 7);

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
        ${d.models && d.models.length > 0 ? `
          <div style="margin-top:8px;font-size:10px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:0.06em;">Models</div>
          ${d.models.slice(0, 3).map(m => `
            <div class="stat-row">
              <span class="stat-label">${m.name}</span>
              <span class="stat-value">${m.tokens} tokens</span>
            </div>
          `).join('')}
        ` : ''}
        ${d.platforms && d.platforms.length > 0 ? `
          <div style="margin-top:8px;font-size:10px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:0.06em;">Platforms</div>
          ${d.platforms.slice(0, 4).map(p => `
            <div class="stat-row">
              <span class="stat-label">${p.name}</span>
              <span class="stat-value">${p.tokens} tokens</span>
            </div>
          `).join('')}
        ` : ''}
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
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost" onclick="openTerminalPanel('Setup ${name}', 'hermes -p ${name} setup')">⚙ Setup</button>
        <button class="btn btn-primary" onclick="openTerminalPanel('Terminal ${name}', 'hermes -p ${name}')">⌘ Terminal</button>
        <button class="btn btn-ghost" onclick="navigate('agents')">← Back</button>
      </div>
    </div>
    <div class="tabs" id="agent-tabs">
      <button class="tab active" data-tab="dashboard">Dashboard</button>
      <button class="tab" data-tab="sessions">Sessions</button>
      <button class="tab" data-tab="gateway">Gateway</button>
      <button class="tab" data-tab="config">Config</button>
      <button class="tab" data-tab="memory">Memory</button>
      <button class="tab" data-tab="cron">Cron</button>
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
      case 'cron': await loadAgentCron(content, profileName); break;
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
      <input type="text" id="session-search" class="search-input" placeholder="Search sessions..." style="flex:1;width:auto;" />
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
      state.currentSessions = [];
      return;
    }

    const sessions = res.sessions;
    state.currentSessions = sessions;

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
                      <button class="btn btn-ghost btn-sm" onclick="renameSession('${s.id}', '${name}')" title="Rename">✎</button>
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
      <div class="terminal-controls">
        <span class="terminal-touch-btn" onclick="terminalKey('ArrowUp')" title="Up">↑</span>
        <span class="terminal-touch-btn" onclick="terminalKey('ArrowDown')" title="Down">↓</span>
        <span class="terminal-touch-btn" onclick="terminalKey(' ')" title="Space">␣</span>
        <span class="terminal-touch-btn" onclick="terminalKey('Enter')" title="Enter">↵</span>
        <span class="terminal-btn" id="terminal-fullscreen" onclick="toggleTerminalFullscreen()">⛶</span>
        <span class="terminal-close" onclick="document.getElementById('main').style.bottom='0'; this.closest('.terminal-panel').remove()">×</span>
      </div>
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
    await loadScript('/vendor/xterm-addon-fit/lib/addon-fit.js');

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', monospace",
      theme: {
        background: '#0b201f',
        foreground: '#dccbb5',
        cursor: '#7c945c',
        selectionBackground: 'rgba(124, 148, 92, 0.3)',
      },
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(bodyEl);
    fitAddon.fit();
    term._fitAddon = fitAddon;
    termInstance = term;

    term.write('Connecting...\r\n');

    // Ensure terminal session exists
    try {
      await api('/api/terminal/ensure', { method: 'POST' });
    } catch {}

    // Connect WebSocket
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProtocol}//${location.host}/ws`);
    termWs = ws;

    let commandSent = false;

    ws.onopen = () => {
      term.write('Connected.\r\n');
      // Send command after delay (wait for PTY ready)
      setTimeout(() => {
        if (command && !commandSent) {
          // Step 1: Ctrl+C to cancel any running command
          ws.send(JSON.stringify({ type: 'terminal-input', data: '\x03' }));
          setTimeout(() => {
            // Step 2: Clear terminal
            ws.send(JSON.stringify({ type: 'terminal-input', data: 'clear\r' }));
            setTimeout(() => {
              // Step 3: Run actual command
              term.write(`\x1b[90m$ ${command}\x1b[0m\r\n`);
              ws.send(JSON.stringify({ type: 'terminal-input', data: command + '\r' }));
              commandSent = true;
            }, 500);
          }, 500);
        }
      }, 2000);
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

    ws.onerror = () => {
      term.write('\r\n[WebSocket error]\r\n');
    };

    ws.onclose = () => {
      term.write('\r\n[Connection closed]\r\n');
    };

    // Send user input
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'terminal-input', data }));
      }
    });

    // Resize handler
    const resizeHandler = () => {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'terminal-resize', cols: term.cols, rows: term.rows }));
      }
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

async function renameSession(sessionId, profileName) {
  // Find current title from stored sessions
  const session = (state.currentSessions || []).find(s => s.id === sessionId);
  const currentTitle = session?.title || '';
  const newTitle = await customPrompt('New session title:', currentTitle);
  if (newTitle === null || newTitle === currentTitle) return;
  try {
    const csrfToken = state.csrfToken || '';
    const agent = profileName || state.currentAgent;
    await api(`/api/sessions/${sessionId}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ title: newTitle, profile: agent }),
    });
    showToast('Session renamed', 'success');
    setTimeout(() => loadAgentSessions(document.getElementById('agent-tab-content'), agent), 2000);
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
    const profile = profileName || state.currentAgent;
    await api(`/api/sessions/${sessionId}?profile=${encodeURIComponent(profile)}`, {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': csrfToken },
    });
    showToast('Session deleted', 'success');
    setTimeout(() => loadAgentSessions(document.getElementById('agent-tab-content'), profileName), 2000);
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
          <select id="log-level" class="log-level-select" style="margin-left:auto;">
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
          ${categories.map((c, i) => `<button class="tab ${i === 0 ? 'active' : ''}" data-cat="${c.key}">${c.label}</button>`).join('')}
          <button class="tab" data-cat="raw">Raw YAML</button>
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

// ============================================
// Cron Tab (per-profile, hermes cron CLI)
// ============================================
async function loadAgentCron(container, name) {
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <div style="display:flex;gap:8px;align-items:center;">
        <span id="cron-scheduler-status" class="badge">loading...</span>
        <span style="font-size:11px;color:var(--fg-muted);">Scheduler</span>
      </div>
      <button class="btn btn-primary btn-sm" onclick="showCreateCronModal('${name}')">+ Create Job</button>
    </div>
    <div id="cron-list"><div class="loading">Loading cron jobs...</div></div>
  `;
  await loadCronJobs(name);
}

async function loadCronJobs(profile) {
  const el = document.getElementById('cron-list');
  const statusEl = document.getElementById('cron-scheduler-status');
  try {
    const res = await api('/api/hermes-cron/' + encodeURIComponent(profile));
    if (!res.ok) { el.innerHTML = '<div class="error-msg">' + (res.error || 'Failed') + '</div>'; return; }
    if (statusEl) {
      statusEl.textContent = res.schedulerRunning ? '\u25CF running' : '\u25CB stopped';
      statusEl.className = 'badge ' + (res.schedulerRunning ? 'status-ok' : 'status-off');
    }
    const jobs = res.jobs || [];
    if (jobs.length === 0) { el.innerHTML = '<div class="card"><div class="card-title">No cron jobs</div></div>'; return; }
    el.innerHTML = '<table class="data-table"><thead><tr><th>Name</th><th>Schedule</th><th>Status</th><th>Next Run</th><th>Actions</th></tr></thead><tbody>' + jobs.map(function(j) {
      var sc = j.status === 'active' ? 'status-ok' : j.status === 'paused' ? 'status-off' : '';
      var nr = j.nextRun ? new Date(j.nextRun).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '\u2014';
      var act = j.status === 'active'
        ? '<button class="btn btn-ghost btn-sm" onclick="cronAction(\''+profile+'\',\''+j.id+'\',\'pause\')" title="Pause">\u23F8</button> <button class="btn btn-ghost btn-sm" onclick="cronAction(\''+profile+'\',\''+j.id+'\',\'run\')" title="Run">\u25B6</button>'
        : '<button class="btn btn-ghost btn-sm" onclick="cronAction(\''+profile+'\',\''+j.id+'\',\'resume\')" title="Resume">\u23F5</button>';
      return '<tr><td>'+(j.name||j.id)+'</td><td><code style="font-size:11px;">'+j.schedule+'</code></td><td><span class="badge '+sc+'">'+j.status+'</span></td><td style="font-size:11px;color:var(--fg-muted);">'+nr+'</td><td style="display:flex;gap:4px;">'+act+'<button class="btn btn-ghost btn-sm btn-danger" onclick="cronRemove(\''+profile+'\',\''+j.id+'\',\''+(j.name||j.id).replace(/'/g, "\\'")+'\')" title="Remove">\u00D7</button></td></tr>';
    }).join('') + '</tbody></table>';
  } catch (e) { el.innerHTML = '<div class="error-msg">'+e.message+'</div>'; }
}

async function cronAction(profile, jobId, action) {
  try {
    await api('/api/hermes-cron/' + encodeURIComponent(profile) + '/' + jobId + '/' + action, { method: 'POST', headers: { 'X-CSRF-Token': state.csrfToken || '' } });
    showToast('Job ' + action + 'd', 'success');
    setTimeout(function() { loadCronJobs(profile); }, 500);
  } catch (e) { showToast(action + ' failed: ' + e.message, 'error'); }
}

async function cronRemove(profile, jobId, name) {
  if (!await customConfirm('Remove job "' + name + '"?')) return;
  try {
    await api('/api/hermes-cron/' + encodeURIComponent(profile) + '/' + jobId + '/remove', { method: 'POST', headers: { 'X-CSRF-Token': state.csrfToken || '' } });
    showToast('Job removed', 'success');
    setTimeout(function() { loadCronJobs(profile); }, 500);
  } catch (e) { showToast('Remove failed: ' + e.message, 'error'); }
}

function showCreateCronModal(profile) {
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = '<div class="modal-card" style="width:500px;max-width:90vw;"><div class="modal-title">Create Cron Job</div><form id="cron-create-form"><div style="margin-bottom:12px;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Name</label><input type="text" id="cron-name" placeholder="e.g. Daily health check" style="width:100%;padding:8px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg);font-family:var(--font);font-size:12px;" /></div><div style="margin-bottom:12px;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Schedule</label><div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;"><button type="button" class="btn btn-ghost btn-sm cron-preset" data-val="5m">5m</button><button type="button" class="btn btn-ghost btn-sm cron-preset" data-val="15m">15m</button><button type="button" class="btn btn-ghost btn-sm cron-preset" data-val="30m">30m</button><button type="button" class="btn btn-ghost btn-sm cron-preset" data-val="1h">1h</button><button type="button" class="btn btn-ghost btn-sm cron-preset" data-val="6h">6h</button><button type="button" class="btn btn-ghost btn-sm cron-preset" data-val="12h">12h</button><button type="button" class="btn btn-ghost btn-sm cron-preset" data-val="daily">daily</button></div><input type="text" id="cron-schedule" placeholder="e.g. every 30m or 0 9 * * *" style="width:100%;padding:8px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg);font-family:var(--font);font-size:12px;" required /></div><div style="margin-bottom:12px;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Prompt (task instruction)</label><textarea id="cron-prompt" rows="3" placeholder="Check system health and report" style="width:100%;resize:vertical;font-family:var(--font);font-size:12px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg);padding:8px;"></textarea></div><div style="display:flex;gap:8px;margin-bottom:12px;"><div style="flex:1;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Deliver</label><select id="cron-deliver" class="log-level-select" style="width:100%;"><option value="origin">origin</option><option value="local">local</option><option value="telegram">telegram</option><option value="discord">discord</option><option value="slack">slack</option><option value="whatsapp">whatsapp</option><option value="signal">signal</option><option value="matrix">matrix</option><option value="mattermost">mattermost</option><option value="email">email</option><option value="sms">sms</option><option value="homeassistant">homeassistant</option><option value="dingtalk">dingtalk</option><option value="feishu">feishu</option><option value="wecom">wecom</option><option value="weixin">weixin</option><option value="bluebubbles">bluebubbles</option></select></div><div style="flex:1;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Repeat</label><select id="cron-repeat" class="log-level-select" style="width:100%;"><option value="">forever</option><option value="1">once</option><option value="5">5 times</option><option value="10">10 times</option><option value="50">50 times</option></select></div></div><div class="modal-actions"><button type="button" class="btn btn-ghost" id="cron-cancel">Cancel</button><button type="submit" class="btn btn-primary">Create Job</button></div></form></div>';
  document.body.appendChild(overlay);
  overlay.querySelectorAll('.cron-preset').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.getElementById('cron-schedule').value = btn.dataset.val;
      overlay.querySelectorAll('.cron-preset').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
    });
  });
  overlay.querySelector('#cron-cancel').addEventListener('click', function() { overlay.remove(); });
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#cron-create-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var schedule = document.getElementById('cron-schedule').value.trim();
    var prompt = document.getElementById('cron-prompt').value.trim();
    var name = document.getElementById('cron-name').value.trim();
    var deliver = document.getElementById('cron-deliver').value;
    var repeat = document.getElementById('cron-repeat').value;
    if (!schedule) { showToast('Schedule required', 'error'); return; }
    if (!prompt) { showToast('Prompt required', 'error'); return; }
    try {
      var res = await api('/api/hermes-cron/' + encodeURIComponent(profile) + '/create', {
        method: 'POST',
        headers: { 'X-CSRF-Token': state.csrfToken || '' },
        body: JSON.stringify({ schedule: schedule, prompt: prompt, name: name, deliver: deliver, repeat: repeat }),
      });
      if (res.ok) { showToast('Cron job created', 'success'); overlay.remove(); setTimeout(function() { loadCronJobs(profile); }, 500); }
      else { showToast(res.error || 'Create failed', 'error'); }
    } catch (err) { showToast('Create failed: ' + err.message, 'error'); }
  });
}


async function loadUsage(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Usage & Analytics</div>
        <div class="page-subtitle">Token usage, costs, and activity breakdown</div>
      </div>
      <div style="display:flex;gap:8px;">
        <select id="usage-days" class="log-level-select">
          <option value="1">Today</option>
          <option value="7" selected>7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
        </select>
        <select id="usage-agent" class="log-level-select">
          <option value="">All agents</option>
        </select>
        <button class="btn btn-ghost" onclick="loadUsage(document.querySelector('.page.active'))">↻ Refresh</button>
      </div>
    </div>
    <div class="card-grid" id="usage-overview">
      <div class="card"><div class="card-title">Overview</div><div class="loading">Loading</div></div>
      <div class="card"><div class="card-title">Models</div><div class="loading">Loading</div></div>
      <div class="card"><div class="card-title">Platforms</div><div class="loading">Loading</div></div>
    </div>
    <div class="card-grid" id="usage-tools" style="margin-top:16px;">
      <div class="card"><div class="card-title">Top Tools</div><div class="loading">Loading</div></div>
    </div>
  `;

  try {
    // Load profiles for agent filter dropdown
    const profilesRes = await api('/api/profiles');
    const agentSelect = document.getElementById('usage-agent');
    if (profilesRes.ok && profilesRes.profiles) {
      profilesRes.profiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        agentSelect.appendChild(opt);
      });
    }

    // Fetch usage data
    await fetchUsageData();

    // Bind filter change → auto-refresh
    ['usage-days', 'usage-agent'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', fetchUsageData);
    });

    // Refresh button — uses current filter values
    document.querySelector('[onclick*="loadUsage"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      fetchUsageData();
    });

  } catch (e) {
    document.getElementById('usage-overview').innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${e.message}</div></div>`;
  }
}

async function fetchUsageData() {
  const days = document.getElementById('usage-days')?.value || '7';
  const agent = document.getElementById('usage-agent')?.value || '';
  const query = agent ? `?profile=${agent}` : '';
  const res = await api(`/api/usage/${days}${query}`);

  if (!res.ok) {
    document.getElementById('usage-overview').innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${res.error || 'Failed to load'}</div></div>`;
    return;
  }

  const d = res;

  // Overview card
  const overviewEl = document.getElementById('usage-overview');
  overviewEl.innerHTML = `
    <div class="card">
      <div class="card-title">Overview ${d.period ? '(' + d.period + ')' : ''}</div>
      <div class="stat-row"><span class="stat-label">Sessions</span><span class="stat-value">${d.sessions}</span></div>
      <div class="stat-row"><span class="stat-label">Messages</span><span class="stat-value">${(d.messages || 0).toLocaleString()}</span></div>
      <div class="stat-row"><span class="stat-label">Input tokens</span><span class="stat-value">${formatNumber(d.inputTokens)}</span></div>
      <div class="stat-row"><span class="stat-label">Output tokens</span><span class="stat-value">${formatNumber(d.outputTokens)}</span></div>
      <div class="stat-row"><span class="stat-label">Total tokens</span><span class="stat-value">${formatNumber(d.totalTokens)}</span></div>
      <div class="stat-row"><span class="stat-label">Est. cost</span><span class="stat-value">${d.cost || '$0.00'}</span></div>
      <div class="stat-row"><span class="stat-label">Active time</span><span class="stat-value">${d.activeTime || '—'}</span></div>
      <div class="stat-row"><span class="stat-label">Avg session</span><span class="stat-value">${d.avgSession || '—'}</span></div>
    </div>
    <div class="card">
      <div class="card-title">Models</div>
      ${d.models && d.models.length > 0 ? d.models.map(m => `
        <div class="stat-row">
          <span class="stat-label">${m.name}</span>
          <span class="stat-value">${m.sessions} sess · ${m.tokens} tokens</span>
        </div>
      `).join('') : '<div class="stat-row"><span class="stat-label">No data</span></div>'}
    </div>
    <div class="card">
      <div class="card-title">Platforms</div>
      ${d.platforms && d.platforms.length > 0 ? d.platforms.map(p => `
        <div class="stat-row">
          <span class="stat-label">${p.name}</span>
          <span class="stat-value">${p.sessions} sess · ${p.tokens} tokens</span>
        </div>
      `).join('') : '<div class="stat-row"><span class="stat-label">No data</span></div>'}
    </div>
  `;

  // Top Tools card
  const toolsEl = document.getElementById('usage-tools');
  toolsEl.innerHTML = `
    <div class="card">
      <div class="card-title">Top Tools</div>
      ${d.topTools && d.topTools.length > 0 ? d.topTools.map(t => `
        <div class="stat-row">
          <span class="stat-label">${t.name}</span>
          <span class="stat-value">${t.calls} calls (${t.pct})</span>
        </div>
      `).join('') : '<div class="stat-row"><span class="stat-label">No data</span></div>'}
    </div>
  `;
}

async function loadSkills(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Skills Marketplace</div>
        <div class="page-subtitle">Browse and manage installed skills</div>
      </div>
      <div style="display:flex;gap:8px;">
        <input type="text" id="skills-search" class="search-input" placeholder="Search skills..." />
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
                <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
                  ${s.source ? `<span class="badge" style="font-size:10px;">${s.source}</span>` : ''}
                  ${s.trust ? `<span class="badge" style="font-size:10px;opacity:0.7;">${s.trust}</span>` : ''}
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
        <div id="doctor-result" style="margin-top:8px;max-height:500px;overflow-y:auto;"></div>
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
    if (res.ok && res.entries && res.entries.length > 0) {
      el.innerHTML = res.entries.slice(0, 10).map(line => {
        // Parse: [timestamp] [user] [role] ACTION: details
        const match = line.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.+)$/);
        if (match) {
          const [, ts, user, role, action] = match;
          const time = new Date(ts).toLocaleString();
          const isDenied = action.includes('DENIED');
          return `<div style="font-size:11px;padding:3px 0;color:${isDenied ? 'var(--red)' : 'var(--fg-muted)'};">
            <span style="color:var(--fg-subtle);">${time}</span>
            <span style="color:var(--accent);margin:0 4px;">${user}</span>
            ${action}
          </div>`;
        }
        return `<div style="font-size:11px;padding:2px 0;color:var(--fg-muted);">${escapeHtml(line)}</div>`;
      }).join('');
    } else {
      el.innerHTML = '<div class="stat-row"><span class="stat-label">No audit entries</span></div>';
    }
  } catch {
    document.getElementById('audit-log').innerHTML = '<div class="stat-row"><span class="stat-label">Audit unavailable</span></div>';
  }
}

function parseDoctorOutput(raw) {
  const lines = raw.split(/\r?\n/);
  const sections = [];
  let current = null;
  let totalPass = 0, totalFail = 0, totalWarn = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip header box
    if (/^[┌└─│┐┘]+$/.test(trimmed)) continue;
    if (/🩺/.test(trimmed)) continue;
    // Empty line flushes current section
    if (!trimmed) { if (current && current.items.length) { sections.push(current); current = null; } continue; }
    // Section header: ◆ Name
    const secMatch = trimmed.match(/^◆\s+(.+)/);
    if (secMatch) {
      if (current && current.items.length) sections.push(current);
      current = { name: secMatch[1], items: [] };
      continue;
    }
    if (!current) continue;
    // Item: ✓ pass, ✗ fail, ⚠ warning
    const itemMatch = trimmed.match(/^([✓✗⚠])\s+(.+)/);
    if (itemMatch) {
      const status = itemMatch[1] === '✓' ? 'pass' : itemMatch[1] === '✗' ? 'fail' : 'warn';
      if (status === 'pass') totalPass++;
      else if (status === 'fail') totalFail++;
      else totalWarn++;
      current.items.push({ status, text: itemMatch[2], suggestion: null });
      continue;
    }
    // Suggestion: → text
    const sugMatch = trimmed.match(/^→\s+(.+)/);
    if (sugMatch && current.items.length) {
      current.items[current.items.length - 1].suggestion = sugMatch[1];
      continue;
    }
  }
  if (current && current.items.length) sections.push(current);
  return { sections, totalPass, totalFail, totalWarn };
}

function renderDoctorOutput(raw) {
  const { sections, totalPass, totalFail, totalWarn } = parseDoctorOutput(raw);
  const total = totalPass + totalFail + totalWarn;
  if (!sections.length) return `<pre style="font-size:11px;white-space:pre-wrap;color:var(--fg-muted);">${escapeHtml(raw)}</pre>`;

  const statusIcon = (s) => s === 'pass' ? '✓' : s === 'fail' ? '✗' : '⚠';
  const statusClass = (s) => s === 'pass' ? 'doctor-pass' : s === 'fail' ? 'doctor-fail' : 'doctor-warn';

  let html = '';

  // Summary bar
  html += `<div class="doctor-summary">`;
  html += `<div class="doctor-summary-item doctor-pass"><span class="doctor-dot"></span>${totalPass} passed</div>`;
  if (totalWarn) html += `<div class="doctor-summary-item doctor-warn"><span class="doctor-dot"></span>${totalWarn} warnings</div>`;
  if (totalFail) html += `<div class="doctor-summary-item doctor-fail"><span class="doctor-dot"></span>${totalFail} failed</div>`;
  html += `<div class="doctor-summary-total">${total} checks</div>`;
  html += `</div>`;

  // Sections
  for (const sec of sections) {
    const hasFail = sec.items.some(i => i.status === 'fail');
    const hasWarn = sec.items.some(i => i.status === 'warn');
    const secStatus = hasFail ? 'fail' : hasWarn ? 'warn' : 'pass';
    html += `<div class="doctor-section ${statusClass(secStatus)}">`;
    html += `<div class="doctor-section-header"><span class="doctor-dot"></span>${escapeHtml(sec.name)}</div>`;
    for (const item of sec.items) {
      html += `<div class="doctor-item">`;
      html += `<span class="doctor-item-icon ${statusClass(item.status)}">${statusIcon(item.status)}</span>`;
      html += `<span class="doctor-item-text">${escapeHtml(item.text)}</span>`;
      html += `</div>`;
      if (item.suggestion) {
        html += `<div class="doctor-suggestion">→ ${escapeHtml(item.suggestion)}</div>`;
      }
    }
    html += `</div>`;
  }
  return html;
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
      el.innerHTML = renderDoctorOutput(res.output);
    } else {
      el.innerHTML = `<div class="error-msg">${escapeHtml(res.output || 'No output')}</div>`;
    }
  } catch (e) {
    el.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
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
  // Pause notification polling during update to avoid false network errors
  const wasPolling = state.notifInterval;
  if (state.notifInterval) { clearInterval(state.notifInterval); state.notifInterval = null; }
  try {
    const csrfToken = state.csrfToken || '';
    const res = await api('/api/update', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
    });
    el.innerHTML = `<pre style="font-size:11px;white-space:pre-wrap;color:var(--fg-muted);">${escapeHtml(res.output || 'Update started')}</pre>`;
    showToast('Hermes update complete', 'success');
  } catch (e) {
    el.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
  } finally {
    // Resume polling after update
    if (wasPolling) startNotifPolling();
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
      state.notifFailCount = 0;
      updateNotifBadge();
    } else if (res.error === 'network' || res.error === 'rate-limited') {
      state.notifFailCount = (state.notifFailCount || 0) + 1;
      if (state.notifFailCount === 3 || state.notifFailCount === 6) startNotifPolling();
    }
  } catch {
    state.notifFailCount = (state.notifFailCount || 0) + 1;
    if (state.notifFailCount === 3 || state.notifFailCount === 6) startNotifPolling();
  }
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
  const failCount = state.notifFailCount || 0;
  const interval = failCount >= 6 ? 120000 : failCount >= 3 ? 60000 : 30000;
  state.notifInterval = setInterval(fetchNotifications, interval);
}

// ============================================
// API Helper
// ============================================
async function api(url, options = {}) {
  try {
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };
    // Add CSRF token for mutating requests
    if (state.csrfToken && options.method && options.method !== 'GET') {
      headers['X-CSRF-Token'] = state.csrfToken;
    }
    const res = await fetch(url, {
      credentials: 'include',
      ...options,
      headers,
    });
    if (res.status === 401) {
      showToast('Session expired — please log in again', 'error');
      setLocked(true);
      return { ok: false, error: 'unauthorized' };
    }
    if (res.status === 429) {
      showToast('Rate limited — slow down', 'warning');
      return { ok: false, error: 'rate-limited' };
    }
    return res.json();
  } catch (err) {
    showToast('Network error — check connection', 'error');
    return { ok: false, error: 'network' };
  }
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
      // Close mobile nav after click
      document.getElementById('nav')?.classList.remove('mobile-open');
    });
  });

  // Mobile nav toggle
  document.getElementById('nav-toggle')?.addEventListener('click', () => {
    document.getElementById('nav')?.classList.toggle('mobile-open');
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
// File Explorer
// ============================================
async function loadFileExplorer(container, dirPath = '') {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">File Explorer</div>
        <div class="page-subtitle">.hermes directory browser</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost" onclick="loadFileExplorer(document.querySelector('.page.active'), '')">⌂ Root</button>
        <button class="btn btn-ghost" onclick="loadFileExplorer(document.querySelector('.page.active'), '${dirPath}')">↻ Refresh</button>
      </div>
    </div>
    <div class="file-explorer-split">
      <div class="file-tree-panel">
        <div id="file-tree"><div class="loading">Loading...</div></div>
      </div>
      <div class="file-editor-panel" id="file-editor-panel" style="display:none;">
        <div class="file-editor-toolbar">
          <span id="file-editor-path" class="file-editor-path">Select a file</span>
          <button class="btn btn-ghost btn-sm" id="file-save-btn" style="display:none;" onclick="saveCurrentFile()">Save</button>
        </div>
        <textarea id="file-editor-text" class="file-editor-textarea" spellcheck="false" placeholder="Select a file from the tree"></textarea>
      </div>
    </div>
  `;

  // Store current dir in state
  state.fileExplorerDir = dirPath;

  try {
    const res = await api(`/api/files/list?path=${encodeURIComponent(dirPath)}`);
    const treeEl = document.getElementById('file-tree');

    if (!res.ok) {
      treeEl.innerHTML = `<div class="error-msg">${res.error || 'Failed to load'}</div>`;
      return;
    }

    // Breadcrumb
    const parts = res.path ? res.path.split('/').filter(Boolean) : [];
    let breadcrumb = `<div class="file-breadcrumb"><span class="file-link" onclick="loadFileExplorer(document.querySelector('.page.active'), '')">⌂ .hermes</span>`;
    let accum = '';
    for (const part of parts) {
      accum += '/' + part;
      breadcrumb += ` / <span class="file-link" onclick="loadFileExplorer(document.querySelector('.page.active'), '${accum.slice(1)}')">${part}</span>`;
    }
    breadcrumb += '</div>';

    // File list
    let itemsHtml = '';
    if (res.path) {
      itemsHtml += `<div class="file-item file-dir" onclick="loadFileExplorer(document.querySelector('.page.active'), '${res.parent}')"><span>📁 ..</span></div>`;
    }
    for (const item of res.items) {
      const icon = item.type === 'directory' ? '📁' : '📄';
      const size = item.type === 'file' ? ` <span class="file-meta">${formatFileSize(item.size)}</span>` : '';
      const action = item.type === 'directory'
        ? `loadFileExplorer(document.querySelector('.page.active'), '${item.path}')`
        : `openFileInEditor('${item.path}')`;
      itemsHtml += `<div class="file-item ${item.type === 'directory' ? 'file-dir' : 'file-file'}" onclick="${action}"><span>${icon} ${item.name}</span>${size}</div>`;
    }

    treeEl.innerHTML = breadcrumb + (itemsHtml || '<div class="empty">Empty directory</div>');
  } catch (e) {
    document.getElementById('file-tree').innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
}

// Open file in the editor pane (split view)
window.currentFilePath = null;
async function openFileInEditor(filePath) {
  const panel = document.getElementById('file-editor-panel');
  const textEl = document.getElementById('file-editor-text');
  const pathEl = document.getElementById('file-editor-path');
  const saveBtn = document.getElementById('file-save-btn');

  panel.style.display = 'flex';
  pathEl.textContent = filePath;
  textEl.value = 'Loading...';
  textEl.disabled = true;
  saveBtn.style.display = 'none';
  window.currentFilePath = filePath;

  try {
    const res = await api(`/api/file?path=${encodeURIComponent(filePath)}`);
    if (res && res.ok) {
      textEl.value = res.content || '(empty file)';
      textEl.disabled = false;
      saveBtn.style.display = 'inline-flex';
      // Highlight active file in tree
      document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));
      const clicked = document.querySelector(`.file-item[onclick*="${filePath}"]`);
      if (clicked) clicked.classList.add('active');
    } else {
      textEl.value = `Error: ${(res && res.error) || 'Could not read file'}\nPath: ${filePath}\n\nTroubleshooting:\n- Check server logs\n- Verify file exists: ls -la ~/.hermes/${filePath}`;
    }
  } catch (e) {
    textEl.value = `Network error: ${e.message}`;
  }
}

// Save file from editor
async function saveCurrentFile() {
  if (!window.currentFilePath) return;
  const textEl = document.getElementById('file-editor-text');
  try {
    const csrfToken = state.csrfToken || '';
    const res = await api('/api/file', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ path: window.currentFilePath, content: textEl.value }),
    });
    if (res && res.ok) {
      showToast('File saved', 'success');
    } else {
      showToast(res?.error || 'Save failed', 'error');
    }
  } catch (e) {
    showToast('Save failed: ' + e.message, 'error');
  }
}

async function loadFileContent(filePath) {
  // Redirect to split view editor
  openFileInEditor(filePath);
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return bytes + 'B';
}

// ============================================
// Terminal Touch Controls & Fullscreen
// ============================================
let termWs = null;
let termInstance = null;

function terminalKey(key) {
  if (!termWs || termWs.readyState !== 1) return;
  const keyMap = {
    'ArrowUp': '\x1b[A',
    'ArrowDown': '\x1b[B',
    'ArrowLeft': '\x1b[D',
    'ArrowRight': '\x1b[C',
    'Enter': '\r',
    ' ': ' ',
  };
  const data = keyMap[key] || key;
  termWs.send(JSON.stringify({ type: 'terminal-input', data }));
}

function toggleTerminalFullscreen() {
  const panel = document.querySelector('.terminal-panel');
  if (!panel) return;
  const isFullscreen = panel.classList.toggle('terminal-fullscreen');
  document.getElementById('terminal-fullscreen').textContent = isFullscreen ? '⊡' : '⛶';
  if (isFullscreen) {
    document.getElementById('main').style.bottom = '0';
  } else {
    document.getElementById('main').style.bottom = '45vh';
  }
  // Refit terminal
  setTimeout(() => {
    if (termInstance && termInstance._fitAddon) {
      termInstance._fitAddon.fit();
    }
  }, 100);
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
  loadUsage,
  loadSkills,
  loadMaintenance,
  loadFileExplorer,
  loadFileContent,
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
  terminalKey,
  toggleTerminalFullscreen,
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
// Expose for onclick handlers in templates
window.loadUsage = loadUsage;
window.fetchUsageData = fetchUsageData;
window.showCreateCronModal = showCreateCronModal;
window.cronAction = cronAction;
window.cronRemove = cronRemove;
window.loadCronJobs = loadCronJobs;
window.openFileInEditor = openFileInEditor;
window.saveCurrentFile = saveCurrentFile;
window.loadFileExplorer = loadFileExplorer;
window.resumeSession = resumeSession;
window.openTerminalPanel = openTerminalPanel;
window.loadHome = loadHome;
window.loadAgentDetail = loadAgentDetail;

init();
