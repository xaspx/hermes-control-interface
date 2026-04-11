# HCI Revamp v2 — Progress

Branch: `revamp/v2`
Last updated: 2026-04-12 by david

## Phase 1: Foundation
- [ ] Module 1.1: Project setup (Vite + vanilla JS init) ← NEXT
- [ ] Module 1.2: Theme system (dark/light CSS + toggle)
- [ ] Module 1.3: Layout skeleton (nav + content area)
- [ ] Module 1.4: Login page + auth backend
- [ ] Module 1.5: User Menu + notifications shell

## Phase 2: Core Pages
- [ ] Module 2.1: Home page
- [ ] Module 2.2: Agents page
- [ ] Module 2.3: Agent Detail — Dashboard tab
- [ ] Module 2.4: Agent Detail — Sessions tab
- [ ] Module 2.5: Agent Detail — Gateway tab
- [ ] Module 2.6: Agent Detail — Config tab (13 categories)
- [ ] Module 2.7: Agent Detail — Memory tab (dynamic)

## Phase 3: Supporting Pages
- [ ] Module 3.1: System Monitor
- [ ] Module 3.2: Skills Marketplace
- [ ] Module 3.3: Maintenance

## Phase 4: Polish
- [ ] Module 4.1: Notifications system
- [ ] Module 4.2: Audit log
- [ ] Module 4.3: Responsive + edge cases

## Phase 5: Release
- [ ] QA testing (browser auto-test)
- [ ] Sync staging → prod
- [ ] Major version commit + GitHub release

## Notes
- Theme: dark bg=#170d02 fg=#ffac02, light bg=#f5f0e8 fg=#170d02
- Stack: Vanilla JS + Vite + Node.js
- Auth: bcrypt + HMAC token, admin+viewer roles
- Config: 13 categories, 80+ settings
- Memory: dynamic based on provider
