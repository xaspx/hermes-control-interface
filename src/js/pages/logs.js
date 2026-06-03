import { state, t } from '../core/state.js';;
import { api } from '../core/api.js';
import { escapeHtml } from '../core/utils.js';

const LEVEL_MAP = { info: 'INF', debug: 'DBG', error: 'ERR', warn: 'WRN', system: 'SYS', user: 'USR' };
const LEVEL_STYLES = {
  INF: 'color:var(--fg-muted)',
  DBG: 'color:var(--fg-subtle)',
  ERR: 'color:var(--coral,#ff6b6b);font-weight:600',
  WRN: 'color:var(--gold,#ffac02)',
  SYS: 'color:var(--teal,#4ecdc4)',
  USR: 'color:var(--purple,#a78bfa)',
};
const TYPE_DEFS = {
  QC:    { keywords: ['quality', 'score', 'eval'],            color: '#a78bfa', label: 'QC' },
  ALERT: { keywords: ['alert', 'warning', 'critical', 'threshold'], color: '#ff6b6b', label: 'ALERT' },
  TASK:  { keywords: ['task', 'job', 'running', 'completed'], color: '#4ecdc4', label: 'TASK' },
  TOOL:  { keywords: ['tool', 'function', 'call'],            color: '#60a5fa', label: 'TOOL' },
  MCP:   { keywords: ['mcp', 'mcp-server', 'stdio'],         color: '#fb923c', label: 'MCP' },
};

async function loadLogs(container) {
  state._logsData = [];
  state._logsAutoRefresh = true;
  state._logsMode = 'poll';
  state._logsStickyBottom = true;
  state._logsLevel = '';
  state._logsComponent = '';
  state._logsType = '';

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
        <span style="font-size:11px;color:var(--fg-muted);" data-i18n="auto.level">Level:</span>
        <div id="logs-level-btns" style="display:flex;gap:3px;">
          <button class="btn btn-ghost btn-sm logs-lvl-btn active" data-level="" onclick="setLogsLevel('')">ALL</button>
          <button class="btn btn-ghost btn-sm logs-lvl-btn" data-level="info" onclick="setLogsLevel('info')">INF</button>
          <button class="btn btn-ghost btn-sm logs-lvl-btn" data-level="debug" onclick="setLogsLevel('debug')">DBG</button>
          <button class="btn btn-ghost btn-sm logs-lvl-btn" data-level="warn" onclick="setLogsLevel('warn')">WRN</button>
          <button class="btn btn-ghost btn-sm logs-lvl-btn" data-level="error" onclick="setLogsLevel('error')">ERR</button>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:4px;">
        <span style="font-size:11px;color:var(--fg-muted);" data-i18n="auto.type">Type:</span>
        <div id="logs-type-btns" style="display:flex;gap:3px;">
          <button class="btn btn-ghost btn-sm logs-type-btn active" data-type="" onclick="setLogsType('')">ALL</button>
          <button class="btn btn-ghost btn-sm logs-type-btn" data-type="QC" onclick="setLogsType('QC')" style="color:#a78bfa;">QC</button>
          <button class="btn btn-ghost btn-sm logs-type-btn" data-type="ALERT" onclick="setLogsType('ALERT')" style="color:#ff6b6b;">ALERT</button>
          <button class="btn btn-ghost btn-sm logs-type-btn" data-type="TASK" onclick="setLogsType('TASK')" style="color:#4ecdc4;">TASK</button>
          <button class="btn btn-ghost btn-sm logs-type-btn" data-type="TOOL" onclick="setLogsType('TOOL')" style="color:#60a5fa;">TOOL</button>
          <button class="btn btn-ghost btn-sm logs-type-btn" data-type="MCP" onclick="setLogsType('MCP')" style="color:#fb923c;">MCP</button>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:4px;">
        <span style="font-size:11px;color:var(--fg-muted);" data-i18n="auto.lines">Lines:</span>
        <select id="logs-lines" class="log-level-select" onchange="refreshLogs()" style="width:70px;">
          <option value="50">50</option>
          <option value="100" selected>100</option>
          <option value="200">200</option>
          <option value="500">500</option>
        </select>
      </div>
      <div style="display:flex;align-items:center;gap:4px;">
        <span style="font-size:11px;color:var(--fg-muted);" data-i18n="auto.search">Search:</span>
        <input id="logs-search" class="search-input" placeholder="keyword..." oninput="debounceLogsSearch()" style="width:140px;" />
      </div>
      <div style="display:flex;align-items:center;gap:4px;margin-left:auto;">
        <button class="btn btn-ghost btn-sm" id="logs-auto-btn" onclick="toggleLogsAuto()" data-i18n="auto.auto">● auto</button>
        <select id="logs-mode" class="log-level-select" onchange="setLogsMode(this.value)" style="width:60px;" title="Refresh mode">
          <option value="poll">poll</option>
          <option value="stream">stream</option>
        </select>
        <button class="btn btn-ghost btn-sm" onclick="clearLogs()" data-i18n="auto.clear">Clear</button>
        <button class="btn btn-ghost btn-sm" onclick="refreshLogs()">⟳</button>
      </div>
    </div>
    <div id="logs-component-bar" style="display:none;margin-bottom:6px;padding:4px 8px;background:var(--bg-inset);border-radius:6px;font-size:11px;align-items:center;gap:6px;">
      <span style="color:var(--fg-muted);" data-i18n="auto.filtering">Filtering:</span>
      <span id="logs-component-tag" style="color:var(--teal);font-weight:600;"></span>
      <button class="btn btn-ghost btn-sm" onclick="clearLogsComponent()" style="font-size:10px;padding:1px 6px;">✕</button>
    </div>
    <div id="logs-panel" style="position:relative;max-height:calc(100vh - 280px);overflow-y:auto;font-family:var(--font-mono,monospace);font-size:12px;line-height:1.7;"></div>
    <div id="logs-jump-btn" style="display:none;position:fixed;bottom:80px;right:24px;z-index:100;">
      <button class="btn btn-primary btn-sm" onclick="scrollLogsBottom()" style="box-shadow:0 2px 8px rgba(0,0,0,0.3);" data-i18n="auto.newLogs">↓ New logs</button>
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

async function loadMonitoring(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title" data-i18n="auto.systemMonitor">System Monitor</div>
        <div class="page-subtitle" data-i18n="auto.realtimeSystemResourceMetrics">Real-time system resource metrics</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost" onclick="loadMonitoring(document.querySelector('.page.active'))" data-i18n="home.refresh">↻ Refresh</button>
      </div>
    </div>

    <!-- Key metrics bar -->
    <div id="mon-overview" class="mon-overview" style="margin-top:12px;">
      <div class="loading" data-i18n="auto.loadingMetrics">Loading metrics…</div>
    </div>

    <!-- Metrics grid -->
    <div id="mon-grid" class="mon-grid" style="margin-top:16px;">
      <div class="mon-card" id="mon-cpu">
        <div class="mon-card-title" data-i18n="auto.cpuUsage">CPU Usage</div>
        <div class="mon-card-body">
          <div class="mon-big-val" id="mon-cpu-val">—</div>
          <div class="mon-sub" id="mon-cpu-sub">%</div>
          <div class="mon-progress-track">
            <div class="mon-progress-fill" id="mon-cpu-bar" style="width:0%"></div>
          </div>
          <div class="mon-progress-label" id="mon-cpu-pct">—</div>
        </div>
      </div>
      <div class="mon-card" id="mon-mem">
        <div class="mon-card-title" data-i18n="auto.memory">Memory</div>
        <div class="mon-card-body">
          <div class="mon-big-val" id="mon-mem-val">—</div>
          <div class="mon-sub" id="mon-mem-sub">MB</div>
          <div class="mon-progress-track">
            <div class="mon-progress-fill" id="mon-mem-bar" style="width:0%"></div>
          </div>
          <div class="mon-progress-label" id="mon-mem-pct">—</div>
        </div>
      </div>
      <div class="mon-card" id="mon-disk">
        <div class="mon-card-title" data-i18n="auto.disk">Disk</div>
        <div class="mon-card-body">
          <div class="mon-big-val" id="mon-disk-val">—</div>
          <div class="mon-sub" id="mon-disk-sub"></div>
          <div class="mon-progress-track">
            <div class="mon-progress-fill" id="mon-disk-bar" style="width:0%"></div>
          </div>
          <div class="mon-progress-label" id="mon-disk-pct">—</div>
        </div>
      </div>
      <div class="mon-card" id="mon-procs">
        <div class="mon-card-title" data-i18n="auto.processes">Processes</div>
        <div class="mon-card-body">
          <div class="mon-big-val" id="mon-procs-val">—</div>
          <div class="mon-sub">running</div>
        </div>
      </div>
    </div>

    <!-- Secondary metrics -->
    <div id="mon-secondary" class="mon-grid" style="margin-top:16px;">
      <div class="mon-card" id="mon-load">
        <div class="mon-card-title" data-i18n="auto.loadAverage">Load Average</div>
        <div class="mon-card-body" style="display:flex;gap:16px;align-items:baseline;">
          <div><div class="mon-big-val" style="font-size:16px;" id="mon-load1">—</div><div class="mon-sub" style="font-size:10px;">1m</div></div>
          <div><div class="mon-big-val" style="font-size:16px;" id="mon-load5">—</div><div class="mon-sub" style="font-size:10px;">5m</div></div>
          <div><div class="mon-big-val" style="font-size:16px;" id="mon-load15">—</div><div class="mon-sub" style="font-size:10px;">15m</div></div>
        </div>
      </div>
      <div class="mon-card" id="mon-net">
        <div class="mon-card-title" data-i18n="auto.networkIo">Network I/O</div>
        <div class="mon-card-body" style="display:flex;flex-direction:column;gap:4px;">
          <div class="mon-stat-row"><span class="mon-stat-label" data-i18n="auto.interface">Interface</span><span class="mon-stat-val" id="mon-net-iface">—</span></div>
          <div class="mon-stat-row"><span class="mon-stat-label" data-i18n="auto.bytes">Bytes</span><span class="mon-stat-val" id="mon-net-bytes">—</span></div>
          <div class="mon-stat-row"><span class="mon-stat-label" data-i18n="auto.packets">Packets</span><span class="mon-stat-val" id="mon-net-packets">—</span></div>
        </div>
      </div>
      <div class="mon-card" id="mon-node-mem">
        <div class="mon-card-title" data-i18n="auto.nodejsMemory">Node.js Memory</div>
        <div class="mon-card-body" style="display:flex;flex-direction:column;gap:4px;">
          <div class="mon-stat-row"><span class="mon-stat-label">RSS</span><span class="mon-stat-val" id="mon-node-rss">—</span></div>
          <div class="mon-stat-row"><span class="mon-stat-label" data-i18n="auto.heapUsed">Heap Used</span><span class="mon-stat-val" id="mon-node-heap">—</span></div>
          <div class="mon-stat-row"><span class="mon-stat-label" data-i18n="auto.heapTotal">Heap Total</span><span class="mon-stat-val" id="mon-node-heap-total">—</span></div>
        </div>
      </div>
    </div>

    <!-- System info -->
    <div id="mon-info" class="mon-grid" style="margin-top:16px;">
      <div class="mon-card">
        <div class="mon-card-title" data-i18n="auto.uptime">Uptime</div>
        <div class="mon-card-body">
          <div class="mon-big-val" style="font-size:18px;" id="mon-uptime-val">—</div>
        </div>
      </div>
      <div class="mon-card">
        <div class="mon-card-title" data-i18n="auto.versions">Versions</div>
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
        <div class="mon-ov-item"><span class="mon-ov-label" data-i18n="auto.memory">Memory</span><span class="mon-ov-val">${r.memory || '—'}</span></div>
        <div class="mon-ov-item"><span class="mon-ov-label" data-i18n="auto.disk">Disk</span><span class="mon-ov-val">${r.disk || '—'}</span></div>
        <div class="mon-ov-item"><span class="mon-ov-label" data-i18n="auto.processes">Processes</span><span class="mon-ov-val">${r.processes || 0}</span></div>
        <div class="mon-ov-item"><span class="mon-ov-label" data-i18n="auto.load">Load</span><span class="mon-ov-val">${r.load?.avg1 || '—'}, ${r.load?.avg5 || '—'}, ${r.load?.avg15 || '—'}</span></div>
      </div>
    `;

    // Primary metrics
    document.getElementById('mon-cpu-val').textContent = r.cpu?.replace('%', '') || '—';
    document.getElementById('mon-mem-val').textContent = (r.memory || '—').split(' ')[0] || '—';
    document.getElementById('mon-mem-sub').textContent = (r.memory || '').includes('MB') ? 'MB' : '';
    document.getElementById('mon-disk-val').textContent = (r.disk || '—').split(' ')[0] || '—';
    document.getElementById('mon-disk-sub').textContent = (r.disk || '—').split(' ').slice(1).join(' ') || '';
    document.getElementById('mon-procs-val').textContent = r.processes || 0;

    // Progress bars — color-coded: green (<60%), yellow (60-80%), red (>80%)
    const getBarColor = (pct) => pct > 80 ? 'var(--danger, #ef4444)' : pct > 60 ? 'var(--warning, #eab308)' : 'var(--success, #22c55e)';

    const cpuPct = r.cpu_pct ?? (parseFloat(r.cpu) || 0);
    const cpuBar = document.getElementById('mon-cpu-bar');
    const cpuPctEl = document.getElementById('mon-cpu-pct');
    if (cpuBar) { cpuBar.style.width = Math.min(cpuPct, 100) + '%'; cpuBar.style.background = getBarColor(cpuPct); }
    if (cpuPctEl) { cpuPctEl.textContent = cpuPct.toFixed(1) + '%'; cpuPctEl.style.color = getBarColor(cpuPct); }

    const memPct = r.mem_pct ?? 0;
    const memBar = document.getElementById('mon-mem-bar');
    const memPctEl = document.getElementById('mon-mem-pct');
    if (memBar) { memBar.style.width = Math.min(memPct, 100) + '%'; memBar.style.background = getBarColor(memPct); }
    if (memPctEl) { memPctEl.textContent = memPct.toFixed(1) + '% used'; memPctEl.style.color = getBarColor(memPct); }

    const diskPct = r.disk_pct ?? 0;
    const diskBar = document.getElementById('mon-disk-bar');
    const diskPctEl = document.getElementById('mon-disk-pct');
    if (diskBar) { diskBar.style.width = Math.min(diskPct, 100) + '%'; diskBar.style.background = getBarColor(diskPct); }
    if (diskPctEl) { diskPctEl.textContent = diskPct.toFixed(1) + '% used'; diskPctEl.style.color = getBarColor(diskPct); }

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

      // Client-side type filter
      const typeFilter = state._logsType || '';
      if (typeFilter) {
        logs = logs.filter(l => detectLogType(l.message) === typeFilter);
      }

      state._logsData = logs;
      renderLogs();
    } else {
      console.warn('[Logs] API returned not ok:', r);
    }
  } catch (e) {
    console.error('[Logs] refreshLogs failed:', e);
  }
}

function renderLogs() {
  const panel = document.getElementById('logs-panel');
  const stats = document.getElementById('logs-stats');
  if (!panel) return;

  const logs = state._logsData;
  if (!logs.length) {
    panel.innerHTML = `<div style="padding:20px;text-align:center;color:var(--fg-subtle);" data-i18n="auto.noLogEntries">No log entries</div>`;
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

  // Type counts
  const typeCounts = {};
  logs.forEach(e => {
    const t = detectLogType(e.message);
    if (t) typeCounts[t] = (typeCounts[t] || 0) + 1;
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
    // Detect entry type for badge
    const entryType = detectLogType(e.message);
    const typeBadge = entryType && TYPE_DEFS[entryType]
      ? `<span style="color:${TYPE_DEFS[entryType].color};font-weight:600;font-size:10px;letter-spacing:0.3px;background:${TYPE_DEFS[entryType].color}18;padding:0 4px;border-radius:3px;margin-left:4px;cursor:pointer;" onclick="setLogsType('${entryType}')" title="Filter by ${entryType}">${entryType}</span>`
      : '';
    return `<div class="log-line" onmouseenter="this.querySelector('.log-copy-icon').style.opacity=1" onmouseleave="this.querySelector('.log-copy-icon').style.opacity=0" style="display:flex;align-items:baseline;padding:1px 4px;border-radius:3px;${shortLvl === 'ERR' ? 'background:rgba(255,107,107,0.06);' : ''}${shortLvl === 'WRN' ? 'background:rgba(255,172,2,0.04);' : ''}">
      <span style="color:var(--fg-subtle);user-select:none;min-width:70px;">[${time}]</span>
      <span style="${style};min-width:32px;text-align:center;font-weight:600;user-select:none;">${shortLvl}</span>
      ${typeBadge}
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
      ${Object.entries(typeCounts).map(([t, c]) => `<span style="color:${TYPE_DEFS[t]?.color || 'var(--fg-muted)'};margin-left:6px;">${t} ${c}</span>`).join('')}
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

function setLogsLevel(lvl) {
  state._logsLevel = lvl;
  document.querySelectorAll('.logs-lvl-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.level === lvl);
  });
  refreshLogs();
}

function setLogsType(type) {
  state._logsType = type;
  document.querySelectorAll('.logs-type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
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

function detectLogType(message) {
  if (!message) return null;
  const lower = message.toLowerCase();
  // Check MCP first (more specific) before TOOL which shares 'mcp' keyword
  for (const [type, def] of Object.entries(TYPE_DEFS)) {
    if (def.keywords.some(kw => lower.includes(kw))) return type;
  }
  return null;
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

export { loadLogs, loadMonitoring, refreshMonitoring, refreshLogs, renderLogs, fmtLogTime, setLogsLevel, setLogsType, setLogsComponent, toggleLogsAuto, startLogsAutoRefresh, stopLogsAutoRefresh, updateLogsAutoBtn, setLogsMode, debounceLogsSearch, detectLogType };
