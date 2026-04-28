# Hermes Control Interface

A self-hosted web dashboard for the [Hermes AI agent](https://github.com/NousResearch/hermes-agent) stack. Browser-based terminal, file explorer, session management, cron scheduling, token analytics, and multi-agent administration — all behind a password gate.

**Stack:** Vanilla JS + Vite · Node.js · Express · WebSocket · xterm.js
**Version:** 3.1.0

---

## Screenshots

### Dark Mode

| Home | Agents | Usage & Analytics |
|------|--------|-------------------|
| ![Home](docs/screenshots/dark/01-home.png) | ![Agents](docs/screenshots/dark/02-agents.png) | ![Usage](docs/screenshots/dark/03-usage.png) |

| Skills Hub | Maintenance | File Explorer |
|------------|-------------|---------------|
| ![Skills](docs/screenshots/dark/04-skills.png) | ![Maintenance](docs/screenshots/dark/05-maintenance.png) | ![Files](docs/screenshots/dark/06-files.png) |

| Agent Dashboard | Gateway & Connections | Memory & Honcho |
|-----------------|----------------------|-----------------|
| ![Dashboard](docs/screenshots/dark/07-agent-dashboard.png) | ![Gateway](docs/screenshots/dark/09-agent-gateway.png) | ![Memory](docs/screenshots/dark/11-agent-memory.png) |

| Agent Skills | Cron Jobs |
|--------------|-----------|
| ![Skills](docs/screenshots/dark/12-agent-skills.png) | ![Cron](docs/screenshots/dark/13-agent-cron.png) |

### Light Mode

| Home | Agents | Skills Hub |
|------|--------|------------|
| ![Home](docs/screenshots/light/01-home.png) | ![Agents](docs/screenshots/light/02-agents.png) | ![Skills](docs/screenshots/light/04-skills.png) |

| Gateway | Memory |
|---------|--------|
| ![Gateway](docs/screenshots/light/09-agent-gateway.png) | ![Memory](docs/screenshots/light/11-agent-memory.png) |

---

## Features

### 7 Pages

**Home** — System overview dashboard:
- System Health: CPU, RAM, Disk, Uptime
- Agent Overview: model, provider, gateway status, API keys, platforms
- Gateways: per-profile running/stopped status
- Token Usage (7d): sessions, messages, tokens, cost, models, platforms, top tools

**Agents** — Multi-agent management:
- List all Hermes profiles with status and model
- Create, clone, delete, set default
- Gateway start/stop per profile

**Agent Detail** — Per-agent management with 6 tabs:
- **Dashboard**: Identity, gateway service, token usage
- **Sessions**: List, search, rename, delete, export, resume in CLI
- **Gateway**: Start/stop/restart, real-time logs, systemd service management
- **Config**: 13 categories, 80+ settings, structured form + raw YAML editor
- **Memory**: Dynamic provider panel (built-in MEMORY.md, honcho, external)
- **Cron**: List/create/pause/resume/run/remove jobs with schedule presets

**Usage & Analytics** — Full token breakdown:
- Time range filter: Today, 7d, 30d, 90d
- Agent filter: per-profile or all
- Overview: sessions, messages, tokens, cost, active time
- Models: per-model sessions and tokens
- Platforms: per-platform breakdown (CLI, Telegram, WhatsApp, etc.)
- Top Tools: most used tools with call counts

**Skills Marketplace** — Installed skills browser:
- List all installed skills grouped by category
- Shows source (builtin/local) and trust level
- Search and filter

**Maintenance** — System administration:
- Doctor: run diagnostics, auto-fix issues
- Dump: generate debug summary
- Update: Hermes agent version update
- Users: create/delete users, role management
- Auth: provider status (OpenRouter, Nous Portal, etc.)
- Audit: timestamped activity log

**File Explorer** — Split-view file editor:
- Directory tree browser (left panel)
- Text editor with save (right panel)
- Secure: paths scoped to ~/.hermes, traversal prevented

### Terminal

- Real PTY shell via node-pty + xterm.js over WebSocket
- Touch controls (↑↓␣↵) for mobile
- Fullscreen toggle
- Auto-cleanup flow: Ctrl+C → clear → command

### Notifications

- Bell icon with unread count badge (top-right)
- Dropdown panel with dismiss/clear
- Sources: system alerts (disk/RAM/CPU), gateway events, session CRUD, user management
- Persistent: ~/.hermes/hci-notifications.json

### Theme

- **Dark mode**: `#0b201f` background, `#dccbb5` foreground, `#7c945c` accent
- **Light mode**: `#e4ebdf` background, `#0b201f` foreground, `#2e6fb0` accent
- Toggle via header button, persisted in localStorage
- Login background image with overlay

### Security

- Multi-user auth: admin + viewer roles
- bcrypt password hashing
- CSRF tokens on all mutating requests
- Conditional Secure cookie flag (auto-detects HTTPS)
- WebSocket origin verification
- Input sanitization: strict regex on all user inputs (profiles, sessions, titles)
- Path traversal prevention
- Rate limiting on login (5 failed/15min)
- unhandledRejection + uncaughtException handlers

---

## Quick Start

```bash
# Clone
git clone https://github.com/xaspx/hermes-control-interface.git
cd hermes-control-interface

# Install
npm install

# Configure
cp .env.example .env
# Edit .env:
#   HERMES_CONTROL_SECRET=your-random-secret

# Build frontend
npx vite build

# Start
npm start
```

Access at `http://localhost:10272` (default PORT).

On a clean install, the web UI prompts you to create the first admin account.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `HERMES_CONTROL_SECRET` | Yes | Auth token signing secret |
| `HERMES_CONTROL_PASSWORD` | No | Legacy env password from pre-user-store auth |
| `PORT` | No | Server port (default: 10272) |
| `HERMES_CONTROL_HOME` | No | Hermes home dir (default: ~/.hermes) |
| `HERMES_CONTROL_ROOTS` | No | File explorer roots (JSON array) |
| `HERMES_PROJECTS_ROOT` | No | Projects directory |

## Architecture

```
src/                    # Vite source (ES modules)
├── index.html          # Entry point
├── js/main.js          # App logic (~2400 lines)
├── css/
│   ├── theme.css       # Color palette (dark/light)
│   ├── layout.css      # Topbar, modals, dropdowns
│   └── components.css  # Cards, tables, forms, editor, file explorer
└── assets/             # SVG icons

dist/                   # Vite build output (served by Express)
server.js               # Express + WebSocket + PTY + API (~2300 lines)
auth.js                 # Multi-user auth system
```

## Development

```bash
# Terminal 1: backend API on the default app port
npm start

# Terminal 2: Vite dev server for frontend changes
npm run dev
```

- Backend default: `http://localhost:10272`
- Frontend dev server: `http://localhost:5173`
- To point the frontend at a different backend, set `HCI_BACKEND_URL` before `npm run dev`

For production/static serving, rebuild the frontend and restart the backend:

```bash
npm run build
npm start
```

## API

60+ endpoints covering:
- Auth (login, logout, setup, users CRUD)
- Sessions (list, rename, delete, export)
- Profiles (list, create, delete, use, gateway control)
- Cron (list, create, pause, resume, run, remove)
- Config (read, write, YAML parsing)
- Memory (provider-specific panels)
- Skills (list, parse)
- Files (list, read, write, save)
- System (health, insights, usage, doctor, dump, update)
- Notifications (list, dismiss, clear)

See `docs/API.md` for full reference.

## Security Audit

Full audit: `docs/SECURITY-AUDIT-2.md`
Score: 9.1/10 — Production-ready with caveats.

## License

MIT

## Credits

Built for the [Hermes Agent](https://github.com/NousResearch/hermes-agent) ecosystem.
