# Configuration Reference

Hermes Control Interface can be configured in two complementary ways:

1. **`hci.config.yaml`** — declarative, version-controllable defaults (checked into git)
2. **Environment variables** — runtime overrides (never stored in plaintext)

Environment variables always take precedence over the YAML file, so secrets (password, secret, API keys) can be kept out of the config file and supplied via env.

---

## Quick Start

### Option A — Environment variables only

```bash
cp .env.example .env
# Fill in HERMES_CONTROL_PASSWORD and HERMES_CONTROL_SECRET
npm start
```

### Option B — YAML config file

```bash
# Create hci.config.yaml next to server.js
cp hci.config.yaml.example hci.config.yaml
# Fill in password and secret (all other keys are optional)
npm start
```

### Option C — YAML + env overrides

```bash
# hci.config.yaml provides defaults / shared config
# .env or systemd Environment= lines override secrets only
```

---

## `hci.config.yaml` Schema

Create `hci.config.yaml` in the repo root (next to `server.js`). All keys are optional unless noted.

```yaml
# ── Required ────────────────────────────────────────────────────────────

password: "your-long-random-password"          # REQUIRED
secret:   "your-hmac-secret"                  # REQUIRED

# ── Server ──────────────────────────────────────────────────────────────

port: 10272                                    # default: 10272

# ── Paths ───────────────────────────────────────────────────────────────

hermes_home: "~/.hermes"                       # Hermes root directory
projects_root: "~/projects"                    # projects explorer root

# ── Explorer roots ─────────────────────────────────────────────────────
# Supports two formats: compact (list of strings) or full objects.

roots:
  - key: "hermes"
    label: "Home"
    root: "~/.hermes"
  # - "/srv/data"                              # shorthand: string → auto key/label

# Or as a comma-separated string (env var HERMES_CONTROL_ROOTS):
# roots: "/srv/projects,~/.hermes,/var/data"

# ── SSL / HTTPS ────────────────────────────────────────────────────────

ssl:
  cert_file: "/etc/ssl/hermes.crt"
  key_file:  "/etc/ssl/hermes.key"

# ── Gateway API ─────────────────────────────────────────────────────────

gateway_api_key: "..."     # overrides auto-discovery from ~/.hermes/config.yaml

# ── CORS ─────────────────────────────────────────────────────────────────

cors_origins:
  - "https://hermes.example.com"
  - "https://staging.example.com"
# or as a comma-separated string (env var HCI_CORS_ORIGINS):
# cors_origins: "https://hermes.example.com,https://staging.example.com"

# ── Rate limiting ─────────────────────────────────────────────────────────

rate_limit:
  window_ms: 900000      # 15 minutes (default)
  max_requests: 100      # per window (default)

# ── Session / cookie ──────────────────────────────────────────────────────

session:
  cookie_name: "hermes_ui_auth"      # default
  cookie_max_age: 86400              # seconds, default 24 h
  secure: true                       # enforce Secure flag; omit for auto-detect
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `HERMES_CONTROL_PASSWORD` | — | **Required.** Login password |
| `HERMES_CONTROL_SECRET` | — | **Required.** HMAC signing secret |
| `PORT` | `10272` | Server listen port |
| `HERMES_CONTROL_HOME` | `~/.hermes` | Hermes root directory |
| `HERMES_PROJECTS_ROOT` | auto | Projects explorer root |
| `HERMES_CONTROL_ROOTS` | `[HERMES_HOME]` | Explorer root dirs (comma or JSON array) |
| `HCI_SSL_CERT_FILE` | — | SSL certificate path |
| `HCI_SSL_KEY_FILE` | — | SSL private key path |
| `GATEWAY_API_KEY` | auto | Gateway API key (auto-discovers from hermes config.yaml) |
| `HCI_CORS_ORIGINS` | auto | Allowed CORS origins (comma-separated) |
| `HCI_RATE_LIMIT_WINDOW_MS` | `900000` | Rate limit window (ms) |
| `HCI_RATE_LIMIT_MAX_REQUESTS` | `100` | Max requests per window |
| `HCI_SESSION_COOKIE_NAME` | `hermes_ui_auth` | Auth cookie name |
| `HCI_SESSION_COOKIE_MAX_AGE` | `86400` | Cookie max-age in seconds |
| `HCI_SESSION_SECURE` | auto | Force Secure flag on cookies |

---

## YAML → Env Key Mapping

When the YAML file has nested keys, they map to env vars using `SECTION_KEY` convention (all caps, underscore-separated):

| YAML path | Equivalent env var |
|---|---|
| `ssl.cert_file` | `HCI_SSL_CERT_FILE` |
| `ssl.key_file` | `HCI_SSL_KEY_FILE` |
| `rate_limit.window_ms` | `HCI_RATE_LIMIT_WINDOW_MS` |
| `rate_limit.max_requests` | `HCI_RATE_LIMIT_MAX_REQUESTS` |
| `session.cookie_name` | `HCI_SESSION_COOKIE_NAME` |
| `session.cookie_max_age` | `HCI_SESSION_COOKIE_MAX_AGE` |
| `session.secure` | `HCI_SESSION_SECURE` |
| `hermes_home` | `HERMES_CONTROL_HOME` |
| `projects_root` | `HERMES_PROJECTS_ROOT` |
| `gateway_api_key` | `GATEWAY_API_KEY` |
| `cors_origins` | `HCI_CORS_ORIGINS` |

---

## Verifying Your Config

The server validates required variables on startup. If `password` or `secret` is missing from both `hci.config.yaml` and the environment, it exits immediately with:

```
Error: Missing HERMES_CONTROL_PASSWORD (set env var or password in hci.config.yaml)
```

To check if your config is loading correctly, start the server and look for:

```
Hermes Control Interface running on port 10272
Password gate: env-secret only
```

---

## Example Production Setup

**`hci.config.yaml`** (committed to version control):
```yaml
port: 10272
hermes_home: "/var/lib/hermes"
ssl:
  cert_file: "/etc/ssl/hermes/fullchain.pem"
  key_file:  "/etc/ssl/hermes/privkey.pem"
rate_limit:
  window_ms: 900000
  max_requests: 200
```

**`.env`** (NOT committed — secrets only):
```bash
HERMES_CONTROL_PASSWORD=$(openssl rand -hex 32)
HERMES_CONTROL_SECRET=$(openssl rand -hex 32)
```

**systemd `Environment=` directives** (alternative to `.env`):
```ini
Environment=HERMES_CONTROL_PASSWORD=<generated>
Environment=HERMES_CONTROL_SECRET=<generated>
```

---

## Production Recommendations

- **Never** commit `.env` to version control — it's in `.gitignore` by default
- Use a secret manager (Vault, AWS Secrets Manager, etc.) for production deployments
- Rotate `HERMES_CONTROL_SECRET` regularly — existing sessions will be invalidated
- Set `NODE_ENV=production` in production deployments
- Use the `ssl` section in `hci.config.yaml` (or `HCI_SSL_CERT_FILE`/`HCI_SSL_KEY_FILE` env vars) to enable HTTPS directly — no reverse proxy required for small deployments
