// lib/multica-bridge.js — pure normalization for Multica execution telemetry.
//
// No I/O here. Every function takes plain data (as already fetched via
// lib/multica-cli.js) and returns plain data. This is what keeps state
// mapping, stale detection, and swarm aggregation independently unit
// testable without spawning the CLI or touching the network — see
// test/multica-bridge.test.js.
//
// ── Execution states (the model required by JOSH-42) ────────────────────────
//   UNASSIGNED     — no member/agent/squad owns the issue yet.
//   ASSIGNED_IDLE  — an agent/squad owns it, but no run is currently active.
//   QUEUED         — a run was dispatched but has not started executing yet.
//   RUNNING        — a run is actively executing and its heartbeat is fresh.
//   STALE          — a run claims to be running but its last activity is
//                    older than the stale threshold. Never reported as RUNNING.
//   WAITING_REVIEW — issue status is in_review and no run is currently active.
//   BLOCKED        — issue status is blocked and no run is currently active.
//   SUCCEEDED      — issue status is done (Multica issue status is canonical).
//   FAILED         — issue is open, no active run, and the most recent run failed.
//   CANCELLED      — issue status is cancelled, or the most recent run was
//                    cancelled and the issue is still open.
//   UNKNOWN        — telemetry could not be read (CLI/API error). Must never
//                    be presented as healthy.
'use strict';

const EXECUTION_STATES = Object.freeze({
  UNASSIGNED: 'unassigned',
  ASSIGNED_IDLE: 'assigned_idle',
  QUEUED: 'queued',
  RUNNING: 'running',
  STALE: 'stale',
  WAITING_REVIEW: 'waiting_review',
  BLOCKED: 'blocked',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown',
});

const DEFAULT_STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes with no heartbeat

function toEpochMs(value) {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/** Normalize one raw `issue runs` record into a compact, display-ready shape. */
function normalizeRun(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: String(raw.id || ''),
    status: String(raw.status || 'unknown'),
    agentId: raw.agent_id || null,
    runtimeId: raw.runtime_id || null,
    createdAt: raw.created_at || null,
    dispatchedAt: raw.dispatched_at || null,
    startedAt: raw.started_at || null,
    completedAt: raw.completed_at || null,
    error: raw.error || null,
    triggerSummary: raw.trigger_summary || null,
    attempt: Number(raw.attempt || 1),
  };
}

/** Runs are not guaranteed to be sorted; sort newest-created-first, defensively. */
function sortRunsDesc(runs) {
  return [...runs].sort((a, b) => toEpochMs(b.createdAt) - toEpochMs(a.createdAt));
}

/** The run currently executing, if any — a `status: 'running'` record. */
function pickActiveRun(normalizedRuns) {
  const running = normalizedRuns.filter((r) => r.status === 'running');
  if (!running.length) return null;
  return sortRunsDesc(running)[0];
}

/** Most recent run that has reached a terminal state (completed/failed/cancelled). */
function pickLastTerminalRun(normalizedRuns) {
  const terminal = normalizedRuns.filter((r) => r.status !== 'running');
  if (!terminal.length) return null;
  return sortRunsDesc(terminal)[0];
}

/**
 * A run counts as merely QUEUED (dispatched, not yet executing) when it has
 * no `startedAt` timestamp yet. Once `startedAt` is set, it is RUNNING
 * (subject to the stale check below).
 */
function isQueued(activeRun) {
  return !!activeRun && !activeRun.startedAt;
}

/**
 * A running task is STALE when nothing has moved — no issue activity — for
 * longer than `staleThresholdMs`. `lastActivityAt` should be the owning
 * issue's `last_activity_at` (comments, run messages, and status changes all
 * bump it), used as the best available heartbeat proxy since Multica does
 * not expose a lower-level per-run heartbeat over the CLI contract.
 */
function isStale(activeRun, lastActivityAt, nowMs, staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS) {
  if (!activeRun || isQueued(activeRun)) return false;
  const lastBeat = Math.max(toEpochMs(lastActivityAt), toEpochMs(activeRun.startedAt));
  if (!lastBeat) return true; // no evidence of activity at all — treat as stale, not healthy
  return (nowMs - lastBeat) > staleThresholdMs;
}

/** Group an issue's children (already fetched via `issue children`) by run/status state. */
function summarizeSwarm(childrenPayload) {
  const stages = Array.isArray(childrenPayload?.stages) ? childrenPayload.stages : [];
  const unstaged = Array.isArray(childrenPayload?.unstaged) ? childrenPayload.unstaged : [];
  const allChildren = [
    ...stages.flatMap((s) => (Array.isArray(s.issues) ? s.issues : [])),
    ...unstaged,
  ];

  const byStatus = {};
  for (const child of allChildren) {
    const status = child.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
  }

  const activeStatuses = new Set(['in_progress', 'todo', 'in_review', 'blocked']);
  const hasActiveChildren = allChildren.some((c) => activeStatuses.has(c.status));

  return {
    totalChildren: allChildren.length,
    byStatus,
    hasActiveChildren,
    isSwarm: allChildren.length > 0,
  };
}

/** Resolve a human-readable agent name from the agents list, falling back to the raw id. */
function resolveAgentName(agentId, agentsById) {
  if (!agentId) return null;
  const agent = agentsById?.[agentId];
  return agent?.name || agentId;
}

/** Resolve a human-readable runtime name from the runtimes list, falling back to the raw id. */
function resolveRuntimeName(runtimeId, runtimesById) {
  if (!runtimeId) return null;
  const runtime = runtimesById?.[runtimeId];
  if (!runtime) return runtimeId;
  return runtime.custom_name || runtime.name || runtimeId;
}

/** Build the canonical deep link back to the issue in the Multica web app. */
function buildIssueDeepLink({ appUrl, workspaceSlug, identifier }) {
  if (!appUrl || !workspaceSlug || !identifier) return null;
  const base = String(appUrl).replace(/\/+$/, '');
  return `${base}/${workspaceSlug}/issues/${identifier}`;
}

/**
 * Classify the single execution state for one issue given its runs and
 * children summary. This is the state-mapping contract every caller
 * (API route, UI, tests) should go through — never re-derive state ad hoc.
 */
function classifyExecutionState({ issue, activeRun, lastTerminalRun, stale }) {
  const status = issue?.status;

  if (status === 'cancelled') return EXECUTION_STATES.CANCELLED;
  if (status === 'done') return EXECUTION_STATES.SUCCEEDED;

  if (activeRun) {
    if (stale) return EXECUTION_STATES.STALE;
    if (isQueued(activeRun)) return EXECUTION_STATES.QUEUED;
    return EXECUTION_STATES.RUNNING;
  }

  if (status === 'in_review') return EXECUTION_STATES.WAITING_REVIEW;
  if (status === 'blocked') return EXECUTION_STATES.BLOCKED;

  if (lastTerminalRun?.status === 'failed') return EXECUTION_STATES.FAILED;
  if (lastTerminalRun?.status === 'cancelled') return EXECUTION_STATES.CANCELLED;

  if (issue?.assignee_type) return EXECUTION_STATES.ASSIGNED_IDLE;

  return EXECUTION_STATES.UNASSIGNED;
}

/**
 * Combine one issue's raw CLI payloads (issue, runs, children) into the
 * display-ready execution record consumed by the API route and the UI.
 *
 * @param {object} params
 * @param {object} params.issue          raw `issue get`/`issue list` record
 * @param {object[]} params.rawRuns      raw `issue runs` array (may be empty)
 * @param {object} params.childrenPayload raw `issue children` payload
 * @param {object} params.agentsById     { [agentId]: agentRecord }
 * @param {object} params.runtimesById   { [runtimeId]: runtimeRecord }
 * @param {object} [params.linkConfig]   { appUrl, workspaceSlug }
 * @param {number} [params.nowMs]        injectable clock for tests
 * @param {number} [params.staleThresholdMs]
 */
function normalizeIssueExecution({
  issue,
  rawRuns = [],
  childrenPayload = null,
  agentsById = {},
  runtimesById = {},
  linkConfig = {},
  nowMs = Date.now(),
  staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS,
}) {
  const runs = (rawRuns || []).map(normalizeRun).filter(Boolean);
  const activeRun = pickActiveRun(runs);
  const lastTerminalRun = pickLastTerminalRun(runs);
  const stale = isStale(activeRun, issue?.last_activity_at, nowMs, staleThresholdMs);
  const executionState = classifyExecutionState({ issue, activeRun, lastTerminalRun, stale });
  const swarm = summarizeSwarm(childrenPayload);

  const displayRun = activeRun || lastTerminalRun;

  return {
    issueId: issue?.id || null,
    identifier: issue?.identifier || null,
    title: issue?.title || null,
    issueStatus: issue?.status || null,
    assigneeType: issue?.assignee_type || null,
    assigneeId: issue?.assignee_id || null,
    executionState,
    isStale: stale,
    run: displayRun
      ? {
          id: displayRun.id,
          status: displayRun.status,
          agentId: displayRun.agentId,
          agentName: resolveAgentName(displayRun.agentId, agentsById),
          runtimeId: displayRun.runtimeId,
          runtimeName: resolveRuntimeName(displayRun.runtimeId, runtimesById),
          startedAt: displayRun.startedAt,
          completedAt: displayRun.completedAt,
          createdAt: displayRun.createdAt,
          error: displayRun.error,
        }
      : null,
    lastActivityAt: issue?.last_activity_at || null,
    swarm,
    deepLink: buildIssueDeepLink({
      appUrl: linkConfig.appUrl,
      workspaceSlug: linkConfig.workspaceSlug,
      identifier: issue?.identifier,
    }),
    parentIssueId: issue?.parent_issue_id || null,
  };
}

/** Index an array of records (agents/runtimes) by `id` for O(1) lookups. */
function indexById(records) {
  const out = {};
  for (const r of records || []) {
    if (r && r.id) out[r.id] = r;
  }
  return out;
}

/**
 * Decide whether an issue is worth including in the "active worker" view at
 * all — anything not done/cancelled, or done/cancelled very recently, so the
 * board doesn't get polluted with the full historical backlog. This is the
 * "preserve history without polluting the active view" requirement.
 */
function isActiveOrRecentIssue(issue, nowMs = Date.now(), recentWindowMs = 15 * 60 * 1000) {
  if (!issue) return false;
  const terminal = issue.status === 'done' || issue.status === 'cancelled';
  if (!terminal) return true;
  const lastActivityMs = toEpochMs(issue.last_activity_at || issue.updated_at);
  return (nowMs - lastActivityMs) <= recentWindowMs;
}

module.exports = {
  EXECUTION_STATES,
  DEFAULT_STALE_THRESHOLD_MS,
  normalizeRun,
  sortRunsDesc,
  pickActiveRun,
  pickLastTerminalRun,
  isQueued,
  isStale,
  summarizeSwarm,
  resolveAgentName,
  resolveRuntimeName,
  buildIssueDeepLink,
  classifyExecutionState,
  normalizeIssueExecution,
  indexById,
  isActiveOrRecentIssue,
};
