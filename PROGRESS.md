# HCI Revamp v2 — Progress

Branch: `revamp/v3`
Last updated: 2026-04-13 by david
Commits: 17 (lokal, belum push)

## Phase 1: Foundation ✅
- [x] All modules done

## Phase 2: Core Pages ✅
- [x] All modules done

## Phase 3: Supporting Pages ✅
- [x] All modules done

## Phase 4: Backend API ✅
- [x] Auth (login, logout, setup, change-password, users CRUD, providers)
- [x] System health, sessions, profiles, gateway, notifications, audit
- [x] Config (YAML parser), Memory, Skills
- [x] Doctor, Dump, Update
- [x] Sessions rename/export/delete (per-profile with `-p` flag)
- [x] File read/save API (`readFileSafe`/`writeFileSafe` resolve to ~/.hermes)
- [x] Agent status endpoint (parsed from `hermes status`)
- [x] System health alerts (disk/RAM/CPU with cooldown)
- [x] Platform parsing in insights

## Phase 5: Polish ✅
- [x] Responsive + mobile — hamburger nav, @768px/@480px breakpoints
- [x] Error handling — `api()` wrapper (401→logout, 429→rate limit, network→toast)
- [x] Alert system — bell icon + dropdown, server-side health alerts
- [x] Performance — smart polling backoff (30s → 60s → 120s)
- [x] Theme — custom palette (dark: #0b201f/#dccbb5/#7c945c, light: #e4ebdf/#0b201f/#2e6fb0)
- [x] Login background image (portal.nousresearch.com/hermes-agent-bg.jpg)
- [x] Header SVG logo (hermes-icon.svg)
- [x] Themed selects (.log-level-select with custom arrow)
- [x] Themed search inputs (.search-input)
- [x] Card grid 2-column layout

## Phase 5.1: Pages ✅
- [x] Home — System Health + Agent Overview + Gateways + Token Usage (7d)
- [x] Agents — agent list + create/clone/delete
- [x] Agent Detail — 6 tabs (Dashboard, Sessions, Gateway, Config, Memory, Cron)
- [x] Usage — full analytics (time range 1d/7d/30d/90d, agent filter, models/platforms/tools)
- [x] Skills — installed skills list (parsed from `hermes skills list`)
- [x] Maintenance — Doctor, Dump, Update, Users, Auth, Audit
- [x] File Explorer — split view (tree left + editor right), read + save

## Phase 5.2: Bug Fixes ✅
- [x] Auth 401 — checkAuth uses /api/auth/status first
- [x] Terminal ANSI garbage — Ctrl+C → clear → command flow (2000+500+500ms)
- [x] Terminal arrow keys — ANSI escape sequences (ArrowUp=\x1b[A, ArrowDown=\x1b[B)
- [x] Skills parsing — split by │, filter data rows only
- [x] Gateway status — system-level systemctl (not user-level)
- [x] CSRF — api() sends X-CSRF-Token on POST/PUT/DELETE
- [x] Sessions rename/delete — hermes -p <profile> flag, state.currentSessions lookup
- [x] Session cache — no fallback to old data for different profiles
- [x] File path — resolve relative to ~/.hermes (CONTROL_HOME)
- [x] File Explorer path — strip leading / and .. from paths
- [x] Uptime — added to /api/system/health response

## Phase 6: Release ← IN PROGRESS
- [x] QA testing (browser auto-test) — all 7 pages + file explorer + agent detail (6 tabs)
  - Login: ✅ no errors
  - Home: ✅ all 4 cards loading with real data
  - Agents: ✅ list, create, delete, set default
  - Agent Detail: ✅ all 6 tabs (Dashboard, Sessions, Gateway, Config, Memory, Cron)
  - Usage: ✅ filters work, models/platforms/tools breakdown
  - Skills: ✅ list with categories and source badges
  - Maintenance: ✅ Doctor, Dump, Update, Users, Auth, Audit
  - File Explorer: ✅ split view, read, save
  - Terminal: ✅ WebSocket, touch controls, fullscreen
  - Notifications: ✅ bell, badge, dropdown
  - Theme: ✅ dark/light toggle
  - Console errors: ✅ zero errors on all pages
- [ ] Sync staging → prod
- [ ] Major version commit + GitHub release (v3.0.0)

## Current State
- All 7 pages implemented and functional
- File Explorer: read + save working
- Theme: dark + light modes with custom palette
- Notifications: system alerts + CRUD actions + gateway events
- Source: src/ (Vite) → dist/ (served by server.js)
- Build: `npx vite build`
- 28 commits lokal, belum push ke GitHub
