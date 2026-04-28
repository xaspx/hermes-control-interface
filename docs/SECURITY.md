# Security Analysis

## Authentication

**Password storage:** Dashboard users are stored in `~/.hermes/hci-users.json` with bcrypt password hashes. Plaintext passwords are not stored.

**Password comparison:** Uses `bcrypt.compareSync()` against the stored password hash.

**Auth tokens:** HMAC-SHA256 signed tokens stored in an HttpOnly cookie. Tokens contain a Unix timestamp and are valid for 24 hours. The signature prevents tampering or forgery.

**Rate limiting:** IPs are blocked from authenticating after 5 failed attempts within a 15-minute window. This does not prevent brute-force attacks entirely but significantly raises the cost.

**Weaknesses:**
- Local filesystem user store (no external identity provider)
- No MFA
- No login attempt notification (could silently tolerate brute force if attacker has enough time)

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

- **Not enterprise identity.** Users are managed in a local JSON store, not LDAP/OIDC/SAML.
- **Not hardened for hostile networks.** Designed for trusted LANs or HTTPS-reverse-proxied deployments.
- **Not audited.** This analysis is a surface-level review, not a formal security audit.

## Recommendations for Production

1. **Use HTTPS.** Always. Either behind an nginx reverse-proxy or on a platform that provides TLS.
2. **Use strong per-user passwords.** Minimum 8 characters; longer is better.
3. **Rotate secrets periodically.** A rotated `HERMES_CONTROL_SECRET` invalidates all existing sessions.
4. **Don't expose to the public internet** without a reverse-proxy and rate limiting.
5. **Consider IP allowlisting** at the firewall or nginx level if access is limited to specific IPs.
