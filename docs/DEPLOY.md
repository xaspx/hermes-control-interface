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
cp .env.example .env
```

Edit `.env`:
```bash
HERMES_CONTROL_SECRET=$(openssl rand -hex 32)
```

Verify it starts:
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
EnvironmentFile=/path/to/hermes-control-interface/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10

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

Open `https://hermes.example.com` in your browser. On a fresh install, create the first admin account in the web UI, then log in with that account.

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

The `Secure` cookie flag will prevent login cookies from working over plain HTTP. To override this for local development, you would need to modify the `setAuthCookie` function — but do not do this in production.
