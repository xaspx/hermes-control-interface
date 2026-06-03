# HCI v3.6.0 Release Notes

**Release Date:** 2026-06-03  
**Tag:** `v3.6.0`  
**Previous:** `v3.5.1`  
**Staging:** agent2.panji.me  
**Production:** agent.panji.me  

---

## 🎯 Highlights

### 🏢 Office v3 — ZOO Swarm Monitor
The Office page is now a full 3-panel swarm monitoring dashboard:

| Panel | Feature | Detail |
|-------|---------|--------|
| **Agents** | Agent health monitor | 4 agents tracked via config.yaml + kanban.db (zero subprocess, ~100ms) |
| **Kanban** | Task pipeline | 8 status lanes, drag-free cards, dependency arrows, quick actions |
| **Live Feed** | Real-time event stream | 50 events from gateway logs, agent filter dropdown, keyword search |

### 📋 Kanban Task Detail Popup v2
Click any card to see:
- **⚡ Run History** — expandable runs with full summary, metadata JSON, error logs
- **📁 Workspace Files** — click artifact to load file content inline (code-syntax, dark theme)
- **📋 Events** — enriched with payload data (assignee, lock, pid)
- **💬 Comments** — full author + body display
- **⏱ Timeline** — merged chronological view of all activity
- **🔗 Dependencies** — parent/child task chips
- **Load More** — "Show all X↑" for runs (>5), comments (>5), events (>10)

### 🎨 Design System
- **Unified HCI dropdown selects** — all selects use canonical HCI style (`appearance: none`, SVG chevron, light/dark mode aware)
- **Live Feed filter bar** — agent dropdown + keyword search with match badge
- **Dark mode:** `#0b201f` bg / `#dccbb5` fg / `#7c945c` accent / JetBrains Mono
- **Light mode:** `#e4ebdf` bg / `#0b201f` fg / `#2e6fb0` accent

---

## 🚀 Features

### Office v3 (NEW)
- 3-panel dashboard: Agents · Kanban · Live Feed
- 8 kanban status lanes: triage → todo → scheduled → ready → running → blocked → review → done
- Card hover shows dependency arrows (SVG bezier curves)
- Quick actions: Mark Done, Reopen, Approve, Start, Unblock, Reassign
- Board switcher: main / dev / content / trading
- Board summary modal with stats + recommendations

### Task Detail Popup v2 (ENHANCED)
- Run detail expansion — click ▶ to see metadata, artifacts, errors
- Workspace file browser — click artifact to load file content
- Event payload enrichment — created/claimed/spawned details
- Load More pagination for runs, comments, events
- Backend: `/api/office/kanban/:taskId/workspace-file` — path-safe file reader

### Live Feed (ENHANCED)
- Agent filter dropdown (auto-populated from visible agents)
- Keyword search (real-time filter across agent + action)
- Match badge showing "N/50"
- Zero-flash re-render

### Chat (FIXED)
- highlight.js security warning fixed — code blocks use `textContent` (not `innerHTML`)
- Chat source filter (`filterChatBySource`) properly exposed on `window`
- Debounced filter prevents rapid rebuild flicker

### Design (POLISHED)
- All dropdown selects unified to canonical HCI style
- Light/dark mode SVG chevron arrows
- Consistent `var(--font)` / `var(--bg-input)` / `var(--radius)` across all selects
- `kb-reassign-select` now matches chat/agent filter dropdowns

### Performance
- Office polling: 2s → **30s** + in-flight guard (prevents spawn storms)
- Agent states: shell-based → **config.yaml + kanban.db** (~100ms, zero subprocess)
- Budget input: guard against duplicate event listeners

---

## 🔧 Infrastructure

### aaPanel Nginx Auto-Start (FIXED)
- `systemd nginx.service` redirected from `/usr/sbin/nginx` → `/www/server/nginx/sbin/nginx`
- PID file: `/www/server/nginx/logs/nginx.pid`
- Config: `-c /www/server/nginx/conf/nginx.conf`
- **All sites survive VPS reboot now**

### Backend
- New endpoint: `GET /api/office/kanban/:taskId/workspace-file?board=&path=`
- Path traversal protection via `path.resolve` boundary check
- File size limit: 500KB
- Auto-detects language from file extension

---

## 🐛 Bug Fixes

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Chat dropdown silent fail | `filterChatBySource` not on `window` | Added to `Object.assign(window, {})` |
| hljs "unescaped HTML" warning | `escapeHtml` decoded by `innerHTML` | `textContent` via placeholder replacement |
| HCI Office spawn storm | Polling 2s spawning `hermes status` | Backend hybrid + frontend 30s interval |

---

## 📦 Ships With

| File | What |
|------|------|
| `src/js/pages/office.js` | Office v3 page loader |
| `src/js/office-kanban.js` | Full kanban + popup + event panel |
| `src/css/office.css` | 1240 lines — Office v3 styling |
| `src/js/chat/cli.js` | Chat render + highlight.js fix |
| `src/js/chat/core.js` | Chat session management |
| `src/js/chat/gateway.js` | Gateway WebSocket bridge |
| `src/js/chat/websocket.js` | WebSocket client |
| `src/js/core/*` | API, auth, navigation, state, utils |
| `src/js/components/*` | Modal, toast, notifications |
| `src/js/pages/*` | 12 pages — full HCI suite |
| `server.js` | Workspace file endpoint + agent-states hybrid |
| `src/public/*` | PWA manifest + service worker + icons |
| `tests/*` | Auth + Office test suites |

**Total:** 23 modified + 13 new = **36 files** · 2,261+ / 8,194-

---

## 🏷️ Tag

```bash
git tag -a v3.6.0 -m "HCI v3.6.0 — Office v3 ZOO Swarm Monitor"
```

**Tag message:**
```
HCI v3.6.0 — Office v3 ZOO Swarm Monitor

Features:
- Office v3: 3-panel swarm dashboard (Agents · Kanban · Live Feed)
- Kanban task detail popup v2 (runs, workspace files, events, timeline)
- Live Feed filter/search (agent dropdown + keyword)
- Unified HCI dropdown selects (light/dark mode)
- highlight.js code block security fix
- aaPanel nginx auto-start on reboot

Performance:
- Office polling: 2s → 30s + in-flight guard
- Agent states: config.yaml + kanban.db (~100ms, zero subprocess)

Fixes:
- Chat dropdown not firing
- Usage agent dropdown duplicates
- hljs "unescaped HTML" warning
- Spawn storm from rapid polling
```

---

## 📋 Commit Checklist

- [ ] Review all 36 files
- [ ] `git add` all modified + new files
- [ ] `git commit -m "feat: HCI v3.6.0 — Office v3 + popup v2 + Live Feed + design system"`
- [ ] `git tag -a v3.6.0 -m "..."  `
- [ ] `git push origin main --tags`
- [ ] King approval
- [ ] Deploy to prod: `git pull origin main` on production server
- [ ] Restart HCI prod
- [ ] Verify agent.panji.me loads Office v3
