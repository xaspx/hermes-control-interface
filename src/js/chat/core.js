import { resolveSessionDisplayTitle, state, t, toDisplayText, wsClient } from '../core/state.js';;
import { addToDedupBuf, createMessageDiv, highlightCodeBlocks, renderChatContent, sendViaCLI, updateGatewayBadge } from './cli.js';
import { sendViaGatewayAPI } from './gateway.js';
import { sendViaWebSocket } from './websocket.js';
import { closeModal, showModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { api } from '../core/api.js';
import { toggleMsgMenu } from '../core/messages.js';
import { escapeHtml, formatNumber } from '../core/utils.js';

let _chatInfoProfiles = [];
let _reloadInProgress = false;

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
          <button class="btn btn-primary btn-sm" style="width:100%;margin-top:6px;" onclick="newChatSession()" data-i18n="auto.newChat">+ New Chat</button>
        </div>
        <div id="chat-agent-panel" class="chat-agent-panel">
          <div class="chat-agent-panel-title" data-i18n="auto.activeAgent">🤖 Active Agent</div>
          <div id="chat-agent-panel-body">
            <!-- Populated by updateChatAgentPanel() -->
          </div>
        </div>
        <div class="chat-sidebar-list" id="chat-sidebar-list">
          <div class="loading" data-i18n="auto.loadingSessions">Loading sessions...</div>
        </div>
        <div id="subagent-panel" class="subagent-panel" style="display:none;">
          <div class="subagent-panel-title" data-i18n="auto.subagents">Subagents</div>
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
              <div class="chat-title" id="chat-title" data-i18n="auto.newChat2">New Chat</div>
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
          <button class="btn btn-primary" id="chat-send-btn" onclick="sendChatMessage()" data-i18n="auto.send">Send</button>
          <button class="btn btn-danger btn-sm" id="chat-stop-btn" style="display:none;" onclick="stopChatStream()" data-i18n="auto.stop">Stop</button>
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
          <kbd>Ctrl+Enter</kbd><span data-i18n="auto.sendMessage">Send message</span>
          <kbd>Esc</kbd><span data-i18n="auto.stopStreamCloseModal">Stop stream / close modal</span>
          <kbd>Ctrl+N</kbd><span data-i18n="auto.newChat3">New chat</span>
          <kbd>Ctrl+K</kbd><span data-i18n="auto.searchSessions">Search sessions</span>
          <kbd>Ctrl+[</kbd><span data-i18n="auto.toggleSidebar">Toggle sidebar</span>
          <kbd>Shift+Enter</kbd><span data-i18n="auto.newLineInInput">New line in input</span>
        </div>`,
        confirmText: 'Got it',
      });
      return;
    }
  });


  // Set default profile
  const profileSelect = document.getElementById('chat-profile');
  if (profileSelect) profileSelect.value = defaultProfile;

  // Restore last-used profile from localStorage
  const lastProfile = localStorage.getItem('hci-chat-profile');
  if (lastProfile && profiles.some(p => p.name === lastProfile)) {
    profileSelect.value = lastProfile;
  }

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
    // Persist selection for page navigation
    localStorage.setItem('hci-chat-profile', selected);
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
          showToast(t('toast.setDefaultFailedPrefix') + e.message, 'error');
          profileSelect.value = hermesDefault;
        }
      } else {
        // User cancelled — apply selection for this session only (don't persist as default)
        updateChatAgentPanel().catch(() => {});
        updateGatewayBadge().catch(() => {});
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
      <div class="chat-welcome-title" data-i18n="auto.welcomeToChat">Welcome to Chat</div>
      <div class="chat-welcome-sub" data-i18n="auto.selectAConversationOrStartANewOne">Select a conversation or start a new one</div>
    </div>
  `;
}

async function refreshChatSidebar() {
  const profile = document.getElementById('chat-profile')?.value || 'default';
  const listEl = document.getElementById('chat-sidebar-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="loading" data-i18n="auto.loading">Loading...</div>';

  try {
    const res = await fetch(`/api/all-sessions?profile=${encodeURIComponent(profile)}`, { credentials: 'include' });
    if (!res.ok) { listEl.innerHTML = '<div class="error-msg" data-i18n="auto.failedToLoad">Failed to load</div>'; return; }
    const data = await res.json();
    let sessions = (data.sessions || []).filter(s => (s.messageCount > 0) || (s.message_count > 0) || (s.title && s.title !== '—'));

    if (sessions.length === 0) {
      listEl.innerHTML = '<div style="text-align:center;color:var(--fg-subtle);padding:20px;font-size:12px;\" data-i18n="auto.noConversationsYet">No conversations yet</div>';
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

    // Build filter HTML with selected attribute to avoid onchange loop
    const activeFilter = listEl.dataset.activeFilter || 'all';
    const filterOptions = `<option value="all" data-i18n="auto.all" ${activeFilter === 'all' ? 'selected' : ''}>All</option>` +
      uniqueSources.map(src => `<option value="${src}" ${activeFilter === src ? 'selected' : ''}>${sourceLabels[src] || src}</option>`).join('');

    // Render filter bar + sessions
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
    // Filter selected via HTML attribute — no .value set needed
  } catch {}
}

function filterChatBySource(value) {
  const listEl = document.getElementById('chat-sidebar-list');
  if (listEl) listEl.dataset.activeFilter = value;
  // Debounce to prevent rapid rebuild flicker (dropdown "KLIK KLIK")
  clearTimeout(state._filterDebounce);
  state._filterDebounce = setTimeout(() => refreshChatSidebar(), 30);
}

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

  container.innerHTML = '<div class="loading" data-i18n="auto.loadingMessages">Loading messages...</div>';

  // Highlight active in sidebar
  document.querySelectorAll('.chat-session-item').forEach(el => {
    el.classList.toggle('active', el.dataset.sid == sessionId);
  });

  // Auto-hide sidebar on mobile after selecting session
  if (window.innerWidth <= 768 && state.chatSidebarOpen) {
    toggleChatSidebar();
  }

  try {
    const fetchSid = sessionId; // capture for stale guard
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages?profile=${encodeURIComponent(profile)}&offset=${offset}&limit=50`, { credentials: 'include' });
    // Stale guard: if user switched sessions during fetch, discard
    if (state._currentChatSession !== fetchSid) { console.warn('[Chat] session changed, discarding stale load'); return; }
    if (!r.ok) { container.innerHTML = '<div class="error-msg" data-i18n="auto.failedToLoadMessages">Failed to load messages</div>'; return; }
    const data = await r.json();
    if (titleEl) {
      titleEl.textContent = toDisplayText(resolveSessionDisplayTitle({ sessionId, data }));
      titleEl.removeAttribute('data-i18n');
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
      container.innerHTML = '<div style="text-align:center;color:var(--fg-subtle);padding:40px;font-size:13px;" data-i18n="auto.noMessagesYet">No messages yet</div>';
      return;
    }

    // Lazy load older: prepend if offset > 0, else replace
    if (offset === 0) {
      // Stale check: if session switched during fetch, abort
      if (state._currentChatSession !== fetchSid) { console.warn('[Chat] stale, discarding render'); return; }
      container.innerHTML = '';
    }
    const frag = document.createDocumentFragment();
    for (const m of data.messages) {
      frag.appendChild(renderChatMessage(m));
    }
    if (offset > 0 && container.firstChild) {
      try {
        // Re-check: container might have been cleared between check and insert
        if (container.firstChild && container.isConnected) {
          container.insertBefore(frag, container.firstChild);
          // Remove old "Load older" button
          const oldBtn = container.querySelector('.load-older-btn');
          if (oldBtn) oldBtn.remove();
        }
      } catch {}
    } else {
      container.appendChild(frag);
    }
    // Add "Load older" button if we got 50 messages (more likely exist)
    if (data.messages.length === 50 && offset === 0) {
      const loadBtn = document.createElement('button');
      loadBtn.className = 'load-older-btn';
      loadBtn.textContent = '↑ Load older messages';
      loadBtn.onclick = () => {
        loadBtn.textContent = t('ui.loading');
        loadBtn.disabled = true;
        loadChatSession(sessionId, offset + 50).then(() => {
          loadBtn.remove();
        }).catch(() => {
          loadBtn.textContent = '↑ Load older messages';
          loadBtn.disabled = false;
        });
      };
      // Safe insert: only if firstChild exists
      if (container.firstChild) {
        try { container.insertBefore(loadBtn, container.firstChild); } catch {}
      } else {
        container.appendChild(loadBtn);
      }
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
  // Include the date alongside the time so messages from older sessions are
  // identifiable at a glance (the header used to show only HH:MM, which read
  // as "today" regardless of the actual send date).
  const ts = msg.timestamp
    ? new Date(msg.timestamp * 1000).toLocaleString([], {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : '';

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
    rd.innerHTML = `<summary style="cursor:pointer;font-size:11px;color:var(--fg-subtle);" data-i18n="auto.reasoning">💭 Reasoning</summary><div class="msg-tool-result" style="margin-top:4px;">${escapeHtml(toDisplayText(msg.reasoning).substring(0, 2000))}</div>`;
    div.appendChild(rd);
  }

  return div;
}

function newChatSession() {
  // Option B: Don't generate session ID yet — let backend create it on first message
  state._currentChatSession = null;

  // Reset UI
  const titleEl = document.getElementById('chat-title');
  if (titleEl) {
    titleEl.setAttribute('data-i18n', 'auto.newChat2');
    titleEl.textContent = t('ui.newChat');
  }
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
      <div class="chat-welcome-title" data-i18n="auto.newConversation">New conversation</div>
      <div class="chat-welcome-sub" data-i18n="auto.typeAMessageToStart">Type a message to start</div>
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

async function updateChatAgentPanel() {
  const body = document.getElementById('chat-agent-panel-body');
  if (!body) return;

  // Reuse cached profiles from sidebar refresh
  let profiles = _chatInfoProfiles;
  if (!profiles.length) {
    body.innerHTML = '<div style="color:var(--fg-muted);font-size:12px;text-align:center;padding:10px;" data-i18n="auto.loading">Loading...</div>';
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
    return `<div class="agent-list-item" onclick="switchChatProfile('${escapeHtml(p.name)}')" style="cursor:pointer;" title="Switch to ${escapeHtml(p.name)}">
      <span class="agent-list-dot ${isRunning ? 'running' : 'stopped'}"></span>
      <span class="agent-list-name">${escapeHtml(p.name)}</span>
      <span class="agent-list-model">${escapeHtml((p.model || '—').split('/').pop())}</span>
      ${p.active ? '<span class="agent-badge-default">★</span>' : ''}
    </div>`;
  }).join('');

  body.innerHTML = currentCard + `<div class="agent-list">${agentItems}</div>`;
}

function switchChatProfile(name) {
  const sel = document.getElementById('chat-profile');
  if (sel) {
    sel.value = name;
    sel.dispatchEvent(new Event('change'));
  }
}

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
  if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = t('ui.send'); }
  if (stopBtn) stopBtn.style.display = 'none';
  // Remove cursor
  const cursor = document.querySelector('.chat-cursor');
  if (cursor) cursor.remove();
}

async function renameChatSession(sessionId = 0) {
  const sid = sessionId || state._currentChatSession;
  if (!sid) return showToast(t('toast.noSessionSelected'), 'info');
  const t = await showModal({ title: 'Rename Session', message: 'Enter a new title.', inputs: [{ placeholder: 'New title' }], buttons: [{ text: 'Cancel', value: false }, { text: 'Rename', value: true, primary: true }] });
  if (!t?.action || !t.inputs?.[0]) return;
  const n = t.inputs[0].trim();
  if (!n) return;
  try {
    const profile = document.getElementById('chat-profile')?.value || 'default';
    const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' }, body: JSON.stringify({ title: n, profile }), credentials: 'include' });
    if (r.ok) {
      showToast(t('toast.sessionRenamed'), 'success');
      const renamed = document.getElementById('chat-title');
      if (renamed) {
        renamed.textContent = n;
        renamed.removeAttribute('data-i18n');
      }
      refreshChatSidebar();
    } else showToast(t('toast.renameFailed'), 'error');
  } catch (e) { showToast(t('toast.renameFailedPrefix') + e.message, 'error'); }
}

async function deleteChatSession(sessionId = 0) {
  const sid = sessionId || state._currentChatSession;
  if (!sid) return showToast(t('toast.noSessionSelected'), 'info');
  const confirmResult = await showModal({ title: 'Delete Session', message: 'Delete this session? This cannot be undone.', buttons: [{ text: 'Cancel', value: false }, { text: 'Delete', value: true, primary: true }] });
  if (!confirmResult?.action) return;
  try {
    const profile = document.getElementById('chat-profile')?.value || 'default';
    const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}?profile=${encodeURIComponent(profile)}`, { method: 'DELETE', headers: { 'X-CSRF-Token': state.csrfToken || '' }, credentials: 'include' });
    if (r.ok) { showToast(t('toast.sessionDeleted'), 'success'); newChatSession(); refreshChatSidebar(); } else showToast(t('toast.deleteFailed'), 'error');
  } catch (e) { showToast(t('toast.deleteFailedPrefix') + e.message, 'error'); }
}

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
    if (titleEl) {
      titleEl.setAttribute('data-i18n', 'auto.newChat2');
      titleEl.textContent = t('ui.newChat');
    }
    if (subtitleEl) subtitleEl.textContent = profile !== 'default' ? `Profile: ${profile}` : '';
    return;
  }
  // Find session title from sidebar
  const item = document.querySelector(`.chat-session-item[data-sid="${sid}"]`);
  const sidebarTitle = item?.dataset?.title || '';
  if (titleEl) {
    titleEl.textContent = sidebarTitle || sid.substring(0, 20) + '...';
    titleEl.removeAttribute('data-i18n');
  }
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
  streamEl.innerHTML = '<div class="msg-header"><span class="msg-header-label" data-i18n="auto.assistant">🤖 Assistant</span></div><div class="msg-body"><span class="streaming-text" id="gw-stream-text"><span class="chat-cursor">▊</span></span></div>';
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
        console.warn('[Chat] WS failed, trying Gateway API:', wsErr.message);
      }
    }
    // Try Gateway API directly (fast, structured SSE events)
    try {
      await sendViaGatewayAPI(text, profile, sessionId, contentDiv, messagesDiv, startTime);
      return;
    } catch (gwErr) {
      console.warn('[Chat] Gateway API failed, falling back to CLI:', gwErr.message);
    }
    // Last resort: raw CLI (slow, stdout parsing)
    await sendViaCLI(text, profile, sessionId, contentDiv, messagesDiv, startTime);
  } catch (cliErr) {
    console.error('[Chat] CLI failed:', cliErr.message);
    if (contentDiv) contentDiv.innerHTML = renderChatContent(fullContent) + '<div style="color:var(--red);margin-top:8px;">Error: ' + escapeHtml(cliErr.message) + '</div>';
  } finally {
    state._chatLock = false;
    state._currentStreamReader = null;
    if (btn) { btn.disabled = false; btn.textContent = t('ui.send'); btn.style.display = ''; }
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
      ${content ? `<pre class="artifact-content ${language ? 'language-' + escapeHtml(language) : ''}">${escapeHtml(content.substring(0, 8000))}</pre>` : '<div class="artifact-empty" data-i18n="auto.noContent">No content</div>'}
    </div>`;
  messagesDiv.appendChild(card);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  state._artifactCount = (state._artifactCount || 0) + 1;
}

function togglePinSession(sid) {
  try {
    const list = JSON.parse(localStorage.getItem('hci_pinned_sessions') || '[]');
    const idx = list.indexOf(sid);
    if (idx >= 0) list.splice(idx, 1); else list.push(sid);
    localStorage.setItem('hci_pinned_sessions', JSON.stringify(list));
    refreshChatSidebar();
  } catch {}
}
window.togglePinSession = togglePinSession;

export { loadChat, refreshChatSidebar, filterChatBySource, reloadCurrentSessionMessages, loadChatSession, renderChatMessage, newChatSession, toggleChatSidebar, updateChatAgentPanel, switchChatProfile, stopChatStream, renameChatSession, deleteChatSession, updateQueueBadge, updateChatHeader, sendChatMessage, forkFromMessage, playChatComplete, toggleChatSound, updateToolCountUI, handleArtifact, togglePinSession };
