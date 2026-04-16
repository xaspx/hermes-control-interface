#!/bin/bash
# HCI Auto-restart wrapper
# Usage: bash restart.sh [port]
PORT=${1:-10274}
cd "$(dirname "$0")"

while true; do
  fuser -k "$PORT/tcp" 2>/dev/null
  sleep 1
  echo "[HCI] Starting on port $PORT..."
  node server.js
  EXIT_CODE=$?
  echo "[HCI] Exited with code $EXIT_CODE"
  if [ "$EXIT_CODE" -eq 0 ]; then
    echo "[HCI] Clean exit, restarting in 2s..."
    sleep 2
  else
    echo "[HCI] Crash (code $EXIT_CODE), restarting in 5s..."
    sleep 5
  fi
done
