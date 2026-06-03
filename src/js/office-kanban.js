import { t } from './core/state.js';
// ═══════════════════════════════════════════════════════════════════════════
// OFFICE v3 — ZOO Swarm Monitor
// 3-panel dashboard: Agent Health | Kanban Pipeline | Live Feed
// Poll 2s · Agent-unique hover colors · Dependency arrows
// ═══════════════════════════════════════════════════════════════════════════
let pollTimer = null;
let currentBoard = 'main';
let kanbanData = null;
let agentStates = [];
let eventsData = [];
let containerId = null;
let highlightedAgent = null;
let fetchInFlight = false; // guard against overlapping polls
// ── Status Config ──────────────────────────────────────────────────────────
const STATUS_ORDER = ['triage','todo','scheduled','ready','running','blocked','review','done'];
const STATUS_META = {
  triage:    { emoji:'🔍', label:'Triage',    cls:'kb--muted' },
  todo:      { emoji:'📋', label:'Todo',      cls:'kb--muted' },
  scheduled: { emoji:'⏰', label:'Scheduled', cls:'kb--blue'  },
  ready:     { emoji:'⬜', label:'Ready',     cls:'kb--blue'  },
  running:   { emoji:'🔄', label:'In Progress', cls:'kb--amber' },
  blocked:   { emoji:'⚠️', label:'Blocked',  cls:'kb--red'   },
  review:    { emoji:'👁️', label:'Review',   cls:'kb--pink'  },
  done:      { emoji:'✅', label:'Done',     cls:'kb--green' },
};
const AGENT_STATE_META = {
  idle:      { emoji:'💤', label:'Idle',     cls:'kb--muted' },
  thinking:  { emoji:'💭', label:'Thinking', cls:'kb--amber' },
  coding:    { emoji:'💻', label:'Coding',   cls:'kb--green' },
  running:   { emoji:'🟢', label:'Running',  cls:'kb--green' },
  blocked:   { emoji:'⚠️', label:'Blocked',  cls:'kb--red'   },
  stopped:   { emoji:'⚫', label:'Stopped',  cls:'kb--muted' },
};
// Unique color per agent — mapped to HCI CSS variables
function getAgentColor(name) {
  const map = {
    david:   'var(--accent)',  // sage green
    cuan:    'var(--amber)',  // amber
    soci:    'var(--blue)',   // blue
    hermes:  'var(--pink)',   // pink
    default: 'var(--fg-muted)',
  };
  return map[name] || `var(--accent)`;
}
// ── Init ───────────────────────────────────────────────────────────────────
let rendered = false; // Track if shell has been rendered (init only)
export async function initKanbanBoard(contId, board) {
  containerId = contId;
  if (board) currentBoard = board;
  destroyKanbanBoard();
  rendered = false;
  fetchDataAndPatch(); // First call renders shell + fetches all
}
export function destroyKanbanBoard() {
  stopKanbanPoll();
  kanbanData = null;
  agentStates = [];
  eventsData = [];
  rendered = false;
}
// ── Data Fetch — 2s poll ───────────────────────────────────────────────────
// Init: render shell with loading spinners, then fire independent fetches
// Poll: only fire fetches, patch panels without resetting shell
async function fetchDataAndPatch() {
  // In-flight guard: skip if previous poll still running
  if (fetchInFlight) return;
  fetchInFlight = true;

  // Only render layout skeleton on first call
  if (!rendered) {
    renderLayoutShell();
    rendered = true;
  }
  // Fire all 3 in parallel but update panels as each resolves
  // Kanban is fast (~0.2s), agent-states ~0.1s, events ~0.1s
  const kanbanP = fetch(`/api/office/kanban?board=${currentBoard}`)
    .then(r => r.json())
    .then(res => {
      if (res?.ok) { kanbanData = res; patchKanbanPanel(); }
    })
    .catch(() => null);
  const agentsP = fetch('/api/office/agent-states')
    .then(r => r.json())
    .then(res => {
      if (res?.ok) { agentStates = res.agents || []; patchAgentPanel(); patchKanbanPanel(); }
    })
    .catch(() => null);
  const eventsP = fetch('/api/office/events')
    .then(r => r.json())
    .then(res => {
      if (res?.ok) { eventsData = res.events || []; patchEventPanel(); }
    })
    .catch(() => null);

  // Reset guard after all 3 settle (success or fail)
  Promise.allSettled([kanbanP, agentsP, eventsP]).finally(() => {
    fetchInFlight = false;
  });
}
// Render just the shell with loading spinners
function renderLayoutShell() {
  const root = document.getElementById(containerId);
  if (!root) return;
  root.innerHTML = `
    <div class="swm-layout">
      <div class="swm-panel swm-panel--agents" id="swm-agent-panel">
        <div class="swm-panel-header">👥 Agents</div>
        <div class="swm-loading">⟳ Loading...</div>
      </div>
      <div class="swm-panel swm-panel--kanban" id="swm-kanban-panel">
        <div class="swm-panel-header"><span>📋 ${esc(currentBoard)}</span></div>
        <div class="swm-loading">⟳ Loading...</div>
      </div>
      <div class="swm-panel swm-panel--events" id="swm-event-panel">
        <div class="swm-panel-header">📡 Live Feed</div>
        <div class="swm-loading">⟳ Loading...</div>
      </div>
    </div>`;
}
// Targeted DOM patches — faster than full rerender
function patchKanbanPanel() {
  const el = document.getElementById('swm-kanban-panel');
  if (!el) return;
  const tasks = kanbanData?.tasks || [];
  const links = kanbanData?.links || [];
  el.outerHTML = renderKanbanPanel(tasks, links);
  // Re-draw arrows
  if (links.length > 0) {
    requestAnimationFrame(() => drawDependencyArrows());
  }
}
function patchAgentPanel() {
  const el = document.getElementById('swm-agent-panel');
  if (!el) return;
  el.outerHTML = renderAgentPanel();
}
function patchEventPanel() {
  const el = document.getElementById('swm-event-panel');
  if (!el) return;
  el.outerHTML = renderEventPanel();
}
export function startKanbanPoll(interval = 2000) {
  stopKanbanPoll();
  pollTimer = setInterval(fetchDataAndPatch, interval);
}
export function stopKanbanPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
export function switchKanbanBoard(board) {
  currentBoard = board;
  document.querySelectorAll('#office-controls .btn').forEach(b => {
    const txt = b.textContent.toLowerCase();
    b.classList.toggle('btn-active', txt.includes(board));
  });
  fetchDataAndPatch();
}
window.switchKanbanBoard = switchKanbanBoard;
// ── Render All Panels ──────────────────────────────────────────────────────
function renderAll() {
  const root = document.getElementById(containerId);
  if (!root) return;
  const tasks = kanbanData?.tasks || [];
  const links = kanbanData?.links || [];
  root.innerHTML = `
    <div class="swm-layout">
      ${renderAgentPanel()}
      ${renderKanbanPanel(tasks, links)}
      ${renderEventPanel()}
    </div>`;
  // Draw dependency arrows after DOM settles
  if (links.length > 0) {
    requestAnimationFrame(() => drawDependencyArrows());
  }
}
// ── Agent Panel (Left) ─────────────────────────────────────────────────────
function renderAgentPanel() {
  if (!agentStates.length) {
    return `<div class="swm-panel swm-panel--agents" id="swm-agent-panel"><div class="swm-panel-header">👥 Agents</div><div class="swm-empty">No agents</div></div>`;
  }
  let cards = '';
  agentStates.forEach(a => {
    const meta = AGENT_STATE_META[a.state] || AGENT_STATE_META.running;
    const activeTasks = kanbanData ? (kanbanData.tasks || []).filter(t => t.assignee === a.name && t.status === 'running').length : 0;
    const totalTasks = kanbanData ? (kanbanData.tasks || []).filter(t => t.assignee === a.name).length : 0;
    const color = getAgentColor(a.name);
    const highlighted = highlightedAgent === a.name ? ' swm-agent--hl' : '';
    cards += `
      <div class="swm-agent-card ${meta.cls}${highlighted}"
           data-agent="${esc(a.name)}"
           data-agent-color="${esc(color)}"
           onclick="window.highlightAgent('${esc(a.name)}','${esc(color)}')"
           onmouseenter="window.highlightAgent('${esc(a.name)}','${esc(color)}')"
           onmouseleave="window.highlightAgent(null,null)">
        <div class="swm-agent-dot"></div>
        <div class="swm-agent-info">
          <div class="swm-agent-name">${esc(a.name)}</div>
          <div class="swm-agent-state">${meta.emoji} ${meta.label}</div>
        </div>
        <div class="swm-agent-tasks">
          ${activeTasks ? `<span class="swm-badge swm-badge--amber">${activeTasks} active</span>` : ''}
          ${totalTasks ? `<span class="swm-badge">${totalTasks} total</span>` : ''}
          ${!totalTasks ? `<span class="swm-badge swm-badge--muted">—</span>` : ''}
        </div>
        ${a.lastAction ? `<div class="swm-agent-last" title="${esc(a.lastAction)}">${esc(trunc(a.lastAction, 20))}</div>` : ''}
      </div>`;
  });
  return `
    <div class="swm-panel swm-panel--agents" id="swm-agent-panel">
      <div class="swm-panel-header">👥 Agents</div>
      <div class="swm-agent-list">${cards}</div>
    </div>`;
}
window.highlightAgent = function(name, color) {
  highlightedAgent = name;
  document.querySelectorAll('.swm-agent-card').forEach(c => {
    c.classList.toggle('swm-agent--hl', c.dataset.agent === name);
  });
  document.querySelectorAll('.kb-card').forEach(c => {
    const match = name && c.dataset.assignee === name;
    c.classList.toggle('swm-card--agent-hl', match);
    if (match && color) {
      c.style.setProperty('--agent-hl-color', color);
      c.style.setProperty('--agent-hl-border', color.replace(')', ', 0.4)'));
    } else {
      c.style.removeProperty('--agent-hl-color');
      c.style.removeProperty('--agent-hl-border');
    }
  });
};
// ── Kanban Panel (Center) ──────────────────────────────────────────────────
function renderKanbanPanel(tasks, links) {
  links = links || [];
  // Build dependency lookup: taskId → unresolved parent IDs
  const taskMap = {};
  tasks.forEach(t => { taskMap[t.id] = t; });
  const waitingOn = {}; // child_id → [parent_ids that are NOT done]
  links.forEach(l => {
    const parent = taskMap[l.parent_id];
    if (parent && parent.status !== 'done') {
      if (!waitingOn[l.child_id]) waitingOn[l.child_id] = [];
      waitingOn[l.child_id].push(l.parent_id);
    }
  });
  const statusMap = {};
  STATUS_ORDER.forEach(s => { statusMap[s] = []; });
  tasks.forEach(t => {
    const s = t.status || 'todo';
    if (statusMap[s]) statusMap[s].push(t);
  });
  const nonEmpty = STATUS_ORDER.filter(s => statusMap[s].length > 0);
  const totalCols = Math.max(nonEmpty.length, 3);
  let colsHtml = '';
  STATUS_ORDER.forEach(status => {
    const meta = STATUS_META[status] || {};
    const colTasks = statusMap[status] || [];
    const isNonEmpty = colTasks.length > 0;
    // Count tasks waiting on deps in this column
    const colWaiting = colTasks.filter(t => waitingOn[t.id]?.length).length;
    let cardsHtml = '';
    colTasks.forEach(task => {
      const shortId = String(task.id).slice(-8);
      const pLabel = task.priority > 0
        ? `<span class="kb-prio kb-prio--${task.priority <= 1 ? 'critical' : task.priority <= 3 ? 'high' : 'low'}">P${task.priority}</span>`
        : '';
      const runningClass = task.status === 'running' ? ' kb-card--running' : '';
      const blockedClass = task.status === 'blocked' ? ' kb-card--blocked' : '';
      // Waiting-on badge
      const deps = waitingOn[task.id] || [];
      const waitBadge = deps.length
        ? `<span class="kb-wait-badge" title="Waiting on: ${deps.map(id => '#'+String(id).slice(-8)).join(', ')}">⏳ ${deps.length}</span>`
        : '';
      cardsHtml += `
        <div class="kb-card ${meta.cls}${runningClass}${blockedClass}"
             data-task-id="${esc(String(task.id))}"
             data-task-status="${esc(task.status || '')}"
             data-assignee="${esc(task.assignee || '')}"
             onclick="window.showKanbanTask('${esc(String(task.id))}')"
             onmouseenter="window.showArrowsForTask('${esc(String(task.id))}')"
             onmouseleave="window.hideAllArrows()">
          <div class="kb-card-top">
            <span class="kb-card-id">#${esc(shortId)}</span>
            ${waitBadge}
            <span class="kb-card-assignee">${esc(task.assignee || '')}</span>
          </div>
          <div class="kb-card-title">${esc(trunc(task.title, 36))}</div>
          <div class="kb-card-footer">
            ${pLabel}
            <span class="kb-card-ts">${relTime(task.created_at)}</span>
          </div>
        </div>`;
    });
    colsHtml += `
      <div class="swm-col ${isNonEmpty ? '' : 'swm-col--empty'}">
        <div class="swm-col-header ${meta.cls}">
          <span>${meta.emoji || '📋'} ${meta.label || status}</span>
          <span class="swm-col-count">${colTasks.length}${colWaiting ? `<span class="kb-wait-count"> ⏳${colWaiting}</span>` : ''}</span>
        </div>
        <div class="swm-col-cards">
          ${cardsHtml || '<div class="swm-col-empty-msg">—</div>'}
        </div>
      </div>`;
  });
  const done = statusMap.done?.length || 0;
  const running = statusMap.running?.length || 0;
  const blocked = statusMap.blocked?.length || 0;
  const review = statusMap.review?.length || 0;
  return `
    <div class="swm-panel swm-panel--kanban" id="swm-kanban-panel">
      <div class="swm-panel-header">
        <span>📋 ${esc(currentBoard)}</span>
        <span class="swm-panel-stats" style="display:flex;align-items:center;gap:8px;">
          <button class="btn btn-ghost btn-sm" onclick="window.showBoardSummary()" title="Board summary &amp; recommendations" style="font-size:0.7rem;padding:2px 8px;">📊 Summary</button>
          ${running ? `<span class="kb--amber">🔄 ${running} active</span>` : ''}
          ${blocked ? `<span class="kb--red">⚠️ ${blocked} blocked</span>` : ''}
          ${review ? `<span class="kb--pink">👁️ ${review} review</span>` : ''}
          <span class="kb--green">✅ ${done} done</span>
        </span>
      </div>
      <div class="swm-kanban-cols" style="--cols:${totalCols}">
        ${colsHtml}
      </div>
    </div>`;
}
// ── Dependency Arrows (SVG) ────────────────────────────────────────────────
// Arrows are hidden by default (CSS opacity:0), shown on card hover
let currentHoveredTask = null;
function drawDependencyArrows() {
  const panel = document.querySelector('.swm-panel--kanban');
  if (!panel) return;
  // Remove old arrows
  const old = panel.querySelector('.swm-arrows');
  if (old) old.remove();
  const links = kanbanData?.links || [];
  if (!links.length) return;
  const cards = panel.querySelectorAll('.kb-card');
  if (!cards.length) return;
  // Build position map: { taskId -> { x, y, right, left } }
  const panelRect = panel.getBoundingClientRect();
  const pos = {};
  cards.forEach(c => {
    const id = c.dataset.taskId;
    if (!id) return;
    const r = c.getBoundingClientRect();
    pos[id] = {
      x: r.left - panelRect.left + r.width / 2,
      y: r.top - panelRect.top + r.height / 2,
      l: r.left - panelRect.left,
      r: r.right - panelRect.left,
      w: r.width,
      h: r.height,
    };
  });
  const valid = links.filter(l => pos[l.parent_id] && pos[l.child_id]);
  if (!valid.length) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('swm-arrows');
  svg.setAttribute('viewBox', `0 0 ${panel.offsetWidth} ${panel.offsetHeight}`);
  svg.setAttribute('width', panel.offsetWidth);
  svg.setAttribute('height', panel.offsetHeight);
  // Group per-link for hover targeting
  valid.forEach(link => {
    const p = pos[link.parent_id];
    const c = pos[link.child_id];
    const sameCol = Math.abs(p.x - c.x) < 80;
    // Wrap path + arrowhead in a group with data attrs
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('data-link-parent', String(link.parent_id));
    g.setAttribute('data-link-child', String(link.child_id));
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    if (sameCol) {
      // Tree connector: vertical line on left side of column
      const lx = Math.min(p.l, c.l) - 18;
      // Gentle S-curve instead of straight line
      const midY = (p.y + c.y) / 2;
      path.setAttribute('d', `M ${lx} ${p.y} C ${lx} ${p.y + 20}, ${lx} ${c.y - 20}, ${lx} ${c.y}`);
    } else {
      // Cross-column: elegant S-curve (half-circle feel)
      const dir = p.x < c.x ? 1 : -1;
      const sx = dir === 1 ? p.r : p.l;
      const ex = dir === 1 ? c.l : c.r;
      const dx = Math.abs(ex - sx);
      const cpOffset = Math.max(dx * 0.45, 40); // 45% of distance = nice curve
      path.setAttribute('d', `M ${sx} ${p.y} C ${sx + dir * cpOffset} ${p.y}, ${ex - dir * cpOffset} ${c.y}, ${ex} ${c.y}`);
    }
    path.setAttribute('stroke', 'var(--accent)');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-dasharray', '5 4');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(g);
    g.appendChild(path);
    // Arrowhead
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    if (sameCol) {
      const lx = Math.min(p.l, c.l) - 18;
      poly.setAttribute('points', `${lx},${c.y} ${lx - 5},${c.y - 8} ${lx + 5},${c.y - 8}`);
    } else {
      const dir = p.x < c.x ? 1 : -1;
      const ex = dir === 1 ? c.l : c.r;
      poly.setAttribute('points', `${ex},${c.y} ${ex - dir * 9},${c.y - 5} ${ex - dir * 9},${c.y + 5}`);
    }
    poly.setAttribute('fill', 'var(--accent)');
    g.appendChild(poly);
  });
  panel.appendChild(svg);
}
// Called from card hover
function showArrowsForTask(taskId) {
  currentHoveredTask = taskId;
  const svg = document.querySelector('.swm-arrows');
  if (!svg) return;
  const groups = svg.querySelectorAll('g');
  groups.forEach(g => {
    const p = g.dataset.linkParent;
    const c = g.dataset.linkChild;
    if (p === taskId || c === taskId) {
      g.classList.add('hl');
    } else {
      g.classList.remove('hl');
    }
  });
}
function hideAllArrows() {
  currentHoveredTask = null;
  const svg = document.querySelector('.swm-arrows');
  if (!svg) return;
  svg.querySelectorAll('g.hl').forEach(g => g.classList.remove('hl'));
}
// ── Event Panel (Right) ────────────────────────────────────────────────────
let eventFilterAgent = 'all';
let eventFilterSearch = '';
function renderEventPanel() {
  // Collect unique agents for filter dropdown
  const allEvents = eventsData.slice(0, 50);
  const agentSet = new Set();
  allEvents.forEach(e => { if (e.agent) agentSet.add(e.agent); });
  const agentList = ['all', ...Array.from(agentSet).sort()];

  // Apply filters
  const filtered = allEvents.filter(e => {
    if (eventFilterAgent !== 'all' && e.agent !== eventFilterAgent) return false;
    if (eventFilterSearch) {
      const q = eventFilterSearch.toLowerCase();
      const haystack = `${e.agent || ''} ${e.action || ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  if (!allEvents.length) {
    return `<div class="swm-panel swm-panel--events" id="swm-event-panel"><div class="swm-panel-header">📡 Live Feed</div><div class="swm-empty">No events yet</div></div>`;
  }

  let items = '';
  filtered.forEach(e => {
    const timeShort = (e.timestamp || '').split(' ').pop() || e.timestamp || '';
    const emoji = e.emoji || '•';
    items += `
      <div class="swm-event" title="${esc(e.agent)} — ${esc(e.action)}">
        <div class="swm-event-row1">
          <span class="swm-event-time">${esc(timeShort)}</span>
          <span class="swm-event-agent">${esc(e.agent)}</span>
        </div>
        <div class="swm-event-row2">
          <span class="swm-event-emoji">${emoji}</span>
          <span class="swm-event-action">${esc(e.action)}</span>
        </div>
      </div>`;
  });

  const filterBar = `
    <div class="swm-event-filters">
      <select class="swm-filter-select" id="event-filter-agent" onchange="setEventFilter('agent', this.value)">
        ${agentList.map(a => `<option value="${esc(a)}" ${eventFilterAgent === a ? 'selected' : ''}>${a === 'all' ? '👥 All' : esc(a)}</option>`).join('')}
      </select>
      <input class="swm-filter-input" id="event-filter-search" type="text" placeholder="Filter…"
             value="${esc(eventFilterSearch)}"
             oninput="setEventFilter('search', this.value)">
      ${eventFilterAgent !== 'all' || eventFilterSearch ? `<span class="swm-filter-badge">${filtered.length}/${allEvents.length}</span>` : ''}
    </div>`;

  return `
    <div class="swm-panel swm-panel--events" id="swm-event-panel">
      <div class="swm-panel-header"><span>📡 Live Feed</span></div>
      ${filterBar}
      <div class="swm-event-list">${items || '<div class="swm-empty">No matches</div>'}</div>
    </div>`;
}
// Event filter setter
window.setEventFilter = function(type, value) {
  if (type === 'agent') eventFilterAgent = value;
  if (type === 'search') eventFilterSearch = value;
  patchEventPanel();
};
// ── Card Detail Popup ──────────────────────────────────────────────────────
// Helper: render a single run item with expandable detail
function renderRunItem(r, totalRuns) {
  const statusIcon = r.status === 'done' ? '✅' : r.status === 'running' ? '🔄' : r.status === 'blocked' ? '⚠️' : r.status === 'failed' ? '❌' : '⏳';
  let meta = null;
  try { if (r.metadata) meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata; } catch(_){}
  const hasMeta = meta && Object.keys(meta).length > 0;
  const hasArtifacts = meta?.artifacts && meta.artifacts.length > 0;
  const runId = `run-${r.id}`;
  return `
    <div class="kb-run-item kb-run--${r.status}" id="${runId}">
      <div class="kb-run-header" onclick="toggleRunExpand('${runId}')">
        <span class="kb-run-expand">▶</span>
        <span class="kb-run-status">${statusIcon} ${r.status}</span>
        <span class="kb-run-outcome">${esc(r.outcome || '')}</span>
        <span class="kb-run-time">${fmtDate(r.started_at)}</span>
      </div>
      ${r.summary ? `<div class="kb-run-summary">${esc(r.summary)}</div>` : ''}
      <div class="kb-run-expanded" id="${runId}-detail" style="display:none">
        ${r.error ? `<div class="kb-run-error">❌ ${esc(r.error)}</div>` : ''}
        ${hasMeta ? `<div class="kb-run-meta">
          <div class="kb-run-meta-title">📊 Run Metadata</div>
          ${Object.entries(meta).filter(([k]) => k !== 'artifacts').map(([k,v]) => `
            <div class="kb-run-meta-row"><span class="kb-run-meta-key">${esc(k)}</span><span class="kb-run-meta-val">${esc(typeof v === 'string' ? v : JSON.stringify(v))}</span></div>
          `).join('')}
        </div>` : ''}
        ${hasArtifacts ? `<div class="kb-run-artifacts">
          <div class="kb-run-meta-title">📁 Workspace Files (${meta.artifacts.length})</div>
          ${meta.artifacts.map(a => `
            <div class="kb-artifact-item" onclick="loadWorkspaceFile('${esc(String(a))}', this)" title="${esc(String(a))}">
              📄 ${esc(String(a).split('/').pop())}
              <span class="kb-artifact-path">${esc(String(a))}</span>
            </div>
          `).join('')}
        </div>` : ''}
      </div>
    </div>`;
}
// Helper: render a single event item with payload data
function renderEventItem(e) {
  let payload = null;
  try { if (e.payload) payload = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload; } catch(_){}
  let detailHtml = '';
  if (payload) {
    if (e.kind === 'created' && payload.assignee) {
      detailHtml = `→ assignee: ${esc(payload.assignee)}, status: ${esc(payload.status || '')}`;
    } else if (e.kind === 'claimed' && payload.lock) {
      detailHtml = `→ lock: ${esc(payload.lock)}, run: #${payload.run_id || '?'}`;
    } else if (e.kind === 'spawned' && payload.pid) {
      detailHtml = `→ pid: ${payload.pid}`;
    } else if (e.kind === 'completed' || e.kind === 'done') {
      detailHtml = `→ finished`;
    } else if (e.kind === 'heartbeat') {
      detailHtml = ``; // skip heartbeat noise
    } else {
      const keys = Object.keys(payload).slice(0, 3);
      detailHtml = keys.length ? `→ ${keys.map(k => `${esc(k)}: ${esc(String(payload[k]).slice(0,40))}`).join(', ')}` : '';
    }
  }
  return `
    <div class="kb-event-item">
      <span class="kb-event-kind">${esc(e.kind)}</span>
      ${detailHtml ? `<span class="kb-event-detail">${detailHtml}</span>` : ''}
      <span class="kb-event-time">${fmtDate(e.created_at)}</span>
    </div>`;
}
// Toggle run detail expansion
window.toggleRunExpand = function(runId) {
  const expand = document.getElementById(`${runId}-detail`);
  const header = document.querySelector(`#${runId} .kb-run-expand`);
  if (!expand) return;
  const isHidden = expand.style.display === 'none';
  expand.style.display = isHidden ? 'block' : 'none';
  if (header) header.textContent = isHidden ? '▼' : '▶';
};
// Load workspace file content
window.loadWorkspaceFile = async function(filePath, el) {
  const popup = document.getElementById('kanban-detail-popup');
  const taskId = popup?.dataset?.taskId || '';
  if (!taskId) return;
  // Show loading
  const orig = el.innerHTML;
  el.innerHTML = '<span class="swm-loading">⟳ Loading...</span>';
  el.classList.add('kb-artifact--loading');
  try {
    const res = await fetch(`/api/office/kanban/${encodeURIComponent(taskId)}/workspace-file?board=${currentBoard}&path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (!data?.ok) throw new Error(data?.error || 'Failed');
    // Show file content in a code block
    const codeBlock = document.createElement('div');
    codeBlock.className = 'kb-artifact-content';
    codeBlock.innerHTML = `<div class="kb-artifact-header">📄 ${esc(data.filename)} (${Math.round(data.size/1024)}KB) <button class="kb-artifact-close" onclick="this.parentElement.parentElement.remove()">✕</button></div><pre><code>${esc(data.content.slice(0, 8000))}${data.content.length > 8000 ? '\n...truncated at 8KB' : ''}</code></pre>`;
    el.parentElement.appendChild(codeBlock);
    el.innerHTML = orig;
    el.classList.remove('kb-artifact--loading');
  } catch(e) {
    el.innerHTML = orig;
    el.classList.remove('kb-artifact--loading');
    el.classList.add('kb-artifact--error');
    el.title = e.message;
  }
};
// Load more items (runs, comments, events)
window.loadMoreItems = function(type) {
  const hiddenId = type === 'runs' ? 'kb-hidden-runs' : `kb-hidden-${type}`;
  const hidden = document.getElementById(hiddenId);
  const listId = type === 'runs' ? 'kb-run-list' : `kb-${type}-list`;
  const list = document.getElementById(listId);
  const btn = document.querySelector(`#kb-section-${type} .kb-showall-btn`);
  if (hidden && list) {
    hidden.style.display = 'block';
    // Move children from hidden to list
    while (hidden.firstChild) {
      list.appendChild(hidden.firstChild);
    }
    if (btn) btn.style.display = 'none';
  }
};
window.showKanbanTask = async function(taskId) {
  const existing = document.getElementById('kanban-detail-popup');
  if (existing) existing.remove();
  // Show loading popup first
  const popup = document.createElement('div');
  popup.id = 'kanban-detail-popup';
  popup.className = 'kb-detail-popup';
  popup.dataset.taskId = taskId;
  popup.innerHTML = `<div class="kb-detail-header"><span class="kb-detail-id">Loading...</span></div><div class="swm-loading">⟳ Fetching details...</div>`;
  document.body.appendChild(popup);
  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!popup.contains(e.target)) {
        popup.remove();
        document.removeEventListener('click', handler);
      }
    }, { once: false });
  }, 0);
  try {
    const res = await fetch(`/api/office/kanban/${encodeURIComponent(taskId)}?board=${currentBoard}`);
    const data = await res.json();
    if (!data?.ok) { popup.innerHTML = `<div class="kb-detail-header kb--red">Error</div><div class="kb-detail-body">${esc(data?.error || 'Unknown error')}</div>`; return; }
    const task = data.task;
    const meta = STATUS_META[task.status] || {};
    const shortId = String(task.id).slice(-8);
    const created = fmtDate(task.created_at);
    const started = fmtDate(task.started_at);
    const completed = fmtDate(task.completed_at);
    // Run history — expandable, click to see full metadata + artifacts
    const allRuns = data.runs || [];
    const showRuns = allRuns.slice(0, 5);
    const hasMoreRuns = allRuns.length > 5;
    const runsHtml = allRuns.length ? `
      <div class="kb-detail-section" id="kb-section-runs">
        <div class="kb-detail-label">
          ⚡ Run History (${allRuns.length})
          ${hasMoreRuns ? `<button class="kb-showall-btn" onclick="loadMoreItems('runs')">Show all ${allRuns.length} ↑</button>` : ''}
        </div>
        <div class="kb-run-list" id="kb-run-list">
          ${showRuns.map(r => renderRunItem(r, allRuns.length)).join('')}
        </div>
        ${hasMoreRuns ? `<div class="kb-hidden-runs" id="kb-hidden-runs" style="display:none">${allRuns.slice(5).map(r => renderRunItem(r, allRuns.length)).join('')}</div>` : ''}
      </div>
    ` : '';

    // Comments — with show all
    const allComments = data.comments || [];
    const showComments = allComments.slice(0, 5);
    const hasMoreComments = allComments.length > 5;
    const commentsHtml = allComments.length ? `
      <div class="kb-detail-section" id="kb-section-comments">
        <div class="kb-detail-label">
          💬 Comments (${allComments.length})
          ${hasMoreComments ? `<button class="kb-showall-btn" onclick="loadMoreItems('comments')">Show all ${allComments.length} ↑</button>` : ''}
        </div>
        <div class="kb-comment-list" id="kb-comment-list">
          ${showComments.map(c => `
            <div class="kb-comment">
              <span class="kb-comment-author">${esc(c.author)}</span>
              <span class="kb-comment-time">${fmtDate(c.created_at)}</span>
              <div class="kb-comment-body">${esc(c.body)}</div>
            </div>
          `).join('')}
        </div>
        ${hasMoreComments ? `<div class="kb-hidden-items" id="kb-hidden-comments" style="display:none">${allComments.slice(5).map(c => `
            <div class="kb-comment">
              <span class="kb-comment-author">${esc(c.author)}</span>
              <span class="kb-comment-time">${fmtDate(c.created_at)}</span>
              <div class="kb-comment-body">${esc(c.body)}</div>
            </div>
          `).join('')}</div>` : ''}
      </div>
    ` : '';

    // Events — with payload enrichment + show all
    const allEvents = data.events || [];
    const showEvents = allEvents.slice(0, 10);
    const hasMoreEvents = allEvents.length > 10;
    const eventsHtml = allEvents.length ? `
      <div class="kb-detail-section" id="kb-section-events">
        <div class="kb-detail-label">
          📋 Events (${allEvents.length})
          ${hasMoreEvents ? `<button class="kb-showall-btn" onclick="loadMoreItems('events')">Show all ${allEvents.length} ↑</button>` : ''}
        </div>
        <div class="kb-event-list" id="kb-event-list">
          ${showEvents.map(e => renderEventItem(e)).join('')}
        </div>
        ${hasMoreEvents ? `<div class="kb-hidden-items" id="kb-hidden-events" style="display:none">${allEvents.slice(10).map(e => renderEventItem(e)).join('')}</div>` : ''}
      </div>
    ` : '';
    // Attachments
    const attachHtml = (data.attachments || []).length ? `
      <div class="kb-detail-section">
        <div class="kb-detail-label">📎 Attachments (${data.attachments.length})</div>
        ${data.attachments.map(a => `<div class="kb-attach">📄 ${esc(a.filename)} (${Math.round(a.size/1024)}KB)</div>`).join('')}
      </div>
    ` : '';
    // Dependencies
    const parentIds = (data.links || []).filter(l => l.child_id === task.id).map(l => l.parent_id);
    const childIds = (data.links || []).filter(l => l.parent_id === task.id).map(l => l.child_id);
    const depsHtml = (parentIds.length || childIds.length) ? `
      <div class="kb-detail-section">
        <div class="kb-detail-label">🔗 Dependencies</div>
        ${parentIds.length ? `<div class="kb-deps"><span class="kb-deps-label">↑ Parents:</span> ${parentIds.map(id => `<span class="kb-dep-chip">#${esc(String(id).slice(-8))}</span>`).join(' ')}</div>` : ''}
        ${childIds.length ? `<div class="kb-deps"><span class="kb-deps-label">↓ Children:</span> ${childIds.map(id => `<span class="kb-dep-chip">#${esc(String(id).slice(-8))}</span>`).join(' ')}</div>` : ''}
      </div>
    ` : '';
    // ── Build Full Timeline (merged runs + comments + events) ────────────
    const timelineItems = [];
    // Lifecycle markers
    if (created)   timelineItems.push({ ts: task.created_at,   icon: '📅', kind: 'Created',       detail: created, author: '' });
    if (started)   timelineItems.push({ ts: task.started_at,   icon: '🚀', kind: 'Started',       detail: started, author: '' });
    if (completed) timelineItems.push({ ts: task.completed_at, icon: '✅', kind: 'Completed',     detail: completed, author: '' });
    // Runs
    (data.runs || []).forEach(r => {
      const icon = r.status === 'done' ? '✅' : r.status === 'running' ? '🔄' : r.status === 'blocked' ? '⚠️' : r.status === 'failed' ? '❌' : '⏳';
      timelineItems.push({ ts: r.started_at || r.created_at, icon, kind: `Run: ${r.status}`, detail: r.outcome || r.summary || '', author: '' });
    });
    // Comments
    (data.comments || []).forEach(c => {
      timelineItems.push({ ts: c.created_at, icon: '💬', kind: 'Comment', detail: c.body || '', author: c.author || '' });
    });
    // Events
    (data.events || []).forEach(e => {
      timelineItems.push({ ts: e.created_at, icon: '📋', kind: e.kind || 'Event', detail: '', author: '' });
    });
    // Sort by timestamp ascending (oldest first)
    timelineItems.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const totalTimeline = timelineItems.length;
    const timelineHtmlFull = totalTimeline ? `
      <div class="kb-timeline-chrono">
        ${timelineItems.map(item => `
          <div class="kb-timeline-row">
            <span class="kb-timeline-dot">${item.icon}</span>
            <span class="kb-timeline-time">${fmtDate(item.ts)}</span>
            <span class="kb-timeline-kind">${esc(item.kind)}</span>
            ${item.author ? `<span class="kb-timeline-author">${esc(item.author)}</span>` : ''}
            ${item.detail ? `<div class="kb-timeline-detail">${esc(trunc(item.detail, 120))}</div>` : ''}
          </div>
        `).join('')}
      </div>
    ` : '<div class="swm-empty">No timeline events</div>';
    // ── Details Tab Content ──────────────────────────────────────────────
    const detailsContent = `
      <div class="kb-detail-meta">
        <div class="kb-detail-meta-item"><span>Assignee</span><span class="kb-detail-meta-val">${esc(task.assignee || 'unassigned')}</span></div>
        <div class="kb-detail-meta-item"><span>Created by</span><span class="kb-detail-meta-val">${esc(task.created_by || '—')}</span></div>
        <div class="kb-detail-meta-item"><span>Created</span><span class="kb-detail-meta-val">${created}</span></div>
      </div>
      ${task.body ? `<div class="kb-detail-body">${esc(task.body)}</div>` : ''}
      ${runsHtml}
      ${commentsHtml}
      ${eventsHtml}
      ${attachHtml}
      ${depsHtml}
    `;
    popup.innerHTML = `
      <div class="kb-detail-header ${meta.cls}">
        <span class="kb-detail-id">#${esc(shortId)}</span>
        <span class="kb-detail-status">${meta.emoji || '📋'} ${task.status}</span>
        ${task.priority > 0 ? `<span class="kb-prio kb-prio--${task.priority <= 1 ? 'critical' : task.priority <= 3 ? 'high' : 'low'}">P${task.priority}</span>` : ''}
      </div>
      <div class="kb-detail-title">${esc(task.title)}</div>
      <div class="kb-detail-tabs">
        <button class="kb-tab kb-tab--active" data-tab="details" onclick="switchPopupTab('details')">📋 Details</button>
        <button class="kb-tab" data-tab="timeline" onclick="switchPopupTab('timeline')">⏱ Timeline (${totalTimeline})</button>
      </div>
      <div class="kb-detail-tab-content" id="kb-tab-details">${detailsContent}</div>
      <div class="kb-detail-tab-content" id="kb-tab-timeline" style="display:none">${timelineHtmlFull}</div>
      <div class="kb-detail-actions">
        ${task.status === 'blocked' ? `<button class="btn btn-sm kb-action-btn kb-action--unblock" onclick="kanbanAction('${esc(task.id)}','unblock')">🔓 Unblock</button>` : ''}
        ${task.status === 'running' || task.status === 'in_progress' ? `<button class="btn btn-sm kb-action-btn kb-action--done" onclick="kanbanAction('${esc(task.id)}','done')">✅ Mark Done</button>` : ''}
        ${task.status === 'done' ? `<button class="btn btn-sm kb-action-btn kb-action--reopen" onclick="kanbanAction('${esc(task.id)}','reopen')">🔄 Reopen</button>` : ''}
        ${task.status === 'review' ? `<button class="btn btn-sm kb-action-btn kb-action--approve" onclick="kanbanAction('${esc(task.id)}','done')">✅ Approve</button>` : ''}
        ${['triage','todo','scheduled','ready'].includes(task.status) ? `<button class="btn btn-sm kb-action-btn kb-action--start" onclick="kanbanAction('${esc(task.id)}','start')">▶ Start</button>` : ''}
        ${task.status !== 'done' ? `
          <select class="kb-reassign-select" onchange="kanbanAction('${esc(task.id)}','reassign', this.value); this.value='';" style="display:inline-block;margin-left:4px;">
            <option value="">🔄 Reassign…</option>
            ${['default','david','cuan','soci','hermes'].filter(a => a !== task.assignee).map(a => `<option value="${a}">→ ${a}</option>`).join('')}
          </select>
        ` : ''}
        <button class="btn btn-ghost btn-sm" style="margin-left:auto;" onclick="document.getElementById('kanban-detail-popup')?.remove()">✕ Close</button>
      </div>
    `;
  } catch(e) {
    popup.innerHTML = `<div class="kb-detail-header kb--red">Error</div><div class="kb-detail-body">${esc(e.message)}</div>`;
  }
};
// ── Quick Actions on Kanban Tasks ──────────────────────────────────────────
async function kanbanAction(taskId, action, extra) {
  const popup = document.getElementById('kanban-detail-popup');
  const btn = popup?.querySelector(`button[onclick*="${action}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  try {
    const res = await fetch(`/api/office/kanban/${encodeURIComponent(taskId)}/action?board=${currentBoard}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.__csrfToken || '',
      },
      credentials: 'include',
      body: JSON.stringify({ action, assignee: extra || undefined }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Action failed');
    // Success — close popup and force immediate poll refresh
    popup?.remove();
    fetchDataAndPatch();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '❌ Failed'; }
    // Show error briefly in popup
    const errEl = popup?.querySelector('.kb-detail-error');
    if (errEl) errEl.textContent = e.message;
  }
}
// Make kanbanAction globally accessible for inline onclick handlers
window.kanbanAction = kanbanAction;
// Make arrow hover functions globally accessible for inline onmouseenter/onmouseleave
window.showArrowsForTask = showArrowsForTask;
window.hideAllArrows = hideAllArrows;
// Board summary modal
window.showBoardSummary = async function() {
  const existing = document.getElementById('board-summary-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'board-summary-modal';
  modal.className = 'kb-detail-popup';
  modal.style.maxWidth = '520px';
  modal.innerHTML = '<div class="kb-detail-header"><span>📊 Board Summary</span></div><div class="swm-loading">⟳ Analyzing board...</div>';
  document.body.appendChild(modal);
  // Outside click → close
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!modal.contains(e.target)) { modal.remove(); document.removeEventListener('click', handler); }
    }, { once: false });
  }, 0);
  try {
    const res = await fetch(`/api/office/summary?board=${currentBoard}`);
    const data = await res.json();
    if (!data?.ok) throw new Error(data?.error || 'Unknown error');
    const { overview, agents, alerts, recommendations } = data;
    // Overview stats
    const statsHtml = `
      <div class="sum-stats">
        <div class="sum-stat"><span class="sum-num">${overview.total}</span><span class="sum-label">Total</span></div>
        <div class="sum-stat sum-stat--amber"><span class="sum-num">${overview.running||0}</span><span class="sum-label">Active</span></div>
        <div class="sum-stat sum-stat--red"><span class="sum-num">${overview.blocked||0}</span><span class="sum-label">Blocked</span></div>
        <div class="sum-stat sum-stat--pink"><span class="sum-num">${overview.review||0}</span><span class="sum-label">Review</span></div>
        <div class="sum-stat sum-stat--green"><span class="sum-num">${overview.done||0}</span><span class="sum-label">Done</span></div>
      </div>`;
    // Agent workload
    const agentsHtml = agents.length ? `
      <div class="sum-section">
        <div class="sum-section-title">👥 Agent Workload</div>
        <div class="sum-agent-list">
          ${agents.map(a => `
            <div class="sum-agent-row">
              <span class="sum-agent-name">${esc(a.name)}</span>
              <span class="sum-agent-meta">
                ${a.running ? `<span class="kb--amber">🔄 ${a.running}</span>` : ''}
                ${a.blocked ? `<span class="kb--red">⚠️ ${a.blocked}</span>` : ''}
                <span class="kb--muted">${a.total} total</span>
              </span>
            </div>
          `).join('')}
        </div>
      </div>` : '';
    // Alerts
    const alertsHtml = alerts.length ? `
      <div class="sum-section">
        <div class="sum-section-title">⚠️ Alerts</div>
        ${alerts.map(a => `
          <div class="sum-alert sum-alert--${a.level}">
            <div class="sum-alert-title">${esc(a.title)}</div>
            ${(a.items||[]).slice(0,5).map(i => `<div class="sum-alert-item">• ${esc(i.title || '')}</div>`).join('')}
            ${(a.items||[]).length > 5 ? `<div class="sum-alert-item kb--muted">… and ${a.items.length-5} more</div>` : ''}
          </div>
        `).join('')}
      </div>` : '<div class="sum-section"><div class="sum-section-title">✅ No Alerts</div><div class="kb--muted">Board looks clean</div></div>';
    // Recommendations
    const recsHtml = `
      <div class="sum-section">
        <div class="sum-section-title">💡 Recommendations</div>
        ${recommendations.map(r => `<div class="sum-rec">${esc(r)}</div>`).join('')}
      </div>`;
    modal.innerHTML = `
      <div class="kb-detail-header kb--accent"><span>📊 Board Summary</span><button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="document.getElementById('board-summary-modal')?.remove()">✕</button></div>
      ${statsHtml}
      ${agentsHtml}
      ${alertsHtml}
      ${recsHtml}
    `;
  } catch(e) {
    modal.innerHTML = `<div class="kb-detail-header kb--red">Error</div><div class="kb-detail-body">${esc(e.message)}</div>`;
  }
};
// Popup tab switcher
window.switchPopupTab = function(tab) {
  const popup = document.getElementById('kanban-detail-popup');
  if (!popup) return;
  // Update tab buttons
  popup.querySelectorAll('.kb-tab').forEach(b => b.classList.toggle('kb-tab--active', b.dataset.tab === tab));
  // Show/hide content
  const details = document.getElementById('kb-tab-details');
  const timeline = document.getElementById('kb-tab-timeline');
  if (details) details.style.display = tab === 'details' ? '' : 'none';
  if (timeline) timeline.style.display = tab === 'timeline' ? '' : 'none';
};
// ── Helpers ────────────────────────────────────────────────────────────────
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function trunc(s, len) { return s && s.length > len ? s.slice(0, len) + '...' : s || ''; }
function relTime(ts) {
  if (!ts) return '';
  const delta = (Date.now() / 1000) - ts;
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ' ' + d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
}
