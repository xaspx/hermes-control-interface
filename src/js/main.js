/* ============================================
   HCI Main Entry Point
   ============================================ */
import { Chart, registerables } from 'chart.js';
import { toDisplayText } from './chat-render-utils.mjs';
import { resolveSessionDisplayTitle } from './session-title-utils.mjs';
import { SSE_EVENT_TYPES, mapWsType } from '../../lib/sse-events.js';
import { wsClient } from './ws-client.js';
Chart.register(...registerables);

// State
const state = {
  user: null,
  page: 'home',
  theme: localStorage.getItem('hci-theme') || 'dark',
  notifications: [],
  notifDisplayLimit: 5,
  notifInterval: null,
  notifFailCount: 0,
  _currentChatSession: null,
  _optMessages: null, // Map<optId, {text, el, ts}>
  _recentMessages: null, // Ring buffer for dedup {role, content, ts}[]
  chatSidebarOpen: localStorage.getItem('hci-chat-sidebar') !== 'false',
  _wsConnected: false, // WebSocket connection state
  _soundEnabled: false, // Sound notification preference
  _soundReady: false, // Audio element initialized
  _soundEl: null, // Audio element ref
  _wsToolCount: 0, // Live count of running tools
  _artifactCount: 0, // Live count of artifacts created
  auditDisplayLimit: 15,
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
  // Cleanup previous page resources
  stopLogsAutoRefresh();
  if (state._logsDebounce) { clearTimeout(state._logsDebounce); state._logsDebounce = null; }

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
      case 'mon':
        // MON page merged into Home — redirect
        navigate('home');
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
      case 'chat':
        await loadChat(container);
        break;
      case 'users':
        await loadUsersPage(container);
        break;
      case 'logs':
        await loadLogs(container);
        break;
      case 'mon':
        await loadMonitoring(container);
        break;
      default:
        container.innerHTML = `<div class="empty">Page not found</div>`;
    }
  } catch (err) {
    container.innerHTML = `<div class="empty">Error loading page: ${escapeHtml(err.message)}</div>`;
  }
}

// ============================================
// Chat Functions
// ============================================
async function loadChat(container) {
  // Load profiles for dropdown
  let profiles = [];
  try {
    const pRes = await api('/api/profiles');
    if (pRes.ok) profiles = pRes.profiles || [];
  } catch {}
  const profileOptions = profiles.map(p => `<option value="${p.name}">${p.name}${p.active ? ' ★' : ''}</option>`).join('');
  const defaultProfile = profiles.find(p => p.active)?.name || 'default';
  state._defaultProfile = defaultProfile;

  // Sidebar state
  const sidebarCollapsed = state.chatSidebarOpen ? '' : ' collapsed';

  container.innerHTML = `
    <div class="chat-layout">
      <div id="chat-sidebar" class="chat-sidebar${sidebarCollapsed}">
        <div class="chat-sidebar-header">
          <div class="chat-sidebar-header-top">
            <select id="chat-profile">
              ${profileOptions || '<option value="default">default</option>'}
            </select>
            <button class="chat-sidebar-close" onclick="toggleChatSidebar()" aria-label="Close sidebar">✕</button>
          </div>
          <input type="text" id="chat-session-search" class="search-input" placeholder="Search sessions..." />
          <button class="btn btn-primary btn-sm" style="width:100%;margin-top:6px;" onclick="newChatSession()">+ New Chat</button>
        </div>
        <div id="chat-agent-panel" class="chat-agent-panel">
          <div class="chat-agent-panel-title">🤖 Active Agent</div>
          <div id="chat-agent-panel-body">
            <!-- Populated by updateChatAgentPanel() -->
          </div>
        </div>
        <div class="chat-sidebar-list" id="chat-sidebar-list">
          <div class="loading">Loading sessions...</div>
        </div>
        <div id="subagent-panel" class="subagent-panel" style="display:none;">
          <div class="subagent-panel-title">Subagents</div>
        </div>
      </div>
      <div class="chat-sidebar-backdrop" id="chat-sidebar-backdrop" onclick="toggleChatSidebar()"></div>
      <div class="chat-main">
        <div class="chat-header" id="chat-header">
          <div class="chat-header-left">
            <button class="chat-sidebar-toggle" id="chat-sidebar-toggle" aria-label="Toggle sidebar" onclick="toggleChatSidebar()">
              <span>☰</span>
            </button>
            <div>
              <div class="chat-title" id="chat-title">New Chat</div>
              <div class="chat-subtitle" id="chat-subtitle"></div>
            </div>
          </div>
          <div class="chat-header-right">
            <span id="chat-gateway-badge" class="chat-header-badge" title="Gateway status">🌐 …</span>
            <span class="chat-header-model-badge" id="chat-model-badge" style="display:none;"></span>
            <button class="btn btn-ghost btn-sm" onclick="renameChatSession()" title="Rename">✏️</button>
            <button class="btn btn-ghost btn-sm btn-danger" onclick="deleteChatSession()" title="Delete">🗑️</button>
          </div>
        </div>
        <div class="chat-messages" id="chat-messages"></div>
        <div class="chat-status-bar" id="chat-status-bar">
          <div class="chat-status-left">
            <span id="agent-status-indicator" class="status-idle">ready</span>
            <span id="chat-status-session" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">—</span>
          </div>
          <div class="chat-status-right">
            <span id="chat-status-tokens"></span>
            <span id="chat-status-elapsed"></span>
          </div>
        </div>
        <div class="chat-input-area">
          <textarea id="chat-input" placeholder="Type a message... (Enter to send)" rows="1" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChatMessage();}"></textarea>
          <span id="chat-queue-badge" class="queue-badge" style="display:none;">0</span>
          <button class="btn btn-primary" id="chat-send-btn" onclick="sendChatMessage()">Send</button>
          <button class="btn btn-danger btn-sm" id="chat-stop-btn" style="display:none;" onclick="stopChatStream()">Stop</button>
        </div>
      </div>
    </div>
  `;

  // ── Keyboard shortcuts ──
  document.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');

    // Ctrl/Cmd + Enter = send
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      sendChatMessage();
      return;
    }

    // Esc = stop stream or close modal
    if (e.key === 'Escape') {
      if (state._chatLock) {
        e.preventDefault();
        stopChatStream();
      } else if (document.querySelector('.modal-overlay')) {
        closeModal();
      }
      return;
    }

    // Ctrl/Cmd + N = new chat
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
      e.preventDefault();
      newChatSession();
      return;
    }

    // Ctrl/Cmd + K = focus session search
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      const search = document.getElementById('chat-session-search');
      if (search) search.focus();
      return;
    }

    // Ctrl/Cmd + [ = toggle sidebar
    if ((e.ctrlKey || e.metaKey) && e.key === 'BracketLeft') {
      e.preventDefault();
      toggleChatSidebar();
      return;
    }

    // Ctrl/Cmd + / = show shortcuts help
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      showModal({
        title: 'Keyboard Shortcuts',
        body: `<div style="display:grid;grid-template-columns:auto 1fr;gap:8px 16px;font-size:13px;">
          <kbd>Ctrl+Enter</kbd><span>Send message</span>
          <kbd>Esc</kbd><span>Stop stream / close modal</span>
          <kbd>Ctrl+N</kbd><span>New chat</span>
          <kbd>Ctrl+K</kbd><span>Search sessions</span>
          <kbd>Ctrl+[</kbd><span>Toggle sidebar</span>
          <kbd>Shift+Enter</kbd><span>New line in input</span>
        </div>`,
        confirmText: 'Got it',
      });
      return;
    }
  });


  // Set default profile
  const profileSelect = document.getElementById('chat-profile');
  if (profileSelect) profileSelect.value = defaultProfile;

  // Cache profiles for the info panel
  _chatInfoProfiles = profiles;

  // Load sessions
  await refreshChatSidebar();
  updateChatAgentPanel().catch(() => {}); // Populate sidebar agent panel

  // Profile change → refresh sidebar + update gateway badge
  // If switching to a non-default profile AND no active session (new-chat scenario),
  // prompt the user to set it as their default agent.
  profileSelect?.addEventListener('change', async () => {
    const selected = profileSelect.value;
    const hermesDefault = state._defaultProfile || 'default';
    // Only prompt if: (1) not already the Hermes default, (2) no active session (new chat)
    if (selected !== hermesDefault && !state._currentChatSession) {
      const useDefault = await showModal({
        title: 'Set as Default Agent?',
        message: `Switch to <strong>${escapeHtml(selected)}</strong> for new chats? This will change your default agent.`,
        buttons: [
          { text: 'Cancel', primary: false, value: false },
          { text: `Set as Default`, primary: true, value: true },
        ],
      });
      if (useDefault?.action === true) {
        // User confirmed — call hermes profile use to switch Hermes CLI default
        try {
          const csrfToken = state.csrfToken || '';
          const res = await fetch('/api/profiles/use', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            credentials: 'include',
            body: JSON.stringify({ profile: selected }),
          });
          const data = await res.json();
          if (data.ok) {
            state._defaultProfile = selected;
            profileSelect.value = selected; // Keep selector in sync with Hermes default
            showToast(`Default agent set to ${selected}`, 'success');
            updateChatAgentPanel().catch(() => {}); // Refresh agent panel
          } else {
            showToast(data.error || 'Failed to set default', 'error');
            profileSelect.value = hermesDefault;
          }
        } catch (e) {
          showToast('Failed to set default: ' + e.message, 'error');
          profileSelect.value = hermesDefault;
        }
      } else {
        // User cancelled or overlay-clicked — revert to Hermes default (do NOT apply selected for new chats)
        profileSelect.value = hermesDefault;
        refreshChatSidebar();
        updateGatewayBadge().catch(() => {});
        return;
      }
    }
    refreshChatSidebar();
    updateGatewayBadge().catch(() => {});
    updateChatAgentPanel().catch(() => {}); // Refresh agent panel on profile change
  });

  // Session search
  document.getElementById('chat-session-search')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#chat-sidebar-list .chat-session-item').forEach(el => {
      el.style.display = el.dataset?.title?.toLowerCase().includes(q) || el.dataset?.sid?.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  // Auto-resize textarea + save draft
  const textarea = document.getElementById('chat-input');
  if (textarea) {
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
      // Save draft per session
      const sid = state._currentChatSession || '_new';
      try { localStorage.setItem('hci_chat_draft_' + sid, textarea.value); } catch {}
    });
    // Restore draft
    const sid = state._currentChatSession || '_new';
    try {
      const draft = localStorage.getItem('hci_chat_draft_' + sid);
      if (draft) { textarea.value = draft; textarea.dispatchEvent(new Event('input')); }
    } catch {}
  }

  // Mobile: always start sidebar collapsed (ignore localStorage)
  if (window.innerWidth <= 768) {
    const sidebar = document.getElementById('chat-sidebar');
    if (sidebar) sidebar.classList.add('collapsed');
    state.chatSidebarOpen = false;
  }

  // Welcome message
  document.getElementById('chat-messages').innerHTML = `
    <div class="chat-welcome">
      <div class="chat-welcome-icon">💬</div>
      <div class="chat-welcome-title">Welcome to Chat</div>
      <div class="chat-welcome-sub">Select a conversation or start a new one</div>
    </div>
  `;
}

async function refreshChatSidebar() {
  const profile = document.getElementById('chat-profile')?.value || 'default';
  const listEl = document.getElementById('chat-sidebar-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const res = await fetch(`/api/all-sessions?profile=${encodeURIComponent(profile)}`, { credentials: 'include' });
    if (!res.ok) { listEl.innerHTML = '<div class="error-msg">Failed to load</div>'; return; }
    const data = await res.json();
    let sessions = (data.sessions || []).filter(s => (s.messageCount > 0) || (s.message_count > 0) || (s.title && s.title !== '—'));

    if (sessions.length === 0) {
      listEl.innerHTML = '<div style="text-align:center;color:var(--fg-subtle);padding:20px;font-size:12px;\">No conversations yet</div>';
      return;
    }

    // Source labels for filter
    const sourceLabels = { telegram: '💬 Telegram', discord: '💜 Discord', slack: '🟡 Slack', cron: '⏰ Cron', api_server: '🔌 API', cli: '⌨️ CLI', web: '🌐 Web', other: '📝 Other' };

    // Parse lastActive string to seconds for sorting
    function parseLastActive(str) {
      if (!str) return 999999;
      const match = str.match(/(\d+)\s*(m|h|d|s)/);
      if (!match) return 999999;
      const val = parseInt(match[1], 10);
      const unit = match[2];
      if (unit === 's') return val;
      if (unit === 'm') return val * 60;
      if (unit === 'h') return val * 3600;
      if (unit === 'd') return val * 86400;
      return 999999;
    }

    // Normalize source
    function normalizeSource(s) {
      const src = s.source;
      if (!src) return 'other';
      if (src === 'api_server') return 'api_server';
      return src;
    }

    // Add normalized source to sessions
    sessions = sessions.map(s => ({ ...s, _source: normalizeSource(s) }));

    // Sort: pinned first, then by last activity
    const pinned = JSON.parse(localStorage.getItem('hci_pinned_sessions') || '[]');
    sessions.sort((a, b) => {
      const ap = pinned.includes(a.id) ? 1 : 0;
      const bp = pinned.includes(b.id) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return 0; // preserve API order (already sorted by last activity)
    });

    // Get unique sources for filter
    const uniqueSources = [...new Set(sessions.map(s => s._source))].sort();

    // Build filter HTML
    const filterOptions = `<option value="all">All</option>` +
      uniqueSources.map(src => `<option value="${src}">${sourceLabels[src] || src}</option>`).join('');

    // Check active filter (persist in data attr)
    const activeFilter = listEl.dataset.activeFilter || 'all';

    // Render filter bar
    let html = `<div class="chat-filter-bar">
      <select id="chat-source-filter" class="chat-source-filter" onchange="filterChatBySource(this.value)">
        ${filterOptions}
      </select>
    </div>`;

    // Filter sessions
    let filtered = activeFilter === 'all' ? sessions : sessions.filter(s => s._source === activeFilter);

    // Backend already sorts by last activity (most recent message timestamp),
    // so no additional sort needed — preserve the order from the API.

    // Render flat list — no grouping
    const currentSid = state._currentChatSession;
    for (const s of filtered.slice(0, 100)) {
      const title = toDisplayText((s.title && s.title !== '—') ? s.title : s.id);
      const isActive = s.id == currentSid;
      const msgs = s.messageCount || s.message_count || 0;
      const model = s.model || '';
      const modelTag = model ? `<span class="session-model-tag">${escapeHtml(model.split('/').pop())}</span>` : '';
      const sourceIcon = { telegram: '💬', discord: '💜', slack: '🟡', cron: '⏰', api_server: '🔌', cli: '⌨️', web: '🌐', other: '📝' }[s._source] || '';
      const isPinned = pinned.includes(s.id);
      html += `<div class="chat-session-item ${isActive ? 'active' : ''} ${isPinned ? 'pinned' : ''}" data-sid="${s.id}" data-title="${escapeHtml(title)}" onclick="loadChatSession('${s.id}')">
        <div class="chat-session-title">${sourceIcon} ${escapeHtml(title.substring(0, 40))}<button class="session-pin-btn" onclick="event.stopPropagation();togglePinSession('${s.id}')" title="${isPinned?'Unpin':'Pin'}">${isPinned?'📌':'○'}</button></div>
        <div class="chat-session-meta">
          <span>${msgs} msgs</span>
          ${modelTag}
          <span class="session-time">${s.lastActive || ''}</span>
        </div>
      </div>`;
    }

    listEl.innerHTML = html;

    // Restore filter value
    const filterEl = document.getElementById('chat-source-filter');
    if (filterEl) filterEl.value = activeFilter;
  } catch {}
}

function filterChatBySource(value) {
  const listEl = document.getElementById('chat-sidebar-list');
  if (listEl) listEl.dataset.activeFilter = value;
  refreshChatSidebar();
}

// Reload current session messages from DB (silent — no loading indicator)
let _reloadInProgress = false;
async function reloadCurrentSessionMessages() {
  const sessionId = state._currentChatSession;
  if (!sessionId) return;
  // Guard: prevent concurrent calls (e.g., double finalizeWsChat race)
  if (_reloadInProgress) {
    console.warn('[Chat] reload already in progress, skipping duplicate call');
    return;
  }
  _reloadInProgress = true;
  // Capture the session ID at call time so a concurrent session
  // switch cannot cause us to overwrite the new session's view with old data.
  const expectedSession = sessionId;
  const profile = document.getElementById('chat-profile')?.value || 'default';
  const container = document.getElementById('chat-messages');
  const statsEl = document.getElementById('chat-status-session');
  const tokensEl = document.getElementById('chat-status-tokens');
  if (!container) return;
  if (statsEl) statsEl.textContent = sessionId;

  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages?profile=${encodeURIComponent(profile)}`, { credentials: 'include' });
    if (!r.ok) { console.warn('[Chat] reload messages failed:', r.status); return; }
    const data = await r.json();

    // Stale guard: if the session switched while the fetch was in flight,
    // discard the response to avoid overwriting the new session's view.
    if (state._currentChatSession !== expectedSession) {
      console.warn('[Chat] session changed during reload, discarding stale response');
      return;
    }

    // Token info
    if (tokensEl && data.session) {
      const tokens = (data.session.input_tokens || 0) + (data.session.output_tokens || 0);
      tokensEl.textContent = tokens > 0 ? formatNumber(tokens) + ' tokens' : '';
    }

    // Model badge
    const modelBadge = document.getElementById('chat-model-badge');
    if (modelBadge && data.session?.model) {
      const modelName = data.session.model.split('/').pop() || data.session.model;
      modelBadge.textContent = modelName;
      modelBadge.style.display = '';
    } else if (modelBadge) {
      modelBadge.style.display = 'none';
    }

    if (!data.messages || data.messages.length === 0) { console.warn('[Chat] no messages in session'); _reloadInProgress = false; return; }

    // Rebuild messages cleanly
    container.innerHTML = '';
    for (const m of data.messages) {
      container.appendChild(renderChatMessage(m));
    }
    highlightCodeBlocks(container);
    container.scrollTop = container.scrollHeight;
  } catch (e) { console.error('[Chat] reload messages error:', e); }
  finally { _reloadInProgress = false; }
}

async function loadChatSession(sessionId, offset = 0) {
  const profile = document.getElementById('chat-profile')?.value || 'default';
  const container = document.getElementById('chat-messages');
  const titleEl = document.getElementById('chat-title');
  const subtitleEl = document.getElementById('chat-subtitle');
  const statsEl = document.getElementById('chat-status-session');
  const tokensEl = document.getElementById('chat-status-tokens');
  if (!container) return;
  state._currentChatSession = sessionId || null;
  if (sessionId) localStorage.setItem('hci-last-session', sessionId);
  else localStorage.removeItem('hci-last-session');
  if (statsEl) statsEl.textContent = sessionId || '—';

  // Restore draft for this session
  const draftInput = document.getElementById('chat-input');
  if (draftInput) {
    try {
      const draft = localStorage.getItem('hci_chat_draft_' + (sessionId || '_new'));
      draftInput.value = draft || '';
      draftInput.style.height = 'auto';
      if (draft) draftInput.style.height = Math.min(draftInput.scrollHeight, 120) + 'px';
    } catch {}
  }

  container.innerHTML = '<div class="loading">Loading messages...</div>';

  // Highlight active in sidebar
  document.querySelectorAll('.chat-session-item').forEach(el => {
    el.classList.toggle('active', el.dataset.sid == sessionId);
  });

  // Auto-hide sidebar on mobile after selecting session
  if (window.innerWidth <= 768 && state.chatSidebarOpen) {
    toggleChatSidebar();
  }

  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages?profile=${encodeURIComponent(profile)}&offset=${offset}&limit=50`, { credentials: 'include' });
    if (!r.ok) { container.innerHTML = '<div class="error-msg">Failed to load messages</div>'; return; }
    const data = await r.json();
    if (titleEl) {
      titleEl.textContent = toDisplayText(resolveSessionDisplayTitle({ sessionId, data }));
    }
    if (subtitleEl) subtitleEl.textContent = `${data.messages?.length || 0} messages · ${profile}`;

    // Token info
    if (tokensEl && data.session) {
      const tokens = (data.session.input_tokens || 0) + (data.session.output_tokens || 0);
      tokensEl.textContent = tokens > 0 ? formatNumber(tokens) + ' tokens' : '';
    }

    // Model badge
    const modelBadge = document.getElementById('chat-model-badge');
    if (modelBadge && data.session?.model) {
      const modelName = data.session.model.split('/').pop() || data.session.model;
      modelBadge.textContent = modelName;
      modelBadge.style.display = '';
    } else if (modelBadge) {
      modelBadge.style.display = 'none';
    }

    if (!data.messages || data.messages.length === 0) {
      container.innerHTML = '<div style="text-align:center;color:var(--fg-subtle);padding:40px;font-size:13px;">No messages yet</div>';
      return;
    }

    // Lazy load older: prepend if offset > 0, else replace
    if (offset === 0) {
      container.innerHTML = '';
    }
    const frag = document.createDocumentFragment();
    for (const m of data.messages) {
      frag.appendChild(renderChatMessage(m));
    }
    if (offset > 0 && container.firstChild) {
      container.insertBefore(frag, container.firstChild);
      // Remove old "Load older" button
      const oldBtn = container.querySelector('.load-older-btn');
      if (oldBtn) oldBtn.remove();
    } else {
      container.appendChild(frag);
    }
    // Add "Load older" button if we got 50 messages (more likely exist)
    if (data.messages.length === 50 && offset === 0) {
      const loadBtn = document.createElement('button');
      loadBtn.className = 'load-older-btn';
      loadBtn.textContent = '↑ Load older messages';
      loadBtn.onclick = () => {
        loadBtn.textContent = 'Loading...';
        loadBtn.disabled = true;
        loadChatSession(sessionId, offset + 50).then(() => {
          loadBtn.remove();
        }).catch(() => {
          loadBtn.textContent = '↑ Load older messages';
          loadBtn.disabled = false;
        });
      };
      container.insertBefore(loadBtn, container.firstChild);
    }
    highlightCodeBlocks(container);
    if (offset === 0) container.scrollTop = container.scrollHeight;
  } catch (e) {
    container.innerHTML = '<div class="error-msg">' + escapeHtml(e.message) + '</div>';
  }
}

function renderChatMessage(msg) {
  const role = msg.role || 'unknown';
  const labels = {
    user: { label: 'You', icon: '👤', cls: 'msg-user' },
    assistant: { label: 'Assistant', icon: '🤖', cls: 'msg-assistant' },
    tool: { label: 'Tool Result', icon: '⚡', cls: 'msg-tool' },
    system: { label: 'System', icon: '⚙️', cls: 'msg-system' },
  };
  const c = labels[role] || labels.system;
  const ts = msg.timestamp ? new Date(msg.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  const div = document.createElement('div');
  div.className = `chat-msg ${c.cls}`;

  // Header
  const header = document.createElement('div');
  header.className = 'msg-header';
  header.innerHTML = `<span class="msg-header-label">${c.icon} ${c.label}</span>${ts ? `<span class="msg-header-time">${ts}</span>` : ''}<button class="msg-menu-btn" onclick="toggleMsgMenu(this, '${role}')" title="Message options">⋮</button>`;
  div.appendChild(header);

  // Tool calls — render as collapsible cards
  if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      const fn = tc.function || tc;
      const name = fn.name || tc.name || 'unknown';
      let args = {};
      try { args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments || {}); } catch {}
      
      const toolCard = document.createElement('div');
      toolCard.className = 'tool-call-card';
      toolCard.innerHTML = `
        <div class="tool-card-header" onclick="this.parentElement.classList.toggle('expanded')">
          <span class="tool-card-icon">⚡</span>
          <span class="tool-card-name">${escapeHtml(name)}</span>
          <span class="tool-card-chevron">▶</span>
        </div>
        <div class="tool-card-body">
          <div class="tool-card-args"><code>${escapeHtml(JSON.stringify(args, null, 2))}</code></div>
        </div>
      `;
      div.appendChild(toolCard);
    }
  }

  // Tool result content
  if (role === 'tool') {
    const contentDiv = document.createElement('div');
    contentDiv.className = 'msg-tool-result';
    let content = msg.content;
    try {
      const parsed = JSON.parse(content);
      if (parsed.summary) content = parsed.summary;
      else if (parsed.results) content = JSON.stringify(parsed.results, null, 2);
      else content = JSON.stringify(parsed, null, 2);
    } catch {}
    contentDiv.textContent = toDisplayText(content).substring(0, 2000);
    div.appendChild(contentDiv);
    return div;
  }

  // Content
  let content = toDisplayText(msg.content);
  content = content.replace(/^Resume this session with:.*$/gm, '');
  content = content.replace(/^Session:\s*\d+.*$/gm, '');
  content = content.replace(/^Duration:.*$/gm, '');
  content = content.replace(/^-{10,}$/gm, '');
  content = content.trim();

  if (content) {
    const contentDiv = document.createElement('div');
    contentDiv.className = 'msg-body';
    contentDiv.innerHTML = renderChatContent(content.substring(0, 8000));
    div.appendChild(contentDiv);
  }

  // Reasoning (if present, collapsible)
  if (msg.reasoning) {
    const rd = document.createElement('details');
    rd.style.cssText = 'margin-top:8px;';
    rd.innerHTML = `<summary style="cursor:pointer;font-size:11px;color:var(--fg-subtle);">💭 Reasoning</summary><div class="msg-tool-result" style="margin-top:4px;">${escapeHtml(toDisplayText(msg.reasoning).substring(0, 2000))}</div>`;
    div.appendChild(rd);
  }

  return div;
}

function newChatSession() {
  // Option B: Don't generate session ID yet — let backend create it on first message
  state._currentChatSession = null;

  // Reset UI
  const titleEl = document.getElementById('chat-title');
  if (titleEl) titleEl.textContent = 'New Chat';
  const subtitleEl = document.getElementById('chat-subtitle');
  if (subtitleEl) subtitleEl.textContent = '';
  const statusSessionEl = document.getElementById('chat-status-session');
  if (statusSessionEl) statusSessionEl.textContent = '—';
  const statusTokensEl = document.getElementById('chat-status-tokens');
  if (statusTokensEl) statusTokensEl.textContent = '';
  const messagesEl = document.getElementById('chat-messages');
  if (messagesEl) messagesEl.innerHTML = `
    <div class="chat-welcome">
      <div class="chat-welcome-icon">💬</div>
      <div class="chat-welcome-title">New conversation</div>
      <div class="chat-welcome-sub">Type a message to start</div>
    </div>
  `;
  document.querySelectorAll('.chat-session-item').forEach(el => el.classList.remove('active'));

  // Reset profile dropdown to default/active profile
  const profileSelect = document.getElementById('chat-profile');
  if (profileSelect && state._defaultProfile) {
    profileSelect.value = state._defaultProfile;
  }

  return null;
}

function toggleChatSidebar() {
  state.chatSidebarOpen = !state.chatSidebarOpen;
  localStorage.setItem('hci-chat-sidebar', state.chatSidebarOpen);

  const sidebar = document.getElementById('chat-sidebar');
  if (sidebar) {
    sidebar.classList.toggle('collapsed', !state.chatSidebarOpen);
  }
  const backdrop = document.getElementById('chat-sidebar-backdrop');
  if (backdrop) {
    backdrop.classList.toggle('active', state.chatSidebarOpen && window.innerWidth <= 768);
  }
}

// Update the sidebar agent panel with current profile data
let _chatInfoProfiles = [];
async function updateChatAgentPanel() {
  const body = document.getElementById('chat-agent-panel-body');
  if (!body) return;

  // Reuse cached profiles from sidebar refresh
  let profiles = _chatInfoProfiles;
  if (!profiles.length) {
    body.innerHTML = '<div style="color:var(--fg-muted);font-size:12px;text-align:center;padding:10px;">Loading...</div>';
    return;
  }

  const defaultAgent = profiles.find(p => p.active);
  const selectedName = document.getElementById('chat-profile')?.value || defaultAgent?.name || 'default';
  const selectedProfile = profiles.find(p => p.name === selectedName) || defaultAgent;

  // Current agent — prominent display
  const currentCard = selectedProfile ? `
    <div class="agent-current">
      <span class="agent-status-dot ${selectedProfile.gateway === 'running' ? 'running' : 'stopped'}"></span>
      <span class="agent-current-name">${escapeHtml(selectedProfile.name)}</span>
      ${selectedProfile.active ? '<span class="agent-badge-default">★ default</span>' : ''}
    </div>
    <div class="agent-current-meta">${escapeHtml(selectedProfile.model || '—')}</div>
  ` : '';

  // All agents compact list
  const agentItems = profiles.map(p => {
    const isRunning = p.gateway === 'running';
    return `<div class="agent-list-item">
      <span class="agent-list-dot ${isRunning ? 'running' : 'stopped'}"></span>
      <span class="agent-list-name">${escapeHtml(p.name)}</span>
      <span class="agent-list-model">${escapeHtml((p.model || '—').split('/').pop())}</span>
      ${p.active ? '<span class="agent-badge-default">★</span>' : ''}
    </div>`;
  }).join('');

  body.innerHTML = currentCard + `<div class="agent-list">${agentItems}</div>`;
}

// Stop active chat stream (Gateway API or CLI or WS)
function stopChatStream() {
  if (state._currentStreamReader) {
    state._currentStreamReader.cancel().catch(() => {});
    state._currentStreamReader = null;
  }
  // Also send WS stop if connected
  if (wsClient.connected) {
    wsClient.chatStop();
  }
  state._chatLock = false;
  const sendBtn = document.getElementById('chat-send-btn');
  const stopBtn = document.getElementById('chat-stop-btn');
  if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
  if (stopBtn) stopBtn.style.display = 'none';
  // Remove cursor
  const cursor = document.querySelector('.chat-cursor');
  if (cursor) cursor.remove();
}

async function renameChatSession(sessionId = 0) {
  const sid = sessionId || state._currentChatSession;
  if (!sid) return showToast('No session selected', 'info');
  const t = await showModal({ title: 'Rename Session', message: 'Enter a new title.', inputs: [{ placeholder: 'New title' }], buttons: [{ text: 'Cancel', value: false }, { text: 'Rename', value: true, primary: true }] });
  if (!t?.action || !t.inputs?.[0]) return;
  const n = t.inputs[0].trim();
  if (!n) return;
  try {
    const profile = document.getElementById('chat-profile')?.value || 'default';
    const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' }, body: JSON.stringify({ title: n, profile }), credentials: 'include' });
    if (r.ok) { showToast('Session renamed', 'success'); document.getElementById('chat-title').textContent = n; refreshChatSidebar(); } else showToast('Rename failed', 'error');
  } catch (e) { showToast('Rename failed: ' + e.message, 'error'); }
}

async function deleteChatSession(sessionId = 0) {
  const sid = sessionId || state._currentChatSession;
  if (!sid) return showToast('No session selected', 'info');
  const confirmResult = await showModal({ title: 'Delete Session', message: 'Delete this session? This cannot be undone.', buttons: [{ text: 'Cancel', value: false }, { text: 'Delete', value: true, primary: true }] });
  if (!confirmResult?.action) return;
  try {
    const profile = document.getElementById('chat-profile')?.value || 'default';
    const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}?profile=${encodeURIComponent(profile)}`, { method: 'DELETE', headers: { 'X-CSRF-Token': state.csrfToken || '' }, credentials: 'include' });
    if (r.ok) { showToast('Session deleted', 'success'); newChatSession(); refreshChatSidebar(); } else showToast('Delete failed', 'error');
  } catch (e) { showToast('Delete failed: ' + e.message, 'error'); }
}

// ── Update chat header with session info ──

function updateQueueBadge() {
  const q = state._chatQueue || [];
  const badge = document.getElementById('chat-queue-badge');
  if (!badge) return;
  badge.textContent = q.length;
  badge.style.display = q.length > 0 ? '' : 'none';
}
function updateChatHeader() {
  const sid = state._currentChatSession;
  const titleEl = document.getElementById('chat-title');
  const subtitleEl = document.getElementById('chat-subtitle');
  const profile = document.getElementById('chat-profile')?.value || 'default';
  if (!sid) {
    if (titleEl) titleEl.textContent = 'New Chat';
    if (subtitleEl) subtitleEl.textContent = profile !== 'default' ? `Profile: ${profile}` : '';
    return;
  }
  // Find session title from sidebar
  const item = document.querySelector(`.chat-session-item[data-sid="${sid}"]`);
  const sidebarTitle = item?.dataset?.title || '';
  if (titleEl) titleEl.textContent = sidebarTitle || sid.substring(0, 20) + '...';
  if (subtitleEl) subtitleEl.textContent = `${profile !== 'default' ? profile + ' · ' : ''}${sid.substring(0, 16)}`;
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = input?.value?.trim();
  if (!text) return;

  // Queue if busy
  if (state._chatLock) {
    if (!state._chatQueue) state._chatQueue = [];
    state._chatQueue.push(text);
    input.value = '';
    input.style.height = 'auto';
    updateQueueBadge();
    return;
  }
  const profile = document.getElementById('chat-profile')?.value || 'default';
  const sessionId = state._currentChatSession || null;
  input.value = '';
  input.style.height = 'auto';
  state._chatLock = true;
  // Initialize optimistic + dedup state
  if (!state._optMessages) state._optMessages = new Map();
  if (!state._recentMessages) state._recentMessages = { buf: [], max: 20 };

  // Clear draft
  try { localStorage.removeItem('hci_chat_draft_' + (state._currentChatSession || '_new')); } catch {}
  const btn = document.getElementById('chat-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  const messagesDiv = document.getElementById('chat-messages');
  if (messagesDiv) {
    const existing = messagesDiv.querySelector('[style*="text-align:center"]');
    if (existing) existing.remove();
    // Optimistic ID: tag user message so we can swap if needed
    const optId = 'opt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    const msgEl = createMessageDiv('user', text, optId);
    messagesDiv.appendChild(msgEl);
    // Track for dedup + optimistic swap
    state._optMessages.set(optId, { text, el: msgEl, ts: Date.now() });
    addToDedupBuf('user', text);
  }
  const streamEl = document.createElement('div');
  streamEl.id = 'chat-streaming';
  streamEl.className = 'chat-msg msg-assistant';
  streamEl.innerHTML = '<div class="msg-header"><span class="msg-header-label">🤖 Assistant</span></div><div class="msg-body"><span class="streaming-text" id="gw-stream-text"><span class="chat-cursor">▊</span></span></div>';
  if (messagesDiv) messagesDiv.appendChild(streamEl);
  if (messagesDiv) messagesDiv.scrollTop = messagesDiv.scrollHeight;
  const contentDiv = streamEl.querySelector('#gw-stream-text') || streamEl.querySelector('.msg-body');
  let fullContent = '';
  const startTime = Date.now();
  // Show stop button, hide send
  const stopBtn = document.getElementById('chat-stop-btn');
  if (btn) { btn.disabled = true; btn.style.display = 'none'; }
  if (stopBtn) stopBtn.style.display = 'inline-flex';
  try {
    // Prefer WebSocket for real-time events (thinking, tool progress, streaming)
    if (wsClient.connected) {
      try {
        await sendViaWebSocket(text, profile, sessionId);
        return; // WS success — done
      } catch (wsErr) {
        console.warn('[Chat] WS failed, falling back to CLI:', wsErr.message);
      }
    }
    // Fallback to CLI (Gateway API chat endpoint not available in Hermes)
    await sendViaCLI(text, profile, sessionId, contentDiv, messagesDiv, startTime);
  } catch (cliErr) {
    console.error('[Chat] CLI failed:', cliErr.message);
    if (contentDiv) contentDiv.innerHTML = renderChatContent(fullContent) + '<div style="color:var(--red);margin-top:8px;">Error: ' + escapeHtml(cliErr.message) + '</div>';
  } finally {
    state._chatLock = false;
    state._currentStreamReader = null;
    if (btn) { btn.disabled = false; btn.textContent = 'Send'; btn.style.display = ''; }
    if (stopBtn) stopBtn.style.display = 'none';
    // Remove lingering cursor
    const cursors = contentDiv?.querySelectorAll('.chat-cursor');
    cursors?.forEach(c => c.remove());
    // Update session title from sidebar
    updateChatHeader();
    // Refresh sidebar to show new sessions or update last activity
    refreshChatSidebar();
  }
}

// ── Gateway API Chat (fast, structured events) ──
async function sendViaGatewayAPI(text, profile, sessionId, contentDiv, messagesDiv, startTime) {
  const toolCards = new Map();
  const bodyObj = { message: text, profile, stream: true };
  if (sessionId) bodyObj.session_id = sessionId;

  const response = await fetch('/api/gateway/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
    credentials: 'include',
    body: JSON.stringify(bodyObj),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gateway ${response.status}: ${err}`);
  }

  // Try to get session ID from response header first
  const headerSessionId = response.headers.get('x-hermes-session-id') || '';
  if (headerSessionId) state._currentChatSession = headerSessionId;

  // Set up stop button
  const stopBtn = document.getElementById('chat-stop-btn');
  state._currentAbortController = null; // we use reader.cancel() instead

  let fullContent = '';
  let fullReasoning = '';
  const reader = response.body.getReader();
  state._currentStreamReader = reader; // for stop button
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on double-newline (SSE boundary)
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const lines = part.split('\n');
        let dataLine = '';
        for (const line of lines) {
          if (line.startsWith('data: ')) dataLine = line.slice(6);
        }
        if (!dataLine) continue;
        try {
          const evt = JSON.parse(dataLine);
          handleGatewayEvent(evt, contentDiv, messagesDiv, toolCards);
          if (evt.type === 'hci.session' && evt.session_id) {
            state._currentChatSession = evt.session_id;
          }
          if (evt.type === 'response.output_text.delta') {
            fullContent += evt.delta || '';
          }
        } catch (e) { /* skip */ }
      }
    }
  } catch (readErr) {
    // User cancelled or connection error
    console.log('[Chat] stream ended:', readErr.message);
  }

  // Finalize — remove cursor, show elapsed
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const elapsedEl = document.getElementById('chat-status-elapsed');
  if (elapsedEl) elapsedEl.textContent = elapsed + 's';
  state._currentStreamReader = null;

  // Reload messages from DB to get clean, properly rendered messages
  // (same as loading a session — ensures streaming view matches final view)
  if (state._currentChatSession) {
    await reloadCurrentSessionMessages();
  }

  await refreshChatSidebar();
  updateChatHeader();
}

function handleGatewayEvent(evt, contentDiv, messagesDiv, toolCards) {
  const t = evt.type;
  if (t === 'response.output_text.delta') {
    updateStreamContent(contentDiv, null, toolCards, messagesDiv);
  } else if (t === 'response.output_item.added') {
    const item = evt.item || {};
    if (item.type === 'function_call' || item.type === 'tool_call') {
      const callId = item.call_id || item.id || ('tc_' + Date.now());
      const cardEl = addToolCallCard(contentDiv, callId, item.name, item.arguments || item.args);
      toolCards.set(callId, cardEl);
      if (messagesDiv) messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
  } else if (t === 'response.function_call_arguments.delta' || t === 'response.tool_call_arguments.delta') {
    // Accumulate arguments for current tool call — update preview
  } else if (t === 'hermes.tool.progress') {
    updateToolProgress(toolCards, evt.name, evt.preview);
  } else if (t === 'response.output_item.done') {
    const item = evt.item || {};
    if (item.type === 'function_call' || item.type === 'tool_call') {
      const callId = item.call_id || item.id;
      const result = item.result || item.output || '';
      finalizeToolCard(toolCards, callId, result);
      if (messagesDiv) messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
  } else if (t === 'response.completed') {
    if (evt.response?.id) {
      // Don't overwrite session_id from hci.session or header
      if (!state._currentChatSession) state._currentChatSession = evt.response.id;
    }
  } else if (t === 'artifact.created') {
    handleArtifact(evt.artifact || evt);
  } else if (t === 'artifact.chunk') {
    // Accumulate artifact chunks — append to latest artifact card
    const messagesDiv = document.getElementById('chat-messages');
    const lastArtifact = messagesDiv?.querySelector('.artifact-card:last-of-type');
    if (lastArtifact) {
      const contentEl = lastArtifact.querySelector('.artifact-content');
      if (contentEl && evt.chunk) {
        contentEl.textContent = (contentEl.textContent || '') + evt.chunk;
      }
    }
  } else if (t === 'subagent.completed' || t === 'chat.subagent.done') {
    handleSubagentEvent('done', evt.payload || evt);
  }
}

// ── WebSocket Chat (TUI events) ──
function setupWsChatHandlers() {
  wsClient.addEventListener('message', (ev) => {
    const msg = ev.detail;
    switch (msg.type) {
      case 'chat.thinking':
        handleThinkingDelta(msg.delta);
        break;
      case 'chat.reasoning':
        handleReasoningDelta(msg.delta);
        break;
      case 'chat.start':
        handleMessageStart();
        break;
      case 'chat.text':
        handleTextDelta(msg.delta);
        break;
      case 'chat.status':
        handleStatusUpdate(msg.status, msg.kind);
        break;
      case 'chat.tool.generating':
        handleToolGenerating(msg.name);
        break;
      case 'chat.tool.start':
        handleToolStart(msg.tool_id, msg.name, msg.context);
        break;
      case 'chat.tool.progress':
        handleToolProgress(msg.name, msg.preview);
        break;
      case 'chat.tool.done':
        handleToolDone(msg.tool_id, msg.name, msg.summary, msg.error, msg.inline_diff);
        break;
      case 'chat.artifact':
        handleArtifact(msg.artifact || msg);
        break;
      case 'chat.session':
        state._currentChatSession = msg.session_id;
        state._sessionInfo = msg.info;
        swapOptimisticMessage(msg.session_id);
        updateChatHeader();
        break;
      case 'chat.done':
        finalizeWsChat();
        break;
      case 'chat.error':
        showChatError(msg.error);
        break;
      case 'chat.clarify':
        showClarifyModal(msg.question, msg.choices, msg.request_id);
        break;
      case 'chat.approval':
        showApprovalModal(msg.command, msg.description);
        break;
      case 'chat.sudo':
        showSudoModal(msg.request_id);
        break;
      case 'chat.secret':
        showSecretModal(msg.env_var, msg.prompt, msg.request_id);
        break;
      case 'chat.subagent.start':
      case 'chat.subagent.progress':
      case 'chat.subagent.complete':
        handleSubagentEvent(msg.type, msg.payload);
        break;
      case 'tui.ready':
        console.log('[TUI] Gateway ready');
        break;
      case 'tui.stderr':
        console.log('[TUI] stderr:', msg.line);
        break;
      case 'tui.error':
        console.error('[TUI] error:', msg.error);
        break;
    }
  });
}

function handleThinkingDelta(delta) {
  const messagesDiv = document.getElementById('chat-messages');
  if (!messagesDiv) return;
  const panel = ensureThinkingPanel(messagesDiv);
  const textEl = panel.querySelector('.thinking-text');
  if (textEl) {
    textEl.textContent += delta;
    panel.scrollTop = panel.scrollHeight;
  }
}

function handleReasoningDelta(delta) {
  // Same as thinking for now
  handleThinkingDelta(delta);
}

function handleMessageStart() {
  hideThinkingPanel();
  const messagesDiv = document.getElementById('chat-messages');
  if (!messagesDiv) return;
  let streamEl = document.getElementById('chat-streaming');
  if (!streamEl) {
    streamEl = document.createElement('div');
    streamEl.id = 'chat-streaming';
    streamEl.className = 'chat-msg msg-assistant chat-streaming';
    streamEl.innerHTML = '<div class="msg-header"><span class="msg-header-label">🤖 Assistant</span></div><div class="msg-body"><span id="gw-stream-text"></span><span class="chat-cursor" style="animation:blink 1s infinite;">▊</span></div>';
    messagesDiv.appendChild(streamEl);
  }
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function handleTextDelta(delta) {
  const messagesDiv = document.getElementById('chat-messages');
  if (!messagesDiv) return;
  // Re-query each time — streaming element may have been replaced by
  // reloadCurrentSessionMessages() between callback invocations.
  const streamEl = document.getElementById('chat-streaming');
  if (!streamEl || !document.contains(streamEl)) return;
  const body = streamEl.querySelector('.msg-body');
  if (!body) return;
  let span = body.querySelector('#gw-stream-text');
  const cursor = body.querySelector('.chat-cursor');
  if (!span) {
    span = document.createElement('span');
    span.id = 'gw-stream-text';
    // Guard: cursor may have been removed by reloadCurrentSessionMessages
    if (cursor && body.contains(cursor)) {
      body.insertBefore(span, cursor);
    } else {
      body.appendChild(span);
    }
  }
  span.textContent += delta;
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function handleStatusUpdate(status, kind) {
  const statusEl = document.getElementById('chat-status-bar');
  if (statusEl) {
    const sessionSpan = statusEl.querySelector('#chat-status-session');
    if (sessionSpan) sessionSpan.textContent = status || '';
  }
  // Also update a global status indicator
  const indicator = document.getElementById('agent-status-indicator');
  if (indicator) {
    indicator.textContent = status || 'ready';
    indicator.className = `status-${kind || 'idle'}`;
  }
}

function handleToolGenerating(name) {
  // Tool schema being generated — show subtle indicator
  console.log('[Tool] Generating:', name);
}

function handleToolStart(toolId, name, context) {
  hideThinkingPanel();
  const tc = ensureToolCards();
  const messagesDiv = document.getElementById('chat-messages');
  const streamEl = document.getElementById('chat-streaming');
  // Guard: if streaming element is no longer in the DOM (e.g. replaced by
  // finalizeWsChat or a new message cycle), skip tool card insertion.
  // The messages will be reloaded from DB when the stream finalizes.
  if (!streamEl || !document.contains(streamEl)) return;
  const targetDiv = streamEl.querySelector('.msg-body');
  if (!targetDiv || !document.contains(targetDiv)) return;
  const card = addToolCallCard(targetDiv, toolId, name, context);
  tc.set(toolId, card);
  if (messagesDiv) messagesDiv.scrollTop = messagesDiv.scrollHeight;
  // Live tool count indicator
  state._wsToolCount = (state._wsToolCount || 0) + 1;
  updateToolCountUI();
}

function handleToolProgress(name, preview) {
  const tc = ensureToolCards();
  for (const [id, el] of tc) {
    // Guard: skip if card is no longer in DOM (orphaned by finalizeWsChat)
    if (!document.contains(el)) continue;
    const previewEl = el.querySelector('.tool-card-preview');
    if (previewEl && preview) previewEl.textContent = preview;
  }
}

function handleToolDone(toolId, name, summary, error, inlineDiff) {
  const tc = ensureToolCards();
  const card = tc.get(toolId);
  if (!card) return; // card already removed (e.g. by finalizeWsChat)
  // Guard: if the card is no longer in the DOM (streaming element replaced),
  // skip DOM update — messages will be reloaded from DB.
  if (!document.contains(card)) return;
  const streamEl = document.getElementById('chat-streaming');
  if (!streamEl || !document.contains(streamEl)) return;
  const statusEl = card.querySelector('.tool-card-status');
  if (statusEl) {
    statusEl.textContent = error ? 'error' : 'done';
    statusEl.className = `tool-card-status ${error ? 'error' : 'done'}`;
  }
  const resultEl = card.querySelector('.tool-card-result');
  if (resultEl) {
    let resultText = error || '';
    if (!error && inlineDiff) {
      resultText = inlineDiff;
    } else if (!error && summary) {
      resultText = summary;
    }
    // 4000-char truncation with expand-on-click
    if (resultText.length > 4000) {
      resultEl.innerHTML = `
        <pre class="tool-result-truncated">${escapeHtml(resultText.substring(0, 4000))}</pre>
        <button class="tool-expand-btn" onclick="this.previousElementSibling.classList.toggle('tool-result-truncated'); this.previousElementSibling.classList.toggle('tool-result-full'); this.textContent = this.previousElementSibling.classList.contains('tool-result-full') ? 'Show less' : 'Show more (${(resultText.length - 4000).toLocaleString()} more chars)';">Show more (${(resultText.length - 4000).toLocaleString()} more chars)</button>`;
      resultEl.classList.add('has-expand');
    } else {
      resultEl.innerHTML = `<pre>${escapeHtml(resultText)}</pre>`;
    }
  }
  tc.delete(toolId);
  // Decrement live tool count
  state._wsToolCount = Math.max(0, (state._wsToolCount || 1) - 1);
  updateToolCountUI();
}

function handleSubagentEvent(type, payload) {
  // Show panel if hidden
  const panel = document.getElementById('subagent-panel');
  if (panel) panel.style.display = '';
  
  const id = payload.subagent_id;
  let el = document.getElementById(`subagent-${id}`);
  
  if (type === 'chat.subagent.start') {
    if (!el) {
      el = document.createElement('div');
      el.id = `subagent-${id}`;
      el.className = 'subagent-item';
      panel.appendChild(el);
    }
    el.innerHTML = `<span class="subagent-status running">●</span> ${escapeHtml(payload.goal?.slice(0, 40) || 'Subagent')} <span class="subagent-model">${escapeHtml(payload.model || '')}</span>`;
  } else if (type === 'chat.subagent.progress') {
    if (el) {
      const progress = payload.iteration ? ` (${payload.iteration}/${payload.tool_count || '?'})` : '';
      el.innerHTML = `<span class="subagent-status running">●</span> ${escapeHtml(payload.goal?.slice(0, 40) || 'Subagent')}${progress}`;
    }
  } else if (type === 'chat.subagent.complete') {
    if (el) {
      const status = payload.status === 'completed' ? 'completed' : 'failed';
      const icon = payload.status === 'completed' ? '✅' : '❌';
      el.innerHTML = `${icon} ${escapeHtml(payload.goal?.slice(0, 40) || 'Subagent')} <span class="subagent-status ${status}">${escapeHtml(payload.status || '')}</span>`;
      // Auto-remove after 5 seconds
      setTimeout(() => el?.remove(), 5000);
    }
  }
  
  // Hide panel if empty
  if (panel && panel.children.length <= 1) {
    panel.style.display = 'none';
  }
}

// ── Interactive Modals ─────────────────────────────────────────────

function showClarifyModal(question, choices, requestId) {
  if (!choices || choices.length === 0) {
    // Open-ended: text input
    showModal({
      title: 'Clarification Needed',
      body: `<p>${escapeHtml(question)}</p><input type="text" id="clarify-input" class="modal-input" placeholder="Your answer..." style="width:100%;margin-top:12px;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-card);color:var(--fg);">`,
      confirmText: 'Submit',
      onConfirm: () => {
        const input = document.getElementById('clarify-input');
        if (input) wsClient.clarifyRespond(requestId, input.value);
      }
    });
  } else {
    // Multiple choice
    const buttons = choices.map(c => 
      `<button class="modal-choice-btn" data-choice="${escapeHtml(c)}" style="display:block;width:100%;margin:4px 0;padding:10px;text-align:left;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;color:var(--fg);cursor:pointer;">${escapeHtml(c)}</button>`
    ).join('');
    showModal({
      title: 'Clarification Needed',
      body: `<p>${escapeHtml(question)}</p><div style="margin-top:12px;">${buttons}</div>`,
      showCancel: false,
      confirmText: null,
      onRender: () => {
        document.querySelectorAll('.modal-choice-btn').forEach(btn => {
          btn.onclick = () => {
            wsClient.clarifyRespond(requestId, null, btn.dataset.choice);
            closeModal();
          };
        });
      }
    });
  }
}

function showApprovalModal(command, description) {
  showModal({
    title: 'Approval Required',
    body: `
      <p>${escapeHtml(description || 'The agent wants to run a command:')}</p>
      <pre style="margin-top:12px;padding:12px;background:var(--bg-dark);border-radius:8px;overflow-x:auto;"><code>${escapeHtml(command)}</code></pre>
    `,
    confirmText: '✅ Approve',
    cancelText: '❌ Deny',
    onConfirm: () => wsClient.approvalRespond(true, command),
    onCancel: () => wsClient.approvalRespond(false, command),
  });
}

function showSudoModal(requestId) {
  showModal({
    title: 'Sudo Password Required',
    body: `<p>The agent needs sudo privileges. Enter your password:</p><input type="password" id="sudo-input" class="modal-input" placeholder="Password" style="width:100%;margin-top:12px;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-card);color:var(--fg);">`,
    confirmText: 'Submit',
    onConfirm: () => {
      const input = document.getElementById('sudo-input');
      if (input) wsClient.sudoRespond(requestId, input.value);
    }
  });
}

function showSecretModal(envVar, prompt, requestId) {
  showModal({
    title: `Secret Required: ${escapeHtml(envVar)}`,
    body: `<p>${escapeHtml(prompt || `Enter value for ${envVar}:`)}</p><input type="password" id="secret-input" class="modal-input" placeholder="Value" style="width:100%;margin-top:12px;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-card);color:var(--fg);">`,
    confirmText: 'Submit',
    onConfirm: () => {
      const input = document.getElementById('secret-input');
      if (input) wsClient.secretRespond(requestId, input.value);
    }
  });
}

function ensureThinkingPanel(messagesDiv) {
  let panel = document.getElementById('chat-thinking-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'chat-thinking-panel';
    panel.className = 'chat-thinking-panel';
    panel.innerHTML = '<div class="thinking-header">💭 Thinking</div><div class="thinking-text"></div>';
    // Insert before the streaming message or at the end
    const streamEl = document.getElementById('chat-streaming');
    // Guard: streamEl might have been removed/replaced by reloadCurrentSessionMessages
    // between check and insert. Use contains() for safety.
    if (streamEl && messagesDiv.contains(streamEl)) {
      messagesDiv.insertBefore(panel, streamEl);
    } else {
      messagesDiv.appendChild(panel);
    }
  }
  return panel;
}

function hideThinkingPanel() {
  const panel = document.getElementById('chat-thinking-panel');
  if (panel) panel.style.display = 'none';
}

function ensureToolCards() {
  if (!state._wsToolCards) state._wsToolCards = new Map();
  return state._wsToolCards;
}

function finalizeWsChat() {
  // Guard: prevent double-call race. chat.done fires once from WS,
  // but sendViaWebSocket also calls finalizeWsChat from onDone handler,
  // and the finally block (sendChatMessage) also runs cleanup. Two calls
  // cause reloadCurrentSessionMessages to race and destroy captured text.
  if (state._finalizeInProgress) return;
  state._finalizeInProgress = true;

  state._wsToolCards = null;
  const elapsed = ((Date.now() - (state._chatStartTime || 0)) / 1000).toFixed(1);
  const elapsedEl = document.getElementById('chat-status-elapsed');
  if (elapsedEl) elapsedEl.textContent = elapsed + 's';
  const stopBtn = document.getElementById('chat-stop-btn');
  if (stopBtn) stopBtn.style.display = 'none';
  const sendBtn = document.getElementById('chat-send-btn');
  if (sendBtn) { sendBtn.style.display = ''; sendBtn.disabled = false; sendBtn.textContent = 'Send'; }

  // Reset status indicator
  const indicator = document.getElementById('agent-status-indicator');
  if (indicator) {
    indicator.textContent = 'ready';
    indicator.className = 'status-idle';
  }

  // Hide subagent panel after delay
  setTimeout(() => {
    const panel = document.getElementById('subagent-panel');
    if (panel && panel.children.length <= 1) panel.style.display = 'none';
  }, 6000);

  // CAPTURE streaming text BEFORE removing streamEl.
  // chat.done fires BEFORE Hermes finishes writing the final message to SQLite,
  // so reloadCurrentSessionMessages() may miss the streaming content.
  const streamEl = document.getElementById('chat-streaming');
  let capturedText = '';
  if (streamEl) {
    const span = streamEl.querySelector('#gw-stream-text');
    if (span) capturedText = span.textContent || '';
    streamEl.remove();
  }
  // Also remove any orphaned thinking panel
  const thinkEl = document.getElementById('chat-thinking-panel');
  if (thinkEl) thinkEl.remove();

  // Reload from DB for clean final render, then merge captured streaming text
  // in case the final message hadn't been written to DB yet.
  if (state._currentChatSession) {
    reloadCurrentSessionMessages().then(() => {
      // Merge captured streaming text if the last assistant message has no body
      if (capturedText) {
        const messagesDiv = document.getElementById('chat-messages');
        if (messagesDiv) {
          const lastMsg = messagesDiv.querySelector('.msg-assistant:last-child');
          const lastBody = lastMsg?.querySelector('.msg-body');
          if (lastBody && !lastBody.textContent?.trim()) {
            lastBody.innerHTML = renderChatContent(capturedText.substring(0, 8000));
            highlightCodeBlocks(lastBody);
          }
        }
      }
    }).finally(() => {
      state._finalizeInProgress = false;
    }).catch((e) => {
      state._finalizeInProgress = false;
      console.error('[Chat] reload error:', e);
    });
  } else {
    state._finalizeInProgress = false;
  }
  refreshChatSidebar();
  updateChatHeader();
  state._chatLock = false;
  // Play completion sound if enabled
  playChatComplete();

  // Dequeue pending messages
  if (state._chatQueue && state._chatQueue.length > 0) {
    const next = state._chatQueue.shift();
    updateQueueBadge();
    const input = document.getElementById('chat-input');
    if (input) { input.value = next; input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; }
    setTimeout(() => sendChatMessage(), 300);
  }
}

function showChatError(error) {
  const messagesDiv = document.getElementById('chat-messages');
  if (messagesDiv) {
    messagesDiv.innerHTML += `<div class="chat-msg msg-system"><div class="msg-body" style="color:var(--error)">❌ ${escapeHtml(error)}</div></div>`;
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }
  const stopBtn = document.getElementById('chat-stop-btn');
  if (stopBtn) stopBtn.style.display = 'none';
  const sendBtn = document.getElementById('chat-send-btn');
  if (sendBtn) sendBtn.style.display = '';
}

// ── Send via WebSocket ──
async function sendViaWebSocket(text, profile, sessionId) {
  return new Promise((resolve, reject) => {
    const messagesDiv = document.getElementById('chat-messages');
    if (!messagesDiv) { reject(new Error('No chat container')); return; }

    // User message ALREADY added by sendChatMessage() — don't add again
    state._chatStartTime = Date.now();
    state._wsToolCards = new Map();

    // Use the streaming element created by sendChatMessage()
    let streamEl = document.getElementById('chat-streaming');
    if (!streamEl) {
      // Fallback: create if missing
      streamEl = document.createElement('div');
      streamEl.id = 'chat-streaming';
      streamEl.className = 'chat-msg msg-assistant';
      streamEl.innerHTML = '<div class="msg-header"><span class="msg-header-label">🤖 Assistant</span></div><div class="msg-body"><span id="gw-stream-text"></span></div>';
      messagesDiv.appendChild(streamEl);
    }
    messagesDiv.scrollTop = messagesDiv.scrollHeight;

    // Show stop button, hide send
    const stopBtn = document.getElementById('chat-stop-btn');
    const sendBtn = document.getElementById('chat-send-btn');
    if (stopBtn) stopBtn.style.display = '';
    if (sendBtn) sendBtn.style.display = 'none';

    // One-time listener for completion
    function onDone(ev) {
      const msg = ev.detail;
      if (msg.type === 'chat.done') {
        wsClient.removeEventListener('message', onDone);
        finalizeWsChat();
        resolve();
      } else if (msg.type === 'chat.error') {
        wsClient.removeEventListener('message', onDone);
        showChatError(msg.error);
        reject(new Error(msg.error));
      }
    }
    wsClient.addEventListener('message', onDone);

    // Send via WS
    const ok = wsClient.chatStart({ message: text, profile, session_id: sessionId });
    if (!ok) {
      wsClient.removeEventListener('message', onDone);
      reject(new Error('WebSocket not connected'));
    }
  });
}

// ── CLI Fallback Chat (legacy) ──
async function sendViaCLI(text, profile, sessionId, contentDiv, messagesDiv, startTime) {
  let fullContent = '';
  const bodyObj = { message: text, profile };
  if (sessionId) bodyObj.sessionId = sessionId;
  const response = await fetch('/api/chat/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
    credentials: 'include',
    body: JSON.stringify(bodyObj),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  while (!done) {
    const { done: d, value } = await reader.read();
    if (d) { done = true; break; }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const evt = JSON.parse(line.slice(6));
        if (evt.type === 'token') {
          fullContent += evt.content;
          if (contentDiv) contentDiv.innerHTML = renderChatContent(fullContent) + '<span class="chat-cursor" style="animation:blink 1s infinite;">▊</span>';
          if (messagesDiv) messagesDiv.scrollTop = messagesDiv.scrollHeight;
        } else if (evt.type === 'done') {
          if (evt.sessionId) state._currentChatSession = evt.sessionId;
        } else if (evt.type === 'error') {
          fullContent += '\n[Error: ' + evt.content + ']';
        }
      } catch {}
    }
  }
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const elapsedEl = document.getElementById('chat-status-elapsed');
  if (elapsedEl) elapsedEl.textContent = elapsed + 's';

  // Reload messages from DB to get clean, properly rendered messages
  if (state._currentChatSession) {
    await reloadCurrentSessionMessages();
  }

  await refreshChatSidebar();
  updateChatHeader();
}

// ── Tool Call Card Rendering ──
function addToolCallCard(contentDiv, callId, name, args) {
  const card = document.createElement('div');
  card.className = 'tool-call-card';
  card.id = `tool-card-${callId}`;
  const argsStr = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
  const argsPreview = argsStr.substring(0, 150) + (argsStr.length > 150 ? '...' : '');
  card.innerHTML = `
    <div class="tool-card-header" onclick="this.parentElement.classList.toggle('expanded')">
      <span class="tool-card-icon">⚡</span>
      <span class="tool-card-name">${escapeHtml(name || 'tool')}</span>
      <span class="tool-card-status running">running</span>
      <span class="tool-card-chevron">▶</span>
    </div>
    <div class="tool-card-body">
      <div class="tool-card-args"><code>${escapeHtml(argsPreview)}</code></div>
      <div class="tool-card-preview" id="tool-preview-${callId}"></div>
      <div class="tool-card-result" id="tool-result-${callId}"></div>
    </div>`;
  // Insert before cursor
  const cursor = contentDiv.querySelector('.chat-cursor');
  if (cursor && contentDiv.contains(cursor)) {
    contentDiv.insertBefore(card, cursor);
  } else {
    contentDiv.appendChild(card);
  }
  return card;
}

function updateToolProgress(toolCards, name, preview) {
  for (const [id, el] of toolCards) {
    const previewEl = el.querySelector('.tool-card-preview');
    if (previewEl && preview) previewEl.textContent = preview;
  }
}

function finalizeToolCard(toolCards, callId, result) {
  const el = toolCards.get(callId);
  if (!el) return;
  const statusEl = el.querySelector('.tool-card-status');
  if (statusEl) { statusEl.textContent = 'done'; statusEl.className = 'tool-card-status done'; }
  // Auto-expand when result arrives
  el.classList.add('expanded');
  const resultEl = el.querySelector(`#tool-result-${callId}`) || el.querySelector('.tool-card-result');
  if (resultEl && result) {
    const display = typeof result === 'string' ? result.substring(0, 4000) : JSON.stringify(result).substring(0, 4000);
    const fullLen = typeof result === 'string' ? result.length : JSON.stringify(result).length;
    if (fullLen > 4000) {
      resultEl.innerHTML = `
        <pre class="tool-result-truncated">${escapeHtml(display)}</pre>
        <button class="tool-expand-btn" onclick="this.previousElementSibling.classList.toggle('tool-result-truncated'); this.previousElementSibling.classList.toggle('tool-result-full'); this.textContent = this.previousElementSibling.classList.contains('tool-result-full') ? 'Show less' : 'Show more (${(fullLen - 4000).toLocaleString()} more chars)';">Show more (${(fullLen - 4000).toLocaleString()} more chars)</button>`;
      resultEl.classList.add('has-expand');
    } else {
      resultEl.innerHTML = `<pre>${escapeHtml(display)}</pre>`;
    }
  }
}

function updateStreamContent(contentDiv, fullContent, toolCards, messagesDiv, elapsed) {
  if (!contentDiv) return;
  // Guard: if contentDiv is no longer in the DOM (stream finalized), skip
  if (!document.contains(contentDiv)) return;
  // Use a dedicated text span for streaming content (avoid full DOM rebuild)
  let textSpan = contentDiv.querySelector('#gw-stream-text');
  if (!textSpan) {
    textSpan = document.createElement('span');
    textSpan.id = 'gw-stream-text';
    // Insert after any existing tool cards
    const lastCard = contentDiv.querySelector('.tool-call-card:last-of-type');
    if (lastCard && contentDiv.contains(lastCard) && lastCard.nextSibling && contentDiv.contains(lastCard.nextSibling)) {
      contentDiv.insertBefore(textSpan, lastCard.nextSibling);
    } else if (lastCard && contentDiv.contains(lastCard)) {
      lastCard.after(textSpan);
    } else {
      contentDiv.prepend(textSpan);
    }
  }
  if (fullContent !== null && fullContent !== undefined) {
    let html = renderChatContent(fullContent);
    if (elapsed) {
      html += `<div style="font-size:10px;color:var(--fg-subtle);margin-top:8px;">${elapsed}s</div>`;
    } else {
      html += '<span class="chat-cursor" style="animation:blink 1s infinite;">▊</span>';
    }
    textSpan.innerHTML = html;
  } else if (elapsed) {
    // Finalize: just add elapsed time
    const cursor = textSpan.querySelector('.chat-cursor');
    if (cursor) cursor.remove();
    textSpan.insertAdjacentHTML('beforeend', `<div style="font-size:10px;color:var(--fg-subtle);margin-top:8px;">${elapsed}s</div>`);
  }
  if (messagesDiv) messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function renderChatContent(text) {
  if (!text) return '';
  text = toDisplayText(text);

  // ── 1. Extract code blocks FIRST (before any escaping) ──
  const codeBlocks = [];
  let html = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    const id = codeBlocks.length;
    codeBlocks.push({ lang: lang || '', code: escapeHtml(code.trimEnd()) });
    return `\x00CODE${id}\x00`;
  });

  // ── 2. Escape everything outside code blocks ──
  html = escapeHtml(html);

  // ── 3. Markdown formatting (safe — text already escaped) ──
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h4 style="font-size:12px;font-weight:700;margin:8px 0 4px;color:var(--fg);">$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3 style="font-size:13px;font-weight:700;margin:10px 0 4px;color:var(--fg);">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 style="font-size:14px;font-weight:700;margin:12px 0 6px;color:var(--fg);">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 style="font-size:15px;font-weight:700;margin:14px 0 8px;color:var(--fg);">$1</h1>');
  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote style="border-left:3px solid var(--accent);padding-left:10px;margin:6px 0;color:var(--fg-subtle);">$1</blockquote>');
  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid var(--border);margin:10px 0;">');

  // ── 4. Restore code blocks ──
  codeBlocks.forEach((cb, i) => {
    const langClass = cb.lang ? `language-${cb.lang}` : '';
    const langLabel = cb.lang ? `<span style="position:absolute;top:4px;left:10px;font-size:9px;text-transform:uppercase;letter-spacing:0.06em;color:var(--fg-subtle);">${escapeHtml(cb.lang)}</span>` : '';
    html = html.replace(
      `\x00CODE${i}\x00`,
      `<pre style="position:relative;padding-top:22px;">${langLabel}<button class="code-copy-btn" onclick="copyCodeBlock(this)">Copy</button><code class="${langClass}">${cb.code}</code></pre>`
    );
  });

  // ── 5. Lists (process after code blocks restored) ──
  // Collect ALL list items first, then wrap adjacent ones in <ul>/<ol>
  const listReplacements = [];
  // Unordered: capture individual - items (non-greedy, won't eat across items)
  html = html.replace(/^- ([\s\S]*?)$/gm, (_, content) => {
    const id = listReplacements.length;
    listReplacements.push({ type: 'ul', content, id });
    return `\x00LISTITEM${id}\x00`;
  });
  // Ordered: capture individual 1. items
  html = html.replace(/^\d+\. ([\s\S]*?)$/gm, (_, content) => {
    const id = listReplacements.length;
    listReplacements.push({ type: 'ol', content, id });
    return `\x00LISTITEM${id}\x00`;
  });
  // Group consecutive same-type list items
  const grouped = [];
  for (const item of listReplacements) {
    const last = grouped[grouped.length - 1];
    if (last && last.type === item.type) {
      last.items.push(item.content);
    } else {
      grouped.push({ type: item.type, items: [item.content] });
    }
  }
  // Restore as <ul>/<ol>
  grouped.forEach((g, gi) => {
    const items = g.items.map((c, i) => `<li>${c}</li>`).join('');
    const tag = `<${g.type}>${items}</${g.type}>`;
    html = html.replace(`\x00LISTITEM${gi}\x00`, tag);
  });
  // Clean up any stray unreplaced list placeholders (shouldn't happen)
  html = html.replace(/\x00LISTITEM\d+\x00/g, '');

  // ── 6. Paragraphs ──
  // Split on double newlines, wrap each chunk in <p>
  const chunks = html.split(/(?:&lt;br&gt;){2,}|\n\n/).filter(Boolean);
  if (chunks.length > 1) {
    html = chunks.map(c => {
      const trimmed = c.trim();
      if (trimmed.startsWith('<pre') || trimmed.startsWith('<blockquote') || trimmed.startsWith('<h') || trimmed.startsWith('<hr') || trimmed.startsWith('<ul') || trimmed.startsWith('<li')) return c;
      return `<p>${trimmed}</p>`;
    }).join('');
  } else if (!html.startsWith('<') || html.startsWith('<em>') || html.startsWith('<strong>')) {
    html = `<p>${html}</p>`;
  }

  // Single line breaks inside paragraphs → <br>
  html = html.replace(/\n/g, '<br>');

  return html;
}

// Copy code block to clipboard
window.copyCodeBlock = function(btn) {
  const pre = btn.closest('pre');
  const code = pre.querySelector('code');
  const text = code.textContent;
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  }).catch(() => {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
};

// Apply syntax highlighting after DOM insertion
function highlightCodeBlocks(container) {
  if (typeof hljs === 'undefined') return;
  container.querySelectorAll('pre code:not(.hljs)').forEach(block => {
    try { hljs.highlightElement(block); } catch {}
  });
}

function createMessageDiv(role, content, optId) {
  const cls = { user: 'msg-user', assistant: 'msg-assistant' }[role] || 'msg-assistant';
  // Dedup: skip if exact user message with same content was sent in last 10s
  if (role === 'user' && isDuplicateUserMessage(content)) {
    console.warn('[Chat] Skipping duplicate user message');
    return document.createElement('div'); // empty, invisible
  }
  const div = document.createElement('div');
  div.className = `chat-msg ${cls}`;
  if (optId) div.dataset.optId = optId;
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = content;
  div.appendChild(body);
  return div;
}

/** 3-layer dedup buffer */
function addToDedupBuf(role, content) {
  if (!state._recentMessages) state._recentMessages = { buf: [], max: 20 };
  const b = state._recentMessages;
  b.buf.unshift({ role, content, ts: Date.now() });
  if (b.buf.length > b.max) b.buf.length = b.max;
}

/** Check if user message is a dupe within 10s / last 5 messages */
function isDuplicateUserMessage(content) {
  const b = state._recentMessages?.buf;
  if (!b?.length) return false;
  const win = 10000; // 10 seconds
  const recent = b.slice(0, 5);
  return recent.some(m => m.role === 'user' && m.content === content && Date.now() - m.ts < win);
}

/** Swap optimistic user message when server confirms session */
function swapOptimisticMessage(sessionId) {
  if (!state._currentChatSession && sessionId) {
    state._currentChatSession = sessionId;
  }
  if (state._optMessages?.size > 0) {
    // Clear optimistic markers once we have a real session
    for (const [optId, entry] of state._optMessages) {
      if (entry.el) entry.el.dataset.optId = '';
    }
    state._optMessages.clear();
  }
}

/** Update chat UI connection status indicator */
function updateWsConnectionUI(connected) {
  // Find or create the connection indicator in chat header
  let indicator = document.getElementById('ws-conn-indicator');
  if (!indicator) {
    // Create it — insert into chat-header-right area
    const header = document.getElementById('chat-header-right');
    if (header) {
      indicator = document.createElement('span');
      indicator.id = 'ws-conn-indicator';
      indicator.title = 'WebSocket connection';
      header.appendChild(indicator);
    }
  }
  if (indicator) {
    indicator.textContent = connected ? '🟢 ws' : '🔴 ws';
    indicator.title = connected ? 'WebSocket connected' : 'WebSocket disconnected — reconnecting...';
    indicator.style.cssText = 'font-size:10px;margin-left:6px;cursor:default;';
  }
  // Also update agent-status-indicator if it exists
  const agentIndicator = document.getElementById('agent-status-indicator');
  if (agentIndicator) {
    if (!connected) {
      agentIndicator.textContent = 'reconnecting';
      agentIndicator.className = 'status-busy';
    }
  }
}

/** Phase 3: Update gateway health badge in chat header */
async function updateGatewayBadge() {
  const badge = document.getElementById('chat-gateway-badge');
  if (!badge) return;
  const profile = document.getElementById('chat-profile')?.value || 'default';
  try {
    const res = await fetch(`/api/gateway/${encodeURIComponent(profile)}/health`);
    if (!res.ok) throw new Error('not ok');
    const data = await res.json();
    if (data.healthy && data.port) {
      badge.textContent = `🌐 ${data.port}`;
      badge.className = 'chat-header-badge badge-healthy';
      badge.title = `Gateway healthy — mode: ${data.gatewayMode}`;
    } else {
      badge.textContent = '⚠️ DOWN';
      badge.className = 'chat-header-badge badge-down';
      badge.title = (data.issues || []).join('; ');
    }
  } catch {
    badge.textContent = '⚠️ ERR';
    badge.className = 'chat-header-badge badge-down';
    badge.title = 'Gateway health check failed';
  }
}

/** Phase 3: Fork session from a specific message index */
async function forkFromMessage(msgIndex) {
  const sid = state._currentChatSession;
  if (!sid) return;
  const profile = document.getElementById('chat-profile')?.value || 'default';
  try {
    const res = await fetch(`/api/chat/fork?profile=${encodeURIComponent(profile)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': state.csrfToken || '' },
      credentials: 'include',
      body: JSON.stringify({ sessionId: sid, messageIndex: msgIndex }),
    });
    const data = await res.json();
    if (data.ok && data.newSessionId) {
      await refreshChatSidebar();
      await loadChatSession(data.newSessionId);
    } else {
      console.warn('[Fork] failed:', data.error);
    }
  } catch (e) {
    console.warn('[Fork] error:', e);
  }
}

/** Play a subtle completion sound when a chat response finishes */
function playChatComplete() {
  if (!state._soundEnabled) return;
  if (!state._soundEl) {
    try {
      state._soundEl = new (window.AudioContext || window.webkitAudioContext)();
      state._soundReady = true;
    } catch (e) {
      console.warn('[Chat] AudioContext not available:', e);
      return;
    }
  }
  try {
    const src = state._soundEl.createBufferSource();
    src.buffer = state._soundEl.createBuffer(1, state._soundEl.sampleRate * 0.12, state._soundEl.sampleRate);
    const data = src.buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / state._soundEl.sampleRate;
      const freq1 = 523, freq2 = 1047, beepDur = 0.06;
      const fade = Math.min(i, data.length - i) / (state._soundEl.sampleRate * 0.015);
      data[i] = (t < beepDur ? Math.sin(2 * Math.PI * freq1 * t) :
                t < beepDur * 2 ? 0 : Math.sin(2 * Math.PI * freq2 * (t - beepDur * 2)) * 0.6) * 0.2 * fade;
    }
    const gain = state._soundEl.createGain();
    gain.gain.value = 0.4;
    src.connect(gain);
    gain.connect(state._soundEl.destination);
    src.start();
  } catch (e) {
    console.warn('[Chat] Failed to play completion sound:', e);
  }
}

/** Toggle chat sound notifications */
function toggleChatSound() {
  state._soundEnabled = !state._soundEnabled;
  const btn = document.getElementById('chat-sound-btn');
  if (btn) btn.textContent = state._soundEnabled ? '🔔' : '🔕';
  if (state._soundEnabled && !state._soundEl) {
    try {
      state._soundEl = new (window.AudioContext || window.webkitAudioContext)();
      state._soundReady = true;
    } catch (e) { /* AudioContext blocked until user gesture */ }
  }
  return state._soundEnabled;
}

/** Update live "running tools" count indicator in chat header */
function updateToolCountUI() {
  const count = state._wsToolCount || 0;
  let indicator = document.getElementById('tool-count-indicator');
  if (!indicator) {
    const header = document.getElementById('chat-header-right');
    if (header) {
      indicator = document.createElement('span');
      indicator.id = 'tool-count-indicator';
      header.appendChild(indicator);
    }
  }
  if (indicator) {
    if (count > 0) {
      indicator.textContent = `🔨 ${count} tool${count > 1 ? 's' : ''} running`;
      indicator.style.cssText = 'font-size:10px;margin-left:6px;color:var(--gold);cursor:default;';
    } else {
      indicator.textContent = '';
    }
  }
}

/** Render an artifact card from the gateway */
function handleArtifact(artifact) {
  if (!artifact) return;
  const messagesDiv = document.getElementById('chat-messages');
  if (!messagesDiv) return;
  const type = artifact.type || 'file';
  const name = artifact.name || 'artifact';
  const description = artifact.description || '';
  const content = artifact.content || '';
  const language = artifact.language || '';

  const card = document.createElement('div');
  card.className = 'artifact-card';
  card.innerHTML = `
    <div class="artifact-header" onclick="this.parentElement.classList.toggle('expanded')">
      <span class="artifact-icon">${type === 'code' ? '💻' : type === 'image' ? '🖼️' : type === 'text' ? '📄' : '📦'}</span>
      <span class="artifact-name">${escapeHtml(name)}</span>
      ${description ? `<span class="artifact-desc">${escapeHtml(description)}</span>` : ''}
      <span class="artifact-chevron">▶</span>
    </div>
    <div class="artifact-body">
      ${content ? `<pre class="artifact-content ${language ? 'language-' + escapeHtml(language) : ''}">${escapeHtml(content.substring(0, 8000))}</pre>` : '<div class="artifact-empty">No content</div>'}
    </div>`;
  messagesDiv.appendChild(card);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  state._artifactCount = (state._artifactCount || 0) + 1;
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
      <div class="card" id="home-gateways"><div class="card-title">Gateways</div><div class="loading">Loading</div></div>
      <div class="card">
        <div class="card-title">Hermes Auth</div>
        <div id="home-auth-list"><div class="loading">Loading auth...</div></div>
      </div>
    </div>
  `;

  try {
    const [monRes, profilesRes, agentRes, cronRes] = await Promise.all([
      api('/api/monitoring'),
      api('/api/profiles'),
      api('/api/agent/status'),
      api('/api/cron/list', { method: 'POST', body: '{}' }),
    ]);

    // Row 1: System Health + Agent Overview (merged)
    const cardsEl = document.getElementById('home-cards');
    if (monRes.ok) {
      const m = monRes;
      cardsEl.innerHTML = `
        <div class="card">
          <div class="card-title">System Health</div>
          <div class="stat-row"><span class="stat-label">CPU</span><span class="stat-value">${m.cpu || 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">RAM</span><span class="stat-value">${m.memory || 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">Disk</span><span class="stat-value">${m.disk || 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">Load</span><span class="stat-value">${m.load ? `${m.load.avg1}, ${m.load.avg5}, ${m.load.avg15}` : 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">Processes</span><span class="stat-value">${m.processes || 0}</span></div>
          <div class="stat-row"><span class="stat-label">Uptime</span><span class="stat-value">${m.uptime || 'N/A'}</span></div>
        </div>
        <div class="card">
          <div class="card-title">System Details</div>
          <div class="stat-row"><span class="stat-label">Network</span><span class="stat-value">${m.network ? `${m.network.interface} (${formatNumber(m.network.bytes)}B)` : 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">Node RSS</span><span class="stat-value">${m.node_memory ? `${m.node_memory.rss_mb} MB` : 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">Heap Used</span><span class="stat-value">${m.node_memory ? `${m.node_memory.heap_used_mb}/${m.node_memory.heap_total_mb} MB` : 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">Hermes</span><span class="stat-value">${m.hermes_version || 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">HCI</span><span class="stat-value">${m.hci_version || 'N/A'}</span></div>
          <div class="stat-row"><span class="stat-label">Node.js</span><span class="stat-value">${m.node_version || 'N/A'}</span></div>
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
    } else if (healthRes.ok) {
      // Fallback to /api/system/health if /api/monitoring fails
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

    // Row 2: Gateways (update only this card, don't replace entire grid)
    const profiles = profilesRes.ok && profilesRes.profiles ? profilesRes.profiles : [];
    const gwHtml = profiles.map(p => {
      const cls = p.gateway === 'running' ? 'status-ok' : 'status-off';
      const txt = p.gateway === 'running' ? '● running' : '○ stopped';
      return `<div class="stat-row"><span class="stat-label">${p.name}</span><span class="stat-value ${cls}">${txt}</span></div>`;
    }).join('');
    const gwCard = document.getElementById('home-gateways');
    if (gwCard) {
      gwCard.innerHTML = `<div class="card-title">Gateways</div>${gwHtml || '<div class="stat-row"><span class="stat-label">No profiles</span></div>'}`;
    }

    // Load auth into home
    loadHomeAuth();

  } catch (e) {
    document.getElementById('home-cards').innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
  }
}

async function hcirestart() {
  if (!await customConfirm('Restart HCI? This will take ~2 seconds.', 'Restart')) return;
  try {
    const csrfToken = state.csrfToken || '';
    const res = await api('/api/hci-restart', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } });
    if (res.ok) {
      showToast('HCI restarting...', 'success');
      // Wait 5s for server to come back up before reload (avoids 502)
      setTimeout(() => location.reload(), 5000);
    } else {
      showToast(res.error || 'Restart failed', 'error');
    }
  } catch (e) { showToast('Restart failed: ' + e.message, 'error'); }
}

async function hciupdate() {
  if (!await customConfirm('Update HCI? This will git pull, npm install, and rebuild (~30s).', 'Update')) return;
  await sseProgressModal('⬆ Updating HCI', '/api/hci/update', {
    headers: { 'X-CSRF-Token': state.csrfToken || '' },
    autoCloseMs: 2000,
    onSuccess: () => { setTimeout(() => location.reload(), 4000); },
  });
}

function closeModal() {
  document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
}

async function runHCIUpdate() {
  if (!await customConfirm('Update HCI? This will git pull, npm install, and rebuild (~30s).', 'Update')) return;
  await sseProgressModal('⬆ Updating HCI', '/api/hci/update', {
    headers: { 'X-CSRF-Token': state.csrfToken || '' },
    autoCloseMs: 2000,
    onSuccess: () => { setTimeout(() => location.reload(), 4000); },
  });
}

// Silent update — just fetches and updates version/commit/branch/behind badge (no modal)
async function updateHCIInfo() {
  try {
    const res = await api('/api/hci/check-update');
    if (!res.ok) return;
    const versionEl = document.getElementById('hci-current-version');
    if (versionEl) versionEl.textContent = res.local.version || '—';
    const hashEl = document.getElementById('hci-current-commit');
    if (hashEl) hashEl.textContent = res.local.hash || '—';
    const branchEl = document.getElementById('hci-current-branch');
    if (branchEl) branchEl.textContent = res.branch || '—';
    const behindEl = document.getElementById('hci-commits-behind');
    if (behindEl) behindEl.textContent = res.behind;
    const behindBadge = document.getElementById('hci-behind-badge');
    if (behindBadge) behindBadge.style.display = res.behind > 0 ? '' : 'none';
    // Store for modal use
    state._hciUpdateInfo = res;
  } catch {}
}

// Explicit check — fetches + shows modal (used by "Check Updates" button)
async function checkHCIUpdates() {
  await updateHCIInfo();
  const res = state._hciUpdateInfo;
  if (!res || !res.ok) { showModal({ title: 'Error', message: res?.error || 'Failed to check updates', buttons: [{ text: 'OK', value: true }] }); return; }
  if (res.behind > 0) {
    showCommitListModal(res);
  } else {
    showModal({
      title: 'Up to Date',
      message: `Already at latest commit on ${res.branch}.`,
      buttons: [{ text: 'OK', value: true }],
    });
  }
}

function showCommitListModal(data) {
  const commitsHtml = data.commits.map((c, i) => `
    <div class="commit-card" data-hash="${c.hash}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <code class="commit-hash">${c.shortHash}</code>
        <span style="flex:1;font-weight:600;font-size:13px;">${escapeHtml(c.msg)}</span>
        <button class="btn btn-xs btn-outline" onclick="showCommitDiff('${c.shortHash}')">Diff</button>
        <button class="btn btn-xs btn-primary" onclick="checkoutCommit('${c.shortHash}')">Checkout</button>
      </div>
      <div style="font-size:11px;color:var(--fg-muted);">
        ${escapeHtml(c.author)} · ${formatRelativeTime(c.date)}
      </div>
    </div>
  `).join('');

  showModal({
    title: `${data.behind} commit(s) behind on ${data.branch}`,
    message: `<div class="commit-list-container">${commitsHtml}</div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
        <button class="btn btn-primary" onclick="runHCIUpdate(); closeModal();">Update All (pull latest)</button>
      </div>`,
    buttons: [{ text: 'Close', value: false }],
  });
}

async function showCommitDiff(hash) {
  const res = await api(`/api/hci/commit/${hash}/diff`);
  if (!res.ok) { showModal({ title: 'Error', message: res.error, buttons: [{ text: 'OK', value: true }] }); return; }
  showModal({
    title: `${res.commit.shortHash}: ${res.commit.msg}`,
    message: `
      <div style="margin-bottom:8px;font-size:12px;color:var(--fg-muted);">${escapeHtml(res.commit.author)} · ${formatRelativeTime(res.commit.date)}</div>
      <div style="margin-bottom:8px;font-weight:600;font-size:12px;">${escapeHtml(res.shortstat)}</div>
      <div class="diff-files-list">${res.files.map(f => `
        <div style="display:flex;gap:8px;font-size:12px;padding:2px 0;">
          <span style="color:var(--green);">+${f.added}</span>
          <span style="color:var(--coral);">-${f.removed}</span>
          <span style="flex:1;font-family:monospace;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(f.file)}</span>
        </div>
      `).join('')}</div>`,
    buttons: [{ text: 'Close', value: true }],
  });
}

async function checkoutCommit(hash) {
  const confirmed = await showModal({
    title: 'Checkout Commit',
    message: `Checkout to <code>${hash}</code>? This will run npm install and rebuild.<br><br><strong>The server will restart.</strong>`,
    buttons: [
      { text: 'Cancel', value: false },
      { text: 'Checkout', value: true, primary: true },
    ],
  });
  if (!confirmed?.action) return;
  runUpdateStream(`/api/hci/update/commit/${hash}`);
}

// Reusable SSE stream handler for update endpoints
async function runUpdateStream(endpoint) {
  // Show progress modal
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'hci-update-progress';
  overlay.innerHTML = `<div class="modal-card" style="max-width:600px;">
    <div class="modal-header"><h3>HCI Update</h3>
      <button class="btn btn-xs btn-ghost" onclick="this.closest('.modal-overlay').remove()">✕</button>
    </div>
    <div class="modal-body">
      <pre id="hci-update-log" style="max-height:400px;overflow-y:auto;font-size:12px;font-family:var(--font-mono);background:var(--bg-input);padding:12px;border-radius:8px;white-space:pre-wrap;"></pre>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const logEl = document.getElementById('hci-update-log');
  let completed = false;

  // Safety timeout — 120s
  const safetyTimeout = setTimeout(() => {
    if (!completed) {
      logEl.textContent += '\n⚠ Update timed out. You may need to restart manually.';
    }
  }, 120000);

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
    const res = await fetch(endpoint, { method: 'POST', headers, body: '{}' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'progress') logEl.textContent += evt.line + '\n';
          if (evt.type === 'warning') logEl.textContent += '⚠ ' + evt.line + '\n';
          if (evt.type === 'error') logEl.textContent += '❌ ' + evt.message + '\n';
          if (evt.type === 'done') {
            completed = true;
            logEl.textContent += '\n✅ ' + evt.message;
            setTimeout(() => location.reload(), 2000);
          }
          logEl.scrollTop = logEl.scrollHeight;
        } catch {}
      }
    }
  } catch (e) {
    logEl.textContent += '\n❌ Connection error: ' + e.message;
  }
  clearTimeout(safetyTimeout);
}

async function hcidoctor() {
  if (!await customConfirm('Run diagnostics? This will check all Hermes components.', 'Diagnostics')) return;
  await sseProgressModal('🩺 Running Diagnostics', '/api/doctor', {
    method: 'POST',
    headers: { 'X-CSRF-Token': state.csrfToken || '' },
    autoCloseMs: 5000,
  });
}

async function loadHomeAuth() {
  try {
    const res = await api('/api/auth/providers');
    const el = document.getElementById('home-auth-list');
    if (!el) return;
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
    const el = document.getElementById('home-auth-list');
    if (el) el.innerHTML = '<div class="stat-row"><span class="stat-label">Auth info unavailable</span></div>';
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
    document.getElementById('agents-grid').innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
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
  if (!await customConfirm(`Set "${name}" as default profile?`, 'Set Default')) return;
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
        <button class="btn btn-primary" onclick="openTerminalPanel('Terminal ${name}', '${name} --tui')">⌘ Terminal</button>
        <button class="btn btn-ghost" onclick="navigate('agents')">← Back</button>
      </div>
    </div>
    <div class="tabs" id="agent-tabs">
      <button class="tab active" data-tab="dashboard">Dashboard</button>
      <button class="tab" data-tab="sessions">Sessions</button>
      <button class="tab" data-tab="gateway">Gateway</button>
      <button class="tab" data-tab="config">Config</button>
      <button class="tab" data-tab="memory">Memory</button>
      <button class="tab" data-tab="skills">Skills</button>
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
    case 'skills': await loadAgentSkills(content, profileName); break;
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
    container.innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
  }
}

window.loadAgentSkills = async function(container, name) {
  container.innerHTML = `<div class="loading">Loading skills for ${name}...</div>`;

  try {
    const res = await api(`/api/skills/list/${name}`);
    const output = res.ok ? res.output : (res.error || 'Failed to load');

    // Parse skills from output — handle box-drawing chars, skip headers/separators
    const skills = [];
    const lines = output.split('\n');
    const skillPattern = /[│┃]\s*([^\s│┃][^\s│┃]*)\s*[│┃]\s*([^│┃]*?)\s*[│┃]\s*(\S+)\s*[│┃]\s*(\S+)\s*[│┃]/;
    for (const line of lines) {
      // Skip separator lines (┏━┗) and header row
      if (line.includes('┏') || line.includes('┗') || line.includes('┡') || line.includes('┩') || line.includes('╍')) continue;
      const match = line.match(skillPattern);
      if (match) {
        const name = match[1].trim();
        if (!name || name === 'Name' || name === '#') continue;
        skills.push({
          name,
          category: match[2].trim(),
          source: match[3].trim(),
          trust: match[4].trim(),
        });
      }
    }

    let skillsHtml = '';
    if (skills.length > 0) {
      skillsHtml = '<div class="card-grid">' + skills.map(s => `
        <div class="card">
          <div class="card-title">${escapeHtml(s.name)}</div>
          <div style="font-size:12px;color:var(--fg-muted);margin-top:4px;">${escapeHtml(s.category || '')}</div>
          <div style="margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <span class="badge" style="font-size:10px;">${escapeHtml(s.source)}</span>
            ${s.trust ? `<span class="badge" style="font-size:10px;opacity:0.7;">${escapeHtml(s.trust)}</span>` : ''}
          </div>
          <div style="margin-top:10px;display:flex;gap:6px;">
            <button class="btn btn-ghost btn-sm" onclick="window.updateSkill('${escapeHtml(s.name)}','${escapeHtml(name)}')">🔄 Update</button>
            <button class="btn btn-danger btn-sm" onclick="window.uninstallSkill('${escapeHtml(s.name)}','${escapeHtml(name)}')">🗑️ Uninstall</button>
          </div>
        </div>
      `).join('') + '</div>';
    } else {
      skillsHtml = `<div class="card"><div class="card-title">No skills installed</div><div style="margin-top:8px;"><a href="#" onclick="window.loadSkills(document.querySelector('.page.active'));return false;" style="color:var(--accent);">Browse Skills Hub →</a></div></div>`;
    }

    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <div style="font-size:14px;color:var(--fg-muted);">${skills.length} skill(s) installed</div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-ghost btn-sm" onclick="window.checkSkillUpdates('${escapeHtml(name)}')">🔍 Check Updates</button>
          <button class="btn btn-ghost btn-sm" onclick="window.loadAgentSkills(document.getElementById('agent-tab-content'), '${escapeHtml(name)}')">↻ Refresh</button>
        </div>
      </div>
      ${skillsHtml}
      <details style="margin-top:16px;">
        <summary style="cursor:pointer;color:var(--fg-muted);font-size:12px;padding:8px 0;">Raw Output</summary>
        <pre style="background:var(--bg-inset);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:10px;line-height:1.4;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto;color:var(--fg-muted);">${escapeHtml(output)}</pre>
      </details>
    `;
  } catch (e) {
    container.innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
  }
}

window.updateSkill = async function(skillName, profile) {
  if (!await customConfirm(`Update skill "${skillName}" on ${profile}?`, 'Update Skill')) return;
  try {
    const res = await api('/api/skills/update', { method: 'POST', body: JSON.stringify({ skill: skillName, profile }) });
    showToast(res.ok ? 'Skill updated!' : (res.output || 'Update failed'), res.ok ? 'success' : 'error');
    if (res.ok) window.loadAgentSkills(document.getElementById('agent-tab-content'), profile);
  } catch (e) { showToast(e.message, 'error'); }
}

window.uninstallSkill = async function(skillName, profile) {
  const result = await showModal({
    title: 'Uninstall Skill',
    message: `Are you sure you want to uninstall "${skillName}" from ${profile}?`,
    buttons: [
      { text: 'Cancel', value: false },
      { text: 'Uninstall', value: true, primary: true },
    ],
  });
  if (!result?.action) return;
  try {
    const res = await api('/api/skills/uninstall', { method: 'POST', body: JSON.stringify({ skill: skillName, profile }) });
    showToast(res.ok ? 'Skill uninstalled!' : (res.output || 'Uninstall failed'), res.ok ? 'success' : 'error');
    if (res.ok) window.loadAgentSkills(document.getElementById('agent-tab-content'), profile);
  } catch (e) { showToast(e.message, 'error'); }
}

window.checkSkillUpdates = async function(profile) {
  try {
    showToast('Checking for updates...', 'info');
    const res = await api('/api/skills/check', { method: 'POST', body: JSON.stringify({ profile }) });
    if (res.ok && res.output) {
      const updates = parseSkillTable(res.output);
      if (updates.length === 0) {
        await customAlert('All skills are up to date!', 'Skill Updates');
      } else {
        let html = '<div style="max-height:400px;overflow-y:auto;">';
        for (const u of updates) {
          const statusColor = u.trust === 'up_to_date' ? 'var(--green)' : 'var(--amber)';
          html += `<div style="padding:8px;border-bottom:1px solid var(--border);">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="font-weight:600;color:var(--fg);">${escapeHtml(u.name)}</span>
              <span style="color:${statusColor};font-size:11px;">${escapeHtml(u.trust || u.source)}</span>
            </div>
            <div style="font-size:11px;color:var(--fg-muted);margin-top:2px;">${escapeHtml(u.source)} — ${escapeHtml(u.description)}</div>
          </div>`;
        }
        html += '</div>';
        await showModal({ title: 'Skill Updates', message: html, buttons: [{ text: 'Close', primary: true }] });
      }
    } else if (!res.ok) {
      await customAlert(res.error || 'Check failed', 'Error');
    } else if (res.output && res.output.includes('unavailable')) {
      // Skills exist but source is unavailable — not an error, show info
      await customAlert('Some installed skills could not be checked (source unavailable). This does not indicate an update is needed.', 'Skill Updates');
    } else if (!res.output || res.output.includes('0 update') || res.output.includes('up to date')) {
      await customAlert('All skills are up to date!', 'Skill Updates');
    } else {
      // Has updates
      const updates = parseSkillTable(res.output);
      let html = '<div style="max-height:400px;overflow-y:auto;">';
      for (const u of updates) {
        const statusColor = u.trust === 'up_to_date' ? 'var(--green)' : 'var(--amber)';
        html += `<div style="padding:8px;border-bottom:1px solid var(--border);">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:600;color:var(--fg);">${escapeHtml(u.name)}</span>
            <span style="color:${statusColor};font-size:11px;">${escapeHtml(u.trust || u.source)}</span>
          </div>
          <div style="font-size:11px;color:var(--fg-muted);margin-top:2px;">${escapeHtml(u.source)} — ${escapeHtml(u.description)}</div>
        </div>`;
      }
      html += '</div>';
      await showModal({ title: 'Skill Updates', message: html, buttons: [{ text: 'Close', primary: true }] });
    }
  } catch (e) { showToast(e.message, 'error'); }
}
async function loadAgentSessions(container, name) {
  container.innerHTML = `
    <div class="card-grid" style="margin-bottom:16px;">
      <div class="card" id="session-stats-${name}">
        <div class="card-title">Session Stats</div>
        <div class="loading">Loading stats...</div>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:16px;align-items:center;">
      <input type="text" id="session-search" class="search-input" placeholder="Search sessions..." style="flex:1;" />
      <button class="btn btn-ghost" id="session-refresh-btn">↻ Refresh</button>
    </div>
    <div id="sessions-table">
      <div class="loading">Loading sessions...</div>
    </div>
  `;

  const refreshBtn = document.getElementById('session-refresh-btn');
  let currentPage = 0;
  const PAGE_SIZE = 50;

  async function fetchAndRender() {
    currentPage = 0;
    const tableEl = document.getElementById('sessions-table');
    tableEl.innerHTML = '<div class="loading">Loading sessions for ' + escapeHtml(name) + '...</div>';
    loadSessionStats(name);

    try {
      const res = await api(`/api/all-sessions?profile=${encodeURIComponent(name)}`);
      if (!res.ok || !res.sessions || res.sessions.length === 0) {
        tableEl.innerHTML = '<div class="card"><div class="card-title">No sessions found</div></div>';
        state.currentSessions = [];
        return;
      }
      state.currentSessions = res.sessions;
      renderSessions('');
    } catch (e) {
      tableEl.innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
    }
  }

  function renderSessions(filter = '') {
    const sessions = state.currentSessions || [];
    const filterText = toDisplayText(filter).toLowerCase();
    const filtered = filterText
      ? sessions.filter(s =>
          toDisplayText(s.title).toLowerCase().includes(filterText) ||
          toDisplayText(s.id).toLowerCase().includes(filterText) ||
          toDisplayText(s.source).toLowerCase().includes(filterText)
        )
      : sessions;

    const tableEl = document.getElementById('sessions-table');
    if (filtered.length === 0) {
      tableEl.innerHTML = '<div class="card"><div class="card-title">No matching sessions</div></div>';
      return;
    }

    const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
    const page = Math.min(currentPage, totalPages - 1);
    const start = page * PAGE_SIZE;
    const pageItems = filtered.slice(start, start + PAGE_SIZE);

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
            ${pageItems.map(s => `
              <tr class="session-row" data-sid="${s.id}">
                <td class="mono" style="font-size:11px;">${s.id || '—'}</td>
                <td>${escapeHtml(s.title || 'Untitled')}</td>
                <td><span class="badge">${s.source || '—'}</span></td>
                <td>${s.messageCount ?? s.message_count ?? '—'}</td>
                <td style="font-size:11px;color:var(--fg-muted);">${s.updated_at ? new Date(s.updated_at).toLocaleDateString() : '—'}</td>
                <td>
                  <div style="display:flex;gap:4px;">
                    <button class="btn btn-ghost btn-sm" onclick="toggleSessionDetail(this, '${s.id}', '${name}')" title="View messages">👁</button>
                    <button class="btn btn-ghost btn-sm" onclick="resumeSession('${s.id}')" title="Resume in CLI">▶</button>
                    <button class="btn btn-ghost btn-sm" onclick="renameSession('${s.id}', '${name}')" title="Rename">✎</button>
                    <button class="btn btn-ghost btn-sm" onclick="exportSession('${s.id}')" title="Export">↓</button>
                    <button class="btn btn-ghost btn-sm btn-danger" onclick="deleteSession('${s.id}', '${name}')" title="Delete">×</button>
                  </div>
                </td>
              </tr>
              <tr class="session-detail-row" data-detail="${s.id}" style="display:none;">
                <td colspan="6" id="session-detail-${s.id}" style="padding:0;border:0;"></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
        <div style="font-size:11px;color:var(--fg-muted);">
          ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length} sessions
        </div>
        ${totalPages > 1 ? `
          <div style="display:flex;gap:4px;">
            <button class="btn btn-ghost btn-sm" ${page <= 0 ? 'disabled style="opacity:0.3;"' : ''} id="sessions-prev">← Prev</button>
            <span style="font-size:11px;color:var(--fg-muted);padding:4px 8px;">${page + 1} / ${totalPages}</span>
            <button class="btn btn-ghost btn-sm" ${page >= totalPages - 1 ? 'disabled style="opacity:0.3;"' : ''} id="sessions-next">Next →</button>
          </div>
        ` : ''}
      </div>
    `;

    // Pagination handlers
    document.getElementById('sessions-prev')?.addEventListener('click', () => {
      if (currentPage > 0) { currentPage--; renderSessions(document.getElementById('session-search')?.value?.toLowerCase() || ''); }
    });
    document.getElementById('sessions-next')?.addEventListener('click', () => {
      if (currentPage < totalPages - 1) { currentPage++; renderSessions(document.getElementById('session-search')?.value?.toLowerCase() || ''); }
    });
  }

  // Agent selector change

  // Refresh button
  refreshBtn?.addEventListener('click', () => fetchAndRender());

  // Search handler
  document.getElementById('session-search')?.addEventListener('input', (e) => {
    currentPage = 0;
    renderSessions(e.target.value.toLowerCase());
  });

  // Initial load
  await fetchAndRender();
}

async function toggleSessionDetail(btn, sessionId, profile) {
  const detailRow = document.querySelector(`[data-detail="${sessionId}"]`);
  if (!detailRow) return;

  // Toggle visibility
  if (detailRow.style.display !== 'none') {
    detailRow.style.display = 'none';
    return;
  }

  detailRow.style.display = '';
  const cell = document.getElementById(`session-detail-${sessionId}`);
  cell.innerHTML = '<div class="loading" style="padding:16px;">Loading messages...</div>';

  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages?profile=${encodeURIComponent(profile)}&offset=0&limit=50`, { credentials: 'include' });
    if (!r.ok) { cell.innerHTML = '<div class="error-msg" style="padding:16px;">Failed to load messages</div>'; return; }
    const data = await r.json();
    if (!data.messages || data.messages.length === 0) {
      cell.innerHTML = '<div style="color:var(--fg-muted);padding:16px;">No messages in this session</div>';
      return;
    }

    let html = `<div style="padding:12px 16px;background:var(--bg-panel);border-radius:0 0 8px 8px;border:1px solid var(--border);border-top:0;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <span style="font-size:13px;font-weight:600;color:var(--fg);">${escapeHtml(data.title || 'Session ' + sessionId)}</span>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('tr').style.display='none'">✕ Close</button>
      </div>
      <div style="max-height:400px;overflow-y:auto;">`;

    for (const m of data.messages) {
      const roleColors = {
        user: { bg: 'var(--accent-dim)', border: 'var(--accent)' },
        assistant: { bg: 'var(--bg-card)', border: 'var(--green, #4ade80)' },
        tool: { bg: 'rgba(251,146,60,0.08)', border: '#fb923c' },
        tool_result: { bg: 'rgba(251,146,60,0.08)', border: '#fb923c' },
        system: { bg: 'rgba(156,163,175,0.08)', border: '#9ca3af' },
      };
      const rc = roleColors[m.role] || roleColors.system;
      const ts = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      let content = toDisplayText(m.content);
      content = content.replace(/Resume this session with:.*$/gm, '');
      content = content.replace(/^Session:\s*\d+.*$/gm, '');
      content = content.replace(/^Duration:.*$/gm, '');
      content = content.replace(/^-{10,}$/gm, '');
      content = content.trim();

      html += `<div style="margin-bottom:6px;padding:8px 10px;border-radius:6px;background:${rc.bg};border-left:3px solid ${rc.border};">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span style="font-size:10px;font-weight:600;text-transform:uppercase;color:var(--fg-muted);">${m.role || 'unknown'}</span>
          ${ts ? `<span style="font-size:10px;color:var(--fg-subtle);">${ts}</span>` : ''}
        </div>
        <div style="font-size:12px;line-height:1.5;color:var(--fg);white-space:pre-wrap;word-break:break-word;">${escapeHtml(content).substring(0, 2000)}${content.length > 2000 ? '\n... (truncated)' : ''}</div>
      </div>`;
    }
    html += '</div></div>';
    cell.innerHTML = html;
  } catch (e) {
    cell.innerHTML = '<div class="error-msg" style="padding:16px;">' + escapeHtml(e.message) + '</div>';
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
  const agent = state.currentAgent || state._defaultProfile || 'default';
  const cmd = `${agent} --tui -r ${sessionId}`;
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
    bodyEl.innerHTML = `<div style="color:var(--red);padding:20px;">Failed to load terminal: ${escapeHtml(e.message)}</div>`;
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
  if (!await customConfirm(`Export session ${sessionId} as JSON?`, 'Export Session')) return;
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
      <div id="gateway-health" style="margin-bottom:12px;">
        <div class="loading">Checking gateway health...</div>
      </div>
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
    `;

    // Load connections
    loadGatewayConnections(name);
    // Load health check
    renderGatewayHealth(document.getElementById('gateway-health'), name);

  } catch (e) {
    container.innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
  }
}

async function renderGatewayHealth(container, profile) {
  if (!container) return;
  try {
    const res = await api(`/api/gateway/${profile}/health`);
    if (!res.ok) { container.innerHTML = '<div class="error-msg">Failed to check health</div>'; return; }

    const statusIcon = res.healthy ? '🟢' : '🔴';
    const statusText = res.healthy ? 'Healthy' : 'Issues Found';

    let html = `<div class="gateway-health-card">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
        <span style="font-size:20px;">${statusIcon}</span>
        <div>
          <div style="font-weight:600;font-size:14px;">${statusText}</div>
          <div style="font-size:12px;color:var(--fg-muted);">Profile: ${profile} · Port: ${res.port || 'N/A'} · Mode: ${res.gatewayMode}</div>
        </div>
      </div>`;

    // Checks list
    html += '<div class="health-checks">';
    for (const [key, value] of Object.entries(res.checks)) {
      const icon = value ? '✅' : '❌';
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      html += `<div class="health-check-row">${icon} <span>${label}</span></div>`;
    }
    html += '</div>';

    // Issues
    if (res.issues.length > 0) {
      html += '<div class="health-issues" style="margin-top:8px;">';
      for (const issue of res.issues) {
        html += `<div class="health-issue">⚠️ ${escapeHtml(issue)}</div>`;
      }
      html += '</div>';
    }

    // Auto-fix button
    if (!res.healthy) {
      html += `<div style="margin-top:12px;">
        <button class="btn btn-primary btn-sm" onclick="fixGateway('${profile}')">🔧 Auto-Fix</button>
      </div>`;
    }

    html += '</div>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = '<div class="error-msg">Health check failed</div>';
  }
}

async function fixGateway(profile) {
  const confirmed = await showModal({
    title: 'Fix Gateway',
    message: `Restart gateway service for profile <code>${profile}</code>?`,
    buttons: [
      { text: 'Cancel', value: false },
      { text: 'Restart', value: true, primary: true },
    ],
  });
  if (!confirmed?.action) return;

  try {
    const res = await api(`/api/gateway/${profile}/start`, { method: 'POST' });
    if (res.ok) {
      showToast('Gateway restarted', 'success');
      // Re-check health after a moment
      setTimeout(() => {
        const el = document.getElementById('gateway-health');
        if (el) renderGatewayHealth(el, profile);
      }, 3000);
    } else {
      showToast('Failed: ' + (res.error || 'unknown'), 'error');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

window.fixGateway = fixGateway;

async function loadGatewayConnections(name) {
  const el = document.getElementById(`gateway-connections-${name}`);
  if (!el) return;
  try {
    const res = await api(`/api/gateway/${name}/connections`);
    if (!res.ok || !res.platforms?.length) {
      el.innerHTML = '<div class="stat-row"><span class="stat-label">No platform data</span></div>';
      return;
    }
    el.innerHTML = res.platforms.map(p => {
      const icon = p.connected ? '●' : '○';
      const statusClass = p.connected ? 'status-ok' : 'status-off';
      const detail = p.detail ? ` <span style="font-size:10px;color:var(--fg-muted);">${escapeHtml(p.detail)}</span>` : '';
      return `<div class="stat-row"><span class="stat-label">${escapeHtml(p.name)}</span><span class="stat-value ${statusClass}">${icon} ${p.connected ? 'connected' : 'not configured'}${detail}</span></div>`;
    }).join('');
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
    viewer.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
  }
}

async function gatewayAction(profile, action) {
  const messages = { start: `Start gateway for ${profile}?`, stop: `Stop gateway for ${profile}?`, restart: `Restart gateway for ${profile}? This may interrupt active sessions.` };
  if (!await customConfirm(messages[action] || `${action} gateway for ${profile}?`, action.charAt(0).toUpperCase() + action.slice(1) + ' Gateway')) return;
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

// Generic SSE progress modal — opens modal, streams SSE, auto-closes
async function sseProgressModal(title, url, options = {}) {
  const { method = 'POST', headers = {}, body, autoCloseMs = 3000, onSuccess, onError } = options;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal-card" style="width:520px;max-width:90vw;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div class="modal-title" style="margin:0;">${title}</div>
        <button class="sse-modal-close" style="display:none;padding:4px 12px;font-size:11px;background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg-muted);cursor:pointer;">✕ Close</button>
      </div>
      <div class="sse-progress-log" style="margin:12px 0;font-family:var(--font-mono,monospace);font-size:12px;line-height:1.8;max-height:300px;overflow-y:auto;background:var(--bg-inset);border-radius:6px;padding:12px;color:var(--fg-muted);white-space:pre-wrap;"></div>
      <div class="sse-progress-status" style="font-size:11px;color:var(--fg-muted);">Starting...</div>
    </div>`;
  document.body.appendChild(overlay);

  const logEl = overlay.querySelector('.sse-progress-log');
  const statusEl = overlay.querySelector('.sse-progress-status');
  const closeBtn = overlay.querySelector('.sse-modal-close');
  const addLine = (text) => { logEl.textContent += text + '\n'; logEl.scrollTop = logEl.scrollHeight; };

  // Close button handler
  closeBtn.onclick = () => overlay.remove();

  // Safety timeout — auto-close after 120s even if no event received
  const safetyTimeout = setTimeout(() => {
    statusEl.textContent = '⚠ Timed out — closing';
    statusEl.style.color = 'var(--amber)';
    closeBtn.style.display = '';
    setTimeout(() => overlay.remove(), 3000);
  }, 120000);

  try {
    const fetchOpts = { method, headers, credentials: 'include' };
    if (body) fetchOpts.body = body;
    const res = await fetch(url, fetchOpts);

    // Fallback for non-SSE responses (e.g. multer errors)
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      const errMsg = data.error || data.message || 'Failed';
      statusEl.textContent = '❌ ' + errMsg;
      statusEl.style.color = 'var(--danger)';
      if (onError) onError(data);
      setTimeout(() => overlay.remove(), 3000);
      return;
    }

    // SSE streaming
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'progress') {
            const text = data.line.replace(/\r/g, '');
            statusEl.textContent = text;
            statusEl.style.color = 'var(--accent)';
            addLine(text);
          } else if (data.type === 'done') {
            statusEl.textContent = '✅ Complete!';
            statusEl.style.color = 'var(--success)';
            if (data.output) {
              // Show summary lines
              const summary = data.output.split('\n').filter(l =>
                l.includes('complete') || l.includes('Complete') || l.includes('restored') ||
                l.includes('Files:') || l.includes('Compressed:') || l.includes('Time:') ||
                l.includes('Original:') || l.includes('Target:') || l.includes('Profile')
              ).join('\n');
              if (summary) addLine('\n' + summary);
            }
            if (data.message) addLine(data.message);
            if (data.path) {
              const a = document.createElement('a');
              a.href = `/api/backup/download?path=${encodeURIComponent(data.path)}`;
              a.download = data.filename || 'backup.zip';
              document.body.appendChild(a);
              a.click();
              a.remove();
            }
            if (onSuccess) onSuccess(data);
            clearTimeout(safetyTimeout);
            closeBtn.style.display = '';
            setTimeout(() => overlay.remove(), autoCloseMs);
          } else if (data.type === 'error') {
            statusEl.textContent = '❌ ' + (data.message || 'Failed');
            statusEl.style.color = 'var(--danger)';
            if (data.output) addLine(data.output);
            if (onError) onError(data);
            clearTimeout(safetyTimeout);
            closeBtn.style.display = '';
            setTimeout(() => overlay.remove(), 5000);
          }
        } catch {}
      }
    }
  } catch (e) {
    statusEl.textContent = '❌ Error: ' + e.message;
    statusEl.style.color = 'var(--danger)';
    clearTimeout(safetyTimeout);
    closeBtn.style.display = '';
    setTimeout(() => overlay.remove(), 3000);
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatRelativeTime(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  if (days < 30) return days + 'd ago';
  const months = Math.floor(days / 30);
  return months + 'mo ago';
}

// Parse hermes skills table output (box-drawing chars) into structured data
function parseSkillTable(output) {
  const lines = String(output || '').split('\n');
  const skills = [];
  const rowPattern = /[│┃]\s*([^│┃\s][^│┃]*?)\s*[│┃]\s*([^│┃]*?)\s*[│┃]\s*(\S+)\s*[│┃]\s*(\S+)\s*[│┃]\s*([^│┃]*?)\s*[│┃]/;
  for (const line of lines) {
    if (line.includes('┏') || line.includes('┗') || line.includes('┡') || line.includes('┩') || line.includes('╍')) continue;
    const match = line.match(rowPattern);
    if (match) {
      const name = match[1].trim();
      if (!name || name === 'Name' || name === '#') continue;
      skills.push({
        name,
        description: match[2].trim(),
        source: match[3].trim(),
        trust: match[4].trim(),
        identifier: match[5].trim(),
      });
    }
  }
  return skills;
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
    const rawYaml = res.raw_yaml || '';
    const categories = [
      { key: 'model', label: 'Model & Provider', icon: '⚡' },
      { key: 'agent', label: 'Agent Behavior', icon: '🤖' },
      { key: 'terminal', label: 'Terminal', icon: '💻' },
      { key: 'display', label: 'Display & Streaming', icon: '🖥' },
      { key: 'compression', label: 'Context & Compression', icon: '📦' },
      { key: 'platforms', label: 'Platforms', icon: '🌐' },
      { key: 'mcp', label: 'MCP Servers', icon: '🔌' },
    ];

    // Store in state for window functions
    state._config = { config, rawYaml, categories, profile: name };

    container.innerHTML = `
      <div style="margin-bottom:12px;">
        <div class="tabs" id="config-tabs" style="margin:0;">
          ${categories.map((c, i) => `<button class="tab ${i === 0 ? 'active' : ''}" data-cat="${c.key}">${c.label}</button>`).join('')}
          <button class="tab" data-cat="secrets">Secrets (.env)</button>
          <button class="tab" data-cat="raw">Raw YAML</button>
        </div>
      </div>
      <div id="config-content">
        <div class="loading">Loading...</div>
      </div>
    `;

    // Edit helpers — delegate to global renderConfigCategory (set below)
    window._enableEditLocal = function(type) {
      const contentEl = document.getElementById('config-content');
      if (contentEl) {
        contentEl.dataset.editMode = 'true';
        state._config && (state._config.activeCat = type);
        window.renderConfigCategory(type);
      }
    };
    window._cancelEditLocal = function(type) {
      const contentEl = document.getElementById('config-content');
      if (contentEl) {
        contentEl.dataset.editMode = 'false';
        state._config && (state._config.activeCat = type);
        window.renderConfigCategory(type);
      }
    };
    window.saveSecretsLocal = async function(profile) {
      const inputs = document.querySelectorAll('[data-secret-name]');
      let saved = 0, failed = 0;
      for (const input of inputs) {
        const keyName = input.dataset.secretName;
        const newValue = input.value;
        try {
          const res = await api('/api/keys/' + encodeURIComponent(profile), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
            body: JSON.stringify({ name: keyName, value: newValue })
          });
          if (res.ok) saved++; else { failed++; showToast('Failed: ' + keyName, 'error'); }
        } catch (e) { failed++; showToast('Error: ' + keyName, 'error'); }
      }
      showToast('Saved ' + saved + ' key(s)' + (failed ? ', ' + failed + ' failed' : ''), failed > 0 ? 'warning' : 'success');
      window.renderConfigCategory('secrets');
    };
    window._saveConfigLocal = async function(profile, catKey) {
      const catConfig = state._config?.config[catKey];
      if (!catConfig) { showToast('Config not loaded', 'error'); return; }
      const updated = JSON.parse(JSON.stringify(catConfig));
      document.querySelectorAll('[data-cfg-key]').forEach(input => {
        const key = input.dataset.cfgKey;
        const type = input.dataset.cfgType;
        if (type === 'bool') updated[key] = input.checked;
        else if (type === 'num') updated[key] = Number(input.value);
        else updated[key] = input.value;
      });
      try {
        const res = await api('/api/config/' + encodeURIComponent(profile), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
          body: JSON.stringify({ config: { [catKey]: updated } })
        });
        if (res.ok) { state._config.config[catKey] = updated; showToast('Config saved', 'success'); window._cancelEditLocal(catKey); }
        else { showToast(res.output || 'Save failed', 'error'); }
      } catch (e) { showToast(e.message, 'error'); }
    };

    // renderConfigCategory is now global (defined below)

    // Initial render — use global renderConfigCategory (defined below)
    state._config.activeCat = categories[0].key;
    window.renderConfigCategory(categories[0].key);

    // Tab switching
    document.getElementById('config-tabs')?.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      document.querySelectorAll('#config-tabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state._config.activeCat = tab.dataset.cat;
      window.renderConfigCategory(tab.dataset.cat);
    });

  } catch (e) {
    container.innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
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
      const hd = memory.honcho_data || {};
      providerSection = `
        <div class="card">
          <div class="card-title">Honcho Memory</div>
          <div class="stat-row"><span class="stat-label">Provider</span><span class="stat-value status-ok">honcho</span></div>
          <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value ${hd.connected ? 'status-ok' : 'status-off'}">${hd.connected ? '● Connected' : '○ Disconnected'}</span></div>
          ${hd.enabled !== undefined ? `<div class="stat-row"><span class="stat-label">Enabled</span><span class="stat-value">${hd.enabled ? 'Yes' : 'No'}</span></div>` : ''}
          ${hd.host ? `<div class="stat-row"><span class="stat-label">Host</span><span class="stat-value">${escapeHtml(hd.host)}</span></div>` : ''}
          ${hd.workspace ? `<div class="stat-row"><span class="stat-label">Workspace</span><span class="stat-value">${escapeHtml(hd.workspace)}</span></div>` : ''}
          ${hd.ai_peer ? `<div class="stat-row"><span class="stat-label">AI Peer</span><span class="stat-value">${escapeHtml(hd.ai_peer)}</span></div>` : ''}
          ${hd.user_peer ? `<div class="stat-row"><span class="stat-label">User Peer</span><span class="stat-value">${escapeHtml(hd.user_peer)}</span></div>` : ''}
          ${hd.session_key ? `<div class="stat-row"><span class="stat-label">Session</span><span class="stat-value" style="font-size:11px">${escapeHtml(hd.session_key)}</span></div>` : ''}
          ${hd.recall_mode ? `<div class="stat-row"><span class="stat-label">Recall Mode</span><span class="stat-value">${escapeHtml(hd.recall_mode)}</span></div>` : ''}
          ${hd.write_freq ? `<div class="stat-row"><span class="stat-label">Write Freq</span><span class="stat-value">${escapeHtml(hd.write_freq)}</span></div>` : ''}
          ${hd.config_path ? `<div class="stat-row"><span class="stat-label">Config</span><span class="stat-value" style="font-size:10px;word-break:break-all">${escapeHtml(hd.config_path)}</span></div>` : ''}
          ${hd.representation ? `
            <details style="margin-top:8px;">
              <summary style="cursor:pointer;color:var(--fg);font-weight:600;font-size:12px;padding:4px 0;">AI Representation</summary>
              <pre style="background:var(--bg-inset);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:10px;line-height:1.4;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto;color:var(--fg-muted);">${escapeHtml(hd.representation)}</pre>
            </details>
          ` : ''}
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
        <div class="card">
          <div class="card-title">File Contents</div>
          <details style="margin-bottom:12px;">
            <summary style="cursor:pointer;color:var(--fg);font-weight:600;font-size:13px;padding:8px 0;">MEMORY.md <span style="color:var(--fg-muted);font-weight:400;font-size:11px;">(${memory.memory_chars || 0} chars)</span></summary>
            <pre style="background:var(--bg-inset);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto;color:var(--fg);">${escapeHtml(memory.memory_content || '(empty)')}</pre>
          </details>
          <details style="margin-bottom:12px;">
            <summary style="cursor:pointer;color:var(--fg);font-weight:600;font-size:13px;padding:8px 0;">USER.md <span style="color:var(--fg-muted);font-weight:400;font-size:11px;">(${memory.user_chars || 0} chars)</span></summary>
            <pre style="background:var(--bg-inset);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto;color:var(--fg);">${escapeHtml(memory.user_content || '(empty)')}</pre>
          </details>
          <details>
            <summary style="cursor:pointer;color:var(--fg);font-weight:600;font-size:13px;padding:8px 0;">SOUL.md <span style="color:var(--fg-muted);font-weight:400;font-size:11px;">(${memory.soul_chars || 0} chars)</span></summary>
            <pre style="background:var(--bg-inset);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto;color:var(--fg);">${escapeHtml(memory.soul_content || '(empty)')}</pre>
          </details>
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
    container.innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
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
      return '<tr><td>'+(j.name||j.id)+'</td><td><code style="font-size:11px;">'+j.schedule+'</code></td><td><span class="badge '+sc+'">'+j.status+'</span></td><td style="font-size:11px;color:var(--fg-muted);">'+nr+'</td><td style="display:flex;gap:4px;">'+act+'<button class="btn btn-ghost btn-sm" onclick="showEditCronModal(\''+profile+'\',\''+j.id+'\')" title="Edit">\u270F</button><button class="btn btn-ghost btn-sm btn-danger" onclick="cronRemove(\''+profile+'\',\''+j.id+'\',\''+(j.name||j.id).replace(/'/g, "\\'")+'\')" title="Remove">\u00D7</button></td></tr>';
    }).join('') + '</tbody></table>';
  } catch (e) { el.innerHTML = '<div class="error-msg">'+e.message+'</div>'; }
}

async function cronAction(profile, jobId, action) {
  const labels = { run: 'Run', pause: 'Pause', resume: 'Resume' };
  if (!await customConfirm(`${labels[action] || action} cron job on ${profile}?`, (labels[action] || action) + ' Job')) return;
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

window.showEditCronModal = async function(profile, jobId) {
  // Fetch current job data
  let res;
  try { res = await api('/api/hermes-cron/' + encodeURIComponent(profile)); }
  catch (e) { showToast('Could not load job data: ' + e.message, 'error'); return; }

  if (!res.ok || !res.jobs) { showToast('Could not load job data', 'error'); return; }
  const job = res.jobs.find(j => j.id === jobId);
  if (!job) { showToast('Job not found', 'error'); return; }

  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = '<div class="modal-card" style="width:500px;max-width:90vw;"><div class="modal-title">Edit Cron Job</div><form id="cron-edit-form"><div style="margin-bottom:12px;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Name</label><input type="text" id="cron-edit-name" value="'+escapeHtml(job.name || '')+'" placeholder="e.g. Daily health check" style="width:100%;padding:8px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg);font-family:var(--font);font-size:12px;" /></div><div style="margin-bottom:12px;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Schedule</label><div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;"><button type="button" class="btn btn-ghost btn-sm cron-edit-preset" data-val="5m">5m</button><button type="button" class="btn btn-ghost btn-sm cron-edit-preset" data-val="15m">15m</button><button type="button" class="btn btn-ghost btn-sm cron-edit-preset" data-val="30m">30m</button><button type="button" class="btn btn-ghost btn-sm cron-edit-preset" data-val="1h">1h</button><button type="button" class="btn btn-ghost btn-sm cron-edit-preset" data-val="6h">6h</button><button type="button" class="btn btn-ghost btn-sm cron-edit-preset" data-val="12h">12h</button><button type="button" class="btn btn-ghost btn-sm cron-edit-preset" data-val="daily">daily</button></div><input type="text" id="cron-edit-schedule" value="'+escapeHtml(job.schedule || '')+'" placeholder="e.g. every 30m or 0 9 * *" style="width:100%;padding:8px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg);font-family:var(--font);font-size:12px;" required /></div><div style="margin-bottom:12px;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Prompt (task instruction)</label><textarea id="cron-edit-prompt" rows="3" placeholder="Check system health and report" style="width:100%;resize:vertical;font-family:var(--font);font-size:12px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg);padding:8px;">'+escapeHtml(job.prompt || '')+'</textarea></div><div style="display:flex;gap:8px;margin-bottom:12px;"><div style="flex:1;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Deliver</label><select id="cron-edit-deliver" class="log-level-select" style="width:100%;"><option value="origin">origin</option><option value="local">local</option><option value="telegram">telegram</option><option value="discord">discord</option><option value="slack">slack</option><option value="whatsapp">whatsapp</option><option value="signal">signal</option><option value="matrix">matrix</option><option value="mattermost">mattermost</option><option value="email">email</option><option value="sms">sms</option><option value="homeassistant">homeassistant</option><option value="dingtalk">dingtalk</option><option value="feishu">feishu</option><option value="wecom">wecom</option><option value="weixin">weixin</option><option value="bluebubbles">bluebubbles</option></select></div><div style="flex:1;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Repeat</label><select id="cron-edit-repeat" class="log-level-select" style="width:100%;"><option value="">forever</option><option value="1">once</option><option value="5">5 times</option><option value="10">10 times</option><option value="50">50 times</option></select></div></div><div class="modal-actions"><button type="button" class="btn btn-ghost" id="cron-edit-cancel">Cancel</button><button type="submit" class="btn btn-primary">Save Changes</button></div></form></div>';
  document.body.appendChild(overlay);

  var deliver = job.deliver || 'origin';
  var repeat = job.repeat !== undefined ? String(job.repeat) : '';
  var delSel = overlay.querySelector('#cron-edit-deliver');
  if (delSel) delSel.value = Array.from(delSel.options).some(function(o) { return o.value === deliver; }) ? deliver : 'origin';
  var repSel = overlay.querySelector('#cron-edit-repeat');
  if (repSel) repSel.value = Array.from(repSel.options).some(function(o) { return o.value === repeat; }) ? repeat : '';

  overlay.querySelectorAll('.cron-edit-preset').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.getElementById('cron-edit-schedule').value = btn.dataset.val;
      overlay.querySelectorAll('.cron-edit-preset').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
    });
  });
  overlay.querySelector('#cron-edit-cancel').addEventListener('click', function() { overlay.remove(); });
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#cron-edit-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var schedule = document.getElementById('cron-edit-schedule').value.trim();
    var prompt = document.getElementById('cron-edit-prompt').value.trim();
    var name = document.getElementById('cron-edit-name').value.trim();
    var deliverVal = document.getElementById('cron-edit-deliver').value;
    var repeatVal = document.getElementById('cron-edit-repeat').value;
    if (!schedule) { showToast('Schedule required', 'error'); return; }
    try {
      var res2 = await api('/api/hermes-cron/' + encodeURIComponent(profile) + '/' + jobId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
        body: JSON.stringify({ schedule: schedule, prompt: prompt, name: name, deliver: deliverVal, repeat: repeatVal || undefined }),
      });
      if (res2.ok) { showToast('Cron job updated', 'success'); overlay.remove(); setTimeout(function() { loadCronJobs(profile); }, 500); }
      else { showToast(res2.error || 'Update failed', 'error'); }
    } catch (err) { showToast('Update failed: ' + err.message, 'error'); }
  });
};


async function loadUsage(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Usage & Analytics</div>
        <div class="page-subtitle">Token usage, costs, and activity breakdown</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <select id="usage-days" class="log-level-select">
          <option value="1">Today</option>
          <option value="7" selected>7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
        </select>
        <select id="usage-agent" class="log-level-select">
          <option value="">All agents</option>
        </select>
        <button class="btn btn-primary" id="usage-apply-btn" onclick="fetchUsageData()">Apply</button>
      </div>
    </div>

    <!-- Overview stats bar -->
    <div id="usage-overview-bar" class="card" style="margin-top:12px;">
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;">
        <span class="stat-label" style="white-space:nowrap;">Sessions</span>
        <span class="stat-label" style="white-space:nowrap;">Messages</span>
        <span class="stat-label" style="white-space:nowrap;">Input Tokens</span>
        <span class="stat-label" style="white-space:nowrap;">Output Tokens</span>
        <span class="stat-label" style="white-space:nowrap;">Total Tokens</span>
        <span class="stat-label" style="white-space:nowrap;">Est. Cost</span>
        <span class="stat-label" style="white-space:nowrap;">Active Time</span>
        <span class="stat-label" style="white-space:nowrap;">Avg Session</span>
      </div>
    </div>

    <!-- Charts: 2-column layout -->
    <div class="card-grid" style="margin-top:16px;">
      <div class="card">
        <div class="card-title">Daily Token Trend</div>
        <canvas id="usage-chart-tokens" height="160"></canvas>
      </div>
      <div class="card">
        <div style="display:flex;flex-direction:column;gap:16px;">
          <div>
            <div class="card-title" style="margin-bottom:8px;">Daily Cost</div>
            <canvas id="usage-chart-cost" height="100"></canvas>
          </div>
          <div>
            <div class="card-title" style="margin-bottom:8px;">Model Distribution</div>
            <canvas id="usage-chart-models" height="120"></canvas>
          </div>
        </div>
      </div>
    </div>

    <!-- Models + Platforms + Top Tools in one row -->
    <div class="card-grid" style="margin-top:16px;">
      <div class="card">
        <div class="card-title">Models</div>
        <div id="usage-models-list"></div>
      </div>
      <div class="card">
        <div class="card-title">Platforms</div>
        <div id="usage-platforms-list"></div>
      </div>
      <div class="card">
        <div class="card-title">Top Tools</div>
        <div id="usage-tools-list"></div>
      </div>
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
  } catch (e) {
    // ignore
  }
}

async function fetchUsageData() {
  const btn = document.getElementById('usage-apply-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }

  // Overview bar — show loading
  const barEl = document.getElementById('usage-overview-bar');
  if (barEl) {
    barEl.innerHTML = `<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center;">
      <span style="color:var(--fg-muted);font-size:13px;">Loading…</span>
    </div>`;
  }

  try {
    const days = document.getElementById('usage-days')?.value || '7';
    const agent = document.getElementById('usage-agent')?.value || '';
    const query = agent ? `?profile=${agent}` : '';

    const [res, dailyRes] = await Promise.all([
      api(`/api/usage/${days}${query}`),
      api(`/api/usage/daily/${days}${query}`),
    ]);

    if (!res.ok) {
      if (barEl) barEl.innerHTML = `<div class="error-msg">${escapeHtml(res.error || 'Failed to load')}</div>`;
      return;
    }

    const d = res;

    // Render compact overview bar
    if (barEl) {
      barEl.innerHTML = `
        <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center;">
          <div style="text-align:center;min-width:60px;">
            <div style="font-size:20px;font-weight:700;color:var(--gold);">${d.sessions}</div>
            <div style="font-size:10px;color:var(--fg-muted);">Sessions</div>
          </div>
          <div style="text-align:center;min-width:70px;">
            <div style="font-size:20px;font-weight:700;color:var(--gold);">${(d.messages || 0).toLocaleString()}</div>
            <div style="font-size:10px;color:var(--fg-muted);">Messages</div>
          </div>
          <div style="text-align:center;min-width:90px;">
            <div style="font-size:20px;font-weight:700;color:var(--teal);">${formatNumber(d.inputTokens)}</div>
            <div style="font-size:10px;color:var(--fg-muted);">Input Tokens</div>
          </div>
          <div style="text-align:center;min-width:90px;">
            <div style="font-size:20px;font-weight:700;color:var(--coral);">${formatNumber(d.outputTokens)}</div>
            <div style="font-size:10px;color:var(--fg-muted);">Output Tokens</div>
          </div>
          <div style="text-align:center;min-width:90px;">
            <div style="font-size:20px;font-weight:700;color:var(--gold);">${formatNumber(d.totalTokens)}</div>
            <div style="font-size:10px;color:var(--fg-muted);">Total Tokens</div>
          </div>
          <div style="text-align:center;min-width:70px;">
            <div style="font-size:20px;font-weight:700;color:var(--gold);">${d.cost || '$0.00'}</div>
            <div style="font-size:10px;color:var(--fg-muted);">Est. Cost</div>
          </div>
          <div style="text-align:center;min-width:80px;">
            <div style="font-size:16px;font-weight:600;color:var(--fg-muted);">${d.activeTime || '—'}</div>
            <div style="font-size:10px;color:var(--fg-muted);">Active Time</div>
          </div>
          <div style="text-align:center;min-width:80px;">
            <div style="font-size:16px;font-weight:600;color:var(--fg-muted);">${d.avgSession || '—'}</div>
            <div style="font-size:10px;color:var(--fg-muted);">Avg Session</div>
          </div>
        </div>
      `;
    }

    // Models
    const modelsEl = document.getElementById('usage-models-list');
    if (modelsEl) {
      modelsEl.innerHTML = d.models && d.models.length > 0
        ? d.models.map(m => `<div class="stat-row"><span class="stat-label">${escapeHtml(m.name)}</span><span class="stat-value">${m.sessions} · ${formatNumber(m.tokens)}</span></div>`).join('')
        : '<div class="stat-row"><span class="stat-label">No data</span></div>';
    }

    // Platforms
    const platEl = document.getElementById('usage-platforms-list');
    if (platEl) {
      platEl.innerHTML = d.platforms && d.platforms.length > 0
        ? d.platforms.map(p => `<div class="stat-row"><span class="stat-label">${escapeHtml(p.name)}</span><span class="stat-value">${p.sessions} · ${formatNumber(p.tokens)}</span></div>`).join('')
        : '<div class="stat-row"><span class="stat-label">No data</span></div>';
    }

    // Top Tools
    const toolsEl = document.getElementById('usage-tools-list');
    if (toolsEl) {
      toolsEl.innerHTML = d.topTools && d.topTools.length > 0
        ? d.topTools.slice(0, 5).map(t => `<div class="stat-row"><span class="stat-label">${escapeHtml(t.name)}</span><span class="stat-value">${t.calls} (${t.pct})</span></div>`).join('')
        : '<div class="stat-row"><span class="stat-label">No data</span></div>';
    }

    // Charts
    renderUsageCharts(d, dailyRes.ok ? dailyRes : null);

  } catch (e) {
    if (barEl) barEl.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Apply'; }
  }
}

// Chart instances (destroy before re-render)
const _charts = {};

function renderUsageCharts(d, daily) {
  const theme = state.theme === 'light' ? 'light' : 'dark';
  const gridColor = theme === 'dark' ? 'rgba(220,203,181,0.08)' : 'rgba(11,32,31,0.08)';
  const textColor = theme === 'dark' ? '#dccbb5' : '#0b201f';
  const colors = ['#ffac02', '#4ecdc4', '#ff6b6b', '#a78bfa', '#34d399', '#60a5fa', '#fb923c', '#f472b6'];

  // Destroy existing charts
  Object.values(_charts).forEach(c => { try { c.destroy(); } catch {} });

  // Daily Token Trend
  const tokenCanvas = document.getElementById('usage-chart-tokens');
  if (tokenCanvas && daily?.daily && daily.daily.length > 0) {
    const labels = daily.daily.map(r => r.date);
    const inputData = daily.daily.map(r => r.input_tokens || 0);
    const outputData = daily.daily.map(r => r.output_tokens || 0);
    const cacheData = daily.daily.map(r => r.cache_read_tokens || 0);

    _charts.tokens = new Chart(tokenCanvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Input', data: inputData, backgroundColor: '#ffac02', borderRadius: 4 },
          { label: 'Output', data: outputData, backgroundColor: '#4ecdc4', borderRadius: 4 },
          { label: 'Cache', data: cacheData, backgroundColor: '#a78bfa', borderRadius: 4 },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: textColor } } },
        scales: {
          x: { stacked: true, ticks: { color: textColor, maxRotation: 45 }, grid: { color: gridColor } },
          y: { stacked: true, ticks: { color: textColor, callback: v => formatNumber(v) }, grid: { color: gridColor } },
        },
      },
    });
  } else if (tokenCanvas && d.models && d.models.length > 0) {
    // Fallback: model distribution
    const labels = d.models.map(m => m.name).slice(0, 8);
    _charts.tokens = new Chart(tokenCanvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: 'Tokens', data: d.models.slice(0, 8).map(m => m.tokens || 0), backgroundColor: colors.slice(0, 8), borderRadius: 4 }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { x: { ticks: { color: textColor }, grid: { color: gridColor } }, y: { ticks: { color: textColor, callback: v => formatNumber(v) }, grid: { color: gridColor } } },
      },
    });
  }

  // Daily Cost Trend
  const costCanvas = document.getElementById('usage-chart-cost');
  if (costCanvas && daily?.daily && daily.daily.length > 0) {
    const labels = daily.daily.map(r => r.date);
    const costData = daily.daily.map(r => r.cost || 0);

    _charts.cost = new Chart(costCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Cost ($)',
          data: costData,
          borderColor: '#ffac02',
          backgroundColor: 'rgba(255,172,2,0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: textColor, maxRotation: 45 }, grid: { color: gridColor } },
          y: { ticks: { color: textColor, callback: v => '$' + v.toFixed(2) }, grid: { color: gridColor } },
        },
      },
    });
  } else if (costCanvas) {
    // Fallback: model cost distribution
    const models = (d.models || []).slice(0, 6);
    _charts.cost = new Chart(costCanvas, {
      type: 'bar',
      data: {
        labels: models.map(m => m.name),
        datasets: [{ label: 'Sessions', data: models.map(m => m.sessions || 0), backgroundColor: colors.slice(0, 6), borderRadius: 4 }],
      },
      options: {
        responsive: true,
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: { x: { ticks: { color: textColor }, grid: { color: gridColor } }, y: { ticks: { color: textColor }, grid: { color: gridColor } } },
      },
    });
  }

  // Model Distribution (doughnut)
  const modelCanvas = document.getElementById('usage-chart-models');
  const models = daily?.byModel || d.models;
  if (modelCanvas && models && models.length > 0) {
    const top = models.slice(0, 6);
    _charts.models = new Chart(modelCanvas, {
      type: 'doughnut',
      data: {
        labels: top.map(m => m.name || m.model),
        datasets: [{
          data: top.map(m => m.tokens || m.total_tokens || 0),
          backgroundColor: colors.slice(0, 6),
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        cutout: '60%',
        plugins: { legend: { position: 'bottom', labels: { color: textColor, font: { size: 10 }, padding: 8 } } },
      },
    });
  }
}

async function loadSkills(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Skills Hub</div>
        <div class="page-subtitle">Browse, install, and manage skills</div>
      </div>
      <div style="display:flex;gap:8px;">
        <input type="text" id="skills-search-input" class="search-input" placeholder="Search skills..." />
        <button class="btn btn-ghost" onclick="loadSkills(document.querySelector('.page.active'))">↻ Refresh</button>
      </div>
    </div>
    <div id="skills-hub-content">
      <div class="loading">Loading skills...</div>
    </div>
  `;

  const contentEl = document.getElementById('skills-hub-content');
  let currentPage = 1;
  let totalPages = 1;
  let profiles = [];

  // Load profiles for install picker
  try {
    const profRes = await api('/api/profiles');
    if (profRes.ok) profiles = profRes.profiles || [];
  } catch {}

  async function loadPage(page) {
    contentEl.innerHTML = '<div class="loading">Loading page ' + page + '...</div>';
    try {
      const res = await api(`/api/skills/browse/${page}`);
      if (!res.ok) {
        contentEl.innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${escapeHtml(res.error || 'Failed to load')}</div></div>`;
        return;
      }

      // Parse output for pagination info
      const output = res.output || '';
      const pageMatch = output.match(/page (\d+)\/(\d+)/);
      if (pageMatch) {
        currentPage = parseInt(pageMatch[1]);
        totalPages = parseInt(pageMatch[2]);
      }

      // Parse table rows
      const skills = [];
      const lines = output.split('\n');
      for (const line of lines) {
        const match = line.match(/[│|]\s*(\d+)\s*[│|]\s*([^\s│|]+)\s*[│|]\s*(.{10,}?)\s*[│|]\s*(\S+)\s*[│|]\s*(.+?)\s*[│|]/);
        if (match) {
          skills.push({
            num: match[1],
            name: match[2].trim(),
            description: match[3].trim().replace(/\.\.\.$/, ''),
            source: match[4].trim(),
            trust: match[5].trim(),
          });
        }
      }

      // Build HTML
      let html = '<div class="card-grid">';
      if (skills.length === 0) {
        html += `<div class="card"><div class="card-title">No skills found on page ${page}</div><pre style="font-size:10px;color:var(--fg-muted);max-height:400px;overflow-y:auto;white-space:pre-wrap;">${escapeHtml(output)}</pre></div>`;
      } else {
        for (const s of skills) {
          const isOfficial = s.source === 'official';
          const badgeColor = isOfficial ? 'var(--accent)' : 'var(--fg-muted)';
          html += `
            <div class="card" style="position:relative;">
              <div class="card-title">${escapeHtml(s.name)}</div>
              <div style="font-size:12px;color:var(--fg-muted);margin-top:4px;">${escapeHtml(s.description)}</div>
              <div style="margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                <span class="badge" style="font-size:10px;background:${badgeColor}22;color:${badgeColor};">${escapeHtml(s.source)}</span>
                ${s.trust ? `<span class="badge" style="font-size:10px;">${escapeHtml(s.trust)}</span>` : ''}
              </div>
              <div style="margin-top:10px;display:flex;gap:6px;">
                <button class="btn btn-ghost btn-sm" onclick="window.inspectSkill('${escapeHtml(s.name)}')">👁️ Preview</button>
                <button class="btn btn-primary btn-sm" onclick="window.installSkill('${escapeHtml(s.name)}')">⬇️ Install</button>
              </div>
            </div>
          `;
        }
      }
      html += '</div>';

      // Pagination
      html += '<div style="display:flex;justify-content:center;gap:8px;margin-top:16px;">';
      if (currentPage > 1) {
        html += `<button class="btn btn-ghost" onclick="skillsLoadPage(${currentPage - 1})">← Page ${currentPage - 1}</button>`;
      }
      html += `<span style="color:var(--fg-muted);padding:8px;">Page ${currentPage} / ${totalPages}</span>`;
      if (currentPage < totalPages) {
        html += `<button class="btn btn-ghost" onclick="skillsLoadPage(${currentPage + 1})">Page ${currentPage + 1} →</button>`;
      }
      html += '</div>';

      contentEl.innerHTML = html;
    } catch (e) {
      contentEl.innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
    }
  }

  // Expose pagination globally
  window.skillsLoadPage = loadPage;

  // Search handler
  document.getElementById('skills-search-input')?.addEventListener('input', async (e) => {
    const q = e.target.value.trim();
    if (q.length < 2) { loadPage(1); return; }
    contentEl.innerHTML = '<div class="loading">Searching...</div>';
    try {
      const res = await api(`/api/skills/search/${encodeURIComponent(q)}`);
      if (res.ok && res.output) {
        const skills = parseSkillTable(res.output);
        if (skills.length === 0) {
          contentEl.innerHTML = `<div class="card"><div class="card-title">Search Results</div><div class="stat-row"><span class="stat-label">No skills found for "${escapeHtml(q)}"</span></div></div>`;
        } else {
          contentEl.innerHTML = `<div class="card"><div class="card-title">Search Results (${skills.length})</div></div>` +
            '<div class="card-grid">' + skills.map(s => `
              <div class="card">
                <div class="card-title">${escapeHtml(s.name)}</div>
                <div style="font-size:12px;color:var(--fg-muted);margin:4px 0;">${escapeHtml(s.description)}</div>
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px;">
                  <span class="badge" style="font-size:10px;">${escapeHtml(s.source)}</span>
                  ${s.trust ? `<span class="badge" style="font-size:10px;opacity:0.7;">${escapeHtml(s.trust)}</span>` : ''}
                </div>
                <div style="margin-top:8px;display:flex;gap:6px;">
                  <button class="btn btn-ghost btn-sm" onclick="window.inspectSkill('${escapeHtml(s.identifier || s.name)}')">🔍 Preview</button>
                  <button class="btn btn-primary btn-sm" onclick="window.installSkill('${escapeHtml(s.identifier || s.name)}')">⬇ Install</button>
                </div>
              </div>
            `).join('') + '</div>';
        }
      } else {
        contentEl.innerHTML = `<div class="card"><div class="card-title">Search Results</div><div class="error-msg">${escapeHtml(res.error || 'Search failed')}</div></div>`;
      }
    } catch (err) {
      contentEl.innerHTML = `<div class="card"><div class="error-msg">${escapeHtml(err.message)}</div></div>`;
    }
  });

  // Load first page
  loadPage(1);
}

// Inspect skill (preview modal)
window.inspectSkill = async function(name) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `<div class="modal-card" style="width:600px;max-width:90vw;"><div class="loading">Loading preview...</div></div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  try {
    const res = await api(`/api/skills/inspect/${encodeURIComponent(name)}`);
    overlay.querySelector('.modal-card').innerHTML = `
      <div class="modal-title">${escapeHtml(name)}</div>
      <pre style="background:var(--bg-inset);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow-y:auto;color:var(--fg);">${escapeHtml(res.ok ? res.output : res.error || 'Failed to load')}</pre>
      <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Close</button>
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove();window.installSkill('${escapeHtml(name)}')">⬇️ Install</button>
      </div>
    `;
  } catch (e) {
    overlay.querySelector('.modal-card').innerHTML = `<div class="modal-title">Error</div><div class="error-msg">${escapeHtml(e.message)}</div><button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()" style="margin-top:12px;">Close</button>`;
  }
}

// Install skill with profile picker
window.installSkill = async function(skillName) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `<div class="modal-card" style="width:450px;max-width:90vw;"><div class="loading">Loading...</div></div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  // Fetch profiles
  let profiles = [];
  try {
    const res = await api('/api/profiles');
    if (res.ok) profiles = res.profiles || [];
  } catch {}

  const profilesList = profiles.map(p =>
    `<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;cursor:pointer;border:1px solid ${p.active ? 'var(--accent)33' : 'var(--border)'};background:${p.active ? 'var(--accent)11' : 'var(--bg-card)'};">
      <input type="radio" name="install-profile" value="${escapeHtml(p.name)}" ${p.active ? 'checked' : ''} />
      <span style="font-weight:600;">${escapeHtml(p.name)}</span>
      ${p.alias && p.alias !== p.name ? `<span style="color:var(--fg-muted);font-size:11px;">(${escapeHtml(p.alias)})</span>` : ''}
      ${p.active ? '<span class="badge" style="font-size:9px;background:var(--accent)22;color:var(--accent);">active</span>' : ''}
      <span style="color:var(--fg-muted);font-size:11px;margin-left:auto;">${escapeHtml(p.model || '')}</span>
    </label>`
  ).join('');

  overlay.querySelector('.modal-card').innerHTML = `
    <div class="modal-title">Install: ${escapeHtml(skillName)}</div>
    <div style="margin-bottom:16px;">
      <div style="font-size:12px;color:var(--fg-muted);margin-bottom:8px;">Select agent profile</div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        ${profilesList || '<div style="color:var(--fg-muted);padding:12px;">No profiles found</div>'}
      </div>
    </div>
    <div id="install-status"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
      <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
      <button class="btn btn-primary" onclick="window.doInstallSkill('${escapeHtml(skillName)}')">⬇️ Install</button>
    </div>
  `;
}

window.doInstallSkill = async function(skillName) {
  const overlay = document.querySelector('.modal-overlay:last-of-type');
  const profileEl = overlay?.querySelector('input[name="install-profile"]:checked');
  const profile = profileEl ? profileEl.value : '';
  const statusEl = overlay?.querySelector('#install-status');
  if (statusEl) statusEl.innerHTML = '<div class="loading">Installing...</div>';

  try {
    const res = await api('/api/skills/install', { method: 'POST', body: JSON.stringify({ skill: skillName, profile }) });
    if (res.ok) {
      if (statusEl) statusEl.innerHTML = `<div style="color:var(--ok);margin-top:8px;">✅ Installed to ${escapeHtml(profile || 'default')}!</div>`;
      setTimeout(() => overlay?.remove(), 2000);
    } else {
      if (statusEl) statusEl.innerHTML = `<div style="color:var(--err);margin-top:8px;">❌ ${escapeHtml(res.output || res.error || 'Install failed')}</div>`;
    }
  } catch (e) {
    if (statusEl) statusEl.innerHTML = `<div style="color:var(--err);margin-top:8px;">❌ ${escapeHtml(e.message)}</div>`;
  }
}

async function loadUsersPage(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">User Management</div>
        <div class="page-subtitle">Manage users, roles, and permissions</div>
      </div>
    </div>
    <div class="card-grid">
      <div class="card">
        <div class="card-title">Users</div>
        <div id="users-page-list"><div class="loading">Loading users...</div></div>
        <div class="card-actions" style="margin-top:8px;">
          <button class="btn btn-ghost" onclick="showCreateUser()">+ Create User</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Audit Log</div>
        <div id="audit-log-page"><div class="loading">Loading audit...</div></div>
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
      el.innerHTML = '<div class="stat-row"><span class="stat-label">No users</span></div>';
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
      el.innerHTML = '<div class="stat-row"><span class="stat-label">No audit entries</span></div>';
    }
  } catch (e) {
    document.getElementById('audit-log-page').innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
  }
}

window.loadMoreAudit = function() {
  state.auditDisplayLimit += 15;
  loadAuditLogPage();
};

async function loadMaintenance(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Maintenance</div>
        <div class="page-subtitle">System tools and diagnostics</div>
      </div>
    </div>
    <div class="card-grid" id="maintenance-grid">
      <div class="card">
        <div class="card-title">Health Check</div>
        <div id="health-check-results">
          <div style="font-size:12px;color:var(--fg-muted);margin-bottom:8px;">Test all HCI API endpoints</div>
        </div>
        <div class="card-actions" style="margin-top:8px;">
          <button class="btn btn-ghost" onclick="runHealthCheck()">🔌 Check APIs</button>
          <button class="btn btn-ghost" onclick="hcirestart()">⟲ Restart HCI</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title">🎯 HCI Update</div>
        <div class="hci-version-info" style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
          <div class="stat-item">
            <span class="stat-label">Version</span>
            <span class="stat-value" id="hci-current-version">—</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Commit</span>
            <span class="stat-value"><code id="hci-current-commit">—</code></span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Branch</span>
            <span class="stat-value"><code id="hci-current-branch">—</code></span>
          </div>
          <div class="stat-item" id="hci-behind-badge" style="display:none;">
            <span class="stat-label">Behind</span>
            <span class="stat-value"><span class="badge badge-warning" id="hci-commits-behind">0</span></span>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="checkHCIUpdates()">Check Updates</button>
          <button class="btn btn-outline" onclick="runUpdateStream('/api/hci/update')">Update All</button>
          <button class="btn btn-ghost" onclick="runUpdateStream('/api/hci/rollback')">⟲ Rollback</button>
        </div>
      </div>
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
      <div class="card">
        <div class="card-title">Backup & Import</div>
        <div style="font-size:12px;color:var(--fg-muted);margin-bottom:10px;">Create and restore Hermes data backups</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-ghost" onclick="createBackup()">📦 Create Backup</button>
          <label class="btn btn-ghost" style="cursor:pointer;margin:0;">
            📥 Import<input type="file" accept=".zip" onchange="importBackup(this)" style="display:none;" />
          </label>
        </div>
        <div id="backup-result" style="margin-top:8px;"></div>
      </div>
      <div class="card">
        <div class="card-title">HCI Info</div>
        <div class="stat-row"><span class="stat-label">GitHub</span><span class="stat-value"><a href="https://github.com/xaspx/hermes-control-interface" target="_blank" style="color:var(--accent);text-decoration:none;">🔗 xaspx/hermes-control-interface</a></span></div>
        <div class="stat-row"><span class="stat-label">Twitter</span><span class="stat-value"><a href="https://x.com/bayendor" target="_blank" style="color:var(--accent);text-decoration:none;">@bayendor</a></span></div>
      </div>
    </div>
  `;

  // Load version
  try {
    const healthRes = await api('/api/system/health');
    if (healthRes.ok) {
      document.getElementById('update-version').textContent = healthRes.hermes_version || '—';
    }
  } catch {}

  // Auto-check HCI updates on page load (silent — no modal)
  updateHCIInfo();
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
      el.innerHTML = '<div class="stat-row"><span class="stat-label">No users</span></div>';
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

async function createBackup() {
  if (!await customConfirm('Create a system backup? This may take a moment.', 'Create Backup')) return;
  await sseProgressModal('📦 Creating Backup', '/api/backup/create', {
    method: 'POST',
    headers: { 'X-CSRF-Token': state.csrfToken || '' },
    autoCloseMs: 3000,
    onSuccess: () => { showToast('Backup downloaded', 'success'); },
  });
}

async function importBackup(input) {
  if (!input.files?.[0]) return;
  const file = input.files[0];
  if (!file.name.endsWith('.zip')) return showToast('Please select a .zip file', 'error');
  if (!await customConfirm('Import backup? This will restore data from the backup file.', 'Import Backup')) { input.value = ''; return; }

  const formData = new FormData();
  formData.append('backup', file);

  await sseProgressModal('📥 Importing Backup', '/api/backup/import', {
    method: 'POST',
    headers: { 'X-CSRF-Token': state.csrfToken || '' },
    body: formData,
    autoCloseMs: 4000,
    onSuccess: () => { showToast('Backup imported successfully', 'success'); },
  });
  input.value = '';
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

async function runHealthCheck() {
  if (!await customConfirm('Run health check on all API endpoints?', 'Health Check')) return;
  const el = document.getElementById('health-check-results');
  if (!el) return;
  el.innerHTML = '<div class="loading">Testing APIs...</div>';
  const endpoints = [
    { name: 'Health', url: '/api/health' },
    { name: 'System', url: '/api/system/health' },
    { name: 'Auth Status', url: '/api/auth/status' },
    { name: 'Profiles', url: '/api/profiles' },
    { name: 'Sessions', url: '/api/all-sessions?profile=default' },
  ];
  const results = [];
  for (const ep of endpoints) {
    const start = performance.now();
    try {
      const res = await api(ep.url);
      const ms = Math.round(performance.now() - start);
      results.push({ name: ep.name, ok: res.ok !== false, ms, error: res.error });
    } catch (e) {
      results.push({ name: ep.name, ok: false, ms: Math.round(performance.now() - start), error: e.message });
    }
  }
  const allOk = results.every(r => r.ok);
  el.innerHTML = results.map(r => `
    <div class="stat-row">
      <span class="stat-label">${r.name}</span>
      <span class="stat-value ${r.ok ? 'status-ok' : 'status-off'}">${r.ok ? '● OK' : '○ FAIL'} <span style="font-size:10px;opacity:0.6;">${r.ms}ms</span></span>
    </div>
  `).join('') + `<div style="margin-top:8px;font-size:11px;color:var(--fg-muted);">${allOk ? 'All endpoints healthy' : 'Some endpoints failed'}</div>`;
}

async function runDoctor(fix = false) {
  const msg = fix ? 'Run diagnostics with auto-fix? This may modify system settings.' : 'Run diagnostics? This is read-only.';
  if (!await customConfirm(msg, fix ? 'Auto-fix' : 'Diagnostics')) return;
  const el = document.getElementById('doctor-result');
  el.innerHTML = '<div class="loading">Running diagnostics...</div>';
  try {
    const csrfToken = state.csrfToken || '';
    const response = await fetch('/api/doctor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      credentials: 'include',
      body: JSON.stringify({ fix }),
    });
    if (!response.ok) {
      el.innerHTML = `<div class="error-msg">HTTP ${response.status}</div>`;
      return;
    }
    // Read SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullOutput = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';
      for (const line of parts) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'progress') {
            fullOutput += data.line + '\n';
          } else if (data.type === 'done') {
            fullOutput = data.output || fullOutput;
          }
        } catch {}
      }
    }
    if (fullOutput.trim()) {
      el.innerHTML = renderDoctorOutput(fullOutput.trim());
    } else {
      el.innerHTML = '<div class="error-msg">No output received</div>';
    }
  } catch (e) {
    el.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
  }
}

async function runDump() {
  if (!await customConfirm('Generate system dump? This creates a summary of current configuration.', 'Generate Dump')) return;
  const el = document.getElementById('dump-result');
  el.innerHTML = '<div class="loading">Generating dump...</div>';
  try {
    const res = await api('/api/dump');
    el.innerHTML = `<pre style="font-size:10px;white-space:pre-wrap;max-height:300px;overflow-y:auto;color:var(--fg-muted);">${escapeHtml(res.output || 'No output')}</pre>`;
  } catch (e) {
    el.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
  }
}

async function runUpdate() {
  if (!await customConfirm('Update Hermes? This may take a minute.')) return;
  // Pause notification polling during update to avoid false network errors
  const wasPolling = state.notifInterval;
  if (state.notifInterval) { clearInterval(state.notifInterval); state.notifInterval = null; }
  await sseProgressModal('⬆ Updating Hermes', '/api/update', {
    method: 'POST',
    headers: { 'X-CSRF-Token': state.csrfToken || '' },
    autoCloseMs: 3000,
    onSuccess: () => { if (wasPolling) startNotifPolling(); },
    onError: () => { if (wasPolling) startNotifPolling(); },
  });
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
    await customAlert('Please enter an agent name first (letters, numbers, hyphens, underscores).', 'Name Required');
    return;
  }

  let body = { name: safeName };

  if (result.action === 'clone_from') {
    const sourceResult = await showModal({
      title: `Clone "${safeName}" From`,
      message: `Clone settings from which profile?`,
      inputs: [{ placeholder: 'Source profile (e.g. david)', value: 'david' }],
      buttons: [
        { text: 'Cancel', value: null },
        { text: 'Clone', primary: true, value: 'ok' },
      ],
    });
    if (!sourceResult || sourceResult.action === null) return;
    const source = (sourceResult.inputs[0] || 'david').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!source) {
      await customAlert('Invalid source profile name.', 'Error');
      return;
    }
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
      <div class="modal-title">Create User</div>
      <form id="create-user-form">
        <div style="margin-bottom:10px;">
          <label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Username</label>
          <input class="modal-input" name="username" placeholder="e.g. alice" autocomplete="off" required />
        </div>
        <div style="margin-bottom:10px;">
          <label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Password</label>
          <div style="position:relative;">
            <input class="modal-input" name="password" type="password" placeholder="Min 8 characters" autocomplete="new-password" required style="padding-right:36px;" />
            <button type="button" onclick="togglePwVis(this)" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--fg-muted);cursor:pointer;font-size:14px;">👁</button>
          </div>
        </div>
        <div style="margin-bottom:10px;">
          <label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Confirm Password</label>
          <div style="position:relative;">
            <input class="modal-input" name="confirm" type="password" placeholder="Re-enter password" autocomplete="new-password" required style="padding-right:36px;" />
            <button type="button" onclick="togglePwVis(this)" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--fg-muted);cursor:pointer;font-size:14px;">👁</button>
          </div>
          <div id="pw-match-msg" style="font-size:11px;margin-top:4px;min-height:16px;"></div>
        </div>
        <div style="font-size:10px;color:var(--fg-subtle);margin-bottom:10px;padding:6px 8px;background:var(--bg-input);border-radius:var(--radius);">Password rules: min 8 chars, no spaces</div>
        <div style="margin-bottom:10px;">
          <label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:6px;">Role</label>
          <div style="display:flex;gap:6px;margin-bottom:10px;">
            <button type="button" class="btn btn-ghost btn-sm" onclick="applyCreatePreset('admin', this)">Admin</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="applyCreatePreset('viewer', this)">Viewer</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="applyCreatePreset('custom', this)">Custom</button>
          </div>
          <input type="hidden" name="role" value="viewer" />
          <div id="perm-custom-list" style="display:none;">
            <div style="font-size:11px;color:var(--fg-muted);margin-bottom:6px;">Permissions:</div>
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
          <button type="button" class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button type="submit" class="btn btn-primary">Create User</button>
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
    if (!username) return showToast('Username required', 'error');
    if (password.length < 8) return showToast('Password must be at least 8 chars', 'error');
    if (password !== confirm) return showToast('Passwords do not match', 'error');
    if (/\s/.test(password)) return showToast('Password cannot contain spaces', 'error');
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
  if (!user) return showToast('User not found', 'error');

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
          <label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:6px;">Role</label>
          <div style="display:flex;gap:6px;margin-bottom:8px;">
            <button type="button" class="btn btn-ghost btn-sm" onclick="applyPreset('admin', this)">Admin</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="applyPreset('viewer', this)">Viewer</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="applyPreset('custom', this)">Custom</button>
          </div>
          <input type="hidden" name="role" id="edit-user-role" value="${user.role}" />
          <div id="edit-perm-custom-list" style="${isCustom ? '' : 'display:none;'}">
            <div style="font-size:11px;color:var(--fg-muted);margin-bottom:6px;">Permissions:</div>
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
          <button type="button" class="btn btn-ghost btn-sm" onclick="showResetPassword('${escapeHtml(username)}')" style="color:var(--coral,#ff6b6b);">🔑 Reset Password</button>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Changes</button>
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

// Reset password sub-modal
async function showResetPassword(username) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="modal-card" style="max-width:400px;">
      <div class="modal-title">Reset Password: ${escapeHtml(username)}</div>
      <form id="reset-pw-form">
        <div style="margin-bottom:10px;">
          <label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">New Password</label>
          <div style="position:relative;">
            <input class="modal-input" name="password" type="password" placeholder="Min 8 characters" autocomplete="new-password" required style="padding-right:36px;" />
            <button type="button" onclick="togglePwVis(this)" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--fg-muted);cursor:pointer;font-size:14px;">👁</button>
          </div>
        </div>
        <div style="margin-bottom:10px;">
          <label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Confirm Password</label>
          <div style="position:relative;">
            <input class="modal-input" name="confirm" type="password" placeholder="Re-enter password" autocomplete="new-password" required style="padding-right:36px;" />
            <button type="button" onclick="togglePwVis(this)" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--fg-muted);cursor:pointer;font-size:14px;">👁</button>
          </div>
          <div id="reset-pw-match-msg" style="font-size:11px;margin-top:4px;min-height:16px;"></div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button type="submit" class="btn btn-primary" style="color:var(--coral,#ff6b6b);">Reset Password</button>
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
    if (newPw.length < 8) return showToast('Password must be at least 8 chars', 'error');
    if (newPw !== confirmPw) return showToast('Passwords do not match', 'error');
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

// ============================================
// Notifications
// ============================================
async function fetchNotifications() {
  try {
    const res = await api('/api/notifications');
    if (res.ok && res.notifications) {
      const prevUnread = state.notifications.filter((n) => !n.dismissed).length;
      state.notifications = res.notifications;
      state.notifFailCount = 0;
      updateNotifBadge();
      // Re-render dropdown if it's open
      const dropdown = document.getElementById('notif-dropdown');
      if (dropdown && dropdown.style.display !== 'none') {
        renderNotifications();
      }
      // Flash badge if new unread notifications arrived
      const newUnread = state.notifications.filter((n) => !n.dismissed).length;
      if (newUnread > prevUnread && badgeFlashTimeout) clearTimeout(badgeFlashTimeout);
      const badge = document.getElementById('notif-badge');
      if (badge && newUnread > prevUnread) {
        badge.style.transform = 'scale(1.3)';
        badgeFlashTimeout = setTimeout(() => { badge.style.transform = 'scale(1)'; }, 300);
      }
    } else if (res.error === 'network' || res.error === 'rate-limited') {
      state.notifFailCount = (state.notifFailCount || 0) + 1;
      if (state.notifFailCount === 3 || state.notifFailCount === 6) startNotifPolling();
    }
  } catch {
    state.notifFailCount = (state.notifFailCount || 0) + 1;
    if (state.notifFailCount === 3 || state.notifFailCount === 6) startNotifPolling();
  }
}

let badgeFlashTimeout;

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
  const interval = failCount >= 6 ? 120000 : failCount >= 3 ? 60000 : 15000;
  state.notifInterval = setInterval(fetchNotifications, interval);
}

// ============================================
// Notification helpers (module-level so fetchNotifications can access them)
// ============================================
function notifColor(type) {
  const colors = {
    error: 'var(--coral, #ff6b6b)',
    warning: 'var(--amber, #fbbf24)',
    success: 'var(--green, #34d399)',
    info: 'var(--teal, #4ecdc4)',
  };
  return colors[type] || colors.info;
}

function notifIcon(type) {
  const icons = {
    error: '🔴',
    warning: '🟡',
    success: '🟢',
    info: '🔵',
  };
  return icons[type] || icons.info;
}

function renderNotifications() {
  const listEl = document.getElementById('notif-list');
  if (!listEl) return;
  const limit = state.notifDisplayLimit;
  const all = state.notifications.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  const shown = all.slice(0, limit);
  if (shown.length === 0) {
    listEl.innerHTML = '<div class="notif-empty">No notifications</div>';
    return;
  }
  listEl.innerHTML = shown.map(n => {
    const color = notifColor(n.type);
    const icon = notifIcon(n.type);
    return `
      <div class="notif-item ${n.dismissed ? 'notif-read' : ''}" data-notif-id="${n.id || ''}" style="padding:8px;border-bottom:1px solid var(--border);font-size:11px;cursor:pointer;${n.dismissed ? 'opacity:0.5;' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;">
          <div style="flex-shrink:0;">${icon}</div>
          <div style="flex:1;color:${n.dismissed ? 'var(--fg-muted)' : 'var(--fg)'};">
            <span style="color:${color};font-weight:600;font-size:10px;text-transform:uppercase;">${n.type || 'info'}</span><br>${escapeHtml(n.message || '')}
          </div>
          <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();dismissNotifItem('${n.id || ''}')" style="padding:2px 6px;font-size:10px;color:var(--fg-muted);" title="Dismiss">✕</button>
        </div>
        <div style="color:var(--fg-subtle);font-size:10px;margin-top:2px;margin-left:22px;">${n.timestamp ? new Date(n.timestamp).toLocaleString() : ''}</div>
      </div>
    `;
  }).join('');

  // Click to mark as read
  listEl.querySelectorAll('.notif-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.notifId;
      if (id) markNotifRead(id);
      el.style.opacity = '0.5';
      el.classList.add('notif-read');
    });
  });

  // Load more button
  if (all.length > limit) {
    listEl.innerHTML += `<div style="padding:8px;text-align:center;"><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();loadMoreNotifs(${limit + 5})">Load more (${all.length - limit} remaining)</button></div>`;
  }
}

window.loadMoreNotifs = function(newLimit) {
  state.notifDisplayLimit = newLimit || 10;
  renderNotifications();
};

window.markNotifRead = async function(id) {
  const n = state.notifications.find(n => n.id === id);
  if (n) n.dismissed = true;
  updateNotifBadge();
  try { await api('/api/notifications/dismiss', { method: 'POST', body: JSON.stringify({ id }) }); } catch {}
};

window.dismissNotifItem = async function(id) {
  const idx = state.notifications.findIndex(n => n.id === id);
  if (idx >= 0) { state.notifications[idx].dismissed = true; updateNotifBadge(); }
  try { await api('/api/notifications/dismiss', { method: 'POST', body: JSON.stringify({ id }) }); } catch {}
  state.notifDisplayLimit = Math.max(state.notifDisplayLimit, 5);
  renderNotifications();
};

window.markAllNotifRead = async function() {
  state.notifications.forEach(n => n.dismissed = true);
  updateNotifBadge();
  try { await api('/api/notifications/clear', { method: 'POST' }); } catch {}
  state.notifDisplayLimit = 5;
  renderNotifications();
};

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
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    // Non-JSON response (HTML error page, etc.)
    const text = await res.text();
    return { ok: false, error: text.substring(0, 200) };
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

  document.getElementById('users-mgmt-btn')?.addEventListener('click', () => {
    document.getElementById('user-dropdown').style.display = 'none';
    navigate('users');
  });

  document.getElementById('password-cancel')?.addEventListener('click', () => {
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

  // Notifications (functions defined at module level, see ~line 3580)
  document.getElementById('notif-btn')?.addEventListener('click', () => {
    const dropdown = document.getElementById('notif-dropdown');
    const isVisible = dropdown.style.display !== 'none';
    dropdown.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) {
      state.notifDisplayLimit = 5;
      renderNotifications();
    }
  });

  document.getElementById('notif-clear')?.addEventListener('click', async () => {
    await window.markAllNotifRead();
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
  const isMobile = window.innerWidth <= 768;
  const sidebarId = 'file-sidebar-overlay';
  const backdropId = 'file-sidebar-backdrop';

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">File Explorer</div>
        <div class="page-subtitle">.hermes directory browser</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        ${isMobile ? `<button class="btn btn-ghost" id="toggle-file-sidebar" onclick="toggleFileSidebar()">☰ Files</button>` : ''}
        <button class="btn btn-ghost" onclick="loadFileExplorer(document.querySelector('.page.active'), '')">⌂ Root</button>
        <button class="btn btn-ghost" onclick="loadFileExplorer(document.querySelector('.page.active'), '${dirPath}')">↻ Refresh</button>
      </div>
    </div>
    <div class="file-explorer-split">
      ${isMobile ? `<div id="${backdropId}" class="file-sidebar-backdrop" onclick="toggleFileSidebar()" style="display:none;"></div>` : ''}
      <div class="file-tree-panel" id="${sidebarId}" style="${isMobile ? 'display:none;position:fixed;top:0;left:0;bottom:0;width:280px;z-index:300;margin:0;transform:translateX(-100%);transition:transform .25s ease;' : ''}">
        <div id="file-tree"><div class="loading">Loading...</div></div>
      </div>
      <div class="file-editor-panel" id="file-editor-panel" style="display:none;">
        <div class="file-editor-toolbar">
          <span id="file-editor-path" class="file-editor-path">Select a file</span>
          <div style="display:flex;gap:4px;">
            ${isMobile ? `<button class="btn btn-ghost btn-sm" onclick="toggleFileSidebar()" style="display:inline-flex;">☰</button>` : ''}
            <button class="btn btn-ghost btn-sm" id="file-save-btn" style="display:none;" onclick="saveCurrentFile()">Save</button>
          </div>
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

    // Breadcrumb — scrollable on mobile
    const parts = res.path ? res.path.split('/').filter(Boolean) : [];
    let breadcrumb = `<div class="file-breadcrumb" style="overflow-x:auto;white-space:nowrap;"><span class="file-link" onclick="loadFileExplorer(document.querySelector('.page.active'), '')">⌂ .hermes</span>`;
    let accum = '';
    for (const part of parts) {
      accum += '/' + part;
      breadcrumb += ` / <span class="file-link" onclick="loadFileExplorer(document.querySelector('.page.active'), '${accum.slice(1)}')">${part}</span>`;
    }
    breadcrumb += '</div>';

    // File list
    let itemsHtml = '';
    if (res.path) {
      itemsHtml += `<div class="file-item file-dir" style="min-height:44px;" onclick="loadFileExplorer(document.querySelector('.page.active'), '${res.parent}');${isMobile?'toggleFileSidebar();':''}"><span>📁 ..</span></div>`;
    }
    for (const item of res.items) {
      const icon = item.type === 'directory' ? '📁' : '📄';
      const size = item.type === 'file' ? ` <span class="file-meta">${formatFileSize(item.size)}</span>` : '';
      const action = item.type === 'directory'
        ? `loadFileExplorer(document.querySelector('.page.active'), '${item.path}');${isMobile?'toggleFileSidebar();':''}`
        : `openFileInEditor('${item.path}');${isMobile?'toggleFileSidebar();':''}`;
      itemsHtml += `<div class="file-item ${item.type === 'directory' ? 'file-dir' : 'file-file'}" style="min-height:44px;" onclick="${action}"><span>${icon} ${item.name}</span>${size}</div>`;
    }

    treeEl.innerHTML = breadcrumb + (itemsHtml || '<div class="empty">Empty directory</div>');
  } catch (e) {
    document.getElementById('file-tree').innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
  }
}

window.toggleFileSidebar = function() {
  const sidebar = document.getElementById('file-sidebar-overlay');
  const backdrop = document.getElementById('file-sidebar-backdrop');
  if (!sidebar) return;
  const isOpen = sidebar.style.display !== 'none' || sidebar.style.transform === '';
  if (isOpen) {
    sidebar.style.display = 'none';
    sidebar.style.transform = 'translateX(-100%)';
    if (backdrop) backdrop.style.display = 'none';
  } else {
    sidebar.style.display = 'flex';
    sidebar.style.transform = 'translateX(0)';
    if (backdrop) backdrop.style.display = 'block';
  }
};

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

// ============================================
// Logs Functions
// Logs page with pagination
const LOGS_MAX_LINES = 500;

// Level shortcut mapping
const LEVEL_MAP = { info: 'INF', debug: 'DBG', error: 'ERR', warn: 'WRN', system: 'SYS', user: 'USR' };
const LEVEL_STYLES = {
  INF: 'color:var(--fg-muted)',
  DBG: 'color:var(--fg-subtle)',
  ERR: 'color:var(--coral,#ff6b6b);font-weight:600',
  WRN: 'color:var(--gold,#ffac02)',
  SYS: 'color:var(--teal,#4ecdc4)',
  USR: 'color:var(--purple,#a78bfa)',
};

async function loadLogs(container) {
  state._logsData = [];
  state._logsAutoRefresh = true;
  state._logsMode = 'poll';
  state._logsStickyBottom = true;
  state._logsLevel = '';
  state._logsComponent = '';

  container.innerHTML = `
    <div id="logs-bar" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid var(--border);margin-bottom:8px;">
      <div style="display:flex;align-items:center;gap:6px;">
        <select id="logs-source" class="log-level-select" onchange="refreshLogs()" style="width:100px;">
          <option value="all">all</option>
          <option value="agent">agent</option>
          <option value="error">errors</option>
          <option value="gateway">gateway</option>
        </select>
      </div>
      <div style="display:flex;align-items:center;gap:4px;">
        <span style="font-size:11px;color:var(--fg-muted);">Level:</span>
        <div id="logs-level-btns" style="display:flex;gap:3px;">
          <button class="btn btn-ghost btn-sm logs-lvl-btn active" data-level="" onclick="setLogsLevel('')">ALL</button>
          <button class="btn btn-ghost btn-sm logs-lvl-btn" data-level="info" onclick="setLogsLevel('info')">INF</button>
          <button class="btn btn-ghost btn-sm logs-lvl-btn" data-level="debug" onclick="setLogsLevel('debug')">DBG</button>
          <button class="btn btn-ghost btn-sm logs-lvl-btn" data-level="warn" onclick="setLogsLevel('warn')">WRN</button>
          <button class="btn btn-ghost btn-sm logs-lvl-btn" data-level="error" onclick="setLogsLevel('error')">ERR</button>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:4px;">
        <span style="font-size:11px;color:var(--fg-muted);">Lines:</span>
        <select id="logs-lines" class="log-level-select" onchange="refreshLogs()" style="width:70px;">
          <option value="50">50</option>
          <option value="100" selected>100</option>
          <option value="200">200</option>
          <option value="500">500</option>
        </select>
      </div>
      <div style="display:flex;align-items:center;gap:4px;">
        <span style="font-size:11px;color:var(--fg-muted);">Search:</span>
        <input id="logs-search" class="search-input" placeholder="keyword..." oninput="debounceLogsSearch()" style="width:140px;" />
      </div>
      <div style="display:flex;align-items:center;gap:4px;margin-left:auto;">
        <button class="btn btn-ghost btn-sm" id="logs-auto-btn" onclick="toggleLogsAuto()">● auto</button>
        <select id="logs-mode" class="log-level-select" onchange="setLogsMode(this.value)" style="width:60px;" title="Refresh mode">
          <option value="poll">poll</option>
          <option value="stream">stream</option>
        </select>
        <button class="btn btn-ghost btn-sm" onclick="clearLogs()">Clear</button>
        <button class="btn btn-ghost btn-sm" onclick="refreshLogs()">⟳</button>
      </div>
    </div>
    <div id="logs-component-bar" style="display:none;margin-bottom:6px;padding:4px 8px;background:var(--bg-inset);border-radius:6px;font-size:11px;align-items:center;gap:6px;">
      <span style="color:var(--fg-muted);">Filtering:</span>
      <span id="logs-component-tag" style="color:var(--teal);font-weight:600;"></span>
      <button class="btn btn-ghost btn-sm" onclick="clearLogsComponent()" style="font-size:10px;padding:1px 6px;">✕</button>
    </div>
    <div id="logs-panel" style="position:relative;max-height:calc(100vh - 280px);overflow-y:auto;font-family:var(--font-mono,monospace);font-size:12px;line-height:1.7;"></div>
    <div id="logs-jump-btn" style="display:none;position:fixed;bottom:80px;right:24px;z-index:100;">
      <button class="btn btn-primary btn-sm" onclick="scrollLogsBottom()" style="box-shadow:0 2px 8px rgba(0,0,0,0.3);">↓ New logs</button>
    </div>
    <div id="logs-stats" style="display:flex;align-items:center;gap:12px;padding:6px 0;font-size:11px;color:var(--fg-muted);border-top:1px solid var(--border);margin-top:8px;"></div>
  `;

  // Track scroll to show/hide jump button
  const panel = document.getElementById('logs-panel');
  if (panel) {
    panel.addEventListener('scroll', () => {
      const atBottom = (panel.scrollHeight - panel.scrollTop - panel.clientHeight) < 40;
      state._logsStickyBottom = atBottom;
      const jumpBtn = document.getElementById('logs-jump-btn');
      if (jumpBtn) jumpBtn.style.display = atBottom ? 'none' : 'block';
    });
  }

  refreshLogs();
}

// ============================================
// Monitoring Page
// ============================================
async function loadMonitoring(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">System Monitor</div>
        <div class="page-subtitle">Real-time system resource metrics</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost" onclick="loadMonitoring(document.querySelector('.page.active'))">↻ Refresh</button>
      </div>
    </div>

    <!-- Key metrics bar -->
    <div id="mon-overview" class="mon-overview" style="margin-top:12px;">
      <div class="loading">Loading metrics…</div>
    </div>

    <!-- Metrics grid -->
    <div id="mon-grid" class="mon-grid" style="margin-top:16px;">
      <div class="mon-card" id="mon-cpu">
        <div class="mon-card-title">CPU Usage</div>
        <div class="mon-card-body">
          <div class="mon-big-val" id="mon-cpu-val">—</div>
          <div class="mon-sub" id="mon-cpu-sub">%</div>
        </div>
      </div>
      <div class="mon-card" id="mon-mem">
        <div class="mon-card-title">Memory</div>
        <div class="mon-card-body">
          <div class="mon-big-val" id="mon-mem-val">—</div>
          <div class="mon-sub" id="mon-mem-sub">MB</div>
        </div>
      </div>
      <div class="mon-card" id="mon-disk">
        <div class="mon-card-title">Disk</div>
        <div class="mon-card-body">
          <div class="mon-big-val" id="mon-disk-val">—</div>
          <div class="mon-sub" id="mon-disk-sub"></div>
        </div>
      </div>
      <div class="mon-card" id="mon-procs">
        <div class="mon-card-title">Processes</div>
        <div class="mon-card-body">
          <div class="mon-big-val" id="mon-procs-val">—</div>
          <div class="mon-sub">running</div>
        </div>
      </div>
    </div>

    <!-- Secondary metrics -->
    <div id="mon-secondary" class="mon-grid" style="margin-top:16px;">
      <div class="mon-card" id="mon-load">
        <div class="mon-card-title">Load Average</div>
        <div class="mon-card-body" style="display:flex;gap:16px;align-items:baseline;">
          <div><div class="mon-big-val" style="font-size:16px;" id="mon-load1">—</div><div class="mon-sub" style="font-size:10px;">1m</div></div>
          <div><div class="mon-big-val" style="font-size:16px;" id="mon-load5">—</div><div class="mon-sub" style="font-size:10px;">5m</div></div>
          <div><div class="mon-big-val" style="font-size:16px;" id="mon-load15">—</div><div class="mon-sub" style="font-size:10px;">15m</div></div>
        </div>
      </div>
      <div class="mon-card" id="mon-net">
        <div class="mon-card-title">Network I/O</div>
        <div class="mon-card-body" style="display:flex;flex-direction:column;gap:4px;">
          <div class="mon-stat-row"><span class="mon-stat-label">Interface</span><span class="mon-stat-val" id="mon-net-iface">—</span></div>
          <div class="mon-stat-row"><span class="mon-stat-label">Bytes</span><span class="mon-stat-val" id="mon-net-bytes">—</span></div>
          <div class="mon-stat-row"><span class="mon-stat-label">Packets</span><span class="mon-stat-val" id="mon-net-packets">—</span></div>
        </div>
      </div>
      <div class="mon-card" id="mon-node-mem">
        <div class="mon-card-title">Node.js Memory</div>
        <div class="mon-card-body" style="display:flex;flex-direction:column;gap:4px;">
          <div class="mon-stat-row"><span class="mon-stat-label">RSS</span><span class="mon-stat-val" id="mon-node-rss">—</span></div>
          <div class="mon-stat-row"><span class="mon-stat-label">Heap Used</span><span class="mon-stat-val" id="mon-node-heap">—</span></div>
          <div class="mon-stat-row"><span class="mon-stat-label">Heap Total</span><span class="mon-stat-val" id="mon-node-heap-total">—</span></div>
        </div>
      </div>
    </div>

    <!-- System info -->
    <div id="mon-info" class="mon-grid" style="margin-top:16px;">
      <div class="mon-card">
        <div class="mon-card-title">Uptime</div>
        <div class="mon-card-body">
          <div class="mon-big-val" style="font-size:18px;" id="mon-uptime-val">—</div>
        </div>
      </div>
      <div class="mon-card">
        <div class="mon-card-title">Versions</div>
        <div class="mon-card-body" style="display:flex;flex-direction:column;gap:4px;">
          <div class="mon-stat-row"><span class="mon-stat-label">HCI</span><span class="mon-stat-val" id="mon-ver-hci">—</span></div>
          <div class="mon-stat-row"><span class="mon-stat-label">Hermes</span><span class="mon-stat-val" id="mon-ver-hermes">—</span></div>
          <div class="mon-stat-row"><span class="mon-stat-label">Node.js</span><span class="mon-stat-val" id="mon-ver-node">—</span></div>
        </div>
      </div>
    </div>
  `;

  // Fetch and render metrics
  await refreshMonitoring();

  // Auto-refresh every 5 seconds
  if (state._monInterval) clearInterval(state._monInterval);
  state._monInterval = setInterval(() => refreshMonitoring(), 5000);
}

async function refreshMonitoring() {
  try {
    const r = await api('/api/monitoring');
    if (!r.ok) {
      document.getElementById('mon-overview').innerHTML = `<div class="error-msg">${r.error || 'Failed to load metrics'}</div>`;
      return;
    }

    // Overview bar
    document.getElementById('mon-overview').innerHTML = `
      <div class="mon-overview-inner">
        <div class="mon-ov-item"><span class="mon-ov-label">CPU</span><span class="mon-ov-val">${r.cpu || '—'}</span></div>
        <div class="mon-ov-item"><span class="mon-ov-label">Memory</span><span class="mon-ov-val">${r.memory || '—'}</span></div>
        <div class="mon-ov-item"><span class="mon-ov-label">Disk</span><span class="mon-ov-val">${r.disk || '—'}</span></div>
        <div class="mon-ov-item"><span class="mon-ov-label">Processes</span><span class="mon-ov-val">${r.processes || 0}</span></div>
        <div class="mon-ov-item"><span class="mon-ov-label">Load</span><span class="mon-ov-val">${r.load?.avg1 || '—'}, ${r.load?.avg5 || '—'}, ${r.load?.avg15 || '—'}</span></div>
      </div>
    `;

    // Primary metrics
    document.getElementById('mon-cpu-val').textContent = r.cpu?.replace('%', '') || '—';
    document.getElementById('mon-mem-val').textContent = (r.memory || '—').split(' ')[0] || '—';
    document.getElementById('mon-mem-sub').textContent = (r.memory || '').includes('MB') ? 'MB' : '';
    document.getElementById('mon-disk-val').textContent = (r.disk || '—').split(' ')[0] || '—';
    document.getElementById('mon-disk-sub').textContent = (r.disk || '—').split(' ').slice(1).join(' ') || '';
    document.getElementById('mon-procs-val').textContent = r.processes || 0;

    // Load averages
    document.getElementById('mon-load1').textContent = r.load?.avg1 || '—';
    document.getElementById('mon-load5').textContent = r.load?.avg5 || '—';
    document.getElementById('mon-load15').textContent = r.load?.avg15 || '—';

    // Network
    document.getElementById('mon-net-iface').textContent = r.network?.interface || '—';
    document.getElementById('mon-net-bytes').textContent = formatNumber(parseInt(r.network?.bytes) || 0);
    document.getElementById('mon-net-packets').textContent = formatNumber(parseInt(r.network?.packets) || 0);

    // Node.js memory
    document.getElementById('mon-node-rss').textContent = r.node_memory?.rss_mb ? `${r.node_memory.rss_mb} MB` : '—';
    document.getElementById('mon-node-heap').textContent = r.node_memory?.heap_used_mb ? `${r.node_memory.heap_used_mb} MB` : '—';
    document.getElementById('mon-node-heap-total').textContent = r.node_memory?.heap_total_mb ? `${r.node_memory.heap_total_mb} MB` : '—';

    // System info
    document.getElementById('mon-uptime-val').textContent = r.uptime || '—';
    document.getElementById('mon-ver-hci').textContent = r.hci_version || '—';
    document.getElementById('mon-ver-hermes').textContent = r.hermes_version || '—';
    document.getElementById('mon-ver-node').textContent = r.node_version || '—';

  } catch (e) {
    // Silent fail on refresh errors
  }
}

async function refreshLogs() {
  const source = document.getElementById('logs-source')?.value || 'all';
  const lines = document.getElementById('logs-lines')?.value || '100';
  const search = document.getElementById('logs-search')?.value || '';
  const level = state._logsLevel || '';
  const component = state._logsComponent || '';

  try {
    const params = new URLSearchParams({ profile: 'all', source, lines });
    if (level) params.set('level', level);
    if (search) params.set('search', search);

    const r = await api('/api/logs?' + params);
    if (r.ok && r.logs) {
      let logs = r.logs;

      // Client-side component filter
      if (component) {
        logs = logs.filter(l => (l.component || '').toLowerCase() === component.toLowerCase());
      }

      state._logsData = logs;
      renderLogs();
    }
  } catch (e) {
    // Silent fail on refresh errors
  }
}

function renderLogs() {
  const panel = document.getElementById('logs-panel');
  const stats = document.getElementById('logs-stats');
  if (!panel) return;

  const logs = state._logsData;
  if (!logs.length) {
    panel.innerHTML = `<div style="padding:20px;text-align:center;color:var(--fg-subtle);">No log entries</div>`;
    if (stats) stats.innerHTML = '';
    return;
  }

  // Aggregate consecutive duplicate errors
  const aggregated = [];
  let prevKey = '';
  let count = 0;
  for (let i = logs.length - 1; i >= 0; i--) {
    const e = logs[i];
    const key = `${e.level}|${e.message}`;
    if (key === prevKey) {
      count++;
    } else {
      if (prevKey && count > 1) {
        aggregated[aggregated.length - 1].count = count;
      }
      aggregated.push(e);
      prevKey = key;
      count = 1;
    }
  }
  if (count > 1) aggregated[aggregated.length - 1].count = count;

  // Reverse to show newest first
  aggregated.reverse();

  // Level counts
  const lvlCounts = { INF: 0, DBG: 0, ERR: 0, WRN: 0, SYS: 0, USR: 0 };
  logs.forEach(e => {
    const s = LEVEL_MAP[e.level] || 'INF';
    lvlCounts[s] = (lvlCounts[s] || 0) + 1;
  });

  // Collect unique components
  const components = [...new Set(logs.map(e => e.component).filter(Boolean))];

  // Render lines
  let html = aggregated.map(e => {
    const shortLvl = LEVEL_MAP[e.level] || 'INF';
    const style = LEVEL_STYLES[shortLvl] || '';
    const time = e.timestamp ? fmtLogTime(e.timestamp) : '        ';
    const comp = e.component || e.source || '';
    const msg = escapeHtml(e.message || '');
    const countBadge = e.count > 1 ? `<span style="color:var(--coral);font-weight:700;margin-left:4px;">×${e.count}</span>` : '';
    const copyIcon = `<span class="log-copy-icon" onclick="copyLogLine(this)" title="Copy" style="cursor:pointer;opacity:0;transition:opacity 0.15s;color:var(--fg-muted);margin-left:6px;">⧉</span>`;

    // Make component clickable for filtering
    const compSpan = comp ? `<span class="log-comp" onclick="setLogsComponent('${escapeHtml(comp)}')" style="cursor:pointer;color:var(--teal);text-decoration:none;" title="Filter by ${escapeHtml(comp)}">${escapeHtml(comp)}</span>` : '';

    return `<div class="log-line" onmouseenter="this.querySelector('.log-copy-icon').style.opacity=1" onmouseleave="this.querySelector('.log-copy-icon').style.opacity=0" style="display:flex;align-items:baseline;padding:1px 4px;border-radius:3px;${shortLvl === 'ERR' ? 'background:rgba(255,107,107,0.06);' : ''}${shortLvl === 'WRN' ? 'background:rgba(255,172,2,0.04);' : ''}">
      <span style="color:var(--fg-subtle);user-select:none;min-width:70px;">[${time}]</span>
      <span style="${style};min-width:32px;text-align:center;font-weight:600;user-select:none;">${shortLvl}</span>
      ${compSpan ? compSpan + ' ' : '<span style="min-width:40px;"></span>'}
      <span style="flex:1;word-break:break-all;">${msg}${countBadge}</span>${copyIcon}
    </div>`;
  }).join('');

  panel.innerHTML = html;

  // Scroll to bottom if sticky
  if (state._logsStickyBottom) {
    requestAnimationFrame(() => { panel.scrollTop = panel.scrollHeight; });
  }

  // Stats bar
  if (stats) {
    stats.innerHTML = `
      <span>${logs.length} entries</span>
      <span style="color:${LEVEL_STYLES.INF}">INF ${lvlCounts.INF}</span>
      <span style="color:${LEVEL_STYLES.DBG}">DBG ${lvlCounts.DBG}</span>
      <span style="color:${LEVEL_STYLES.WRN}">WRN ${lvlCounts.WRN}</span>
      <span style="color:${LEVEL_STYLES.ERR}">ERR ${lvlCounts.ERR}</span>
      ${components.length > 0 ? `<span style="margin-left:auto;color:var(--fg-subtle);">${components.length} components</span>` : ''}
    `;
  }
}

function fmtLogTime(ts) {
  // Convert ISO or full timestamp to HH:MM:SS
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) {
    // Try extracting time from string
    const m = ts.match(/(\d{2}):(\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}:${m[3]}` : ts.slice(-8);
  }
  return d.toTimeString().slice(0, 8);
}

// --- Log actions ---

function setLogsLevel(lvl) {
  state._logsLevel = lvl;
  document.querySelectorAll('.logs-lvl-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.level === lvl);
  });
  refreshLogs();
}

function setLogsComponent(comp) {
  state._logsComponent = comp;
  const bar = document.getElementById('logs-component-bar');
  const tag = document.getElementById('logs-component-tag');
  if (bar && tag && comp) {
    bar.style.display = 'flex';
    tag.textContent = comp;
  }
  refreshLogs();
}

window.clearLogsComponent = function() {
  state._logsComponent = '';
  const bar = document.getElementById('logs-component-bar');
  if (bar) bar.style.display = 'none';
  refreshLogs();
};

window.clearLogs = function() {
  state._logsData = [];
  renderLogs();
};

window.scrollLogsBottom = function() {
  const panel = document.getElementById('logs-panel');
  if (panel) {
    panel.scrollTop = panel.scrollHeight;
    state._logsStickyBottom = true;
    const jumpBtn = document.getElementById('logs-jump-btn');
    if (jumpBtn) jumpBtn.style.display = 'none';
  }
};

window.copyLogLine = function(icon) {
  const line = icon.closest('.log-line');
  if (!line) return;
  const text = line.textContent.replace('⧉', '').trim();
  navigator.clipboard.writeText(text).then(() => {
    icon.textContent = '✓';
    setTimeout(() => { icon.textContent = '⧉'; }, 1000);
  });
};

// --- Auto refresh ---

function toggleLogsAuto() {
  if (state._logsAutoRefresh) {
    stopLogsAutoRefresh();
  } else {
    state._logsAutoRefresh = true;
    startLogsAutoRefresh();
    refreshLogs();
  }
  updateLogsAutoBtn();
}

function startLogsAutoRefresh() {
  stopLogsAutoRefresh();
  if (state._logsMode === 'stream') {
    // Stream mode: use shorter interval (simulated — real WebSocket in future)
    state._logsInterval = setInterval(refreshLogs, 2000);
  } else {
    // Poll mode: standard 5s interval
    state._logsInterval = setInterval(refreshLogs, 5000);
  }
}

function stopLogsAutoRefresh() {
  if (state._logsInterval) {
    clearInterval(state._logsInterval);
    state._logsInterval = null;
  }
}

function updateLogsAutoBtn() {
  const btn = document.getElementById('logs-auto-btn');
  if (!btn) return;
  if (state._logsAutoRefresh) {
    btn.textContent = '● auto';
    btn.classList.add('active');
  } else {
    btn.textContent = '◯ auto';
    btn.classList.remove('active');
  }
}

function setLogsMode(mode) {
  state._logsMode = mode;
  if (state._logsAutoRefresh) {
    startLogsAutoRefresh();
  }
}

function debounceLogsSearch() {
  clearTimeout(state._logsDebounce);
  state._logsDebounce = setTimeout(refreshLogs, 400);
}

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
window.toggleSessionDetail = toggleSessionDetail;
window.createBackup = createBackup;
window.importBackup = importBackup;
window.hcirestart = hcirestart;
window.hciupdate = hciupdate;
window.hcidoctor = hcidoctor;
window.checkHCIUpdates = checkHCIUpdates;
window.showCommitDiff = showCommitDiff;
window.checkoutCommit = checkoutCommit;
window.runUpdateStream = runUpdateStream;
window.closeModal = closeModal;
window.runHCIUpdate = runHCIUpdate;
window.runHealthCheck = runHealthCheck;
window.runDoctor = runDoctor;
window.openTerminalPanel = openTerminalPanel;
window.loadHome = loadHome;
window.loadAgentDetail = loadAgentDetail;


// ============================================
// Permission Helper
// ============================================
function hasPerm(perm) {
  if (!state.user) return false;
  if (state.user.role === "admin") return true;
  return !!state.user.permissions?.[perm];
}

// Expose for onclick handlers in templates
window.hasPerm = hasPerm;

window.refreshLogs = refreshLogs;
window.toggleLogsAuto = toggleLogsAuto;
window.setLogsLevel = setLogsLevel;
window.setLogsComponent = setLogsComponent;
window.setLogsMode = setLogsMode;
window.debounceLogsSearch = debounceLogsSearch;
window.showCreateUser = showCreateUser;
window.showEditUser = showEditUser;
window.showResetPassword = showResetPassword;
window.togglePwVis = function(btn) {
  const input = btn.previousElementSibling;
  if (input.type === 'password') { input.type = 'text'; btn.textContent = '🙈'; }
  else { input.type = 'password'; btn.textContent = '👁'; }
};

function _isSessionPinned(sid) {
  try { return JSON.parse(localStorage.getItem('hci_pinned_sessions') || '[]').includes(sid); } catch { return false; }
}
window.togglePinSession = function(sid) {
  try {
    const list = JSON.parse(localStorage.getItem('hci_pinned_sessions') || '[]');
    const idx = list.indexOf(sid);
    if (idx >= 0) list.splice(idx, 1); else list.push(sid);
    localStorage.setItem('hci_pinned_sessions', JSON.stringify(list));
    refreshChatSidebar();
  } catch {}
};
window.sendChatMessage = sendChatMessage;
window.loadChatSession = loadChatSession;
window.refreshChatSidebar = refreshChatSidebar;
window.newChatSession = newChatSession;
window.toggleChatSidebar = toggleChatSidebar;
window.filterChatBySource = filterChatBySource;
window.renameChatSession = renameChatSession;
window.deleteChatSession = deleteChatSession;
window.loadLogs = loadLogs;

// Config functions
window.enableEdit = function(type) {
  const contentEl = document.getElementById('config-content');
  if (contentEl) {
    contentEl.dataset.editMode = 'true';
    const cat = type === 'secrets' ? 'secrets' : (state._config?.activeCat || 'model');
    state._config && (state._config.activeCat = cat);
    renderConfigCategory(cat);
  }
};

window.cancelEdit = function(type) {
  const contentEl = document.getElementById('config-content');
  if (contentEl) {
    contentEl.dataset.editMode = 'false';
    const cat = type === 'secrets' ? 'secrets' : (state._config?.activeCat || 'model');
    state._config && (state._config.activeCat = cat);
    renderConfigCategory(cat);
  }
};

// Render Platforms tab — Gateway API config
function renderPlatformsTab(contentEl, config, profile, isEditMode) {
  const apiServer = config.platforms?.api_server || {};
  const enabled = apiServer.enabled || false;
  const extra = apiServer.extra || {};
  const port = extra.port || '—';
  const host = extra.host || '—';
  const cors = extra.cors_origins || '—';
  const keySet = extra.key ? '✅ Set' : '❌ Not set';

  if (isEditMode) {
    contentEl.innerHTML = `
      <div class="card">
        <div class="card-title">🌐 Platforms — Gateway API</div>
        <div style="display:flex;flex-direction:column;gap:12px;margin-top:12px;">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" id="cfg-platforms-enabled" ${enabled ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--gold);" />
            <span style="font-size:13px;">Gateway API Enabled</span>
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;">
            <span style="font-size:12px;color:var(--fg-muted);">Host</span>
            <input type="text" id="cfg-platforms-host" value="${escapeHtml(host)}" style="padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-size:13px;" />
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;">
            <span style="font-size:12px;color:var(--fg-muted);">Port</span>
            <input type="number" id="cfg-platforms-port" value="${port !== '—' ? port : ''}" style="padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-size:13px;" />
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;">
            <span style="font-size:12px;color:var(--fg-muted);">API Key</span>
            <input type="password" id="cfg-platforms-key" value="${escapeHtml(extra.key || '')}" style="padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-size:13px;" />
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;">
            <span style="font-size:12px;color:var(--fg-muted);">CORS Origins (comma-separated)</span>
            <input type="text" id="cfg-platforms-cors" value="${escapeHtml(cors !== '—' ? cors : '')}" style="padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-size:13px;" />
          </label>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-primary" onclick="savePlatformsConfig('${escapeHtml(profile)}')">💾 Save</button>
            <button class="btn" onclick="cancelEdit('platforms')">Cancel</button>
          </div>
        </div>
      </div>
    `;
    return;
  }

  // Read-only view
  const statusColor = enabled ? 'var(--green)' : 'var(--red)';
  const statusText = enabled ? 'Active' : 'Disabled';
  contentEl.innerHTML = `
    <div class="card">
      <div class="card-title">🌐 Platforms — Gateway API</div>
      <div class="stat-row">
        <span class="stat-label">Status</span>
        <span style="color:${statusColor};font-weight:600;">${statusText}</span>
      </div>
      ${enabled ? `
      <div class="stat-row"><span class="stat-label">Host</span><span>${escapeHtml(host)}</span></div>
      <div class="stat-row"><span class="stat-label">Port</span><span style="color:var(--gold);font-weight:600;">${port}</span></div>
      <div class="stat-row"><span class="stat-label">API Key</span><span>${keySet}</span></div>
      <div class="stat-row"><span class="stat-label">CORS</span><span style="font-size:11px;">${escapeHtml(cors)}</span></div>
      ` : '<div class="stat-row"><span class="stat-label" style="color:var(--fg-muted);">Gateway API is not configured. Click Edit to enable.</span></div>'}
      <div style="margin-top:12px;">
        <button class="btn btn-primary" onclick="enableEdit('platforms')">✏️ Edit</button>
      </div>
    </div>
  `;
}

window.savePlatformsConfig = async function(profile) {
  const enabled = document.getElementById('cfg-platforms-enabled')?.checked;
  const host = document.getElementById('cfg-platforms-host')?.value || '127.0.0.1';
  const port = parseInt(document.getElementById('cfg-platforms-port')?.value || '8650');
  const key = document.getElementById('cfg-platforms-key')?.value || '';
  const cors = document.getElementById('cfg-platforms-cors')?.value || '';

  const newConfig = JSON.parse(JSON.stringify(state._config.config));
  newConfig.platforms = {
    api_server: {
      enabled,
      extra: { host, port, key, cors_origins: cors },
    },
  };

  try {
    const csrfToken = state.csrfToken || '';
    const res = await api('/api/config/' + encodeURIComponent(profile), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ config: newConfig }),
    });
    if (res.ok) {
      showToast('Platforms config saved', 'success');
      state._config.config = newConfig;
      cancelEdit('platforms');
    } else {
      showToast(res.error || 'Save failed', 'error');
    }
  } catch (e) {
    showToast('Save failed: ' + e.message, 'error');
  }
};

// Render config category (form-based per-field editor)
function renderConfigCategory(catKey) {
  const contentEl = document.getElementById('config-content');
  if (!contentEl || !state._config) return;
  const isEditMode = contentEl.dataset.editMode === 'true';
  const { config, rawYaml, profile } = state._config;

  if (catKey === 'raw') {
    contentEl.innerHTML = `<div class="card"><div class="card-title">Raw Config</div><pre style="font-size:11px;white-space:pre-wrap;max-height:500px;overflow-y:auto;color:var(--fg-muted);">${escapeHtml(rawYaml || JSON.stringify(config, null, 2))}</pre></div>`;
    return;
  }

  if (catKey === 'secrets') {
    loadSecretsTab(contentEl, profile, isEditMode);
    return;
  }

  if (catKey === 'platforms') {
    renderPlatformsTab(contentEl, config, profile, isEditMode);
    return;
  }

  const catConfig = config[catKey];
  if (!catConfig || (typeof catConfig === 'object' && Object.keys(catConfig).length === 0)) {
    contentEl.innerHTML = `<div class="card"><div class="card-title">${catKey}</div><div class="stat-row"><span class="stat-label">No settings configured</span></div></div>`;
    return;
  }

  if (isEditMode) {
    // Form-based editing: each field gets its own input
    const fieldRows = Object.entries(catConfig).map(([k, v]) => {
      const isObj = typeof v === 'object' && v !== null;
      const isBool = typeof v === 'boolean';
      const isNum = typeof v === 'number';
      const isSensitive = /key|token|secret|password|passwd/i.test(k);

      if (isObj) {
        // Nested object — show collapsed with raw JSON viewer
        return `
          <div style="margin-bottom:12px;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;">
            <div style="background:var(--bg-inset);padding:8px 12px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
              <span style="font-size:12px;font-weight:600;color:var(--fg);">${escapeHtml(k)}</span>
              <span style="font-size:11px;color:var(--fg-muted);">${Object.keys(v).length} nested values ▾</span>
            </div>
            <div style="display:none;padding:8px;">
              <textarea id="cfg-nested-${escapeHtml(k)}" style="width:100%;min-height:120px;font-family:var(--font-mono,monospace);font-size:11px;background:var(--bg-input);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:8px;resize:vertical;" spellcheck="false">${escapeHtml(JSON.stringify(v, null, 2))}</textarea>
            </div>
          </div>
        `;
      }

      if (isBool) {
        return `
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;min-width:200px;">
              <input type="checkbox" id="cfg-${escapeHtml(k)}" ${v ? 'checked' : ''} data-cfg-key="${escapeHtml(k)}" data-cfg-type="bool"
                style="width:16px;height:16px;accent-color:var(--gold);cursor:pointer;" />
              <span style="font-size:12px;color:var(--fg);">${escapeHtml(k)}</span>
            </label>
            <span style="font-size:11px;color:var(--fg-muted);">boolean</span>
          </div>
        `;
      }

      if (isNum) {
        return `
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
            <label style="min-width:200px;">
              <span style="font-size:12px;color:var(--fg);">${escapeHtml(k)}</span>
            </label>
            <input type="number" id="cfg-${escapeHtml(k)}" value="${v}" data-cfg-key="${escapeHtml(k)}" data-cfg-type="num"
              style="flex:1;background:var(--bg-input);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:12px;" />
          </div>
        `;
      }

      // String value
      const inputType = isSensitive ? 'password' : 'text';
      return `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
          <label style="min-width:200px;">
            <span style="font-size:12px;color:var(--fg);">${escapeHtml(k)}</span>
          </label>
          <div style="display:flex;flex:1;gap:4px;">
            <input type="${inputType}" id="cfg-${escapeHtml(k)}" value="${escapeHtml(String(v ?? ''))}" data-cfg-key="${escapeHtml(k)}" data-cfg-type="str"
              style="flex:1;background:var(--bg-input);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:12px;" />
            ${isSensitive ? `<button type="button" onclick="this.previousElementSibling.type=this.previousElementSibling.type==='password'?'text':'password'" style="background:none;border:none;cursor:pointer;font-size:14px;padding:4px;color:var(--fg-muted);">👁</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    contentEl.innerHTML = `
      <div class="card">
        <div class="card-title">${catKey} — Editing</div>
        <div style="max-height:60vh;overflow-y:auto;padding-right:4px;">
          ${fieldRows}
        </div>
        <div style="display:flex;gap:8px;margin-top:14px;">
          <button class="btn btn-primary" onclick="window.saveConfigForm('${profile}','${catKey}')">💾 Save changes</button>
          <button class="btn btn-ghost" onclick="window.cancelEdit('${catKey}')">↺ Revert</button>
        </div>
      </div>
    `;
  } else {
    // View mode: stat rows with Edit button
    let rows = '';
    if (typeof catConfig === 'object') {
      rows = Object.entries(catConfig).map(([k, v]) => {
        const isObj = typeof v === 'object' && v !== null;
        const isBool = typeof v === 'boolean';
        let display, cls;
        if (isBool) {
          display = v ? '✓ enabled' : '✗ disabled';
          cls = v ? 'status-ok' : 'status-off';
        } else if (isObj) {
          display = `{${Object.keys(v).length} keys}`;
          cls = '';
        } else {
          display = String(v ?? '');
          cls = '';
        }
        return `<div class="stat-row"><span class="stat-label">${escapeHtml(k)}</span><span class="stat-value ${cls}">${escapeHtml(display)}</span></div>`;
      }).join('');
    }
    // Edit button at TOP (not bottom)
    const editBtn = `
      <div style="margin-bottom:12px;">
        <button class="btn btn-primary" onclick="window._enableEditLocal('${catKey}')">✏️ Edit ${state._config?.categories?.find(c => c.key === catKey)?.label || catKey}</button>
      </div>
    `;
    contentEl.innerHTML = `
      <div class="card">
        ${editBtn}
        <div class="card-title">${state._config?.categories?.find(c => c.key === catKey)?.label || catKey}</div>
        ${rows}
      </div>
    `;
  }
}

// Export for inline onclick handlers
window.renderConfigCategory = renderConfigCategory;

// Save config from form-based editor
window.saveConfigForm = async function(profile, category) {
  const catConfig = state._config?.config[category];
  if (!catConfig) { showToast('Config not loaded', 'error'); return; }

  // Start with existing config, apply changes
  const updated = JSON.parse(JSON.stringify(catConfig));

  // Process form inputs
  document.querySelectorAll('[data-cfg-key]').forEach(input => {
    const key = input.dataset.cfgKey;
    const type = input.dataset.cfgType;
    if (type === 'bool') {
      updated[key] = input.checked;
    } else if (type === 'num') {
      updated[key] = Number(input.value);
    } else {
      updated[key] = input.value;
    }
  });

  // Process nested JSON fields
  Object.keys(catConfig).forEach(k => {
    if (typeof catConfig[k] === 'object' && catConfig[k] !== null) {
      const ta = document.getElementById('cfg-nested-' + k);
      if (ta) {
        try {
          updated[k] = JSON.parse(ta.value);
        } catch {
          showToast(`Invalid JSON in "${k}"`, 'error');
          return;
        }
      }
    }
  });

  try {
    const res = await api('/api/config/' + encodeURIComponent(profile), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
      body: JSON.stringify({ config: { [category]: updated } })
    });
    if (res.ok) {
      if (state._config) state._config.config[category] = updated;
      showToast('Config saved', 'success');
      cancelEdit(category);
    } else {
      showToast(res.output || 'Save failed', 'error');
    }
  } catch (e) { showToast(e.message, 'error'); }
};

// Secrets editor — grouped categories, hermes-agent dashboard style
async function loadSecretsTab(contentEl, profile, isEditMode) {
  contentEl.innerHTML = `<div class="card"><div class="card-title">Environment Secrets</div><div class="loading">Loading secrets...</div></div>`;
  try {
    const res = await api(`/api/keys/${profile}`);
    if (!res.ok) {
      contentEl.innerHTML = `<div class="card"><div class="card-title">Secrets</div><div class="error-msg">${escapeHtml(res.error || 'Failed to load')}</div></div>`;
      return;
    }

    const categories = res.categories || [];
    const allKeys = res.keys || [];

    // Check if there are advanced keys
    const hasAdvanced = allKeys.some(k => k.is_advanced);

    let html = `<div class="card">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>Environment Secrets</span>
        <div style="display:flex;gap:8px;align-items:center;">
          ${hasAdvanced ? `<button class="btn btn-ghost btn-sm" id="adv-toggle-btn" onclick="window.toggleAdvancedSecrets()">Show Advanced (${allKeys.filter(k=>k.is_advanced).length})</button>` : ''}
          ${isEditMode
            ? `<button class="btn btn-primary btn-sm" onclick="window.saveSecrets('${profile}')">💾 Save</button><button class="btn btn-ghost btn-sm" onclick="window.cancelEdit('secrets')">↺ Revert</button>`
            : `<button class="btn btn-primary btn-sm" onclick="window.enableEdit('secrets')">✏️ Edit</button>`}
        </div>
      </div>`;

    if (categories.length === 0) {
      html += `<div class="stat-row"><span class="stat-label">No secrets configured</span></div>`;
    } else {
      categories.forEach((cat, ci) => {
        const catId = `sec-cat-${ci}`;
        const isAdvCat = cat.name === 'Advanced' || cat.name === 'MCP Keys';
        html += `
          <div style="margin-top:${ci > 0 ? '16px' : '0'};">
            <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer;" onclick="window.toggleSecretCat('${catId}')">
              <span style="font-size:13px;font-weight:600;color:var(--fg);">${escapeHtml(cat.name)}</span>
              <span style="font-size:11px;color:var(--fg-muted);">(${cat.keys.length})</span>
              <span style="font-size:11px;color:var(--fg-muted);margin-left:auto;">▾</span>
            </div>
            <div id="${catId}" class="secret-cat-body">
              ${cat.keys.map(k => {
                const rowId = `sec-row-${profile}-${k.name}`;
                const inputId = `sec-input-${k.name}`;
                if (isEditMode) {
                  return `
                    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-subtle);" id="${rowId}">
                      <div style="min-width:200px;">
                        <div style="font-family:var(--font-mono,monospace);font-size:12px;color:var(--fg);">${escapeHtml(k.name)}</div>
                        <div style="font-size:10px;color:var(--fg-muted);">${escapeHtml(k.description || '')}</div>
                      </div>
                      <div style="flex:1;display:flex;gap:4px;">
                        <input id="${inputId}" type="password" data-secret-name="${escapeHtml(k.name)}" data-secret-new="false" value="" placeholder="${k.has_value ? '••••••••' : 'Enter value...'}" style="flex:1;background:var(--bg-input);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:12px;" />
                        <button type="button" onclick="this.previousElementSibling.type=this.previousElementSibling.type==='password'?'text':'password'" style="background:none;border:none;cursor:pointer;font-size:13px;padding:4px;color:var(--fg-muted);">👁</button>
                      </div>
                      ${k.provider_url ? `<a href="${escapeHtml(k.provider_url)}" target="_blank" style="font-size:11px;color:var(--teal);text-decoration:none;white-space:nowrap;">Get key →</a>` : '<span style="width:60px;"></span>'}
                      <button class="btn btn-ghost btn-sm" onclick="window.deleteSecret('${escapeHtml(k.name)}','${profile}')" title="Delete">✕</button>
                    </div>
                  `;
                } else {
                  return `
                    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-subtle);" id="${rowId}">
                      <div style="min-width:200px;">
                        <div style="font-family:var(--font-mono,monospace);font-size:12px;color:var(--fg);">${escapeHtml(k.name)}</div>
                        <div style="font-size:10px;color:var(--fg-muted);">${escapeHtml(k.description || '')}</div>
                      </div>
                      <div style="flex:1;">
                        <span class="secret-masked-value" style="font-size:12px;color:var(--fg-muted);font-family:var(--font-mono,monospace);" data-masked="${escapeHtml(k.masked)}">${escapeHtml(k.masked)}</span>
                      </div>
                      ${k.provider_url ? `<a href="${escapeHtml(k.provider_url)}" target="_blank" style="font-size:11px;color:var(--teal);text-decoration:none;white-space:nowrap;">Get key →</a>` : '<span style="width:60px;"></span>'}
                      <button class="btn btn-ghost btn-sm" onclick="window.revealSecret('${escapeHtml(k.name)}','${profile}')" title="Reveal">👁</button>
                    </div>
                  `;
                }
              }).join('')}
            </div>
          </div>
        `;
      });
    }

    // Add new key section (edit mode only)
    if (isEditMode) {
      html += `
        <div style="margin-top:16px;padding:12px;border:1px dashed var(--border);border-radius:var(--radius);">
          <div style="font-size:12px;font-weight:600;color:var(--fg);margin-bottom:8px;">+ Add new key</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <input id="new-secret-name" type="text" placeholder="KEY_NAME" style="width:180px;background:var(--bg-input);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:12px;font-family:var(--font-mono,monospace);" />
            <input id="new-secret-value" type="password" placeholder="value" style="flex:1;background:var(--bg-input);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:12px;" />
            <button type="button" onclick="this.previousElementSibling.type=this.previousElementSibling.type==='password'?'text':'password'" style="background:none;border:none;cursor:pointer;font-size:13px;padding:4px;color:var(--fg-muted);">👁</button>
            <button class="btn btn-primary btn-sm" onclick="window.addSecret('${profile}')">Add</button>
          </div>
        </div>
      `;
    }

    html += `</div>`;
    contentEl.innerHTML = html;

    // In edit mode, load existing values into inputs
    if (isEditMode) {
      allKeys.forEach(k => {
        const input = document.getElementById(`sec-input-${k.name}`);
        if (input) {
          input.dataset.secretNew = 'false';
          // Load current value from reveal endpoint
          (async () => {
            try {
              const rv = await api(`/api/keys/${profile}/reveal/${k.name}`);
              if (rv.ok && rv.value) {
                input.value = rv.value;
                input.placeholder = '';
              }
            } catch {}
          })();
        }
      });
    }

    // Collapse advanced by default
    if (hasAdvanced) {
      allKeys.filter(k => k.is_advanced).forEach((k, i) => {
        const body = document.getElementById(`sec-cat-${categories.findIndex(c => c.name === k.category)}`);
        if (body && i === 0) {
          // collapse advanced categories
          const catIdx = categories.findIndex(c => c.name === k.category);
          if (catIdx > 0) {
            const catBody = document.getElementById(`sec-cat-${catIdx}`);
            if (catBody) catBody.style.display = 'none';
          }
        }
      });
      window._advancedSecretsVisible = false;
    }

  } catch {
    contentEl.innerHTML = `<div class="card"><div class="card-title">Secrets</div><div class="error-msg">Failed to load secrets</div></div>`;
  }
}

window.toggleSecretCat = function(catId) {
  const body = document.getElementById(catId);
  if (!body) return;
  body.style.display = body.style.display === 'none' ? 'block' : 'none';
};

window.toggleAdvancedSecrets = function() {
  window._advancedSecretsVisible = !window._advancedSecretsVisible;
  const btn = document.getElementById('adv-toggle-btn');
  document.querySelectorAll('[id^="sec-cat-"]').forEach((el, idx) => {
    // Find which category this is
    const catBodies = el.id.match(/sec-cat-(\d+)/);
    if (catBodies) {
      // Could check if it's advanced category
    }
  });
  // Simple approach: toggle all sec-cat-* bodies
  const allBodies = Array.from(document.querySelectorAll('[id^="sec-cat-"]'));
  allBodies.forEach(body => {
    if (body.id === 'sec-cat-0') return; // never collapse first category
    body.style.display = window._advancedSecretsVisible ? 'block' : 'none';
  });
  if (btn) {
    btn.textContent = window._advancedSecretsVisible ? 'Hide Advanced' : `Show Advanced (${allBodies.length - 1})`;
  }
};

window.addSecret = async function(profile) {
  const nameInput = document.getElementById('new-secret-name');
  const valueInput = document.getElementById('new-secret-value');
  const name = nameInput?.value.trim();
  const value = valueInput?.value;
  if (!name) { showToast('Enter a key name', 'error'); return; }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    showToast('Key name must match [A-Za-z_][A-Za-z0-9_]*', 'error'); return;
  }
  try {
    const res = await api('/api/keys/' + encodeURIComponent(profile), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
      body: JSON.stringify({ name, value: value || '' })
    });
    if (res.ok) {
      showToast(`Added ${name}`, 'success');
      nameInput.value = '';
      valueInput.value = '';
      // Re-render secrets tab
      loadSecretsTab(document.getElementById('config-content'), profile, true);
    } else {
      showToast(res.output || 'Failed to add', 'error');
    }
  } catch (e) { showToast(e.message, 'error'); }
};

window.revealSecret = async function(keyName, profile) {
  const row = document.getElementById(`sec-row-${profile}-${keyName}`);
  const valueEl = row?.querySelector('.secret-masked-value');
  const btn = row?.querySelector('button[title="Reveal"]') || row?.querySelector('button[title="Hide"]');

  // Toggle off if already revealed
  if (valueEl && valueEl.dataset.revealed === 'true') {
    valueEl.textContent = valueEl.dataset.masked || '••••••••';
    valueEl.dataset.revealed = 'false';
    valueEl.style.color = 'var(--fg-muted)';
    if (btn) btn.title = 'Reveal';
    return;
  }

  try {
    const res = await api(`/api/keys/${profile}/reveal/${keyName}`);
    if (res.ok && res.value) {
      if (valueEl) {
        valueEl.textContent = res.value;
        valueEl.dataset.revealed = 'true';
        valueEl.dataset.masked = valueEl.dataset.masked || valueEl.textContent;
        valueEl.style.color = 'var(--fg)';
      }
      if (btn) btn.title = 'Hide';
    } else {
      showToast(res.error || 'Failed to reveal', 'error');
    }
  } catch (e) {
    showToast(e.message, 'error');
  }
};

window.editSecret = function(keyName, profile) {
  const el = document.querySelector(`#config-input-${keyName}`);
  if (el) {
    el.removeAttribute('readonly');
    el.focus();
  }
};

window.deleteSecret = async function(keyName, profile) {
  if (!await customConfirm(`Delete secret "${keyName}"?`)) return;
  try {
    const res = await api('/api/keys/' + encodeURIComponent(profile) + '/' + encodeURIComponent(keyName), { method: 'DELETE' });
    showToast(res.ok ? 'Secret deleted' : (res.output || 'Failed'), res.ok ? 'success' : 'error');
    if (res.ok) loadAgentConfig(document.getElementById('agent-tab-content'), profile);
  } catch (e) { showToast(e.message, 'error'); }
};

window.saveSecrets = async function(profile) {
  const inputs = document.querySelectorAll('[data-secret-name]');
  let saved = 0, failed = 0;
  for (const input of inputs) {
    const keyName = input.dataset.secretName;
    const newValue = input.value;
    try {
      const res = await api('/api/keys/' + encodeURIComponent(profile), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
        body: JSON.stringify({ name: keyName, value: newValue })
      });
      if (res.ok) saved++;
      else { failed++; showToast(`Failed: ${keyName}`, 'error'); }
    } catch (e) { failed++; showToast(`Error: ${keyName}`, 'error'); }
  }
  showToast(`Saved ${saved} key(s)${failed ? `, ${failed} failed` : ''}`, failed > 0 ? 'warning' : 'success');
  // Re-render secrets tab to reflect saved state
  loadSecretsTab(document.getElementById('config-content'), profile, true);
};

window.saveConfig = async function(profile, category) {
  const textarea = document.getElementById('config-edit-textarea');
  if (!textarea) { showToast('No editor found', 'error'); return; }

  let value;
  try {
    value = JSON.parse(textarea.value);
  } catch {
    showToast('Invalid JSON — fix syntax errors first', 'error');
    return;
  }

  const config = { [category]: value };

  try {
    const res = await api('/api/config/' + encodeURIComponent(profile), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
      body: JSON.stringify({ config })
    });
    showToast(res.ok ? 'Config saved' : (res.output || 'Save failed'), res.ok ? 'success' : 'error');
    if (res.ok) {
      if (state._config) state._config.config[category] = value;
      cancelEdit(category);
    }
  } catch (e) { showToast(e.message, 'error'); }
};

/** Phase 3: Toggle message ⋮ dropdown menu */
function toggleMsgMenu(btn, role) {
  // Close any existing menu first
  closeMsgMenu();
  // Build menu
  const menu = document.createElement('div');
  menu.className = 'msg-menu-dropdown';
  menu.innerHTML = `<button class="msg-menu-item" onclick="forkFromMessageIdx(this)">🔱 Fork session here</button>`;
  document.body.appendChild(menu);
  // Position it relative to the button
  const rect = btn.getBoundingClientRect();
  menu.style.top = rect.bottom + window.scrollY + 2 + 'px';
  menu.style.left = rect.left + window.scrollX + 'px';
  // Store message index on the menu for the fork handler
  const msgDiv = btn.closest('.chat-msg');
  const msgs = Array.from(msgDiv.parentElement.querySelectorAll('.chat-msg'));
  const idx = msgs.indexOf(msgDiv);
  menu.dataset.msgIdx = idx;
  menu.dataset.role = role;
  // Close on outside click
  setTimeout(() => { document.addEventListener('click', closeMsgMenu, { once: true }); }, 0);
}

/** Phase 3: Close message menu */
function closeMsgMenu() {
  document.querySelectorAll('.msg-menu-dropdown').forEach(m => m.remove());
}

/** Phase 3: Fork session from the stored message index */
async function forkFromMessageIdx(el) {
  closeMsgMenu();
  const menu = el.closest('.msg-menu-dropdown');
  const msgIdx = parseInt(menu?.dataset?.msgIdx || '0', 10);
  await forkFromMessage(msgIdx);
}

init();
