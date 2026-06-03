import { state, t, toDisplayText } from '../core/state.js';;
import { customAlert, customConfirm, customPrompt, showModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { api } from '../core/api.js';
import { navigate } from '../core/navigation.js';
import { escapeHtml } from '../core/utils.js';
import { loadAgentConfig, loadAgentCron, loadAgentMemory } from './agent-config.js';
import { loadTokenUsage } from './home.js';
import { showCreateAgent } from './maintenance.js';
import { terminalKey, toggleTerminalFullscreen } from './terminal.js';

async function loadAgents(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title" data-i18n="auto.agents">Agents</div>
        <div class="page-subtitle" data-i18n="auto.manageYourHermesProfiles">Manage your Hermes profiles</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-primary" onclick="showCreateAgent()" data-i18n="auto.createAgent">+ Create Agent</button>
        <button class="btn btn-ghost" onclick="loadAgents(document.querySelector('.page.active'))" data-i18n="home.refresh">↻ Refresh</button>
      </div>
    </div>
    <div class="card-grid" id="agents-grid">
      <div class="loading" data-i18n="auto.loadingAgents">Loading agents</div>
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
            <div class="stat-row"><span class="stat-label" data-i18n="auto.status">Status</span><span class="stat-value ${statusClass}">${statusText}</span></div>
            <div class="stat-row"><span class="stat-label" data-i18n="home.model">Model</span><span class="stat-value">${p.model || '—'}</span></div>
            ${p.alias ? `<div class="stat-row"><span class="stat-label" data-i18n="auto.alias">Alias</span><span class="stat-value">${p.alias}</span></div>` : ''}
            <div class="card-actions">
              <button class="btn btn-ghost btn-sm" onclick="navigate('agent-detail', {name:'${p.name}'})" data-i18n="auto.open">Open</button>
              ${!p.active ? `<button class="btn btn-ghost btn-sm" onclick="setAgentDefault('${p.name}')" data-i18n="auto.setDefault">Set Default</button>` : ''}
              ${p.name !== 'default' ? `<button class="btn btn-ghost btn-sm btn-danger" onclick="deleteAgent('${p.name}')" data-i18n="auto.delete">Delete</button>` : ''}
            </div>
          </div>
        `;
      }).join('');
    } else {
      grid.innerHTML = '<div class="card"><div class="card-title" data-i18n="auto.noAgentsFound">No agents found</div><div class="stat-row"><span class="stat-label" data-i18n="auto.createYourFirstAgentProfileToGetStarted">Create your first agent profile to get started.</span></div></div>';
    }
  } catch (e) {
    document.getElementById('agents-grid').innerHTML = `<div class="card"><div class="card-title" data-i18n="common.error">Error</div><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
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
        <div class="page-subtitle" data-i18n="auto.agentDetail">Agent detail</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost" onclick="openTerminalPanel('Setup ${name}', 'hermes -p ${name} setup')" data-i18n="auto.setup">⚙ Setup</button>
        <button class="btn btn-primary" onclick="openTerminalPanel('Terminal ${name}', '${name} --tui')" data-i18n="home.terminal">⌘ Terminal</button>
        <button class="btn btn-ghost" onclick="navigate('agents')" data-i18n="auto.back">← Back</button>
      </div>
    </div>
    <div class="tabs" id="agent-tabs">
      <button class="tab active" data-tab="dashboard" data-i18n="auto.dashboard">Dashboard</button>
      <button class="tab" data-tab="sessions" data-i18n="home.sessions">Sessions</button>
      <button class="tab" data-tab="gateway" data-i18n="home.gateway">Gateway</button>
      <button class="tab" data-tab="config" data-i18n="auto.config">Config</button>
      <button class="tab" data-tab="memory" data-i18n="auto.memory">Memory</button>
      <button class="tab" data-tab="skills" data-i18n="auto.skills">Skills</button>
      <button class="tab" data-tab="cron" data-i18n="home.cron">Cron</button>
    </div>
    <div id="agent-tab-content">
      <div class="loading" data-i18n="common.loading">Loading</div>
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
  content.innerHTML = '<div class="loading" data-i18n="common.loading">Loading</div>';

  switch (tabName) {
    case 'dashboard': await loadAgentDashboard(content, profileName); break;
    case 'sessions': await loadAgentSessions(content, profileName); break;
    case 'gateway': await loadAgentGateway(content, profileName); break;
    case 'config': await loadAgentConfig(content, profileName); break;
    case 'memory': await loadAgentMemory(content, profileName); break;
    case 'skills': await loadAgentSkills(content, profileName); break;
    case 'cron': await loadAgentCron(content, profileName); break;
    default: content.innerHTML = '<div class="empty" data-i18n="auto.unknownTab">Unknown tab</div>';
  }
}

async function loadAgentDashboard(container, name) {
  container.innerHTML = '<div class="loading" data-i18n="auto.loadingDashboard">Loading dashboard</div>';

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
          <div class="card-title" data-i18n="auto.identity">Identity</div>
          <div class="stat-row"><span class="stat-label" data-i18n="auto.profile">Profile</span><span class="stat-value">${name}</span></div>
          <div class="stat-row"><span class="stat-label" data-i18n="home.model">Model</span><span class="stat-value">${profile?.model || '—'}</span></div>
          <div class="stat-row"><span class="stat-label" data-i18n="auto.status">Status</span><span class="stat-value ${gatewayOk && gatewayRes.active ? 'status-ok' : 'status-off'}">${gatewayOk && gatewayRes.active ? '● Active' : '○ Inactive'}</span></div>
          ${profile?.alias ? `<div class="stat-row"><span class="stat-label" data-i18n="auto.alias">Alias</span><span class="stat-value">${profile.alias}</span></div>` : ''}
          ${profile?.active ? `<div class="stat-row"><span class="stat-label" data-i18n="auto.default">Default</span><span class="stat-value status-ok" data-i18n="auto.yes">Yes</span></div>` : ''}
        </div>
        <div class="card">
          <div class="card-title" data-i18n="home.gateway">Gateway</div>
          <div class="stat-row"><span class="stat-label" data-i18n="auto.service">Service</span><span class="stat-value">${gatewayRes.service || '—'}</span></div>
          <div class="stat-row"><span class="stat-label" data-i18n="auto.status">Status</span><span class="stat-value ${gatewayOk && gatewayRes.active ? 'status-ok' : 'status-off'}">${gatewayOk && gatewayRes.active ? '● Running' : '○ Stopped'}</span></div>
          <div class="stat-row"><span class="stat-label" data-i18n="auto.enabled">Enabled</span><span class="stat-value">${gatewayRes.enabled ? 'Yes' : 'No'}</span></div>
        </div>
        <div class="card">
          <div class="card-title" data-i18n="auto.tokenUsageToday">Token Usage (today)</div>
          <div id="agent-token-${name}"><div class="loading" data-i18n="auto.loading">Loading...</div></div>
        </div>
      </div>
    `;
    loadTokenUsage(`agent-token-${name}`, 1);
  } catch (e) {
    container.innerHTML = `<div class="card"><div class="card-title" data-i18n="common.error">Error</div><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
  }
}

async function loadAgentSessions(container, name) {
  container.innerHTML = `
    <div class="card-grid" style="margin-bottom:16px;">
      <div class="card" id="session-stats-${name}">
        <div class="card-title" data-i18n="auto.sessionStats">Session Stats</div>
        <div class="loading" data-i18n="auto.loadingStats">Loading stats...</div>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:16px;align-items:center;">
      <input type="text" id="session-search" class="search-input" placeholder="Search sessions..." style="flex:1;" />
      <button class="btn btn-ghost" id="session-refresh-btn" data-i18n="home.refresh">↻ Refresh</button>
    </div>
    <div id="sessions-table">
      <div class="loading" data-i18n="auto.loadingSessions">Loading sessions...</div>
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
        tableEl.innerHTML = '<div class="card"><div class="card-title" data-i18n="auto.noSessionsFound">No sessions found</div></div>';
        state.currentSessions = [];
        return;
      }
      state.currentSessions = res.sessions;
      renderSessions('');
    } catch (e) {
      tableEl.innerHTML = `<div class="card"><div class="card-title" data-i18n="common.error">Error</div><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
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
      tableEl.innerHTML = '<div class="card"><div class="card-title" data-i18n="auto.noMatchingSessions">No matching sessions</div></div>';
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
              <th data-i18n="auto.sessionId">Session ID</th>
              <th data-i18n="auto.title">Title</th>
              <th data-i18n="auto.source">Source</th>
              <th data-i18n="auto.messages">Messages</th>
              <th data-i18n="auto.updated">Updated</th>
              <th data-i18n="auto.actions">Actions</th>
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
            <button class="btn btn-ghost btn-sm" ${page <= 0 ? 'disabled style="opacity:0.3;"' : ''} id="sessions-prev" data-i18n="auto.prev">← Prev</button>
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
  cell.innerHTML = '<div class="loading" style="padding:16px;" data-i18n="auto.loadingMessages">Loading messages...</div>';

  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages?profile=${encodeURIComponent(profile)}&offset=0&limit=50`, { credentials: 'include' });
    if (!r.ok) { cell.innerHTML = '<div class="error-msg" style="padding:16px;" data-i18n="auto.failedToLoadMessages">Failed to load messages</div>'; return; }
    const data = await r.json();
    if (!data.messages || data.messages.length === 0) {
      cell.innerHTML = '<div style="color:var(--fg-muted);padding:16px;" data-i18n="auto.noMessagesInThisSession">No messages in this session</div>';
      return;
    }

    let html = `<div style="padding:12px 16px;background:var(--bg-panel);border-radius:0 0 8px 8px;border:1px solid var(--border);border-top:0;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <span style="font-size:13px;font-weight:600;color:var(--fg);">${escapeHtml(data.title || 'Session ' + sessionId)}</span>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('tr').style.display='none'" data-i18n="auto.close2">✕ Close</button>
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
      // Hermes stores message.timestamp as Unix epoch *seconds* (matches
      // renderChatMessage in the chat panel). Without *1000 every row
      // rendered the same epoch-1970 time (~15:18 in CET) instead of the
      // real send time. Also include the date so the panel is useful for
      // sessions older than today.
      const ts = m.timestamp
        ? new Date(m.timestamp * 1000).toLocaleString([], {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
          })
        : '';
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
        <div class="card-title" data-i18n="auto.sessionStats">Session Stats</div>
        <div class="stat-row"><span class="stat-label" data-i18n="auto.totalSessions">Total sessions</span><span class="stat-value">${totalMatch?.[1] || '—'}</span></div>
        <div class="stat-row"><span class="stat-label" data-i18n="auto.totalMessages">Total messages</span><span class="stat-value">${messagesMatch?.[1]?.toLocaleString() || '—'}</span></div>
        <div class="stat-row"><span class="stat-label" data-i18n="auto.dbSize">DB size</span><span class="stat-value">${dbMatch?.[1] || '—'}</span></div>
        <div style="margin-top:6px;font-size:10px;color:var(--fg-subtle);text-transform:uppercase;" data-i18n="auto.byPlatform">By Platform</div>
        ${cliMatch ? `<div class="stat-row"><span class="stat-label">CLI</span><span class="stat-value">${cliMatch[1]} sessions</span></div>` : ''}
        ${tgMatch ? `<div class="stat-row"><span class="stat-label">Telegram</span><span class="stat-value">${tgMatch[1]} sessions</span></div>` : ''}
        ${waMatch ? `<div class="stat-row"><span class="stat-label">WhatsApp</span><span class="stat-value">${waMatch[1]} sessions</span></div>` : ''}
      `;
    } else {
      el.innerHTML = '<div class="card-title" data-i18n="auto.sessionStats">Session Stats</div><div class="stat-row"><span class="stat-label" data-i18n="auto.noStatsAvailable">No stats available</span></div>';
    }
  } catch {
    el.innerHTML = '<div class="card-title" data-i18n="auto.sessionStats">Session Stats</div><div class="error-msg" data-i18n="auto.failedToLoadStats">Failed to load stats</div>';
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
    window.termInstance = term;

    term.write('Connecting...\r\n');

    // Ensure terminal session exists
    try {
      await api('/api/terminal/ensure', { method: 'POST' });
    } catch {}

    // Connect WebSocket
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProtocol}//${location.host}/ws`);
    window.termWs = ws;

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
  const newTitle = await customPrompt(t('dialog.newSessionTitle'), currentTitle);
  if (newTitle === null || newTitle === currentTitle) return;
  try {
    const csrfToken = state.csrfToken || '';
    const agent = profileName || state.currentAgent;
    await api(`/api/sessions/${sessionId}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ title: newTitle, profile: agent }),
    });
    showToast(t('toast.sessionRenamed'), 'success');
    setTimeout(() => loadAgentSessions(document.getElementById('agent-tab-content'), agent), 2000);
  } catch (e) {
    showToast(t('toast.renameFailedPrefix') + e.message, 'error');
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
      showToast(t('toast.sessionExported'), 'success');
    }
  } catch (e) {
    showToast(t('toast.exportFailedPrefix') + e.message, 'error');
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
    showToast(t('toast.sessionDeleted'), 'success');
    setTimeout(() => loadAgentSessions(document.getElementById('agent-tab-content'), profileName), 2000);
  } catch (e) {
    showToast(t('toast.deleteFailedPrefix') + e.message, 'error');
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
        <div class="loading" data-i18n="auto.checkingGatewayHealth">Checking gateway health...</div>
      </div>
      <div class="card-grid">
        <div class="card">
          <div class="card-title" data-i18n="auto.gatewayService">Gateway Service</div>
          <div class="stat-row"><span class="stat-label" data-i18n="auto.service">Service</span><span class="stat-value">${res.service || '—'}</span></div>
          <div class="stat-row"><span class="stat-label" data-i18n="auto.status">Status</span><span class="stat-value ${active ? 'status-ok' : 'status-off'}">${active ? '● Running' : '○ Stopped'}</span></div>
          <div class="stat-row"><span class="stat-label" data-i18n="auto.enabled">Enabled</span><span class="stat-value">${res.enabled ? 'Yes' : 'No'}</span></div>
          <div class="card-actions" style="margin-top:12px;">
            <button class="btn btn-ghost" onclick="gatewayAction('${name}', 'start')" ${active ? 'disabled' : ''} data-i18n="auto.start">Start</button>
            <button class="btn btn-ghost" onclick="gatewayAction('${name}', 'stop')" ${!active ? 'disabled' : ''} data-i18n="auto.stop">Stop</button>
            <button class="btn btn-ghost" onclick="gatewayAction('${name}', 'restart')" data-i18n="auto.restart">Restart</button>
          </div>
        </div>
        <div class="card">
          <div class="card-title" data-i18n="auto.connections">Connections</div>
          <div id="gateway-connections-${name}">
            <div class="loading" data-i18n="auto.loadingConnections">Loading connections...</div>
          </div>
        </div>
      </div>
    `;

    // Load connections
    loadGatewayConnections(name);
    // Load health check
    renderGatewayHealth(document.getElementById('gateway-health'), name);

  } catch (e) {
    container.innerHTML = `<div class="card"><div class="card-title" data-i18n="common.error">Error</div><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
  }
}

async function renderGatewayHealth(container, profile) {
  if (!container) return;
  try {
    const res = await api(`/api/gateway/${profile}/health`);
    if (!res.ok) { container.innerHTML = '<div class="error-msg" data-i18n="auto.failedToCheckHealth">Failed to check health</div>'; return; }

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
        <button class="btn btn-primary btn-sm" onclick="fixGateway('${profile}')" data-i18n="auto.autofix">🔧 Auto-Fix</button>
      </div>`;
    }

    html += '</div>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = '<div class="error-msg" data-i18n="auto.healthCheckFailed">Health check failed</div>';
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
      showToast(t('toast.gatewayRestarted'), 'success');
      // Re-check health after a moment
      setTimeout(() => {
        const el = document.getElementById('gateway-health');
        if (el) renderGatewayHealth(el, profile);
      }, 3000);
    } else {
      showToast(t('toast.failedPrefix') + (res.error || 'unknown'), 'error');
    }
  } catch (e) {
    showToast(t('toast.errorPrefix') + e.message, 'error');
  }
}

async function loadGatewayConnections(name) {
  const el = document.getElementById(`gateway-connections-${name}`);
  if (!el) return;
  try {
    const res = await api(`/api/gateway/${name}/connections`);
    if (!res.ok || !res.platforms?.length) {
      el.innerHTML = '<div class="stat-row"><span class="stat-label" data-i18n="auto.noPlatformData">No platform data</span></div>';
      return;
    }
    el.innerHTML = res.platforms.map(p => {
      const icon = p.connected ? '●' : '○';
      const statusClass = p.connected ? 'status-ok' : 'status-off';
      const detail = p.detail ? ` <span style="font-size:10px;color:var(--fg-muted);">${escapeHtml(p.detail)}</span>` : '';
      return `<div class="stat-row"><span class="stat-label">${escapeHtml(p.name)}</span><span class="stat-value ${statusClass}">${icon} ${p.connected ? 'connected' : 'not configured'}${detail}</span></div>`;
    }).join('');
  } catch {
    el.innerHTML = '<div class="stat-row"><span class="stat-label" data-i18n="auto.errorLoadingConnections">Error loading connections</span></div>';
  }
}

async function loadGatewayLogs(name) {
  const viewer = document.getElementById('log-viewer');
  if (!viewer) return;
  viewer.innerHTML = '<div class="loading" data-i18n="auto.loadingLogs">Loading logs...</div>';

  const activeTab = document.querySelector('#log-tabs .tab.active')?.dataset.log || 'agent';
  const level = document.getElementById('log-level')?.value || '';

  try {
    const url = `/api/gateway/${name}/logs?log=${activeTab}&lines=100${level ? '&level=' + level : ''}`;
    const res = await api(url);
    if (res.ok) {
      viewer.innerHTML = `<pre style="margin:0;font-size:11px;white-space:pre-wrap;word-break:break-all;max-height:400px;overflow-y:auto;color:var(--fg-muted);">${escapeHtml(res.logs || 'No logs')}</pre>`;
    } else {
      viewer.innerHTML = '<div class="empty" data-i18n="auto.noLogsAvailable">No logs available</div>';
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

async function sseProgressModal(title, url, options = {}) {
  const { method = 'POST', headers = {}, body, autoCloseMs = 3000, onSuccess, onError } = options;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal-card" style="width:520px;max-width:90vw;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div class="modal-title" style="margin:0;">${title}</div>
        <button class="sse-modal-close" style="display:none;padding:4px 12px;font-size:11px;background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg-muted);cursor:pointer;" data-i18n="auto.close2">✕ Close</button>
      </div>
      <div class="sse-progress-log" style="margin:12px 0;font-family:var(--font-mono,monospace);font-size:12px;line-height:1.8;max-height:300px;overflow-y:auto;background:var(--bg-inset);border-radius:6px;padding:12px;color:var(--fg-muted);white-space:pre-wrap;"></div>
      <div class="sse-progress-status" style="font-size:11px;color:var(--fg-muted);" data-i18n="auto.starting">Starting...</div>
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

// ---- Global exposure for onclick handlers ----
window.loadAgents = loadAgents;
window.openTerminalPanel = openTerminalPanel;
window.toggleSessionDetail = toggleSessionDetail;
window.resumeSession = resumeSession;
window.renameSession = renameSession;
window.exportSession = exportSession;
window.deleteSession = deleteSession;
window.deleteAgent = deleteAgent;
window.setAgentDefault = setAgentDefault;
window.loadAgentGateway = loadAgentGateway;
window.renderGatewayHealth = renderGatewayHealth;
window.fixGateway = fixGateway;
window.loadGatewayConnections = loadGatewayConnections;
window.loadGatewayLogs = loadGatewayLogs;
window.gatewayAction = gatewayAction;
window.sseProgressModal = sseProgressModal;
window.loadXtermAndConnect = loadXtermAndConnect;
window.loadAgentSkills = async function(container, name) {
  container.innerHTML = `<div class="loading">Loading skills for ${name}...</div>`;
  try {
    const res = await api(`/api/skills/list/${name}`);
    const output = res.ok ? res.output : (res.error || 'Failed to load');
    const skills = [];
    const lines = output.split('\n');
    const skillPattern = /[│┃]\s*([^\s│┃][^\s│┃]*)\s*[│┃]\s*([^│┃]*?)\s*[│┃]\s*(\S+)\s*[│┃]\s*(\S+)\s*[│┃]/;
    for (const line of lines) {
      if (line.includes('┏') || line.includes('┗') || line.includes('┡') || line.includes('┩') || line.includes('╍')) continue;
      const match = line.match(skillPattern);
      if (match) {
        const sname = match[1].trim();
        if (!sname || sname === 'Name' || sname === '#') continue;
        skills.push({ name: sname, category: match[2].trim(), source: match[3].trim(), trust: match[4].trim() });
      }
    }
    let skillsHtml = skills.length > 0
      ? '<div class="card-grid">' + skills.map(s => `
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
        </div>`).join('') + '</div>'
      : `<div class="card"><div class="card-title">No skills installed</div><div style="margin-top:8px;"><a href="#" onclick="window.loadSkills(document.querySelector('.page.active'));return false;" style="color:var(--accent);">Browse Skills Hub →</a></div></div>`;
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
      </details>`;
  } catch (e) {
    container.innerHTML = `<div class="card"><div class="card-title">Error</div><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
  }
};

window.updateSkill = async function(skillName, profile) {
  if (!await customConfirm(`Update skill "${skillName}" on ${profile}?`, 'Update Skill')) return;
  try {
    const res = await api('/api/skills/update', { method: 'POST', body: JSON.stringify({ skill: skillName, profile }) });
    showToast(res.ok ? 'Skill updated!' : (res.output || 'Update failed'), res.ok ? 'success' : 'error');
    if (res.ok) window.loadAgentSkills(document.getElementById('agent-tab-content'), profile);
  } catch (e) { showToast(e.message, 'error'); }
};

window.uninstallSkill = async function(skillName, profile) {
  const result = await showModal({
    title: 'Uninstall Skill',
    message: `Are you sure you want to uninstall "${skillName}" from ${profile}?`,
    buttons: [{ text: 'Cancel', value: false }, { text: 'Uninstall', value: true, primary: true }],
  });
  if (!result?.action) return;
  try {
    const res = await api('/api/skills/uninstall', { method: 'POST', body: JSON.stringify({ skill: skillName, profile }) });
    showToast(res.ok ? 'Skill uninstalled!' : (res.output || 'Uninstall failed'), res.ok ? 'success' : 'error');
    if (res.ok) window.loadAgentSkills(document.getElementById('agent-tab-content'), profile);
  } catch (e) { showToast(e.message, 'error'); }
};

window.checkSkillUpdates = async function(profile) {
  try {
    showToast('Checking for updates...', 'info');
    const res = await api('/api/skills/check', { method: 'POST', body: JSON.stringify({ profile }) });
    if (res.ok && res.output) {
      const lines = res.output.split('\n');
      const updates = [];
      for (const line of lines) {
        const m = line.match(/[│┃]\s*([^\s│┃]+)\s*[│┃]\s*(.+?)\s*[│┃]\s*(\S+)\s*[│┃]/);
        if (m) updates.push({ name: m[1].trim(), description: m[2].trim(), source: m[3].trim() });
      }
      if (updates.length === 0) {
        await customAlert('All skills are up to date!', 'Skill Updates');
      } else {
        const html = '<div style="max-height:400px;overflow-y:auto;">' + updates.map(u =>
          `<div style="padding:8px;border-bottom:1px solid var(--border);"><span style="font-weight:600;">${escapeHtml(u.name)}</span><span style="color:var(--amber);font-size:11px;margin-left:8px;">${escapeHtml(u.source)}</span></div>`
        ).join('') + '</div>';
        await customAlert(html, `Updates Available (${updates.length})`);
      }
    } else {
      showToast(res.error || 'Check failed', 'error');
    }
  } catch (e) { showToast(e.message, 'error'); }
};

export { loadAgents, deleteAgent, setAgentDefault, loadAgentDetail, loadAgentTab, loadAgentDashboard, loadAgentSessions, toggleSessionDetail, loadSessionStats, resumeSession, openTerminalPanel, loadXtermAndConnect, renameSession, exportSession, deleteSession, loadAgentGateway, renderGatewayHealth, fixGateway, loadGatewayConnections, loadGatewayLogs, gatewayAction, sseProgressModal };
