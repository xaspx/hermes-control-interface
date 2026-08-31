# Multica-to-Hermes Execution Telemetry Bridge

**Status:** first vertical slice, implemented and verified live against the
real Multica API on 2026-08-31 (workspace `Josh Hobby` / `josh-hobby`).
Tracks issue: `JOSH-42`.

## Product decision (unchanged by this slice)

Multica remains canonical for issue ownership, status, comments, and swarm
structure. Hermes/HCI is a **read-only, engine-level operational mirror**:
runtime, active execution, heartbeats, and last-activity. This bridge does
**not** create a second source of truth — it never writes to Multica, and it
is safe to delete without losing any Multica state.

## Architecture

```
┌─────────────────────┐     shells out to      ┌──────────────────┐
│ lib/multica-cli.js   │ ───────────────────►   │ `multica` CLI     │
│ (I/O boundary)       │  --output json only    │ (authenticated)   │
└──────────┬───────────┘                        └──────────────────┘
           │ raw JSON (issues, runs, children, agents, runtimes, workspace)
           ▼
┌──────────────────────┐
│ lib/multica-bridge.js │  pure functions, no I/O — state mapping,
│ (normalization)       │  stale detection, swarm aggregation
└──────────┬────────────┘
           │ normalized execution records
           ▼
┌────────────────────────┐
│ lib/multica-telemetry.js│  orchestrates cli + bridge into one snapshot
└──────────┬───────────────┘
           │
           ▼
   GET /api/office/multica-issues   (server.js, requireAuth, 5s cache)
           │
           ▼
   src/js/multica-issues-panel.js   (Office page, "🔗 Multica Issues" tab)
```

This 3-layer split (I/O adapter → pure normalization → orchestration) exists
specifically so `lib/multica-bridge.js` — state mapping, stale detection,
swarm aggregation — is unit-testable without spawning the CLI or touching the
network. See `test/multica-bridge.test.js` (29 tests, all passing).

## Integration contract

**Only `lib/multica-cli.js` shells out to `multica`.** Every call uses
`--output json` and parses the CLI's JSON contract — never human-formatted
table output. Calls used:

| CLI command | Purpose |
|---|---|
| `multica issue list --output json --limit 100` | Enumerate issues (single page — see Known Limitations) |
| `multica issue runs <id> --output json` | Execution history for one issue: `status` (`running`/`completed`/`failed`/`cancelled`), `agent_id`, `runtime_id`, `started_at`, `completed_at` |
| `multica issue children <id> --output json` | Sub-issues grouped by stage — swarm detection |
| `multica agent list --output json` | Resolve `agent_id` → agent name |
| `multica runtime list --output json` | Resolve `runtime_id` → runtime/device name (`custom_name` preferred, e.g. "Venom") |
| `multica workspace get <id> --output json` | Resolve workspace `slug` for building the deep link |

No direct `state.db` access, no scraping of table output, no secrets read
from the CLI's config — auth is whatever `multica auth status` already has
configured on the host running HCI (the same identity as any other `multica`
invocation on that machine).

## Execution state model

`lib/multica-bridge.js`'s `classifyExecutionState()` is the single place that
derives the display state — every caller (API, UI, tests) goes through it:

| State | Meaning |
|---|---|
| `unassigned` | No member/agent/squad owns the issue |
| `assigned_idle` | Owned by an agent/squad, no run currently active |
| `queued` | A run was dispatched but has not started (`started_at` is null) |
| `running` | A run is executing and its heartbeat proxy is fresh |
| `stale` | A run claims to be running, but no activity for > threshold (default 15 min) — **never** reported as healthy `running` |
| `waiting_review` | Issue status is `in_review`, no active run |
| `blocked` | Issue status is `blocked`, no active run |
| `succeeded` | Issue status is `done` (Multica status is canonical) |
| `failed` | Issue open, no active run, most recent run `failed` |
| `cancelled` | Issue status `cancelled`, or most recent run `cancelled` |
| `unknown` | Telemetry could not be read for this issue (CLI/API error) — flagged, never presented as healthy |

**Stale detection.** Multica's CLI does not expose a lower-level per-run
heartbeat, so `issue.last_activity_at` (bumped by comments, run messages, and
status changes) is used as the best available heartbeat proxy. A `running`
run whose `max(last_activity_at, started_at)` is older than
`staleThresholdMs` (default 15 minutes) is reclassified `stale`. A run with
no `started_at` at all is `queued`, not stale — staleness only applies once
execution has actually begun.

**Swarm detection.** `summarizeSwarm()` reads `multica issue children`,
counts by status, and flags `hasActiveChildren` when any child is
`in_progress`/`todo`/`in_review`/`blocked`. `isSwarm` is true whenever a
parent has one or more children — this is how a parent issue's swarm
activity is surfaced without a separate "squad" concept in the UI.

**History preservation.** `isActiveOrRecentIssue()` includes every non-terminal
issue plus terminal (`done`/`cancelled`) issues whose `last_activity_at` is
within the last 15 minutes. Older completed/cancelled issues fall out of this
view automatically — they remain fully queryable in Multica itself
(`multica issue list --status done`), satisfying "preserve history without
polluting the active view" without building a second history store in HCI.

## API

`GET /api/office/multica-issues` (session auth required, same as the rest of
`/api/office/*`).

```json
{
  "ok": true,
  "generatedAt": "2026-08-31T02:40:00.000Z",
  "staleThresholdMs": 900000,
  "warnings": [],
  "issues": [
    {
      "issueId": "01a0...",
      "identifier": "JOSH-42",
      "title": "Expose Multica Issue execution, agent, and swarm telemetry in Hermes",
      "issueStatus": "in_progress",
      "assigneeType": "agent",
      "assigneeId": "958229c6-...",
      "executionState": "running",
      "isStale": false,
      "run": {
        "id": "01a0...",
        "status": "running",
        "agentId": "958229c6-...",
        "agentName": "Implementation Engineer",
        "runtimeId": "17b5c82c-...",
        "runtimeName": "Venom",
        "startedAt": "2026-08-31T02:07:...Z",
        "completedAt": null,
        "createdAt": "2026-08-31T02:07:...Z",
        "error": null
      },
      "lastActivityAt": "2026-08-31T02:40:...Z",
      "swarm": { "totalChildren": 3, "byStatus": {"backlog": 3}, "hasActiveChildren": false, "isSwarm": true },
      "deepLink": "https://multica.ai/josh-hobby/issues/JOSH-42",
      "parentIssueId": null
    }
  ]
}
```

On failure (CLI unavailable, auth expired, etc.), the endpoint returns
`{ ok: false, error, issues: [], warnings: [...] }` with HTTP 200 (the panel
renders an explicit "⚠️ Multica telemetry unavailable" error state — it never
silently falls back to a stale-looking "healthy" table). Per-issue partial
failures (e.g. `issue runs` failing for one issue while the rest succeed) are
recorded as `telemetryError` on that record and force `executionState:
"unknown"`, rather than being dropped or shown as healthy.

**Caching.** The route caches the full snapshot for 5 seconds
(`MULTICA_TELEMETRY_CACHE_MS` in `server.js`) to avoid hammering the CLI when
the UI polls every 5s. Pass `?refresh=1` to bypass the cache.

## UI

Office page (`src/js/pages/office.js`) gained a second tab next to the
existing PixiJS Kanban board: **🔗 Multica Issues**. Switching tabs stops the
other view's polling — they never both poll simultaneously.
`src/js/multica-issues-panel.js` renders a sortable table (active states
first: stale → running → queued → waiting_review → blocked → failed →
assigned_idle → unassigned → unknown → succeeded → cancelled), each row
showing the state badge, run id/status, resolved agent/runtime name, last
activity, swarm badge (child count + active indicator), and an "Open ↗" deep
link back to the canonical Multica issue. Polls every 5s while the tab is
active.

## Auth / secrets handling

No new secrets are introduced. The bridge relies entirely on the `multica`
CLI's own stored auth token (`~/.multica/config.json` on whichever host runs
`multica`, e.g. via HCI's `docker exec` context or a bound daemon) — HCI
never reads or forwards that token itself; it only reads the CLI's stdout.
`MULTICA_WORKSPACE_ID` and `MULTICA_APP_URL` (used only to build the
human-facing deep link) are read from HCI's own process environment, with no
credential material in either.

## Known limitations / assumptions

- **Single-page issue listing.** `fetchAllIssues()` reads one page
  (`--limit 100`, the CLI's per-page cap) and does not paginate further. On
  workspaces with more than 100 issues where the active/recent ones fall
  outside that first page, this bridge would miss them. Given the current
  workspace's issue count (< 100 seen at implementation time), this was
  judged an acceptable first-slice limit — the fix is a straightforward
  `--offset` loop in `fetchAllIssues()` if/when it's needed.
- **No per-run heartbeat.** Stale detection uses issue-level
  `last_activity_at` as a proxy, not a lower-level per-run heartbeat (Multica
  does not expose one over the CLI contract investigated here). A long-running
  task that produces no comments/run-messages for 15+ minutes will show as
  `stale` even if it is still healthily working — this is a deliberate
  fail-safe bias (never claim healthy without evidence), not a bug.
- **Polling, not push.** The UI polls every 5s and the API caches for 5s;
  there is no webhook/SSE push from Multica in this slice. This matches the
  existing Office Kanban panel's own polling pattern (30s) and was chosen for
  consistency and to avoid a new event-plumbing dependency in the first slice.
  A future slice could push updates over the same `/ws` HCI already runs.
- **Deep link construction.** `buildIssueDeepLink()` assumes Multica's issue
  URL is `{appUrl}/{workspaceSlug}/issues/{identifier}` (confirmed from
  Multica's own GitHub-integration docs, which document `MUL-123`-style
  identifiers used in exactly this path shape). If Multica's URL scheme
  changes, only this one function needs updating.
- **No E2E browser test added.** `test/office-visualization.spec.js`
  (Playwright) exercises the existing Kanban panel against a running HCI
  server; extending it to the new Multica tab requires a running server with
  configured auth secrets, which is out of scope for this slice's automated
  test run (documented here rather than skipped silently). The live
  `buildTelemetrySnapshot()` call against the real Multica workspace (see
  Test Evidence below) is the closest available proof this actually works
  end-to-end.

## Test evidence

```
$ npm test
...
ℹ tests 42
ℹ pass 42
ℹ fail 0
```

29 of those 42 are new, in `test/multica-bridge.test.js`, covering:
normalization (`normalizeRun`), sorting/selection (`sortRunsDesc`,
`pickActiveRun`, `pickLastTerminalRun`), queued/stale detection (`isQueued`,
`isStale`), swarm aggregation (`summarizeSwarm`), name resolution
(`resolveAgentName`, `resolveRuntimeName`), deep-link construction
(`buildIssueDeepLink`), the full state-mapping matrix
(`classifyExecutionState`), the end-to-end normalization pipeline
(`normalizeIssueExecution`), and history-window filtering
(`isActiveOrRecentIssue`).

**Live verification** (2026-08-31, real Multica workspace, no mocks):

```
$ node -e "require('./lib/multica-telemetry').buildTelemetrySnapshot({...}).then(...)"
ok: true
warnings: []
issue count: 19
running/stale: [
  { id: 'JOSH-44', state: 'running', agent: 'Security Architect', runtime: 'Venom' },
  { id: 'JOSH-43', state: 'stale',   agent: 'Architecture Director', runtime: 'Venom' },
  { id: 'JOSH-42', state: 'running', agent: 'Implementation Engineer', runtime: 'Venom' },
  { id: 'JOSH-41', state: 'running', agent: 'SDLC Pipeline Coordinator', runtime: 'Venom' }
]
swarms: [ { id: 'JOSH-42', swarm: { totalChildren: 3, hasActiveChildren: true, isSwarm: true } } ]
```

This is JOSH-42 (this very issue) observing itself: correctly shown
`running`, with `Implementation Engineer` as the executing agent and `Venom`
as the bound runtime, and its own children correctly detected as an active
swarm. JOSH-43's run is correctly downgraded from `running` to `stale` by the
heartbeat-age check, demonstrating the "run failures/stale heartbeats fail
visibly" acceptance criterion against real, uncontrolled production data —
not a fixture.

**Not run:** `npx vite build` (frontend bundling) — fails in this
environment with a pre-existing, unrelated error (`rolldown-binding.darwin-universal.node`
missing; verified with `git stash` that the failure exists on `main` before
any of this slice's changes). `node --check` was run against every new/edited
`.js` file instead (all pass) as the available substitute for a type/syntax
gate in this repo (plain JS, no TypeScript, no dedicated lint config beyond
`npm test`).
