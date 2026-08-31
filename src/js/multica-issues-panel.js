// src/js/multica-issues-panel.js — Multica Issue Execution Telemetry panel
// (JOSD-42 / JOSH-42: Multica-to-Hermes execution-observability bridge).
//
// Multica remains canonical for issue ownership/status/comments/swarm
// structure. This panel is a read-only mirror of `/api/office/multica-issues`
// (server.js → lib/multica-telemetry.js → lib/multica-bridge.js), which in
// turn wraps the authenticated `multica` CLI's JSON contract. No secrets, no
// direct state.db access from here.

let pollTimer = null;
let containerId = null;
let fetchInFlight = false;
let lastSnapshot = null;

const STATE_META = {
  unassigned:     { emoji: '➖', label: 'Unassigned',      cls: 'mx--muted' },
  assigned_idle:  { emoji: '🧍', label: 'Assigned · Idle', cls: 'mx--blue'  },
  queued:         { emoji: '⏳', label: 'Queued',          cls: 'mx--blue'  },
  running:        { emoji: '🟢', label: 'Running',         cls: 'mx--green' },
  stale:          { emoji: '💤', label: 'Stale',           cls: 'mx--red'   },
  waiting_review: { emoji: '👁️', label: 'Waiting Review',  cls: 'mx--pink'  },
  blocked:        { emoji: '⚠️', label: 'Blocked',         cls: 'mx--red'   },
  succeeded:      { emoji: '✅', label: 'Succeeded',       cls: 'mx--green' },
  failed:         { emoji: '❌', label: 'Failed',          cls: 'mx--red'   },
  cancelled:      { emoji: '🚫', label: 'Cancelled',       cls: 'mx--muted' },
  unknown:        { emoji: '❓', label: 'Unknown',         cls: 'mx--red'   },
};

// Execution states shown in the active-worker view by default; done/cancelled
// issues only appear here briefly (see isActiveOrRecentIssue server-side),
// keeping completed history queryable separately without polluting this view.
const ACTIVE_ORDER = ['stale', 'running', 'queued', 'waiting_review', 'blocked', 'failed', 'assigned_idle', 'unassigned', 'unknown', 'succeeded', 'cancelled'];

function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function trunc(s, len) { return s && s.length > len ? s.slice(0, len) + '…' : (s || ''); }

function relTimeFromIso(iso) {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const deltaMs = Date.now() - ms;
  if (deltaMs < 0) return 'just now';
  const m = Math.floor(deltaMs / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export async function initMulticaPanel(contId) {
  containerId = contId;
  destroyMulticaPanel();
  renderShell();
  await fetchAndRender();
}

export function destroyMulticaPanel() {
  stopMulticaPoll();
  lastSnapshot = null;
}

export function startMulticaPoll(interval = 5000) {
  stopMulticaPoll();
  pollTimer = setInterval(fetchAndRender, interval);
}

export function stopMulticaPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function renderShell() {
  const root = document.getElementById(containerId);
  if (!root) return;
  root.innerHTML = `
    <div class="mx-panel" id="mx-panel">
      <div class="mx-panel-header">
        <span>🔗 Multica Issues — Execution Telemetry</span>
        <span id="mx-generated-at" class="mx-generated-at"></span>
      </div>
      <div id="mx-body" class="mx-loading">⟳ Loading Multica telemetry…</div>
    </div>`;
}

async function fetchAndRender() {
  if (fetchInFlight) return;
  fetchInFlight = true;
  try {
    const res = await fetch('/api/office/multica-issues');
    const data = await res.json();
    lastSnapshot = data;
    patchBody(data);
  } catch (e) {
    patchBody({ ok: false, error: e.message, issues: [], warnings: [] });
  } finally {
    fetchInFlight = false;
  }
}

function patchBody(data) {
  const body = document.getElementById('mx-body');
  const genAt = document.getElementById('mx-generated-at');
  if (!body) return;

  if (genAt) genAt.textContent = data.generatedAt ? `updated ${relTimeFromIso(data.generatedAt)}` : '';

  if (!data.ok) {
    // Fail visibly — never render a stale/empty table as if it were healthy.
    body.innerHTML = `
      <div class="mx-error">
        <div class="mx-error-title">⚠️ Multica telemetry unavailable</div>
        <div class="mx-error-detail">${esc(data.error || 'unknown error')}</div>
      </div>`;
    return;
  }

  const issues = Array.isArray(data.issues) ? data.issues : [];
  const warnings = Array.isArray(data.warnings) ? data.warnings.filter(Boolean) : [];

  const sorted = [...issues].sort((a, b) => {
    const ai = ACTIVE_ORDER.indexOf(a.executionState);
    const bi = ACTIVE_ORDER.indexOf(b.executionState);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const warnBanner = warnings.length
    ? `<div class="mx-warnings">⚠️ ${warnings.map((w) => esc(w)).join(' · ')}</div>`
    : '';

  if (!sorted.length) {
    body.innerHTML = `${warnBanner}<div class="mx-empty">No active or recently active Multica issues.</div>`;
    return;
  }

  body.innerHTML = `${warnBanner}<div class="mx-table-wrap">${renderTable(sorted)}</div>`;
}

function renderTable(records) {
  const rows = records.map(renderRow).join('');
  return `
    <table class="mx-table">
      <thead>
        <tr>
          <th>Issue</th>
          <th>Status</th>
          <th>Execution</th>
          <th>Run</th>
          <th>Agent / Runtime</th>
          <th>Last Activity</th>
          <th>Swarm</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderRow(rec) {
  const meta = STATE_META[rec.executionState] || STATE_META.unknown;
  const run = rec.run;
  const swarm = rec.swarm || { totalChildren: 0, isSwarm: false, hasActiveChildren: false, byStatus: {} };

  const swarmBadge = swarm.isSwarm
    ? `<span class="mx-swarm-badge ${swarm.hasActiveChildren ? 'mx--amber' : 'mx--muted'}" title="${esc(Object.entries(swarm.byStatus).map(([s, n]) => `${s}: ${n}`).join(', '))}">
         🐝 ${swarm.totalChildren}${swarm.hasActiveChildren ? ' active' : ''}
       </span>`
    : '<span class="mx-swarm-none">—</span>';

  const runCell = run
    ? `<span class="mx-run-id" title="${esc(run.id)}">#${esc(String(run.id).slice(-8))}</span> <span class="mx-run-status">${esc(run.status)}</span>`
    : '<span class="mx-run-none">—</span>';

  const agentCell = run && (run.agentName || run.runtimeName)
    ? `${esc(run.agentName || '—')}<div class="mx-runtime-name">${esc(run.runtimeName || '')}</div>`
    : '<span class="mx-run-none">—</span>';

  const errCell = rec.telemetryError
    ? `<div class="mx-telemetry-error" title="${esc(rec.telemetryError)}">⚠️ telemetry gap</div>`
    : '';

  return `
    <tr class="mx-row ${meta.cls}${rec.isStale ? ' mx-row--stale' : ''}" data-issue-id="${esc(rec.issueId || '')}">
      <td class="mx-issue-cell">
        <div class="mx-issue-id">${esc(rec.identifier || '—')}</div>
        <div class="mx-issue-title" title="${esc(rec.title || '')}">${esc(trunc(rec.title || '', 46))}</div>
        ${errCell}
      </td>
      <td><span class="mx-issue-status">${esc(rec.issueStatus || '—')}</span></td>
      <td><span class="mx-state-badge ${meta.cls}">${meta.emoji} ${meta.label}</span></td>
      <td>${runCell}</td>
      <td>${agentCell}</td>
      <td>${esc(relTimeFromIso(rec.lastActivityAt))}</td>
      <td>${swarmBadge}</td>
      <td>${rec.deepLink ? `<a class="mx-link" href="${esc(rec.deepLink)}" target="_blank" rel="noopener">Open ↗</a>` : ''}</td>
    </tr>`;
}
