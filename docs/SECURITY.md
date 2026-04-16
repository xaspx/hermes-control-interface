# Security Analysis

## Authentication

**Password storage:** Plaintext comparison against the value in `HERMES_CONTROL_PASSWORD`. The password itself is never stored — only the live environment variable. Use a long, random value in production.

**Password comparison:** Uses `crypto.timingSafeEqual` to prevent timing oracle attacks. This eliminates timing side-channels in the comparison itself.

**Auth tokens:** HMAC-SHA256 signed tokens stored in an HttpOnly cookie. Tokens contain a Unix timestamp and are valid for 24 hours. The signature prevents tampering or forgery.

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

## What This Is Not

- **Not multi-user.** All browser sessions share the same password. Treat it like a root password.
- **Not hardened for hostile networks.** Designed for trusted LANs or HTTPS-reverse-proxied deployments.
- **Not audited.** This analysis is a surface-level review, not a formal security audit.

## Recommendations for Production

1. **Use HTTPS.** Always. Either behind an nginx reverse-proxy or on a platform that provides TLS.
2. **Use a strong, randomly generated password.** Minimum 32 characters.
3. **Rotate secrets periodically.** A rotated `HERMES_CONTROL_SECRET` invalidates all existing sessions.
4. **Don't expose to the public internet** without a reverse-proxy and rate limiting.
5. **Consider IP allowlisting** at the firewall or nginx level if access is limited to specific IPs.
