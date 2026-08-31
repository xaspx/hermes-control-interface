// lib/multica-telemetry.js — orchestrates the CLI adapter + normalization
// into the single payload the API route serves.
//
// Boundary discipline: this module is the only caller of both
// lib/multica-cli.js (I/O) and lib/multica-bridge.js (pure logic). Keeping
// them separate is what makes lib/multica-bridge.js unit-testable without a
// CLI/network dependency.
'use strict';

const cli = require('./multica-cli');
const bridge = require('./multica-bridge');

const DEFAULT_ISSUE_PAGE_LIMIT = 100;

/**
 * Fetch every issue in the workspace (single page — the workspace-scale
 * assumption is documented in docs/MULTICA_BRIDGE.md's "known limitations").
 */
async function fetchAllIssues({ limit = DEFAULT_ISSUE_PAGE_LIMIT } = {}) {
  const page = await cli.listIssuesPage({ limit, offset: 0 });
  if (!page.ok) return { ok: false, error: page.error, issues: [] };
  return { ok: true, issues: page.data?.issues || [], total: page.data?.total ?? null };
}

/**
 * Build the full Multica execution telemetry snapshot: one normalized
 * execution record per active/recent issue, agents+runtimes resolved to
 * names, and a workspace-level deep-link config.
 *
 * Never throws. Partial failures (e.g. runs lookup fails for one issue) are
 * recorded per-issue as `telemetryError` rather than dropped silently or
 * shown as healthy — satisfies "failures fail visibly" from the acceptance
 * criteria.
 */
async function buildTelemetrySnapshot({
  workspaceId,
  appUrl = 'https://multica.ai',
  staleThresholdMs,
  nowMs = Date.now(),
} = {}) {
  const warnings = [];

  const [issuesResult, agentsResult, runtimesResult, workspaceResult] = await Promise.all([
    fetchAllIssues(),
    cli.listAgents(),
    cli.listRuntimes(),
    cli.getWorkspace(workspaceId),
  ]);

  if (!issuesResult.ok) {
    return {
      ok: false,
      error: `Could not read Multica issues: ${issuesResult.error}`,
      issues: [],
      warnings: [issuesResult.error],
      generatedAt: new Date(nowMs).toISOString(),
    };
  }

  if (!agentsResult.ok) warnings.push(`agent list unavailable: ${agentsResult.error}`);
  if (!runtimesResult.ok) warnings.push(`runtime list unavailable: ${runtimesResult.error}`);
  if (!workspaceResult.ok) warnings.push(`workspace lookup unavailable: ${workspaceResult.error}`);

  const agentsById = bridge.indexById(agentsResult.ok ? agentsResult.data : []);
  const runtimesById = bridge.indexById(runtimesResult.ok ? runtimesResult.data : []);
  const workspaceSlug = workspaceResult.ok ? workspaceResult.data?.slug : null;

  const candidateIssues = issuesResult.issues.filter((i) => bridge.isActiveOrRecentIssue(i, nowMs));

  const records = await Promise.all(candidateIssues.map(async (issue) => {
    const [runsResult, childrenResult] = await Promise.all([
      cli.getIssueRuns(issue.id),
      cli.getIssueChildren(issue.id),
    ]);

    const record = bridge.normalizeIssueExecution({
      issue,
      rawRuns: runsResult.ok ? runsResult.data : [],
      childrenPayload: childrenResult.ok ? childrenResult.data : null,
      agentsById,
      runtimesById,
      linkConfig: { appUrl, workspaceSlug },
      nowMs,
      staleThresholdMs,
    });

    if (!runsResult.ok) {
      record.executionState = bridge.EXECUTION_STATES.UNKNOWN;
      record.telemetryError = `runs unavailable: ${runsResult.error}`;
    } else if (!childrenResult.ok) {
      record.telemetryError = `children unavailable: ${childrenResult.error}`;
    }

    return record;
  }));

  return {
    ok: true,
    issues: records,
    warnings,
    generatedAt: new Date(nowMs).toISOString(),
    staleThresholdMs: staleThresholdMs ?? bridge.DEFAULT_STALE_THRESHOLD_MS,
  };
}

module.exports = { fetchAllIssues, buildTelemetrySnapshot };
