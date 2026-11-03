# Hermes Control Interface — Agent Onboarding

> Self-hosted web dashboard for the Hermes AI agent stack. Manages terminals, files, sessions, cron jobs, token analytics, multi-agent gateways, and team access behind a password gate.

## Project Purpose

Single-pane operations console for Hermes profiles. 10 pages: Home · Agents · Usage · Skills · Chat · Logs · Monitor · Maintenance · Files · Office. RBAC v2 (28 permissions × 12 groups). Multi-agent gateway start/stop/configure with real-time logs over WebSocket.

## Stack

- **Frontend**: Vanilla JS + Vite (no framework), xterm.js, Chart.js
- **Backend**: Node ≥20, Express, WebSocket (`ws`), node-pty, better-sqlite3
- **Auth**: bcrypt password gate, helmet, express-rate-limit
- **Test**: `node --test` (unit), Playwright (E2E in `qa/`)

## Layout

```
server.js          ⚠ ~150KB single-file backend (`stat -f %z server.js` for exact) — surgical edits only
auth.js            password + session middleware
src/
  index.html       SPA shell
  js/              page modules
  css/             styles
  assets/
docs/              API · CONFIG · DEPLOY · DESIGN · INSTALL · PASSWORD · SECURITY · TROUBLESHOOTING
qa/                Playwright suites
scripts/           setup-gateway-service.sh (only file present; `reset-password.js` referenced in package.json is missing — use HTTP endpoint instead)
test/              node --test specs
```

## Commands

| Task | Command |
|------|---------|
| Dev (Vite) | `npm run dev` |
| Run server | `npm start` |
| Build | `npm run build` |
| Test | `npm test` |
| E2E | `npx playwright test` |
| Reset password (HTTP) | `POST /api/users/:username/reset-password` (admin role; see server.js:1639). NOTE: `package.json` `reset-password` script points to `scripts/reset-password.js` which is **missing** — use the HTTP endpoint instead |
| Install (fresh) | `npm install` only — there is no `install.sh`. Setup gateway via `bash scripts/setup-gateway-service.sh` |

## Operational Invariants

- **Password gate** is the only auth boundary. Never expose endpoints outside `requireAuth` middleware unless explicitly public (health checks).
- **RBAC v2**: 28 permissions across 12 groups. New endpoints must declare a permission.
- **WebSocket** streams log/terminal output. Always tear down on client disconnect (memory leak risk with node-pty).
- **launchd integration** (macOS): per-profile gateway services named `ai.hermes.gateway[-<profile>].plist` (verified via `ls ~/Library/LaunchAgents/ai.hermes.gateway*`). Watchdog companion: `ai.hermes.gateway-watchdog.plist`. (Project README mentions systemd but Mac Studio runs launchd via `launchctl`.)
- **Session ID parsing** must handle both new (`session_id:`) and legacy (`Session:`) formats.
- **Token analytics** uses `@pydantic/genai-prices` for cost. Refresh package when adding new models.

## Pre-conditions Before Editing

1. `server.js` is huge — locate target route via grep before editing. Avoid bulk reformat.
2. New permissions: register in the 28-permission catalog AND assign to default groups.
3. Gateway lifecycle changes: test with `launchctl bootout/bootstrap gui/$UID ~/Library/LaunchAgents/ai.hermes.gateway[-<profile>].plist` (Mac Studio uses launchd, not systemd).
4. Frontend changes: rebuild via `npm run build` and verify in dark mode (default theme).

## Refs

- `README.md` (605 lines) — full feature tour with screenshots
- `docs/API.md` — backend endpoint reference
- `docs/SECURITY.md` — auth + RBAC details
- `docs/CONFIG.md` — config schema (13 categories, 80+ settings)
- `docs/DEPLOY.md` — production deployment
