# Security Analysis

## Authentication

**Password storage:** bcrypt hashing with cost factor 10. The password itself is never stored in plaintext — only the bcrypt hash in the auth database.

**Password comparison:** `bcrypt.compare()` — constant-time comparison, resistant to timing oracle attacks. No plaintext comparison ever occurs.

**Auth tokens:** Session cookie (`hermes...auth`) — HttpOnly, SameSite=Lax, optional Secure flag. No JWT or bearer tokens. Sessions are validated server-side on each request.

**Rate limiting:** IPs are blocked from authenticating after 5 failed attempts within a 15-minute window. This does not prevent brute-force attacks entirely but significantly raises the cost.

## Multi-User Access

**Multi-user via RBAC v2.** Role-Based Access Control with two built-in roles:

- **admin** — full access to all features including user management, system controls, and secrets
- **viewer** — read-only access to sessions, logs, and usage analytics

Create additional users via the Maintenance → Users panel. All users share the same login password format but have isolated permissions. Treat the admin password like a root password.

## Cookies

| Attribute | Value |
|---|---|
| `HttpOnly` | Yes — not accessible to JavaScript |
| `SameSite` | `Lax` — sent on top-level navigations and same-site subrequests |
| `Secure` | Yes — only sent over HTTPS |
| `Max-Age` | 86400 seconds (24 hours) |

The `Secure` flag means cookies are suppressed over plain HTTP. If you expose this service without HTTPS (e.g. direct LAN access on `http://`), the login cookie won't work. Use a reverse-proxy with TLS termination in front.

## File Operations

File read and write operations are scoped to the configured explorer roots. Path traversal attempts outside these roots are rejected with a `403`-style error.

```
isAllowedPath(filePath):
  resolve(filePath) must equal OR be inside resolve(root)
  for at least one configured root
```

The explorer also ignores `node_modules`, `.git`, and other sensitive directories.

## No External Network Access

The server makes no outbound HTTP requests. It only:
- reads local files within explorer roots
- spawns a PTY shell
- communicates over WebSocket with authenticated clients

## WebSocket

The `/ws` endpoint requires an authenticated session cookie. Unauthenticated WebSocket connections receive no data.

## Security Audit Status
- **Multi-user via RBAC v2.** 20 permissions, admin/viewer/custom roles.
- **CSRF protection** on all state-changing admin endpoints (21 endpoints protected).
- **Security audit completed** (2026-04-19): 18 findings addressed — see `SECURITY_AUDIT.md` for full report.
- **XSS audit completed** (2026-04-27): Comprehensive `escapeHtml()` audit — all 15+ error handlers fixed, code-first escape pattern verified in `renderChatContent()`.
- **Command injection hardened:** All shell execution points use `execHermes()` (no shell interpretation) or strict input validation.

## Recommendations for Production

1. **Use HTTPS.** Always. Either behind an nginx reverse-proxy or on a platform that provides TLS.
2. **Use a strong, randomly generated password.** Minimum 32 characters.
3. **Rotate secrets periodically.** A rotated `HERMES_CONTROL_SECRET` invalidates all existing sessions.
4. **Don't expose to the public internet** without a reverse-proxy and rate limiting.
5. **Consider IP allowlisting** at the firewall or nginx level if access is limited to specific IPs.
