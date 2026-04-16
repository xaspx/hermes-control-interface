/* ============================================
   HCI Main Entry Point
   ============================================ */
import { Chart, registerables } from 'chart.js';
Chart.register(...registerables);

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
      case 'chat':
        await loadChat(container);
        break;
      case 'logs':
        await loadLogs(container);
        break;
      default:
        container.innerHTML = `<div class="empty">Page not found</div>`;
    }
  } catch (err) {
    container.innerHTML = `<div class="empty">Error loading page: ${err.message}</div>`;
  }
}

// ============================================
// Chat Functions
// ============================================
async function loadChat(container) {
  container.innerHTML = `
    <div class="chat-sidebar" id="chat-sidebar">
      ${await loadChatSidebar()}
    </div>
    <div class="chat-main" id="chat-main">
      <div class="chat-header" id="chat-header">
        <div class="chat-title" id="chat-title">New Chat</div>
        <div class="chat-status" id="chat-status-session">—</div>
        <div class="chat-status-elapsed" id="chat-status-elapsed"></div>
        <div style="display:flex;gap:4px;">
          <button class="btn btn-ghost btn-sm" onclick="newChatSession()" title="New Chat">+ New</button>
          <button class="btn btn-ghost btn-sm" onclick="renameChatSession()" title="Rename">✏ Rename</button>
          <button class="btn btn-danger btn-sm" onclick="deleteChatSession()" title="Delete">✕ Delete</button>
        </div>
      </div>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-input-area" id="chat-input-area">
        <select id="chat-profile" onchange="loadChatSidebar()" style="width:120px;">
          <option value="default">default</option>
        </select>
        <select id="chat-model" style="width:180px;">
          <option value="">auto</option>
        </select>
        <input id="chat-input" placeholder="Type a message…" onkeydown="if(event.key==='Enter')sendChatMessage()" />
        <button class="btn btn-primary" id="chat-send-btn" onclick="sendChatMessage()">Send</button>
      </div>
    </div>
  `;
  loadChatSession(0);
}

async function loadChatSidebar() {
  const profile = document.getElementById('chat-profile')?.value || 'default';
  let html = `<div style="padding:10px 12px;cursor:pointer;border-bottom:1px solid var(--border);" onclick="newChatSession()">
    <div style="font-size:13px;color:var(--fg);font-weight:500;">+ New Chat</div>
  </div>`;
  try {
    const res = await fetch(`/api/all-sessions?profile=${encodeURIComponent(profile)}`, { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      if (data.sessions && data.sessions.length > 0) {
        const filtered = data.sessions.filter(s => (s.messageCount > 0) || (s.message_count > 0) || (s.title && s.title !== '—'));
        html = `<div style="padding:10px 12px;cursor:pointer;border-bottom:1px solid var(--border);" onclick="newChatSession()">
          <div style="font-size:13px;color:var(--fg);font-weight:500;">+ New Chat</div>
        </div>` + filtered.slice(0, 50).map(s => {
          const title = (s.title && s.title !== '—') ? s.title : s.preview?.substring(0, 40) || s.id;
          const time = s.lastActive || '';
          return `<div style="padding:10px 12px;cursor:pointer;border-bottom:1px solid var(--border);" onclick="loadChatSession('${s.id}')">
            <div style="font-size:12px;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:400;">${escapeHtml(title.substring(0, 45))}</div>
            <div style="font-size:10px;color:var(--fg-subtle);margin-top:3px;display:flex;justify-content:space-between;">
              <span>${s.messageCount || 0} msgs</span><span>${time}</span>
            </div>
          </div>`;
        }).join('');
        if (filtered.length === 0) {
          html += '<div style="text-align:center;color:var(--fg-subtle);padding:20px;font-size:12px;">No conversations yet</div>';
        }
      }
    }
  } catch (e) {}
  const sidebar = document.getElementById('chat-sidebar');
  if (sidebar) sidebar.innerHTML = html;
}

async function loadChatSession(sessionId) {
  const profile = document.getElementById('chat-profile')?.value || 'default';
  const container = document.getElementById('chat-messages');
  const n = document.getElementById('chat-title');
  const stats = document.getElementById('chat-status-session');
  if (!container) return;
  state._currentChatSession = sessionId || 0;
  if (stats) stats.textContent = sessionId || '—';
  container.innerHTML = '<div class="loading">Loading messages</div>';
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages?profile=${encodeURIComponent(profile)}`, { credentials: 'include' });
    if (!r.ok) { container.innerHTML = '<div class="error-msg">Failed to load messages</div>'; return; }
    const i = await r.json();
    if (n) n.textContent = i.title || ('Chat ' + sessionId);
    if (!i.messages || i.messages.length === 0) { container.innerHTML = '<div style="text-align:center;color:var(--fg-subtle);padding:40px;font-size:13px;">No messages in this session yet</div>'; return; }
    container.innerHTML = '';
    for (const m of i.messages) Fu(container, m);
    container.scrollTop = container.scrollHeight;
  } catch (e) { container.innerHTML = '<div class="error-msg">' + Z(e.message) + '</div>'; }
}

function Fu(p, t) {
  const n = t.role || 'unknown';
  const r = { user: { bg: 'var(--accent-dim)', border: 'var(--accent)' }, assistant: { bg: 'var(--bg-card)', border: 'var(--green, #4ade80)' }, tool: { bg: 'rgba(251,146,60,0.08)', border: '#fb923c' }, tool_result: { bg: 'rgba(251,146,60,0.08)', border: '#fb923c' }, system: { bg: 'rgba(156,163,175,0.08)', border: '#9ca3af' } };
  const i = r[n] || r.system;
  const a = document.createElement('div');
  a.style.cssText = 'margin-bottom:8px;padding:10px 12px;border-radius:8px;background:' + i.bg + ';border-left:3px solid ' + i.border + ';';
  const o = t.timestamp ? new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  if (o) { const d = document.createElement('div'); d.style.cssText = 'font-size:10px;color:var(--fg-subtle);margin-bottom:4px;'; d.textContent = o; a.appendChild(d); }
  const e = document.createElement('div');
  let s = t.content || '';
  s = s.replace(/\u256d\u2500+[\\s\\S]*?\u2570\u2500+[^]*?\u256f/g, '');
  s = s.replace(/Resume this session with:.*$/gm, '');
  s = s.replace(/^Session:\\s*\\d+.*$/gm, '');
  s = s.replace(/^Duration:.*$/gm, '');
  s = s.replace(/^Messages:.*$/gm, '');
  s = s.replace(/^Query:.*$/gm, '');
  s = s.replace(/^Initializing agent\\.\\.\\..*$/gm, '');
  s = s.replace(/^-{10,}$/gm, '');
  s = s.trim();
  if (s.includes('\\n\\n')) {
    const parts = s.split('\\n\\n').filter(p => p.trim());
    parts.forEach((part, idx) => {
      const div = document.createElement('div');
      div.style.cssText = 'margin-bottom:4px;font-size:13px;line-height:1.6;color:var(--fg);';
      if (idx === 0 && part.startsWith('```json') && part.endsWith('```')) {
        try {
          const parsed = JSON.parse(part.replace(/```json/, '').replace(/```/, '').trim());
          const pre = document.createElement('pre');
          pre.style.cssText = 'background:var(--bg-panel);padding:8px;border-radius:4px;overflow-x:auto;font-size:11px;color:var(--fg);white-space:pre-wrap;';
          pre.textContent = JSON.stringify(parsed, null, 2);
          div.appendChild(pre);
        } catch (err) { div.textContent = part; }
      } else {
        div.textContent = part;
      }
      e.appendChild(div);
    });
  } else {
    e.style.cssText = 'font-size:13px;line-height:1.6;color:var(--fg);';
    e.textContent = s;
  }
  a.appendChild(e);
  p.appendChild(a);
}

async function newChatSession() {
  const container = document.getElementById('page-chat');
  if (!container) return;
  state._currentChatSession = 0;
  const chatHeader = document.getElementById('chat-header');
  if (chatHeader) chatHeader.querySelector('.chat-title').textContent = 'New Chat';
  const stats = document.getElementById('chat-status-session');
  if (stats) stats.textContent = '—';
  const messages = document.getElementById('chat-messages');
  if (messages) messages.innerHTML = '<div style="text-align:center;color:var(--fg-subtle);padding:60px 20px;"><div style="font-size:24px;margin-bottom:12px;">💬</div><div style="font-size:14px;margin-bottom:4px;">New conversation</div><div style="font-size:12px;">Type a message to start</div></div>';
}

async function renameChatSession(sessionId = 0) {
  const titleEl = document.getElementById('chat-title');
  const sessionIdNum = sessionId || parseInt(prompt('Enter session ID to rename:'));
  if (isNaN(sessionIdNum)) return;
  const t = await showModal({ title: 'Rename Session', message: 'Enter a new title for this session.', inputs: [{ placeholder: 'New title' }], buttons: [{ text: 'Cancel', value: false }, { text: 'Rename', value: true, primary: true }] });
  if (!t?.action || !t.inputs?.[0]) return;
  const n = t.inputs[0].trim();
  if (!n) return;
  try {
    const profile = document.getElementById('chat-profile')?.value || 'default';
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionIdNum)}/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' }, body: JSON.stringify({ title: n, profile }) });
    if (r.ok) { showToast(`Session renamed`, 'success'); await loadChatSidebar(); if (sessionIdNum === 0) titleEl.textContent = n; } else showToast(`Rename failed`, 'error');
  } catch (e) { showToast(`Rename failed: ${e.message}`, 'error'); }
}

async function deleteChatSession(sessionId = 0) {
  if (!(await showModal({ title: 'Delete Session', message: 'Delete this session? This cannot be undone.', buttons: [{ text: 'Cancel', value: false }, { text: 'Delete', value: true, primary: true }] })?.action)) return;
  try {
    const profile = document.getElementById('chat-profile')?.value || 'default';
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: { 'X-CSRF-Token': state.csrfToken || '', 'Content-Type': 'application/json' }, credentials: 'include' });
    if (r.ok) { showToast(`Session deleted`, 'success'); await loadChatSidebar(); if (sessionId === 0) { const messages = document.getElementById('chat-messages'); if (messages) messages.innerHTML = '<div style="text-align:center;color:var(--fg-subtle);padding:60px 20px;"><div style="font-size:24px;margin-bottom:12px;">💬</div><div style="font-size:14px;margin-bottom:4px;">New conversation</div><div style="font-size:12px;">Type a message to start</div></div>'; } } else showToast(`Delete failed`, 'error');
  } catch (e) { showToast(`Delete failed: ${e.message}`, 'error'); }
}

async function sendChatMessage() {
  if (state._chatLock) return;
  const input = document.getElementById('chat-input');
  const text = input?.value?.trim();
  if (!text) return;
  const profile = document.getElementById('chat-profile')?.value || 'default';
  const model = document.getElementById('chat-model')?.value || '';
  const sessionId = state._currentChatSession || 0;
  input.value = '';
  input.style.height = 'auto';
  state._chatLock = true;
  const btn = document.getElementById('chat-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  const messagesDiv = document.getElementById('chat-messages');
  if (messagesDiv) {
    const existing = messagesDiv.querySelector('[style*="text-align:center"]');
    if (existing) existing.remove();
    messagesDiv.appendChild(createMessageDiv('user', text));
  }
  const streamEl = document.createElement('div');
  streamEl.id = 'chat-streaming';
  streamEl.style.cssText = 'margin-bottom:8px;padding:10px 12px;border-radius:8px;background:var(--bg-card);border-left:3px solid var(--green, #4ade80);';
  streamEl.innerHTML = '<div style="font-size:10px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;">assistant</div><div id="chat-stream-content" style="font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--fg);"><span class="chat-cursor" style="animation:blink 1s infinite;">▊</span></div>';
  if (messagesDiv) messagesDiv.appendChild(streamEl);
  if (messagesDiv) messagesDiv.scrollTop = messagesDiv.scrollHeight;
  const contentDiv = streamEl.querySelector('#chat-stream-content');
  let fullContent = '';
  let startTime = Date.now();
  try {
    const body = JSON.stringify({ message: text, profile, sessionId, model });
    const response = await fetch('/api/chat/send', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' }, credentials: 'include', body });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    while (!done) {
      const { done: d, value } = await reader.read();
      if (d) { done = true; break; }
      buffer += decoder.decode(value, { stream: true });
      // Parse SSE data: lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'token') {
            fullContent += evt.content;
            contentDiv.innerHTML = renderChatContent(fullContent) + '<span class="chat-cursor" style="animation:blink 1s infinite;">▊</span>';
            if (messagesDiv) messagesDiv.scrollTop = messagesDiv.scrollHeight;
          } else if (evt.type === 'done') {
            if (evt.sessionId) state._currentChatSession = evt.sessionId;
          } else if (evt.type === 'error') {
            fullContent += '\n[Error: ' + evt.content + ']';
          }
        } catch {}
      }
    }
    // Process remaining buffer
    if (buffer.startsWith('data: ')) {
      try {
        const evt = JSON.parse(buffer.slice(6));
        if (evt.type === 'token') fullContent += evt.content;
        if (evt.type === 'done' && evt.sessionId) state._currentChatSession = evt.sessionId;
      } catch {}
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (contentDiv) {
      contentDiv.innerHTML = renderChatContent(fullContent) + '<div style="font-size:10px;color:var(--fg-subtle);margin-top:8px;">' + elapsed + 's</div>';
    }
    const stats = document.getElementById('chat-status-session');
    const elapsedEl = document.getElementById('chat-status-elapsed');
    if (stats) stats.textContent = state._currentChatSession || '—';
    if (elapsedEl) elapsedEl.textContent = elapsed + 's';
    // Refresh sidebar to show new session
    loadChatSidebar();
  } catch (e) {
    if (contentDiv) contentDiv.innerHTML = renderChatContent(fullContent) + '<div style="color:var(--red);margin-top:8px;">Error: ' + escapeHtml(e.message) + '</div>';
  } finally {
    state._chatLock = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
  }
}

function renderChatContent(text) {
  // Simple markdown-like rendering: code blocks, bold, line breaks
  let html = escapeHtml(text);
  // Code blocks ```...```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre style="background:var(--bg-panel);padding:8px;border-radius:4px;overflow-x:auto;font-size:12px;margin:6px 0;"><code>$2</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code style="background:var(--bg-panel);padding:1px 4px;border-radius:3px;font-size:12px;">$1</code>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return html;
}

function createMessageDiv(role, content) {
  const r = { user: { bg: 'var(--accent-dim)', border: 'var(--accent)' }, assistant: { bg: 'var(--bg-card)', border: 'var(--green, #4ade80)' } };
  const i = r[role] || r.assistant;
  const a = document.createElement('div');
  a.style.cssText = 'margin-bottom:8px;padding:10px 12px;border-radius:8px;background:' + i.bg + ';border-left:3px solid ' + i.border + ';';
  const d = document.createElement('div');
  d.style.cssText = 'font-size:13px;line-height:1.6;color:var(--fg);';
  d.textContent = content;
  a.appendChild(d);
  return a;
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
      <div class="card" id="home-hci-panel"><div class="card-title">HCI</div><div class="loading">Loading</div></div>
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
    `;

    // Load HCI version panel
    loadHCIPanel();

  } catch (e) {
    document.getElementById('home-cards').innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${e.message}</div></div>`;
  }
}

async function loadHCIPanel() {
  const el = document.getElementById('home-hci-panel');
  if (!el) return;
  try {
    const [healthRes, pkgRes] = await Promise.all([
      api('/api/health'),
      api('/api/system/health'),
    ]);
    const hciVersion = (pkgRes?.hci_version) || '—';
    const hermesVersion = (pkgRes?.hermes_version) || '—';
    const nodeVersion = (pkgRes?.node_version) || '—';
    const cpu = (pkgRes?.cpu) || '—';
    const ram = (pkgRes?.ram) || '—';
    const isHealthy = healthRes?.ok || false;

    el.innerHTML = `
      <div class="card-title">HCI</div>
      <div class="stat-row"><span class="stat-label">Version</span><span class="stat-value">${hciVersion}</span></div>
      <div class="stat-row"><span class="stat-label">Hermes</span><span class="stat-value">${hermesVersion}</span></div>
      <div class="stat-row"><span class="stat-label">Node</span><span class="stat-value">${nodeVersion}</span></div>
      <div class="stat-row"><span class="stat-label">CPU</span><span class="stat-value">${cpu}%</span></div>
      <div class="stat-row"><span class="stat-label">RAM</span><span class="stat-value">${ram}</span></div>
      <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value ${isHealthy ? 'status-ok' : 'status-off'}">${isHealthy ? '● Healthy' : '○ Error'}</span></div>
      <div style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm" onclick="hcirestart()">⟲ Restart</button>
        <button class="btn btn-ghost btn-sm" onclick="hciupdate()">↑ Update</button>
        <button class="btn btn-ghost btn-sm" onclick="hcidoctor()">♡ Health Check</button>
      </div>
    `;
  } catch (e) {
    el.innerHTML = `<div class="card-title">HCI</div><div class="error-msg">${e.message}</div>`;
  }
}

async function hcirestart() {
  if (!await customConfirm('Restart HCI? This will take ~2 seconds.', 'Restart')) return;
  try {
    const csrfToken = state.csrfToken || '';
    const res = await api('/api/hci-restart', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } });
    if (res.ok) {
      showToast('HCI restarting...', 'success');
      setTimeout(() => location.reload(), 3000);
    } else {
      showToast(res.error || 'Restart failed', 'error');
    }
  } catch (e) { showToast('Restart failed: ' + e.message, 'error'); }
}

async function hciupdate() {
  if (!await customConfirm('Update HCI? This will git pull, npm install, and rebuild (~30s).', 'Update')) return;
  try {
    const csrfToken = state.csrfToken || '';
    showToast('Updating HCI...', 'info');
    const res = await api('/api/hci/update', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } });
    if (res.ok) {
      showToast('HCI updated! Restarting...', 'success');
      setTimeout(() => location.reload(), 3000);
    } else {
      showToast('Update failed: ' + (res.error || 'unknown'), 'error');
    }
  } catch (e) { showToast('Update failed: ' + e.message, 'error'); }
}

async function hcidoctor() {
  try {
    showToast('Running health check...', 'info');
    const res = await api('/api/doctor', { method: 'POST', headers: { 'X-CSRF-Token': state.csrfToken || '' } });
    if (res.ok && res.output) {
      await customAlert(res.output.substring(0, 2000), 'Health Check');
    } else {
      await customAlert(res.error || 'Health check completed', 'Health Check');
    }
  } catch (e) { showToast('Health check failed: ' + e.message, 'error'); }
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
    container.innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${e.message}</div></div>`;
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
    container.innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${e.message}</div></div>`;
  }
}

window.updateSkill = async function(skillName, profile) {
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
    } else {
      await customAlert(res.error || 'Check failed', 'Error');
    }
  } catch (e) { showToast(e.message, 'error'); }
}
async function loadAgentSessions(container, name) {
  // Load all profiles for agent selector
  let profiles = [];
  try {
    const pRes = await api('/api/profiles');
    if (pRes.ok) profiles = pRes.profiles || [];
  } catch {}

  const profileOptions = profiles.map(p =>
    `<option value="${p.name}" ${p.name === name ? 'selected' : ''}>${p.name}${p.active ? ' (default)' : ''}</option>`
  ).join('');

  container.innerHTML = `
    <div class="card-grid" style="margin-bottom:16px;">
      <div class="card" id="session-stats-${name}">
        <div class="card-title">Session Stats</div>
        <div class="loading">Loading stats...</div>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:16px;align-items:center;flex-wrap:wrap;">
      ${profiles.length > 1 ? `<select id="session-agent-select" class="modal-input" style="width:auto;margin:0;padding:8px 12px;">${profileOptions}</select>` : ''}
      <input type="text" id="session-search" class="search-input" placeholder="Search sessions..." style="flex:1;width:auto;min-width:200px;" />
      <button class="btn btn-ghost" id="session-refresh-btn">↻ Refresh</button>
    </div>
    <div id="sessions-table">
      <div class="loading">Loading sessions...</div>
    </div>
  `;

  const agentSelect = document.getElementById('session-agent-select');
  const refreshBtn = document.getElementById('session-refresh-btn');
  let currentAgent = name;
  let currentPage = 0;
  const PAGE_SIZE = 50;

  async function fetchAndRender(agent) {
    currentAgent = agent;
    currentPage = 0;
    const tableEl = document.getElementById('sessions-table');
    tableEl.innerHTML = '<div class="loading">Loading sessions for ' + escapeHtml(agent) + '...</div>';

    loadSessionStats(agent);

    try {
      const res = await api(`/api/all-sessions?profile=${encodeURIComponent(agent)}`);
      if (!res.ok || !res.sessions || res.sessions.length === 0) {
        tableEl.innerHTML = '<div class="card"><div class="card-title">No sessions found</div></div>';
        state.currentSessions = [];
        return;
      }
      state.currentSessions = res.sessions;
      renderSessions('');
    } catch (e) {
      tableEl.innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${e.message}</div></div>`;
    }
  }

  function renderSessions(filter = '') {
    const sessions = state.currentSessions || [];
    const filtered = filter
      ? sessions.filter(s =>
          (s.title || '').toLowerCase().includes(filter) ||
          (s.id || '').toLowerCase().includes(filter) ||
          (s.source || '').toLowerCase().includes(filter)
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
                    <button class="btn btn-ghost btn-sm" onclick="toggleSessionDetail(this, '${s.id}', '${currentAgent}')" title="View messages">👁</button>
                    <button class="btn btn-ghost btn-sm" onclick="resumeSession('${s.id}')" title="Resume in CLI">▶</button>
                    <button class="btn btn-ghost btn-sm" onclick="renameSession('${s.id}', '${currentAgent}')" title="Rename">✎</button>
                    <button class="btn btn-ghost btn-sm" onclick="exportSession('${s.id}')" title="Export">↓</button>
                    <button class="btn btn-ghost btn-sm btn-danger" onclick="deleteSession('${s.id}', '${currentAgent}')" title="Delete">×</button>
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
  refreshBtn?.addEventListener('click', () => fetchAndRender(agentSelect?.value || currentAgent));

  // Search handler
  document.getElementById('session-search')?.addEventListener('input', (e) => {
    currentPage = 0;
    renderSessions(e.target.value.toLowerCase());
  });

  // Initial load
  await fetchAndRender(name);
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
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages?profile=${encodeURIComponent(profile)}`, { credentials: 'include' });
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
      let content = m.content || '';
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
    `;

    // Load connections
    loadGatewayConnections(name);

  } catch (e) {
    container.innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${e.message}</div></div>`;
  }
}

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
      { key: 'mcp', label: 'MCP Servers', icon: '🔌' },
    ];

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

    function renderCategory(catKey) {
      const contentEl = document.getElementById('config-content');
      if (!contentEl) return;
      const isEditMode = contentEl.dataset.editMode === 'true';

      if (catKey === 'raw') {
        contentEl.innerHTML = `
          <div class="card">
            <div class="card-title">Raw Config (read-only)</div>
            <pre style="font-size:11px;white-space:pre-wrap;max-height:500px;overflow-y:auto;color:var(--fg-muted);">${escapeHtml(rawYaml || JSON.stringify(config, null, 2))}</pre>
          </div>
        `;
        return;
      }

      if (catKey === 'secrets') {
        const keysRes = api(`/api/keys/${name}`).then(r => r.ok ? r : { ok: false, keys: [] });
        
        contentEl.innerHTML = `
          <div class="card">
            <div class="card-title">Environment Secrets</div>
            <div class="loading">Loading secrets...</div>
          </div>
        `;
        
        keysRes.then(keysRes => {
          const keysData = keysRes.ok ? keysRes.keys : [];
          
          let secretsHtml = `
            <div class="card">
              <div class="card-title">Environment Secrets</div>
          `;
          
          if (keysData.length === 0) {
            secretsHtml += `<div class="stat-row"><span class="stat-label">No secrets configured</span></div>`;
          } else {
            secretsHtml += `<table class="data-table"><thead><tr><th>Key</th><th>Value</th><th>Actions</th></tr></thead><tbody>`;
            keysData.forEach(k => {
              const maskedValue = k.masked;
              secretsHtml += `
                <tr>
                  <td class="mono" style="font-size:11px;">${escapeHtml(k.name)}</td>
                  <td><span class="mono" style="font-size:11px;${isEditMode ? '' : 'filter: blur(2px)'}">${isEditMode ? k.value : maskedValue}</span></td>
                  <td style="display:flex;gap:4px;">
                    ${isEditMode ? 
                      `<button class="btn btn-ghost btn-sm" onclick="revealSecret('${k.name}','${name}')">👁</button>
                      <button class="btn btn-ghost btn-sm" onclick="editSecret('${k.name}','${name}')">✎</button>
                      <button class="btn btn-danger btn-sm" onclick="deleteSecret('${k.name}','${name}')">×</button>` :
                      `<button class="btn btn-ghost btn-sm" onclick="revealSecret('${k.name}','${name}')">👁</button>`
                    }
                  </td>
                </tr>
              `;
            });
            secretsHtml += `</tbody></table>`;
          }

          // Edit mode controls
          if (isEditMode) {
            secretsHtml += `
              <div style="margin-top:12px;display:flex;gap:8px;">
                <button class="btn btn-primary" onclick="saveSecrets('${name}')">💾 Save</button>
                <button class="btn btn-ghost" onclick="cancelEdit('secrets')">↺ Revert</button>
              </div>
            `;
          } else {
            secretsHtml += `
              <div style="margin-top:12px;">
                <button class="btn btn-primary" onclick="enableEdit('secrets')">✏️ Edit</button>
              </div>
            `;
          }

          secretsHtml += `</div>`;
          contentEl.innerHTML = secretsHtml;
        }).catch(() => {
          contentEl.innerHTML = `<div class="card"><div class="card-title">Secrets</div><div class="error-msg">Failed to load secrets</div></div>`;
        });
        return;
      }

      const data = config[catKey] || {};
      const entries = Object.entries(data);

      if (entries.length === 0) {
        contentEl.innerHTML = `<div class="card"><div class="card-title">${catKey}</div><div class="stat-row"><span class="stat-label">No settings configured</span></div></div>`;
        return;
      }

      // Edit mode controls
      let editControls = '';
      if (isEditMode) {
        editControls = `
          <div style="margin-bottom:12px;display:flex;gap:8px;">
            <button class="btn btn-primary" onclick="saveConfig('${name}','${catKey}')">💾 Save</button>
            <button class="btn btn-ghost" onclick="cancelEdit('${catKey}')">↺ Revert</button>
          </div>
        `;
      }

      contentEl.innerHTML = `
        <div class="card">
          <div class="card-title">${categories.find(c => c.key === catKey)?.label || catKey}</div>
          ${editControls}
          ${entries.map(([k, v]) => {
            const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
            const isBool = typeof v === 'boolean';
            const isNum = typeof v === 'number';
            
            if (isEditMode) {
              if (isBool) {
                return `
                  <div class="stat-row">
                    <span class="stat-label">${k}</span>
                    <select class="stat-value" id="config-input-${k}">
                      <option value="true" ${v ? 'selected' : ''}>Enabled</option>
                      <option value="false" ${!v ? 'selected' : ''}>Disabled</option>
                    </select>
                  </div>
                `;
              } else if (isNum) {
                return `
                  <div class="stat-row">
                    <span class="stat-label">${k}</span>
                    <input type="number" id="config-input-${k}" value="${v}" style="width:100%;padding:4px 8px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-family:var(--font);font-size:12px;" />
                  </div>
                `;
              } else {
                return `
                  <div class="stat-row">
                    <span class="stat-label">${k}</span>
                    <input type="text" id="config-input-${k}" value="${escapeHtml(val)}" style="width:100%;padding:4px 8px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-family:var(--font);font-size:12px;" />
                  </div>
                `;
              }
            } else {
              return `
                <div class="stat-row">
                  <span class="stat-label">${k}</span>
                  <span class="stat-value">${isBool ? (v ? '✓ enabled' : '✗ disabled') : escapeHtml(val)}</span>
                </div>
              `;
            }
          }).join('')}
        </div>
      `;
    }

    renderCategory(categories[0].key);

    // Tab switching
    document.getElementById('config-tabs')?.addEventListener('click', async (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      document.querySelectorAll('#config-tabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      if (tab.dataset.cat === 'secrets') {
        // Load secrets tab dynamically
        const keysRes = await api(`/api/keys/${name}`);
        const keysData = keysRes.ok ? keysRes.keys : [];
        
        let secretsHtml = `
          <div class="card">
            <div class="card-title">Environment Secrets</div>
        `;
        
        if (keysData.length === 0) {
          secretsHtml += `<div class="stat-row"><span class="stat-label">No secrets configured</span></div>`;
        } else {
          secretsHtml += `<table class="data-table"><thead><tr><th>Key</th><th>Value</th><th>Actions</th></tr></thead><tbody>`;
          keysData.forEach(k => {
            secretsHtml += `
              <tr>
                <td class="mono" style="font-size:11px;">${escapeHtml(k.name)}</td>
                <td><span class="mono" style="font-size:11px;">${k.masked}</span></td>
                <td style="display:flex;gap:4px;">
                  <button class="btn btn-ghost btn-sm" onclick="revealSecret('${k.name}','${name}')">👁</button>
                  <button class="btn btn-ghost btn-sm" onclick="editSecret('${k.name}','${name}')">✎</button>
                  <button class="btn btn-danger btn-sm" onclick="deleteSecret('${k.name}','${name}')">×</button>
                </td>
              </tr>
            `;
          });
          secretsHtml += `</tbody></table>`;
        }

        secretsHtml += `
          </div>
          <div style="margin-top:12px;">
            <button class="btn btn-primary" onclick="enableEdit('secrets')">✏️ Edit</button>
          </div>
        `;
        contentEl.innerHTML = secretsHtml;
      } else {
        renderCategory(tab.dataset.cat);
      }
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
    <div class="card" style="margin-top:16px;">
      <div class="card-title">Daily Token Trend</div>
      <canvas id="usage-chart-tokens" height="200"></canvas>
    </div>
    <div class="card-grid" style="margin-top:16px;">
      <div class="card" style="flex:1;">
        <div class="card-title">Daily Cost</div>
        <canvas id="usage-chart-cost" height="180"></canvas>
      </div>
      <div class="card" style="flex:1;">
        <div class="card-title">Model Distribution</div>
        <canvas id="usage-chart-models" height="180"></canvas>
      </div>
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

  // Fetch both overview + daily data in parallel
  const [res, dailyRes] = await Promise.all([
    api(`/api/usage/${days}${query}`),
    api(`/api/usage/daily/${days}${query}`),
  ]);

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

  // Render charts
  renderUsageCharts(d, dailyRes.ok ? dailyRes : null);

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
      contentEl.innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${e.message}</div></div>`;
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
    overlay.querySelector('.modal-card').innerHTML = `<div class="modal-title">Error</div><div class="error-msg">${e.message}</div><button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()" style="margin-top:12px;">Close</button>`;
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
    if (statusEl) statusEl.innerHTML = `<div style="color:var(--err);margin-top:8px;">❌ ${e.message}</div>`;
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
        <div class="card-title">Health Check</div>
        <div class="stat-row"><span class="stat-label">HCI Status</span><span class="stat-value" id="hc-status">—</span></div>
        <div class="stat-row"><span class="stat-label">Hermes</span><span class="stat-value" id="hc-hermes">—</span></div>
        <div class="stat-row"><span class="stat-label">Node</span><span class="stat-value" id="hc-node">—</span></div>
        <div class="stat-row"><span class="stat-label">DB</span><span class="stat-value" id="hc-db">—</span></div>
        <div class="card-actions" style="margin-top:8px;">
          <button class="btn btn-ghost" onclick="hcidoctor()">Run Health Check</button>
          <button class="btn btn-ghost" onclick="hcirestart()">⟲ Restart HCI</button>
          <button class="btn btn-ghost" onclick="hciupdate()">↑ Update HCI</button>
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
    const [healthRes, apiHealthRes] = await Promise.all([
      api('/api/system/health'),
      api('/api/health'),
    ]);
    if (healthRes.ok) {
      document.getElementById('update-version').textContent = healthRes.hermes_version || '—';
      const hcStatus = document.getElementById('hc-status');
      const hcHermes = document.getElementById('hc-hermes');
      const hcNode = document.getElementById('hc-node');
      const hcDb = document.getElementById('hc-db');
      if (hcStatus) {
        hcStatus.textContent = apiHealthRes.ok ? '● Healthy' : '○ Error';
        hcStatus.className = 'stat-value ' + (apiHealthRes.ok ? 'status-ok' : 'status-off');
      }
      if (hcHermes) hcHermes.textContent = healthRes.hermes_version || '—';
      if (hcNode) hcNode.textContent = healthRes.node_version || '—';
      if (hcDb) hcDb.textContent = healthRes.db_size || '—';
    }
  } catch {}
}

async function loadUsers() {
  try {
    const res = await api('/api/users');
    const el = document.getElementById('users-list');
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

async function createBackup() {
  try {
    showToast('Creating backup...', 'info');
    const csrfToken = state.csrfToken || '';
    const res = await api('/api/backup/create', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } });
    if (res.ok && res.path) {
      const a = document.createElement('a');
      a.href = `/api/backup/download?path=${encodeURIComponent(res.path)}`;
      a.download = res.filename || 'backup.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('Backup downloaded', 'success');
    } else {
      showToast(res.error || 'Backup failed', 'error');
    }
  } catch (e) { showToast('Backup failed: ' + e.message, 'error'); }
}

async function importBackup(input) {
  if (!input.files?.[0]) return;
  const file = input.files[0];
  if (!file.name.endsWith('.zip')) return showToast('Please select a .zip file', 'error');
  if (!confirm('Import backup? This will restore data from the backup file.')) { input.value = ''; return; }
  try {
    showToast('Importing backup...', 'info');
    const csrfToken = state.csrfToken || '';
    const formData = new FormData();
    formData.append('backup', file);
    const res = await fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      body: formData,
      credentials: 'include',
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Backup imported successfully', 'success');
    } else {
      showToast(data.error || 'Import failed', 'error');
    }
  } catch (e) { showToast('Import failed: ' + e.message, 'error'); }
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
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="modal-card" style="max-width:550px;max-height:85vh;overflow-y:auto;">
      <div class="modal-title">Create User</div>
      <form id="create-user-form">
        <div style="margin-bottom:10px;">
          <label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Username</label>
          <input class="modal-input" name="username" placeholder="e.g. bayendor" autocomplete="off" required />
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
            <button type="button" class="btn btn-ghost btn-sm" id="role-admin-btn" onclick="this.closest('form').querySelector('[name=role]').value='admin';document.getElementById('perm-custom-list').style.display='none'">Admin</button>
            <button type="button" class="btn btn-ghost btn-sm" id="role-viewer-btn" onclick="this.closest('form').querySelector('[name=role]').value='viewer';document.getElementById('perm-custom-list').style.display='none'">Viewer</button>
            <button type="button" class="btn btn-ghost btn-sm" id="role-custom-btn" onclick="this.closest('form').querySelector('[name=role]').value='custom';document.getElementById('perm-custom-list').style.display='block'">Custom</button>
          </div>
          <input type="hidden" name="role" value="viewer" />
          <div id="perm-custom-list" style="display:none;">
            <div style="font-size:11px;color:var(--fg-muted);margin-bottom:6px;">Select permissions:</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:12px;" id="perm-checkboxes">
              ${['sessions.view','sessions.messages','logs.view','usage.view','gateway.control','config.edit','secrets.view','secrets.reveal','secrets.edit','skills.browse','skills.install','cron.view','cron.manage','files.read','files.write','terminal','users.manage','hci.update','backup','doctor'].map(p =>
                `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;padding:2px 0;"><input type="checkbox" name="perm" value="${p}" /> ${p}</label>`
              ).join('')}
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

  // Password match check
  const form = overlay.querySelector('#create-user-form');
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
      loadUsers();
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

  const result = await showModal({
    title: `Edit User: ${username}`,
    message: `Role: ${user.role} · ${user.permissions ? Object.values(user.permissions).filter(Boolean).length : 0} permissions`,
    inputs: [
      { placeholder: 'Role (admin/viewer/custom)', value: user.role },
    ],
    buttons: [
      { text: 'Cancel', value: false },
      { text: 'Save', value: true, primary: true },
    ],
  });
  if (!result?.action) return;
  const role = result.inputs[0]?.trim() || user.role;
  if (!['admin', 'viewer', 'custom'].includes(role)) return showToast('Invalid role', 'error');
  try {
    const csrfToken = state.csrfToken || '';
    const res = await api(`/api/users/${encodeURIComponent(username)}`, {
      method: 'PUT',
      headers: { 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ role }),
    });
    if (res.ok) {
      showToast(`User ${username} updated to ${role}`, 'success');
      loadUsers();
    } else {
      showToast(`Failed: ${res.error}`, 'error');
    }
  } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
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
      const unread = state.notifications.filter(n => !n.dismissed).sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
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

// ============================================
// Logs Functions
// ============================================
async function loadLogs(container) {
  container.innerHTML = `
    <div class="logs-toolbar">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <select id="logs-profile" class="log-level-select" onchange="refreshLogs()" style="width:120px;">
          <option value="all">All Profiles</option>
        </select>
        <select id="logs-source" class="log-level-select" onchange="refreshLogs()" style="width:120px;">
          <option value="all">All Sources</option>
        </select>
        <select id="logs-level" class="log-level-select" onchange="refreshLogs()" style="width:120px;">
          <option value="">All Levels</option>
          <option value="error">Error</option>
          <option value="warn">Warning</option>
          <option value="debug">Debug</option>
        </select>
        <input id="logs-search" class="search-input" placeholder="Search logs…" oninput="debounceLogsSearch()" />
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <button class="btn btn-ghost btn-sm" id="logs-auto-btn" onclick="toggleLogsAutoRefresh()">◯ auto</button>
        <button class="btn btn-ghost btn-sm" onclick="refreshLogs()">⟳ Refresh</button>
        <button class="btn btn-ghost btn-sm" onclick="loadMoreNotifs()" style="display:none;" id="logs-load-more">Load more</button>
      </div>
    </div>
    <div id="logs-list"></div>
  `;
  refreshLogs();
}

async function refreshLogs() {
  const profile = document.getElementById("logs-profile")?.value || "all";
  const source = document.getElementById("logs-source")?.value || "all";
  const level = document.getElementById("logs-level")?.value || "";
  const search = document.getElementById("logs-search")?.value || "";
  const container = document.getElementById("logs-list");
  if (!container) return;
  container.innerHTML = '<div class="loading">Loading logs</div>';
  try {
    const o = new URLSearchParams({ profile, source, lines: "300" });
    if (level) o.set("level", level);
    if (search) o.set("search", search);
    const t0 = performance.now();
    const r = await api("/api/logs?" + o);
    const t = Math.round(performance.now() - t0);
    if (r.ok && r.logs) {
      if (r.logs.length === 0) { container.innerHTML = `<div class="empty">No log entries found</div>`; return; }
      container.innerHTML = r.logs.map(e => {
        const lvl = e.level === "error" ? "error-msg" : e.level === "warn" ? "warning" : e.level === "debug" ? "subtle" : "";
        const time = e.timestamp ? e.timestamp.replace(/T/, " ").replace(/\.\d+Z?/, "") : "—";
        const prof = `<span style="color:var(--accent);font-size:10px;">[${escapeHtml(e.profile || '')}]</span>`;
        const src = `<span style="color:var(--fg-subtle);font-size:10px;">[${escapeHtml(e.source || '')}]</span>`;
        return `<div style="padding:3px 0;border-bottom:1px solid var(--border);line-height:1.5;"><div style="font-size:11px;color:var(--fg-muted);">${time} ${prof} ${src}</div><div class="${lvl}" style="font-size:13px;">${escapeHtml(e.message || '')}</div></div>`;
      }).join("");
      const btn = document.getElementById("logs-load-more");
      if (btn) btn.style.display = r.count && r.count >= 300 ? "block" : "none";
    } else { container.innerHTML = `<div class="error-msg">Error loading logs</div>`; }
  } catch (e) { container.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`; }
}

function toggleLogsAutoRefresh() {
  if (state._logsInterval) { clearInterval(state._logsInterval); state._logsInterval = null; document.getElementById("logs-auto-btn").textContent = "◯ auto"; document.getElementById("logs-auto-btn").classList.remove("active"); return; }
  state._logsInterval = setInterval(refreshLogs, 5000);
  const btn = document.getElementById("logs-auto-btn");
  if (btn) { btn.textContent = "● auto"; btn.classList.add("active"); }
  refreshLogs();
}

function debounceLogsSearch() {
  clearTimeout(state._logsDebounce);
  state._logsDebounce = setTimeout(refreshLogs, 400);
}


// ============================================

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

function dismissNotif(el, id) {
  if (el) el.style.opacity = "0.4";
  if (id) {
    const idx = state.notifications.findIndex(n => n.id === id);
    if (idx >= 0) { state.notifications[idx].dismissed = true; md(); }
  }
}

function loadMoreNotifs() {
  if (state._notifExtra) state._notifExtra += 10;
  else state._notifExtra = 10;
  md();
}

window.dismissNotif = dismissNotif;
window.loadMoreNotifs = loadMoreNotifs;
window.refreshLogs = refreshLogs;
window.toggleLogsAutoRefresh = toggleLogsAutoRefresh;
window.debounceLogsSearch = debounceLogsSearch;
window.showCreateUser = showCreateUser;
window.showEditUser = showEditUser;
window.togglePwVis = function(btn) {
  const input = btn.previousElementSibling;
  if (input.type === 'password') { input.type = 'text'; btn.textContent = '🙈'; }
  else { input.type = 'password'; btn.textContent = '👁'; }
};
window.sendChatMessage = sendChatMessage;
window.loadChatSession = loadChatSession;
window.loadChatSidebar = loadChatSidebar;
window.newChatSession = newChatSession;
window.renameChatSession = renameChatSession;
window.deleteChatSession = deleteChatSession;
window.loadLogs = loadLogs;

// Config functions
window.enableEdit = function(type) {
  const contentEl = document.getElementById('config-content');
  if (contentEl) {
    contentEl.dataset.editMode = 'true';
    renderCategory(type === 'secrets' ? 'secrets' : (contentEl.querySelector('.tab.active')?.dataset.cat || categories[0].key));
  }
};

window.cancelEdit = function(type) {
  const contentEl = document.getElementById('config-content');
  if (contentEl) {
    contentEl.dataset.editMode = 'false';
    renderCategory(type === 'secrets' ? 'secrets' : (contentEl.querySelector('.tab.active')?.dataset.cat || categories[0].key));
  }
};

window.revealSecret = async function(keyName, profile) {
  try {
    const res = await api(`/api/keys/${profile}/reveal/${keyName}`);
    if (res.ok) {
      showToast(`Revealed: ${keyName}`, 'info');
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
  const rows = document.querySelectorAll('#config-content table tbody tr');
  let updated = 0;
  for (const row of rows) {
    const keyCell = row.querySelector('td.mono');
    if (!keyCell) continue;
    const keyName = keyCell.textContent.trim();
    const input = row.querySelector('input');
    if (!input) continue;
    const newValue = input.value.trim();
    try {
      const res = await api('/api/keys/' + encodeURIComponent(profile), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
        body: JSON.stringify({ name: keyName, value: newValue })
      });
      if (res.ok) updated++;
      else showToast(`Failed to save ${keyName}: ${res.output}`, 'error');
    } catch (e) {
      showToast(`Failed to save ${keyName}: ${e.message}`, 'error');
    }
  }
  if (updated > 0) {
    showToast(`Saved ${updated} secret(s)`, 'success');
    enableEdit('secrets'); // Re-enable edit mode to persist changes
  }
};

window.saveConfig = async function(profile, category) {
  const rows = document.querySelectorAll('#config-content .stat-row');
  const config = {};
  let hasChanges = false;
  
  for (const row of rows) {
    const label = row.querySelector('.stat-label');
    const input = row.querySelector('input, select');
    if (!label || !input) continue;
    
    const key = label.textContent.trim();
    let value = input.value.trim();
    
    // Parse value based on input type
    if (input.type === 'number') {
      value = Number(value);
    } else if (input.tagName.toLowerCase() === 'select') {
      value = input.value === 'true';
    }
    
    if (!config[category]) config[category] = {};
    config[category][key] = value;
    hasChanges = true;
  }
  
  if (!hasChanges) { showToast('No changes to save', 'info'); return; }
  
  try {
    const res = await api('/api/config/' + encodeURIComponent(profile), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
      body: JSON.stringify({ config })
    });
    showToast(res.ok ? 'Config saved' : (res.output || 'Save failed'), res.ok ? 'success' : 'error');
    if (res.ok) {
      cancelEdit(category);
      // Refresh the tab to show updated values
      const tab = document.querySelector(`#config-tabs .tab[data-cat="${category}"]`);
      if (tab) tab.click();
    }
  } catch (e) { showToast(e.message, 'error'); }
};

init();
