# Hermes Control Interface

A self‑hosted web dashboard for the [Hermes AI agent](https://github.com/NousResearch/hermes-agent) stack. Manage terminals, files, sessions, cron jobs, token analytics, multi‑agent gateways, and team access — all behind a password gate.

**Stack:** Vanilla JS + Vite · Node.js · Express · WebSocket · xterm.js  
**Version:** 3.5.1  

---  

## Introduction

Hermes Control Interface (HCI) is the web UI that lets you operate a Hermes AI agent deployment from a browser. It provides:

* Real‑time chat via the Gateway API with tool‑call cards and session resume
* Full RBAC (28 permissions, 3 built‑in roles) and multi‑user management
* Multi‑agent gateway control, log streaming and systemd service integration
* Token‑usage analytics, health monitoring and diagnostics
* Secure, password‑protected access with bcrypt hashing, CSRF protection and rate limiting  
* File explorer, in‑browser terminal, skill marketplace and maintenance tools  

The UI is built with vanilla JavaScript, Vite for bundling, and an Express‑powered backend that also hosts the WebSocket and PTY services required for the terminal.

---  

## Features  

### 🔐 Authentication & Security  
* Single‑password login (configurable via `HERMES_CONTROL_PASSWORD`)  
* BCrypt password hashing (cost 10) and optional multi‑user support  
* CSRF tokens on all mutating endpoints  
* Secure cookies (HTTPS‑only when applicable)  
* Rate limiting (5 failed logins/15 min per IP, 30 terminal commands/min)  
* Comprehensive XSS, injection and CORS hardening (see `docs/SECURITY_AUDIT.md`)  

### 🏠 Home Dashboard  
* System health overview (CPU, RAM, disk, uptime)  
* Agent and gateway status badges  
* 7‑day token‑usage summary with cost estimation  

### 🤖 Agents – Multi‑Agent Management  
* List, create, clone, delete and set default Hermes profiles  
* Start/stop/restart gateways per profile with live log viewer  

### 💬 Chat – Revamped Interface  
* Real‑time streaming via Gateway API  
* Collapsible tool‑call cards with JSON viewer  
* Session sidebar for resume, rename, delete and export  
* Multi‑profile support and auto‑fallback to CLI  

### 📊 Usage & Analytics  
* Token & cost breakdown by model, platform and time range  
* Interactive charts and tables for sessions, messages and tools  

### 🛠️ Agent Detail (Dashboard, Sessions, Gateway, Config, Memory, Cron)  

### 📦 Skills Marketplace  
* Browse, install, update and uninstall skills from the official registry  

### 🧑‍🔧 Maintenance & Administration  
* Doctor diagnostics, system dump, update, backup/restore, HCI restart  
* User management (create/edit/delete, role assignment, permission editing)  

### 📁 File Explorer  
* Scoped, secure, two‑pane editor with syntax highlighting  

### 💻 Terminal  
* Browser‑based PTY via `node‑pty` + `xterm.js`  

### 🔔 Notifications  
* Real‑time alerts with persistent storage  

### 🎨 Theme  
* Dark (default) and Light modes, persisted in `localStorage`  

---  

## Installation  

### Prerequisites  

| Requirement | Minimum | Recommended |
|---|---|---|
| Node.js | v20+ | v22 LTS |
| RAM | 512 MiB | 1 GiB+ |
| Disk | 200 MiB | 500 MiB+ |
| OS | Linux / macOS / WSL2 | Ubuntu 22.04 LTS |
| Hermes Agent | v0.3.x | latest |
| Build tools | `python3`, `make`, `g++` | required for `node‑pty` native module |

### Manual Installation (Recommended)  

```bash
# 1. Clone the repository
git clone https://github.com/xaspx/hermes-control-interface.git
cd hermes-control-interface

# 2. Install Node dependencies
npm install

# 3. Prepare environment variables
cp .env.example .env
# Edit .env:
#   HERMES_CONTROL_PASSWORD=your‑secure‑password
#   HERMES_CONTROL_SECRET=$(openssl rand -hex 32)

# 4. Build the frontend assets
npm run build

# 5. Start the server
npm start
```

The dashboard will be reachable at `http://localhost:10272` (default `PORT`).

### Production with systemd  

```bash
# Use the helper script (creates a systemd unit)
bash scripts/setup-gateway-service.sh
```

Or create a unit manually:

```ini
# /etc/systemd/system/hermes-control.service
[Unit]
Description=Hermes Control Interface
After=network.target

[Service]
Type=simple
User=hermes          # non‑root preferred
WorkingDirectory=/path/to/hermes-control-interface
ExecStart=/usr/bin/node server.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable hermes-control
sudo systemctl start hermes-control
```

---  

## Usage  

1. Open the UI in a browser (`http://HOST:PORT`).  
2. Log in with the password defined in `.env`.  
3. Navigate through the top‑level pages: **Home**, **Agents**, **Chat**, **Usage**, **Skills**, **Logs**, **Monitor**, **Files**, **Maintenance**, **Office**.  
4. Use the **Users** tab (Administration → Users) to add additional accounts and assign roles.  
5. For each Hermes profile you can start/stop the gateway, edit its configuration, view logs and manage scheduled cron jobs.  
6. The **Chat** page streams responses instantly; use the stop button to abort a running stream.  
7. The **Usage** page offers token analytics; select a time range and/or specific agent to filter.  
8. The **File Explorer** lets you edit files under `~/.hermes` (or any roots defined via `HERMES_CONTROL_ROOTS`).  

All actions are logged in the **Audit** view for traceability.

---  

## Testing  

```bash
npm test          # Unit tests (node --test, test/*.test.js)
npm run test:e2e  # Playwright E2E (test/office-visualization.spec.js) — needs a first-run server on :8790 (credentials in test/global-setup.js)
npm run test:qa   # Playwright route QA (qa/) — set QA_BASE_URL to a running instance
```  

---  

## Project Structure  

```
.
├── AGENTS.md
├── auth.js                 # Multi‑user auth & RBAC logic
├── CLAUDE.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── dist/                   # Production assets built by Vite
│   ├── assets/
│   │   ├── favicon-Bkag5KeL.svg
│   │   ├── hermes-agent-bg-DhFabiO9.jpg
│   │   ├── hermes-icon-BhPDiZ8G.svg
│   │   ├── index-C33hUJXJ.css
│   │   └── index-DXC1lv8V.js
│   ├── i18n/
│   │   ├── en.json
│   │   └── ja.json
│   └── index.html
├── docs/
│   ├── API.md
│   ├── CONFIG.md
│   ├── DEPLOY.md
│   ├── DESIGN.md
│   ├── INSTALL.md
│   ├── PASSWORD.md
│   ├── SECURITY.md
│   ├── TROUBLESHOOTING.md
│   ├── TUI_CHAT_REVAMP_PLAN.md
│   ├── SECURITY_AUDIT.md
│   └── plans/
│       ├── 2026-04-19-gateway-health-check.md
│       ├── 2026-04-19-granular-update-system.md
│       └── 2026-05-06-ux-fixes.md
│   └── screenshots/
│       ├── dark/   (01‑13 PNG files)
│       └── light/  (01‑03 PNG files)
├── hci.config.yaml.example
├── lib/                    # Shared utility libraries
├── LICENSE
├── node_modules/
├── package-lock.json
├── package.json
├── playwright.config.js
├── playwright.config.mts
├── qa/                     # QA helpers & test data
├── README.md               # <<‑‑ This file
├── scripts/                # Helper scripts (setup, lint, etc.)
├── SECURITY_AUDIT.md
├── server.js               # Express + WebSocket + PTY server
├── src/                    # Vite source code (frontend)
│   ├── assets/
│   ├── css/
│   ├── js/
│   └── index.html
├── test/
├── test-results/
├── vite.config.js
└── (additional directories)
```

*Key directories*  

* `src/` – Front‑end source (ES modules, CSS, assets).  
* `dist/` – Bundled static files served by Express in production.  
* `server.js` – Backend API, WebSocket handling, PTY terminal, authentication.  
* `auth.js` – RBAC implementation and password handling.  
* `docs/` – Comprehensive documentation (API, configuration, deployment, security).  

---  

## License  

This project is licensed under the MIT License – see the `LICENSE` file for details.  