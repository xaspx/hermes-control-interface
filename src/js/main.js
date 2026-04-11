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
      showApp();
      return true;
    }
  } catch {}
  showLogin();
  return false;
}

function showLogin() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('app').style.display = 'none';
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
      errorEl.textContent = '';
      showApp();
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
    </div>
    <div class="card-grid" id="home-cards">
      <div class="card">
        <div class="card-title">System Health</div>
        <div class="loading">Loading</div>
      </div>
      <div class="card">
        <div class="card-title">Hermes</div>
        <div class="loading">Loading</div>
      </div>
      <div class="card">
        <div class="card-title">Token Usage</div>
        <div class="loading">Loading</div>
      </div>
    </div>
  `;

  // Fetch system health
  try {
    const res = await api('/api/system/health');
    const cards = document.getElementById('home-cards');
    if (res.ok) {
      cards.innerHTML = `
        <div class="card">
          <div class="card-title">System Health</div>
          <div style="margin-top:12px;">
            <div style="margin-bottom:8px;">CPU: ${res.cpu || 'N/A'}</div>
            <div style="margin-bottom:8px;">RAM: ${res.ram || 'N/A'}</div>
            <div>Disk: ${res.disk || 'N/A'}</div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Hermes</div>
          <div style="margin-top:12px;">
            <div style="margin-bottom:8px;">Version: ${res.hermes_version || 'N/A'}</div>
            <div style="margin-bottom:8px;">Agents: ${res.agents || 0}</div>
            <div>Sessions: ${res.sessions || 0}</div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Token Usage (7d)</div>
          <div class="loading">Coming soon</div>
        </div>
      `;
    }
  } catch {
    // Will implement in Module 2.1
  }
}

async function loadAgents(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Agents</div>
        <div class="page-subtitle">Manage your Hermes profiles</div>
      </div>
      <button class="btn btn-primary" id="create-agent-btn">+ Create Agent</button>
    </div>
    <div class="card-grid" id="agents-grid">
      <div class="loading">Loading agents</div>
    </div>
  `;
  // Will implement in Module 2.2
}

async function loadAgentDetail(container, params) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Agent: ${params.name || 'Unknown'}</div>
        <div class="page-subtitle">Agent detail</div>
      </div>
      <button class="btn btn-ghost" onclick="navigate('agents')">← Back</button>
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
  // Will implement in Module 2.3-2.7
}

async function loadMonitor(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">System Monitor</div>
        <div class="page-subtitle">System resources and services</div>
      </div>
    </div>
    <div class="card-grid">
      <div class="card"><div class="card-title">CPU / RAM / Disk</div><div class="loading">Loading</div></div>
      <div class="card"><div class="card-title">Services</div><div class="loading">Loading</div></div>
      <div class="card"><div class="card-title">Cron Jobs</div><div class="loading">Loading</div></div>
    </div>
  `;
  // Will implement in Module 3.1
}

async function loadSkills(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Skills Marketplace</div>
        <div class="page-subtitle">Browse and manage skills</div>
      </div>
    </div>
    <div class="card-grid">
      <div class="card"><div class="card-title">Installed Skills</div><div class="loading">Loading</div></div>
    </div>
  `;
  // Will implement in Module 3.2
}

async function loadMaintenance(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Maintenance</div>
        <div class="page-subtitle">System tools and diagnostics</div>
      </div>
    </div>
    <div class="card-grid">
      <div class="card"><div class="card-title">Doctor</div><div class="loading">Loading</div></div>
      <div class="card"><div class="card-title">Update</div><div class="loading">Loading</div></div>
      <div class="card"><div class="card-title">Users</div><div class="loading">Loading</div></div>
    </div>
  `;
  // Will implement in Module 3.3
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
    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
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

// Start
init();
