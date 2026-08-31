const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXECUTION_STATES,
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
} = require('../lib/multica-bridge');

// ── normalizeRun ─────────────────────────────────────────────────────────────
test('normalizeRun returns null for non-objects', () => {
  assert.strictEqual(normalizeRun(null), null);
  assert.strictEqual(normalizeRun('abc'), null);
});

test('normalizeRun extracts basic fields with defaults', () => {
  const raw = { id: 'task-1', status: 'running' };
  const norm = normalizeRun(raw);
  assert.strictEqual(norm.id, 'task-1');
  assert.strictEqual(norm.status, 'running');
  assert.strictEqual(norm.attempt, 1);
});

test('normalizeRun parses timestamps', () => {
  const now = new Date().toISOString();
  const raw = { id: 't1', created_at: now, started_at: now, completed_at: now };
  const norm = normalizeRun(raw);
  assert.strictEqual(norm.createdAt, now);
  assert.strictEqual(norm.startedAt, now);
  assert.strictEqual(norm.completedAt, now);
});

// ── sortRunsDesc ─────────────────────────────────────────────────────────────
// sortRunsDesc/pickActiveRun/pickLastTerminalRun operate on *normalized* runs
// (camelCase createdAt), i.e. the output of normalizeRun — not raw CLI records.
test('sortRunsDesc sorts newest-created-first', () => {
  const r1 = { id: '1', createdAt: '2026-01-02T00:00:00Z' };
  const r2 = { id: '2', createdAt: '2026-01-01T00:00:00Z' };
  const r3 = { id: '3', createdAt: '2026-01-03T00:00:00Z' };
  const sorted = sortRunsDesc([r1, r2, r3]);
  assert.strictEqual(sorted[0].id, '3');
  assert.strictEqual(sorted[1].id, '1');
  assert.strictEqual(sorted[2].id, '2');
});

// ── pickActiveRun ────────────────────────────────────────────────────────────
test('pickActiveRun returns the newest running run', () => {
  const runs = [
    { id: 'r1', status: 'running', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'r2', status: 'completed', createdAt: '2026-01-02T00:00:00Z' },
    { id: 'r3', status: 'running', createdAt: '2026-01-03T00:00:00Z' },
  ];
  const active = pickActiveRun(runs);
  assert.strictEqual(active.id, 'r3');
});

test('pickActiveRun returns null when no running runs', () => {
  const runs = [
    { id: 'r1', status: 'completed', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'r2', status: 'failed', createdAt: '2026-01-02T00:00:00Z' },
  ];
  const active = pickActiveRun(runs);
  assert.strictEqual(active, null);
});

// ── pickLastTerminalRun ─────────────────────────────────────────────────────
test('pickLastTerminalRun returns the newest terminal run', () => {
  const runs = [
    { id: 'r1', status: 'completed', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'r2', status: 'failed', createdAt: '2026-01-03T00:00:00Z' },
    { id: 'r3', status: 'running', createdAt: '2026-01-02T00:00:00Z' },
  ];
  const term = pickLastTerminalRun(runs);
  assert.strictEqual(term.id, 'r2');
});

// ── isQueued ────────────────────────────────────────────────────────────────
test('isQueued returns true when activeRun has no startedAt', () => {
  const run = { id: 'r1', status: 'running', startedAt: null };
  assert.strictEqual(isQueued(run), true);
});

test('isQueued returns false when activeRun has startedAt', () => {
  const run = { id: 'r1', status: 'running', startedAt: '2026-01-01T00:00:00Z' };
  assert.strictEqual(isQueued(run), false);
});

// ── isStale ──────────────────────────────────────────────────────────────────
test('isStale returns false for a fresh running run', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const run = { id: 'r1', status: 'running', startedAt: '2026-01-01T00:00:00Z' };
  const issue = { last_activity_at: '2026-01-01T00:00:00Z' };
  assert.strictEqual(isStale(run, issue.last_activity_at, now, 15 * 60 * 1000), false);
});

test('isStale returns true when no heartbeat for > threshold', () => {
  const now = Date.parse('2026-01-01T00:20:00Z');
  const run = { id: 'r1', status: 'running', startedAt: '2026-01-01T00:00:00Z' };
  const issue = { last_activity_at: '2026-01-01T00:00:00Z' };
  assert.strictEqual(isStale(run, issue.last_activity_at, now, 15 * 60 * 1000), true);
});

test('isStale returns false for a run that has not started yet (queued, not stale)', () => {
  // isQueued() short-circuits: a dispatched-but-not-started run is QUEUED,
  // never STALE — staleness only applies once execution has actually begun.
  const now = Date.parse('2026-01-01T00:00:00Z');
  const run = { id: 'r1', status: 'running' }; // no startedAt => queued
  assert.strictEqual(isStale(run, null, now, 15 * 60 * 1000), false);
});

// ── summarizeSwarm ──────────────────────────────────────────────────────────
test('summarizeSwarm counts children by status', () => {
  const payload = {
    stages: [
      { issues: [
        { status: 'todo' },
        { status: 'todo' },
        { status: 'in_progress' },
      ]},
    ],
    unstaged: [{ status: 'done' }],
  };
  const summary = summarizeSwarm(payload);
  assert.strictEqual(summary.totalChildren, 4);
  assert.deepStrictEqual(summary.byStatus, { todo: 2, in_progress: 1, done: 1 });
  assert.strictEqual(summary.hasActiveChildren, true);
  assert.strictEqual(summary.isSwarm, true);
});

test('summarizeSwarm returns empty summary for null/empty', () => {
  const s1 = summarizeSwarm(null);
  assert.strictEqual(s1.totalChildren, 0);
  const s2 = summarizeSwarm({});
  assert.strictEqual(s2.totalChildren, 0);
});

// ── resolveAgentName / resolveRuntimeName ────────────────────────────────────
test('resolveAgentName returns agent name or falls back to id', () => {
  const byId = { 'a1': { name: 'Hermes' }, 'a2': { name: 'Codex' } };
  assert.strictEqual(resolveAgentName('a1', byId), 'Hermes');
  assert.strictEqual(resolveAgentName('unknown', byId), 'unknown');
  assert.strictEqual(resolveAgentName(null, {}), null);
});

test('resolveRuntimeName prefers custom_name, falls back to name, then id', () => {
  const byId = {
    'r1': { name: 'Venom.local' },
    'r2': { name: 'Hermes', custom_name: 'My Hermes' },
  };
  assert.strictEqual(resolveRuntimeName('r1', byId), 'Venom.local');
  assert.strictEqual(resolveRuntimeName('r2', byId), 'My Hermes');
  assert.strictEqual(resolveRuntimeName('unknown', byId), 'unknown');
});

// ── buildIssueDeepLink ──────────────────────────────────────────────────────
test('buildIssueDeepLink constructs the canonical issue URL', () => {
  const link = buildIssueDeepLink({
    appUrl: 'https://multica.ai',
    workspaceSlug: 'josh-hobby',
    identifier: 'JOSH-42',
  });
  assert.strictEqual(link, 'https://multica.ai/josh-hobby/issues/JOSH-42');
});

test('buildIssueDeepLink returns null when any part is missing', () => {
  assert.strictEqual(buildIssueDeepLink({ appUrl: 'x', workspaceSlug: 'y', identifier: null }), null);
  assert.strictEqual(buildIssueDeepLink({ appUrl: null, workspaceSlug: 'y', identifier: 'z' }), null);
});

// ── classifyExecutionState ───────────────────────────────────────────────────
test('classifyExecutionState respects issue status first', () => {
  assert.strictEqual(classifyExecutionState({ issue: { status: 'done' } }), EXECUTION_STATES.SUCCEEDED);
  assert.strictEqual(classifyExecutionState({ issue: { status: 'cancelled' } }), EXECUTION_STATES.CANCELLED);
  assert.strictEqual(classifyExecutionState({ issue: { status: 'in_review' } }), EXECUTION_STATES.WAITING_REVIEW);
  assert.strictEqual(classifyExecutionState({ issue: { status: 'blocked' } }), EXECUTION_STATES.BLOCKED);
});

test('classifyExecutionState picks RUNNING for fresh active run', () => {
  const active = { status: 'running', startedAt: '2026-01-01T00:00:00Z' };
  assert.strictEqual(classifyExecutionState({ issue: { status: 'in_progress' }, activeRun: active, stale: false }), EXECUTION_STATES.RUNNING);
});

test('classifyExecutionState picks STALE for stale active run', () => {
  const active = { status: 'running', startedAt: '2026-01-01T00:00:00Z' };
  assert.strictEqual(classifyExecutionState({ issue: { status: 'in_progress' }, activeRun: active, stale: true }), EXECUTION_STATES.STALE);
});

test('classifyExecutionState picks QUEUED for dispatched but not started', () => {
  const active = { status: 'running', startedAt: null };
  assert.strictEqual(classifyExecutionState({ issue: { status: 'in_progress' }, activeRun: active, stale: false }), EXECUTION_STATES.QUEUED);
});

test('classifyExecutionState falls back to ASSIGNED_IDLE or UNASSIGNED', () => {
  assert.strictEqual(classifyExecutionState({ issue: { status: 'in_progress', assignee_type: 'agent', assignee_id: 'a1' } }), EXECUTION_STATES.ASSIGNED_IDLE);
  assert.strictEqual(classifyExecutionState({ issue: { status: 'todo' } }), EXECUTION_STATES.UNASSIGNED);
});

// ── normalizeIssueExecution ──────────────────────────────────────────────────
test('normalizeIssueExecution runs the full pipeline', () => {
  const now = Date.parse('2026-01-01T00:05:00Z'); // 5 minutes after run start — within threshold
  const issue = { id: 'i1', identifier: 'JOSH-42', title: 'Test', status: 'in_progress', last_activity_at: '2026-01-01T00:05:00Z' };
  const rawRuns = [{
    id: 'r1',
    status: 'running',
    created_at: '2026-01-01T00:00:00Z',
    started_at: '2026-01-01T00:00:00Z',
    agent_id: 'a1',
    runtime_id: 'rt1',
  }];
  const children = { stages: [], unstaged: [] };
  const agents = { 'a1': { name: 'Hermes' } };
  const runtimes = { 'rt1': { custom_name: 'Hermes', name: 'Hermes' } };

  const norm = normalizeIssueExecution({ issue, rawRuns, childrenPayload: children, agentsById: agents, runtimesById: runtimes, nowMs: now });
  assert.strictEqual(norm.executionState, EXECUTION_STATES.RUNNING);
  assert.strictEqual(norm.run.agentName, 'Hermes');
  assert.strictEqual(norm.run.runtimeName, 'Hermes');
  assert.strictEqual(norm.swarm.isSwarm, false);
  assert.strictEqual(norm.isStale, false);
});

// ── indexById ────────────────────────────────────────────────────────────────
test('indexById returns an object keyed by id', () => {
  const arr = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  const byId = indexById(arr);
  assert.strictEqual(byId.a.name, 'A');
  assert.strictEqual(byId.b.name, 'B');
});

test('indexById returns {} for null/empty', () => {
  assert.deepStrictEqual(indexById(null), {});
  assert.deepStrictEqual(indexById([]), {});
});

// ── isActiveOrRecentIssue ────────────────────────────────────────────────────
test('isActiveOrRecentIssue includes open issues', () => {
  const issue = { status: 'in_progress' };
  assert.strictEqual(isActiveOrRecentIssue(issue), true);
});

test('isActiveOrRecentIssue includes recently completed/cancelled', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const issue = { status: 'done', last_activity_at: '2026-01-01T00:00:00Z' };
  assert.strictEqual(isActiveOrRecentIssue(issue, now, 15 * 60 * 1000), true);
});

test('isActiveOrRecentIssue excludes older terminal issues', () => {
  const now = Date.parse('2026-01-01T00:20:00Z');
  const issue = { status: 'done', last_activity_at: '2026-01-01T00:00:00Z' };
  assert.strictEqual(isActiveOrRecentIssue(issue, now, 15 * 60 * 1000), false);
});
