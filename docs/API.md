# API Reference

Base URL: `http://localhost:10272` (or your domain if behind a reverse-proxy)

---

## Authentication

All endpoints marked **Auth required** require a valid session cookie (`hermes...auth`).

Login first via `POST /api/auth/login` to receive the cookie.

Internal endpoints (marked **Internal**) require the `x-hermes-control-secret` header matching `HERMES_CONTROL_SECRET` instead of a cookie.

---

## Endpoints

### `GET /api/health`

**Auth required:** No

Returns a basic health check.

```json
{
  "ok": true,
  "title": "Hermes Control Interface",
  "auth": true,
  "ws": "/ws"
}
```

---

### `GET /api/auth/status`

**Auth required:** No

Returns the current authentication state.

```json
{
  "authenticated": false,
  "passwordRequired": true,
  "identity": "root@hermes"
}
```

---

### `POST /api/auth/login`

**Auth required:** No

**Rate limited:** 5 attempts per 15 minutes per IP.

**Request body:**
```json
{ "password": "***" }
```

**Success response (200):**
```json
{ "ok": true }
```
Sets the `hermes...auth` cookie.

**Failure response (401):**
```json
{ "ok": false, "error": "bad password" }
```

**Rate limited response (429):**
```json
{
  "ok": false,
  "error": "too many failed attempts, try again in 15 minutes"
}
```

---

### `POST /api/auth/logout`

**Auth required:** No (but does nothing if not authenticated)

Clears the session cookie.

```json
{ "ok": true }
```

---

### `GET /api/profiles`

**Auth required:** Yes

Returns all configured Hermes profiles with their status.

**Response:**
```json
{
  "ok": true,
  "profiles": [
    { "name": "default", "model": "xiaomi/mimo-v2-pro", "gateway": "stopped", "alias": null, "active": false },
    { "name": "david", "model": "xiaomi/mimo-v2-pro", "gateway": "running", "alias": "david", "active": true },
    { "name": "soci", "model": "gpt-5.4-mini", "gateway": "stopped", "alias": "soci", "active": false }
  ]
}
```

---

### `POST /api/profiles/use`

**Auth required:** Yes (CSRF required)

Sets the active (default) Hermes profile.

**Request body:**
```json
{ "profile": "david" }
```

**Response:**
```json
{ "ok": true, "profile": "david", "output": "..." }
```

---

### `GET /api/gateway/:profile`

**Auth required:** Yes

Returns the systemd service status for a profile's gateway.

**Response:**
```json
{
  "ok": true,
  "profile": "david",
  "service": "hermes-gateway-david",
  "active": true,
  "enabled": true,
  "status": "● hermes-gateway-david.service - Hermes Gateway - david..."
}
```

---

### `POST /api/gateway/:profile/:action`

**Auth required:** Yes (CSRF required)

Controls a gateway systemd service.

**Actions:** `start`, `stop`, `restart`, `enable`, `disable`

**Response:**
```json
{
  "ok": true,
  "profile": "david",
  "action": "start",
  "active": true,
  "output": ""
}
```

---

### `GET /api/gateway/:profile/logs`

**Auth required:** Yes

Returns journal logs for a gateway service.

**Query parameters:**
- `lines` (optional) — number of log lines to return (default: 50, max: 500)

**Response:**
```json
{
  "ok": true,
  "profile": "david",
  "service": "hermes-gateway-david",
  "logs": "Apr 10 23:00:00 vm1 systemd[1]: Started Hermes Gateway - david..."
}
```

---

### `GET /api/explorer`

**Auth required:** Yes

Returns directory trees for configured explorer roots.

**Query parameters:**
- `root` (optional) — key of a specific root to query. If omitted, returns all roots.

**Response:**
```json
[
  {
    "key": "projects",
    "label": "/root/projects",
    "root": "/root/projects",
    "children": [
      {
        "name": "my-project",
        "path": "/root/projects/my-project",
        "rel": "my-project",
        "type": "dir",
        "depth": 0,
        "children": [...]
      }
    ]
  }
]
```

---

### `GET /api/file`

**Auth required:** Yes

Reads a file.

**Query parameters:**
- `path` — absolute path to the file (must be within an explorer root)

**Response (200):**
```json
{
  "path": "/root/projects/my-project/file.js",
  "content": "console.log('hello')"
}
```

**Error responses:**
- `400` — path missing or outside allowed roots
- `404` — file not found
- `400` — path is a directory

---

### `POST /api/file`

**Auth required:** Yes

Writes a file.

**Request body:**
```json
{
  "path": "/root/projects/my-project/file.js",
  "content": "console.log('updated')"
}
```

**Response (200):**
```json
{
  "ok": true,
  "path": "/root/projects/my-project/file.js",
  "bytes": 24
}
```

---

### `POST /api/terminal/exec`

**Auth required:** Yes

Queues a command in the PTY terminal session.

**Request body:**
```json
{ "command": "ls -la" }
```

**Response:**
```json
{
  "ok": true,
  "queued": true,
  "command": "ls -la",
  "cwd": "/root/projects/hermes-control-interface",
  "identity": "root@hermes",
  "ready": true,
  "buffer": "...terminal output...",
  "timestamp": "2026-04-09T00:00:00.000Z"
}
```

Special commands starting with `/cron` are handled internally and marked `"special": true`.

---

### `POST /api/cron/:action`

**Auth required:** Yes

**Actions:** `add`, `list`, `remove`, `pause`, `resume`

**`add` request body:**
```json
{
  "schedule": "30m",
  "note": "daily report",
  "deliver": "origin"
}
```

**`remove` request body:**
```json
{ "id": "abc123" }
```

**`pause` / `resume` request body:**
```json
{ "id": "abc123" }
```

**`list`** takes no body.

---

### `POST /internal/cron/:action`

**Auth required:** Internal (header-based)

Same as `/api/cron/:action` but uses `x-hermes-control-secret` header for authentication. Used by Hermes itself to trigger cron actions internally.

---

### `GET /usage`  /  `GET /api/usage`

**Auth required:** Yes

Returns system resource usage.

```json
{
  "memUsed": "842 MB",
  "memTotal": "1.96 GB",
  "diskUsed": "38 GB",
  "diskTotal": "49 GB",
  "cpuCores": 2,
  "loadAvg": [0.12, 0.08, 0.05],
  "uptime": 3600,
  "hostname": "vm1"
}
```

---

### `GET /api/layout`

**Auth required:** Yes

Returns the saved dashboard layout.

```json
{
  "ok": true,
  "layout": {
    "updatedAt": "2026-04-09T00:00:00.000Z",
    "panels": [
      { "id": "terminal", "x": 0, "y": 0, "w": 800, "h": 400 }
    ]
  }
}
```

---

### `POST /api/layout`

**Auth required:** Yes

Saves dashboard layout.

**Request body:**
```json
{
  "panels": [
    { "id": "terminal", "x": 0, "y": 0, "w": 800, "h": 400 }
  ]
}
```

---

### `GET /api/avatar`

**Auth required:** Yes

Returns avatar metadata (URL reference, not the full image data).

```json
{
  "ok": true,
  "url": "/api/avatar/image",
  "custom": true
}
```

---

### `GET /api/avatar/image`

**Auth required:** Yes

Returns the avatar image as raw binary with proper `Content-Type` and `Cache-Control` headers. Use this endpoint in `<img>` tags instead of embedding base64 data.

**Response:** Raw image bytes (`image/jpeg`, `image/png`, or `image/webp`).

**Headers:**
- `Cache-Control: private, max-age=3600` (1 hour browser cache)
- `Content-Type: image/*` (matches the uploaded format)

---

### `POST /api/avatar`

**Auth required:** Yes

Uploads a custom avatar image.

**Request body:**
```json
{ "dataUrl": "data:image/png;base64,iVBORw0KGgo..." }
```

Accepted formats: PNG, JPEG, WebP.

**Response:**
```json
{
  "ok": true,
  "url": "/api/avatar/image",
  "custom": true
}
```

Triggers a WebSocket snapshot broadcast so connected clients refresh the avatar.

---

### `DELETE /api/avatar`

**Auth required:** Yes

Resets avatar to the default photo. Triggers a WebSocket broadcast.

---

## WebSocket (`/ws`)

**Auth required:** Yes (via cookie)

### Client → Server messages

**Ping:**
```json
{ "type": "ping" }
```

**Terminal input:**
```json
{ "type": "terminal-input", "data": "ls -la\n" }
```

**Terminal resize:**
```json
{ "type": "terminal-resize", "cols": 120, "rows": 32 }
```

### Server → Client messages

**Dashboard snapshot** (sent on connect):
```json
{
  "type": "snapshot",
  "payload": { /* dashboard-state object */ }
}
```

**Live updates:**
```json
{
  "type": "snapshot",
  "payload": { /* updated dashboard-state */ }
}
```

**Terminal output (from PTY to client):**
```json
{
  "type": "terminal-output",
  "chunk": "root@hermes:~$ ",
  "buffer": "...",
  "ready": true,
  "cwd": "/root/projects/hermes-control-interface",
  "prompt": "root@hermes:/root/projects/hermes-control-interface# "
}
```

**Terminal transcript** (sent on reconnect if session was active):
```json
{
  "type": "terminal-transcript",
  "buffer": "...",
  "ready": true,
  "cwd": "...",
  "prompt": "...",
  "cols": 120,
  "rows": 32
}
```

**Pong:**
```json
{ "type": "pong", "ts": 1712600000000 }
```
