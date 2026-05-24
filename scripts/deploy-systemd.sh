#!/bin/bash
# deploy-systemd.sh — Deploy HCI systemd services from template
# Regenerates both prod & staging services from scripts/hci@.service template

set -euo pipefail

TEMPLATE="/root/projects/hermes-control-interface/scripts/hci@.service"
REPO="/root/projects/hermes-control-interface"

if [ ! -f "$TEMPLATE" ]; then
  echo "Template not found: $TEMPLATE"
  exit 1
fi

# --- hci-prod.service ---
cat > /etc/systemd/system/hci-prod.service <<UNIT
$(cat "$TEMPLATE" | sed 's/%i/prod/')

WorkingDirectory=${REPO}
Environment=PORT=10272
UNIT

# --- hci-staging.service ---
cat > /etc/systemd/system/hci-staging.service <<UNIT
$(cat "$TEMPLATE" | sed 's/%i/staging/')

WorkingDirectory=/root/projects/hci-staging
Environment=PORT=10274
UNIT

systemctl daemon-reload
echo "✅ Services generated from template. Run: systemctl restart hci-prod hci-staging"
