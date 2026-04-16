# HCI Security Audit Report

**Project:** Hermes Control Interface (HCI)
**Version:** 3.3.0
**Audit Date:** 2026-04-17
**Auditor:** Hermes Orchestrator
**Repository:** https://github.com/xaspx/hermes-control-interface

---

## Overall Security Posture: 7.0 / 10

The HCI codebase demonstrates solid security fundamentals with proper password hashing (bcrypt), CSRF protection with timing-safe comparison, comprehensive input allowlist sanitization, path traversal prevention, and audit logging. Critical gaps in XSS sanitization on the home page and missing admin-gating on some endpoints lower the score from what would otherwise be an 8+.

---

## Top 5 Critical Issues

### 1. [HIGH] XSS in Home Page — `loadHomeCards()` (main.js:825-840)

**Location:** `src/js/main.js` lines 825-840

**Description:** The `loadHomeCards()` function renders API response data directly into innerHTML without escaping. Values like `hermesVersion`, `hciVersion`, `nodeVersion`, `cpu`, and `ram` are inserted via template literals. If any of these values originate from an attacker-controlled source (e.g., a compromised Hermes version string, manipulated `state.db`, or manipulated environment variable output), they could execute arbitrary JavaScript.

**Severity:** High — Requires an attacker with some degree of control over data displayed on the home dashboard, or a supply-chain-style compromise of version strings.

**Proof of Concept:**
```javascript
// If hermesVersion contained: <img src=x onerror=alert(document.cookie)>
el.innerHTML = `...<div class="stat-row"><span class="stat-label">Hermes</span><span class="stat-value">${hermesVersion}</span></div>...`;
// Would execute JavaScript in the context of the HCI page
```

**Remediation:**
```javascript
// Escape all dynamic values before innerHTML insertion
el.innerHTML = `
  <div class="card-title">HCI</div>
  <div class="stat-row"><span class="stat-label">Version</span><span class="stat-value">${escapeHtml(hciVersion)}</span></div>
  <div class="stat-row"><span class="stat-label">Hermes</span><span class="stat-value">${escapeHtml(hermesVersion)}</span></div>
  <div class="stat-row"><span class="stat-label">Node</span><span class="stat-value">${escapeHtml(nodeVersion)}</span></div>
  <div class="stat-row"><span class="stat-label">CPU</span><span class="stat-value">${escapeHtml(cpu)}%</span></div>
  <div class="stat-row"><span class="stat-label">RAM</span><span class="stat-value">${escapeHtml(ram)}</span></div>
  <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value ${isHealthy ? 'status-ok' : 'status-off'}">${isHealthy ? '● Healthy' : '○ Error'}</span></div>
  ...
`;
```

**Status:** Fixed in v3.3.0 (commit b6e931c). All dynamic values now escaped with `escapeHtml()`.

---

### 2. [MEDIUM] Missing Admin Gating on `GET /api/plugins`

**Location:** `server.js:244`

**Description:** `GET /api/plugins` requires only `requireAuth` (any authenticated user), but plugin listings may reveal information about installed premium/locked plugins that should be admin-only.

**Current:**
```javascript
app.get('/api/plugins', requireAuth, (req, res) => { ... })
```

**Remediation:**
```javascript
app.get('/api/plugins', requireRole('admin'), (req, res) => { ... })
```

**Status:** Fixed in v3.3.0 (commit b6e931c). `requireRole('admin')` added to `GET /api/plugins`.

---

### 3. [MEDIUM] Missing Rate Limiting on `/api/terminal/exec`

**Location:** `server.js:2159`

**Description:** The terminal execution endpoint is protected by auth + CSRF + permission but has no rate limiting. An authenticated user with `terminal.exec` permission could exhaust server resources with rapid command execution.

**Remediation:** Apply `express-rate-limit` with a lower limit specifically for this endpoint:
```javascript
const terminalRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 commands per minute per IP
  keyGenerator: (req) => getClientIp(req),
});

app.post('/api/terminal/exec', terminalRateLimiter, requireAuth, requireCsrf, requirePerm('terminal.exec'), async (req, res) => { ... });
```

**Status:** Fixed in v3.3.0 (commit bb10c51). `terminalRateLimiter` added: 30 commands/minute per IP.

---

### 4. [MEDIUM] CSP Allows `unsafe-inline` for Scripts and Script Attributes

**Location:** `server.js:181-195`

**Description:** The Content Security Policy uses `'unsafe-inline'` for both `scriptSrc` and `scriptSrcAttr`. This significantly weakens XSS protection by allowing inline script execution. Since HCI is a single-page app built with Vite (hashed JS bundles), the inline scripts should not be necessary in production.

**Current:**
```javascript
scriptSrc: ["'self'", "'unsafe-inline'"],
scriptSrcAttr: ["'unsafe-inline'"],
```

**Remediation:**
```javascript
scriptSrc: ["'self'"],  // Vite hashed bundles are safe
scriptSrcAttr: null,    // Disable inline event handlers
```

**Note:** This will break any `<button onclick="...">` inline handlers in the HTML. Vite's modern approach uses `addEventListener` in JS instead. The frontend should be audited for inline `onclick` handlers and migrated to proper event listeners before removing `unsafe-inline`.

**Status:** Long-term fix — requires frontend migration.

---

### 5. [MEDIUM] Token Expiry Not Enforced on Sessions

**Location:** `server.js:489`

**Description:** Auth tokens include a 24-hour timestamp check (`Date.now() - Number(ts) > 24 * 60 * 60 * 1000`), but the `tokenToUser` Map is never cleaned up. Tokens remain valid in the Map even after 24 hours until server restart, allowing expired tokens to remain usable.

**Remediation:**
```javascript
// Add periodic cleanup of expired tokens
setInterval(() => {
  const now = Date.now();
  for (const [token, user] of tokenToUser.entries()) {
    const [ts] = token.split('.');
    if (now - Number(ts) > 24 * 60 * 60 * 1000) {
      tokenToUser.delete(token);
    }
  }
}, 60 * 60 * 1000); // Run every hour
```

**Status:** Fixed in v3.3.0 (commit bb10c51). `setInterval()` added every 15 minutes to clean up expired tokens.

---

## Complete Findings by Category

### Authentication & Sessions

| # | Severity | Location | Issue | Status |
|---|----------|----------|-------|--------|
| A1 | Medium | server.js:489 | Token expiry not enforced — `tokenToUser` Map not cleaned up | Fix recommended |
| A2 | Low | server.js:131 | Cookie lacks `Max-Age` on `Secure` variant — only sets Path/Max-Age on non-secure path | Cosmetic |
| A3 | Info | auth.js:12 | `SALT_ROUNDS = 10` — bcrypt cost factor. Modern recommendation is 12. Consider upgrading. | Future consideration |

### Authorization & RBAC

| # | Severity | Location | Issue | Status |
|---|----------|----------|-------|--------|
| B1 | Medium | server.js:244 | `GET /api/plugins` missing `requireRole('admin')` | Fix immediately |
| B2 | Info | server.js:1421 | `requirePerm` skips permission check for admin role (expected behavior) | OK |
| B3 | Info | auth.js:161-163 | Existing users without `permissions` field get permissions resolved dynamically | OK — auto-migration |

### Input Validation & Injection

| # | Severity | Location | Issue | Status |
|---|----------|----------|-------|--------|
| C1 | High | main.js:825-840 | XSS — dynamic values in `innerHTML` without escaping | Fix immediately |
| C2 | Low | server.js:282 | Chat message uses manual single-quote escaping (`'\\''`) instead of `shellQuote()`. Functionally safe but inconsistent. | Use `shell_quote()` from hermes_tools |
| C3 | Info | server.js:710-733 | All critical inputs use allowlist regex sanitization | Good practice |

### Command Injection

| # | Severity | Location | Issue | Status |
|---|----------|----------|-------|--------|
| D1 | Low | server.js:77-101 | `shell()` uses `bash -lc` with raw command string interpolation. All user-adjacent inputs are sanitized, but hermes CLI args (lines 287, 918, 1032, etc.) use simple string concatenation. | Acceptable — inputs sanitized via `sanitizeProfileName`, `sanitizeSessionId`, etc. |
| D2 | Info | server.js:282 | Chat message manual escaping works but `shellQuote()` would be more robust | Recommend using `shell_quote()` |

### XSS

| # | Severity | Location | Issue | Status |
|---|----------|----------|-------|--------|
| E1 | High | main.js:825-840 | Home dashboard renders unescaped API response data | Fix immediately |
| E2 | Low | main.js:190,226 | `container.innerHTML` with hardcoded static HTML strings | OK — no dynamic content |
| E3 | Info | main.js:708 | `renderChatContent()` correctly escapes with `escapeHtml()` before markdown-like rendering | Good |
| E4 | Info | main.js:396-397 | Session list correctly uses `escapeHtml()` on `title` | Good |

### CSRF

| # | Severity | Location | Issue | Status |
|---|----------|----------|-------|--------|
| F1 | Info | server.js:514-523 | CSRF uses `safeTimingEqual` (timing-safe comparison) | Good |
| F2 | Info | server.js:517-522 | Debug `console.error` logs CSRF failures server-side only (not client-exposed) | Good |

### Rate Limiting

| # | Severity | Location | Issue | Status |
|---|----------|----------|-------|--------|
| G1 | Medium | server.js:2159 | `/api/terminal/exec` has no per-IP rate limit | Add rate limiter |
| G2 | Info | server.js:536-549 | Login endpoint has 5 attempts/15 minutes rate limit | Good |
| G3 | Info | server.js | No global API rate limit for authenticated endpoints | Consider global rate limit |

### Secrets & Configuration

| # | Severity | Location | Issue | Status |
|---|----------|----------|-------|--------|
| H1 | Info | server.js:104-105 | `CONTROL_PASSWORD` and `CONTROL_SECRET` read from env (not hardcoded) | Good |
| H2 | Info | .gitignore | `.env`, `dist/`, `node_modules/` all properly gitignored | Good |

### Dependencies

| # | Severity | Package | Issue | Status |
|---|----------|---------|-------|--------|
| I1 | Low | `bcrypt ^6.0.0` | Uses `node-addon-api` — native addon. CVEs in native addons possible. | Monitor |
| I2 | Low | `multer ^2.1.1` | File upload middleware — ensure proper size limits are enforced | Review |
| I3 | Low | `node-pty ^1.1.0` | PTY spawning — native addon. Could have privilege escalation if exploited. | Monitor |
| I4 | Info | `helmet ^8.1.0` | Latest major version | OK |
| I5 | Info | `express ^4.18.2` | LTS but v4 has known issues in edge cases. Consider v5. | Future |
| I6 | Info | `ws ^8.18.0` | No known CVEs at time of audit | OK |

### Security Headers & CORS

| # | Severity | Location | Issue | Status |
|---|----------|----------|-------|--------|
| J1 | Medium | server.js:185-186 | CSP allows `'unsafe-inline'` for scripts — weakens XSS protection | Fix after inline handler migration |
| J2 | Low | server.js:194 | HSTS disabled (appropriate for dev/internal tool) | OK for HTTP deployments |
| J3 | Info | server.js:190 | `connectSrc` allows `ws:` and `wss:` — necessary for WebSocket log streaming | OK |

### File Operations

| # | Severity | Location | Issue | Status |
|---|----------|----------|-------|--------|
| K1 | Info | server.js:735-738 | `isAllowedPath()` uses `path.resolve` + `startsWith` for path traversal prevention | Good |
| K2 | Info | server.js:2331 | Avatar upload validates `data:image/*;base64,` prefix | Good |

### Error Handling

| # | Severity | Location | Issue | Status |
|---|----------|----------|-------|--------|
| L1 | Info | server.js | No `error.stack` exposure in API responses | Good |
| L2 | Info | server.js:364 | `e.message` returned in `/api/models` — safe, just the message | OK |

---

## Remediation Roadmap

### Immediate (Before Open Source Release)

1. **Fix XSS in `loadHomeCards()`** — Add `escapeHtml()` to all dynamic values
2. **Add `requireRole('admin')` to `GET /api/plugins`** — 1-line fix
3. **Add rate limiter to `/api/terminal/exec`** — 5-line addition

### Short-term (Before v1.0 Release)

4. Migrate inline `onclick` handlers to `addEventListener` in JS
5. Remove `'unsafe-inline'` from CSP after migration
6. Add periodic cleanup of expired auth tokens from `tokenToUser`
7. Add per-endpoint rate limiters for sensitive operations

### Long-term (Future Versions)

8. Upgrade `bcrypt` cost factor from 10 to 12
9. Consider upgrading to Express v5
10. Add `express-async-errors` for unhandled promise rejection handling
11. Implement resource-based rate limiting (per-user, not just per-IP)
12. Add Content-Type sniffing protection for avatar uploads

---

## Positive Security Findings

- bcrypt with 10 rounds for password hashing ✅
- Timing-safe CSRF token comparison (`crypto.timingSafeEqual`) ✅
- Allowlist input sanitization (`sanitizeProfileName`, `sanitizeSessionId`, etc.) ✅
- Path traversal prevention with `isAllowedPath()` ✅
- Audit logging for auth events and permission denials ✅
- HttpOnly + SameSite cookies ✅
- No stack trace leakage in API responses ✅
- Proper `.gitignore` of `.env`, credentials, and build artifacts ✅
- Permission-based access control with admin bypass only ✅
- Chat content properly escaped before HTML rendering ✅
- Session list items properly escaped ✅
- Login rate limiting (5 attempts / 15 min) ✅
- Command timeout on shell execution (8s default) ✅
- Max command length enforcement (4096 chars on terminal) ✅

---

*End of Security Audit Report*
