# Deployment Guide

## Prerequisites

- Node.js 20+
- npm
- A domain/subdomain pointed at your server (for HTTPS)
- nginx (or any reverse-proxy with TLS termination)
- Optional: systemd for auto-start

---

## Step 1 — Install the Dashboard

```bash
git clone https://github.com/xaspx/hermes-control-interface.git hermes-control-interface
cd hermes-control-interface
npm install
```

## Step 1b — Configure

The dashboard supports two config patterns. Choose the one that fits your deployment:

### Pattern A — Environment variables only

```bash
cp .env.example .env
# Edit .env and set:
#   HERMES_CONTROL_PASSWORD=$(openssl rand -hex 32)
#   HERMES_CONTROL_SECRET=$(openssl rand -hex 32)
```

### Pattern B — YAML config + env overrides (recommended for production)

```bash
cp hci.config.yaml.example hci.config.yaml
# Edit hci.config.yaml (password and secret are required):
#   password: "<generate with: openssl rand -hex 32>"
#   secret:   "<generate with: openssl rand -hex 32>"
```

> **Why YAML?** `hci.config.yaml` can be committed to version control and shared across machines, while secrets (password, secret) are still supplied via environment variables (`.env` or systemd `Environment=` lines) so they never appear in plaintext in the repo.

### Verify startup

```bash
npm start
# Should print: Hermes Control Interface running on port 10272
curl http://localhost:10272/api/health
```

---

## Step 2 — Obtain an SSL Certificate

If you don't already have one for your domain, use Let's Encrypt:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d hermes.example.com
```

Follow the prompts. Certbot will auto-renew the certificate.

---

## Step 3 — Configure nginx

Create `/etc/nginx/sites-available/hermes-control` (or add to an existing server block):

```nginx
upstream hermes_control {
    server 127.0.0.1:10272;
    keepalive 64;
}

server {
    listen 80;
    server_name hermes.example.com;

    # Redirect all HTTP → HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name hermes.example.com;

    ssl_certificate     /etc/letsencrypt/live/hermes.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hermes.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         EECDH+CHACHA20:EECDH+AES128:RSA+AES128:EECDH+AES256:RSA+AES256:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;

    client_max_body_size 10M;

    # Allow long polling / streaming
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;

    location / {
        proxy_pass         http://hermes_control;
        proxy_http_version 1.1;
        proxy_set_header   Host              $http_host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";
    }
}
```

Enable the site:
```bash
sudo ln -sf /etc/nginx/sites-available/hermes-control /etc/nginx/sites-enabled/hermes-control
sudo nginx -t
sudo systemctl reload nginx
```

---

## Step 4 — Systemd Service (optional but recommended)

> **Security recommendation:** Run the service as a non-root user.
> Create a dedicated user first:
> ```bash
> sudo useradd -r -s /bin/false hermes
> sudo chown -R hermes:hermes /path/to/hermes-control-interface
> ```
> Then uncomment `User=hermes` and `Group=hermes` in the service file below.

Create `/etc/systemd/system/hermes-control.service`:

```ini
[Unit]
Description=Hermes Control Interface
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/hermes-control-interface
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
# Environment=HERMES_CONTROL_PASSWORD=<generate with: openssl rand -hex 32>
# Environment=HERMES_CONTROL_SECRET=<generate with: openssl rand -hex 32>

# Run as non-root user (recommended for production)
# Create the user first: sudo useradd -r -s /bin/false hermes
User=hermes
Group=hermes

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable hermes-control
sudo systemctl start hermes-control
sudo systemctl status hermes-control
```

---

## Step 5 — Verify

Open `https://hermes.example.com` in your browser. You should see the login screen. Log in with your configured password.

---

## Direct HTTPS Without a Reverse Proxy

The dashboard can terminate TLS directly. Add to `hci.config.yaml`:

```yaml
ssl:
  cert_file: "/etc/letsencrypt/live/hermes.example.com/fullchain.pem"
  key_file:  "/etc/letsencrypt/live/hermes.example.com/privkey.pem"
```

Or via environment variables:
```bash
HCI_SSL_CERT_FILE=/etc/letsencrypt/live/hermes.example.com/fullchain.pem
HCI_SSL_KEY_FILE=/etc/letsencrypt/live/hermes.example.com/privkey.pem
```

---

## Updating

```bash
cd hermes-control-interface
git pull
npm install          # update dependencies
sudo systemctl restart hermes-control
```

---

## Reverse-Proxy Alternatives

### Caddy (simpler than nginx)

```caddy
hermes.example.com {
    reverse_proxy localhost:10272
}
```

### Cloudflare Tunnel (no public IP needed)

Point the tunnel at `http://localhost:10272`. Set `CFG_REQUEST_HEADERS_TO_STRIP=X-Forwarded-Proto` in the tunnel config to preserve HTTPS cookies.

---

## Running Without a Reverse-Proxy (LAN only)

Not recommended for deployments exposed to the internet. Fine for a home network behind a NAT.

```bash
PORT=10272 npm start
# Access via http://<server-ip>:10272
```

The `Secure` cookie flag will prevent login cookies from working over plain HTTP. Set `session.secure: false` in `hci.config.yaml` or `HCI_SESSION_SECURE=false` for local development only.

---

## Configuration Reference

See [CONFIG.md](./CONFIG.md) for the full configuration schema.

| Variable | Required | Default | Description |
|---|---|---|---|
| `HERMES_CONTROL_PASSWORD` | ✅ | — | Login password (min 32 chars in production) |
| `HERMES_CONTROL_SECRET` | ✅ | — | HMAC secret for auth tokens |
| `PORT` | — | `10272` | Server listen port |
| `GATEWAY_API_KEY` | — | auto | Gateway API auth key (auto-discovers from hermes config.yaml) |
| `HCI_CORS_ORIGINS` | — | auto-detect → localhost | Comma-separated CORS origins for production |
| `HERMES_CONTROL_HOME` | — | `~/.hermes` | Hermes root directory |
| `HERMES_PROJECTS_ROOT` | — | parent of repo | Projects explorer root |
| `HCI_SSL_CERT_FILE` | — | — | SSL certificate path |
| `HCI_SSL_KEY_FILE` | — | — | SSL private key path |

**CORS Origins:** For localhost development, works out of the box (auto-detects from request origin). For production deployments:
```bash
HCI_CORS_ORIGINS=https://your-domain.com,https://staging.your-domain.com
```
Or in `hci.config.yaml`:
```yaml
cors_origins:
  - "https://your-domain.com"
  - "https://staging.your-domain.com"
```
