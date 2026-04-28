#!/usr/bin/env bash
# Hermes Control Interface — Setup script
# Run this once after cloning, before first start.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${GREEN}[INFO]${RESET} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET} $1"; }
err()     { echo -e "${RED}[ERR]${RESET}  $1"; }
bold()    { echo -e "${BOLD}$1${RESET}"; }

# ── helpers ──────────────────────────────────────────────────────────────────
need() { command -v "$1" >/dev/null 2>&1 || { err "Missing required command: $1"; exit 1; }; }
uuid4() { cat /proc/sys/kernel/random/uuid 2>/dev/null || node -e "console.log(require('crypto').randomUUID())"; }
openssl_rand() { openssl rand -hex 32 2>/dev/null; }

# ── 1. Requirements ───────────────────────────────────────────────────────────
bold "Checking requirements…"

need node
need npm

NODE_VER=$(node -v | tr -d 'v' | cut -d. -f1)
if (( NODE_VER < 20 )); then
  err "Node.js 20+ required (found $(node -v))"
  exit 1
fi
info "Node.js $(node -v) — OK"

# ── 2. Install deps ───────────────────────────────────────────────────────────
bold "Installing dependencies…"
npm install
info "Dependencies installed"

# ── 3. .env ───────────────────────────────────────────────────────────────────
bold "Configuring environment…"

if [[ -f .env ]]; then
  info ".env already exists — skipping generation"
else
  if [[ ! -f .env.example ]]; then
    err ".env.example missing — cannot generate .env"
    exit 1
  fi

  cp .env.example .env

  if grep -q '^HERMES_CONTROL_SECRET=' .env 2>/dev/null; then
    info ".env template copied"
  fi

  if grep -q '^HERMES_CONTROL_SECRET=***' .env 2>/dev/null; then
    NEW_SECRET=$(openssl_rand | cut -c1-64)
    perl -0pi -e 's/^HERMES_CONTROL_SECRET=.*/HERMES_CONTROL_SECRET='"${NEW_SECRET}"'/m' .env
    info "Generated HERMES_CONTROL_SECRET"
  fi

  chmod 600 .env
  info ".env created — edit it if you want to change defaults"
fi

# ── 4. Nginx reverse-proxy (optional) ─────────────────────────────────────────
bold "Nginx setup (optional)…"

NGINX_CONF="/etc/nginx/sites-available/hermes-control"
ask_nginx() {
  read -rp "Configure nginx reverse-proxy for HTTPS? [y/N] " yn
  [[ "${yn,,}" == "y" ]]
}

configure_nginx() {
  local DOMAIN="$1"
  local PORT="$2"
  cat > /tmp/hermes-control-nginx.conf << NGINX
# Hermes Control Interface — reverse-proxy for $DOMAIN
# Adjust PORT if you changed the default 10272 in .env
upstream hermes_control {
    server 127.0.0.1:$PORT;
}

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    # Redirect HTTP → HTTPS
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    client_max_body_size 10M;

    location / {
        proxy_pass         http://hermes_control;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$http_host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
NGINX
  sudo tee "$NGINX_CONF" > /dev/null <<< "$(< /tmp/hermes-control-nginx.conf)"
  sudo ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/hermes-control
  sudo nginx -t && sudo systemctl reload nginx
  info "Nginx configured for https://$DOMAIN"
}

if [[ -f /etc/nginx/nginx.conf ]]; then
  if ask_nginx; then
    read -rp "Domain name for this dashboard? (e.g. hermes.example.com): " DOMAIN
    read -rp "Port number [10272]: " PORT
    PORT="${PORT:-10272}"
    if [[ -z "$DOMAIN" ]]; then
      warn "No domain entered — skipping nginx config"
    else
      configure_nginx "$DOMAIN" "$PORT"
    fi
  fi
else
  info "Nginx not detected — skipping reverse-proxy setup"
fi

# ── 5. Systemd service (optional) ────────────────────────────────────────────
bold "Systemd service (optional)…"

SYSTEMD_SERVICE="/etc/systemd/system/hermes-control.service"
install_systemd() {
  cat > /tmp/hermes-control.service << EOF
[Unit]
Description=Hermes Control Interface
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_ROOT
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

# Security: run as non-root user (recommended for production)
# Create user first: sudo useradd -r -s /bin/false hermes
# Then chown the project dir: sudo chown -R hermes:hermes $REPO_ROOT
User=hermes
Group=hermes

[Install]
WantedBy=multi-user.target
EOF
  sudo tee "$SYSTEMD_SERVICE" > /dev/null <<< "$(< /tmp/hermes-control.service)"
  sudo systemctl daemon-reload
  sudo systemctl enable hermes-control
  info "Systemd service installed — start with: sudo systemctl start hermes-control"
}

if [[ -d /run/systemd/system ]]; then
  read -rp "Install systemd service to auto-start on boot? [y/N] " yn
  if [[ "${yn,,}" == "y" ]]; then
    install_systemd
  fi
fi

# ── Done ─────────────────────────────────────────────────────────────────────
bold ""
bold "Setup complete!"
echo ""
echo "  1. Start the server:"
echo "     npm start"
echo ""
echo "  2. Open the dashboard:"
LOCAL_IP=$(node -e 'const os=require("os"); const nets=os.networkInterfaces(); for (const entries of Object.values(nets)) { for (const entry of (entries || [])) { if (entry && entry.family === "IPv4" && !entry.internal) { console.log(entry.address); process.exit(0); } } } console.log("127.0.0.1");')
echo "     http://${LOCAL_IP}:10272"
echo ""
echo "  3. On first run, create the first admin account in the web UI"
echo ""
echo "  For HTTPS + auto-start, enable the systemd service."
echo ""
