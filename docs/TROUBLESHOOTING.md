# Troubleshooting

---

## Server won't start

### `Error: Missing HERMES_CONTROL_PASSWORD or HERMES_CONTROL_SECRET environment variables`

The `.env` file is missing or those variables are empty.

```bash
cp .env.example .env
# Edit .env and fill in both values
npm start
```

---

### `Error: listen EADDRINUSE :::10272`

Port 10272 is already in use.

Find the conflicting process:
```bash
ss -tlnp | grep 10272
lsof -i :10272
```

Kill it or change the port:
```bash
PORT=10702 npm start
```

---

### `Error: Cannot find module 'express-rate-limit'`

Dependencies weren't installed.

```bash
npm install
```

If it still fails, check that Node.js version is 20+:
```bash
node -v  # should be v20.x.x or higher
```

---

## Login doesn't work

### Login form returns 401

Wrong password. Check the value in `.env`:

```bash
grep HERMES_CONTROL_PASSWORD .env
```

There is no way to recover a lost password except by setting a new one in `.env`.

### Login appears to succeed but immediately asks for password again

The `Secure` cookie flag is blocking the cookie over plain HTTP.

- If accessing locally: use `http://localhost:10272` (the browser may still require HTTPS for Secure cookies — try Firefox which is more lenient, or enable HTTPS)
- If behind a reverse-proxy: ensure the proxy is using HTTPS (TLS termination) before forwarding to the dashboard

Check in browser DevTools → Application → Cookies that a cookie named `hermes...auth` is being set.

### Rate limited — "too many failed attempts"

Wait 15 minutes, or restart the server to clear the in-memory rate limit store:

```bash
sudo systemctl restart hermes-control
# or if running manually:
pkill -f "node server.js" && npm start
```

---

## Terminal panel

### Terminal connects but shows no prompt

The PTY process may not have started. Reload the dashboard (refresh the browser).

Check if the PTY process is running:
```bash
ps aux | grep node-pty
```

### Terminal output is garbled / wrong encoding

The PTY TERM is set to `xterm-256color`. This should work with most modern terminals. If you see mojibake, try refreshing — the terminal should auto-reconnect.

### Terminal disconnects frequently

Check the server's WebSocket connection is not being closed by a proxy timeout. The nginx config in `docs/DEPLOY.md` sets `proxy_read_timeout 600s` to handle long-lived connections.

---

## File Explorer

### "Access denied" on a file I should be able to read

The file path must be within one of the configured explorer roots. Paths outside those roots return `400 Bad Request`.

Check your configured roots:
```bash
# From .env
grep HERMES_CONTROL_ROOTS .env

# Default roots if not set:
# - HERMES_PROJECTS_ROOT (defaults to parent dir of the repo)
# - HERMES_CONTROL_HOME (defaults to ~/.hermes)
```

### Directory tree is empty

- The directory may genuinely be empty
- The path may not exist — check the `root` directory is valid
- `node_modules`, `.git`, and hidden files/directories are hidden from the tree view by default

---

## WebSocket issues

### Dashboard loads but shows "Connecting…" forever

The WebSocket handshake is failing. Common causes:

1. **Wrong cookie path.** The auth cookie `Path=/` must be compatible with your reverse-proxy configuration.
2. **Reverse-proxy not configured for WebSocket.** nginx needs:
   ```nginx
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection "upgrade";
   ```
   See the nginx config in `docs/DEPLOY.md`.
3. **Server restarting.** The dashboard may have crashed. Check:
   ```bash
   sudo systemctl status hermes-control
   # or
   curl http://localhost:10272/api/health
   ```

---

## Metrics panel shows stale or zero data

The metrics update via WebSocket events (no polling). If you're seeing stale data:

1. Check WebSocket is connected (no "Connecting…" message)
2. Click the Refresh button in the top bar for a full state reload
3. Check the server is running: `curl http://localhost:10272/api/health`

---

## Avatar flickers or resets to default

This was a known issue before v1.1.0. If you're still seeing it:

1. Hard refresh the browser (Ctrl+Shift+R) to clear cached JS
2. Check that `/api/avatar/image` returns 200: `curl -s -o /dev/null -w '%{http_code}' http://localhost:10272/api/avatar/image`
3. Re-upload the avatar via the dashboard UI

---

## Sessions disappear after avatar upload

Fixed in v1.1.0. Sessions are now included in the snapshot and change detection prevents empty overwrite. If still happening, hard refresh the browser.

---

## High memory usage

The dashboard stores PTY output in memory (capped at 1000 lines). For very long sessions, the buffer can grow.

PTY session is shared across all authenticated sessions — there is only one PTY process. Closing the browser tab does not close the PTY.

To restart the PTY session cleanly:
```bash
# Send SIGHUP to force a PTY restart (handled in server code)
# or restart the service:
sudo systemctl restart hermes-control
```

---

## Systemd service won't start

Check the logs:
```bash
sudo journalctl -u hermes-control -n 50
```

Common issues:
- Wrong `WorkingDirectory` in the service file
- Missing `.env` — systemd doesn't load it automatically. Either set `Environment=` vars in the service file, or use `EnvironmentFile=/path/to/.env`
- `node` not on PATH — use the absolute path in `ExecStart`, e.g. `/usr/bin/node`
