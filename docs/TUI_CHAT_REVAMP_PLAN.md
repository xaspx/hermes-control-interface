# HCI Chat Full Revamp — TUI Integration Plan

**Scope:** HCI Staging (`/root/projects/hci-staging`)  
**Target:** Port 10274  
**Approach:** TUI Gateway Bridge (JSON-RPC → WebSocket)  
**Design:** OpenWebUI-style bubble chat, fully responsive  
**Effort:** ~800-1000 lines (backend 350 + frontend 450 + CSS 200)  
**Timeline:** 6 Phases, ~5-7 hari aktif  

---

## Architecture

### TUI Gateway Bridge

```
Browser (HCI) ←──WSS──→ Node Backend ←──JSON-RPC──→ Python tui_gateway.entry
                                                          ↓
                                                    Hermes Agent
```

- **Backend** spawn `python -m tui_gateway.entry` per profile
- **JSON-RPC** over stdin/stdout (line-delimited)
- **WebSocket** broadcast events to authenticated browsers
- **Per-profile isolation** — default, david, soci, cuan

### Why TUI over Gateway API?

| Feature | Gateway API | TUI |
|---------|-------------|-----|
| Text streaming | ✅ | ✅ |
| Tool progress | ✅ (limited) | ✅✅ (rich) |
| Thinking stream | ⚠️ (reasoning.delta only) | ✅✅ (full thinking panel) |
| Clarify | ❌ | ✅ (native modal) |
| Approval | ❌ | ✅ (native dialog) |
| Sudo/Secret | ❌ | ✅ (native prompt) |
| Subagent progress | ❌ | ✅ (live tracking) |
| Status updates | ❌ | ✅ (real-time bar) |

---

## Design Philosophy

### OpenWebUI + Telegram Hybrid

- **Bubble chat** — user di kanan (accent color), assistant di kiri (darker bg)
- **Avatar + name** — tiap bubble punya avatar agent dan timestamp
- **Thinking panel** — collapsible, stream real-time reasoning
- **Tool progress** — inline badges "⚡ Using terminal..." expand on click
- **Status bar** — bottom sticky: model, status, tokens, context usage
- **Input area** — sticky bottom, auto-expand textarea, send + stop
- **System messages** — center-aligned, muted ("Pxnji changed the model")

### Responsive Breakpoints

```
Mobile (< 640px):   Full-width bubbles, collapsible sidebar, bottom nav
Tablet (640-1024):  Sidebar collapsible, 80% bubble max-width
Desktop (> 1024):   Fixed sidebar, 70% bubble max-width, hover effects
```

### Color Palette (Existing)

- Gold `#ffac02` — accent, user bubbles, active states
- Teal `#4ecdc4` — assistant bubbles border, success
- Coral `#ff6b6b` — error, destructive
- Purple `#a78bfa` — thinking panel, subagent
- Green `#34d399` — success, tool complete

---

## Phase 0: Foundation Cleanup (1 hari)

**Goal:** Siapkan codebase sebelum TUI integration

### Tasks

1. **Commit existing WS changes**
   ```bash
   git add -A
   git commit -m "feat(ws): gateway API streaming foundation (checkpoint)"
   ```

2. **Backup old WS bridge**
   - Rename `handleWsChatStart` → `handleGatewayApiChatStart`
   - Keep as fallback kalau TUI down

3. **Remove dead code**
   - Hapus `PLAN-websocket-chat-revamp.md` (outdated)
   - Bersihkan console.log debug

4. **Verify build**
   ```bash
   npm run build
   # Fix errors
   ```

### Deliverables
- [ ] Clean git state, 1 commit ahead
- [ ] Build passes
- [ ] Staging restart & basic test OK

---

## Phase 1: TUI Gateway Bridge Backend (1-2 hari)

**Goal:** Spawn TUI gateway, parse JSON-RPC, broadcast via WS

### Tasks

1. **Create `lib/tui-gateway-bridge.js`**

```js
class TuiGatewayBridge {
  constructor(profile = 'default') {
    this.profile = profile;
    this.proc = null;
    this.clients = new Set(); // WS sockets
    this.ready = false;
    this.reqId = 0;
    this.pending = new Map();
    this.bufferedEvents = [];
  }

  start() {
    // spawn python -m tui_gateway.entry
    // set HERMES_CWD, PYTHONPATH, profile env
    // parse stdout JSON-RPC lines
    // parse stderr → log + gateway.stderr event
  }

  dispatch(msg) {
    // id match → resolve pending RPC
    // method === 'event' → publish to all WS clients
  }

  request(method, params) {
    // JSON-RPC request with timeout
  }

  broadcast(event) {
    // Send to all connected WS clients
  }

  kill() {
    // Graceful shutdown
  }
}
```

2. **Integrate with existing `/ws` endpoint**
   - On WS connect → subscribe to TuiGatewayBridge
   - On `chat.start` → forward to TUI via `session.sendPrompt`
   - On `chat.stop` → forward `session.interrupt`
   - On `clarify.respond` → forward `clarify.respond`
   - On `approval.respond` → forward `approval.respond`
   - On `sudo.respond` → forward `sudo.respond`
   - On `secret.respond` → forward `secret.respond`

3. **Event transformation**
   TUI events → WS events (same shape, frontend-compatible):
   ```
   thinking.delta → chat.thinking
   message.delta → chat.text
   message.complete → chat.done
   tool.start → chat.tool.start
   tool.progress → chat.tool.progress
   tool.complete → chat.tool.done
   clarify.request → chat.clarify
   approval.request → chat.approval
   sudo.request → chat.sudo
   secret.request → chat.secret
   subagent.* → chat.subagent.*
   error → chat.error
   ```

4. **Session lifecycle**
   - `session.create` on first message
   - `session.resume` untuk session existing
   - `session.interrupt` untuk stop
   - Auto-flush on disconnect

### Deliverables
- [ ] `TuiGatewayBridge` class working
- [ ] WS clients receive TUI events
- [ ] Auth + profile isolation
- [ ] Fallback ke Gateway API kalau TUI crash

### Files Modified
- `server.js` (integrate bridge)
- `lib/tui-gateway-bridge.js` (new)

---

## Phase 2: Frontend Event Router (1 hari)

**Goal:** Browser handle semua TUI events

### Tasks

1. **Update `ws-client.js`**
   - Tambah method-specific handlers:
     ```js
     wsClient.on('chat.thinking', handler)
     wsClient.on('chat.tool.start', handler)
     wsClient.on('chat.clarify', showClarifyModal)
     wsClient.on('chat.approval', showApprovalModal)
     wsClient.on('chat.sudo', showSudoPrompt)
     wsClient.on('chat.secret', showSecretPrompt)
     ```

2. **Create `src/js/chat-event-router.js`**
   - Map semua 30+ event types ke UI actions
   - State machine untuk chat lifecycle:
     ```
     idle → starting → thinking → tool → message → complete → idle
     ```

3. **Modal handlers**
   - `showClarifyModal(question, choices, requestId)`
   - `showApprovalModal(command, description)`
   - `showSudoPrompt(requestId)`
   - `showSecretPrompt(envVar, prompt, requestId)`
   - Semua pakai `showModal()` (themed, bukan native)

4. **Subagent tracking**
   - Panel kecil di sidebar showing active subagents
   - Real-time progress dari `subagent.*` events

### Deliverables
- [ ] All events routed correctly
- [ ] Modals work (clarify, approval, sudo, secret)
- [ ] Subagent panel visible

### Files Modified
- `src/js/ws-client.js`
- `src/js/chat-event-router.js` (new)
- `src/js/main.js` (integrate router)

---

## Phase 3: Chat UI Revamp — Bubble Layout (1-2 hari)

**Goal:** OpenWebUI-style bubble chat

### Tasks

1. **Bubble CSS (`src/css/chat.css`)**
   ```css
   .chat-msg { display: flex; margin: 8px 0; }
   .msg-user { justify-content: flex-end; }
   .msg-assistant { justify-content: flex-start; }
   .msg-bubble {
     max-width: 70%;
     padding: 12px 16px;
     border-radius: 16px;
     line-height: 1.6;
   }
   .msg-user .msg-bubble {
     background: var(--gold);
     color: #000;
     border-bottom-right-radius: 4px;
   }
   .msg-assistant .msg-bubble {
     background: var(--bg-card);
     border: 1px solid var(--border);
     border-bottom-left-radius: 4px;
   }
   ```

2. **Avatar + Header**
   - Assistant: 🤖 icon + "Hermes" label
   - User: 👤 icon + username
   - Timestamp di header

3. **Thinking Panel**
   - Collapsible di atas chat
   - Stream `thinking.delta` real-time
   - Auto-collapse saat `message.start`
   - Toggle button: "💭 Show thinking"

4. **Tool Progress**
   - Inline badge: "🔧 terminal_tool — Running..."
   - Expandable preview dari `tool.progress`
   - Success ✅ / Fail ❌ indicator
   - Hover/click untuk detail

5. **Status Bar**
   - Sticky bottom, di atas input
   - Model name, status text, token count
   - Context usage bar (progress)
   - Update dari `session.info` + `status.update`

6. **Input Area**
   - Auto-expand textarea (max 5 rows)
   - Send button (➤) + Stop button (⏹)
   - Keyboard: Enter send, Shift+Enter newline
   - Draft message persist per session

### Deliverables
- [ ] Bubble layout renders
- [ ] Thinking panel streams
- [ ] Tool badges show progress
- [ ] Status bar live update
- [ ] Input area polished

### Files Modified
- `src/css/chat.css` (major rewrite)
- `src/js/main.js` (chat render logic)
- `src/index.html` (chat markup tweaks)

---

## Phase 4: Interactive Features (1 hari)

**Goal:** Clarify, approval, sudo, secret — native HCI modals

### Tasks

1. **Clarify Modal**
   - Title: "Clarification Needed"
   - Question text
   - Choice buttons (kalau ada choices)
   - Free-text input (kalau open-ended)
   - Send → `wsClient.send({ type: 'clarify.respond', ... })`

2. **Approval Dialog**
   - Title: "Approval Required"
   - Command preview (code block)
   - Description text
   - Approve ✅ / Deny ❌ buttons
   - Send → `wsClient.send({ type: 'approval.respond', ... })`

3. **Sudo Prompt**
   - Title: "Sudo Password"
   - Password input (masked)
   - Submit → `wsClient.send({ type: 'sudo.respond', ... })`

4. **Secret Prompt**
   - Title: "Secret Required"
   - Show env_var name
   - Prompt text
   - Input field
   - Submit → `wsClient.send({ type: 'secret.respond', ... })`

5. **Queue Input**
   - User bisa type saat agent busy
   - Queue count badge di input
   - Auto-send pas agent idle

### Deliverables
- [ ] All 4 modals work end-to-end
- [ ] Queue input functional
- [ ] Events flow TUI → HCI → TUI

### Files Modified
- `src/js/main.js` (modal handlers)
- `src/css/chat.css` (modal styles)

---

## Phase 5: Session Management & Sidebar (1 hari)

**Goal:** Sidebar redesign, session organization

### Tasks

1. **Sidebar Redesign**
   - Collapsible (toggle button)
   - Search bar (filter sessions)
   - Group by date: Today, Yesterday, Earlier
   - Pin/unpin sessions
   - Delete session (modal confirm)

2. **Session Metadata**
   - Title, message count, last active
   - Source tag (TUI / Gateway / CLI)
   - Token usage preview
   - Model icon

3. **Draft Messages**
   - Save unsent text per session
   - Restore saat buka session
   - Clear saat sent

4. **New Chat Button**
   - Prominent di atas sidebar
   - Shortcut: Cmd/Ctrl + N

### Deliverables
- [ ] Sidebar collapsible
- [ ] Session grouping
- [ ] Pin sessions
- [ ] Draft messages persist

### Files Modified
- `src/css/chat.css` (sidebar styles)
- `src/js/main.js` (session management)

---

## Phase 6: Polish & Responsive (1 hari)

**Goal:** Production-ready, semua device

### Tasks

1. **Virtual Scroll**
   - Untuk chat > 100 messages
   - IntersectionObserver-based
   - Keep scroll position saat streaming

2. **Mobile Optimizations**
   - Full-width bubbles
   - Bottom nav (chat, sidebar, settings)
   - Swipe gestures (swipe right = sidebar)
   - Touch-friendly buttons (min 44px)

3. **Keyboard Shortcuts**
   - Cmd/Ctrl + Enter = send
   - Esc = stop / close modal
   - Cmd/Ctrl + K = search sessions
   - Cmd/Ctrl + N = new chat
   - Cmd/Ctrl + [ = toggle sidebar

4. **Animations**
   - Bubble appear: fadeIn + scale
   - Thinking pulse: CSS animation
   - Tool badge slide-in
   - Status bar transition
   - Modal backdrop fade

5. **Error Handling**
   - TUI crash → auto-restart (max 3 retries)
   - WS disconnect → banner "Reconnecting..."
   - Gateway API fallback
   - Graceful degradation

6. **Performance**
   - Debounce thinking.delta (100ms)
   - Batch DOM updates (requestAnimationFrame)
   - Lazy load old messages
   - Code split chat module

### Deliverables
- [ ] Virtual scroll smooth
- [ ] Mobile usable
- [ ] Keyboard shortcuts work
- [ ] Animations smooth
- [ ] Errors handled gracefully

### Files Modified
- `src/css/chat.css` (animations, responsive)
- `src/js/main.js` (virtual scroll, shortcuts)
- `src/js/ws-client.js` (reconnect, fallback)

---

## Phase 7: QA → Prod (1 hari)

### QA Checklist

- [ ] Login → WS connects → TUI gateway ready
- [ ] Chat biasa → message streaming dengan bubble
- [ ] Tool call → progress badge visible
- [ ] Thinking → panel muncul + streaming
- [ ] Clarify → modal muncul, bisa jawab, lanjut chat
- [ ] Approval → dialog muncul, approve/deny works
- [ ] Sudo → prompt muncul, password accepted
- [ ] Secret → prompt muncul, secret accepted
- [ ] Subagent → panel update real-time
- [ ] Queue → input pas busy works
- [ ] Sidebar → collapsible, search, group, pin
- [ ] Mobile → layout OK, touch friendly
- [ ] WS disconnect → auto-reconnect
- [ ] TUI crash → fallback ke Gateway API
- [ ] Session panjang → virtual scroll smooth
- [ ] Keyboard shortcuts → all work

### Sync ke Prod

1. Commit dev → push GitHub
2. King approve → merge main
3. Bump version
4. Rebuild + restart prod
5. Release (King)

---

## Risk & Mitigation

| Risk | Mitigation |
|------|-----------|
| TUI process crash | Auto-restart (max 3), fallback ke Gateway API |
| Memory leak (WS clients) | Heartbeat, auto-close stale |
| Event flood (thinking.delta) | Debounce 100ms + batch |
| Mobile layout break | Test tiap phase di devtools mobile |
| Performance lag | Virtual scroll, lazy load, RAF batching |
| TUI version mismatch | Pin hermes-agent version, test before update |

---

## Effort Breakdown

| Phase | Backend | Frontend | CSS | Total |
|-------|---------|----------|-----|-------|
| 0 | — | — | — | — |
| 1 | ~200 lines | — | — | ~200 |
| 2 | ~50 lines | ~150 lines | — | ~200 |
| 3 | — | ~200 lines | ~150 lines | ~350 |
| 4 | — | ~100 lines | ~30 lines | ~130 |
| 5 | — | ~80 lines | ~50 lines | ~130 |
| 6 | — | ~100 lines | ~80 lines | ~180 |
| 7 | — | testing | — | — |
| **Total** | **~250** | **~630** | **~310** | **~1190** |

---

## Next Steps

1. **King review plan** → approve/modify/cancel
2. **Phase 0** → Commit current WS changes
3. **Phase 1** → Build TUI Gateway Bridge
4. **Per-phase demo** → test sebelum lanjut
5. **No release until King approves**
