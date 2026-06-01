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
  // Only render layout skeleton on first call
  if (!rendered) {
    renderLayoutShell();
    rendered = true;
  }

  // Fire all 3 in parallel but update panels as each resolves
  // Kanban is fast (~0.2s), agent-states can be slow (3-30s), events moderate
  fetch(`/api/office/kanban?board=${currentBoard}`)
    .then(r => r.json())
    .then(res => {
      if (res?.ok) { kanbanData = res; patchKanbanPanel(); }
    })
    .catch(() => null);

  fetch('/api/office/agent-states')
    .then(r => r.json())
    .then(res => {
      if (res?.ok) { agentStates = res.agents || []; patchAgentPanel(); patchKanbanPanel(); }
    })
    .catch(() => null);

  fetch('/api/office/events')
    .then(r => r.json())
    .then(res => {
      if (res?.ok) { eventsData = res.events || []; patchEventPanel(); }
    })
    .catch(() => null);
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
  el.outerHTML = renderKanbanPanel(tasks);
  // Re-draw arrows
  const links = kanbanData?.links || [];
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
      ${renderKanbanPanel(tasks)}
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
function renderKanbanPanel(tasks) {
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

    let cardsHtml = '';
    colTasks.forEach(task => {
      const shortId = String(task.id).slice(-8);
      const pLabel = task.priority > 0
        ? `<span class="kb-prio kb-prio--${task.priority <= 1 ? 'critical' : task.priority <= 3 ? 'high' : 'low'}">P${task.priority}</span>`
        : '';
      const runningClass = task.status === 'running' ? ' kb-card--running' : '';
      const blockedClass = task.status === 'blocked' ? ' kb-card--blocked' : '';

      cardsHtml += `
        <div class="kb-card ${meta.cls}${runningClass}${blockedClass}"
             data-task-id="${esc(String(task.id))}"
             data-task-status="${esc(task.status || '')}"
             data-assignee="${esc(task.assignee || '')}"
             onclick="window.showKanbanTask('${esc(String(task.id))}')">
          <div class="kb-card-top">
            <span class="kb-card-id">#${esc(shortId)}</span>
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
          <span class="swm-col-count">${colTasks.length}</span>
        </div>
        <div class="swm-col-cards">
          ${cardsHtml || '<div class="swm-col-empty-msg">—</div>'}
        </div>
      </div>`;
  });

  const done = statusMap.done?.length || 0;
  const running = statusMap.running?.length || 0;
  const blocked = statusMap.blocked?.length || 0;

  return `
    <div class="swm-panel swm-panel--kanban" id="swm-kanban-panel">
      <div class="swm-panel-header">
        <span>📋 ${esc(currentBoard)}</span>
        <span class="swm-panel-stats">
          ${running ? `<span class="kb--amber">🔄 ${running} active</span>` : ''}
          ${blocked ? `<span class="kb--red">⚠️ ${blocked} blocked</span>` : ''}
          <span class="kb--green">✅ ${done} done</span>
        </span>
      </div>
      <div class="swm-kanban-cols" style="--cols:${totalCols}">
        ${colsHtml}
      </div>
    </div>`;
}

// ── Dependency Arrows (SVG) ────────────────────────────────────────────────
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
    };
  });

  const valid = links.filter(l => pos[l.parent_id] && pos[l.child_id]);
  if (!valid.length) return;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('swm-arrows');
  svg.setAttribute('viewBox', `0 0 ${panel.offsetWidth} ${panel.offsetHeight}`);

  valid.forEach(link => {
    const p = pos[link.parent_id];
    const c = pos[link.child_id];
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${p.r} ${p.y} C ${p.r + 28} ${p.y}, ${c.l - 28} ${c.y}, ${c.l} ${c.y}`);
    path.setAttribute('stroke', 'var(--accent)');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-dasharray', '4 4');
    path.setAttribute('fill', 'none');
    path.setAttribute('opacity', '0.35');
    svg.appendChild(path);

    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', `${c.l},${c.y} ${c.l - 8},${c.y - 4} ${c.l - 8},${c.y + 4}`);
    poly.setAttribute('fill', 'var(--accent)');
    poly.setAttribute('opacity', '0.35');
    svg.appendChild(poly);
  });

  panel.appendChild(svg);
}

// ── Event Panel (Right) ────────────────────────────────────────────────────
function renderEventPanel() {
  const events = eventsData.slice(0, 50);
  if (!events.length) {
    return `<div class="swm-panel swm-panel--events" id="swm-event-panel"><div class="swm-panel-header">📡 Live Feed</div><div class="swm-empty">No events yet</div></div>`;
  }

  let items = '';
  events.forEach(e => {
    items += `
      <div class="swm-event">
        <span class="swm-event-time">${esc(e.timestamp)}</span>
        <span class="swm-event-emoji">${e.emoji || '•'}</span>
        <span class="swm-event-agent">${esc(e.agent)}</span>
        <span class="swm-event-action">${esc(trunc(e.action, 30))}</span>
      </div>`;
  });

  return `
    <div class="swm-panel swm-panel--events" id="swm-event-panel">
      <div class="swm-panel-header">📡 Live Feed</div>
      <div class="swm-event-list">${items}</div>
    </div>`;
}

// ── Card Detail Popup ──────────────────────────────────────────────────────
window.showKanbanTask = async function(taskId) {
  const existing = document.getElementById('kanban-detail-popup');
  if (existing) existing.remove();

  // Show loading popup first
  const popup = document.createElement('div');
  popup.id = 'kanban-detail-popup';
  popup.className = 'kb-detail-popup';
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

    // Run history
    const runsHtml = (data.runs || []).length ? `
      <div class="kb-detail-section">
        <div class="kb-detail-label">⚡ Run History (${data.runs.length})</div>
        <div class="kb-run-list">
          ${data.runs.slice(0, 5).map(r => `
            <div class="kb-run-item kb-run--${r.status}">
              <span class="kb-run-status">${r.status === 'done' ? '✅' : r.status === 'running' ? '🔄' : r.status === 'blocked' ? '⚠️' : r.status === 'failed' ? '❌' : '⏳'} ${r.status}</span>
              <span class="kb-run-outcome">${r.outcome || ''}</span>
              <span class="kb-run-time">${fmtDate(r.started_at)}</span>
              ${r.summary ? `<div class="kb-run-summary">${esc(trunc(r.summary, 200))}</div>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    ` : '';

    // Comments
    const commentsHtml = (data.comments || []).length ? `
      <div class="kb-detail-section">
        <div class="kb-detail-label">💬 Comments (${data.comments.length})</div>
        <div class="kb-comment-list">
          ${data.comments.slice(0, 5).map(c => `
            <div class="kb-comment">
              <span class="kb-comment-author">${esc(c.author)}</span>
              <span class="kb-comment-time">${fmtDate(c.created_at)}</span>
              <div class="kb-comment-body">${esc(trunc(c.body, 150))}</div>
            </div>
          `).join('')}
        </div>
      </div>
    ` : '';

    // Events
    const eventsHtml = (data.events || []).length ? `
      <div class="kb-detail-section">
        <div class="kb-detail-label">📋 Events (${data.events.length})</div>
        <div class="kb-event-list">
          ${data.events.slice(0, 10).map(e => `
            <div class="kb-event-item">
              <span class="kb-event-kind">${esc(e.kind)}</span>
              <span class="kb-event-time">${fmtDate(e.created_at)}</span>
            </div>
          `).join('')}
        </div>
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

    // Timeline
    const timelineHtml = (created || started || completed) ? `
      <div class="kb-detail-section">
        <div class="kb-detail-label">⏱ Timeline</div>
        <div class="kb-timeline">
          ${created   ? `<div class="kb-timeline-item"><span class="kb-timeline-icon">📅</span><span>Created ${created}</span></div>` : ''}
          ${started   ? `<div class="kb-timeline-item"><span class="kb-timeline-icon">🚀</span><span>Started ${started}</span></div>` : ''}
          ${completed ? `<div class="kb-timeline-item"><span class="kb-timeline-icon">✅</span><span>Completed ${completed}</span></div>` : ''}
        </div>
      </div>
    ` : '';

    popup.innerHTML = `
      <div class="kb-detail-header ${meta.cls}">
        <span class="kb-detail-id">#${esc(shortId)}</span>
        <span class="kb-detail-status">${meta.emoji || '📋'} ${task.status}</span>
        ${task.priority > 0 ? `<span class="kb-prio kb-prio--${task.priority <= 1 ? 'critical' : task.priority <= 3 ? 'high' : 'low'}">P${task.priority}</span>` : ''}
      </div>
      <div class="kb-detail-title">${esc(task.title)}</div>
      <div class="kb-detail-meta">
        <div class="kb-detail-meta-item"><span>Assignee</span><span class="kb-detail-meta-val">${esc(task.assignee || 'unassigned')}</span></div>
        <div class="kb-detail-meta-item"><span>Created by</span><span class="kb-detail-meta-val">${esc(task.created_by || '—')}</span></div>
        <div class="kb-detail-meta-item"><span>Created</span><span class="kb-detail-meta-val">${created}</span></div>
      </div>
      ${task.body ? `<div class="kb-detail-body">${esc(task.body)}</div>` : ''}
      ${timelineHtml}
      ${runsHtml}
      ${commentsHtml}
      ${eventsHtml}
      ${attachHtml}
      ${depsHtml}
      <div class="kb-detail-actions">
        <!-- Quick actions based on status -->
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
