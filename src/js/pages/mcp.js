// MCP Manager Page — server list, tools inspector, live logs
import { state } from '../core/state.js';
import { api } from '../core/api.js';
import { showToast } from '../components/toast.js';
import { customConfirm } from '../components/modal.js';
import { escapeHtml } from '../core/utils.js';

let selectedServer = null;
let autoRefreshId = null;
let logsPaused = false;

const STATUS_COLORS = {
  running: '#4ecdc4',
  starting: '#ffd93d',
  stopping: '#ff8c42',
  stopped: '#666',
  error: '#ff6b6b',
};

export function loadMcp(container) {
  if (!container) return;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">📡 MCP Servers</div>
        <div class="page-subtitle">Manage Model Context Protocol servers</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-sm btn-ghost" onclick="navigate('#mcp')">🔄 Refresh</button>
        <button class="btn btn-sm btn-primary" onclick="showAddMcpModal()">+ Add Server</button>
      </div>
    </div>
    <div class="mcp-layout">
      <div id="mcp-server-list" class="mcp-sidebar">
        <div class="loading">Loading servers...</div>
      </div>
      <div id="mcp-detail-panel" class="mcp-detail">
        <div class="mcp-empty" style="margin-top:80px;">
          📡 Select a server from the list
        </div>
      </div>
    </div>
  `;

  fetchMcpServers();
  autoRefreshId = setInterval(fetchMcpServers, 5000);
}

function fetchMcpServers() {
  api('/api/mcp/servers').then(res => {
    if (!res.ok) {
      console.error('[MCP] servers API failed:', res.status, res.error);
      return;
    }
    renderServerList(res.servers || []);
    if (selectedServer && res.servers) {
      const stillExists = res.servers.find(s => s.name === selectedServer);
      if (stillExists) {
        selectedServer = stillExists.name;
        fetchMcpDetail(selectedServer, true);
      } else {
        selectedServer = null;
        document.getElementById('mcp-detail-panel').innerHTML =
          '<div class="mcp-empty" style="margin-top:80px;">📡 Select a server from the list</div>';
      }
    }
  }).catch(e => {
    console.error('[MCP] fetchMcpServers failed:', e);
  });
}

function renderServerList(servers) {
  const el = document.getElementById('mcp-server-list');
  if (!el) return;

  if (!servers.length) {
    el.innerHTML = `<div class="mcp-empty">
      <div style="font-size:48px;margin-bottom:16px;">📡</div>
      <div style="font-weight:600;font-size:15px;margin-bottom:8px;">No MCP Servers Configured</div>
      <p style="color:var(--fg-muted);font-size:13px;line-height:1.6;max-width:400px;margin:0 auto 16px;">
        MCP (Model Context Protocol) servers give Hermes agents new capabilities — like controlling a browser, accessing GitHub, or querying databases. Each server exposes tools that agents can use.
      </p>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
        <button class="btn btn-sm btn-primary" onclick="showAddMcpModal()">+ Add Server</button>
      </div>
    </div>`;
    // Also update the detail panel
    const detail = document.getElementById('mcp-detail-panel');
    if (detail) detail.innerHTML = `<div class="mcp-empty" style="margin-top:60px;">
      <div style="font-size:32px;margin-bottom:12px;">🔧</div>
      <div style="font-weight:600;margin-bottom:8px;">Ready to Extend Your Agents</div>
      <p style="color:var(--fg-muted);font-size:13px;line-height:1.6;max-width:440px;">
        Popular MCP servers include <b>Chrome DevTools</b> (browser automation), <b>GitHub</b> (PR & repo management), <b>Filesystem</b> (file access), and <b>Postgres</b> (database queries).
      </p>
      <p style="color:var(--fg-muted);font-size:12px;margin-top:16px;">
        Use <code>mcporter</code> CLI or <code>mcp:</code> section in <code>config.yaml</code> to configure servers.
      </p>
    </div>`;
    return;
  }

  el.innerHTML = `
    <input type="text" id="mcp-filter" class="search-input" placeholder="Filter servers..."
      style="width:100%;margin-bottom:8px;box-sizing:border-box;"
      oninput="renderServerListFiltered()" />
    <div id="mcp-servers-inner">
      ${servers.map(s => {
        const color = STATUS_COLORS[s.status] || '#666';
        const uptime = s.uptime ? fmtUptime(s.uptime) : '';
        return `
          <div class="mcp-server-card ${selectedServer === s.name ? 'mcp-selected' : ''}"
               onclick="selectMcpServer('${escapeHtml(s.name)}')"
               style="border-color:${selectedServer === s.name ? color : 'transparent'};">
            <span class="mcp-dot" style="background:${color};" title="${s.status}"></span>
            <div class="mcp-card-body">
              <div class="mcp-card-name">${escapeHtml(s.name)}</div>
              <div class="mcp-card-meta">
                <span>${s.type}</span>
                ${s.toolCount ? `<span>· ${s.toolCount} tools</span>` : ''}
                ${uptime ? `<span>· ${uptime}</span>` : ''}
              </div>
            </div>
          </div>`;
      }).join('')}
    </div>`;
}

export function renderServerListFiltered() {
  const filter = (document.getElementById('mcp-filter')?.value || '').toLowerCase();
  const cards = document.querySelectorAll('.mcp-server-card');
  cards.forEach(card => {
    const name = card.querySelector('div div:first-child')?.textContent?.toLowerCase() || '';
    card.style.display = name.includes(filter) ? '' : 'none';
  });
}

export function selectMcpServer(name) {
  selectedServer = name;
  // Re-render list to highlight
  api('/api/mcp/servers').then(res => {
    if (res.ok) renderServerList(res.servers || []);
    fetchMcpDetail(name);
  });
}

async function fetchMcpDetail(name, silent) {
  const panel = document.getElementById('mcp-detail-panel');
  if (!panel) return;

  if (!silent) panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const res = await api(`/api/mcp/servers/${encodeURIComponent(name)}`);
    if (!res.ok) { panel.innerHTML = `<div style="color:var(--danger)">${escapeHtml(res.error)}</div>`; return; }

    const s = res.server;
    const color = STATUS_COLORS[s.status] || '#666';
    const uptime = s.uptime ? fmtUptime(s.uptime) : '—';

    panel.innerHTML = `
      <div class="mcp-detail-header">
        <span class="mcp-dot" style="width:12px;height:12px;background:${color};"></span>
        <h3>${escapeHtml(s.name)}</h3>
        <span class="badge">${s.type}</span>
        <span class="badge ${s.status === 'running' ? 'badge-success' : s.status === 'error' ? 'badge-danger' : ''}"
              style="margin-left:auto;">${s.status}</span>
      </div>

      <div style="display:flex;gap:8px;margin-bottom:16px;">
        ${s.status === 'running'
          ? `<button class="btn btn-sm btn-danger" onclick="mcpAction('${escapeHtml(s.name)}','stop')">⏹ Stop</button>
             <button class="btn btn-sm btn-ghost" onclick="mcpAction('${escapeHtml(s.name)}','restart')">↻ Restart</button>`
          : `<button class="btn btn-sm btn-success" onclick="mcpAction('${escapeHtml(s.name)}','start')">▶ Start</button>`}
        <button class="btn btn-sm btn-ghost" onclick="mcpAction('${escapeHtml(s.name)}','remove')">🗑 Remove</button>
      </div>

      <div class="mcp-stats">
        <div class="mcp-stat-item"><small>Uptime</small><br><strong>${uptime}</strong></div>
        <div class="mcp-stat-item"><small>PID</small><br><strong>${s.pid || '—'}</strong></div>
        <div class="mcp-stat-item"><small>Tools</small><br><strong>${s.toolCount}</strong></div>
        <div class="mcp-stat-item"><small>Memory</small><br><strong>${s.memory}</strong></div>
      </div>

      <div class="tabs" style="margin-bottom:8px;">
        <button class="tab active" onclick="mcpSwitchTab('${escapeHtml(s.name)}','tools')">🔧 Tools</button>
        <button class="tab" onclick="mcpSwitchTab('${escapeHtml(s.name)}','logs')">📜 Logs</button>
        <button class="tab" onclick="mcpSwitchTab('${escapeHtml(s.name)}','config')">⚙ Config</button>
      </div>
      <div id="mcp-tab-content"></div>
    `;

    // Default to tools tab
    mcpSwitchTab(s.name, 'tools', s);
  } catch (e) {
    panel.innerHTML = `<div style="color:var(--danger)">Error: ${escapeHtml(e.message)}</div>`;
  }
}

export function mcpSwitchTab(serverName, tab, serverData) {
  const content = document.getElementById('mcp-tab-content');
  if (!content) return;

  // Update tab active states
  document.querySelectorAll('#mcp-detail-panel .tab').forEach(t => {
    t.classList.toggle('active', t.textContent.includes(tab === 'tools' ? 'Tools' : tab === 'logs' ? 'Logs' : 'Config'));
  });

  if (tab === 'tools') {
    const tools = serverData?.tools || [];
    if (!tools.length) {
      content.innerHTML = '<div class="mcp-empty">No tools discovered yet. Start the server to discover tools.</div>';
      return;
    }
    content.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:4px;">
        ${tools.map(t => `
          <div class="mcp-tool-card" onclick="this.nextElementSibling.style.display =
            this.nextElementSibling.style.display === 'none' ? 'block' : 'none'">
            <strong>${escapeHtml(t.name)}</strong>
            <span style="font-size:11px;color:var(--text-dim);margin-left:8px;"
              >${escapeHtml(t.description || '')}</span>
          </div>
          <div class="mcp-tool-detail">
            <div style="margin-bottom:4px;">Schema:</div>
            <pre>${escapeHtml(JSON.stringify(t.inputSchema || t, null, 2))}</pre>
            <button class="btn btn-xs btn-ghost" style="margin-top:6px;"
              onclick="event.stopPropagation();showMcpTestModal('${escapeHtml(serverName)}','${escapeHtml(t.name)}')"
              >▶ Test Tool</button>
          </div>
        `).join('')}
      </div>`;
  } else if (tab === 'logs') {
    const logs = serverData?.logs || [];
    content.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <button class="btn btn-xs ${logsPaused ? 'btn-primary' : 'btn-ghost'}" onclick="toggleMcpLogs()">
          ${logsPaused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <button class="btn btn-xs btn-ghost" onclick="clearMcpLogs()">Clear</button>
        <span style="font-size:11px;color:var(--text-dim);">${logs.length} lines</span>
      </div>
      <div id="mcp-logs-view" class="mcp-logs-view">
        ${logs.length ? logs.map(l => `<div>${escapeHtml(l)}</div>`).join('') :
          '<div style="color:var(--text-dim)">No log output yet.</div>'}
      </div>`;
  } else if (tab === 'config') {
    const cfg = serverData?.config || {};
    // Mask env values
    const safeCfg = { ...cfg };
    if (safeCfg.env) {
      if (Array.isArray(safeCfg.env)) {
        safeCfg.env = safeCfg.env.map(e => e.replace(/=.*/, '=••••'));
      } else {
        safeCfg.env = Object.fromEntries(Object.entries(safeCfg.env).map(([k]) => [k, '••••']));
      }
    }
    content.innerHTML = `
      <pre class="mcp-config-view">${escapeHtml(JSON.stringify(safeCfg, null, 2))}</pre>
      <div style="margin-top:8px;">
        <button class="btn btn-sm btn-primary" onclick="showEditMcpConfigModal('${escapeHtml(serverName)}')">Edit Config</button>
      </div>`;
  }
}

export function toggleMcpLogs() {
  logsPaused = !logsPaused;
  if (!selectedServer) return;
  if (!logsPaused) refreshMcpLogs();
}

export function clearMcpLogs() {
  // Just refresh the detail — server will clear on restart
  if (selectedServer) fetchMcpDetail(selectedServer);
}

function refreshMcpLogs() {
  if (logsPaused || !selectedServer) return;
  fetchMcpDetail(selectedServer, true);
}

export async function mcpAction(serverName, action) {
  if (action === 'remove') {
    const confirmed = await customConfirm(`Remove MCP server "${serverName}"? This cannot be undone.`);
    if (!confirmed) return;
  }

  const methodMap = {
    start: 'start', stop: 'stop', restart: 'restart', remove: ''
  };
  const method = action === 'remove' ? 'DELETE' : 'POST';
  const url = action === 'remove'
    ? `/api/mcp/servers/${encodeURIComponent(serverName)}`
    : `/api/mcp/servers/${encodeURIComponent(serverName)}/${methodMap[action]}`;

  try {
    const res = await api(url, { method, headers: { 'X-CSRF-Token': state.csrfToken || '' } });
    if (res.ok) {
      showToast(`${action} ${serverName}: ${res.message || 'ok'}`);
      // Refresh after a short delay
      setTimeout(() => {
        fetchMcpServers();
        if (action !== 'remove') setTimeout(() => fetchMcpDetail(serverName), 1500);
      }, 500);
    } else {
      showToast(res.error || `${action} failed`, 'error');
    }
  } catch (e) {
    showToast(`${action} error: ${e.message}`, 'error');
  }
}

export function showAddMcpModal() {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;';
  modal.onclick = e => { if (e.target === modal) modal.remove(); };

  const inputStyle = 'padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-size:13px;';
  const labelStyle = 'display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--fg-muted);margin-bottom:6px;';

  modal.innerHTML = `
    <div class="modal-card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:24px;min-width:420px;max-width:520px;box-shadow:0 8px 32px rgba(0,0,0,0.4);"
         onclick="event.stopPropagation()">
      <h3 style="margin:0 0 16px;font-size:15px;font-weight:600;">+ Add MCP Server</h3>
      <div style="display:flex;flex-direction:column;gap:2px;">
        <label style="${labelStyle}">Name *</label>
        <input id="mcp-add-name" style="${inputStyle}" placeholder="chrome-devtools" />

        <label style="${labelStyle}">Type *</label>
        <select id="mcp-add-type" style="${inputStyle};cursor:pointer;" onchange="toggleMcpAddType()">
          <option value="stdio">stdio (command)</option>
          <option value="http">http (URL)</option>
        </select>

        <div id="mcp-add-stdio">
          <label style="${labelStyle}">Command *</label>
          <input id="mcp-add-command" style="${inputStyle}" placeholder="npx @anthropic/mcp-server-puppeteer" />
        </div>
        <div id="mcp-add-http" style="display:none;">
          <label style="${labelStyle}">URL *</label>
          <input id="mcp-add-url" style="${inputStyle}" placeholder="https://mcp.example.com" />
        </div>

        <label style="${labelStyle}">Arguments</label>
        <input id="mcp-add-args" style="${inputStyle}" placeholder="-y (optional)" />

        <label style="${labelStyle}">Environment Variables</label>
        <textarea id="mcp-add-env" style="${inputStyle};min-height:60px;resize:vertical;font-family:monospace;font-size:12px;"
          placeholder="KEY=value&#10;API_KEY=sk-..."></textarea>
      </div>
      <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end;border-top:1px solid var(--border);padding-top:14px;">
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="submitAddMcp()">Add Server</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  document.getElementById('mcp-add-name')?.focus();
}

export function toggleMcpAddType() {
  const type = document.getElementById('mcp-add-type')?.value;
  const stdioDiv = document.getElementById('mcp-add-stdio');
  const httpDiv = document.getElementById('mcp-add-http');
  if (stdioDiv) stdioDiv.style.display = type === 'stdio' ? '' : 'none';
  if (httpDiv) httpDiv.style.display = type === 'http' ? '' : 'none';
}

export async function submitAddMcp() {
  const name = document.getElementById('mcp-add-name')?.value?.trim();
  const type = document.getElementById('mcp-add-type')?.value;
  const command = document.getElementById('mcp-add-command')?.value?.trim();
  const url = document.getElementById('mcp-add-url')?.value?.trim();
  const args = document.getElementById('mcp-add-args')?.value?.trim();
  const envRaw = document.getElementById('mcp-add-env')?.value?.trim();

  if (!name) { showToast('Name required', 'error'); return; }
  if (type === 'stdio' && !command) { showToast('Command required', 'error'); return; }
  if (type === 'http' && !url) { showToast('URL required', 'error'); return; }

  const body = { name };
  if (type === 'stdio') body.command = args ? `${command} ${args}` : command;
  if (type === 'http') body.url = url;
  if (envRaw) {
    const env = {};
    envRaw.split('\n').filter(Boolean).forEach(line => {
      const eq = line.indexOf('=');
      if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    });
    if (Object.keys(env).length) body.env = env;
  }

  try {
    const res = await api('/api/mcp/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
      body: JSON.stringify(body)
    });
    if (res.ok) {
      showToast(`Server "${name}" added`);
      document.querySelector('.modal-overlay')?.remove();
      fetchMcpServers();
    } else {
      showToast(res.error || 'Failed to add server', 'error');
    }
  } catch (e) {
    showToast(`Error: ${e.message}`, 'error');
  }
}

export function showMcpTestModal(serverName, toolName) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;';
  modal.onclick = e => { if (e.target === modal) modal.remove(); };

  modal.innerHTML = `
    <div class="modal-card" style="background:var(--surface);border-radius:8px;padding:24px;min-width:400px;"
         onclick="event.stopPropagation()">
      <h3 style="margin:0 0 16px;">▶ Test Tool: ${escapeHtml(toolName)}</h3>
      <div><label style="font-size:12px;">Params (JSON)</label>
        <textarea id="mcp-test-params" style="width:100%;min-height:80px;font-family:monospace;font-size:12px;"
          placeholder='{"key": "value"}'></textarea></div>
      <div id="mcp-test-result" style="margin-top:8px;display:none;">
        <div style="font-size:11px;font-weight:500;">Result:</div>
        <pre id="mcp-test-output" style="margin:0;padding:8px;background:var(--bg);border-radius:4px;
          max-height:200px;overflow-y:auto;font-size:11px;white-space:pre-wrap;"></pre>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Close</button>
        <button class="btn btn-primary" onclick="submitMcpTest('${escapeHtml(serverName)}','${escapeHtml(toolName)}')">Execute</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

export async function submitMcpTest(serverName, toolName) {
  const paramsRaw = document.getElementById('mcp-test-params')?.value?.trim();
  let params = {};
  if (paramsRaw) {
    try { params = JSON.parse(paramsRaw); }
    catch { showToast('Invalid JSON params', 'error'); return; }
  }

  try {
    const res = await api(`/api/mcp/servers/${encodeURIComponent(serverName)}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
      body: JSON.stringify({ tool: toolName, params })
    });
    const resultEl = document.getElementById('mcp-test-result');
    const outputEl = document.getElementById('mcp-test-output');
    if (resultEl && outputEl) {
      resultEl.style.display = 'block';
      outputEl.textContent = res.ok ? res.result : (res.error || 'No result');
    }
  } catch (e) {
    showToast(`Test error: ${e.message}`, 'error');
  }
}

export function showEditMcpConfigModal(serverName) {
  api(`/api/mcp/servers/${encodeURIComponent(serverName)}/config`).then(res => {
    if (!res.ok) { showToast(res.error, 'error'); return; }
    const cfg = res.config || {};

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;';
    modal.onclick = e => { if (e.target === modal) modal.remove(); };

    modal.innerHTML = `
      <div class="modal-card" style="background:var(--surface);border-radius:8px;padding:24px;min-width:450px;"
           onclick="event.stopPropagation()">
        <h3 style="margin:0 0 16px;">⚙ Edit Config: ${escapeHtml(serverName)}</h3>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <textarea id="mcp-edit-config" style="width:100%;min-height:200px;font-family:monospace;font-size:12px;">${escapeHtml(JSON.stringify(cfg, null, 2))}</textarea>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="btn btn-primary" onclick="submitMcpConfigEdit('${escapeHtml(serverName)}')">Save</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  });
}

export async function submitMcpConfigEdit(serverName) {
  const raw = document.getElementById('mcp-edit-config')?.value;
  if (!raw) return;

  try {
    const config = JSON.parse(raw);
    const res = await api(`/api/mcp/servers/${encodeURIComponent(serverName)}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
      body: JSON.stringify(config)
    });
    if (res.ok) {
      showToast('Config updated');
      document.querySelector('.modal-overlay')?.remove();
      if (selectedServer === serverName) fetchMcpDetail(serverName);
    } else {
      showToast(res.error || 'Save failed', 'error');
    }
  } catch (e) {
    showToast(`Invalid JSON: ${e.message}`, 'error');
  }
}

function fmtUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// Cleanup on page leave
export function unloadMcp() {
  if (autoRefreshId) { clearInterval(autoRefreshId); autoRefreshId = null; }
  selectedServer = null;
  logsPaused = false;
}

// Expose to window
window.loadMcp = loadMcp;
window.showAddMcpModal = showAddMcpModal;
window.mcpAction = mcpAction;
window.mcpSwitchTab = mcpSwitchTab;
window.showMcpTestModal = showMcpTestModal;
window.showEditMcpConfigModal = showEditMcpConfigModal;
window.submitAddMcp = submitAddMcp;
window.submitMcpTest = submitMcpTest;
window.submitMcpConfigEdit = submitMcpConfigEdit;
window.selectMcpServer = selectMcpServer;
window.toggleMcpAddType = toggleMcpAddType;
window.renderServerListFiltered = renderServerListFiltered;
window.toggleMcpLogs = toggleMcpLogs;
window.clearMcpLogs = clearMcpLogs;
