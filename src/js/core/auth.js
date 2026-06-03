import { state, t, wsClient } from './state.js';;
import { updateGatewayBadge, updateWsConnectionUI } from '../chat/cli.js';
import { loadChatSession } from '../chat/core.js';
import { setupWsChatHandlers, showChatWarning } from '../chat/gateway.js';
import { startNotifPolling } from '../components/notifications.js';
import { navigate } from './navigation.js';
import { hasPerm } from './permissions.js';

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
      window.__csrfToken = data.csrfToken;
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
  document.getElementById('login-sub').textContent = t('login.subtitleFirstRun');
}

function showApp() {
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('app').style.display = 'block';
  updateUserMenu();
  navigate(state.page);
  startNotifPolling();

  // ── Phase 3: Session Restore ──
  // Restore last session from localStorage after sidebar loads
  const lastSid = localStorage.getItem('hci-last-session');
  if (lastSid && state.page === 'chat') {
    // Poll until sessions are loaded in DOM
    let attempts = 0;
    const tryRestore = () => {
      attempts++;
      const exists = document.querySelector(`.chat-session-item[data-sid="${lastSid}"]`);
      if (exists) {
        loadChatSession(lastSid);
      } else if (attempts < 10) {
        setTimeout(tryRestore, 400);
      } else {
        localStorage.removeItem('hci-last-session');
      }
    };
    setTimeout(tryRestore, 300);
  }

  // Phase 3: init gateway health badge (defer until DOM renders)
  if (state.page === 'chat') setTimeout(() => updateGatewayBadge().catch(() => {}), 100);
  // Connect WebSocket for real-time events — add listeners BEFORE connect to avoid race
  wsClient.addEventListener('open', () => {
    state._wsConnected = true;
    updateWsConnectionUI(true);
  });
  wsClient.addEventListener('close', () => {
    state._wsConnected = false;
    updateWsConnectionUI(false);
    // Unlock chat if disconnect happens mid-stream (debounced: once per 15s)
    if (state._chatLock) {
      state._chatLock = false;
      const sendBtn = document.getElementById('chat-send-btn');
      const stopBtn = document.getElementById('chat-stop-btn');
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = t('ui.send'); sendBtn.style.display = ''; }
      if (stopBtn) stopBtn.style.display = 'none';
      const cursors = document.querySelectorAll('.chat-cursor');
      cursors.forEach(c => c.remove());
      const now = Date.now();
      if (!state._lastWsWarn || now - state._lastWsWarn > 15000) {
        state._lastWsWarn = now;
        showChatWarning('Connection lost — response may be incomplete');
      }
    }
  });
  if (wsClient.connected) {
    // Already connected (e.g. reconnect before showApp re-runs)
    updateWsConnectionUI(true);
  }
  wsClient.connect();
  setupWsChatHandlers();
}

function updateUserMenu() {
  if (!state.user) return;
  document.getElementById('user-name').textContent = state.user.username;
  document.getElementById('user-role').textContent = state.user.role;
  // Show User Management button for admin only
  const btn = document.getElementById('users-mgmt-btn');
  if (btn) {
    btn.style.display = hasPerm('users.manage') ? 'block' : 'none';
  }
}

// Login form
document.getElementById('login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  const btn = e.target.querySelector('button[type="submit"]');

  if (!username || !password) {
    errorEl.textContent = 'Username and password required';
    return;
  }

  btn.disabled = true;
  btn.textContent = '...';

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
      window.__csrfToken = data.csrfToken || '';
      errorEl.textContent = '';
      showApp();
    } else if (data.error === 'first_run') {
      showSetup();
    } else {
      // Show server error with rate-limit awareness
      const msg = data.error || 'Login failed';
      errorEl.textContent = msg.includes('too many') 
        ? '⏳ Rate limited — wait 15 minutes or restart server'
        : msg;
    }
  } catch (err) {
    errorEl.textContent = 'Connection error — check server';
  } finally {
    btn.disabled = false;
    btn.textContent = 'unlock';
  }
});

// Setup form (first run)
document.getElementById('setup-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('setup-username').value.trim();
  const password = document.getElementById('setup-password').value;
  const confirm = document.getElementById('setup-password-confirm').value;
  const errorEl = document.getElementById('login-error');

  if (password !== confirm) {
    errorEl.textContent = 'Passwords don\'t match';
    return;
  }
  if (password.length < 8) {
    errorEl.textContent = 'Password too short (min 8 chars)';
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
      window.__csrfToken = data.csrfToken || '';
      errorEl.textContent = '';
      showApp();
    } else {
      errorEl.textContent = data.error || 'Setup failed';
    }
  } catch (err) {
    errorEl.textContent = 'Connection error — check server';
  }
});

export { checkAuth, showLogin, showSetup, showApp, updateUserMenu };
