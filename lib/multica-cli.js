// lib/multica-cli.js — thin adapter over the `multica` CLI's JSON contract.
//
// This is the ONLY place that shells out to `multica`. It never scrapes
// human-formatted table output — every call appends `--output json` and
// parses structured JSON, per the integration contract in
// docs/MULTICA_BRIDGE.md.
//
// Every function returns `{ ok: true, data }` or `{ ok: false, error }` —
// callers must handle both explicitly. No exception is ever thrown across
// this boundary; execution telemetry must fail visibly (surfaced as `ok:false`
// / a warning in the API response) rather than crash the dashboard or
// silently show a stale/empty view as healthy.
'use strict';

const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_BIN = 'multica';

function getBinPath() {
  return process.env.MULTICA_CLI_PATH || DEFAULT_BIN;
}

/** Run a `multica ... --output json` command and parse its stdout. */
function runMulticaJson(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = execFile(
        getBinPath(),
        [...args, '--output', 'json'],
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => {
          if (settled) return;
          settled = true;
          if (err) {
            resolve({
              ok: false,
              error: err.killed
                ? `multica ${args[0] || ''} timed out after ${timeoutMs}ms`
                : (err.message || 'multica command failed'),
            });
            return;
          }
          try {
            resolve({ ok: true, data: JSON.parse(stdout) });
          } catch (parseErr) {
            resolve({ ok: false, error: `failed to parse multica JSON output: ${parseErr.message}` });
          }
        }
      );
    } catch (spawnErr) {
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: `failed to spawn multica CLI: ${spawnErr.message}` });
      }
      return;
    }
    child?.on?.('error', (spawnErr) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: `failed to spawn multica CLI: ${spawnErr.message}` });
    });
  });
}

/** List issues in the workspace. Returns the raw `{ issues, has_more, ... }` page. */
function listIssuesPage({ limit = 100, offset = 0, status } = {}) {
  const args = ['issue', 'list', '--limit', String(limit), '--offset', String(offset)];
  if (status) args.push('--status', status);
  return runMulticaJson(args);
}

/** Execution history for one issue — array of run records. */
function getIssueRuns(issueId) {
  return runMulticaJson(['issue', 'runs', issueId]);
}

/** Sub-issues grouped by stage, plus any unstaged children. */
function getIssueChildren(issueId) {
  return runMulticaJson(['issue', 'children', issueId]);
}

/** All agent runtimes bound to daemons in the workspace. */
function listRuntimes() {
  return runMulticaJson(['runtime', 'list']);
}

/** All agents in the workspace (id, name, runtime_id, ...). */
function listAgents() {
  return runMulticaJson(['agent', 'list']);
}

/** Workspace metadata — used to build a canonical deep link back to the issue. */
function getWorkspace(workspaceId) {
  const args = ['workspace', 'get'];
  if (workspaceId) args.push(workspaceId);
  return runMulticaJson(args);
}

module.exports = {
  runMulticaJson,
  listIssuesPage,
  getIssueRuns,
  getIssueChildren,
  listRuntimes,
  listAgents,
  getWorkspace,
};
