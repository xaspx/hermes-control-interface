require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { execFile, spawn } = require('child_process');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const rateLimit = require('express-rate-limit');
const yaml = require('js-yaml');

// Async shell execution utility (non-blocking)
function shell(cmd, timeout = '8s') {
  return new Promise((resolve) => {
    execFile('bash', ['-lc', `timeout ${timeout} ${cmd} 2>&1`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
    }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

const PORT = Number(process.env.PORT || 10272);
const CONTROL_PASSWORD = process.env.HERMES_CONTROL_PASSWORD;
const CONTROL_SECRET = process.env.HERMES_CONTROL_SECRET;
const AUTH_COOKIE = 'hermes_control_auth';
const PROJECT_ROOT = __dirname;
const PROJECTS_ROOT = process.env.HERMES_PROJECTS_ROOT || path.dirname(PROJECT_ROOT);
const CONTROL_HOME = process.env.HERMES_CONTROL_HOME || path.join(os.homedir(), '.hermes');
const CONTROL_STATE_DIR = path.join(CONTROL_HOME, 'control-interface');
const AVATAR_OVERRIDE_PATH = path.join(CONTROL_STATE_DIR, 'avatar.dataurl');

function parseExplorerRoots(raw) {
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

const ROOTS = parseExplorerRoots(process.env.HERMES_CONTROL_ROOTS) || [
  { key: 'hermes', label: CONTROL_HOME, root: CONTROL_HOME },
];
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'cache', 'document_cache', 'audio_cache', 'checkpoints', 'logs', 'tmp', '.next', '.turbo', '.cache',
]);

if (!CONTROL_PASSWORD || !CONTROL_SECRET) {
  throw new Error('Missing HERMES_CONTROL_PASSWORD or HERMES_CONTROL_SECRET environment variables');
}

const app = express();

// Security headers — safe config (no HSTS, CSP allows Google Fonts)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'sha256-x0qS2TZv9XGjDs5X2fiLzoolq41ckXzs8zaPKfo4Izg='"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
    },
  },
  hsts: false,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'dist')));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/xterm')));
app.use('/vendor/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules/xterm-addon-fit')));

const sessions = new Map();
const events = [];
// Log streaming state
let logStream = { proc: null, type: null, level: null, clients: new Set() };
let hermesSidebarSessionsCache = { at: 0, data: [] };
const cronJobs = [];
const quickActions = [
  { cmd: 'hermes status', desc: 'Show Hermes health and session status' },
  { cmd: 'hermes skills', desc: 'Inspect installed skills' },
  { cmd: 'hermes cron list', desc: 'List cron jobs' },
  { cmd: 'hermes model', desc: 'Inspect the active model' },
  { cmd: 'hermes config', desc: 'Show Hermes config' },
];
const layoutStorePath = path.join(CONTROL_HOME, 'control-interface-layout.json');

const spriteState = {
  state: 'idle',
  label: 'ready',
  details: 'standing by',
  since: Date.now(),
  frame: 0,
};

const terminalSession = {
  proc: null,
  startedAt: null,
  buffer: '',
  prompt: `root@hermes:${PROJECT_ROOT}# `,
  cwd: PROJECT_ROOT,
  ready: false,
  lastError: null,
  cols: 120,
  rows: 32,
};
const AVATAR_IMAGE_PATH = path.join(CONTROL_STATE_DIR, 'default-avatar.jpg');
const DEFAULT_AVATAR_FALLBACK = AVATAR_IMAGE_PATH;
let avatarDataUrlCache = null;

function ensureControlStateDir() {
  fs.mkdirSync(CONTROL_STATE_DIR, { recursive: true });
}

function readAvatarOverride() {
  try {
    return fs.readFileSync(AVATAR_OVERRIDE_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

function writeAvatarOverride(dataUrl) {
  ensureControlStateDir();
  fs.writeFileSync(AVATAR_OVERRIDE_PATH, String(dataUrl || ''), 'utf8');
  avatarDataUrlCache = String(dataUrl || '');
}

function clearAvatarOverride() {
  avatarDataUrlCache = null;
  try { fs.unlinkSync(AVATAR_OVERRIDE_PATH); } catch {}
}

function getAvatarDataUrl() {
  if (avatarDataUrlCache) return avatarDataUrlCache;
  const override = readAvatarOverride();
  if (override) {
    avatarDataUrlCache = override;
    return avatarDataUrlCache;
  }
  try {
    const buf = fs.readFileSync(DEFAULT_AVATAR_FALLBACK);
    avatarDataUrlCache = `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch (error) {
    log('avatar.missing', error.message || 'avatar image not found');
    avatarDataUrlCache = '';
  }
  return avatarDataUrlCache;
}

function log(kind, message, extra = {}) {
  events.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    ts: new Date().toISOString(),
    kind,
    message,
    ...extra,
  });
  if (events.length > 100) events.splice(0, events.length - 100);
}

function hmac(value) {
  return crypto.createHmac('sha256', CONTROL_SECRET).update(value).digest('hex');
}

function createAuthToken() {
  const ts = Date.now().toString();
  return `${ts}.${hmac(ts)}`;
}

function deriveCsrfToken(authToken) {
  return hmac('csrf:' + authToken);
}

function verifyCsrfToken(req) {
  const headerToken = req.headers['x-csrf-token'];
  if (!headerToken) return false;
  const cookies = parseCookies(req);
  const authToken = cookies[AUTH_COOKIE];
  if (!authToken) return false;
  const expected = deriveCsrfToken(authToken);
  return safeTimingEqual(headerToken, expected);
}

function safeTimingEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [ts, sig] = token.split('.');
  if (!ts || !sig) return false;
  if (Date.now() - Number(ts) > 24 * 60 * 60 * 1000) return false;
  return safeTimingEqual(sig, hmac(ts));
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return raw.split(';').reduce((acc, pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return acc;
    const key = pair.slice(0, idx).trim();
    const value = decodeURIComponent(pair.slice(idx + 1).trim());
    acc[key] = value;
    return acc;
  }, {});
}

function isAuthed(req) {
  const cookies = parseCookies(req);
  return verifyAuthToken(cookies[AUTH_COOKIE]);
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: 'authentication required' });
}

function requireCsrf(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ error: 'authentication required' });
  if (verifyCsrfToken(req)) return next();
  return res.status(403).json({ error: 'invalid CSRF token' });
}

function setAuthCookie(res) {
  const token = createAuthToken();
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${24 * 60 * 60}; Secure`);
  return token;
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure`);
}

function getClientIp(req) {
  const fw = req.headers['x-forwarded-for'];
  if (fw) return String(fw.split(',')[0]).trim();
  return req.socket.remoteAddress || req.ip || 'unknown';
}

// Rate limiter: block an IP after 5 failed login attempts within 15 minutes
// Each failed password check also increments the counter via the handler below
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window
  keyGenerator: (req) => getClientIp(req),
  handler: (req, res) => {
    log('auth.rate_limited', `ip ${getClientIp(req)}`);
    res.status(429).json({
      ok: false,
      error: 'too many failed attempts, try again in 15 minutes',
    });
  },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false,
});

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let value = bytes;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatUptime(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

function trimTerminalBuffer(text, limit = 50000) {
  const raw = String(text || '');
  return raw.length > limit ? raw.slice(raw.length - limit) : raw;
}

function broadcastToClients(message) {
  const payload = JSON.stringify(message);
  for (const client of wss?.clients || []) {
    if (client.readyState === 1 && client.authed) client.send(payload);
  }
}

function startLogStream(logType, level, socket) {
  // Kill existing stream
  stopLogStream();
  const args = ['logs', logType || 'agent', '-f', '-n', '200'];
  if (level) args.push('--level', level);
  logStream.proc = spawn('hermes', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
  logStream.type = logType || 'agent';
  logStream.level = level || 'all';
  logStream.clients.add(socket);
  let buffer = '';
  let flushTimer = null;
  const flush = () => {
    if (buffer && socket.readyState === 1) {
      socket.send(JSON.stringify({ type: 'log-stream', logType: logStream.type, data: buffer }));
      buffer = '';
    }
    flushTimer = null;
  };
  logStream.proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    if (!flushTimer) flushTimer = setTimeout(flush, 200);
  });
  logStream.proc.stderr.on('data', (chunk) => {
    buffer += chunk.toString();
    if (!flushTimer) flushTimer = setTimeout(flush, 200);
  });
  logStream.proc.on('close', () => {
    if (flushTimer) clearTimeout(flushTimer);
    flush();
    logStream.proc = null;
  });
  // Send initial confirmation
  socket.send(JSON.stringify({ type: 'log-stream-start', logType: logStream.type, level: logStream.level }));
}

function stopLogStream() {
  if (logStream.proc) {
    try { logStream.proc.kill('SIGTERM'); } catch {}
    logStream.proc = null;
  }
  logStream.clients.clear();
}

function appendTerminalOutput(chunk) {
  const raw = String(chunk || '');
  if (!raw) return;
  terminalSession.buffer = trimTerminalBuffer(terminalSession.buffer + raw);
  broadcastToClients({
    type: 'terminal-output',
    chunk: raw,
    buffer: terminalSession.buffer,
    ready: terminalSession.ready,
    cwd: terminalSession.cwd,
    prompt: terminalSession.prompt,
  });
}

function ensureTerminalSession() {
  if (terminalSession.proc && terminalSession.ready) return terminalSession;

  const REAL_HOME = os.homedir();
  const env = {
    ...process.env,
    HOME: REAL_HOME,
    USER: REAL_HOME.split('/').pop() || 'root',
    LOGNAME: REAL_HOME.split('/').pop() || 'root',
    SHELL: '/bin/bash',
    TERM: 'xterm-256color',
    HERMES_HOME: CONTROL_HOME,
    HISTFILE: '/dev/null',
    PROMPT_COMMAND: '',
    PS1: terminalSession.prompt,
    PATH: process.env.PATH,
  };

  const proc = pty.spawn('bash', ['--noprofile', '--norc', '-i'], {
    cwd: PROJECT_ROOT,
    env,
    cols: terminalSession.cols,
    rows: terminalSession.rows,
    name: 'xterm-256color',
  });

  terminalSession.proc = proc;
  terminalSession.startedAt = Date.now();
  terminalSession.ready = true;
  terminalSession.lastError = null;
  terminalSession.buffer = '';

  proc.onData((data) => appendTerminalOutput(data));
  proc.onExit(({ exitCode, signal }) => {
    terminalSession.ready = false;
    terminalSession.lastError = `terminal exited ${signal || exitCode}`;
    appendTerminalOutput(`\r\n[terminal exited ${signal || exitCode}]\r\n`);
    terminalSession.proc = null;
  });

  setTimeout(() => {
    if (terminalSession.proc) {
      terminalSession.proc.write(`export PS1='${terminalSession.prompt.replaceAll("'", "'\\''")}'\r`);
      terminalSession.proc.write(`cd ${PROJECT_ROOT}\r`);
    }
  }, 100);

  return terminalSession;
}

function sendTerminalInput(command) {
  const text = String(command || '').replace(/\n+$/g, '');
  if (!text.trim()) return { ok: true, queued: false };
  const session = ensureTerminalSession();
  if (!session.proc) throw new Error('terminal not ready');
  session.proc.write(`${text}\r`);
  return { ok: true, queued: true };
}

function isAllowedPath(filePath) {
  const abs = path.resolve(filePath);
  return ROOTS.some(({ root }) => abs === path.resolve(root) || abs.startsWith(path.resolve(root) + path.sep));
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function readFileSafe(filePath, maxBytes = 120_000) {
  const abs = path.resolve(filePath);
  if (!isAllowedPath(abs)) throw new Error('path outside allowed roots');
  const stat = safeStat(abs);
  if (!stat) throw new Error('file not found');
  if (stat.isDirectory()) throw new Error('EISDIR: illegal operation on a directory, read');
  const buf = fs.readFileSync(abs);
  return buf.toString('utf8', 0, Math.min(buf.length, maxBytes));
}

function writeFileSafe(filePath, content) {
  const abs = path.resolve(filePath);
  if (!isAllowedPath(abs)) throw new Error('path outside allowed roots');
  const stat = safeStat(abs);
  if (!stat) throw new Error('file not found');
  if (stat.isDirectory()) throw new Error('EISDIR: illegal operation on a directory, write');
  fs.writeFileSync(abs, String(content ?? ''), 'utf8');
  return { path: abs, bytes: Buffer.byteLength(String(content ?? ''), 'utf8') };
}

function listDirectory(current, depth, maxDepth, maxEntries, baseRoot) {
  if (depth > maxDepth) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return [];
  }
  entries = entries
    .filter((e) => !e.name.startsWith('.DS_Store') && !IGNORED_DIRS.has(e.name))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const output = [];
  for (const entry of entries) {
    if (output.length >= maxEntries) break;
    const abs = path.join(current, entry.name);
    const node = {
      name: entry.name,
      path: abs,
      rel: path.relative(baseRoot, abs) || entry.name,
      type: entry.isDirectory() ? 'dir' : 'file',
      depth,
      children: [],
    };
    if (entry.isDirectory() && depth < maxDepth) {
      node.children = listDirectory(abs, depth + 1, maxDepth, maxEntries, baseRoot);
    }
    output.push(node);
  }
  return output;
}

function buildExplorerRoot({ key, label, root }) {
  return {
    key,
    label,
    root,
    children: listDirectory(root, 0, 2, 140, root),
  };
}

function getProjects() {
  try {
    return fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name))
      .map((e) => ({ name: e.name, path: path.join(PROJECTS_ROOT, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function parseHermesSessionsList(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  const dataLines = lines.filter((line) =>
    !/^Title\s+Preview\s+Last Active\s+ID$/i.test(line) &&
    !/^[─\-]+$/.test(line) &&
    !/^(Preview|Title|Last Active|Src)\s+(Preview|Title|Last Active|Src)/i.test(line)
  );
  return dataLines.map((line) => {
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length < 4) return null;
    const [title, preview, lastActive, id] = parts;
    return {
      id: String(id || '').trim(),
      title: String(title || '').trim() || '—',
      preview: String(preview || '').trim() || '—',
      lastActive: String(lastActive || '').trim() || '—',
    };
  }).filter(Boolean);
}

function readLayoutStore() {
  try {
    const raw = fs.readFileSync(layoutStorePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeLayoutStore(layout) {
  const payload = {
    updatedAt: new Date().toISOString(),
    panels: Array.isArray(layout?.panels) ? layout.panels : [],
  };
  fs.mkdirSync(path.dirname(layoutStorePath), { recursive: true });
  fs.writeFileSync(layoutStorePath, JSON.stringify(payload, null, 2));
  return payload;
}

function parseHermesCronList(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((line) => line.trimEnd());
  const jobs = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    jobs.push(current);
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (/^┌|^└|^│\s*Scheduled Jobs|^─+$/.test(trimmed)) continue;

    const header = trimmed.match(/^([0-9a-f]{6,})\s+\[(active|paused|inactive|running|stopped)\]$/i);
    if (header) {
      flush();
      current = {
        id: header[1],
        status: header[2].toUpperCase(),
        name: header[1],
        schedule: 'n/a',
        repeat: null,
        nextRun: null,
        lastRun: null,
        deliver: 'n/a',
        source: 'hermes cron list',
      };
      continue;
    }
    if (!current) continue;
    const kv = trimmed.match(/^([A-Za-z ]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (key === 'name') current.name = value || current.name;
    else if (key === 'schedule') current.schedule = value || 'n/a';
    else if (key === 'repeat') current.repeat = value || null;
    else if (key === 'next run') current.nextRun = value || null;
    else if (key === 'last run') current.lastRun = value || null;
    else if (key === 'deliver') current.deliver = value || 'n/a';
  }
  flush();
  return jobs;
}

async function getCronJobs() {
  const now = Date.now();
  if (getCronJobs.cache && now - getCronJobs.cache.at < 10_000) return getCronJobs.cache.data;
  const raw = await shell('hermes cron list');
  if (raw) {
    const data = parseHermesCronList(raw);
    getCronJobs.cache = { at: now, data };
    return data;
  }
  // Preserve existing cache on error — don't clobber with empty fallback
  if (getCronJobs.cache?.data?.length) {
    return getCronJobs.cache.data;
  }
  const fallback = cronJobs.map((job) => ({
    ...job,
    id: job.id || job.name,
    schedule: job.schedule || 'n/a',
    source: job.source || 'local',
    nextRun: job.nextRun || null,
    lastRun: job.lastRun || null,
  }));
  getCronJobs.cache = { at: now, data: fallback };
  return fallback;
}
getCronJobs.cache = { at: 0, data: [] };

function handleCronAction(action, body = {}, query = {}, source = '/api/cron') {
  const normalized = String(action || '').toLowerCase();
  if (normalized === 'list') {
    return { ok: true, action: normalized, jobs: getCronJobs() };
  }
  if (normalized === 'add') {
    const schedule = body.schedule || query.schedule || '';
    const note = body.note || body.message || body.text || query.note || query.message || query.text || '';
    const job = addCronJob({ schedule, note, source: body.source || source });
    return { ok: true, action: normalized, job, jobs: getCronJobs() };
  }
  if (normalized === 'remove') {
    const id = String(body.id || query.id || '');
    const before = cronJobs.length;
    for (let i = cronJobs.length - 1; i >= 0; i -= 1) {
      if (cronJobs[i].id === id || cronJobs[i].name === id) cronJobs.splice(i, 1);
    }
    broadcast();
    return { ok: true, action: normalized, removed: before - cronJobs.length, jobs: getCronJobs() };
  }
  if (normalized === 'pause' || normalized === 'resume') {
    const id = String(body.id || query.id || '');
    const job = cronJobs.find((item) => item.id === id || item.name === id);
    if (!job) {
      const error = new Error('cron job not found');
      error.statusCode = 404;
      throw error;
    }
    job.status = normalized === 'pause' ? 'PAUSED' : 'ACTIVE';
    broadcast();
    return { ok: true, action: normalized, job, jobs: getCronJobs() };
  }
  const error = new Error(`unsupported cron action: ${normalized}`);
  error.statusCode = 400;
  throw error;
}

function maybeHandleSpecialTerminalCommand(command) {
  const trimmed = String(command || '').trim();
  const match = trimmed.match(/^\/cron\s+(\w+)\s*(.*)$/i);
  if (!match) return null;
  const action = match[1].toLowerCase();
  const tail = match[2] || '';
  if (action === 'add') {
    const addMatch = tail.match(/^(\S+)\s+(.+)$/);
    if (!addMatch) throw new Error('usage: /cron add <schedule> <note>');
    return handleCronAction('add', { schedule: addMatch[1], note: normalizeCronLabel(addMatch[2].replace(/^['"]|['"]$/g, '')), source: '/cron add' }, {}, '/cron add');
  }
  if (action === 'list') return handleCronAction('list');
  if (action === 'remove' || action === 'pause' || action === 'resume') {
    const id = normalizeCronLabel(tail.replace(/^['"]|['"]$/g, ''));
    if (!id) throw new Error(`usage: /cron ${action} <id>`);
    return handleCronAction(action, { id, source: '/cron' }, {}, '/cron');
  }
  throw new Error(`unsupported cron action: ${action}`);
}

async function getSessions() {
  const now = Date.now();
  if (hermesSidebarSessionsCache.data.length && now - hermesSidebarSessionsCache.at < 10_000) {
    return hermesSidebarSessionsCache.data;
  }
  const raw = await shell('hermes sessions list --limit 10');
  if (raw) {
    const data = parseHermesSessionsList(raw);
    if (data.length) {
      hermesSidebarSessionsCache = { at: now, data };
      return data;
    }
  }
  // Preserve existing cache on error — don't clobber with empty fallback
  if (hermesSidebarSessionsCache.data.length) {
    return hermesSidebarSessionsCache.data;
  }
  return Array.from(sessions.entries()).map(([id, messages]) => ({
    id,
    title: 'local chat',
    preview: messages.at(-1)?.content?.slice(0, 90) || 'quiet',
    lastActive: 'now',
  }));
}

let hermesAllSessionsCache = { at: 0, data: [] };

async function getAllSessions() {
  const now = Date.now();
  if (hermesAllSessionsCache.data.length && now - hermesAllSessionsCache.at < 10_000) {
    return hermesAllSessionsCache.data;
  }
  const raw = await shell('hermes sessions list --limit 250');
  if (raw) {
    const data = parseHermesSessionsList(raw);
    if (data.length) {
      hermesAllSessionsCache = { at: now, data };
      return data;
    }
  }
  if (hermesAllSessionsCache.data.length) {
    return hermesAllSessionsCache.data;
  }
  return Array.from(sessions.entries()).map(([id, messages]) => ({
    id,
    title: 'local chat',
    preview: messages.at(-1)?.content?.slice(0, 90) || 'quiet',
    lastActive: 'now',
  }));
}

function getSystem() {
  const memTotal = os.totalmem();
  const memUsed = memTotal - os.freemem();
  let disk = null;
  try {
    const st = fs.statfsSync('/');
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    const used = total - free;
    disk = { total, used, free, percent: total ? Math.round((used / total) * 100) : 0 };
  } catch {
    disk = null;
  }
  return {
    host: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    cpuCores: os.cpus().length,
    uptime: process.uptime(),
    load: os.loadavg(),
    memory: { total: memTotal, used: memUsed, percent: Math.round((memUsed / memTotal) * 100) },
    disk,
  };
}

function parseHermesInsights(raw) {
  const text = String(raw || '');
  const grab = (label) => {
    const m = text.match(new RegExp(label + ':\\s+([\\d,]+)'));
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  };
  // Parse overview stats
  const sessions = grab('Sessions');
  const messages = grab('Messages');
  const toolCalls = grab('Tool calls');
  const userMessages = grab('User messages');
  const inputTokens = grab('Input tokens');
  const outputTokens = grab('Output tokens');
  const cacheRead = grab('Cache read');
  const cacheWrite = grab('Cache write');
  const totalTokens = grab('Total tokens');

  // Parse model breakdown
  const modelBreakdown = [];
  const modelRegex = /^[\w.-]+\s+\d+\s+([\d,]+)/gm;
  const modelLines = text.split('\n').filter(l => /^\s+[\w.-]+\s+\d+\s+[\d,]+/.test(l));
  for (const line of modelLines) {
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length >= 3) {
      modelBreakdown.push({
        model: parts[0].trim(),
        sessions: parseInt(parts[1].replace(/,/g, ''), 10) || 0,
        tokens: parseInt(parts[2].replace(/,/g, ''), 10) || 0,
      });
    }
  }

  // Parse period
  const periodMatch = text.match(/Period:\s+(.+)/);
  const period = periodMatch ? periodMatch[1].trim() : '';

  return {
    sessions, messages, toolCalls, userMessages,
    inputTokens, outputTokens, cacheRead, cacheWrite, totalTokens,
    modelBreakdown, period,
    raw: text,
  };
}

async function getInsights(days = 7, source = '') {
  const cacheKey = `${days}|${source}`;
  const now = Date.now();
  if (getInsights.cache[cacheKey] && now - getInsights.cache[cacheKey].at < 300_000) {
    return getInsights.cache[cacheKey].data;
  }
  let cmd = `hermes insights --days ${days}`;
  if (source) cmd += ` --source ${source}`;
  const raw = await shell(cmd, '15s');
  if (raw) {
    const data = parseHermesInsights(raw);
    getInsights.cache[cacheKey] = { at: now, data };
    return data;
  }
  if (getInsights.cache[cacheKey]?.data) return getInsights.cache[cacheKey].data;
  return {
    sessions: 0, messages: 0, toolCalls: 0, userMessages: 0,
    inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    modelBreakdown: [], period: 'unavailable',
  };
}
getInsights.cache = {};

function getTokens(insights) {
  const data = insights || { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, messages: 0, toolCalls: 0, period: '', modelBreakdown: [] };
  return {
    totalTokens: data.totalTokens,
    inputTokens: data.inputTokens,
    outputTokens: data.outputTokens,
    cacheRead: data.cacheRead,
    cacheWrite: data.cacheWrite,
    promptTokens: data.inputTokens,
    completionTokens: data.outputTokens,
    sessions: data.sessions,
    messages: data.messages,
    toolCalls: data.toolCalls,
    period: data.period,
    modelBreakdown: data.modelBreakdown.map(m => ({ model: m.model, tokens: m.tokens })),
  };
}


function buildUsageSummary(insights) {
  const data = insights || { sessions: 0, messages: 0, toolCalls: 0, userMessages: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, period: '', modelBreakdown: [] };
  const recentKinds = events.slice(-50).reduce((acc, event) => {
    acc[event.kind] = (acc[event.kind] || 0) + 1;
    return acc;
  }, {});
  return {
    generatedAt: new Date().toISOString(),
    sessionCount: data.sessions,
    messageCount: data.messages,
    toolCalls: data.toolCalls,
    userMessages: data.userMessages,
    inputTokens: data.inputTokens,
    outputTokens: data.outputTokens,
    cacheRead: data.cacheRead,
    cacheWrite: data.cacheWrite,
    totalTokens: data.totalTokens,
    period: data.period,
    modelBreakdown: data.modelBreakdown,
    eventCount: events.length,
    cronCount: cronJobs.length,
    rootCount: ROOTS.length,
    recentKinds,
    tokenUsage: getTokens(insights),
    lastEvent: events.at(-1) || null,
  };
}

function extractConfigSummary() {
  const configPath = path.join(CONTROL_HOME, 'config.yaml');
  let raw = '';
  let config = {};
  try {
    raw = fs.readFileSync(configPath, 'utf8');
    config = yaml.load(raw) || {};
  } catch {}
  const model = config.model || {};
  const defaultModel = model.default || 'unknown';
  const provider = model.provider || 'unknown';
  const fallbackModel = config.alternate_models?.[0]?.model || 'none';
  const fallbackProvider = config.alternate_models?.[0]?.provider || 'none';
  return { defaultModel, provider, fallbackProvider, fallbackModel, raw };
}

function getSkills() {
  const roots = [
    path.join(CONTROL_HOME, 'skills'),
    path.join(CONTROL_HOME, 'hermes-agent', 'skills'),
  ];
  const skills = new Set();
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) skills.add(entry.name);
      }
    } catch {}
  }
  return Array.from(skills).sort();
}

function getModels() {
  const cfg = extractConfigSummary();
  return [
    { label: 'Default', value: cfg.defaultModel },
    { label: 'Provider', value: cfg.provider },
    { label: 'Fallback', value: `${cfg.fallbackProvider} / ${cfg.fallbackModel}` },
    { label: 'Session model', value: process.env.LLM_MODEL || 'openai/gpt-4o-mini' },
  ];
}

async function buildKnowledgeMarkdown() {
  const raw = await shell('hermes status');
  if (raw) {
    const status = raw.replace(/\r?\n/g, '\n').trim();
    return `## Hermes Status\n\`\`\`\n${status}\n\`\`\``;
  }
  return '## Hermes Status\n`hermes status` unavailable — is Hermes running?';
}

function buildSpriteState() {
  const elapsed = Date.now() - spriteState.since;
  const states = ['idle', 'thinking', 'coding', 'executing'];
  const state = states[Math.floor(elapsed / 5000) % states.length];
  spriteState.state = state;
  spriteState.label = {
    idle: 'ready',
    thinking: 'reasoning',
    coding: 'building',
    executing: 'running',
  }[state];
  spriteState.details = `${getSessions().length} sessions`;
  spriteState.frame = Math.floor(elapsed / 500) % 3;
  return spriteState;
}

async function buildDashboardState(authed = false) {
  const terminal = ensureTerminalSession();
  const [sessionsData, allSessionsData, cronJobsData, insightsData, knowledgeData, profilesData] = await Promise.all([
    getSessions(),
    getAllSessions(),
    getCronJobs(),
    getInsights(),
    buildKnowledgeMarkdown(),
    getProfiles(),
  ]);
  return {
    title: 'Hermes Control Interface',
    now: new Date().toISOString(),
    passwordRequired: true,
    authed,
    agent: buildSpriteState(),
    system: getSystem(),
    sessionCount: sessionsData.length,
    sessions: sessionsData,
    allSessions: allSessionsData,
    cronJobs: cronJobsData,
    profiles: profilesData,
    quickActions,
    explorerRoots: ROOTS.map(buildExplorerRoot),
    tokens: getTokens(insightsData),
    usage: buildUsageSummary(insightsData),
    skills: getSkills(),
    models: getModels(),
    configSummary: extractConfigSummary(),
    knowledge: knowledgeData,
    logs: events.slice(-30),
    loginIdentity: 'root@hermes',
    workingDir: PROJECT_ROOT,
    avatar: (() => {
      const override = readAvatarOverride();
      const hash = override ? crypto.createHash('md5').update(override).digest('hex').slice(0, 12) : 'default';
      return { url: '/api/avatar/image', custom: !!override, hash };
    })(),
    terminal: {
      ready: terminal.ready,
      buffer: terminal.buffer,
      prompt: terminal.prompt,
      cwd: terminal.cwd,
      lastError: terminal.lastError,
    },
  };
}

app.get('/api/session', (req, res) => {
  const authed = isAuthed(req);
  const response = { authenticated: authed, passwordRequired: true, identity: 'root@hermes' };
  if (authed) {
    const cookies = parseCookies(req);
    response.csrfToken = deriveCsrfToken(cookies[AUTH_COOKIE]);
  }
  res.json(response);
});

function verifyPassword(password) {
  // bcrypt hash check (preferred)
  if (CONTROL_PASSWORD.startsWith('$2b$') || CONTROL_PASSWORD.startsWith('$2a$')) {
    return bcrypt.compareSync(password, CONTROL_PASSWORD);
  }
  // plaintext fallback for migration
  return safeTimingEqual(password, CONTROL_PASSWORD);
}

app.post('/api/login', loginRateLimiter, (req, res) => {
  const ip = getClientIp(req);
  const password = String(req.body?.password || '');
  if (!verifyPassword(password)) {
    log('auth.failed', `bad password from ip ${ip}`);
    return res.status(401).json({ ok: false, error: 'bad password' });
  }
  const authToken = setAuthCookie(res);
  const csrfToken = deriveCsrfToken(authToken);
  log('auth.login', 'dashboard unlocked');
  return res.json({ ok: true, csrfToken });
});

app.post('/api/logout', requireCsrf, (req, res) => {
  clearAuthCookie(res);
  log('auth.logout', 'dashboard locked');
  res.json({ ok: true });
});

app.get('/api/dashboard-state', requireAuth, async (req, res) => {
  res.json(await buildDashboardState(true));
});

app.get('/api/sessions', requireAuth, (req, res) => {
  // Short list for sidebar — limit 10, cached 10s
  const data = getSessions();
  res.json({ sessions: data, cachedAt: hermesSidebarSessionsCache.at });
});

app.get('/api/all-sessions', requireAuth, (req, res) => {
  // Full list for agent panel — limit 250, cached 10s
  const data = getAllSessions();
  res.json({ sessions: data, cachedAt: hermesAllSessionsCache.at });
});

function parseHermesProfileList(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  // First line is header, second is separator — skip both, parse from line 3 onward
  const dataLines = lines.slice(2);
  const profiles = [];
  for (const line of dataLines) {
    const active = line.includes('◆');
    const cleaned = line.replace(/[◆\s]+$/, '').replace(/\s*◆\s*/, '').trim();
    const parts = cleaned.split(/\s{2,}/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 3) continue;
    profiles.push({
      name: parts[0] || '',
      model: parts[1] || '—',
      gateway: (parts[2] || '').toLowerCase(),
      alias: parts[3] && parts[3] !== '—' ? parts[3] : null,
      active,
    });
  }
  return profiles;
}

async function getProfiles() {
  const now = Date.now();
  if (getProfiles.cache && now - getProfiles.cache.at < 15_000) return getProfiles.cache.data;
  const raw = await shell('hermes profile list');
  if (raw) {
    const data = parseHermesProfileList(raw);
    getProfiles.cache = { at: now, data };
    return data;
  }
  if (getProfiles.cache?.data?.length) return getProfiles.cache.data;
  return [];
}
getProfiles.cache = { at: 0, data: [] };

app.get('/api/profiles', requireAuth, async (req, res) => {
  const profiles = await getProfiles();
  res.json({ ok: true, profiles });
});

app.post('/api/profiles/use', requireCsrf, async (req, res) => {
  const name = String(req.body?.profile || '').trim();
  if (!name) return res.status(400).json({ error: 'profile name required' });
  try {
    const result = await shell(`hermes profile use ${name}`, '10s');
    // Invalidate profiles cache so next fetch shows updated active profile
    getProfiles.cache = { at: 0, data: [] };
    res.json({ ok: true, profile: name, output: result.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Gateway Service Management ─────────────────────────────────────────────

function getGatewayServiceName(profile) {
  return `hermes-gateway-${profile || 'soci'}`;
}

app.get('/api/gateway/:profile', requireAuth, async (req, res) => {
  const profile = req.params.profile;
  const svc = getGatewayServiceName(profile);
  try {
    const [isActive, isEnabled, status] = await Promise.all([
      shell(`systemctl is-active ${svc} 2>/dev/null || echo inactive`),
      shell(`systemctl is-enabled ${svc} 2>/dev/null || echo disabled`),
      shell(`systemctl status ${svc} 2>/dev/null | head -10`),
    ]);
    res.json({
      ok: true,
      profile,
      service: svc,
      active: isActive.trim() === 'active',
      enabled: isEnabled.trim() === 'enabled',
      status: status.trim(),
    });
  } catch (e) {
    res.json({ ok: true, profile, service: svc, active: false, enabled: false, status: 'not installed' });
  }
});

app.post('/api/gateway/:profile/:action', requireCsrf, async (req, res) => {
  const profile = req.params.profile;
  const action = req.params.action; // start, stop, restart, enable, disable
  const svc = getGatewayServiceName(profile);

  if (!['start', 'stop', 'restart', 'enable', 'disable'].includes(action)) {
    return res.status(400).json({ error: 'invalid action' });
  }

  try {
    // Check if service exists first
    const exists = await shell(`systemctl list-unit-files ${svc}.service 2>&1`);
    if (!exists.includes(svc)) {
      return res.status(400).json({ ok: false, error: `Service ${svc} not installed. Run: bash scripts/setup-gateway-service.sh --profile ${profile} --user root` });
    }
    const result = await shell(`systemctl ${action} ${svc} 2>&1`);
    const isActive = (await shell(`systemctl is-active ${svc} 2>/dev/null || echo inactive`)).trim() === 'active';
    res.json({ ok: true, profile, action, active: isActive, output: result.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/gateway/:profile/logs', requireAuth, async (req, res) => {
  const profile = req.params.profile;
  const svc = getGatewayServiceName(profile);
  const lines = Math.min(parseInt(req.query.lines || '50', 10), 500);
  try {
    const logs = await shell(`journalctl -u ${svc} --no-pager -n ${lines} 2>&1`);
    res.json({ ok: true, profile, service: svc, logs: logs.trim() });
  } catch (e) {
    res.json({ ok: true, profile, service: svc, logs: '' });
  }
});

app.get('/api/explorer', requireAuth, (req, res) => {
  const roots = String(req.query.root || '');
  if (roots) {
    const root = ROOTS.find((r) => r.key === roots);
    if (!root) return res.status(404).json({ error: 'unknown root' });
    return res.json(buildExplorerRoot(root));
  }
  return res.json(ROOTS.map(buildExplorerRoot));
});

app.get('/api/file', requireAuth, (req, res) => {
  const requested = String(req.query.path || '');
  if (!requested) return res.status(400).json({ error: 'path required' });
  try {
    const content = readFileSafe(requested);
    return res.json({ path: path.resolve(requested), content });
  } catch (error) {
    const message = error.message || 'file read failed';
    const status = message.includes('EISDIR') ? 400 : message.includes('not found') ? 404 : 400;
    return res.status(status).json({ error: message });
  }
});

app.post('/api/file', requireCsrf, (req, res) => {
  const { path: filePath, content } = req.body || {};
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const result = writeFileSafe(filePath, content);
    log('file.saved', result.path);
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'save failed' });
  }
});

app.post('/api/terminal/exec', requireCsrf, (req, res) => {
  const command = String(req.body?.command || '').trim();
  if (!command) return res.status(400).json({ error: 'command required' });
  if (command.length > 4096) return res.status(400).json({ error: 'command too long (max 4096 chars)' });
  log('terminal.input', command.slice(0, 120));
  try {
    const special = maybeHandleSpecialTerminalCommand(command);
    if (special) {
      appendTerminalOutput(`
[cron] ${String(command).replace(/^\//, '')}
`);
      return res.json({
        ok: true,
        special: true,
        command,
        cwd: PROJECT_ROOT,
        identity: 'root@hermes',
        ready: terminalSession.ready,
        buffer: terminalSession.buffer,
        timestamp: new Date().toISOString(),
        result: special,
      });
    }
    const result = sendTerminalInput(command);
    return res.json({
      ...result,
      command,
      cwd: PROJECT_ROOT,
      identity: 'root@hermes',
      ready: terminalSession.ready,
      buffer: terminalSession.buffer,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'terminal write failed' });
  }
});

app.post('/api/chat', requireCsrf, async (req, res) => {
  const { message, sessionId = 'control-ui' } = req.body || {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message required' });
  const history = sessions.get(sessionId) || [];
  log('task.started', message.slice(0, 90));
  try {
    const response = 'chat endpoint active — use the terminal for AI responses';
    const nextHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: response }].slice(-30);
    sessions.set(sessionId, nextHistory);
    log('task.completed', `chat: ${sessionId}`);
    res.json({ response, sessionId });
  } catch (error) {
    log('task.error', error.message);
    res.status(500).json({ error: error.message });
  }
});

function parseDurationToMs(input) {
  const value = String(input || '').trim().toLowerCase();
  const match = value.match(/^(\d+)([smhd])$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * multipliers[unit];
}

function normalizeCronLabel(text) {
  return String(text || '').replace(/^\s+|\s+$/g, '');
}

function addCronJob({ schedule, note, source = '/cron add' }) {
  const delay = parseDurationToMs(schedule) ?? 30 * 60_000;
  const now = Date.now();
  const job = {
    id: crypto.randomUUID(),
    name: normalizeCronLabel(note || schedule || 'cron job'),
    schedule: normalizeCronLabel(schedule || '30m'),
    source,
    status: 'ACTIVE',
    createdAt: now,
    nextRun: now + delay,
    lastRun: null,
  };
  cronJobs.unshift(job);
  log('cron.added', `${job.name} @ ${job.schedule}`);
  broadcast();
  return job;
}

app.post('/api/cron/:action', requireCsrf, (req, res) => {
  try {
    const result = handleCronAction(req.params.action, req.body || {}, req.query || {}, '/api/cron');
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message || 'cron action failed' });
  }
});

app.post('/internal/cron/:action', (req, res) => {
  const secret = String(req.get('x-hermes-control-secret') || '');
  if (!secret || !safeTimingEqual(secret, CONTROL_SECRET)) return res.status(403).json({ error: 'forbidden' });
  try {
    const result = handleCronAction(req.params.action, req.body || {}, req.query || {}, '/internal/cron');
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message || 'cron action failed' });
  }
});


app.get('/usage', requireAuth, (req, res) => {
  res.json(buildUsageSummary());
});

app.get('/api/usage', requireAuth, (req, res) => {
  res.json(buildUsageSummary());
});

app.get('/api/insights', requireAuth, async (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 7));
  const source = String(req.query.source || '').trim();
  const data = await getInsights(days, source);
  res.json({ ok: true, ...data, filter: { days, source: source || 'all' } });
});

app.get('/api/layout', requireAuth, (req, res) => {
  res.json({ ok: true, layout: readLayoutStore() });
});

app.post('/api/layout', requireCsrf, (req, res) => {
  try {
    const panels = Array.isArray(req.body?.panels) ? req.body.panels : [];
    const normalized = panels
      .filter((item) => item && item.id)
      .map((item) => ({
        id: String(item.id),
        x: Number(item.x || 0),
        y: Number(item.y || 0),
        w: Number(item.w || 0),
        h: Number(item.h || 0),
      }));
    const saved = writeLayoutStore({ panels: normalized });
    log('layout.saved', `${normalized.length} panels`);
    return res.json({ ok: true, layout: saved });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'layout save failed' });
  }
});

app.get('/api/avatar', requireAuth, (req, res) => {
  res.json({ ok: true, url: '/api/avatar/image', custom: !!readAvatarOverride() });
});

// Debug: force agent sprite state for testing
app.post('/api/agent/state', requireCsrf, (req, res) => {
  const target = String(req.body?.state || '').toLowerCase();
  const valid = ['idle', 'thinking', 'coding', 'executing', 'error'];
  if (!valid.includes(target)) return res.status(400).json({ error: `valid states: ${valid.join(', ')}` });
  const states = ['idle', 'thinking', 'coding', 'executing'];
  const idx = states.indexOf(target);
  if (idx >= 0) {
    spriteState.since = Date.now() - idx * 5000 - 2500; // middle of the slot
    spriteState.state = target;
  }
  log('agent.state.set', target);
  broadcast();
  return res.json({ ok: true, state: target });
});

app.post('/api/avatar', requireCsrf, (req, res) => {
  const dataUrl = String(req.body?.dataUrl || '').trim();
  if (!dataUrl) return res.status(400).json({ error: 'no data' });
  // Accept any image/* data URL with base64 encoding
  if (!dataUrl.startsWith('data:image/') || !dataUrl.includes(';base64,')) {
    return res.status(400).json({ error: 'invalid image data' });
  }
  // Extract base64 part and validate size (max 5MB decoded)
  const b64Part = dataUrl.split(';base64,')[1];
  if (!b64Part || b64Part.length < 10) {
    return res.status(400).json({ error: 'invalid image data' });
  }
  const decodedSize = Math.ceil(b64Part.length * 0.75);
  if (decodedSize > 5 * 1024 * 1024) {
    return res.status(400).json({ error: 'image too large (max 5MB)' });
  }
  writeAvatarOverride(dataUrl);
  log('avatar.uploaded', `len ${dataUrl.length}`);
  broadcast();
  return res.json({ ok: true, url: '/api/avatar/image', custom: true });
});

app.delete('/api/avatar', requireCsrf, (req, res) => {
  clearAvatarOverride();
  log('avatar.reset', 'avatar reverted to default photo');
  broadcast();
  return res.json({ ok: true, src: getAvatarDataUrl(), custom: false });
});

app.get('/api/avatar/image', requireAuth, (req, res) => {
  const override = readAvatarOverride();
  if (override) {
    const match = override.match(/^data:(image\/\w+);base64,(.+)$/);
    if (match) {
      res.set('Content-Type', match[1]);
      res.set('Cache-Control', 'private, max-age=3600');
      return res.send(Buffer.from(match[2], 'base64'));
    }
  }
  try {
    const buf = fs.readFileSync(DEFAULT_AVATAR_FALLBACK);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    return res.send(buf);
  } catch {
    return res.status(404).send('no avatar');
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, title: 'Hermes Control Interface', auth: true, ws: '/ws' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Hermes Control Interface running on port ${PORT}`);
  console.log('Password gate: env-secret only');
  console.log(`Identity: root@hermes`);
});

const wss = new WebSocketServer({ server, path: '/ws' });

async function broadcast() {
  const state = await buildDashboardState(true);
  const payload = JSON.stringify({ type: 'snapshot', payload: state });
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.authed) client.send(payload);
  }
}

wss.on('connection', async (socket, req) => {
  socket.authed = isAuthed(req);
  const state = await buildDashboardState(socket.authed);
  socket.send(JSON.stringify({ type: 'snapshot', payload: state }));
  if (socket.authed && terminalSession.buffer) {
    socket.send(JSON.stringify({
      type: 'terminal-transcript',
      buffer: terminalSession.buffer,
      ready: terminalSession.ready,
      cwd: terminalSession.cwd,
      prompt: terminalSession.prompt,
      cols: terminalSession.cols,
      rows: terminalSession.rows,
    }));
  }
  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      if (msg.type === 'terminal-input' && socket.authed) {
        const data = String(msg.data || '');
        if (data.length > 4096) return;
        const command = data.replace(/[\r\n]+$/g, '');
        if (/^\/cron\s+/i.test(command)) {
          try {
            maybeHandleSpecialTerminalCommand(command);
            appendTerminalOutput(`\r\n[cron] ${command.slice(1)}\r\n`);
          } catch (error) {
            appendTerminalOutput(`\r\n[error] ${error.message}\r\n`);
          }
          return;
        }
        const session = ensureTerminalSession();
        if (session.proc) session.proc.write(data);
      }
      if (msg.type === 'terminal-resize' && socket.authed) {
        const cols = Number(msg.cols || 120);
        const rows = Number(msg.rows || 32);
        terminalSession.cols = cols;
        terminalSession.rows = rows;
        if (terminalSession.proc && terminalSession.proc.resize) terminalSession.proc.resize(cols, rows);
      }
      if (msg.type === 'log-start' && socket.authed) {
        startLogStream(msg.logType || 'agent', msg.level || '', socket);
      }
      if (msg.type === 'log-stop' && socket.authed) {
        stopLogStream();
      }
    } catch {}
  });
});

// Broadcast only on actual state changes (avatar upload/delete, cron actions).
// No periodic broadcast — clients get updates via WS events and targeted API calls.

log('system.started', 'Hermes Control Interface booted');

// Lightweight system metrics broadcast every 5 seconds (no hermes commands)
setInterval(() => {
  broadcastToClients({
    type: 'system-metrics',
    payload: getSystem(),
  });
}, 5000);

// Graceful shutdown
function shutdown(signal) {
  log('system.shutdown', `received ${signal}, shutting down gracefully`);
  // Kill PTY process
  if (terminalSession.proc) {
    try { terminalSession.proc.kill(); } catch {}
  }
  // Close WebSocket connections
  for (const client of wss.clients) {
    try { client.close(1001, 'server shutting down'); } catch {}
  }
  // Close server
  server.close(() => {
    log('system.shutdown', 'server closed');
    process.exit(0);
  });
  // Force exit after 5 seconds
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
