require('dotenv').config();
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 10272);
const CONTROL_PASSWORD = process.env.HERMES_CONTROL_PASSWORD;
const CONTROL_SECRET = process.env.HERMES_CONTROL_SECRET;
const AUTH_COOKIE = 'hermes_control_auth';
const PROJECT_ROOT = __dirname;
const PROJECTS_ROOT = process.env.HERMES_PROJECTS_ROOT || path.dirname(PROJECT_ROOT);
const CONTROL_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
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
  { key: 'projects', label: PROJECTS_ROOT, root: PROJECTS_ROOT },
  { key: 'hermes', label: CONTROL_HOME, root: CONTROL_HOME },
];
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'cache', 'document_cache', 'audio_cache', 'checkpoints', 'logs', 'tmp', '.next', '.turbo', '.cache',
]);

if (!CONTROL_PASSWORD || !CONTROL_SECRET) {
  throw new Error('Missing HERMES_CONTROL_PASSWORD or HERMES_CONTROL_SECRET environment variables');
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'website')));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/xterm')));
app.use('/vendor/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules/xterm-addon-fit')));

const sessions = new Map();
const events = [];
let hermesSessionsCache = { at: 0, data: [] };
const cronJobs = [
  { name: 'daily-memory-distill', status: 'ACTIVE', nextRun: Date.now() + 1000 * 60 * 60, lastRun: Date.now() - 1000 * 60 * 60 * 24 },
  { name: 'weekly-maintenance', status: 'ACTIVE', nextRun: Date.now() + 1000 * 60 * 60 * 24 * 2, lastRun: Date.now() - 1000 * 60 * 60 * 24 * 6 },
  { name: 'trend-watch', status: 'PAUSED', nextRun: Date.now() + 1000 * 60 * 15, lastRun: Date.now() - 1000 * 60 * 30 },
];
const quickActions = [
  { cmd: 'hermes status', desc: 'Show Hermes health and session status' },
  { cmd: 'hermes skills', desc: 'Inspect installed skills' },
  { cmd: 'hermes cron list', desc: 'List cron jobs' },
  { cmd: 'hermes model', desc: 'Inspect the active model' },
  { cmd: 'hermes config', desc: 'Show Hermes config' },
];
const layoutStorePath = path.join(process.env.HERMES_HOME || '/root/.hermes', 'control-interface-layout.json');

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

function setAuthCookie(res) {
  const token = createAuthToken();
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${24 * 60 * 60}`);
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

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

  const env = {
    ...process.env,
    HOME: '/root',
    USER: 'root',
    LOGNAME: 'root',
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
  const dataLines = lines.filter((line) => !/^Title\s+Preview\s+Last Active\s+ID$/i.test(line) && !/^[─\-]+$/.test(line));
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

function getCronJobs() {
  const now = Date.now();
  if (getCronJobs.cache && now - getCronJobs.cache.at < 10_000) return getCronJobs.cache.data;
  try {
    const raw = execFileSync('bash', ['-lc', 'timeout 8s hermes cron list 2>&1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const data = parseHermesCronList(raw);
    getCronJobs.cache = { at: now, data };
    return data;
  } catch (error) {
    log('cron.list.error', error.message || 'failed to run hermes cron list');
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

function getSessions() {
  const now = Date.now();
  if (hermesSessionsCache.data.length && now - hermesSessionsCache.at < 10_000) {
    return hermesSessionsCache.data;
  }

  try {
    const raw = execFileSync('bash', ['-lc', 'timeout 8s hermes sessions list 2>&1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const data = parseHermesSessionsList(raw);
    hermesSessionsCache = { at: now, data };
    return data;
  } catch (error) {
    log('sessions.list.error', error.message || 'failed to run hermes sessions list');
    return Array.from(sessions.entries()).map(([id, messages]) => ({
      id,
      title: 'local chat',
      preview: messages.at(-1)?.content?.slice(0, 90) || 'quiet',
      lastActive: 'now',
    }));
  }
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

function getTokens() {
  const total = Array.from(sessions.values()).reduce(
    (sum, messages) => sum + messages.reduce((m, msg) => m + Math.max(1, Math.round((msg.content || '').length / 4)), 0),
    0,
  );
  return {
    totalTokens: total + Math.round(process.uptime() * 2),
    promptTokens: Math.round(total * 0.6),
    completionTokens: Math.round(total * 0.4),
    modelBreakdown: [
      { model: 'gpt-5.4-mini', tokens: Math.round(total * 0.45) },
      { model: 'minimax-m2.7', tokens: Math.round(total * 0.18) },
      { model: 'gpt-5.3-codex', tokens: Math.round(total * 0.1) },
      { model: 'other', tokens: Math.max(0, total - Math.round(total * 0.73)) },
    ],
  };
}


function buildUsageSummary() {
  const tokenUsage = getTokens();
  const messageCount = Array.from(sessions.values()).reduce((sum, messages) => sum + messages.length, 0);
  const recentKinds = events.slice(-50).reduce((acc, event) => {
    acc[event.kind] = (acc[event.kind] || 0) + 1;
    return acc;
  }, {});
  return {
    generatedAt: new Date().toISOString(),
    sessionCount: sessions.size,
    messageCount,
    eventCount: events.length,
    cronCount: cronJobs.length,
    rootCount: ROOTS.length,
    recentKinds,
    tokenUsage,
    lastEvent: events.at(-1) || null,
  };
}

function extractConfigSummary() {
  const configPath = path.join(CONTROL_HOME, 'config.yaml');
  let raw = '';
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {}
  const defaultModel = (raw.match(/default:\s*([^\n]+)/) || [])[1]?.trim() || 'unknown';
  const provider = (raw.match(/provider:\s*([^\n]+)/) || [])[1]?.trim() || 'unknown';
  const fallbackProvider = (raw.match(/fallback_model:[\s\S]*?provider:\s*([^\n]+)/) || [])[1]?.trim() || 'none';
  const fallbackModel = (raw.match(/fallback_model:[\s\S]*?model:\s*([^\n]+)/) || [])[1]?.trim() || 'none';
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

function buildKnowledgeMarkdown() {
  const cfg = extractConfigSummary();
  const skills = getSkills();
  const models = getModels();
  return [
    '# Hermes Knowledge',
    '',
    '## Skills',
    ...skills.slice(0, 30).map((s) => `- ${s}`),
    '',
    '## Models',
    ...models.map((m) => `- ${m.label}: ${m.value}`),
    '',
    '## Hermes config',
    `- default: ${cfg.defaultModel}`,
    `- provider: ${cfg.provider}`,
    `- fallback: ${cfg.fallbackProvider} / ${cfg.fallbackModel}`,
    '',
    '## Notes',
    `- explorer defaults to ${PROJECTS_ROOT} and ${CONTROL_HOME}`,
    '- directory clicks only expand and never attempt read',
    '- file saves require explicit write action',
    '- terminal panel runs the real `hermes` command',
  ].join('\n');
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
  spriteState.details = `${getSessions().length} sessions • ${getProjects().length} projects`;
  spriteState.frame = Math.floor(elapsed / 500) % 3;
  return spriteState;
}

function buildDashboardState(authed = false) {
  const terminal = ensureTerminalSession();
  return {
    title: 'Hermes Control Interface',
    now: new Date().toISOString(),
    passwordRequired: true,
    authed,
    system: getSystem(),
    agent: buildSpriteState(),
    projects: getProjects(),
    sessions: getSessions(),
    cronJobs: getCronJobs(),
    quickActions,
    explorerRoots: ROOTS.map(buildExplorerRoot),
    tokens: getTokens(),
    usage: buildUsageSummary(),
    skills: getSkills(),
    models: getModels(),
    configSummary: extractConfigSummary(),
    knowledge: buildKnowledgeMarkdown(),
    logs: events.slice(-30),
    loginIdentity: 'root@hermes',
    workingDir: PROJECT_ROOT,
    avatar: {
      src: getAvatarDataUrl(),
    },
    terminal: {
      ready: terminal.ready,
      buffer: terminal.buffer,
      prompt: terminal.prompt,
      cwd: terminal.cwd,
      lastError: terminal.lastError,
    },
  };
}

function offlineReply(message) {
  const lower = String(message || '').toLowerCase();
  if (lower.includes('status')) return 'status ok\nterminal alive\nhermes ready';
  if (lower.includes('skills')) return 'skills listed\nknowledge panel synced';
  if (lower.includes('model')) return 'model info live\ncheck the top bar';
  return 'command recv\nno api key needed for local dashboard mode';
}

function runShell(command) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      HOME: '/root',
      USER: 'root',
      LOGNAME: 'root',
      SHELL: '/bin/bash',
      TERM: 'xterm-256color',
      HERMES_HOME: CONTROL_HOME,
      PATH: process.env.PATH,
    };
    const child = exec(command, {
      cwd: PROJECT_ROOT,
      env,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      shell: '/bin/bash',
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });
    child.stdin?.end();
  });
}

function buildTerminalCommand(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (raw === 'hermes') return 'timeout 8s hermes --help 2>&1 | head -n 16';
  return raw;
}

app.get('/api/session', (req, res) => {
  res.json({ authenticated: isAuthed(req), passwordRequired: true, identity: 'root@hermes' });
});

app.post('/api/login', (req, res) => {
  const password = String(req.body?.password || '');
  if (password !== CONTROL_PASSWORD) {
    log('auth.failed', 'bad password attempt');
    return res.status(401).json({ ok: false, error: 'bad password' });
  }
  setAuthCookie(res);
  log('auth.login', 'dashboard unlocked');
  return res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  clearAuthCookie(res);
  log('auth.logout', 'dashboard locked');
  res.json({ ok: true });
});

app.get('/api/dashboard-state', requireAuth, (req, res) => {
  res.json(buildDashboardState(true));
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

app.post('/api/file', requireAuth, (req, res) => {
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

app.post('/api/terminal/exec', requireAuth, (req, res) => {
  const command = String(req.body?.command || '').trim();
  if (!command) return res.status(400).json({ error: 'command required' });
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

app.post('/api/chat', requireAuth, async (req, res) => {
  const { message, sessionId = 'control-ui' } = req.body || {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message required' });
  const history = sessions.get(sessionId) || [];
  log('task.started', message.slice(0, 90));
  try {
    const response = process.env.LLM_API_KEY ? await offlineReply(message) : offlineReply(message);
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

app.post('/api/cron/:action', requireAuth, (req, res) => {
  try {
    const result = handleCronAction(req.params.action, req.body || {}, req.query || {}, '/api/cron');
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message || 'cron action failed' });
  }
});

app.post('/internal/cron/:action', (req, res) => {
  const secret = String(req.get('x-hermes-control-secret') || '');
  if (!secret || secret !== CONTROL_SECRET) return res.status(403).json({ error: 'forbidden' });
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

app.get('/api/layout', requireAuth, (req, res) => {
  res.json({ ok: true, layout: readLayoutStore() });
});

app.post('/api/layout', requireAuth, (req, res) => {
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
  res.json({ ok: true, src: getAvatarDataUrl(), custom: !!readAvatarOverride() });
});

app.post('/api/avatar', requireAuth, (req, res) => {
  const dataUrl = String(req.body?.dataUrl || '').trim();
  if (!/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(dataUrl)) {
    return res.status(400).json({ error: 'invalid image data' });
  }
  writeAvatarOverride(dataUrl);
  log('avatar.uploaded', `len ${dataUrl.length}`);
  broadcast();
  return res.json({ ok: true, src: dataUrl, custom: true });
});

app.delete('/api/avatar', requireAuth, (req, res) => {
  clearAvatarOverride();
  log('avatar.reset', 'avatar reverted to default photo');
  broadcast();
  return res.json({ ok: true, src: getAvatarDataUrl(), custom: false });
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

function broadcast() {
  const payload = JSON.stringify({ type: 'snapshot', payload: buildDashboardState(true) });
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.authed) client.send(payload);
  }
}

wss.on('connection', (socket, req) => {
  socket.authed = isAuthed(req);
  socket.send(JSON.stringify({ type: 'snapshot', payload: buildDashboardState(socket.authed) }));
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
    } catch {}
  });
});

setInterval(() => {
  log('system.metrics.updated', `mem ${formatBytes(process.memoryUsage().rss)} load ${os.loadavg()[0].toFixed(2)}`);
  broadcast();
}, 2000);

log('system.started', 'Hermes Control Interface booted');
