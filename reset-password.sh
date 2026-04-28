#!/usr/bin/env bash
# Hermes Control Interface — Reset Password
# Hashes a new password with bcrypt and updates .env

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${GREEN}[INFO]${RESET} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET} $1"; }
err()     { echo -e "${RED}[ERR]${RESET}  $1"; }

# Check for node
if ! command -v node >/dev/null 2>&1; then
  err "Node.js is required but not found."
  exit 1
fi

# Check .env exists
if [[ ! -f .env ]]; then
  err ".env file not found. Run install.sh first."
  exit 1
fi

echo -e "${BOLD}Hermes Control Interface — Password Reset${RESET}"
echo ""
warn "This will replace your current HERMES_CONTROL_PASSWORD in .env"
echo "with a bcrypt-hashed version."
echo ""

read -rp "Are you sure you want to continue? [y/N] " confirm
if [[ "${confirm,,}" != "y" ]]; then
  info "Aborted."
  exit 0
fi

echo ""

if [[ $# -ge 2 ]]; then
  node scripts/reset-password.js "$1" "$2"
elif [[ $# -ge 1 ]]; then
  node scripts/reset-password.js "$1"
else
  node scripts/reset-password.js
fi
