const state = {
  snapshot: null,
  socket: null,
  pollTimer: null,
  clockTimer: null,
  sessionsPoller: null,
  lastLogId: null,
  currentFile: null,
  currentTree: [],
  expandedRoots: new Set(['hermes']),
  expandedDirs: new Set(),
  dirty: false,
  terminalLineCount: 0,
  lastTerminalBufferLength: 0,
  terminal: null,
  terminalFit: null,
  terminalInitRetry: null,
  pendingTerminalBuffer: '',
  terminalFullscreen: false,
  explorerFullscreen: false,
  avatarSource: '',
  avatarImage: null,
  avatarCanvas: null,
  avatarCtx: null,
  avatarState: 'idle',
  avatarLoadId: 0,
  spriteTick: 0,
  widgetLayoutReady: false,
  layoutEditMode: false,
  autoRefreshTimer: null,
  autoRefreshEnabled: true,
  lastTerminalActivity: 0,
  csrfToken: '',
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ============================================
// Group 13: Centralized fetch wrapper with error handling
// ============================================
async function apiFetch(url, options = {}) {
  const h = options.headers || {};
  if (state.csrfToken && !h['X-CSRF-Token']) h['X-CSRF-Token'] = state.csrfToken;
  if (options.body && !h['Content-Type']) h['Content-Type'] = 'application/json';
  try {
    const res = await fetch(url, { ...options, headers: h });
    if (res.status === 401) {
      setLocked(true);
      showToast('Session expired — please log in again', 'error');
      return null;
    }
    if (res.status === 429) {
      showToast('Rate limited — slow down', 'warning');
      return null;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || `Request failed (${res.status})`, 'error');
      return null;
    }
    return await res.json();
  } catch (err) {
    showToast('Network error — check connection', 'error');
    return null;
  }
}

// ============================================
// Group 11: Alert System
// ============================================
const alertState = { lastCount: 0, pollTimer: null, pollInterval: 30000 };

function renderAlerts(notifications) {
  const badge = document.getElementById('alert-badge');
  const list = document.getElementById('alert-list');
  if (!badge || !list) return;
  const unread = notifications.filter(n => !n.dismissed);
  if (unread.length > 0) {
    badge.textContent = unread.length > 99 ? '99' : unread.length;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
  if (notifications.length === 0) {
    list.innerHTML = '<div class="alert-empty">No alerts</div>';
    return;
  }
  const iconMap = { error: '🔴', warning: '🟡', success: '🟢', info: '🔵' };
  list.innerHTML = notifications.map(n => {
    const icon = iconMap[n.type] || '⚪';
    const time = new Date(n.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<div class="alert-item type-${n.type}" data-id="${n.id}">
      <span class="alert-icon">${icon}</span>
      <div class="alert-content">
        <div class="alert-msg">${escHtml(n.message)}</div>
        <div class="alert-time">${time}</div>
      </div>
      <button class="alert-dismiss" data-dismiss="${n.id}" title="Dismiss">×</button>
    </div>`;
  }).join('');
}

async function pollAlerts() {
  const data = await apiFetch('/api/notifications');
  if (data?.ok) {
    renderAlerts(data.notifications || []);
  }
}

function startAlertPolling() {
  stopAlertPolling();
  pollAlerts();
  alertState.pollTimer = setInterval(pollAlerts, alertState.pollInterval);
}

function stopAlertPolling() {
  if (alertState.pollTimer) {
    clearInterval(alertState.pollTimer);
    alertState.pollTimer = null;
  }
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

const els = {
  shell: $('#shell'),
  topbar: $('#topbar'),
  overlay: $('#login-overlay'),
  loginForm: $('#login-form'),
  passwordInput: $('#password-input'),
  loginError: $('#login-error'),
  sidebarAgentStatus: $('#sidebar-agent-status'),
  sidebarAgentModel: $('#sidebar-agent-model'),
  clock: $('#clock'),
  refreshBtn: $('#refresh-btn'),
  layoutEditBtn: $('#layout-edit-btn'),
  layoutSaveBtn: $('#layout-save-btn'),
  logoutBtn: $('#logout-btn'),
  projectsList: null, // removed - projects sidebar gone
  sessionsList: $('#sessions-list'),
  quickActions: $('#quick-actions'),
  agentList: $('#agent-list'),
  terminalOutput: $('#terminal-output'),
  // terminal form removed — xterm.js handles all input directly
  terminalLabel: $('#terminal-label'),
  terminalFullscreenBtn: $('#terminal-fullscreen-btn'),
  fileStatus: $('#file-status'),
  explorerRoots: $('#explorer-roots'),
  projectsTree: $('#projects-tree'),
  hermesTree: $('#hermes-tree'),
  editorPath: $('#editor-path'),
  editorMeta: $('#editor-meta'),
  editor: $('#file-editor'),
  saveBtn: $('#save-file-btn'),
  explorerFullscreenBtn: $('#explorer-fullscreen-btn'),
  sidebarAgentSprite: $('#sidebar-agent-sprite'),
  sidebarAvatarImg: $('#sidebar-avatar-img'),
  sidebarAgentState: $('#sidebar-agent-state'),
  sidebarAgentDetails: $('#sidebar-agent-details'),
  systemPanel: $('#system-panel'),
  cronPanel: $('#cron-panel'),
  tokensPanel: $('#tokens-panel'),
  explorerPanel: $('#explorer-panel'),
  sidebarInfo: $('#sidebar-info'),
  sprite: $('#agent-sprite'),
  agentStateLabel: $('#agent-state-label'),
  agentDetails: $('#agent-details'),
  eventsCount: $('#events-count'),
  tokenProvider: $('#token-provider'),
  loadLabel: $('#load-label'),
  avatarUploadBtn: $('#avatar-upload-btn'),
  avatarResetBtn: $('#avatar-reset-btn'),
  avatarFileInput: $('#avatar-file-input'),
};

const spriteFrames = {
  idle: [
    [
      '................',
      '.....oooooo.....',
      '....oohhhhhho....',
      '...ohhhsssshhho..',
      '..ohhhsseeesshh..',
      '.ohhsseoomoessh..',
      '.ohhsseessssesh..',
      '.ohhssssssssshh..',
      '..ohhsssssssshh..',
      '...ohhhhhhhhhho..',
      '.....ojjjjjjo....',
      '....ojbbbbbbj....',
      '...ojbbttttbbjo..',
      '..ojbbbbbbbbbbjo.',
      '..ojbbbbbbbbbbjo.',
      '...ojppppppppjo..',
      '....ohppppppho...',
      '......ohhhho.....',
    ],
    [
      '................',
      '.....oooooo.....',
      '....oohhhhhho....',
      '...ohhhsssshhho..',
      '..ohhhsseeesshh..',
      '.ohhsseoxxoeessh.',
      '.ohhsseessssesh..',
      '.ohhssssssssshh..',
      '..ohhsssssssshh..',
      '...ohhhhhhhhhho..',
      '.....ojjjjjjo....',
      '....ojbbbbbbj....',
      '...ojbbttttbbjo..',
      '..ojbbbbbbbbbbjo.',
      '..ojbbbbbbbbbbjo.',
      '...ojppppppppjo..',
      '....ohppppppho...',
      '......ohhhho.....',
    ],
  ],
  thinking: [
    [
      '................',
      '.....oooooo.....',
      '....oohhhhhho....',
      '...ohhhsssshhho..',
      '..ohhhsseeesshh..',
      '.ohhsseo--oeessh.',
      '.ohhsseessssesh..',
      '.ohhssssssssshh..',
      '..ohhsssssssshh..',
      '...ohhhhhhhhhho..',
      '.....ojjjjjjo....',
      '....ojbbbbbbj....',
      '...ojbbttttbbjo..',
      '..ojbbbbbbbbbbjo.',
      '..ojbbbbbbbbbbjo.',
      '...ojppppppppjo..',
      '....ohppppppho...',
      '......ohhhho.....',
    ],
    [
      '................',
      '.....oooooo.....',
      '....oohhhhhho....',
      '...ohhhsssshhho..',
      '..ohhhsseeesshh..',
      '.ohhsseoxxoeessh.',
      '.ohhsseessssesh..',
      '.ohhssssssssshh..',
      '..ohhsssssssshh..',
      '...ohhhhhhhhhho..',
      '.....ojjjjjjo....',
      '....ojbbbbbbj....',
      '...ojbbttttbbjo..',
      '..ojbbbbbbbbbbjo.',
      '..ojbbbbbbbbbbjo.',
      '...ojppppppppjo..',
      '....ohppppppho...',
      '......ohhhho.....',
    ],
  ],
  coding: [
    [
      '................',
      '.....oooooo.....',
      '....oohhhhhho....',
      '...ohhhsssshhho..',
      '..ohhhsseeesshh..',
      '.ohhsseoomoessh..',
      '.ohhsseessssesh..',
      '.ohhssssssssshh..',
      '..ohhsssssssshh..',
      '...ohhhhhhhhhho..',
      '.....ojjjjjjo....',
      '....ojbbbbbbj....',
      '...ojbbttttbbjo..',
      '..ojbbbbbbbbbbjo.',
      '..ojbbbbbbbbbbjo.',
      '...ojppppppppjo..',
      '....ohppppppho...',
      '......ohhhho.....',
    ],
    [
      '................',
      '.....oooooo.....',
      '....oohhhhhho....',
      '...ohhhsssshhho..',
      '..ohhhsseeesshh..',
      '.ohhsseoxxoeessh.',
      '.ohhsseessssesh..',
      '.ohhssssssssshh..',
      '..ohhsssssssshh..',
      '...ohhhhhhhhhho..',
      '.....ojjjjjjo....',
      '....ojbbbbbbj....',
      '...ojbbttttbbjo..',
      '..ojbbbbbbbbbbjo.',
      '..ojbbbbbbbbbbjo.',
      '...ojppppppppjo..',
      '....ohppppppho...',
      '......ohhhho.....',
    ],
  ],
  executing: [
    [
      '................',
      '.....oooooo.....',
      '....oohhhhhho....',
      '...ohhhsssshhho..',
      '..ohhhsseeesshh..',
      '.ohhsseoomoessh..',
      '.ohhsseessssesh..',
      '.ohhssssssssshh..',
      '..ohhsssssssshh..',
      '...ohhhhhhhhhho..',
      '.....ojjjjjjo....',
      '....ojbbbbbbj....',
      '...ojbbttttbbjo..',
      '..ojbbbbbbbbbbjo.',
      '..ojbbbbbbbbbbjo.',
      '...ojppppppppjo..',
      '....ohppppppho...',
      '......ohhhho.....',
    ],
    [
      '................',
      '.....oooooo.....',
      '....oohhhhhho....',
      '...ohhhsssshhho..',
      '..ohhhsseeesshh..',
      '.ohhsseoxxoeessh.',
      '.ohhsseessssesh..',
      '.ohhssssssssshh..',
      '..ohhsssssssshh..',
      '...ohhhhhhhhhho..',
      '.....ojjjjjjo....',
      '....ojbbbbbbj....',
      '...ojbbttttbbjo..',
      '..ojbbbbbbbbbbjo.',
      '..ojbbbbbbbbbbjo.',
      '...ojppppppppjo..',
      '....ohppppppho...',
      '......ohhhho.....',
    ],
  ],
};

const palette = {
  o: '#1d1526',
  h: '#4a321f',
  s: '#f0c7a1',
  b: '#356df5',
  p: '#2e3548',
  l: '#fff4d6',
  g: '#9ad7ff',
  x: '#ff8b7a',
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n || 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function addLine(text, cls = 'dim') {
  const line = document.createElement('div');
  line.className = `terminal-line ${cls}`;
  line.textContent = text;
  els.terminalOutput.appendChild(line);
  els.terminalOutput.scrollTop = els.terminalOutput.scrollHeight;
}

function bootTerminal() {
  if (!els.terminalOutput) return;
  if (state.terminal) return;
  if (!window.Terminal || !window.FitAddon) {
    if (!state.terminalInitRetry) {
      state.terminalInitRetry = setTimeout(() => {
        state.terminalInitRetry = null;
        bootTerminal();
      }, 120);
    }
    return;
  }

  els.terminalOutput.innerHTML = '';
  if (!state.terminal) {
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    state.terminal = new window.Terminal({
      cursorBlink: true,
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: isMobile ? 14 : 13,
      theme: {
        background: '#000000',
        foreground: '#ede6d4',
        cursor: '#f4c75c',
        selectionBackground: 'rgba(244, 199, 92, 0.25)',
      },
      scrollback: isMobile ? 800 : 2000,
      allowTransparency: true,
      smoothScrollDuration: isMobile ? 0 : 80,
      convertEol: true,
    });
    state.terminalFit = new window.FitAddon.FitAddon();
    state.terminal.loadAddon(state.terminalFit);
    state.terminal.open(els.terminalOutput);
    els.terminalOutput.addEventListener('click', () => state.terminal?.focus());
    window.visualViewport?.addEventListener('resize', () => setTimeout(syncTerminalSize, 50));
    state.terminal.onData((data) => {
      if (state.socket?.readyState === WebSocket.OPEN) {
        state.socket.send(JSON.stringify({ type: 'terminal-input', data }));
      } else {
        const h = { 'Content-Type': 'application/json' };
        if (state.csrfToken) h['X-CSRF-Token'] = state.csrfToken;
        fetch('/api/terminal/exec', {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ command: data }),
        }).catch(() => {});
      }
    });
    window.addEventListener('resize', () => syncTerminalSize());
  }

  state.terminal.writeln('\x1b[1;33mHermes terminal connected.\x1b[0m');
  state.terminal.writeln('\x1b[2mroot@hermes session ready. Type: hermes\x1b[0m');
  if (state.pendingTerminalBuffer) {
    state.terminal.write(state.pendingTerminalBuffer);
    state.pendingTerminalBuffer = '';
  }
  syncTerminalSize();
}

function syncTopbarOffset() {
  if (!els.topbar) return;
  const height = Math.ceil(els.topbar.getBoundingClientRect().height || 68);
  document.documentElement.style.setProperty('--topbar-offset', `${height}px`);
}

function syncTerminalSize() {
  if (!state.terminal || !state.terminalFit) return;
  try {
    state.terminalFit.fit();
    const cols = state.terminal.cols;
    const rows = state.terminal.rows;
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: 'terminal-resize', cols, rows }));
    }
  } catch {}
}

function setTerminalFullscreen(enabled) {
  state.terminalFullscreen = Boolean(enabled);
  document.body.classList.toggle('terminal-fullscreen', state.terminalFullscreen);
  els.shell.classList.toggle('terminal-fullscreen', state.terminalFullscreen);
  const panel = document.querySelector('[data-panel-id="terminal"]');
  if (panel) panel.classList.toggle('is-fullscreen', state.terminalFullscreen);
  if (els.terminalFullscreenBtn) {
    els.terminalFullscreenBtn.textContent = state.terminalFullscreen ? 'exit fullscreen' : 'fullscreen';
  }
  syncTopbarOffset();
  requestAnimationFrame(() => {
    syncTopbarOffset();
    syncTerminalSize();
  });
}

function setExplorerFullscreen(enabled) {
  state.explorerFullscreen = Boolean(enabled);
  document.body.classList.toggle('explorer-fullscreen', state.explorerFullscreen);
  els.shell.classList.toggle('explorer-fullscreen', state.explorerFullscreen);
  const panel = document.querySelector('[data-panel-id="explorer"]');
  if (panel) panel.classList.toggle('is-fullscreen', state.explorerFullscreen);
  if (els.explorerFullscreenBtn) {
    els.explorerFullscreenBtn.textContent = state.explorerFullscreen ? 'exit fullscreen' : 'fullscreen';
  }
  syncTopbarOffset();
  requestAnimationFrame(() => {
    syncTopbarOffset();
  });
}

function writeTerminalRaw(chunk) {
  const raw = String(chunk || '');
  if (!raw) return;
  if (state.terminal) {
    state.terminal.write(raw);
  } else {
    state.pendingTerminalBuffer += raw;
  }
}

function renderTerminalBuffer(snapshotTerminal) {
  if (!snapshotTerminal) return;
  const text = String(snapshotTerminal.buffer || '');
  state.lastTerminalBufferLength = text.length;
  if (text) {
    if (state.terminal) state.terminal.write(text);
    else state.pendingTerminalBuffer += text;
  }
  bootTerminal();
}

function appendTerminalChunk(chunk) {
  writeTerminalRaw(chunk);
}

function renderList(container, items, formatter) {
  const tpl = $('#list-item-template');
  container.innerHTML = '';
  items.forEach((item) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.querySelector('.item-text').innerHTML = formatter(item);
    container.appendChild(node);
  });
}

function renderSidebarAgent(snapshot) {
  const a = snapshot.agent || {};
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const sessionCount = snapshot.sessionCount ?? sessions.length ?? 0;
  const label = a.label || 'David';
  const detailsText = `${label} • ${sessionCount} sessions`;
  if (els.sidebarAgentDetails) els.sidebarAgentDetails.textContent = detailsText;

  const elapsed = Date.now() - state.lastTerminalActivity;
  let agentState = elapsed < 3000 ? 'thinking' : 'idle';

  const avatarUrl = snapshot.avatar?.url || '';
  const hasCustomAvatar = snapshot.avatar?.custom;
  const avatarHash = snapshot.avatar?.hash || 'default';

  if (hasCustomAvatar && avatarUrl) {
    // Only reload image when avatar hash actually changes (not every snapshot)
    if (state._lastAvatarHash !== avatarHash) {
      state._lastAvatarHash = avatarHash;
      els.sidebarAvatarImg.src = `${avatarUrl}?h=${avatarHash}`;
    }
    els.sidebarAvatarImg.style.display = '';
    els.sidebarAgentSprite.style.display = 'none';
  } else {
    // Default: show pixel sprite canvas, hide img
    if (state._lastAvatarHash !== 'default') {
      state._lastAvatarHash = 'default';
      els.sidebarAvatarImg.src = '';
    }
    els.sidebarAvatarImg.style.display = 'none';
    els.sidebarAgentSprite.style.display = '';
    drawSidebarSprite(agentState, 0);
  }
}

const SIDEBAR_COLORS = {
  o: '#f4c75c', h: '#ede6d4', s: '#b0a98c', e: '#7a6f5a',
  m: '#f4c75c', x: '#ede6d4', j: '#c9a96e', b: '#4a5568',
  t: '#ede6d4', p: '#3a5a40', g: '#67fb7f', r: '#ff7171',
  w: '#ffffff', d: '#9ca3af', '-': 'transparent',
};

function drawSidebarSprite(stateName, frameIdx) {
  const canvas = els.sidebarAgentSprite;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const frames = spriteFrames[stateName] || spriteFrames.idle;
  const frame = frames[frameIdx % frames.length];
  const pw = 18, ph = 18, scale = 6;
  canvas.width = pw * scale;
  canvas.height = ph * scale;
  ctx.fillStyle = 'transparent';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw pixel sprite (only shown when no custom avatar)
  for (let row = 0; row < frame.length; row++) {
    const line = frame[row] || '';
    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      const color = SIDEBAR_COLORS[ch] || null;
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(col * scale, row * scale, scale, scale);
    }
  }
}

function renderSessions(snapshot) {
  // Sessions rendered from /api/sessions polling (limit 10)
  if (!els.sessionsList) return;
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  // Skip rebuild if sessions haven't changed (prevent scroll reset)
  const fingerprint = sessions.map(s => s.id).join(',');
  if (fingerprint === state._lastSessionsFingerprint) return;
  state._lastSessionsFingerprint = fingerprint;
  if (!sessions.length) {
    els.sessionsList.innerHTML = '<div class="list-item"><span class="bullet" style="background: var(--amber);"></span><div class="item-text">No sessions found<span class="meta">run hermes sessions list</span></div></div>';
    return;
  }
  els.sessionsList.innerHTML = sessions.map((item) => {
    const title = escapeHtml(item.title || '—');
    const preview = escapeHtml(item.preview || '—');
    const lastActive = escapeHtml(item.lastActive || '—');
    const id = escapeHtml(item.id || '—');
    return `<div class="list-item">
      <span class="bullet"></span>
      <div class="item-text">${title}<span class="meta">${preview} • ${lastActive} • ${id}</span></div>
    </div>`;
  }).join('');
}

async function pollSidebarSessions() {
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) return;
    const data = await res.json();
    // Only update if we got actual sessions — don't overwrite with empty
    if (!Array.isArray(data.sessions) || data.sessions.length === 0) return;
    // Merge sessions into current snapshot without replacing the whole thing
    if (state.snapshot) {
      state.snapshot.sessions = data.sessions;
    }
    renderSessions(state.snapshot || { sessions: data.sessions });
  } catch {}
}

function startSessionsPoller(intervalMs = 10_000) {
  stopSessionsPoller();
  pollSidebarSessions();
  state.sessionsPoller = setInterval(pollSidebarSessions, intervalMs);
}

function stopSessionsPoller() {
  if (state.sessionsPoller) {
    clearInterval(state.sessionsPoller);
    state.sessionsPoller = null;
  }
}

function renderQuickActions(snapshot) {
  els.quickActions.innerHTML = '';
  (snapshot.quickActions || []).forEach((action) => {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.textContent = action.cmd;
    btn.title = action.desc;
    btn.addEventListener('click', () => {
      if (state.terminal) {
        state.terminal.write(action.cmd + '\r');
      }
    });
    els.quickActions.appendChild(btn);
  });
}

function renderAgentList(snapshot) {
  const profiles = snapshot.profiles || [];
  if (!profiles.length) {
    els.agentList.innerHTML = '<div class="agent-empty">No profiles found</div>';
    return;
  }
  els.agentList.innerHTML = profiles.map((p) => {
    const running = p.gateway === 'running';
    const statusClass = running ? 'running' : 'stopped';
    const activeClass = p.active ? 'active-profile' : '';
    const modelName = p.model.length > 22 ? p.model.slice(0, 20) + '…' : p.model;
    const toggleLabel = running ? 'stop gateway' : 'start gateway';
    return `
      <div class="agent-item ${activeClass}" data-profile="${escapeHtml(p.name)}">
        <div class="agent-row">
          <span class="agent-dot ${statusClass}"></span>
          <span class="agent-name">${escapeHtml(p.name)}</span>
          ${p.active ? '<span class="agent-badge">active</span>' : ''}
        </div>
        <div class="agent-meta">
          <span class="agent-model">${escapeHtml(modelName)}</span>
          <div class="agent-actions">
            ${!p.active ? `<button class="gw-toggle activate" data-activate-profile="${escapeHtml(p.name)}" title="set as default profile">activate</button>` : ''}
            <button class="gw-toggle ${statusClass}" data-gw-profile="${escapeHtml(p.name)}" data-gw-action="${running ? 'stop' : 'start'}" title="${toggleLabel}">${toggleLabel}</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

async function toggleGateway(profile, action) {
  try {
    const h = { 'Content-Type': 'application/json' };
    if (state.csrfToken) h['X-CSRF-Token'] = state.csrfToken;
    const res = await fetch(`/api/gateway/${profile}/${action}`, {
      method: 'POST',
      headers: h,
    });
    const data = await res.json();
    if (data.ok) {
      showToast(`Gateway ${action}: ${profile}`, 'success');
      fetchSnapshot();
    } else {
      showToast(`Gateway ${action} failed: ${data.error}`, 'error');
    }
  } catch (e) {
    showToast(`Gateway error: ${e.message}`, 'error');
  }
}

async function useProfile(profile) {
  try {
    const h = { 'Content-Type': 'application/json' };
    if (state.csrfToken) h['X-CSRF-Token'] = state.csrfToken;
    const res = await fetch('/api/profiles/use', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ profile }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast(`Profile "${profile}" activated`, 'success');
      fetchSnapshot();
    } else {
      showToast(`Activate failed: ${data.error}`, 'error');
    }
  } catch (e) {
    showToast(`Activate error: ${e.message}`, 'error');
  }
}

function renderSystem(snapshot) {
  const s = snapshot.system || {};
  const a = snapshot.agent || {};
  const memPct = s.memory?.percent ?? 0;
  const diskPct = s.disk?.percent ?? 0;
  els.systemPanel.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">CPU load</div><div class="stat-value">${(s.load?.[0] || 0).toFixed(2)}</div><div class="stat-note">${s.cpuCores || 0} cores • ${a.state || 'idle'}</div></div>
      <div class="stat-card"><div class="stat-label">Memory</div><div class="stat-value">${memPct}%</div><div class="stat-note">${fmtBytes(s.memory?.used || 0)} / ${fmtBytes(s.memory?.total || 0)}</div><div class="progress"><span style="width:${memPct}%"></span></div></div>
      <div class="stat-card"><div class="stat-label">Disk</div><div class="stat-value">${diskPct}%</div><div class="stat-note">${fmtBytes(s.disk?.used || 0)} used</div><div class="progress"><span style="width:${diskPct}%"></span></div></div>
      <div class="stat-card"><div class="stat-label">Uptime</div><div class="stat-value">${formatUptime(s.uptime || 0)}</div><div class="stat-note">${escapeHtml(s.host)}</div></div>
      <div class="stat-card full-span"><div class="stat-label">Runtime</div><div class="stat-note">${escapeHtml(s.platform || '')}</div></div>
    </div>`;
  els.loadLabel.textContent = `${(s.load?.[0] || 0).toFixed(2)} load`;
}

function formatUptime(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

function renderCron(snapshot) {
  const jobs = Array.isArray(snapshot.cronJobs) ? snapshot.cronJobs : [];
  if (!jobs.length) {
    els.cronPanel.innerHTML = '<div class="list-item"><span class="bullet" style="background: var(--amber);"></span><div class="item-text">No scheduled jobs<span class="meta">run hermes cron list</span></div></div>';
    return;
  }
  els.cronPanel.innerHTML = `<div class="job-list">${jobs.map((job) => `
    <div class="job-row">
      <div class="left">
        <div class="title">${escapeHtml(job.name)}</div>
        <div class="sub">schedule: ${escapeHtml(job.schedule || 'n/a')} • next: ${fmtTime(job.nextRun)} • last: ${job.lastRun ? fmtTime(job.lastRun) : 'never'}</div>
        <div class="sub">${escapeHtml(job.source || 'local')}</div>
      </div>
      <div class="value"><span class="badge ${job.status === 'ACTIVE' ? 'green' : 'amber'}">${job.status}</span></div>
    </div>
  `).join('')}</div>`;
}

let insightsFilter = { days: 7, source: '' };
let insightsCache = {};

function renderTokens(snapshot) {
  const t = snapshot.tokens || {};
  const u = snapshot.usage || {};
  const recentKinds = u.recentKinds || {};
  const kindLine = Object.entries(recentKinds).slice(0, 4).map(([kind, count]) => `${kind}:${count}`).join(' • ') || 'none';
  const period = t.period || u.period || '';
  const fmtN = (n) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);
  const activeDays = insightsFilter.days;
  const activeSource = insightsFilter.source || 'all';
  const sources = ['all', 'cli', 'telegram', 'whatsapp', 'discord', 'cron'];

  els.tokensPanel.innerHTML = `<div class="metric-list">
    <div class="metric-row full-span" style="padding:6px 0;">
      <div class="insights-filters" style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
        ${[1, 7, 30].map(d => `<button class="ghost-btn filter-btn ${activeDays === d ? 'active' : ''}" data-days="${d}" data-source="${activeSource}" style="font-size:10px;padding:3px 8px;min-height:auto;">${d === 1 ? 'Today' : d + 'd'}</button>`).join('')}
        <select class="insights-source" style="margin-left:auto;background:#0e121b;color:#ede6d4;border:1px solid rgba(244,199,92,0.3);border-radius:4px;padding:2px 6px;font-size:10px;font-family:'JetBrains Mono',monospace;">
          ${sources.map(s => `<option value="${s}" ${activeSource === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="metric-row"><div class="left"><div class="title">Total tokens</div><div class="sub">${escapeHtml(period || activeDays + ' days')}</div></div><div class="value">${fmtN(t.totalTokens ?? 0)}</div></div>
    <div class="metric-row"><div class="left"><div class="title">Input / output</div><div class="sub">prompt vs completion</div></div><div class="value">${fmtN(t.inputTokens ?? 0)} / ${fmtN(t.outputTokens ?? 0)}</div></div>
    <div class="metric-row"><div class="left"><div class="title">Cache read / write</div><div class="sub">prompt caching</div></div><div class="value">${fmtN(t.cacheRead ?? 0)} / ${fmtN(t.cacheWrite ?? 0)}</div></div>
    <div class="metric-row"><div class="left"><div class="title">Sessions / messages</div><div class="sub">from hermes insights</div></div><div class="value">${fmtN(t.sessions ?? u.sessionCount ?? 0)} / ${fmtN(t.messages ?? u.messageCount ?? 0)}</div></div>
    <div class="metric-row"><div class="left"><div class="title">Tool calls / user msgs</div><div class="sub">activity</div></div><div class="value">${fmtN(t.toolCalls ?? 0)} / ${fmtN(t.userMessages ?? 0)}</div></div>
    ${(t.modelBreakdown || []).map((m) => `<div class="metric-row"><div class="left"><div class="title">${escapeHtml(m.model)}</div><div class="sub">${m.sessions || ''} sessions</div></div><div class="value">${fmtN(m.tokens)}</div></div>`).join('')}
  </div>`;
  els.tokenProvider.textContent = period ? 'insights' : 'local';

  // Bind filter events
  els.tokensPanel.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => filterInsights(parseInt(btn.dataset.days), insightsFilter.source));
  });
  const sourceSelect = els.tokensPanel.querySelector('.insights-source');
  if (sourceSelect) {
    sourceSelect.addEventListener('change', () => filterInsights(insightsFilter.days, sourceSelect.value));
  }
}

async function filterInsights(days, source) {
  insightsFilter = { days, source: source === 'all' ? '' : source };
  const cacheKey = `${days}|${insightsFilter.source}`;
  if (insightsCache[cacheKey] && Date.now() - insightsCache[cacheKey].at < 60000) {
    renderTokens({ tokens: insightsCache[cacheKey].data, usage: state.snapshot?.usage || {} });
    return;
  }
  // Show loading
  els.tokensPanel.innerHTML = '<div class="small-meta" style="padding:12px;text-align:center;">Loading insights…</div>';
  try {
    const params = `days=${days}${insightsFilter.source ? '&source=' + insightsFilter.source : ''}`;
    const res = await fetch(`/api/insights?${params}`);
    const data = await res.json();
    if (data.ok) {
      insightsCache[cacheKey] = { at: Date.now(), data };
      renderTokens({ tokens: data, usage: state.snapshot?.usage || {} });
    }
  } catch {
    els.tokensPanel.innerHTML = '<div class="small-meta" style="padding:12px;text-align:center;color:#ff7171;">Failed to load insights</div>';
  }
}

function markdownToHtml(md) {
  const lines = String(md || '').split('\n');
  let html = '';
  let inPre = false;
  for (const line of lines) {
    if (line.startsWith('```')) {
      inPre = !inPre;
      html += inPre ? '<pre>' : '</pre>';
      continue;
    }
    if (inPre) {
      html += escapeHtml(line) + '\n';
      continue;
    }
    if (/^#\s+/.test(line)) html += `<h1>${escapeHtml(line.slice(2))}</h1>`;
    else if (/^##\s+/.test(line)) html += `<h2>${escapeHtml(line.slice(3))}</h2>`;
    else if (/^###\s+/.test(line)) html += `<h3>${escapeHtml(line.slice(4))}</h3>`;
    else if (/^-\s+/.test(line)) html += `<ul><li>${escapeHtml(line.slice(2))}</li></ul>`;
    else if (!line.trim()) html += '<p></p>';
    else html += `<p>${escapeHtml(line)}</p>`;
  }
  return html.replace(/<\/ul><ul>/g, '');
}

const asciiDavidFrames = {
  idle: [
    [
      `      .-^^^^-.      `,
      `     /  .--.  \     `,
      `    /  (o  o)  \    `,
      `   |     __     |    `,
      `   |    (__)    |    `,
      `    \   .--.   /    `,
      `     \__/  \__/     `,
      `      /|    |\      `,
      `     /_|____|_\     `,
      `        ||||         `,
      `      __||||__       `,
      `     /_/    \_\      `,
    ],
    [
      `      .-^^^^-.      `,
      `     /  .--.  \     `,
      `    /  (o  o)  \    `,
      `   |     __     |    `,
      `   |    (__)    |    `,
      `    \   '--'   /    `,
      `     \__/  \__/     `,
      `      /|    |\      `,
      `     /_|____|_\     `,
      `        ||||         `,
      `      __||||__       `,
      `     /_/    \_\      `,
    ],
  ],
  thinking: [
    [
      `      .-^^^^-.      `,
      `     /  .--.  \     `,
      `    /  (o  o)  \    `,
      `   |     __     |    `,
      `   |   __(  )__ |    `,
      `    \   /____\  /   `,
      `     \__/  __\__/   `,
      `      /|  /\  |\    `,
      `     /_|_/  \_|_\   `,
      `        ||  ||       `,
      `      __||||__       `,
      `     /_/    \_\      `,
    ],
    [
      `      .-^^^^-.      `,
      `     /  .--.  \     `,
      `    /  (o  o)  \    `,
      `   |     __     |    `,
      `   |   __(  )__ |    `,
      `    \   \____/  /   `,
      `     \__/  __\__/   `,
      `      /| /\  |\    `,
      `     /_|____|_\     `,
      `        ||  ||       `,
      `      __||||__       `,
      `     /_/    \_\      `,
    ],
  ],
  error: [
    [
      `      .-^^^^-.      `,
      `     /  xx xx  \     `,
      `    /  (  !!  )  \   `,
      `   |    .----.    |  `,
      `   |   / FAIL \   |  `,
      `    \  | ERROR |  /  `,
      `     \_\______/__/   `,
      `      /| /\  /\ |\   `,
      `     /_|_\__/__\_|_\  `,
      `        ||!!||        `,
      `      __||!!||__      `,
      `     /_/  !!  \_\     `,
    ],
    [
      `      .-^^^^-.      `,
      `     /  xx xx  \     `,
      `    /  (  !!  )  \   `,
      `   |    .----.    |  `,
      `   |   / FAIL \   |  `,
      `    \  |  !   |  /  `,
      `     \_\______/__/   `,
      `      /| /\  /\ |\   `,
      `     /_|_\__/__\_|_\  `,
      `        ||!!||        `,
      `      __||!!||__      `,
      `     /_/  !!  \_\     `,
    ],
  ],
};

function ensureAvatarCanvas() {
  if (state.avatarCanvas) return state.avatarCanvas;
  const canvas = document.createElement('canvas');
  canvas.className = 'avatar-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  els.sprite.innerHTML = '';
  els.sprite.appendChild(canvas);
  state.avatarCanvas = canvas;
  state.avatarCtx = canvas.getContext('2d', { alpha: false });
  return canvas;
}

function loadAvatarImage(url, isCustom) {
  if (!url) return;
  // Use cache-busted URL for custom avatars so they reload on change
  const resolvedUrl = isCustom ? `${url}?t=${Date.now()}` : url;
  if (state.avatarSource === resolvedUrl && state.avatarImage) return;
  if (state._avatarLoadingSrc === resolvedUrl) return;
  state.avatarSource = resolvedUrl;
  state._avatarLoadingSrc = resolvedUrl;
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    if (state._avatarLoadingSrc !== resolvedUrl) return;
    state.avatarImage = img;
    paintSprite(state.avatarState || 'idle', state.spriteTick);
  };
  img.onerror = () => {
    if (state._avatarLoadingSrc !== resolvedUrl) return;
    state.avatarImage = null;
    state._avatarLoadingSrc = null;
  };
  img.src = resolvedUrl;
}

function paintSprite(stateName, frameIndex) {
  state.avatarState = stateName || 'idle';
  const avatarUrl = state.snapshot?.avatar?.url;
  const isCustom = state.snapshot?.avatar?.custom;
  if (avatarUrl) loadAvatarImage(avatarUrl, isCustom);
  const canvas = ensureAvatarCanvas();
  const ctx = state.avatarCtx || canvas.getContext('2d', { alpha: false });
  state.avatarCtx = ctx;

  const image = state.avatarImage;
  const baseWidth = state.avatarState === 'error' ? 34 : state.avatarState === 'thinking' ? 38 : 42;
  const wobble = frameIndex % 2;
  const lowW = baseWidth + wobble;

  if (!image) {
    canvas.width = 42;
    canvas.height = 42;
    canvas.style.width = 'min(100%, 220px)';
    canvas.style.height = 'auto';
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0e121b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#f4c75c';
    ctx.fillRect(9, 10, 24, 22);
    ctx.fillStyle = '#ede6d4';
    ctx.fillRect(13, 16, 4, 4);
    ctx.fillRect(25, 16, 4, 4);
    ctx.fillStyle = '#000';
    ctx.fillRect(12, 24, 18, 2);
    return;
  }

  const ratio = image.height / image.width || 1;
  const lowH = Math.max(1, Math.round(lowW * ratio));
  canvas.width = lowW;
  canvas.height = lowH;
  canvas.style.width = 'min(100%, 220px)';
  canvas.style.height = 'auto';
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, lowW, lowH);
  ctx.drawImage(image, 0, 0, lowW, lowH);

  // Apply state-based visual effects on top of avatar
  if (state.avatarState === 'thinking') {
    // Pixelated effect: draw tiny then scale up
    const px = Math.max(4, Math.round(lowW / 8));
    const sw = Math.ceil(lowW / px);
    const sh = Math.ceil(lowH / px);
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, lowW, lowH);
    ctx.drawImage(image, 0, 0, sw, sh);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, 0, 0, sw, sh, 0, 0, lowW, lowH);
    ctx.fillStyle = 'rgba(244, 199, 92, 0.10)';
    ctx.fillRect(0, 0, lowW, lowH);
  } else if (state.avatarState === 'error') {
    // Red tint + pixelation
    const px = Math.max(3, Math.round(lowW / 10));
    const sw = Math.ceil(lowW / px);
    const sh = Math.ceil(lowH / px);
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, lowW, lowH);
    ctx.drawImage(image, 0, 0, sw, sh);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, 0, 0, sw, sh, 0, 0, lowW, lowH);
    ctx.fillStyle = 'rgba(255, 80, 80, 0.15)';
    ctx.fillRect(0, 0, lowW, lowH);
  } else if (state.avatarState === 'executing') {
    // Clean + green glow pulse
    ctx.clearRect(0, 0, lowW, lowH);
    ctx.drawImage(image, 0, 0, lowW, lowH);
    ctx.fillStyle = `rgba(103, 240, 162, ${0.04 + (frameIndex % 3) * 0.02})`;
    ctx.fillRect(0, 0, lowW, lowH);
  } else {
    // idle: clean, slight contrast boost
    ctx.filter = 'contrast(1.04) brightness(1.02)';
    ctx.clearRect(0, 0, lowW, lowH);
    ctx.drawImage(image, 0, 0, lowW, lowH);
    ctx.filter = 'none';
  }
}

function normalizeAgentState(rawState, details = '') {
  const stateStr = String(rawState || details || 'idle').toLowerCase();
  if (stateStr.includes('error') || stateStr.includes('fail') || stateStr.includes('halt') || stateStr.includes('panic')) return 'error';
  if (stateStr.includes('exec') || stateStr.includes('run') || stateStr.includes('busy')) return 'executing';
  if (stateStr.includes('coding') || stateStr.includes('build')) return 'thinking';
  if (stateStr.includes('think') || stateStr.includes('work')) return 'thinking';
  return 'idle';
}

function renderKnowledge(snapshot) {
  if (!els.sidebarInfo) return;
  els.sidebarInfo.innerHTML = markdownToHtml(snapshot.knowledge || '');
}

function renderAgent(snapshot) {
  // Sidebar agent panel only — nothing to render here since agent panel was moved to sidebar
}

function renderTreeRoots(snapshot) {
  const roots = Array.isArray(snapshot.explorerRoots) ? snapshot.explorerRoots : [];
  if (!els.explorerRoots) return;

  // Skip rebuild if tree data hasn't changed (prevent scroll reset on every snapshot)
  const rootsFingerprint = roots.map(r => r.key + ':' + (r.children?.length || 0)).join(',');
  if (rootsFingerprint === state._lastRootsFingerprint) return;
  state._lastRootsFingerprint = rootsFingerprint;

  if (!roots.some((root) => state.expandedRoots.has(root.key))) {
    state.expandedRoots = new Set(roots.map((root) => root.key));
  }
  // Save scroll position before DOM rebuild
  const scrollBefore = els.explorerRoots.scrollTop;
  els.explorerRoots.innerHTML = '';

  if (!roots.length) {
    els.explorerRoots.innerHTML = '<div class="small-meta">No explorer roots configured</div>';
    return;
  }

  roots.forEach((root) => {
    const block = document.createElement('section');
    block.className = `root-block${state.expandedRoots.has(root.key) ? '' : ' collapsed'}`;
    block.dataset.rootKey = root.key;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'root-head';
    head.innerHTML = `<span>${escapeHtml(root.label || root.root || root.key)}</span><span class="root-state">${state.expandedRoots.has(root.key) ? 'collapse' : 'expand'}</span>`;
    head.addEventListener('click', () => {
      if (state.expandedRoots.has(root.key)) state.expandedRoots.delete(root.key);
      else state.expandedRoots.add(root.key);
      state._lastRootsFingerprint = null; // force rebuild
      renderTreeRoots(state.snapshot || snapshot);
    });

    const tree = document.createElement('div');
    tree.className = 'tree';
    tree.dataset.rootKey = root.key;

    const renderNode = (node, depth = 0) => {
      const isDir = node.type === 'dir';
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `tree-row ${isDir ? 'dir' : 'file'}${state.currentFile === node.path ? ' active' : ''}`;
      row.style.marginLeft = `${depth * 12}px`;
      row.dataset.path = node.path;
      row.innerHTML = isDir
        ? `<span class="tree-chevron">${state.expandedDirs.has(node.path) ? '▾' : '▸'}</span><span>${escapeHtml(node.name)}</span>`
        : `<span class="tree-chevron">•</span><span>${escapeHtml(node.name)}</span>`;
      row.addEventListener('click', async () => {
        if (isDir) {
          if (state.expandedDirs.has(node.path)) state.expandedDirs.delete(node.path);
          else state.expandedDirs.add(node.path);
          state._lastRootsFingerprint = null; // force rebuild
          renderTreeRoots(state.snapshot || snapshot);
          return;
        }
        await openFile(node.path);
      });

      const frag = document.createDocumentFragment();
      frag.appendChild(row);
      if (isDir && state.expandedDirs.has(node.path) && Array.isArray(node.children) && node.children.length) {
        const childWrap = document.createElement('div');
        childWrap.className = 'tree-children';
        node.children.forEach((child) => childWrap.appendChild(renderNode(child, depth + 1)));
        frag.appendChild(childWrap);
      }
      return frag;
    };

    (root.children || []).forEach((child) => tree.appendChild(renderNode(child, 0)));
    block.appendChild(head);
    block.appendChild(tree);
    els.explorerRoots.appendChild(block);
  });
  // Restore scroll position after DOM rebuild
  requestAnimationFrame(() => {
    if (els.explorerRoots) els.explorerRoots.scrollTop = scrollBefore;
  });
}

async function openFile(filePath) {

  state.currentFile = filePath;
  state.dirty = false;
  els.fileStatus.textContent = 'loading';
  els.editorMeta.textContent = 'reading file';
  els.editorPath.textContent = filePath;
  try {
    const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'file read failed');
    els.editor.value = data.content || '';
    els.fileStatus.textContent = 'ready';
    els.editorMeta.textContent = `${(data.content || '').split('\n').length} lines`;
  } catch (error) {
    els.fileStatus.textContent = 'error';
    els.editorMeta.textContent = error.message;
    els.editor.value = '';
  }
}

async function saveCurrentFile() {
  if (!state.currentFile) return;
  try {
    const h = { 'Content-Type': 'application/json' };
    if (state.csrfToken) h['X-CSRF-Token'] = state.csrfToken;
    const res = await fetch('/api/file', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ path: state.currentFile, content: els.editor.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'save failed');
    state.dirty = false;
    els.fileStatus.textContent = 'saved';
    els.editorMeta.textContent = `${(els.editor.value || '').split('\n').length} lines`;
    showToast('File saved', 'success');
  } catch (error) {
    els.fileStatus.textContent = 'error';
    els.editorMeta.textContent = error.message;
    showToast(`Save failed: ${error.message}`, 'error');
  }
}

async function fetchSession() {
  const res = await fetch('/api/session');
  return res.json();
}

async function login(password) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'login failed');
  return data;
}

async function logout() {
  stopAutoRefresh();
  stopAlertPolling();
  const h = { 'Content-Type': 'application/json' };
  if (state.csrfToken) h['X-CSRF-Token'] = state.csrfToken;
  await fetch('/api/logout', { method: 'POST', headers: h }).catch(() => {});
  if (state.socket) {
    try { state.socket.close(); } catch {}
    state.socket = null;
  }
  setLocked(true);
}

function setLocked(locked) {
  els.overlay.classList.toggle('hidden', !locked);
  els.shell.classList.toggle('locked', locked);
}

function snapshotDataChanged(prev, next, key) {
  if (!prev) return true;
  if (key === 'sessions') {
    const a = prev.sessions?.map(s => s.id).join(',') || '';
    const b = next.sessions?.map(s => s.id).join(',') || '';
    return a !== b;
  }
  if (key === 'explorerRoots') {
    const a = prev.explorerRoots?.map(r => r.key + ':' + (r.children?.length || 0)).join(',') || '';
    const b = next.explorerRoots?.map(r => r.key + ':' + (r.children?.length || 0)).join(',') || '';
    return a !== b;
  }
  if (key === 'system') return JSON.stringify(prev.system) !== JSON.stringify(next.system);
  if (key === 'cronJobs') return JSON.stringify(prev.cronJobs) !== JSON.stringify(next.cronJobs);
  if (key === 'tokens') return JSON.stringify(prev.tokens) !== JSON.stringify(next.tokens);
  if (key === 'background') return JSON.stringify(prev.background) !== JSON.stringify(next.background);
  if (key === 'knowledge') return prev.knowledge !== next.knowledge;
  if (key === 'avatar') return prev.avatar?.hash !== next.avatar?.hash;
  return true;
}

function renderSnapshot(snapshot) {
  if (!els.topbar?.textContent) return; // Defensive: DOM not ready
  const prev = state.snapshot;
  state.snapshot = snapshot;
  document.title = `Hermes Control Interface • ${snapshot.agent?.state || 'idle'}`;
  if (els.sidebarAgentStatus) {
    const isLive = snapshot.authed;
    els.sidebarAgentStatus.textContent = isLive ? 'LIVE' : 'LOCKED';
    els.sidebarAgentStatus.className = `sidebar-agent-status ${isLive ? 'live' : 'locked'}`;
  }
  if (els.sidebarAgentModel) {
    els.sidebarAgentModel.textContent = snapshot.configSummary?.defaultModel || 'unknown';
  }
  if (els.terminalLabel) els.terminalLabel.textContent = snapshot.loginIdentity || 'root@hermes';

  // Always update sidebar agent (lightweight — just text + cached avatar draw)
  renderSidebarAgent(snapshot);

  // Only re-render panels if their data actually changed
  if (snapshotDataChanged(prev, snapshot, 'sessions')) renderSessions(snapshot);
  renderQuickActions(snapshot);
  if (snapshotDataChanged(prev, snapshot, 'profiles')) renderAgentList(snapshot);
  if (els.systemPanel && snapshotDataChanged(prev, snapshot, 'system')) renderSystem(snapshot);
  if (els.cronPanel && snapshotDataChanged(prev, snapshot, 'cronJobs')) renderCron(snapshot);
  if (els.tokensPanel && snapshotDataChanged(prev, snapshot, 'tokens')) renderTokens(snapshot);
  if (els.agentPanel) renderAgent(snapshot);
  if (els.sidebarInfo && snapshotDataChanged(prev, snapshot, 'knowledge')) renderKnowledge(snapshot);
  if (els.explorerPanel && snapshotDataChanged(prev, snapshot, 'explorerRoots')) renderTreeRoots(snapshot);
  if (!state.terminal && els.terminalOutput) renderTerminalBuffer(snapshot.terminal);
}

async function fetchSnapshot() {
  try {
    const res = await fetch('/api/dashboard-state');
    const data = await res.json();
    if (!res.ok) {
      // Not authenticated yet — this is normal before login
      return null;
    }
    renderSnapshot(data);
    return data;
  } catch (err) {
    // Network error or malformed response — wait for WS snapshot instead
    return null;
  }
}

function connectWs() {
  if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket = socket;
  socket.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'snapshot') {
        const prev = state.snapshot || {};
        const incoming = data.payload || {};
        // Preserve existing sessions if incoming has none (server may not always include them)
        const hasIncomingSessions = Array.isArray(incoming.sessions) && incoming.sessions.length > 0;
        const mergedSnapshot = { ...incoming, sessions: hasIncomingSessions ? incoming.sessions : (prev.sessions || []) };
        renderSnapshot(mergedSnapshot);
      }
      if (data.type === 'terminal-transcript') {
        renderTerminalBuffer(data);
        state.lastTerminalBufferLength = String(data.buffer || '').length;
        state.lastTerminalActivity = Date.now();
      }
      if (data.type === 'terminal-output') {
        appendTerminalChunk(data.chunk || '');
        state.lastTerminalBufferLength = String(data.buffer || '').length || state.lastTerminalBufferLength;
        state.lastTerminalActivity = Date.now();
      }
      if (data.type === 'system-metrics') {
        // Update only system panel — lightweight, no full re-render
        if (state.snapshot) {
          state.snapshot.system = data.payload;
          renderSystem(state.snapshot);
        }
      }
      if (data.type === 'log-stream') {
        appendLogLines(data.data || '');
        const status = document.getElementById('log-status');
        if (status) status.textContent = 'live';
      }
      if (data.type === 'log-stream-start') {
        const status = document.getElementById('log-status');
        if (status) status.textContent = 'live';
      }
    } catch {}
  });
  socket.addEventListener('close', () => {
    if (state.socket === socket) {
      state.socket = null;
      // Auto-reconnect after 3s
      setTimeout(() => connectWs(), 3000);
    }
  });
}

function normalizeQuotedText(text) {
  const value = String(text || '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

async function postJson(url, body, method = 'POST') {
  const headers = { 'Content-Type': 'application/json' };
  if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
  const res = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed: ${url}`);
  return data;
}

const LAYOUT_STORAGE_KEY = 'hermes-control-layout-v1';

function getPanelLayout() {
  return $$('.panel').map((panel) => ({
    id: panel.dataset.panelId,
    x: Number(panel.dataset.x || '0'),
    y: Number(panel.dataset.y || '0'),
    w: Number(panel.dataset.w || '0'),
    h: Number(panel.dataset.h || '0'),
  })).filter((item) => item.id);
}

function applySavedLayout(layout) {
  const byId = new Map($$('.panel').map((panel) => [panel.dataset.panelId, panel]));
  const panels = Array.isArray(layout) ? layout : layout?.panels;
  if (!Array.isArray(panels) || !panels.length) return false;
  let applied = false;
  panels.forEach((item) => {
    const panel = byId.get(item.id);
    if (!panel) return;
    const x = Number(item.x);
    const y = Number(item.y);
    const w = Number(item.w);
    const h = Number(item.h);
    if (![x, y, w, h].every((n) => Number.isFinite(n))) return;
    panel.dataset.x = String(x);
    panel.dataset.y = String(y);
    panel.dataset.w = String(w);
    panel.dataset.h = String(h);
    applied = true;
  });
  return applied;
}

async function loadLayoutState() {
  try {
    const stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      applySavedLayout(parsed);
    }
  } catch {}

  try {
    const res = await fetch('/api/layout');
    const data = await res.json();
    if (res.ok && data?.layout) {
      applySavedLayout(data.layout);
      try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(data.layout)); } catch {}
      window.dispatchEvent(new Event('resize'));
    }
  } catch {}
}

async function saveLayoutState() {
  const layout = { panels: getPanelLayout() };
  const h = { 'Content-Type': 'application/json' };
  if (state.csrfToken) h['X-CSRF-Token'] = state.csrfToken;
  const res = await fetch('/api/layout', {
    method: 'POST',
    headers: h,
    body: JSON.stringify(layout),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'layout save failed');
  try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(data.layout || layout)); } catch {}
  return data.layout || layout;
}

function setLayoutEditMode(enabled) {
  state.layoutEditMode = Boolean(enabled);
  document.body.classList.toggle('layout-edit-mode', state.layoutEditMode);
  if (els.layoutEditBtn) {
    els.layoutEditBtn.style.display = state.layoutEditMode ? 'none' : '';
  }
  if (els.layoutSaveBtn) {
    els.layoutSaveBtn.style.display = state.layoutEditMode ? '' : 'none';
  }
}

async function handleCronSlashCommand(trimmed) {
  const match = trimmed.match(/^\/cron\s+(\w+)\s*(.*)$/i);
  if (!match) return false;
  const action = match[1].toLowerCase();
  const tail = match[2] || '';

  if (action === 'add') {
    const addMatch = tail.match(/^(\S+)\s+(.+)$/);
    if (!addMatch) throw new Error('usage: /cron add <schedule> <note>');
    const schedule = addMatch[1];
    const note = normalizeQuotedText(addMatch[2]);
    await postJson('/api/cron/add', { schedule, note, source: '/cron add' });
    addLine(`cron added: ${schedule} ${note}`, 'green');
    await fetchSnapshot();
    return true;
  }

  if (action === 'list') {
    await fetchSnapshot();
    addLine('cron list refreshed', 'system');
    return true;
  }

  if (action === 'remove' || action === 'pause' || action === 'resume') {
    const id = normalizeQuotedText(tail);
    if (!id) throw new Error(`usage: /cron ${action} <id>`);
    await postJson(`/api/cron/${action}`, { id });
    addLine(`cron ${action}d: ${id}`, 'green');
    await fetchSnapshot();
    return true;
  }

  throw new Error(`unsupported cron action: ${action}`);
}

async function runTerminalCommand(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed) return;
  try {
    if (trimmed.startsWith('/cron ')) {
      await handleCronSlashCommand(trimmed);
      return;
    }
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: 'terminal-input', data: `${trimmed}\r` }));
      return;
    }
    const h = { 'Content-Type': 'application/json' };
    if (state.csrfToken) h['X-CSRF-Token'] = state.csrfToken;
    const res = await fetch('/api/terminal/exec', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ command: trimmed }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'terminal input failed');
    if (data.buffer && data.buffer.length > state.lastTerminalBufferLength) {
      appendTerminalChunk(data.buffer.slice(state.lastTerminalBufferLength));
      state.lastTerminalBufferLength = data.buffer.length;
    }
  } catch (error) {
    addLine(`error: ${error.message}`, 'red');
  }
}

async function uploadAvatarFile(file) {
  if (!file) return;
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('failed to read image'));
    reader.readAsDataURL(file);
  });
  // Reset cached avatar so the new image loads on next snapshot/render
  state._lastAvatarHash = null;
  state.avatarSource = '';
  state.avatarImage = null;
  state._avatarLoadingSrc = null;
  await postJson('/api/avatar', { dataUrl });
  // Don't call fetchSnapshot() — server broadcasts on avatar change
}


function initDragResize() {
  const panels = Array.from(document.querySelectorAll('.panel'));
  const workspace = $('#workspace');

  const applyLayout = () => {
    if (window.matchMedia('(max-width: 1200px)').matches || state.terminalFullscreen || state.explorerFullscreen || !workspace) return;
    const rect = workspace.getBoundingClientRect();
    panels.forEach((panel) => {
      const x = Number(panel.dataset.x || '0');
      const y = Number(panel.dataset.y || '0');
      const w = Number(panel.dataset.w || '30');
      const h = Number(panel.dataset.h || '30');
      panel.style.position = 'absolute';
      // Calculate raw pixel values
      let left = Math.max(0, (x / 100) * rect.width);
      let top = Math.max(0, (y / 100) * rect.height);
      let width = Math.max(260, (w / 100) * rect.width);
      let height = Math.max(190, (h / 100) * rect.height);
      // Clamp to workspace bounds — prevent overflow on smaller screens
      if (left + width > rect.width) {
        width = Math.max(260, rect.width - left);
      }
      if (top + height > rect.height) {
        height = Math.max(190, rect.height - top);
      }
      // If panel is still too wide for workspace, push it left
      if (width > rect.width) {
        width = rect.width - 4;
        left = 2;
      }
      if (height > rect.height) {
        height = rect.height - 4;
        top = 2;
      }
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.width = `${width}px`;
      panel.style.height = `${height}px`;
    });
  };

  const updateFromPixels = (panel) => {
    const rect = workspace.getBoundingClientRect();
    panel.dataset.x = ((parseFloat(panel.style.left || '0') / rect.width) * 100).toFixed(2);
    panel.dataset.y = ((parseFloat(panel.style.top || '0') / rect.height) * 100).toFixed(2);
    panel.dataset.w = ((parseFloat(panel.style.width || '0') / rect.width) * 100).toFixed(2);
    panel.dataset.h = ((parseFloat(panel.style.height || '0') / rect.height) * 100).toFixed(2);
  };

  panels.forEach((panel) => {
    const handle = panel.querySelector('.drag-handle');
    const resize = panel.querySelector('.resize-handle');

    handle?.addEventListener('pointerdown', (ev) => {
      if (!state.layoutEditMode || window.matchMedia('(max-width: 1200px)').matches || state.terminalFullscreen || state.explorerFullscreen) return;
      ev.preventDefault();
      panel.classList.add('dragging');
      const startX = ev.clientX;
      const startY = ev.clientY;
      const startLeft = parseFloat(panel.style.left || '0');
      const startTop = parseFloat(panel.style.top || '0');
      const onMove = (move) => {
        panel.style.left = `${Math.max(0, startLeft + (move.clientX - startX))}px`;
        panel.style.top = `${Math.max(0, startTop + (move.clientY - startY))}px`;
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        panel.classList.remove('dragging');
        updateFromPixels(panel);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });

    resize?.addEventListener('pointerdown', (ev) => {
      if (!state.layoutEditMode || window.matchMedia('(max-width: 1200px)').matches || state.terminalFullscreen || state.explorerFullscreen) return;
      ev.preventDefault();
      ev.stopPropagation();
      panel.classList.add('resizing');
      const startX = ev.clientX;
      const startY = ev.clientY;
      const startWidth = parseFloat(panel.style.width || '0');
      const startHeight = parseFloat(panel.style.height || '0');
      const onMove = (move) => {
        panel.style.width = `${Math.max(260, startWidth + (move.clientX - startX))}px`;
        panel.style.height = `${Math.max(190, startHeight + (move.clientY - startY))}px`;
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        panel.classList.remove('resizing');
        updateFromPixels(panel);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  });

  window.addEventListener('resize', applyLayout);
  applyLayout();
}

// Log streaming
const logState = { type: 'agent', level: '', paused: false, lineCount: 0 };
const MAX_LOG_LINES = 500;

function startLogStream(logType, level) {
  logState.type = logType || 'agent';
  logState.level = level || '';
  logState.paused = false;
  logState.lineCount = 0;
  const output = document.getElementById('logs-output');
  if (output) output.innerHTML = '';
  const status = document.getElementById('log-status');
  if (status) status.textContent = 'connecting…';
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: 'log-start', logType: logState.type, level: logState.level }));
  }
}

function stopLogStream() {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: 'log-stop' }));
  }
  const status = document.getElementById('log-status');
  if (status) status.textContent = 'idle';
}

function appendLogLines(data) {
  if (logState.paused) return;
  const output = document.getElementById('logs-output');
  if (!output) return;
  const lines = data.split('\n').filter(l => l.trim());
  for (const line of lines) {
    if (logState.lineCount >= MAX_LOG_LINES) {
      output.removeChild(output.firstChild);
    } else {
      logState.lineCount++;
    }
    const div = document.createElement('div');
    div.className = 'log-line';
    // Color-code log level
    const levelMatch = line.match(/\b(DEBUG|INFO|WARNING|ERROR)\b/);
    const levelClass = levelMatch ? `log-level-${levelMatch[1]}` : '';
    div.innerHTML = `<span class="${levelClass}">${escapeHtml(line)}</span>`;
    output.appendChild(div);
  }
  // Auto-scroll to bottom
  output.scrollTop = output.scrollHeight;
}

function bindUi() {



  els.refreshBtn.addEventListener('click', fetchSnapshot);
  document.getElementById('auto-refresh-btn')?.addEventListener('click', toggleAutoRefresh);

  // Group 12: Sidebar hamburger toggle
  document.getElementById('sidebar-toggle-btn')?.addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    sidebar?.classList.toggle('mobile-open');
    overlay?.classList.toggle('active');
  });
  document.getElementById('sidebar-overlay')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.remove('mobile-open');
    document.getElementById('sidebar-overlay')?.classList.remove('active');
  });

  // Group 11: Alert bell dropdown toggle
  document.getElementById('alert-bell-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const dropdown = document.getElementById('alert-dropdown');
    dropdown?.classList.toggle('hidden');
    if (!dropdown?.classList.contains('hidden')) pollAlerts();
  });
  document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('alert-dropdown');
    if (dropdown && !e.target.closest('.alert-bell-wrap')) {
      dropdown.classList.add('hidden');
    }
  });
  document.getElementById('alert-clear-btn')?.addEventListener('click', async () => {
    await apiFetch('/api/notifications/clear', { method: 'POST' });
    pollAlerts();
    showToast('Alerts cleared', 'success');
  });
  document.getElementById('alert-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-dismiss]');
    if (!btn) return;
    const id = btn.dataset.dismiss;
    await apiFetch(`/api/notifications/${id}/dismiss`, { method: 'POST' });
    pollAlerts();
  });

  // Gateway toggle — event delegation (CSP-safe, no inline onclick)
  els.agentList?.addEventListener('click', (e) => {
    const btn = e.target.closest('.gw-toggle');
    if (!btn) return;
    const profile = btn.dataset.gwProfile;
    const action = btn.dataset.gwAction;
    const activateProfile = btn.dataset.activateProfile;
    if (activateProfile) {
      useProfile(activateProfile);
    } else if (profile && action) {
      toggleGateway(profile, action);
    }
  });

  // Log panel bindings
  document.querySelectorAll('.log-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.log-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const logType = tab.dataset.log;
      const level = document.getElementById('log-level')?.value || '';
      startLogStream(logType, level);
    });
  });
  document.getElementById('log-level')?.addEventListener('change', (e) => {
    const activeTab = document.querySelector('.log-tab.active');
    const logType = activeTab?.dataset.log || 'agent';
    startLogStream(logType, e.target.value);
  });
  document.getElementById('log-pause-btn')?.addEventListener('click', () => {
    logState.paused = !logState.paused;
    const btn = document.getElementById('log-pause-btn');
    if (btn) btn.textContent = logState.paused ? 'resume' : 'pause';
    const status = document.getElementById('log-status');
    if (status) status.textContent = logState.paused ? 'paused' : 'live';
  });
  els.layoutEditBtn?.addEventListener('click', () => setLayoutEditMode(!state.layoutEditMode));
  els.layoutSaveBtn?.addEventListener('click', async () => {
    try {
      await saveLayoutState();
      showToast('Layout saved', 'success');
      setLayoutEditMode(false);
    } catch (error) {
      showToast(`Layout save failed: ${error.message}`, 'error');
    }
  });
  els.logoutBtn.addEventListener('click', logout);
  els.terminalFullscreenBtn?.addEventListener('click', () => setTerminalFullscreen(!state.terminalFullscreen));
  els.explorerFullscreenBtn?.addEventListener('click', () => setExplorerFullscreen(!state.explorerFullscreen));
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (state.terminalFullscreen) setTerminalFullscreen(false);
      if (state.explorerFullscreen) setExplorerFullscreen(false);
    }
  });
  window.addEventListener('resize', syncTopbarOffset);
  window.visualViewport?.addEventListener('resize', syncTopbarOffset);

  els.loginForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    els.loginError.textContent = '';
    try {
      const result = await login(els.passwordInput.value.trim());
      state.csrfToken = result.csrfToken || '';
      els.passwordInput.value = '';
      setLocked(false);
      connectWs();
      await loadLayoutState();
      await fetchSnapshot();
    } catch (error) {
      els.loginError.textContent = error.message;
    }
  });

  els.saveBtn.addEventListener('click', saveCurrentFile);
  els.avatarUploadBtn?.addEventListener('click', () => els.avatarFileInput?.click());
  els.avatarResetBtn?.addEventListener('click', async () => {
    els.sidebarAvatarImg.src = '';
    els.sidebarAvatarImg.style.display = 'none';
    els.sidebarAgentSprite.style.display = '';
    await postJson('/api/avatar', {}, 'DELETE');
    showToast('Avatar reset', 'info');
    // Don't call fetchSnapshot() — server broadcasts on avatar change
  });
  els.avatarFileInput?.addEventListener('change', async () => {
    const file = els.avatarFileInput.files?.[0];
    if (!file) return;
    try {
      await uploadAvatarFile(file);
      showToast('Avatar updated', 'success');
      els.avatarFileInput.value = '';
    } catch (error) {
      showToast(`Avatar upload failed: ${error.message}`, 'error');
    }
  });
  els.editor.addEventListener('input', () => {
    if (!state.currentFile) return;
    state.dirty = true;
    els.fileStatus.textContent = 'edited';
    els.editorMeta.textContent = 'unsaved changes';
  });

  els.editor.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      saveCurrentFile();
    }
  });

  $$('[data-root-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rootKey = btn.dataset.rootToggle;
      if (state.expandedRoots.has(rootKey)) state.expandedRoots.delete(rootKey);
      else state.expandedRoots.add(rootKey);
      const block = btn.closest('.root-block');
      block.classList.toggle('collapsed', !state.expandedRoots.has(rootKey));
      btn.querySelector('.root-state').textContent = state.expandedRoots.has(rootKey) ? 'collapse' : 'expand';
    });
  });
}

function startClock() {
  const tick = () => {
    const now = new Date();
    els.clock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  tick();
  state.clockTimer = setInterval(tick, 1000);
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!state.autoRefreshEnabled) return;
  state.autoRefreshFailCount = 0;
  state.autoRefreshTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/dashboard-state');
      if (!res.ok) throw new Error('fetch failed');
      state.autoRefreshFailCount = 0;
      const data = await res.json();
      if (data?.snapshot) renderSnapshot(data.snapshot);
    } catch {
      state.autoRefreshFailCount = (state.autoRefreshFailCount || 0) + 1;
      // Exponential backoff: after 3 failures, slow to 60s; after 6, slow to 120s
      if (state.autoRefreshFailCount === 3 || state.autoRefreshFailCount === 6) {
        startAutoRefresh();
      }
    }
  }, state.autoRefreshFailCount >= 6 ? 120000 : state.autoRefreshFailCount >= 3 ? 60000 : 30000);
}

function stopAutoRefresh() {
  if (state.autoRefreshTimer) {
    clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
}

function toggleAutoRefresh() {
  state.autoRefreshEnabled = !state.autoRefreshEnabled;
  const btn = document.getElementById('auto-refresh-btn');
  if (state.autoRefreshEnabled) {
    btn.classList.add('active');
    btn.textContent = 'auto';
    startAutoRefresh();
  } else {
    btn.classList.remove('active');
    btn.textContent = 'off';
    stopAutoRefresh();
  }
}

async function boot() {
  syncTopbarOffset();
  setLayoutEditMode(false);
  bootTerminal();
  bindUi();
  initDragResize();
  startClock();

  const session = await fetchSession();
  if (session.authenticated) {
    state.csrfToken = session.csrfToken || '';
    setLocked(false);
    connectWs();
    await loadLayoutState();
    await fetchSnapshot();
    startAutoRefresh();
    startAlertPolling();
    // Start log stream (agent logs, default level)
    setTimeout(() => startLogStream('agent', ''), 1000);
  } else {
    setLocked(true);
  }
  // Hide loading overlay
  const loadingOverlay = document.getElementById('loading-overlay');
  if (loadingOverlay) loadingOverlay.style.display = 'none';
}

boot();
