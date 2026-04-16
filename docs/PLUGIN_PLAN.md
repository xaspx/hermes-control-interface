# HCI Plugin Architecture + Monetization Plan

## Date: 2026-04-16

## Vision
HCI becomes the "VS Code of Hermes" — extensible, plugin-driven, marketplace.

## Plugin System

### How it works
- Skills can include `ui/manifest.json` to register UI pages
- HCI discovers plugins by scanning `~/.hermes/skills/*/ui/manifest.json`
- Plugin pages loaded dynamically into nav
- Plugin API routes served under `/plugins/:id/`

### Manifest Format
```json
{
  "id": "llm-wiki",
  "name": "LLM Wiki",
  "version": "1.0.0",
  "description": "Knowledge base with RAG",
  "premium": false,
  "price": null,
  "pages": [
    {
      "id": "wiki",
      "label": "Wiki",
      "icon": "📚",
      "nav": "main",
      "entry": "ui/wiki.html"
    }
  ],
  "api": {
    "prefix": "/api/wiki",
    "routes": "ui/routes.js"
  },
  "permissions": ["files.read", "files.write"]
}
```

### Skill Directory Structure
```
~/.hermes/skills/research/llm-wiki/
├── SKILL.md
├── ui/
│   ├── manifest.json
│   ├── wiki.html
│   ├── wiki.js
│   └── wiki.css
├── scripts/
│   └── process.py
└── data/
    └── wiki.db
```

## Monetization

### Model: Open Core + Premium Content
- Plugin loader + license system: open source
- Premium UI components: paid via license server

### Premium Gating
- Free: CLI skills (always open source)
- Premium: HCI UI pages (encrypted, license-gated)
- License stored locally in `~/.hermes/licenses.json`
- Validated against license server periodically

### Pricing
- LLM-Wiki Pro: $9.99 one-time
- Analytics Dashboard: $4.99 one-time
- Multi-Agent Builder: $14.99 one-time
- HCI Pro (all): $19.99/mo
- HCI Team (5 users): $49.99/mo

### Payment
- Stripe Checkout (embedded)
- License server (separate, private)
- No payment handling in HCI core

### Anti-Piracy
- Level 2: UI assets encrypted, decrypted with token
- Level 3: Periodic license validation (24h)
- Degrade to trial mode if validation fails

## Implementation Priority

### Phase 1: Foundation (NOW)
- Plugin manifest discovery
- Plugin API endpoint
- Dynamic nav loading

### Phase 2: Chat Feature (NOW)
- Backend: webhook proxy + SSE streaming
- Frontend: chat UI with tool calls, status bar
- Theme matching (dark mode, gold accent)

### Phase 3: LLM-Wiki Plugin (NEXT)
- First plugin with UI pages
- File upload, processing, search
- Proof of concept for plugin system

### Phase 4: License Server (WHEN READY)
- Stripe integration
- Token generation/validation
- Premium skill gating

## Killer Features
1. Chat (webhook-based, streaming, tool calls)
2. LLM-Wiki (knowledge-augmented chat)
3. Plugin system (extensible UI)
4. Multi-agent orchestration (visual pipeline)
5. Cost tracking per user (team billing)
