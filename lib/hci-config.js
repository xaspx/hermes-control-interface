/**
 * lib/hci-config.js
 * ─────────────────
 * HCI Configuration loader.
 *
 * Loads hci.config.yaml from the repo root, then applies environment-variable
 * overrides.  This gives operators two ergonomic patterns:
 *
 *   1. YAML file  – edit once, commit to version control (defaults / shared config)
 *   2. env vars   – override any key at runtime (secrets, per-deployment values)
 *
 * Environment variables always win over the YAML file so that secrets never need
 * to be stored in plaintext.
 *
 * YAML schema (all keys are optional unless noted):
 *
 *   port: 10272                       # server listen port
 *   password: "..."                   # REQUIRED — login password
 *   secret: "..."                     # REQUIRED — HMAC signing secret
 *   hermes_home: "~/.hermes"          # Hermes root (state dir, avatar, layout)
 *   projects_root: "~/projects"       # projects explorer root
 *   roots:                             # explorer root directories
 *     - key: "hermes"
 *       label: "Home"
 *       root: "~/.hermes"
 *   cors_origins:                      # allowed origins for gateway config injection
 *     - "https://example.com"
 *   ssl:
 *     cert_file: "/path/to/cert.pem"
 *     key_file:  "/path/to/key.pem"
 *   gateway_api_key: "..."            # overrides auto-discovery from hermes config.yaml
 *   rate_limit:
 *     window_ms: 900000               # 15 min window
 *     max_requests: 100              # per window
 *   session:
 *     cookie_name: "hermes_ui_auth"
 *     cookie_max_age: 86400          # seconds (default 24 h)
 *     secure: true                    # enforce Secure flag on cookies
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const yaml = require('js-yaml');

// ── helpers ─────────────────────────────────────────────────────────────────

function resolveHome(p) {
  return p.replace(/^~\//, os.homedir() + '/');
}

function truthy(v) {
  return v === true || v === 'true' || v === '1';
}

function falsy(v) {
  return v === false || v === 'false' || v === '0' || v === '';
}

/** Shallow-merge arrays of objects by a unique `key` field. */
function mergeRoots(base, overlay) {
  if (!overlay || !overlay.length) return base;
  const baseKeys = new Set((base || []).map(r => r.key));
  const merged = [...(base || [])];
  for (const r of overlay) {
    const idx = merged.findIndex(x => x.key === r.key);
    if (idx >= 0) merged[idx] = { ...merged[idx], ...r };
    else merged.push(r);
  }
  return merged;
}

// ── YAML loader ─────────────────────────────────────────────────────────────

/**
 * Attempt to load hci.config.yaml from the repo root (server.js directory).
 * Silently returns an empty object if the file does not exist — that is
 * intentional so the file is optional when all required values come from env.
 */
function loadYamlConfig() {
  try {
    const configPath = path.join(__dirname, '..', 'hci.config.yaml');
    if (!fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, 'utf8');
    return yaml.load(raw) || {};
  } catch (err) {
    console.error('[hci-config] Failed to load hci.config.yaml:', err.message);
    return {};
  }
}

// ── Environment overrides ────────────────────────────────────────────────────

/**
 * Coerce a raw string value from the YAML file into the value that would be
 * produced by the same key as an environment variable.
 *
 * Strategy mirrors dotenv-expand: numeric strings → numbers, /true|false/ →
 * booleans, otherwise strings.
 */
function coerceYamlValue(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (raw === '') return '';
  if (!isNaN(raw) && String(Number(raw)) === String(raw)) return Number(raw);
  if (raw === 'true')  return true;
  if (raw === 'false') return false;
  return raw;
}

/**
 * Convert a YAML config tree to a flat key → value map using underscore-separated
 * env-key convention so we can compare against process.env.
 *
 * Example: { ssl: { cert_file: "x" } }  →  { "SSL_CERT_FILE": "x" }
 */
function flattenKeys(obj, prefix, result = {}) {
  if (obj === null || obj === undefined) return result;
  if (typeof obj !== 'object') {
    result[prefix] = obj;
    return result;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => flattenKeys(item, `${prefix}_${i}`, result));
    return result;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}_${k.toUpperCase()}` : k.toUpperCase();
    flattenKeys(v, key, result);
  }
  return result;
}

// ── Main config builder ─────────────────────────────────────────────────────

function buildConfig() {
  const yamlCfg = loadYamlConfig();

  // Flatten YAML so we can check env-override pairs using consistent naming.
  const flat = flattenKeys(yamlCfg, '');
  const yamlMap = Object.fromEntries(
    Object.entries(flat).map(([k, v]) => [k, coerceYamlValue(v)])
  );

  // ── Required values ─────────────────────────────────────────────────────
  // Env wins; fall back to YAML; error if neither.
  const password = process.env.HERMES_CONTROL_PASSWORD
    || yamlMap.HERMES_CONTROL_PASSWORD
    || yamlMap.PASSWORD;
  if (!password) {
    throw new Error('Missing HERMES_CONTROL_PASSWORD (set env var or password in hci.config.yaml)');
  }

  const secret = process.env.HERMES_CONTROL_SECRET
    || yamlMap.HERMES_CONTROL_SECRET
    || yamlMap.SECRET;
  if (!secret) {
    throw new Error('Missing HERMES_CONTROL_SECRET (set env var or secret in hci.config.yaml)');
  }

  // ── Server ──────────────────────────────────────────────────────────────
  const port = Number(
    process.env.PORT
    || yamlMap.PORT
    || 10272
  );

  // ── Paths ───────────────────────────────────────────────────────────────
  const hermesHome = resolveHome(
    process.env.HERMES_CONTROL_HOME
    || yamlMap.HERMES_CONTROL_HOME
    || yamlMap.HERMES_HOME
    || '~/.hermes'
  );

  const projectsRoot = resolveHome(
    process.env.HERMES_PROJECTS_ROOT
    || yamlMap.HERMES_PROJECTS_ROOT
    || path.resolve(__dirname, '..', '..')
  );

  // ── Explorer roots ───────────────────────────────────────────────────────
  // Env takes precedence; then YAML array; then single hermes_home default.
  let roots = null;

  // HERMES_CONTROL_ROOTS env (existing format: comma-string or JSON array)
  if (process.env.HERMES_CONTROL_ROOTS) {
    roots = parseEnvRoots(process.env.HERMES_CONTROL_ROOTS);
  }

  // roots key in YAML
  if (!roots && yamlMap.ROOTS) {
    roots = mergeRoots(null, yamlMap.ROOTS);
  }

  // Default: single root pointing at hermes_home
  if (!roots) {
    roots = [{ key: 'hermes', label: 'Home', root: hermesHome }];
  }

  // ── CORS ─────────────────────────────────────────────────────────────────
  // HCI_CORS_ORIGINS env wins over YAML array.
  const corsOrigins = process.env.HCI_CORS_ORIGINS
    || (yamlMap.CORS_ORIGINS
      ? (Array.isArray(yamlMap.CORS_ORIGINS)
          ? yamlMap.CORS_ORIGINS.join(',')
          : String(yamlMap.CORS_ORIGINS))
      : null);

  // ── SSL ──────────────────────────────────────────────────────────────────
  const ssl = {
    certFile: process.env.HCI_SSL_CERT_FILE
      || yamlMap.SSL_CERT_FILE
      || yamlMap.HCI_SSL_CERT_FILE
      || null,
    keyFile: process.env.HCI_SSL_KEY_FILE
      || yamlMap.SSL_KEY_FILE
      || yamlMap.HCI_SSL_KEY_FILE
      || null,
  };

  // ── Gateway API key ───────────────────────────────────────────────────────
  // Env wins over YAML; auto-discovery from hermes config.yaml is handled
  // in server.js after we export this value so we don't duplicate the logic.
  const gatewayApiKey = process.env.GATEWAY_API_KEY
    || yamlMap.GATEWAY_API_KEY
    || null;  // null → server.js will auto-discover

  // ── Rate limiting ─────────────────────────────────────────────────────────
  const rateLimit = {
    windowMs: Number(
      process.env.HCI_RATE_LIMIT_WINDOW_MS
      || yamlMap.RATE_LIMIT_WINDOW_MS
      || yamlMap.HCI_RATE_LIMIT_WINDOW_MS
      || 900000
    ),
    maxRequests: Number(
      process.env.HCI_RATE_LIMIT_MAX_REQUESTS
      || yamlMap.RATE_LIMIT_MAX_REQUESTS
      || yamlMap.HCI_RATE_LIMIT_MAX_REQUESTS
      || 100
    ),
  };

  // ── Session / cookie ──────────────────────────────────────────────────────
  const session = {
    cookieName: String(
      process.env.HCI_SESSION_COOKIE_NAME
      || yamlMap.SESSION_COOKIE_NAME
      || yamlMap.HCI_SESSION_COOKIE_NAME
      || 'hermes_ui_auth'
    ),
    cookieMaxAge: Number(
      process.env.HCI_SESSION_COOKIE_MAX_AGE
      || yamlMap.SESSION_COOKIE_MAX_AGE
      || yamlMap.HCI_SESSION_COOKIE_MAX_AGE
      || 86400
    ),
    // Secure flag: env / YAML bool, or null (server.js decides based on TLS)
    secure: (() => {
      if (process.env.HCI_SESSION_SECURE !== undefined) return !falsy(process.env.HCI_SESSION_SECURE);
      if (yamlMap.SESSION_SECURE !== undefined) return !falsy(yamlMap.SESSION_SECURE);
      return null;  // auto-detect
    })(),
  };

  // ── Assemble ─────────────────────────────────────────────────────────────
  return {
    // Raw required values (plain strings — server.js handles hashing etc.)
    password,
    secret,
    // Server
    port,
    // Paths
    hermesHome,
    projectsRoot,
    // Explorer
    roots,
    // Network
    corsOrigins,
    ssl,
    gatewayApiKey,
    // Security
    rateLimit,
    session,
    // Raw YAML for advanced use (server.js may need to check unmapped keys)
    _yaml: yamlCfg,
    _yamlPath: path.join(__dirname, '..', 'hci.config.yaml'),
  };
}

// ── Existing parseEnvRoots (extracted so it can be reused here) ─────────────

function parseEnvRoots(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) {
      return parsed.map((item, index) => {
        if (typeof item === 'string') {
          return { key: `root-${index + 1}`, label: item, root: item };
        }
        if (item && typeof item === 'object' && item.root) {
          return {
            key: String(item.key || `root-${index + 1}`),
            label: String(item.label || item.root),
            root: String(item.root),
          };
        }
        return null;
      }).filter(Boolean);
    }
  } catch {}
  return String(raw)
    .split(',')
    .map((part, index) => part.trim())
    .filter(Boolean)
    .map((root, index) => ({ key: `root-${index + 1}`, label: root, root }));
}

// ── Singleton export ──────────────────────────────────────────────────────────

let _config = null;

function getConfig() {
  if (!_config) {
    _config = buildConfig();
  }
  return _config;
}

module.exports = { getConfig, buildConfig };
