// lib/hermes.js — Direct data access helpers (no subprocess)
const path = require('path');
const fs = require('fs');
const os = require('os');

// Cached hermes version (doesn't change during process lifetime)
let _hermesVersionCache = null;
function getHermesVersion() {
  if (_hermesVersionCache) return _hermesVersionCache;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('hermes', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    _hermesVersionCache = out.split('\n')[0];
  } catch { _hermesVersionCache = 'unknown'; }
  return _hermesVersionCache;
}

// Count agents = profile directories with config.yaml (+ default)
function getAgentCount() {
  try {
    const base = path.join(os.homedir(), '.hermes');
    let count = fs.existsSync(path.join(base, 'config.yaml')) ? 1 : 0;
    const profilesDir = path.join(base, 'profiles');
    if (fs.existsSync(profilesDir)) {
      count += fs.readdirSync(profilesDir).filter(d =>
        fs.existsSync(path.join(profilesDir, d, 'config.yaml'))
      ).length;
    }
    return count;
  } catch { return 0; }
}

// Count sessions via state.db
function getSessionCount() {
  try {
    const dbPath = path.join(os.homedir(), '.hermes', 'state.db');
    if (!fs.existsSync(dbPath)) return 0;
    const db = require('better-sqlite3')(dbPath, { readonly: true });
    const row = db.prepare('SELECT COUNT(*) as c FROM sessions').get();
    db.close();
    return row?.c || 0;
  } catch { return 0; }
}

module.exports = { getHermesVersion, getAgentCount, getSessionCount };
