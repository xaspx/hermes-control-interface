#!/bin/bash
# state-maintenance.sh — Weekly VACUUM + cleanup for Hermes state databases
# Runs: vacuum state.db, trim WAL, clean old snapshots

set -euo pipefail

PROFILES_DIR="${HERMES_HOME:-/root/.hermes}/profiles"
SNAPSHOTS_DIR="${HERMES_HOME:-/root/.hermes}/snapshots"
LOG="/tmp/state-maintenance.log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting state maintenance..." > "$LOG"

# 1. VACUUM default state.db
DB="${HERMES_HOME:-/root/.hermes}/state.db"
if [ -f "$DB" ]; then
  BEFORE=$(stat -c%s "$DB" 2>/dev/null || echo 0)
  sqlite3 "$DB" "VACUUM;" 2>> "$LOG"
  sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" 2>> "$LOG"
  AFTER=$(stat -c%s "$DB" 2>/dev/null || echo 0)
  echo "[VACUUM] default: ${BEFORE} → ${AFTER} bytes ($(( (BEFORE - AFTER) / 1024 ))KB saved)" >> "$LOG"
fi

# 2. VACUUM profile state.dbs
if [ -d "$PROFILES_DIR" ]; then
  for PROFILE in "$PROFILES_DIR"/*/; do
    PROFILE_NAME=$(basename "$PROFILE")
    PROFILE_DB="${PROFILE}state.db"
    if [ -f "$PROFILE_DB" ]; then
      BEFORE=$(stat -c%s "$PROFILE_DB" 2>/dev/null || echo 0)
      sqlite3 "$PROFILE_DB" "VACUUM;" 2>> "$LOG"
      sqlite3 "$PROFILE_DB" "PRAGMA wal_checkpoint(TRUNCATE);" 2>> "$LOG"
      AFTER=$(stat -c%s "$PROFILE_DB" 2>/dev/null || echo 0)
      echo "[VACUUM] ${PROFILE_NAME}: ${BEFORE} → ${AFTER} bytes" >> "$LOG"
    fi
  done
fi

# 3. Clean old snapshots — keep only the 3 most recent
if [ -d "$SNAPSHOTS_DIR" ]; then
  COUNT=$(ls -1 "$SNAPSHOTS_DIR"/*.db 2>/dev/null | wc -l)
  if [ "$COUNT" -gt 3 ]; then
    ls -1t "$SNAPSHOTS_DIR"/*.db 2>/dev/null | tail -n +4 | xargs -r rm -v >> "$LOG"
    echo "[SNAPSHOTS] Cleaned $(( COUNT - 3 )) old snapshots" >> "$LOG"
  else
    echo "[SNAPSHOTS] Only $COUNT snapshots — no cleanup needed" >> "$LOG"
  fi
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] State maintenance complete." >> "$LOG"

# Print summary
cat "$LOG"
