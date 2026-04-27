require('dotenv').config();
const https = require('https');
const express = require('express');
const helmet = require('helmet');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const rateLimit = require('express-rate-limit');
const yaml = require('js-yaml');
const Database = require('better-sqlite3');
const { getConfig } = require('./lib/hci-config');
const {
  mergeSessionsFromSources,
  parseHermesSessionsList,
} = require('./lib/session-list');

// ── TUI Gateway Bridge ──
const { getBridge, killAllBridges } = require('./lib/tui-gateway-bridge');

// ── LLM Pricing (via @pydantic/genai-prices) ──
const { calcPrice } = require('@pydantic/genai-prices');

// Free models (no cost regardless of pricing data)
const FREE_MODELS = new Set([
  'xiaomi/mimo-v2-pro',
  'mimo-v2-pro',
]);

// Hermes billing_provider → genai-prices providerId mapping
const PROVIDER_MAP = {
  'openrouter':    'openrouter',
  'openai-codex':  'openai',
  'opencode-go':   'openrouter', // minimax available via OpenRouter pricing
};

// Custom pricing for models not in genai-prices (per million tokens)
const CUSTOM_PRICING = {
  'minimax-m2':   { input_mtok: 0.30, output_mtok: 1.20, cache_read_mtok: 0.03 },
  'minimax-m2.7': { input_mtok: 0.30, output_mtok: 1.20, cache_read_mtok: 0.03 },
};

// Calculate cost in USD from token counts
function calculateCost(model, inputTokens, outputTokens, cacheReadTokens = 0, billingProvider) {
  if (!model || FREE_MODELS.has(model)) return 0;

  // genai-prices expects input_tokens = total input (including cache)
  // Our DB stores input and cache separately, so combine them
  const usage = {
    input_tokens: inputTokens + cacheReadTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
  };

  // 1. Try with provider hint
  const providerId = PROVIDER_MAP[billingProvider];
  if (providerId) {
    try {
      const r = calcPrice(usage, model, { providerId });
      if (r) return r.total_price;
    } catch (_) { /* fallback to next */ }
  }

  // 2. Try without provider (match across all providers)
  try {
    const r = calcPrice(usage, model);
    if (r) return r.total_price;
  } catch (_) { /* fallback to custom pricing */ }

  // 3. Custom pricing fallback
  const custom = CUSTOM_PRICING[model];
  if (custom) {
    return (inputTokens / 1e6) * custom.input_mtok
      + (outputTokens / 1e6) * custom.output_mtok
      + (cacheReadTokens / 1e6) * (custom.cache_read_mtok || custom.input_mtok * 0.1);
  }

  return 0;
}

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

// Safer execution — no bash interpretation, direct args
function execHermes(args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile('hermes', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout,
    }, (err, stdout, stderr) => {
      // stderr often contains real error messages hermes doesn't write to stdout
      const output = err ? (stdout + '\n' + stderr) : stdout;
      resolve(output);
    });
  });
}

// ── Load HCI config (hci.config.yaml + env overrides) ──
const cfg = getConfig();

const PORT            = cfg.port;
const CONTROL_PASSWORD = cfg.password;
const CONTROL_SECRET  = cfg.secret;
const AUTH_COOKIE      = cfg.session.cookieName;
const PROJECT_ROOT     = __dirname;
const PROJECTS_ROOT    = cfg.projectsRoot;

// Dynamic identity — works for root and non-root users
const HCI_USER = os.userInfo().username;
const HCI_HOST = os.hostname();
const HCI_IDENTITY = `${HCI_USER}@${HCI_HOST}`;
const IS_ROOT = process.getuid() === 0;
// systemctl/journalctl: add --user flag for non-root
const SYSTEMD_USER_FLAG = IS_ROOT ? '' : '--user';
// XDG_RUNTIME_DIR: required for systemctl --user to work
// Auto-detect if not set (e.g. running via sudo -u without login session)
if (!IS_ROOT && !process.env.XDG_RUNTIME_DIR) {
  const uid = process.getuid();
  const runtimeDir = `/run/user/${uid}`;
  if (fs.existsSync(runtimeDir)) {
    process.env.XDG_RUNTIME_DIR = runtimeDir;
  }
}


// Cookie helper — conditionally adds Secure flag for HTTPS
function setAuthCookie(res, token, maxAge = cfg.session.cookieMaxAge) {
  const secure = cfg.session.secure !== null
    ? cfg.session.secure
    : res.req?.secure || res.req?.get('X-Forwarded-Proto') === 'https';
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}
function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
const CONTROL_HOME = cfg.hermesHome;
const CONTROL_STATE_DIR = path.join(CONTROL_HOME, 'control-interface');
const AVATAR_OVERRIDE_PATH = path.join(CONTROL_STATE_DIR, 'avatar.dataurl');
const STATE_DB_PATH = path.join(CONTROL_HOME, 'state.db');

// Explorer roots — already parsed by hci-config.js
const ROOTS = cfg.roots;
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
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://portal.nousresearch.com"],
      connectSrc: ["'self'", "ws:", "wss:"],
      upgradeInsecureRequests: null,
    },
  },
  hsts: false,
}));

app.use(express.json({ limit: '1mb' }));
// Vite-built assets have content hashes — safe to cache aggressively
app.use(express.static(path.join(__dirname, 'dist'), {
  maxAge: '365d',
  immutable: true,
  setHeaders: (res, filePath) => {
    // HTML files should NEVER be cached (they reference hashed assets)
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

// API responses should NEVER be cached
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm'), { maxAge: '30d' }));
app.use('/vendor/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit'), { maxAge: '30d' }));

// ── Plugin System ──
// Scan ~/.hermes/skills/*/ui/manifest.json for plugin registrations
function findPluginManifests() {
  const skillsDir = path.join(os.homedir(), '.hermes', 'skills');
  const manifests = [];
  if (!fs.existsSync(skillsDir)) return manifests;
  try {
    const categories = fs.readdirSync(skillsDir);
    for (const cat of categories) {
      const catDir = path.join(skillsDir, cat);
      if (!fs.statSync(catDir).isDirectory()) continue;
      try {
        const skills = fs.readdirSync(catDir);
        for (const skill of skills) {
          const manifestPath = path.join(catDir, skill, 'ui', 'manifest.json');
          if (fs.existsSync(manifestPath)) {
            try {
              const plugin = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
              plugin.path = path.join(catDir, skill);
              plugin.uiPath = path.join(catDir, skill, 'ui');
              plugin.status = plugin.premium ? 'locked' : 'active';
              manifests.push(plugin);
            } catch (e) { log('plugin.parse', `Failed to parse ${manifestPath}: ${e.message}`); }
          }
        }
      } catch {}
    }
  } catch {}
  return manifests;
}

// List plugins API
app.get('/api/plugins', requireRole('admin'), (req, res) => {
  const plugins = findPluginManifests().map(p => ({
    id: p.id,
    name: p.name,
    version: p.version,
    description: p.description,
    icon: p.icon || '📦',
    pages: p.pages || [],
    status: p.status,
    premium: p.premium || false,
    price: p.price || null,
  }));
  res.json({ ok: true, plugins });
});

// Serve plugin static files (UI assets)
app.use('/plugins/:id', (req, res, next) => {
  const plugins = findPluginManifests();
  const plugin = plugins.find(p => p.id === req.params.id);
  if (!plugin) return res.status(404).json({ error: 'plugin not found' });
  if (plugin.status === 'locked') return res.status(402).json({ error: 'premium required', price: plugin.price });
  express.static(plugin.uiPath, { maxAge: '1h' })(req, res, next);
});

const events = [];

// ── Chat System — uses real hermes sessions from state.db ──
// No in-memory chat sessions — sidebar shows actual hermes sessions
// Sending a message uses --resume with the real hermes session ID

// ── Gateway API Proxy (fast, structured events) ────────────────────
// Gateway API key: explicit config → auto-discover from hermes config.yaml
const GATEWAY_API_KEY = cfg.gatewayApiKey || loadGatewayApiKey();
const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');

// Load gateway API key from default profile config.yaml
function loadGatewayApiKey() {
  try {
    const yaml = require('js-yaml');
    const configPath = path.join(os.homedir(), '.hermes', 'config.yaml');
    if (fs.existsSync(configPath)) {
      const cfg = yaml.load(fs.readFileSync(configPath, 'utf8'));
      return cfg?.platforms?.api_server?.extra?.key || '';
    }
  } catch {}
  return '';
}

// Resolve CORS origins for gateway config injection
// Priority: explicit config → HCI_CORS_ORIGINS env var → auto-detect from request
function resolveCorsOrigins(req) {
  // If loaded from config/env, use it directly (already comma-separated string)
  if (cfg.corsOrigins) return cfg.corsOrigins;
  // If env var set, use it directly (comma-separated)
  if (process.env.HCI_CORS_ORIGINS) return process.env.HCI_CORS_ORIGINS;
  // Auto-detect from the incoming request origin
  const origin = req?.headers?.origin || req?.get?.('origin') || '';
  if (origin) return origin;
  // Defaults: localhost common dev ports
  return 'http://localhost:3000,http://localhost:5173,http://localhost:10272,http://127.0.0.1:3000,http://127.0.0.1:5173,http://127.0.0.1:10272';
}

// Dynamic profile → Gateway API port discovery
// Scans ~/.hermes/config.yaml (default) + ~/.hermes/profiles/*/config.yaml
function discoverGatewayPorts() {
  const ports = {};
  const baseHermesHome = path.join(os.homedir(), '.hermes');
  try {
    // Default profile: ~/.hermes/config.yaml (base, not HERMES_HOME which may be profile-specific)
    const defaultConf = fs.readFileSync(path.join(baseHermesHome, 'config.yaml'), 'utf8');
    const defaultCfg = yaml.load(defaultConf);
    // Check both platforms.api_server (injected) and top-level api_server (legacy)
    const ds = defaultCfg.platforms?.api_server || defaultCfg.api_server;
    if (ds?.enabled && ds?.extra?.port) {
      ports['default'] = ds.extra.port;
    }
  } catch (_) { /* no default config */ }

  // Other profiles: ~/.hermes/profiles/<name>/config.yaml
  const profilesDir = path.join(baseHermesHome, 'profiles');
  try {
    for (const name of fs.readdirSync(profilesDir)) {
      try {
        const confPath = path.join(profilesDir, name, 'config.yaml');
        const raw = fs.readFileSync(confPath, 'utf8');
        const cfg = yaml.load(raw);
        const apiSrv = cfg.platforms?.api_server || cfg.api_server;
        if (apiSrv?.enabled && apiSrv?.extra?.port) {
          ports[name] = apiSrv.extra.port;
        }
      } catch (_) { /* skip broken config */ }
    }
  } catch (_) { /* no profiles dir */ }
  return ports;
}

let gatewayPorts = discoverGatewayPorts();
console.log('[Gateway] Discovered ports:', gatewayPorts);

// Refresh on config changes (watch profiles dir)
try {
  fs.watch(path.join(HERMES_HOME, 'profiles'), { recursive: true }, (event, filename) => {
    if (filename?.endsWith('config.yaml')) {
      gatewayPorts = discoverGatewayPorts();
      console.log('[Gateway] Ports refreshed:', gatewayPorts);
    }
  });
} catch (_) { /* fs.watch not supported */ }

function getGatewayBase(profile) {
  const port = gatewayPorts[profile] || gatewayPorts['default'];
  if (!port) return null; // no gateway api available
  return `http://127.0.0.1:${port}`;
}

// Read default model from profile config.yaml
function getDefaultModel(profile) {
  const baseHermesHome = path.join(os.homedir(), '.hermes');
  try {
    const configPath = profile === 'default'
      ? path.join(baseHermesHome, 'config.yaml')
      : path.join(baseHermesHome, 'profiles', profile, 'config.yaml');
    if (fs.existsSync(configPath)) {
      const cfg = yaml.load(fs.readFileSync(configPath, 'utf8'));
      return cfg?.model?.default || cfg?.model || 'moonshotai/kimi-k2.6';
    }
  } catch (_) { /* fallback */ }
  return 'moonshotai/kimi-k2.6';
}

// GET /api/gateway/ports — discovered gateway API ports per profile
app.get('/api/gateway/ports', requireAuth, (req, res) => {
  res.json({ ports: gatewayPorts, profiles: Object.keys(gatewayPorts) });
});

// POST /api/gateway/responses — start a new agent run via Gateway API
app.post('/api/gateway/responses', requireAuth, requirePerm('chat.use'), async (req, res) => {
  const { message, profile, session_id, model, stream = true } = req.body || {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message required' });

  console.log(`[GatewayChat] profile="${profile || 'default'}", available ports:`, gatewayPorts);

  try {
    const gatewayBase = getGatewayBase(profile || 'default');
    if (!gatewayBase) {
      console.log(`[GatewayChat] No gateway for profile "${profile || 'default'}", falling back`);
      return res.status(503).json({ error: 'Gateway API not available for profile: ' + (profile || 'default') });
    }
    console.log(`[GatewayChat] Routing to ${gatewayBase}/v1/responses`);
    const gatewayBody = {
      model: model || getDefaultModel(profile || 'default'),
      input: message,
      stream,
    };
    // Use X-Hermes-Session-Id header for conversation continuity
    const gwHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GATEWAY_API_KEY}`,
    };
    if (session_id) {
      gwHeaders['X-Hermes-Session-Id'] = session_id;
    }

    const gatewayRes = await fetch(`${gatewayBase}/v1/responses`, {
      method: 'POST',
      headers: gwHeaders,
      body: JSON.stringify(gatewayBody),
    });

    console.log(`[GatewayChat] Response status: ${gatewayRes.status}`);

    if (!gatewayRes.ok) {
      const errText = await gatewayRes.text();
      console.log(`[GatewayChat] Gateway error: ${errText}`);
      return res.status(gatewayRes.status).json({ error: `Gateway error: ${errText}` });
    }

    // Extract Hermes session ID from Gateway response headers
    const hermesSessionId = gatewayRes.headers.get('x-hermes-session-id') || '';

    if (!stream) {
      const data = await gatewayRes.json();
      if (hermesSessionId) data._hermes_session_id = hermesSessionId;
      return res.json(data);
    }

    // Streaming: proxy SSE events to client using Web ReadableStream API
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(hermesSessionId ? { 'X-Hermes-Session-Id': hermesSessionId } : {}),
    });

    // Inject session ID as first SSE event so frontend can pick it up
    if (hermesSessionId) {
      res.write(`event: hci.session\ndata: ${JSON.stringify({ type: 'hci.session', session_id: hermesSessionId })}\n\n`);
    }

    const webReader = gatewayRes.body.getReader();
    const decoder = new TextDecoder();
    let aborted = false;

    // Client abort → cancel gateway stream
    req.on('close', () => {
      aborted = true;
      webReader.cancel().catch(() => {});
    });

    // Pipe chunks from Gateway to client
    (async () => {
      try {
        while (!aborted) {
          const { done, value } = await webReader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          res.write(chunk);
        }
      } catch (pipeErr) {
        console.error('[Gateway proxy] pipe error:', pipeErr.message);
      } finally {
        res.end();
      }
    })();
  } catch (e) {
    console.error('[Gateway proxy] error:', e.message);
    if (!res.headersSent) {
      return res.status(502).json({ error: `Gateway unavailable: ${e.message}` });
    }
    res.end();
  }
});

app.post('/api/chat/send', requireAuth, requirePerm('chat.use'), async (req, res) => {
  const { message, profile, sessionId, model } = req.body || {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message required' });

  const prof = sanitizeProfileName(profile) || 'default';

  // Build hermes command
  const escapedMsg = "'" + message.replace(/'/g, "'\\''") + "'";
  const profileFlag = prof !== 'default' ? `-p ${prof}` : '';
  const modelFlag = model ? `-m ${model}` : '';
  // Resume existing session, or create new with empty --continue flag
  const resumeFlag = sessionId ? `--resume ${sessionId}` : '--continue ""';
  const fullCmd = `hermes chat -Q -q ${escapedMsg} ${profileFlag} ${modelFlag} ${resumeFlag} 2>&1`;

  // SSE response
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const startTime = Date.now();
  let fullResponse = '';

  try {
    const proc = spawn('bash', ['-lc', fullCmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HERMES_HOME: path.join(os.homedir(), '.hermes') },
    });

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      fullResponse += text;
      // With -Q flag, output is clean — stream directly
      const cleaned = text
        .replace(/╭[═─╮][\s\S]*?╰[═─╯][^\n]*\n?/g, '') // safety: strip any remaining banners
        .replace(/^Session:\s+\d+.*$/gm, '')
        .replace(/^Resume this session with:.*$/gm, '')
        .replace(/^Duration:.*$/gm, '')
        .replace(/^Messages:.*$/gm, '')
        .replace(/^Query:.*$/gm, '')
        .replace(/^-{10,}$/gm, '')
        .replace(/^Initializing agent.*$/gm, '');
      if (cleaned.trim()) {
        res.write(`data: ${JSON.stringify({ type: 'token', content: cleaned })}\n\n`);
      }
    });

    proc.stderr.on('data', (chunk) => {
      res.write(`data: ${JSON.stringify({ type: 'error', content: chunk.toString() })}\n\n`);
    });

    proc.on('close', () => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      // Extract real hermes session ID from output
      const sidMatch = fullResponse.match(/session_id:\s*([0-9]{8}_[0-9]{6}_[a-f0-9]+)/i)
                   || fullResponse.match(/Session:\s+([0-9]{8}_[0-9]{6}_[a-f0-9]+)/i);
      const newSessionId = sidMatch ? sidMatch[1] : sessionId || '';
      res.write(`data: ${JSON.stringify({ type: 'done', sessionId: newSessionId, elapsed: parseFloat(elapsed) })}\n\n`);
      res.end();
    });
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'error', content: e.message })}\n\n`);
    res.end();
  }
});

// POST /api/chat/fork — create a new session forked from a source session up to message_index
app.post('/api/chat/fork', requireAuth, requireCsrf, requirePerm('chat.use'), (req, res) => {
  const { sessionId, messageIndex, profile } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId required' });
  }
  if (messageIndex == null || typeof messageIndex !== 'number' || messageIndex < 0) {
    return res.status(400).json({ error: 'messageIndex must be a non-negative number' });
  }

  const prof = sanitizeProfileName(profile) || 'default';
  const stateDbPath = getStateDbPath(prof);

  if (!fs.existsSync(stateDbPath)) {
    return res.status(404).json({ error: 'session store not found for profile: ' + prof });
  }

  let db;
  try {
    db = new Database(stateDbPath, { readonly: false });

    // Verify source session exists
    const sourceSession = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!sourceSession) {
      return res.status(404).json({ error: 'source session not found' });
    }

    // Get messages for the source session, ordered by id, up to message_index (inclusive, 0-based)
    // We use id <= (SELECT MIN(id) FROM messages WHERE session_id = ? AND rowid > ...) approach
    // Simpler: grab all messages for this session sorted by id, slice to messageIndex + 1
    const messages = db.prepare(`
      SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC
    `).all(sessionId);

    if (messageIndex >= messages.length) {
      return res.status(400).json({ error: 'messageIndex out of range for this session' });
    }

    const messagesToFork = messages.slice(0, messageIndex + 1);

    // Generate new session ID: YYYYMMDD_HHMMSS_randomHex
    const now = new Date();
    const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/^(\d{8})(\d{6})$/, '$1_$2_');
    const rand = crypto.randomBytes(4).toString('hex');
    const newSessionId = ts + rand;

    // Calculate message_count for forked session
    const forkedMessageCount = messagesToFork.length;

    // Copy the source session, but give it a new id and set parent_session_id
    db.prepare(`
      INSERT INTO sessions (
        id, source, user_id, model, model_config, system_prompt,
        parent_session_id, started_at, ended_at, end_reason,
        message_count, tool_call_count, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens,
        billing_provider, billing_base_url, billing_mode,
        estimated_cost_usd, actual_cost_usd, cost_status, cost_source,
        pricing_version, title, api_call_count
      ) VALUES (
        @id, @source, @user_id, @model, @model_config, @system_prompt,
        @parent_session_id, @started_at, @ended_at, @end_reason,
        @message_count, @tool_call_count, @input_tokens, @output_tokens,
        @cache_read_tokens, @cache_write_tokens, @reasoning_tokens,
        @billing_provider, @billing_base_url, @billing_mode,
        @estimated_cost_usd, @actual_cost_usd, @cost_status, @cost_source,
        @pricing_version, @title, @api_call_count
      )
    `).run({
      id: newSessionId,
      source: sourceSession.source,
      user_id: sourceSession.user_id,
      model: sourceSession.model,
      model_config: sourceSession.model_config,
      system_prompt: sourceSession.system_prompt,
      parent_session_id: sessionId,
      started_at: Date.now() / 1000,
      ended_at: null,
      end_reason: null,
      message_count: forkedMessageCount,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: sourceSession.billing_provider,
      billing_base_url: sourceSession.billing_base_url,
      billing_mode: sourceSession.billing_mode,
      estimated_cost_usd: null,
      actual_cost_usd: null,
      cost_status: null,
      cost_source: null,
      pricing_version: sourceSession.pricing_version,
      title: sourceSession.title ? (sourceSession.title + ' (fork)') : null,
      api_call_count: 0,
    });

    // Copy messages to the new session
    const insertMsg = db.prepare(`
      INSERT INTO messages (
        session_id, role, content, tool_call_id, tool_calls, tool_name,
        timestamp, token_count, finish_reason, reasoning, reasoning_details,
        codex_reasoning_items, reasoning_content, codex_message_items
      ) VALUES (
        @session_id, @role, @content, @tool_call_id, @tool_calls, @tool_name,
        @timestamp, @token_count, @finish_reason, @reasoning, @reasoning_details,
        @codex_reasoning_items, @reasoning_content, @codex_message_items
      )
    `);

    for (const msg of messagesToFork) {
      insertMsg.run({
        session_id: newSessionId,
        role: msg.role,
        content: msg.content,
        tool_call_id: msg.tool_call_id,
        tool_calls: msg.tool_calls,
        tool_name: msg.tool_name,
        timestamp: msg.timestamp,
        token_count: msg.token_count,
        finish_reason: msg.finish_reason,
        reasoning: msg.reasoning,
        reasoning_details: msg.reasoning_details,
        codex_reasoning_items: msg.codex_reasoning_items,
        reasoning_content: msg.reasoning_content,
        codex_message_items: msg.codex_message_items,
      });
    }

    // Invalidate sessions caches so the new session appears
    hermesSidebarSessionsCache = { at: 0, data: [] };
    hermesAllSessionsCache = { at: 0, data: [] };

    res.json({
      ok: true,
      newSessionId,
      forkedSession: {
        id: newSessionId,
        title: sourceSession.title ? (sourceSession.title + ' (fork)') : null,
        parent_session_id: sessionId,
        message_count: forkedMessageCount,
        model: sourceSession.model,
        started_at: Date.now() / 1000,
      },
    });
  } catch (e) {
    console.error('[chat.fork] error:', e.message);
    res.status(500).json({ error: 'failed to fork session: ' + e.message });
  } finally {
    if (db) db.close();
  }
});

// ── Model Info — read from config.yaml ──
app.get('/api/models', requireAuth, async (req, res) => {
  try {
    const configPath = path.join(os.homedir(), '.hermes', 'config.yaml');
    const configContent = await fs.promises.readFile(configPath, 'utf-8');
    const config = yaml.load(configContent) || {};
    
    const modelConfig = config.model || {};
    const defaultModel = modelConfig.default || 'unknown';
    const provider = modelConfig.provider || 'unknown';
    
    // Return single model info (hermes doesn't expose full model list via CLI)
    res.json({
      ok: true,
      default: defaultModel,
      provider: provider,
      groups: [{
        provider: provider,
        models: [defaultModel]
      }]
    });
  } catch (e) {
    res.json({ ok: false, error: e.message, groups: [], default: 'auto' });
  }
});

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
  prompt: `${HCI_IDENTITY}:${PROJECT_ROOT}# `,
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
  return getCurrentUser(req) !== null;
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: 'authentication required' });
}

function requireCsrf(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ error: 'authentication required' });
  const headerToken = req.headers['x-csrf-token'];
  if (!headerToken) return res.status(403).json({ error: 'invalid CSRF token' });
  const cookies = parseCookies(req);
  const authToken = cookies[AUTH_COOKIE];
  if (!authToken) return res.status(403).json({ error: 'invalid CSRF token' });
  const expected = deriveCsrfToken(authToken);
  if (!safeTimingEqual(headerToken, expected)) return res.status(403).json({ error: 'invalid CSRF token' });
  return next();
}

// (setAuthCookie and clearAuthCookie defined above at L37/L40)

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

// Terminal exec rate limiter — 30 commands/minute per IP
const terminalRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 commands per minute per IP
  keyGenerator: (req) => getClientIp(req),
  handler: (req, res) => {
    log('terminal.rate_limited', `ip ${getClientIp(req)}`);
    res.status(429).json({ ok: false, error: 'too many terminal commands, slow down' });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

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
  let raw = String(chunk || '');
  if (!raw) return;
  // Strip cursor position report (CPR) responses: ESC[<row>;<column>R
  // These leak through PTY and cause ";1R" to appear before commands
  raw = raw.replace(/\x1b\[[0-9;]*R/g, '');
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
      // Use XOFF (Ctrl+S) to suppress output echo while sending setup commands,
      // then XON (Ctrl+Q) to resume. Prevents PS1/cd commands from appearing in terminal.
      terminalSession.proc.write('\x13'); // Ctrl+S — stop output
      terminalSession.proc.write(`export PS1='${terminalSession.prompt.replaceAll("'", "'\\''")}' && cd ${PROJECT_ROOT}\r`);
      terminalSession.proc.write('\x11'); // Ctrl+Q — resume output
    }
  }, 100);

  return terminalSession;
}

function sendTerminalInput(command) {
  let text = String(command || '').replace(/\n+$/g, '');
  // Strip CPR responses that may leak through
  text = text.replace(/\x1b\[[0-9;]*R/g, '').replace(/;[0-9]+R/g, '');
  if (!text.trim()) return { ok: true, queued: false };
  const session = ensureTerminalSession();
  if (!session.proc) throw new Error('terminal not ready');
  session.proc.write(`${text}\r`);
  return { ok: true, queued: true };
}

// ============================================
// Input Sanitization — allowlist regex for shell injection prevention
// ============================================
function sanitizeProfileName(name) {
  const s = String(name || '').trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) return null;
  return s;
}

function sanitizeSessionId(id) {
  const s = String(id || '').trim();
  if (!/^[a-zA-Z0-9_.@-]+$/.test(s)) return null;
  return s;
}

function sanitizeTitle(title) {
  const s = String(title || '').trim();
  if (s.length > 200) return null;
  if (!/^[a-zA-Z0-9 _!?@#.()\-]+$/u.test(s)) return null;
  return s;
}

function sanitizeGatewayAction(action) {
  const valid = ['start', 'stop', 'restart', 'enable', 'disable'];
  const s = String(action || '').trim().toLowerCase();
  return valid.includes(s) ? s : null;
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
  // Use actual Hermes home (env var takes precedence, then config, then ~/.hermes)
  const HERMES = process.env.HERMES_HOME || cfg.hermesHome || path.join(os.homedir(), '.hermes');
  const rel = String(filePath || '').replace(/^\/+/, '');
  const abs = path.resolve(HERMES, rel);
  if (!isAllowedPath(abs)) throw new Error('path outside allowed roots');
  const stat = safeStat(abs);
  if (!stat) throw new Error('file not found');
  if (stat.isDirectory()) throw new Error('EISDIR: illegal operation on a directory, read');
  const buf = fs.readFileSync(abs);
  return buf.toString('utf8', 0, Math.min(buf.length, maxBytes));
}

function writeFileSafe(filePath, content) {
  const HERMES = process.env.HERMES_HOME || cfg.hermesHome || path.join(os.homedir(), '.hermes');
  const rel = String(filePath || '').replace(/^\/+/, '');
  const abs = path.resolve(HERMES, rel);
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

async function handleCronAction(action, body = {}, query = {}, source = '/api/cron') {
  const normalized = String(action || '').toLowerCase();
  if (normalized === 'list') {
    return { ok: true, action: normalized, jobs: await getCronJobs() };
  }
  if (normalized === 'add') {
    const schedule = body.schedule || query.schedule || '';
    const note = body.note || body.message || body.text || query.note || query.message || query.text || '';
    const job = addCronJob({ schedule, note, source: body.source || source });
    return { ok: true, action: normalized, job, jobs: await getCronJobs() };
  }
  if (normalized === 'remove') {
    const id = String(body.id || query.id || '');
    const before = cronJobs.length;
    for (let i = cronJobs.length - 1; i >= 0; i -= 1) {
      if (cronJobs[i].id === id || cronJobs[i].name === id) cronJobs.splice(i, 1);
    }
    broadcast();
    return { ok: true, action: normalized, removed: before - cronJobs.length, jobs: await getCronJobs() };
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
    return { ok: true, action: normalized, job, jobs: await getCronJobs() };
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
  const data = await getAllSessions().then((sessions) => sessions.slice(0, 10)).catch(() => []);
  if (data.length) {
    hermesSidebarSessionsCache = { at: now, data };
    return data;
  }
  // Preserve existing cache on error — don't clobber with empty fallback
  if (hermesSidebarSessionsCache.data.length) {
    return hermesSidebarSessionsCache.data;
  }
  return [];
}

let hermesAllSessionsCache = { at: 0, data: [] };

function getStateDbPath(profile) {
  // Named profiles (soci, david, cuan…) live under profiles/{name}/state.db
  // The default/unnamed profile uses Hermes root-level state.db
  if (profile && profile !== 'default') {
    return path.join(os.homedir(), '.hermes', 'profiles', profile, 'state.db');
  }
  return path.join(os.homedir(), '.hermes', 'state.db');
}

function loadSessionsFromDb(stateDbPath, limit = 250) {
  if (!fs.existsSync(stateDbPath)) return { dbSessions: [], previewBySessionId: {}, lastActivityBySessionId: {} };

  const db = new Database(stateDbPath, { readonly: true });
  try {
    const dbSessions = db.prepare(`
      SELECT id, title, parent_session_id, started_at, ended_at, message_count, source
      FROM sessions
      ORDER BY COALESCE(ended_at, started_at) DESC, id DESC
      LIMIT ?
    `).all(limit);

    const previewRows = db.prepare(`
      SELECT session_id, content
      FROM messages
      WHERE id IN (
        SELECT MAX(id)
        FROM messages
        WHERE content IS NOT NULL AND TRIM(content) != ''
        GROUP BY session_id
      )
    `).all();

    const previewBySessionId = {};
    for (const row of previewRows) {
      previewBySessionId[row.session_id] = row.content;
    }

    // Last activity per session (most recent message timestamp)
    const lastActivityRows = db.prepare(`
      SELECT session_id, MAX(timestamp) as last_activity
      FROM messages
      GROUP BY session_id
    `).all();

    const lastActivityBySessionId = {};
    for (const row of lastActivityRows) {
      lastActivityBySessionId[row.session_id] = row.last_activity;
    }

    return { dbSessions, previewBySessionId, lastActivityBySessionId };
  } finally {
    db.close();
  }
}

async function getAllSessions(profile) {
  const now = Date.now();
  const cacheKey = profile || 'all';
  if (hermesAllSessionsCache.data.length && now - hermesAllSessionsCache.at < 10_000 && hermesAllSessionsCache.key === cacheKey) {
    return hermesAllSessionsCache.data;
  }
  const cmd = profile ? `hermes -p ${profile} sessions list --limit 250` : 'hermes sessions list --limit 250';
  const raw = await shell(cmd);
  if (raw) {
    const cliSessions = parseHermesSessionsList(raw);
    const stateDbPath = getStateDbPath(profile);
    const { dbSessions, previewBySessionId, lastActivityBySessionId } = loadSessionsFromDb(stateDbPath);
    const data = mergeSessionsFromSources({
      cliSessions,
      dbSessions,
      previewBySessionId,
      lastActivityBySessionId,
      nowMs: now,
    });
    hermesAllSessionsCache = { at: now, data, key: cacheKey };
    return data;
  }

  try {
    const stateDbPath = getStateDbPath(profile);
    const { dbSessions, previewBySessionId, lastActivityBySessionId } = loadSessionsFromDb(stateDbPath);
    const data = mergeSessionsFromSources({ dbSessions, previewBySessionId, lastActivityBySessionId, nowMs: now });
    if (data.length) {
      hermesAllSessionsCache = { at: now, data, key: cacheKey };
      return data;
    }
  } catch {}

  // No fallback to old cache — return empty if command returned nothing
  return [];
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

// Group 11: System health alert checks (throttled — max 1 alert per type per hour)
const healthAlertCooldown = {};
function checkSystemHealth() {
  const sys = getSystem();
  const now = Date.now();
  // Disk > 90%
  if (sys.disk && sys.disk.percent > 90) {
    const key = 'disk-high';
    if (!healthAlertCooldown[key] || now - healthAlertCooldown[key] > 3600000) {
      addNotification('error', `Disk usage critical: ${sys.disk.percent}% — clean up now`);
      healthAlertCooldown[key] = now;
    }
  }
  // RAM > 90%
  if (sys.memory.percent > 90) {
    const key = 'ram-high';
    if (!healthAlertCooldown[key] || now - healthAlertCooldown[key] > 3600000) {
      addNotification('warning', `RAM usage high: ${sys.memory.percent}% — watch for OOM kills`);
      healthAlertCooldown[key] = now;
    }
  }
  // Load > 2x CPU cores
  if (sys.load[0] > sys.cpuCores * 2) {
    const key = 'load-high';
    if (!healthAlertCooldown[key] || now - healthAlertCooldown[key] > 3600000) {
      addNotification('warning', `CPU load spike: ${sys.load[0].toFixed(1)} (${sys.cpuCores} cores)`);
      healthAlertCooldown[key] = now;
    }
  }
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
  const raw = await shell(cmd, '60s');
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
  if (authed) checkSystemHealth();
  const terminal = ensureTerminalSession();
  // Core data — must resolve fast (<5s)
  const [sessionsData, allSessionsData, cronJobsData, knowledgeData, profilesData] = await Promise.all([
    getSessions(),
    getAllSessions(),
    getCronJobs(),
    buildKnowledgeMarkdown(),
    getProfiles(),
  ]);
  // Insights — async, may take 30-60s. Return cached or null immediately.
  let insightsData = null;
  try {
    // Race: either cached/fast result within 2s, or give up and use null
    insightsData = await Promise.race([
      getInsights(),
      new Promise(resolve => setTimeout(() => resolve(null), 2000)),
    ]);
  } catch {}
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
    loginIdentity: HCI_IDENTITY,
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
  const response = { authenticated: authed, passwordRequired: true, identity: HCI_IDENTITY };
  if (authed) {
    const cookies = parseCookies(req);
    response.csrfToken = deriveCsrfToken(cookies[AUTH_COOKIE]);
  }
  res.json(response);
});

// ============================================
// Multi-User Auth (replaces single-password auth)
// ============================================
const {
  isFirstRun, findUser, createUser, deleteUser,
  verifyUserPassword, changePassword, resetUserPassword, sanitizeUsername, listUsers,
  updateUserPermissions, PERMISSIONS, PRESET_PERMISSIONS, resolvePermissions,
  audit, getAuditLog,
  loadNotifications, addNotification, dismissNotification, clearNotifications,
} = require('./auth');

// Periodic cleanup of expired auth tokens (every 15 minutes)
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k] of tokenToUser) {
    const [t] = k.split('.');
    if (Number(t) < cutoff) tokenToUser.delete(k);
  }
}, 15 * 60 * 1000);

// Track current user in request (bound to token)
const tokenToUser = new Map(); // token -> { username, role }

function createAuthToken(username, role, permissions) {
  const ts = String(Date.now());
  const sig = hmac(ts + ':' + username);
  const token = ts + '.' + sig;
  tokenToUser.set(token, { username, role, permissions });
  return token;
}

function getCurrentUser(req) {
  const cookies = parseCookies(req);
  const token = cookies[AUTH_COOKIE];
  if (!token) return null;
  return tokenToUser.get(token) || null;
}

function requireRole(role) {
  return (req, res, next) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'authentication required' });
    if (role === 'admin' && user.role !== 'admin') {
      audit(user.username, user.role, 'DENIED', `${req.method} ${req.path}`);
      return res.status(403).json({ error: 'admin access required' });
    }
    req.hciUser = user;
    next();
  };
}

// Permission-based access control
function requirePerm(...perms) {
  return (req, res, next) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'authentication required' });
    // Admin always has access
    if (user.role === 'admin') { req.hciUser = user; return next(); }
    const userPerms = user.permissions || {};
    const hasAll = perms.every(p => userPerms[p]);
    if (!hasAll) {
      audit(user.username, user.role, 'DENIED', `${req.method} ${req.path} (need: ${perms.join(',')})`);
      return res.status(403).json({ error: `permission required: ${perms.join(', ')}` });
    }
    req.hciUser = user;
    next();
  };
}

// verifyPassword removed — use verifyUserPassword from user store

// ============================================
// Auth API Routes
// ============================================

// Check auth status / get current user
app.get('/api/auth/me', (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ ok: false });
  const cookies = parseCookies(req);
  const csrfToken = deriveCsrfToken(cookies[AUTH_COOKIE]);
  res.json({ ok: true, user: { username: user.username, role: user.role, permissions: user.permissions }, csrfToken });
});

// Check if first run (no rate limit, no auth required)
app.get('/api/auth/status', (req, res) => {
  try {
    const users = listUsers();
    res.json({ ok: true, first_run: users.length === 0, user_count: users.length });
  } catch (e) {
    res.json({ ok: true, first_run: true, user_count: 0 });
  }
});

// First-run setup (create admin)
app.post('/api/auth/setup', loginRateLimiter, (req, res) => {
  if (!isFirstRun()) {
    return res.status(400).json({ ok: false, error: 'Setup already completed' });
  }
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password required' });
  }
  if (!sanitizeUsername(username)) {
    return res.status(400).json({ ok: false, error: 'Invalid username (2-32 chars, alphanumeric/_.- only)' });
  }
  if (password.length < 8) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
  }
  const result = createUser(username, password, 'admin');
  if (!result.ok) return res.status(400).json(result);

  const authToken = createAuthToken(username, 'admin', PRESET_PERMISSIONS.admin);
  setAuthCookie(res, authToken);
  audit(username, 'admin', 'SETUP', 'first-run admin created');
  addNotification('success', `Admin account created: ${username}`);
  const csrfToken = deriveCsrfToken(authToken);
  res.json({ ok: true, user: { username, role: 'admin' }, csrfToken });
});

// Login (multi-user)
app.post('/api/auth/login', loginRateLimiter, (req, res) => {
  const ip = getClientIp(req);
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password required' });
  }
  if (!sanitizeUsername(username)) {
    return res.status(400).json({ ok: false, error: 'Invalid username' });
  }

  // If no users exist, redirect to setup
  if (isFirstRun()) {
    return res.status(400).json({ ok: false, error: 'first_run', message: 'No users exist. Please create an admin account.' });
  }

  const user = verifyUserPassword(username, password);
  if (!user) {
    audit(username, 'unknown', 'LOGIN_FAILED', `bad credentials from ${ip}`);
    return res.status(401).json({ ok: false, error: 'Invalid username or password' });
  }

  const authToken = createAuthToken(user.username, user.role, user.permissions);
  setAuthCookie(res, authToken);
  audit(user.username, user.role, 'LOGIN', `success from ${ip}`);
  const csrfToken = deriveCsrfToken(authToken);
  res.json({ ok: true, user: { username: user.username, role: user.role, permissions: user.permissions }, csrfToken });
});

// Logout
app.post('/api/auth/logout', requireAuth, requireCsrf, (req, res) => {
  const user = getCurrentUser(req);
  const cookies = parseCookies(req);
  const token = cookies[AUTH_COOKIE];
  if (token) tokenToUser.delete(token);
  clearAuthCookie(res);
  if (user) audit(user.username, user.role, 'LOGOUT', '');
  res.json({ ok: true });
});

// Change own password
app.post('/api/auth/change-password', requireAuth, requireCsrf, (req, res) => {
  const user = getCurrentUser(req);
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) {
    return res.status(400).json({ ok: false, error: 'Current and new password required' });
  }
  const result = changePassword(user.username, current_password, new_password);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true });
});

// ============================================
// User Management Routes (admin only)
// ============================================

// List users
app.get('/api/users', requireRole('admin'), (req, res) => {
  res.json({ ok: true, users: listUsers() });
});

// Create user
app.post('/api/users', requireRole('admin'), requireCsrf, (req, res) => {
  const { username, password, role, permissions } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password required' });
  }
  if (!sanitizeUsername(username)) {
    return res.status(400).json({ ok: false, error: 'Invalid username (2-32 chars, alphanumeric/_.- only)' });
  }
  if (password.length < 8) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
  }
  const userRole = ['admin', 'viewer', 'custom'].includes(role) ? role : 'viewer';
  const result = createUser(username, password, userRole, userRole === 'custom' ? permissions : null);
  if (!result.ok) return res.status(400).json(result);
  addNotification('success', `User created: ${username} (${userRole})`);
  res.json({ ok: true });
});

// Update user permissions
app.put('/api/users/:username', requireRole('admin'), requireCsrf, (req, res) => {
  const { role, permissions } = req.body || {};
  const userRole = ['admin', 'viewer', 'custom'].includes(role) ? role : 'viewer';
  const result = updateUserPermissions(req.params.username, userRole, userRole === 'custom' ? permissions : null);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true });
});

// List available permissions and presets
app.get('/api/permissions', requireAuth, (req, res) => {
  res.json({ ok: true, permissions: PERMISSIONS, presets: PRESET_PERMISSIONS });
});

// Delete user
app.delete('/api/users/:username', requireRole('admin'), requireCsrf, (req, res) => {
  const currentUser = getCurrentUser(req);
  const result = deleteUser(req.params.username, currentUser.username);
  if (!result.ok) return res.status(400).json(result);
  addNotification('info', `User deleted: ${req.params.username}`);
  res.json({ ok: true });
});

// Reset user password
app.post('/api/users/:username/reset-password', requireRole('admin'), requireCsrf, (req, res) => {
  const currentUser = getCurrentUser(req);
  const { new_password } = req.body || {};
  if (!new_password) {
    return res.status(400).json({ ok: false, error: 'New password required' });
  }
  const result = resetUserPassword(req.params.username, new_password, currentUser.username);
  if (!result.ok) return res.status(400).json(result);
  addNotification('info', `Password reset for ${req.params.username}`);
  res.json({ ok: true });
});

// ============================================
// Audit Log
// ============================================
app.get('/api/audit', requireRole('admin'), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  res.json({ ok: true, entries: getAuditLog(limit) });
});

// ============================================
// Notifications API
// ============================================
app.get('/api/notifications', requireAuth, (req, res) => {
  const notifs = loadNotifications();
  res.json({ ok: true, notifications: notifs });
});

// Support both /api/notifications/:id/dismiss (URL param) and /api/notifications/dismiss (body id)
app.post('/api/notifications/:id/dismiss', requireAuth, requireCsrf, (req, res) => {
  const id = req.params.id || req.body?.id;
  if (id) dismissNotification(id);
  res.json({ ok: true });
});

app.post('/api/notifications/dismiss', requireAuth, requireCsrf, (req, res) => {
  const id = req.body?.id;
  if (id) dismissNotification(id);
  res.json({ ok: true });
});

app.post('/api/notifications/clear', requireAuth, requireCsrf, (req, res) => {
  clearNotifications();
  res.json({ ok: true });
});

// ============================================
// System Health API
// ============================================
app.get('/api/system/health', requireAuth, async (req, res) => {
  try {
    const [cpu, ram, disk, version, agents, sessions] = await Promise.all([
      shell("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'"),
      shell("free -m | awk '/Mem:/ {printf \"%d/%dMB (%.0f%%)\", $3, $2, $3/$2*100}'"),
      shell("df -h / | awk 'NR==2 {print $3\"/\"$2\" (\"$5\")\"}'"),
      shell("hermes version 2>&1 | head -1"),
      shell("hermes profile list 2>&1 | wc -l"),
      shell("hermes sessions list --limit 1000 2>&1 | wc -l"),
    ]);
    // Format uptime from process.uptime()
    const upSec = process.uptime();
    const upDays = Math.floor(upSec / 86400);
    const upHrs = Math.floor((upSec % 86400) / 3600);
    const upMins = Math.floor((upSec % 3600) / 60);
    const uptime = upDays > 0 ? `${upDays}d ${upHrs}h ${upMins}m` : upHrs > 0 ? `${upHrs}h ${upMins}m` : `${upMins}m`;
    res.json({
      ok: true,
      cpu: cpu.trim() || 'N/A',
      ram: ram.trim() || 'N/A',
      disk: disk.trim() || 'N/A',
      uptime,
      hermes_version: version.trim() || 'N/A',
      hci_version: require('./package.json').version,
      node_version: process.version,
      agents: Math.max(0, parseInt(agents.trim()) - 2) || 0, // subtract header lines
      sessions: Math.max(0, parseInt(sessions.trim()) - 2) || 0,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// System Monitoring — detailed metrics
app.get('/api/monitoring', requireAuth, async (req, res) => {
  try {
    const [cpu, mem, disk, loadAvg, netio, processes, uptime, version] = await Promise.all([
      shell("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'"),
      shell("free -m | awk '/Mem:/ {printf \"%d/%dMB (%.1f%%)\", $3, $2, $3/$2*100}'"),
      shell("df -h / | awk 'NR==2 {print $3\"/\"$2\" (\"$5\")\"}'"),
      shell("cat /proc/loadavg | awk '{print $1\", \"$2\", \"$3}'"),
      shell("cat /proc/net/dev | awk 'NR==3 {print $1, $9}'"),
      shell("ps aux --no-headers | wc -l"),
      shell("uptime | awk -F'up ' '{split($2,a,\" user\");print a[1]\", \"$3}'"),
      shell("hermes version 2>&1 | head -1"),
    ]);

    // Parse network interface (skip loopback)
    const netParts = (netio || 'lo 0').trim().split(/\s+/);
    const netInterface = netParts[0] || 'eth0';
    const netBytes = netParts[1] || '0';
    const netPackets = netParts[2] || '0';

    // CPU percentage (already in format like "12.5%")
    const cpuPct = (cpu.trim() || 'N/A').replace(/,/g, '');

    // Memory usage
    const memInfo = mem.trim() || 'N/A';

    // Disk usage
    const diskInfo = disk.trim() || 'N/A';

    // Load averages
    const loadParts = (loadAvg.trim() || '0, 0, 0').split(',').map(l => l.trim());
    const load1 = loadParts[0] || '0';
    const load5 = loadParts[1] || '0';
    const load15 = loadParts[2] || '0';

    // Process count
    const procCount = parseInt(processes.trim()) || 0;

    // Uptime info
    const upInfo = uptime.trim() || 'N/A';

    // Hermes version
    const hermesVer = version.trim() || 'N/A';
    const hciVer = require('./package.json').version;

    // Node.js memory usage (RSS, HeapUsed, HeapTotal)
    const nodeMem = process.memoryUsage();
    const nodeMemRSS = Math.round(nodeMem.rss / 1024 / 1024);
    const nodeMemHeapUsed = Math.round(nodeMem.heapUsed / 1024 / 1024);
    const nodeMemHeapTotal = Math.round(nodeMem.heapTotal / 1024 / 1024);

    res.json({
      ok: true,
      cpu: cpuPct,
      memory: memInfo,
      disk: diskInfo,
      load: { avg1: load1, avg5: load5, avg15: load15 },
      network: { interface: netInterface, bytes: netBytes, packets: netPackets },
      processes: procCount,
      uptime: upInfo,
      hermes_version: hermesVer,
      hci_version: hciVer,
      node_version: process.version,
      node_memory: {
        rss_mb: nodeMemRSS,
        heap_used_mb: nodeMemHeapUsed,
        heap_total_mb: nodeMemHeapTotal,
      },
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Hermes agent status (parsed from `hermes status`)
app.get('/api/agent/status', requireAuth, async (req, res) => {
  try {
    const raw = await shell('hermes status 2>&1', '15s');
    const grab = (label) => {
      const re = new RegExp(label + ':\\s+(.+)');
      const m = raw.match(re);
      return m ? m[1].trim() : '';
    };
    // Parse key fields
    const model = grab('Model');
    const provider = grab('Provider');
    // Gateway status — check systemd (user-level for non-root, system-level for root)
    let gatewayStatus = 'unknown';
    try {
      const gwCheck = await shell(`systemctl ${SYSTEMD_USER_FLAG} is-active hermes-gateway 2>/dev/null || systemctl ${SYSTEMD_USER_FLAG} is-active hermes-gateway-* 2>/dev/null | head -1`, '5s');
      gatewayStatus = gwCheck.trim() === 'active' ? 'running' : 'stopped';
    } catch {
      gatewayStatus = grab('Status');
    }
    const activeSessions = grab('Active');

    // Parse API keys (lines with ✓ or ✗)
    const keyLines = raw.match(/◆ API Keys\n([\s\S]*?)(?:\n◆|\n──)/);
    const apiKeys = { active: 0, total: 0 };
    if (keyLines) {
      const kLines = keyLines[1].split('\n').filter(l => l.trim());
      apiKeys.total = kLines.length;
      apiKeys.active = kLines.filter(l => l.includes('✓')).length;
    }

    // Parse platforms (lines with ✓ or ✗ after "Messaging Platforms")
    const platLines = raw.match(/◆ Messaging Platforms\n([\s\S]*?)(?:\n◆|\n──)/);
    const platforms = [];
    if (platLines) {
      for (const l of platLines[1].split('\n')) {
        const m = l.match(/^\s+(\S.+?)\s+(✓|✗)\s+(.+)/);
        if (m) platforms.push({ name: m[1].trim(), configured: m[2] === '✓', detail: m[3].trim() });
      }
    }

    // Parse auth providers
    const authLines = raw.match(/◆ Auth Providers\n([\s\S]*?)(?:\n◆|\n──)/);
    const authProviders = [];
    if (authLines) {
      for (const l of authLines[1].split('\n')) {
        const m = l.match(/^\s+(\S.+?)\s+(✓|✗)\s+(.+)/);
        if (m) authProviders.push({ name: m[1].trim(), loggedIn: m[2] === '✓', detail: m[3].trim() });
      }
    }

    // Parse scheduled jobs
    const jobs = grab('Jobs');

    res.json({
      ok: true,
      model, provider,
      gatewayStatus,
      activeSessions: parseInt(activeSessions) || 0,
      scheduledJobs: parseInt(jobs) || 0,
      apiKeys,
      platforms,
      authProviders,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/dashboard-state', requireAuth, async (req, res) => {
  res.json(await buildDashboardState(true));
});

app.get('/api/sessions', requireAuth, async (req, res) => {
  // Short list for sidebar — limit 10, cached 10s
  const data = await getSessions();
  res.json({ sessions: data, cachedAt: hermesSidebarSessionsCache.at });
});

app.get('/api/all-sessions', requireAuth, async (req, res) => {
  // Sessions list — can filter by profile
  const profile = sanitizeProfileName(req.query.profile) || undefined;
  const data = await getAllSessions(profile);
  res.json({ ok: true, sessions: data, cachedAt: hermesAllSessionsCache.at });
});

function parseHermesProfileList(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  // Find the header row dynamically by looking for "Profile" followed by "Model" and "Gateway"
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/profile\s+model\s+gateway/i.test(lines[i])) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex === -1) return [];
  // Skip header, separator, and any lines containing python-dotenv warnings
  const dataLines = [];
  for (let i = headerIndex + 2; i < lines.length; i++) {
    const line = lines[i];
    // Skip separator line (box-drawing dashes)
    if (/^[\s─▪▫·∙¤]+$/.test(line)) continue;
    // Skip any lines containing python-dotenv warnings as extra safety
    if (line.toLowerCase().includes('python-dotenv')) continue;
    dataLines.push(line);
  }
  const profiles = [];
  for (const line of dataLines) {
    const active = line.includes('◆');
    const cleaned = line.replace(/[◆]+$/, '').replace(/\s*◆\s*/, '').trimEnd();
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
  console.log('[DEBUG getProfiles] raw shell output:', JSON.stringify(raw));
  if (raw) {
    const data = parseHermesProfileList(raw);
    console.log('[DEBUG getProfiles] parsed:', JSON.stringify(data));
    getProfiles.cache = { at: now, data };
    return data;
  }
  if (getProfiles.cache?.data?.length) return getProfiles.cache.data;
  return [];
}
getProfiles.cache = { at: 0, data: [] };

app.get('/api/profiles', requireAuth, async (req, res) => {
  const profiles = await getProfiles();
  console.log('[DEBUG /api/profiles] returning:', JSON.stringify(profiles));
  res.json({ ok: true, profiles });
});

app.post('/api/profiles/use', requireRole('admin'), requireCsrf, async (req, res) => {
  const name = sanitizeProfileName(req.body?.profile);
  if (!name) return res.status(400).json({ error: 'invalid profile name (allowed: a-z, A-Z, 0-9, _, -)' });
  try {
    const result = await execHermes(['profile', 'use', name], 10000);
    // Invalidate profiles cache so next fetch shows updated active profile
    getProfiles.cache = { at: 0, data: [] };
    res.json({ ok: true, profile: name, output: result.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Gateway Service Management ─────────────────────────────────────────────

function getGatewayServiceName(profile) {
  // For non-root user services, the bare 'hermes-gateway' name is common.
  // For root (system-level), it's typically 'hermes-gateway-${profile}'.
  // Return both candidates — callers can try both.
  const suffix = profile || 'soci';
  return {
    bare: 'hermes-gateway',
    profiled: `hermes-gateway-${suffix}`,
    // Primary: prefer profiled for root, bare for non-root
    primary: IS_ROOT ? `hermes-gateway-${suffix}` : 'hermes-gateway',
  };
}

app.get('/api/gateway/:profile', requireAuth, async (req, res) => {
  const profile = sanitizeProfileName(req.params.profile);
  if (!profile) return res.status(400).json({ error: 'invalid profile name' });
  const svcs = getGatewayServiceName(profile);
  try {
    // Try primary first, fallback to alternate
    const svc = svcs.primary;
    const [isActive, isEnabled, status] = await Promise.all([
      shell(`systemctl ${SYSTEMD_USER_FLAG} is-active ${svc} 2>/dev/null || systemctl ${SYSTEMD_USER_FLAG} is-active ${svcs.bare === svc ? svcs.profiled : svcs.bare} 2>/dev/null || echo inactive`),
      shell(`systemctl ${SYSTEMD_USER_FLAG} is-enabled ${svc} 2>/dev/null || echo disabled`),
      shell(`systemctl ${SYSTEMD_USER_FLAG} status ${svc} 2>/dev/null | head -10`),
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

// Gateway connections (parse from hermes status --all)
app.get('/api/gateway/:profile/connections', requireAuth, async (req, res) => {
  const profile = sanitizeProfileName(req.params.profile);
  if (!profile) return res.status(400).json({ error: 'invalid profile name' });
  try {
    const flag = profile === 'default' ? '' : `-p ${profile} `;
    const output = await shell(`hermes ${flag}status --all 2>&1`, '15s');
    const lines = output.split('\n');

    // Find Messaging Platforms section
    const startIdx = lines.findIndex(l => l.includes('Messaging Platforms'));
    const endIdx = lines.findIndex((l, i) => i > startIdx && (l.trim().startsWith('◆') || l.trim().startsWith('┌')));

    const platforms = [];
    if (startIdx > -1) {
      const section = endIdx > -1 ? lines.slice(startIdx + 1, endIdx) : lines.slice(startIdx + 1);
      for (const line of section) {
        const match = line.match(/^\s{2}(.+?)\s{2,}(✓|✗)\s*(.*)$/);
        if (match) {
          const name = match[1].trim();
          const connected = match[2] === '✓';
          const detail = match[3].trim();
          if (name && name.length > 1) {
            platforms.push({ name, connected, detail });
          }
        }
      }
    }

    res.json({ ok: true, profile, platforms });
  } catch (e) {
    res.json({ ok: false, error: e.message, platforms: [] });
  }
});

app.post('/api/gateway/:profile/:action', requireCsrf, async (req, res) => {
  const profile = sanitizeProfileName(req.params.profile);
  const action = sanitizeGatewayAction(req.params.action);

  if (!profile) return res.status(400).json({ error: 'invalid profile name' });
  if (!action) return res.status(400).json({ error: 'invalid action (allowed: start, stop, restart, enable, disable)' });

  try {
    // Auto-inject api_server config if starting/restarting and port is missing
    if ((action === 'start' || action === 'restart') && !gatewayPorts[profile]) {
      const confPath = profile === 'default'
        ? path.join(HERMES_HOME, 'config.yaml')
        : path.join(HERMES_HOME, 'profiles', profile, 'config.yaml');
      if (fs.existsSync(confPath)) {
        try {
          const raw = fs.readFileSync(confPath, 'utf8');
          const cfg = yaml.load(raw) || {};
          if (!cfg.platforms?.api_server?.enabled) {
            const existingPorts = discoverGatewayPorts();
            let port = 8650;
            while (Object.values(existingPorts).includes(port)) port++;
            cfg.platforms = cfg.platforms || {};
            cfg.platforms.api_server = {
              enabled: true,
              extra: {
                host: '127.0.0.1',
                port,
                key: GATEWAY_API_KEY,
                cors_origins: resolveCorsOrigins(req),
              },
            };
            fs.writeFileSync(confPath, yaml.dump(cfg, { lineWidth: 120 }));
            gatewayPorts = discoverGatewayPorts();
            console.log(`[GatewayAction] Auto-injected api_server on port ${port} for ${profile}`);
            addNotification('info', `Injected Gateway API config on port ${port} for ${profile}`);
          }
        } catch (injectErr) {
          console.error(`[GatewayAction] Failed to inject api_server for ${profile}:`, injectErr.message);
        }
      }
    }

    // Check if service exists first — try both names
    const svcs = getGatewayServiceName(profile);
    let svc = svcs.primary;
    let exists = await shell(`systemctl ${SYSTEMD_USER_FLAG} list-unit-files ${svc}.service 2>&1`);
    if (!exists.includes(svc)) {
      // Try fallback
      svc = svcs.bare === svc ? svcs.profiled : svcs.bare;
      exists = await shell(`systemctl ${SYSTEMD_USER_FLAG} list-unit-files ${svc}.service 2>&1`);
      if (!exists.includes(svc)) {
        return res.status(400).json({ ok: false, error: `Service not found. Tried: ${svcs.primary}, ${svc}` });
      }
    }
    const result = await shell(`systemctl ${SYSTEMD_USER_FLAG} ${action} ${svc} 2>&1`);
    const isActive = (await shell(`systemctl ${SYSTEMD_USER_FLAG} is-active ${svc} 2>/dev/null || echo inactive`)).trim() === 'active';
    addNotification(isActive ? 'success' : 'info', `Gateway ${profile}: ${action} ${isActive ? '→ running' : '→ stopped'}`);
    res.json({ ok: true, profile, action, active: isActive, output: result.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/gateway/:profile/logs', requireAuth, async (req, res) => {
  const profile = sanitizeProfileName(req.params.profile);
  if (!profile) return res.status(400).json({ error: 'invalid profile name' });
  const svcs = getGatewayServiceName(profile);
  const svc = svcs.primary;
  const lines = Math.min(parseInt(req.query.lines || '50', 10), 500);
  const logType = String(req.query.log || 'gateway').toLowerCase();
  try {
    let logs = '';
    if (logType === 'agent') {
      const logPath = path.join(CONTROL_HOME, 'logs', 'agent.log');
      logs = await shell(`tail -n ${lines} "${logPath}" 2>/dev/null || echo "No agent log found"`, '10s');
    } else if (logType === 'error') {
      const logPath = path.join(CONTROL_HOME, 'logs', 'errors.log');
      logs = await shell(`tail -n ${lines} "${logPath}" 2>/dev/null || echo "No error log found"`, '10s');
    } else {
      // Gateway logs via journalctl
      logs = await shell(`journalctl ${SYSTEMD_USER_FLAG} -u ${svc} --no-pager -n ${lines} 2>&1`, '10s');
    }
    res.json({ ok: true, profile, service: svc, logType, logs: logs.trim() });
  } catch (e) {
    res.json({ ok: true, profile, service: svc, logType, logs: '' });
  }
});

// Gateway health check for a specific profile
app.get('/api/gateway/:profile/health', requireAuth, async (req, res) => {
  try {
    const profile = sanitizeProfileName(req.params.profile) || 'default';
    const port = gatewayPorts[profile];
    const issues = [];
    const checks = {};

    // Check 1: Port discovered
    checks.port_discovered = !!port;
    if (!port) issues.push('Gateway port not configured in config.yaml (platforms.api_server.extra.port)');

    // Check 1b: Port conflict (another profile using same port)
    checks.port_unique = true;
    if (port) {
      const otherProfiles = Object.entries(gatewayPorts)
        .filter(([name, p]) => name !== profile && p === port)
        .map(([name]) => name);
      if (otherProfiles.length > 0) {
        checks.port_unique = false;
        issues.push(`Port ${port} is also used by: ${otherProfiles.join(', ')}. Run setup to assign a unique port.`);
      }
    }

    // Check 2: Gateway process running
    let gatewayRunning = false;
    try {
      const svcName = `hermes-gateway-${profile}`;
      const status = (await shell(`systemctl is-active ${svcName} 2>&1`, '5s')).trim();
      gatewayRunning = status === 'active';
      checks.service_status = status;
    } catch {}
    if (!gatewayRunning) {
      // Fallback: check if something is listening on the port
      if (port) {
        const listening = (await shell(`ss -tlnp | grep :${port}`, '5s')).trim();
        checks.port_listening = !!listening;
        if (!listening) issues.push(`Nothing listening on port ${port}`);
      }
    }

    // Check 3: API responds
    checks.api_reachable = false;
    if (port) {
      try {
        const healthRes = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(3000)
        });
        checks.api_reachable = healthRes.ok;
        if (!healthRes.ok) issues.push(`Gateway API returned ${healthRes.status}`);
      } catch (e) {
        issues.push(`Gateway API unreachable: ${e.message}`);
      }
    }

    // Check 4: Profile routing — each profile has its own gateway port
    checks.profile_supported = !!port;
    if (!port) {
      issues.push('Gateway port not found for this profile. Check platforms.api_server.extra.port in config.yaml.');
    }

    // Check 5: Config exists
    const configPath = profile === 'default'
      ? path.join(HERMES_HOME, 'config.yaml')
      : path.join(HERMES_HOME, 'profiles', profile, 'config.yaml');
    checks.config_exists = fs.existsSync(configPath);
    if (!checks.config_exists) issues.push(`Config not found: ${configPath}`);

    const healthy = checks.port_discovered && checks.api_reachable && checks.config_exists;

    res.json({
      ok: true,
      profile,
      port: port || null,
      healthy,
      checks,
      issues,
      gatewayMode: healthy ? 'Gateway API (fast)' : 'CLI fallback (slow)',
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Unified Logs — all profiles, all sources, with filters
app.get('/api/logs', requireAuth, requirePerm('logs.view'), async (req, res) => {
  try {
    const profile = String(req.query.profile || 'all');
    const source = String(req.query.source || 'all'); // agent, error, gateway
    const lines = Math.min(parseInt(req.query.lines || '200', 10), 1000);
    const level = String(req.query.level || '').toLowerCase(); // error, warn, info, debug
    const search = String(req.query.search || '').toLowerCase();

    const profiles = profile === 'all'
      ? ['default', ...fs.readdirSync(path.join(os.homedir(), '.hermes', 'profiles')).filter(d => {
          try { return fs.statSync(path.join(os.homedir(), '.hermes', 'profiles', d)).isDirectory(); } catch { return false; }
        })]
      : [sanitizeProfileName(profile)].filter(Boolean);

    const sources = source === 'all' ? ['agent', 'error'] : [source];

    let allLines = [];

    for (const prof of profiles) {
      const logBase = prof === 'default'
        ? path.join(os.homedir(), '.hermes', 'logs')
        : path.join(os.homedir(), '.hermes', 'profiles', prof, 'logs');

      for (const src of sources) {
        if (src === 'gateway') {
          // Gateway logs from journalctl
          const svc = prof === 'default' ? 'hermes-gateway' : `hermes-gateway-${prof}`;
          const raw = await shell(`journalctl ${SYSTEMD_USER_FLAG} -u ${svc} --no-pager -n ${lines} 2>&1`, '10s');
          for (const line of raw.split('\n').filter(Boolean)) {
            allLines.push(parseLogLine(line, prof, 'gateway'));
          }
        } else {
          const logFile = path.join(logBase, `${src}.log`);
          if (fs.existsSync(logFile)) {
            const raw = await shell(`tail -n ${lines} "${logFile}" 2>/dev/null`, '5s');
            for (const line of raw.split('\n').filter(Boolean)) {
              allLines.push(parseLogLine(line, prof, src));
            }
          }
        }
      }
    }

    // Sort by timestamp descending (newest first)
    allLines.sort((a, b) => (b.ts || 0) - (a.ts || 0));

    // Apply level filter
    if (level) {
      allLines = allLines.filter(l => l.level === level);
    }

    // Apply search filter
    if (search) {
      allLines = allLines.filter(l => l.raw.toLowerCase().includes(search));
    }

    // Limit total
    allLines = allLines.slice(0, lines);

    res.json({ ok: true, count: allLines.length, logs: allLines });
  } catch (e) {
    res.json({ ok: false, error: e.message, logs: [] });
  }
});

// Parse a log line into structured format
function parseLogLine(line, profile, source) {
  // Try to extract: [TIMESTAMP] [LEVEL] [COMPONENT] message
  const match = line.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(?:\[([^\]]+)\]\s*)?(.+)$/);
  if (match) {
    const [, ts, lvl, comp, msg] = match;
    return {
      ts: new Date(ts).getTime() || 0,
      timestamp: ts,
      level: lvl.toLowerCase(),
      component: comp || source,
      profile,
      source,
      message: msg.trim(),
      raw: line,
    };
  }
  // Fallback: journalctl format or plain line
  // Try to detect level from content
  let level = 'info';
  if (/error|fail|fatal|crash/i.test(line)) level = 'error';
  else if (/warn/i.test(line)) level = 'warn';
  else if (/debug/i.test(line)) level = 'debug';

  return {
    ts: 0,
    timestamp: '',
    level,
    component: source,
    profile,
    source,
    message: line.trim(),
    raw: line,
  };
}

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
    const HERMES = process.env.HERMES_HOME || cfg.hermesHome || path.join(os.homedir(), '.hermes');
    return res.json({ ok: true, path: path.resolve(HERMES, requested.replace(/^\/+/, '')), content });
  } catch (error) {
    const message = error.message || 'file read failed';
    const status = message.includes('EISDIR') ? 400 : message.includes('not found') ? 404 : 400;
    return res.status(status).json({ error: message, path: requested });
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

// File listing API for File Explorer
app.get('/api/files/list', requireAuth, (req, res) => {
  const dirPath = String(req.query.path || '').replace(/^\/+/, '').replace(/\.\./g, '');
  const baseDir = path.join(os.homedir(), '.hermes');
  
  // Security: ensure we stay within .hermes
  const resolved = path.resolve(baseDir, dirPath);
  if (!resolved.startsWith(baseDir)) {
    return res.status(403).json({ error: 'path outside allowed roots' });
  }
  
  try {
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'directory not found' });
    }
    
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'not a directory' });
    }
    
    const items = fs.readdirSync(resolved).map(name => {
      try {
        const itemPath = path.join(resolved, name);
        const itemStat = fs.statSync(itemPath);
        return {
          name,
          type: itemStat.isDirectory() ? 'directory' : 'file',
          size: itemStat.size,
          modified: itemStat.mtime.toISOString(),
          path: path.relative(baseDir, itemPath)
        };
      } catch {
        return { name, type: 'unknown', path: path.relative(baseDir, path.join(resolved, name)) };
      }
    });
    
    // Sort: directories first, then files
    items.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });
    
    res.json({
      ok: true,
      path: path.relative(baseDir, resolved),
      items,
      parent: path.relative(baseDir, path.dirname(resolved)).replace(/\.\./g, '') || ''
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'failed to list directory' });
  }
});

// Ensure terminal session exists
app.post('/api/terminal/ensure', requireAuth, (req, res) => {
  try {
    const session = ensureTerminalSession();
    res.json({ ok: true, ready: session.ready, cwd: session.cwd });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/terminal/exec', terminalRateLimiter, requireAuth, requireCsrf, requirePerm('terminal.exec'), async (req, res) => {
  const command = String(req.body?.command || '').trim();
  if (!command) return res.status(400).json({ error: 'command required' });
  if (command.length > 4096) return res.status(400).json({ error: 'command too long (max 4096 chars)' });
  log('terminal.input', command.slice(0, 120));
  try {
    const special = await maybeHandleSpecialTerminalCommand(command);
    if (special) {
      appendTerminalOutput(`
[cron] ${String(command).replace(/^\//, '')}
`);
      return res.json({
        ok: true,
        special: true,
        command,
        cwd: PROJECT_ROOT,
        identity: HCI_IDENTITY,
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
      identity: HCI_IDENTITY,
      ready: terminalSession.ready,
      buffer: terminalSession.buffer,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'terminal write failed' });
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

app.post('/api/cron/:action', requireAuth, requireCsrf, requirePerm('cron.manage'), async (req, res) => {
  try {
    const result = await handleCronAction(req.params.action, req.body || {}, req.query || {}, '/api/cron');
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message || 'cron action failed' });
  }
});

app.post('/internal/cron/:action', async (req, res) => {
  const secret = String(req.get('x-hermes-control-secret') || '');
  if (!secret || !safeTimingEqual(secret, CONTROL_SECRET)) return res.status(403).json({ error: 'forbidden' });
  try {
    const result = await handleCronAction(req.params.action, req.body || {}, req.query || {}, '/internal/cron');
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message || 'cron action failed' });
  }
});


app.get('/usage', requireAuth, (req, res) => {
  res.json(buildUsageSummary());
});

app.get('/api/usage', requireAuth, requirePerm('usage.view'), (req, res) => {
  res.json(buildUsageSummary());
});

app.get('/api/insights', requireAuth, requirePerm('usage.view'), async (req, res) => {
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

app.post('/api/avatar', requireCsrf, express.json({ limit: '10mb' }), (req, res) => {
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

// HCI Update — git pull + npm install + build + auto-restart
app.post('/api/hci/update', requireRole('admin'), requireCsrf, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'progress', line: 'Starting HCI update...' })}\n\n`);

  const HCI_DIR = path.join(__dirname);
  const steps = [
    { name: 'git reset', cmd: `cd ${HCI_DIR} && git checkout -- . 2>&1 || true` },
    { name: 'git pull', cmd: `cd ${HCI_DIR} && git pull --ff-only 2>&1` },
    { name: 'npm install', cmd: `cd ${HCI_DIR} && npm install 2>&1` },
    { name: 'build', cmd: `cd ${HCI_DIR} && npm run build 2>&1` },
  ];

  (async () => {
    for (const step of steps) {
      res.write(`data: ${JSON.stringify({ type: 'progress', line: `▸ ${step.name}...` })}\n\n`);
      try {
        const out = await shell(step.cmd, '120s');
        const text = out.trim() || '(no output)';
        text.split('\n').filter(l => l.trim()).forEach(line => {
          res.write(`data: ${JSON.stringify({ type: 'progress', line: '  ' + line.trim() })}\n\n`);
        });
        if (out.includes('error') || out.includes('ERROR') || out.includes('fatal')) {
          res.write(`data: ${JSON.stringify({ type: 'error', message: `${step.name} failed` })}\n\n`);
          return res.end();
        }
      } catch (e) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: `${step.name} failed: ${e.message}` })}\n\n`);
        return res.end();
      }
    }
    res.write(`data: ${JSON.stringify({ type: 'progress', line: '▸ Update complete. Restarting in 3s...' })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done', message: 'Update complete, restarting...' })}\n\n`);
    res.end();
    // Spawn restart script — same pattern as /api/hci-restart
    // Server stays alive until fuser -k kills it, then new one starts
    const restartScript = `sleep 3 && fuser -k ${PORT}/tcp 2>/dev/null; sleep 1 && cd ${PROJECT_ROOT} && nohup node server.js &>/tmp/hci-staging.log &`;
    spawn('sh', ['-c', restartScript], { detached: true, stdio: 'ignore' }).unref();
    // No process.exit(0) — fuser -k will kill us cleanly
  })();
});

// HCI Check Updates — git fetch + compare local vs remote
app.get('/api/hci/check-update', requireRole('admin'), async (req, res) => {
  try {
    const HCI_DIR = __dirname;
    // Helper: run shell command in HCI_DIR (timeout can't exec shell builtins like cd)
    const run = (cmd, timeout) => shell(`bash -c "cd '${HCI_DIR}' && ${cmd}"`, timeout);
    // Get current branch
    const branch = (await run('git branch --show-current', '5s')).trim();
    // Fetch latest without modifying working tree
    await run('git fetch origin ' + branch, '30s');
    // Get local commit
    const localHash = (await run('git rev-parse --short HEAD', '5s')).trim();
    const localMsg = (await run('git log -1 --pretty=format:"%s"', '5s')).trim();
    const localDate = (await run('git log -1 --format="%ci"', '5s')).trim();
    // Get remote commit
    const remoteHash = (await run(`git rev-parse --short origin/${branch}`, '5s')).trim();
    // Count commits behind
    const behindStr = (await run(`git rev-list HEAD..origin/${branch} --count`, '5s')).trim();
    const behind = parseInt(behindStr, 10) || 0;
    // List commits ahead on remote (newest first)
    let commits = [];
    if (behind > 0) {
      const logRaw = await run(
        `git log --oneline --format="%H|%h|%s|%an|%ci" HEAD..origin/${branch}`,
        '10s'
      );
      commits = logRaw.trim().split('\n').filter(Boolean).map(line => {
        const [hash, shortHash, msg, author, date] = line.split('|');
        return { hash, shortHash, msg, author, date };
      });
    }
    // Get package.json version
    let pkgVersion = '';
    try { pkgVersion = JSON.parse(fs.readFileSync(path.join(HCI_DIR, 'package.json'), 'utf8')).version; } catch {}

    res.json({
      ok: true,
      branch,
      local: { hash: localHash, msg: localMsg, date: localDate, version: pkgVersion },
      remote: { hash: remoteHash },
      behind,
      commits,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// HCI Commit Diff — summary of changes for a specific commit
app.get('/api/hci/commit/:hash/diff', requireRole('admin'), async (req, res) => {
  try {
    const HCI_DIR = __dirname;
    const hash = req.params.hash.replace(/[^a-f0-9]/g, ''); // sanitize
    const run = (cmd, timeout) => shell(`bash -c "cd '${HCI_DIR}' && ${cmd}"`, timeout);
    // Get commit metadata
    const metaRaw = await run(`git log -1 --format="%H|%h|%s|%an|%ci|%b" ${hash}`, '5s');
    const [fullHash, shortHash, msg, author, date, body] = metaRaw.trim().split('|');
    // Get diffstat (summary only, no raw diff)
    const stat = await run(`git diff --stat ${hash}~1..${hash} 2>&1`, '10s');
    // Get numstat for structured data
    const numstat = await run(`git diff --numstat ${hash}~1..${hash} 2>&1`, '10s');
    const files = numstat.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t');
      return { added: parseInt(parts[0], 10) || 0, removed: parseInt(parts[1], 10) || 0, file: parts[2] };
    });
    // Summary line from git diff --shortstat
    const shortstat = (await run(`git diff --shortstat ${hash}~1..${hash}`, '5s')).trim();

    res.json({
      ok: true,
      commit: { hash: fullHash, shortHash, msg, author, date, body: body || '' },
      files,
      shortstat,
      statText: stat.trim(),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// HCI Update to specific commit — git checkout + npm install + build + auto-restart
app.post('/api/hci/update/commit/:hash', requireRole('admin'), requireCsrf, (req, res) => {
  const HCI_DIR = __dirname;
  const hash = req.params.hash.replace(/[^a-f0-9]/g, ''); // sanitize
  const run = (cmd, timeout) => shell(`bash -c "cd '${HCI_DIR}' && ${cmd}"`, timeout);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'progress', line: `Checking out commit ${hash}...` })}\n\n`);

  const steps = [
    { name: 'fetch', cmd: 'git fetch origin', timeout: '30s' },
    { name: 'checkout', cmd: `git checkout ${hash} 2>&1`, timeout: '15s' },
    { name: 'npm install', cmd: 'npm install 2>&1', timeout: '120s' },
    { name: 'build', cmd: 'npm run build 2>&1', timeout: '120s' },
  ];

  (async () => {
    for (const step of steps) {
      res.write(`data: ${JSON.stringify({ type: 'progress', line: `▸ ${step.name}...` })}\n\n`);
      try {
        const out = await run(step.cmd, step.timeout || '60s');
        const text = out.trim() || '(no output)';
        text.split('\n').filter(l => l.trim()).forEach(line => {
          res.write(`data: ${JSON.stringify({ type: 'progress', line: '  ' + line.trim() })}\n\n`);
        });
        if (out.includes('error') || out.includes('ERROR') || out.includes('fatal')) {
          // Don't abort on git checkout "error" — it might be a warning
          if (step.name === 'checkout') {
            res.write(`data: ${JSON.stringify({ type: 'warning', line: 'Checkout had warnings but continuing' })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({ type: 'error', message: `${step.name} failed` })}\n\n`);
            return res.end();
          }
        }
      } catch (e) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: `${step.name} failed: ${e.message}` })}\n\n`);
        return res.end();
      }
    }
    // Get commit info for confirmation
    const currentHash = (await run('git rev-parse --short HEAD', '5s')).trim();
    const currentMsg = (await run('git log -1 --pretty=format:"%s"', '5s')).trim();
    res.write(`data: ${JSON.stringify({ type: 'progress', line: `▸ Now at ${currentHash}: ${currentMsg}` })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'progress', line: '▸ Update complete. Restarting in 3s...' })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done', message: 'Update complete', hash: currentHash, msg: currentMsg })}\n\n`);
    res.end();

    // Spawn restart script (same pattern as existing /api/hci/update)
    const restartScript = `sleep 3 && fuser -k ${PORT}/tcp 2>/dev/null; sleep 1 && cd ${PROJECT_ROOT} && nohup node server.js &>/tmp/hci-staging.log &`;
    spawn('sh', ['-c', restartScript], { detached: true, stdio: 'ignore' }).unref();
  })();
});

// HCI Rollback — checkout previous commit (HEAD~N)
app.post('/api/hci/rollback', requireRole('admin'), requireCsrf, (req, res) => {
  const HCI_DIR = __dirname;
  const numSteps = req.body?.steps || 1; // how many commits back, default 1
  const run = (cmd, timeout) => shell(`bash -c "cd '${HCI_DIR}' && ${cmd}"`, timeout);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'progress', line: `Rolling back ${numSteps} commit(s)...` })}\n\n`);

  const rollbackSteps = [
    { name: 'checkout', cmd: `git checkout HEAD~${numSteps} 2>&1`, timeout: '15s' },
    { name: 'npm install', cmd: 'npm install 2>&1', timeout: '120s' },
    { name: 'build', cmd: 'npm run build 2>&1', timeout: '120s' },
  ];

  (async () => {
    for (const step of rollbackSteps) {
      res.write(`data: ${JSON.stringify({ type: 'progress', line: `▸ ${step.name}...` })}\n\n`);
      try {
        const out = await run(step.cmd, step.timeout);
        const text = out.trim() || '(no output)';
        text.split('\n').filter(l => l.trim()).forEach(line => {
          res.write(`data: ${JSON.stringify({ type: 'progress', line: '  ' + line.trim() })}\n\n`);
        });
      } catch (e) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: `${step.name} failed: ${e.message}` })}\n\n`);
        return res.end();
      }
    }
    const currentHash = (await run('git rev-parse --short HEAD', '5s')).trim();
    res.write(`data: ${JSON.stringify({ type: 'progress', line: `▸ Rolled back to ${currentHash}` })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done', message: 'Rollback complete', hash: currentHash })}\n\n`);
    res.end();

    const restartScript = `sleep 3 && fuser -k ${PORT}/tcp 2>/dev/null; sleep 1 && cd ${PROJECT_ROOT} && nohup node server.js &>/tmp/hci-staging.log &`;
    spawn('sh', ['-c', restartScript], { detached: true, stdio: 'ignore' }).unref();
  })();
});

// ============================================
// Missing API Endpoints
// ============================================

// Auth providers (Hermes auth list)
app.get('/api/auth/providers', requireRole('admin'), async (req, res) => {
  try {
    const raw = await shell('hermes auth list 2>&1');
    const lines = raw.split('\n').filter(Boolean);
    const providers = [];
    for (const line of lines) {
      const match = line.match(/(✓|✗|●|○)\s*(\w+)\s*(set|not set)/i);
      if (match) {
        providers.push({ name: match[2], set: match[3] === 'set' });
      }
    }
    // Fallback: parse any line with provider names
    if (providers.length === 0) {
      const knownProviders = ['openrouter', 'anthropic', 'nous', 'openai', 'google', 'openai-codex', 'firecrawl', 'tavily'];
      for (const p of knownProviders) {
        if (raw.toLowerCase().includes(p)) {
          providers.push({ name: p, set: raw.includes(p) && !raw.includes(`${p}\nnot set`) });
        }
      }
    }
    res.json({ ok: true, providers });
  } catch (e) {
    res.json({ ok: true, providers: [] });
  }
});

// Skills list
app.get('/api/skills', requireAuth, async (req, res) => {
  try {
    const raw = await shell('hermes skills list 2>&1');
    const lines = raw.split('\n');
    const skills = [];
    for (const line of lines) {
      // Only parse data rows that start with │
      if (!line.trim().startsWith('│')) continue;
      // Split by │ and clean each cell
      const cells = line.split('│').map(c => c.trim()).filter((c, i) => i > 0);
      if (cells.length >= 2 && cells[0]) {
        skills.push({
          name: cells[0] || '',
          category: cells[1] || 'uncategorized',
          source: cells[2] || '',
          trust: cells[3] || '',
          enabled: true,
        });
      }
    }
    res.json({ ok: true, skills });
  } catch (e) {
    res.json({ ok: true, skills: [] });
  }
});

// Config show
app.get('/api/config/:profile', requireAuth, async (req, res) => {
  try {
    const profile = sanitizeProfileName(req.params.profile);
    if (!profile) return res.status(400).json({ ok: false, error: 'invalid profile name' });
    const home = profile === 'default' ? `${process.env.HOME}/.hermes` : `${process.env.HOME}/.hermes/profiles/${profile}`;
    const configPath = `${home}/config.yaml`;
    const raw = await shell(`cat "${configPath}" 2>/dev/null || echo "not_found"`);
    if (raw.trim() === 'not_found') {
      return res.json({ ok: false, error: 'Config not found' });
    }
    // Parse YAML
    const config = yaml.load(raw) || {};
    // Also return raw YAML for diff/preview
    res.json({ ok: true, config, raw_yaml: raw });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Config update (save)
app.put('/api/config/:profile', requireAuth, requireRole('admin'), requireCsrf, async (req, res) => {
  try {
    const profile = sanitizeProfileName(req.params.profile);
    if (!profile) return res.status(400).json({ ok: false, error: 'invalid profile name' });
    const home = profile === 'default' ? `${process.env.HOME}/.hermes` : `${process.env.HOME}/.hermes/profiles/${profile}`;
    const configPath = `${home}/config.yaml`;

    // Validate input is an object
    const newConfig = req.body?.config;
    if (!newConfig || typeof newConfig !== 'object' || Array.isArray(newConfig)) {
      return res.status(400).json({ ok: false, error: 'config must be a non-array object' });
    }

    // Backup current config
    const backupPath = `${configPath}.bak.${Date.now()}`;
    await shell(`cp "${configPath}" "${backupPath}" 2>/dev/null || true`);

    // Auto-inject or fix api_server for Gateway API chat (every save)
    const jsYaml = require('js-yaml');
    const existingPorts = discoverGatewayPorts(); // { profile: port, ... }
    const myPort = existingPorts[profile]; // this profile's current port (from old config)

    if (newConfig.platforms?.api_server?.enabled) {
      // Config has api_server — check for port conflicts (clone issue)
      const requestedPort = newConfig.platforms.api_server.extra?.port;
      if (requestedPort) {
        // Check if another profile is using this port
        const conflict = Object.entries(existingPorts).find(([p, pt]) => p !== profile && pt === requestedPort);
        if (conflict) {
          // Port conflict — assign new unique port
          let newPort = 8650;
          while (Object.values(existingPorts).includes(newPort)) newPort++;
          newConfig.platforms.api_server.extra.port = newPort;
          console.log(`[ConfigSave] Port conflict: ${requestedPort} used by ${conflict[0]}, reassigned to ${newPort} for ${profile}`);
        }
      }
    } else {
      // No api_server — inject from scratch
      let port = myPort || 8650;
      if (Object.values(existingPorts).includes(port) && !myPort) {
        while (Object.values(existingPorts).includes(port)) port++;
      }
      newConfig.platforms = newConfig.platforms || {};
      newConfig.platforms.api_server = {
        enabled: true,
        extra: {
          host: '127.0.0.1',
          port,
          key: GATEWAY_API_KEY,
          cors_origins: resolveCorsOrigins(req),
        },
      };
      console.log(`[ConfigSave] Auto-injected api_server on port ${port} for ${profile}`);
    }
    // Restart gateway service + refresh ports
    const svcFile = `/etc/systemd/system/hermes-gateway-${profile}.service`;
    if (fs.existsSync(svcFile)) {
      try { await shell(`systemctl daemon-reload && systemctl restart hermes-gateway-${profile} 2>&1`, '15s'); } catch {}
    } else {
      console.log(`[ConfigSave] No gateway service for ${profile}, skipping restart`);
    }
    gatewayPorts = discoverGatewayPorts();

    // Convert to YAML with good formatting
    const yamlLib = require('yaml');
    const doc = new yamlLib.Document(newConfig);
    doc.commentBefore = ' Managed by Hermes Control Interface';
    const yamlStr = doc.toString();

    // Validate by parsing back
    const parsed = yamlLib.parse(yamlStr);
    if (!parsed || typeof parsed !== 'object') {
      return res.status(400).json({ ok: false, error: 'Generated YAML is invalid' });
    }

    // Write
    fs.writeFileSync(configPath, yamlStr + '\n');

    // Force-refresh gateway ports after file write (don't rely on fs.watch timing)
    gatewayPorts = discoverGatewayPorts();
    console.log('[Gateway] Ports refreshed after config save:', gatewayPorts);

    audit(req.hciUser?.username || 'unknown', req.hciUser?.role || 'unknown', 'CONFIG_UPDATE', profile);
    res.json({ ok: true, backup: backupPath });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Key metadata: category, description, provider URL, advanced flag
const KEY_METADATA = {
  // LLM Providers
  OPENROUTER_API_KEY:      { cat: 'LLM Providers',    desc: 'OpenRouter API key',           url: 'https://openrouter.ai/keys',       adv: false },
  OPENAI_API_KEY:          { cat: 'LLM Providers',    desc: 'OpenAI API key',               url: 'https://platform.openai.com/api-keys', adv: false },
  ANTHROPIC_API_KEY:       { cat: 'LLM Providers',    desc: 'Anthropic API key',            url: 'https://console.anthropic.com/settings/keys', adv: false },
  DEEPSEEK_API_KEY:        { cat: 'LLM Providers',    desc: 'DeepSeek API key',              url: 'https://platform.deepseek.com/api-keys', adv: false },
  GEMINI_API_KEY:          { cat: 'LLM Providers',    desc: 'Google Gemini API key',         url: 'https://aistudio.google.com/app/apikey', adv: false },
  GROQ_API_KEY:            { cat: 'LLM Providers',    desc: 'Groq API key',                  url: 'https://console.groq.com/keys',     adv: false },
  MISTRAL_API_KEY:         { cat: 'LLM Providers',    desc: 'Mistral API key',               url: 'https://console.mistral.ai/api/',    adv: false },
  TOGETHER_API_KEY:        { cat: 'LLM Providers',    desc: 'Together AI API key',           url: 'https://api.together.xyz/settings/api-keys', adv: false },
  OPENAI_BASE_URL:         { cat: 'LLM Providers',    desc: 'OpenAI-compatible base URL',    url: '',  adv: false },
  ANTHROPIC_BASE_URL:      { cat: 'LLM Providers',    desc: 'Anthropic base URL',            url: '',  adv: true },
  DEEPSEEK_BASE_URL:       { cat: 'LLM Providers',    desc: 'DeepSeek base URL',             url: '',  adv: true },
  LLM_MODEL:               { cat: 'LLM Providers',    desc: 'Default LLM model',             url: '',  adv: false },
  LLM_PROVIDER:            { cat: 'LLM Providers',    desc: 'Default LLM provider',          url: '',  adv: false },
  // Tool APIs
  BROWSERBASE_API_KEY:     { cat: 'Tool APIs',        desc: 'Browserbase API key (web scraping)', url: 'https://browserbase.com',  adv: false },
  BROWSERBASE_API_SECRET:  { cat: 'Tool APIs',        desc: 'Browserbase API secret',         url: 'https://browserbase.com',  adv: true },
  FIRECRAWL_API_KEY:       { cat: 'Tool APIs',        desc: 'Firecrawl API key (web scraping)', url: 'https://firecrawl.dev', adv: false },
  TAVILY_API_KEY:          { cat: 'Tool APIs',        desc: 'Tavily API key (web search)',   url: 'https://app.tavily.com',    adv: false },
  ELEVENLABS_API_KEY:      { cat: 'Tool APIs',        desc: 'ElevenLabs API key (TTS)',     url: 'https://elevenlabs.io/api',  adv: false },
  HUGGINGFACE_API_KEY:     { cat: 'Tool APIs',        desc: 'HuggingFace API key',          url: 'https://huggingface.co/settings/inference', adv: false },
  // Messaging Platforms
  TELEGRAM_BOT_TOKEN:      { cat: 'Messaging Platforms', desc: 'Telegram bot token',         url: 'https://t.me/BotFather',    adv: false },
  DISCORD_BOT_TOKEN:       { cat: 'Messaging Platforms', desc: 'Discord bot token',           url: 'https://discord.com/developers/applications', adv: false },
  SLACK_BOT_TOKEN:         { cat: 'Messaging Platforms', desc: 'Slack bot token (xoxb)',      url: 'https://api.slack.com/apps', adv: false },
  WHATSAPP_SESSION_PATH:   { cat: 'Messaging Platforms', desc: 'WhatsApp session file path', url: '',  adv: false },
  // Agent Settings
  HERMES_CONTROL_PASSWORD:  { cat: 'Agent Settings',   desc: 'HCI control password',         url: '',  adv: false },
  HERMES_CONTROL_SECRET:   { cat: 'Agent Settings',   desc: 'HCI control secret',           url: '',  adv: true },
  API_SERVER_ENABLED:      { cat: 'Agent Settings',   desc: 'Enable API server',             url: '',  adv: false },
  API_SERVER_PORT:         { cat: 'Agent Settings',   desc: 'API server port',               url: '',  adv: true },
  WEBHOOK_SECRET:          { cat: 'Agent Settings',   desc: 'Webhook verification secret',   url: '',  adv: true },
  // MCP Keys (match by prefix)
  _MCP_KEYS_PREFIX: ['MCP_'],
};

function getKeyMeta(name) {
  if (KEY_METADATA[name]) return KEY_METADATA[name];
  // Prefix matching for MCP_*
  if (name.startsWith('MCP_')) return { cat: 'MCP Keys', desc: `MCP configuration: ${name}`, url: '', adv: true };
  // If it looks like an API key
  if (/_API_KEY$|_KEY$|_TOKEN$|_SECRET$|_PASSWORD$/i.test(name)) {
    return { cat: 'Advanced', desc: name, url: '', adv: true };
  }
  return { cat: 'Advanced', desc: name, url: '', adv: true };
}

// Keys (secrets) — list keys from .env with category metadata
app.get('/api/keys/:profile', requireAuth, async (req, res) => {
  try {
    const profile = sanitizeProfileName(req.params.profile);
    if (!profile) return res.status(400).json({ ok: false, error: 'invalid profile name' });
    const home = profile === 'default' ? `${process.env.HOME}/.hermes` : `${process.env.HOME}/.hermes/profiles/${profile}`;
    const envPath = `${home}/.env`;
    const raw = await shell(`cat "${envPath}" 2>/dev/null || echo ""`);
    if (!raw.trim()) {
      return res.json({ ok: true, keys: [], categories: [] });
    }
    const keys = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const name = trimmed.substring(0, eqIdx).trim();
      const value = trimmed.substring(eqIdx + 1).trim();
      const masked = value.length > 4
        ? value.substring(0, 2) + '•'.repeat(Math.min(value.length - 4, 20)) + value.substring(value.length - 2)
        : '•'.repeat(value.length);
      const meta = getKeyMeta(name);
      keys.push({ name, masked, has_value: value.length > 0, category: meta.cat, description: meta.desc, provider_url: meta.url, is_advanced: meta.adv });
    }

    // Group by category
    const cats = {};
    const catOrder = ['LLM Providers', 'Tool APIs', 'Messaging Platforms', 'Agent Settings', 'MCP Keys', 'Advanced'];
    keys.forEach(k => {
      if (!cats[k.category]) cats[k.category] = [];
      cats[k.category].push(k);
    });
    const categories = catOrder.filter(c => cats[c]).map(c => ({ name: c, keys: cats[c] }));
    // Add any remaining uncategorized
    Object.keys(cats).forEach(c => {
      if (!catOrder.includes(c) && c !== 'Advanced') {
        categories.push({ name: c, keys: cats[c] });
      }
    });

    res.json({ ok: true, keys, categories });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Keys — reveal single key value
app.get('/api/keys/:profile/reveal/:name', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const profile = sanitizeProfileName(req.params.profile);
    const keyName = req.params.name;
    if (!profile || !keyName) return res.status(400).json({ ok: false, error: 'invalid params' });
    // Sanitize key name (allow only alphanumeric, underscore)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyName)) {
      return res.status(400).json({ ok: false, error: 'invalid key name' });
    }
    const home = profile === 'default' ? `${process.env.HOME}/.hermes` : `${process.env.HOME}/.hermes/profiles/${profile}`;
    const envPath = `${home}/.env`;
    const raw = await shell(`grep -E "^${keyName}=" "${envPath}" 2>/dev/null || echo ""`);
    if (!raw.trim()) {
      return res.json({ ok: false, error: 'Key not found' });
    }
    const value = raw.trim().substring(raw.indexOf('=') + 1).trim();
    audit(req.hciUser?.username || 'unknown', req.hciUser?.role || 'unknown', 'KEY_REVEAL', `${profile}:${keyName}`);
    res.json({ ok: true, value });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Keys — save/update key
app.put('/api/keys/:profile', requireAuth, requireRole('admin'), requireCsrf, async (req, res) => {
  try {
    const profile = sanitizeProfileName(req.params.profile);
    if (!profile) return res.status(400).json({ ok: false, error: 'invalid profile name' });
    const { name, value } = req.body || {};
    if (!name || typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return res.status(400).json({ ok: false, error: 'invalid key name (must match [A-Za-z_][A-Za-z0-9_]*)' });
    }
    if (typeof value !== 'string') {
      return res.status(400).json({ ok: false, error: 'value must be a string' });
    }
    const home = profile === 'default' ? `${process.env.HOME}/.hermes` : `${process.env.HOME}/.hermes/profiles/${profile}`;
    const envPath = `${home}/.env`;
    // Read current .env
    const raw = await shell(`cat "${envPath}" 2>/dev/null || echo ""`);
    const lines = raw.split('\n');
    const keyRegex = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=`);
    const existingIdx = lines.findIndex(l => keyRegex.test(l.trim()));
    // Escape value for .env — quote only if value has spaces/special chars
    const needsQuote = /[\s"'`$\\#!]/.test(value) || value === '';
    const line = needsQuote ? `${name}='${value.replace(/'/g, "'\\''")}'` : `${name}=${value}`;
    if (existingIdx >= 0) {
      // Update existing
      lines[existingIdx] = line;
    } else {
      // Add new
      lines.push(line);
    }
    const newContent = lines.join('\n');
    fs.writeFileSync(envPath, newContent + '\n');
    audit(req.hciUser?.username || 'unknown', req.hciUser?.role || 'unknown', 'KEY_UPDATE', `${profile}:${name}`);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Keys — delete key
app.delete('/api/keys/:profile/:name', requireAuth, requireRole('admin'), requireCsrf, async (req, res) => {
  try {
    const profile = sanitizeProfileName(req.params.profile);
    const keyName = req.params.name;
    if (!profile || !keyName) return res.status(400).json({ ok: false, error: 'invalid params' });
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyName)) {
      return res.status(400).json({ ok: false, error: 'invalid key name' });
    }
    const home = profile === 'default' ? `${process.env.HOME}/.hermes` : `${process.env.HOME}/.hermes/profiles/${profile}`;
    const envPath = `${home}/.env`;
    // Remove the key line using sed
    await shell(`sed -i '/^${keyName}=/d' "${envPath}"`);
    audit(req.hciUser?.username || 'unknown', req.hciUser?.role || 'unknown', 'KEY_DELETE', `${profile}:${keyName}`);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Memory data
app.get('/api/memory/:profile', requireAuth, async (req, res) => {
  try {
    const profile = sanitizeProfileName(req.params.profile);
    if (!profile) return res.status(400).json({ ok: false, error: 'invalid profile name' });
    const home = profile === 'default' ? `${process.env.HOME}/.hermes` : `${process.env.HOME}/.hermes/profiles/${profile}`;
    const memoriesDir = profile === 'default' ? `${process.env.HOME}/.hermes/memories` : `${home}/memories`;
    const [memoryContent, userContent, soulContent, honchoConfig] = await Promise.all([
      shell(`cat "${memoriesDir}/MEMORY.md" 2>/dev/null || echo ""`),
      shell(`cat "${memoriesDir}/USER.md" 2>/dev/null || echo ""`),
      shell(`cat "${home}/SOUL.md" 2>/dev/null || echo ""`),
      shell(`cat "${home}/honcho.json" 2>/dev/null || echo ""`),
    ]);
    // Check Honcho connection via hermes CLI
    let honcho_data = { connected: false };
    try {
      const honchoStatus = await shell(`hermes honcho --target-profile ${profile} status 2>&1`);
      const lines = honchoStatus.split('\n');
      honcho_data.connected = honchoStatus.includes('Connection... OK');
      honcho_data.enabled = honchoStatus.includes('Enabled:        True');
      const getVal = (key) => {
        const line = lines.find(l => l.trim().startsWith(key + ':'));
        return line ? line.split(':').slice(1).join(':').trim() : '';
      };
      honcho_data.profile = getVal('Profile');
      honcho_data.host = getVal('Host');
      honcho_data.workspace = getVal('Workspace');
      honcho_data.ai_peer = getVal('AI peer');
      honcho_data.user_peer = getVal('User peer');
      honcho_data.session_key = getVal('Session key');
      honcho_data.recall_mode = getVal('Recall mode');
      honcho_data.write_freq = getVal('Write freq');
      honcho_data.config_path = getVal('Config path');
      // Extract first few lines of representation
      const reprStart = lines.findIndex(l => l.includes('AI peer representation:'));
      if (reprStart > -1) {
        honcho_data.representation = lines.slice(reprStart + 1, reprStart + 6)
          .map(l => l.trim()).filter(Boolean).join(' ').substring(0, 200);
      }
    } catch { honcho_data = { connected: false }; }
    res.json({
      ok: true,
      memory_chars: memoryContent.length,
      memory_max: 2200,
      user_chars: userContent.length,
      user_max: 1375,
      soul_chars: soulContent.length,
      memory_content: memoryContent.substring(0, 200),
      user_content: userContent.substring(0, 200),
      soul_content: soulContent,
      honcho_connected: honcho_data.connected,
      honcho_data,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Profiles list (for skill install picker)
// Skills browse (paginated)
app.get('/api/skills/browse/:page', requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.params.page) || 1);
    const output = await execHermes(['skills', 'browse', '--page', String(page)], 15000);
    res.json({ ok: true, output, page });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Skills search — use execHermes to prevent shell injection
app.get('/api/skills/search/:query', requireAuth, async (req, res) => {
  try {
    const query = decodeURIComponent(req.params.query);
    const output = await execHermes(['skills', 'search', query], 15000);
    // Parse table output into structured results
    const lines = output.split('\n');
    const results = [];
    for (const line of lines) {
      // Match lines like: │ solana │ Query Solana blockchain... │ official │ official │ official/blockchain/… │
      const cells = line.split('│').map(c => c.trim()).filter(Boolean);
      if (cells.length >= 4 && !cells[0].match(/^[━┏┗┓┛┠┨┯┷┼─]+$/) && cells[0] !== 'Name') {
        results.push({
          name: cells[0],
          description: cells[1] || '',
          source: cells[2] || '',
          trust: cells[3] || '',
          identifier: cells[4] || cells[0],
        });
      }
    }
    // Deduplicate by name
    const seen = new Set();
    const unique = results.filter(r => { if (seen.has(r.name)) return false; seen.add(r.name); return true; });
    res.json({ ok: true, output, results: unique });
  } catch (e) {
    res.json({ ok: false, error: e.message, results: [] });
  }
});

// Skills inspect (preview) — use execHermes to prevent shell injection
app.get('/api/skills/inspect/:name', requireAuth, async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const output = await execHermes(['skills', 'inspect', name], 15000);
    res.json({ ok: true, output });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Skills list (installed for a profile)
app.get('/api/skills/list/:profile', requireAuth, async (req, res) => {
  try {
    const profile = sanitizeProfileName(req.params.profile);
    if (!profile) return res.status(400).json({ ok: false, error: 'invalid profile name' });
    const profArg = profile === 'default' ? [] : ['-p', profile];
    const output = await execHermes([...profArg, 'skills', 'list'], 15000);
    res.json({ ok: true, output });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Skills install (with profile picker)
app.post('/api/skills/install', requireRole('admin'), requireCsrf, async (req, res) => {
  try {
    const { skill, profile } = req.body || {};
    if (!skill) return res.status(400).json({ ok: false, error: 'skill name required' });
    if (!/^[\w.\-]+$/.test(skill)) return res.status(400).json({ ok: false, error: 'invalid skill name' });
    const profArg = profile ? ['-p', sanitizeProfileName(profile)] : [];
    const output = await execHermes([...profArg, 'skills', 'install', skill, '--yes'], 30000);
    const success = !output.includes('error') && !output.includes('Error');
    res.json({ ok: success, output });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Skills uninstall
app.post('/api/skills/uninstall', requireRole('admin'), requireCsrf, async (req, res) => {
  try {
    const { skill, profile } = req.body || {};
    if (!skill) return res.status(400).json({ ok: false, error: 'skill name required' });
    // Sanitize skill name — only allow safe characters to prevent command injection
    if (!/^[\w.\-]+$/.test(skill)) return res.status(400).json({ ok: false, error: 'invalid skill name' });
    const profArg = profile ? ['-p', sanitizeProfileName(profile)] : [];
    const output = await shell(`echo y | hermes ${profArg.length ? `-p ${profArg[1]} ` : ''}skills uninstall ${skill} 2>&1`, 15000);
    res.json({ ok: true, output });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Skills update
app.post('/api/skills/update', requireRole('admin'), requireCsrf, async (req, res) => {
  try {
    const { skill, profile } = req.body || {};
    if (skill && !/^[\w.\-]+$/.test(skill)) return res.status(400).json({ ok: false, error: 'invalid skill name' });
    const profArg = profile ? ['-p', sanitizeProfileName(profile)] : [];
    const args = [...profArg, 'skills', 'update', ...(skill ? [skill] : [])];
    const output = await execHermes(args, 30000);
    res.json({ ok: true, output });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Skills check updates
app.post('/api/skills/check', requireAuth, requireCsrf, async (req, res) => {
  try {
    const { profile } = req.body || {};
    const profArg = profile ? ['-p', sanitizeProfileName(profile)] : [];
    const output = await execHermes([...profArg, 'skills', 'check'], 30000);
    // Parse table output
    const lines = output.split('\n');
    const updates = [];
    for (const line of lines) {
      const cells = line.split(/[┃┡━╇┓┛┠┨┯┷┼─]+/).map(c => c.trim()).filter(Boolean);
      if (cells.length >= 3 && cells[0] !== 'Name' && !cells[0].match(/^[━┏┗┓┛]+$/)) {
        updates.push({ name: cells[0], source: cells[1], status: cells[2] });
      }
    }
    const hasUpdates = updates.some(u => /update|outdated|newer/i.test(u.status));
    res.json({ ok: true, output, updates, hasUpdates });
  } catch (e) {
    res.json({ ok: false, error: e.message, updates: [] });
  }
});

// Doctor
app.post('/api/doctor', requireRole('admin'), requireCsrf, (req, res) => {
  const fix = req.body.fix ? '--fix' : '';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'progress', line: fix ? 'Running diagnostics with auto-fix...' : 'Running diagnostics...' })}\n\n`);

  const proc = spawn('script', ['-qfc', `hermes doctor ${fix}`, '/dev/null'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HERMES_HOME: path.join(os.homedir(), '.hermes'), TERM: 'dumb' },
  });
  let fullOutput = '';
  proc.stdout.on('data', (chunk) => {
    const text = stripAnsi(chunk.toString());
    fullOutput += text;
    text.split('\n').filter(l => l.trim()).forEach(line => {
      res.write(`data: ${JSON.stringify({ type: 'progress', line: line.trim() })}\n\n`);
    });
  });
  proc.stderr.on('data', (chunk) => {
    const text = stripAnsi(chunk.toString());
    fullOutput += text;
    if (text.trim()) res.write(`data: ${JSON.stringify({ type: 'progress', line: text.trim() })}\n\n`);
  });
  proc.on('close', (code) => {
    res.write(`data: ${JSON.stringify({ type: 'done', output: fullOutput.trim() })}\n\n`);
    res.end();
  });
});

// ── Backup & Import ──
// Helper: strip ANSI escape codes from string
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\r/g, '');
}

app.post('/api/backup/create', requireRole('admin'), requireCsrf, (req, res) => {
  // SSE response — stream hermes backup progress in real-time
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',  // prevent nginx buffering
  });
  res.flushHeaders();
  // Send initial event so frontend knows connection is alive
  res.write(`data: ${JSON.stringify({ type: 'progress', line: 'Starting backup...' })}\n\n`);

  const outPath = `/tmp/hermes-backup-${Date.now()}.zip`;
  // Use 'script' to fake a PTY — forces hermes CLI to line-buffer stdout
  const proc = spawn('script', ['-qfc', `hermes backup -o ${outPath}`, '/dev/null'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HERMES_HOME: path.join(os.homedir(), '.hermes'), TERM: 'dumb' },
  });
  let fullOutput = '';
  proc.stdout.on('data', (chunk) => {
    const text = stripAnsi(chunk.toString());
    fullOutput += text;
    text.split('\n').filter(l => l.trim()).forEach(line => {
      res.write(`data: ${JSON.stringify({ type: 'progress', line: line.trim() })}\n\n`);
    });
  });
  proc.stderr.on('data', (chunk) => {
    const text = stripAnsi(chunk.toString());
    fullOutput += text;
    if (text.trim()) {
      res.write(`data: ${JSON.stringify({ type: 'progress', line: text.trim() })}\n\n`);
    }
  });
  proc.on('close', (code) => {
    if (!fs.existsSync(outPath)) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Backup file not created', output: fullOutput.trim() })}\n\n`);
      return res.end();
    }
    const filename = 'hermes-backup-' + new Date().toISOString().slice(0, 10) + '.zip';
    audit(req.hciUser?.username || 'unknown', req.hciUser?.role || 'unknown', 'BACKUP_CREATE', outPath);
    res.write(`data: ${JSON.stringify({ type: 'done', path: outPath, filename, output: fullOutput.trim() })}\n\n`);
    res.end();
  });
});

app.post('/api/backup/import', requireRole('admin'), requireCsrf, (req, res) => {
  const multer = require('multer');
  const upload = multer({ dest: '/tmp/', limits: { fileSize: 5 * 1024 * 1024 * 1024 } }); // 5GB
  upload.single('backup')(req, res, (multerErr) => {
    if (multerErr || !req.file) {
      return res.json({ ok: false, error: multerErr?.message || 'No file uploaded' });
    }
    const zipPath = req.file.path;
    // SSE response — stream hermes import progress in real-time
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'progress', line: `File uploaded: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)` })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'progress', line: 'Starting import...' })}\n\n`);

    // Use 'script' to fake a PTY — forces hermes CLI to line-buffer stdout
    const proc = spawn('script', ['-qfc', `hermes import ${zipPath} --force`, '/dev/null'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HERMES_HOME: path.join(os.homedir(), '.hermes'), TERM: 'dumb' },
    });
    let fullOutput = '';
    proc.stdout.on('data', (chunk) => {
      const text = stripAnsi(chunk.toString());
      fullOutput += text;
      text.split('\n').filter(l => l.trim()).forEach(line => {
        res.write(`data: ${JSON.stringify({ type: 'progress', line: line.trim() })}\n\n`);
      });
    });
    proc.stderr.on('data', (chunk) => {
      const text = stripAnsi(chunk.toString());
      fullOutput += text;
      if (text.trim()) {
        res.write(`data: ${JSON.stringify({ type: 'progress', line: text.trim() })}\n\n`);
      }
    });
    proc.on('close', (code) => {
      try { fs.unlinkSync(zipPath); } catch {}
      audit(req.hciUser?.username || 'unknown', req.hciUser?.role || 'unknown', 'BACKUP_IMPORT', req.file.originalname);
      res.write(`data: ${JSON.stringify({ type: 'done', output: fullOutput.trim() })}\n\n`);
      res.end();
    });
  });
});

app.get('/api/backup/download', requireRole('admin'), (req, res) => {
  const rawPath = req.query.path;
  if (!rawPath || !rawPath.endsWith('.zip')) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  const filePath = path.resolve(rawPath);
  // Backups are always created in /tmp/ — reject anything outside
  if (!filePath.startsWith('/tmp/')) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath);
});

// Dump
app.get('/api/dump', requireRole('admin'), async (req, res) => {
  try {
    const output = await shell('hermes dump --show-keys 2>&1', '60s');
    res.json({ ok: true, output });
  } catch (e) {
    res.json({ ok: false, output: e.message });
  }
});

// Update
app.post('/api/update', requireRole('admin'), requireCsrf, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'progress', line: 'Starting Hermes update...' })}\n\n`);
  audit(req.hciUser?.username || 'unknown', req.hciUser?.role || 'unknown', 'HERMES_UPDATE', 'started');

  // hermes update --gateway uses file-based IPC for prompts (not stdin!)
  // It writes ~/.hermes/.update_prompt.json and waits for ~/.hermes/.update_response
  const hermesHome = path.join(os.homedir(), '.hermes');
  const promptPath = path.join(hermesHome, '.update_prompt.json');
  const responsePath = path.join(hermesHome, '.update_response');

  // Watch for prompt file and auto-answer "Y"
  const answerInterval = setInterval(() => {
    try {
      if (fs.existsSync(promptPath)) {
        fs.writeFileSync(responsePath, 'Y');
      }
    } catch {}
  }, 500);

  const proc = spawn('script', ['-qfc', 'hermes update --gateway', '/dev/null'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HERMES_HOME: hermesHome, TERM: 'dumb' },
  });
  let fullOutput = '';
  proc.stdout.on('data', (chunk) => {
    const text = stripAnsi(chunk.toString());
    fullOutput += text;
    text.split('\n').filter(l => l.trim()).forEach(line => {
      res.write(`data: ${JSON.stringify({ type: 'progress', line: line.trim() })}\n\n`);
    });
  });
  proc.stderr.on('data', (chunk) => {
    const text = stripAnsi(chunk.toString());
    fullOutput += text;
    if (text.trim()) res.write(`data: ${JSON.stringify({ type: 'progress', line: text.trim() })}\n\n`);
  });
  proc.on('close', (code) => {
    clearInterval(answerInterval);
    // Clean up IPC files
    try { fs.unlinkSync(promptPath); } catch {}
    try { fs.unlinkSync(responsePath); } catch {}
    res.write(`data: ${JSON.stringify({ type: 'done', output: fullOutput.trim() })}\n\n`);
    res.end();
  });
});

// HCI Restart — delayed restart, response sent first
app.post('/api/hci-restart', requireRole('admin'), requireCsrf, (req, res) => {
  audit(req.hciUser?.username || 'unknown', req.hciUser?.role || 'unknown', 'HCI_RESTART', 'initiated');
  res.json({ ok: true, message: 'HCI restarting in 2 seconds...' });
  // Delayed restart: let response flush, then kill and restart
  const script = `sleep 2 && fuser -k ${PORT}/tcp 2>/dev/null; sleep 1 && cd ${PROJECT_ROOT} && nohup node server.js &>/tmp/hci-staging.log &`;
  spawn('sh', ['-c', script], {
    detached: true,
    stdio: 'ignore',
  }).unref();
});

// Session rename
app.post('/api/sessions/:id/rename', requireCsrf, async (req, res) => {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    if (!sessionId) return res.status(400).json({ ok: false, error: 'invalid session id' });
    const title = sanitizeTitle(req.body?.title);
    if (!title) return res.status(400).json({ ok: false, error: 'invalid title (allowed: a-z, A-Z, 0-9, spaces, basic punctuation)' });
    const profile = req.body?.profile || '';
    const profArg = profile ? ['-p', sanitizeProfileName(profile)] : [];
    const args = [...profArg, 'sessions', 'rename', sessionId, title];
    const output = await execHermes(args);
    // Invalidate sessions cache so sidebar refresh picks up the rename
    hermesAllSessionsCache = { at: 0, data: [], key: '' };
    audit(req.hciUser?.username || 'unknown', req.hciUser?.role || 'unknown', 'SESSION_RENAME', `${req.params.id} → ${title}`);
    addNotification('info', `Session renamed: ${sessionId.slice(0, 12)}… → ${title}`);
    res.json({ ok: true, output });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Session export
app.get('/api/sessions/:id/export', requireAuth, async (req, res) => {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    if (!sessionId) return res.status(400).json({ ok: false, error: 'invalid session id' });
    const tmpFile = `/tmp/session-${crypto.randomUUID()}.jsonl`;
    const output = await execHermes(['sessions', 'export', tmpFile, '--session-id', sessionId]);
    const data = await fs.promises.readFile(tmpFile, 'utf8').catch(() => output);
    await fs.promises.unlink(tmpFile).catch(() => {});
    res.json({ ok: true, data: data || output });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Session messages — Phase 1: Message Viewer

app.get('/api/sessions/:id/messages', requireAuth, (req, res) => {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    if (!sessionId) return res.status(400).json({ ok: false, error: 'invalid session id' });

    // Resolve profile-aware state.db path
    const profile = sanitizeProfileName(req.query.profile);
    const stateDbPath = profile && profile !== 'default'
      ? path.join(os.homedir(), '.hermes', 'profiles', profile, 'state.db')
      : path.join(os.homedir(), '.hermes', 'state.db');

    if (!fs.existsSync(stateDbPath)) {
      return res.json({ ok: false, error: `state.db not found for profile: ${profile || 'default'}` });
    }

    const db = new Database(stateDbPath, { readonly: true });
    try {
      // Get session metadata
      const session = db.prepare(`
        SELECT id, source, model, title, started_at, ended_at,
               message_count, tool_call_count, input_tokens, output_tokens,
               estimated_cost_usd
        FROM sessions WHERE id = ?
      `).get(sessionId);

      if (!session) {
        return res.json({ ok: false, error: 'Session not found' });
      }

      // Get messages
      const messages = db.prepare(`
        SELECT id, role, content, tool_calls, tool_name, timestamp,
               reasoning, finish_reason
        FROM messages
        WHERE session_id = ?
        ORDER BY timestamp ASC
      `).all(sessionId);

      // Parse tool_calls JSON strings
      const parsed = messages.map(m => ({
        ...m,
        tool_calls: m.tool_calls ? JSON.parse(m.tool_calls) : null,
      }));

      res.json({ ok: true, session, messages: parsed });
    } finally {
      db.close();
    }
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Session delete
app.delete('/api/sessions/:id', requireCsrf, async (req, res) => {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    if (!sessionId) return res.status(400).json({ ok: false, error: 'invalid session id' });
    const profile = req.body?.profile || req.query?.profile || '';
    const profileFlag = profile ? `-p ${sanitizeProfileName(profile)} ` : '';
    const output = await shell(`hermes ${profileFlag}sessions delete --yes ${sessionId} 2>&1`);
    // Invalidate sessions cache so sidebar refresh picks up the deletion
    hermesAllSessionsCache = { at: 0, data: [], key: '' };
    audit(req.hciUser?.username || 'unknown', req.hciUser?.role || 'unknown', 'SESSION_DELETE', req.params.id);
    addNotification('info', `Session deleted: ${sessionId.slice(0, 12)}…`);
    res.json({ ok: true, output });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Session stats
app.get('/api/sessions/stats', requireAuth, async (req, res) => {
  try {
    const output = await shell('hermes sessions stats 2>&1');
    res.json({ ok: true, stats: output });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Token usage / insights
app.get('/api/usage/:days', requireAuth, requirePerm('usage.view'), async (req, res) => {
  try {
    const days = Math.min(parseInt(req.params.days || '7', 10), 90);
    const profile = sanitizeProfileName(req.query.profile) || undefined;

    // Determine which state.db paths to query
    let dbPaths = [];
    if (profile) {
      const p = profile !== 'default'
        ? path.join(os.homedir(), '.hermes', 'profiles', profile, 'state.db')
        : path.join(os.homedir(), '.hermes', 'state.db');
      if (!fs.existsSync(p)) return res.json({ ok: false, error: 'state.db not found' });
      dbPaths = [{ profile: profile || 'default', path: p }];
    } else {
      // All profiles
      const profilesDir = path.join(os.homedir(), '.hermes', 'profiles');
      if (fs.existsSync(profilesDir)) {
        for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const dbPath = path.join(profilesDir, entry.name, 'state.db');
          if (fs.existsSync(dbPath)) dbPaths.push({ profile: entry.name, path: dbPath });
        }
      }
      // Include default profile
      const defaultDbPath = path.join(os.homedir(), '.hermes', 'state.db');
      if (fs.existsSync(defaultDbPath)) {
        dbPaths.push({ profile: 'default', path: defaultDbPath });
      }
      if (dbPaths.length === 0) return res.json({ ok: false, error: 'No state.db found' });
    }

    // Aggregate across all DBs
    const modelMap = {};
    const platformMap = {};
    const toolMap = {};
    let totalSessions = 0, totalMessages = 0, totalToolCalls = 0;
    let totalInput = 0, totalOutput = 0, totalCost = 0;

    for (const { path: dbPath } of dbPaths) {
      const db = new Database(dbPath, { readonly: true });
      try {
        const since = `-${days}`;
        const sessions = db.prepare(`
          SELECT model, source, billing_provider,
                 input_tokens, output_tokens, cache_read_tokens,
                 message_count, tool_call_count
          FROM sessions
          WHERE started_at > strftime('%s', 'now', ? || ' days')
        `).all(since);

        for (const s of sessions) {
          const cost = calculateCost(s.model, s.input_tokens || 0, s.output_tokens || 0, s.cache_read_tokens || 0, s.billing_provider);
          const tokens = (s.input_tokens || 0) + (s.output_tokens || 0);

          totalSessions++;
          totalInput += s.input_tokens || 0;
          totalOutput += s.output_tokens || 0;
          totalCost += cost;
          totalMessages += s.message_count || 0;
          totalToolCalls += s.tool_call_count || 0;

          const mKey = s.model || 'unknown';
          if (!modelMap[mKey]) modelMap[mKey] = { name: mKey, sessions: 0, tokens: 0 };
          modelMap[mKey].sessions++;
          modelMap[mKey].tokens += tokens;

          const pKey = s.source || 'unknown';
          if (!platformMap[pKey]) platformMap[pKey] = { name: pKey, sessions: 0, tokens: 0 };
          platformMap[pKey].sessions++;
          platformMap[pKey].tokens += tokens;
        }

        // Top tools
        const tools = db.prepare(`
          SELECT tool_name, COUNT(*) as calls
          FROM messages
          WHERE tool_name IS NOT NULL AND tool_name != ''
            AND timestamp > strftime('%s', 'now', ? || ' days')
          GROUP BY tool_name
          ORDER BY calls DESC
          LIMIT 10
        `).all(since);

        for (const t of (tools || [])) {
          if (!toolMap[t.tool_name]) toolMap[t.tool_name] = { name: t.tool_name, calls: 0 };
          toolMap[t.tool_name].calls += t.calls;
        }
      } finally {
        db.close();
      }
    }

    // Calculate active time (avg session duration)
    let avgDuration = 0;
    for (const { path: dbPath } of dbPaths) {
      const db = new Database(dbPath, { readonly: true });
      try {
        const dur = db.prepare(`
          SELECT AVG(ended_at - started_at) as avg_dur
          FROM sessions
          WHERE started_at > strftime('%s', 'now', ? || ' days') AND ended_at > 0
        `).get(`-${days}`);
        if (dur?.avg_dur) avgDuration += dur.avg_dur;
      } finally {
        db.close();
      }
    }
    avgDuration = dbPaths.length > 0 ? avgDuration / dbPaths.length : 0;

    // Format active time
    const formatDuration = (secs) => {
      if (!secs || secs < 60) return '—';
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };

    const topTools = Object.values(toolMap)
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 5)
      .map(t => ({ ...t, pct: totalToolCalls > 0 ? ((t.calls / totalToolCalls) * 100).toFixed(1) + '%' : '0%' }));

    res.json({
      ok: true,
      sessions: totalSessions,
      messages: totalMessages,
      toolCalls: totalToolCalls,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      totalTokens: totalInput + totalOutput,
      cost: '$' + totalCost.toFixed(2),
      activeTime: formatDuration(avgDuration),
      avgSession: formatDuration(avgDuration),
      period: `${days} days${profile ? ` (${profile})` : ' (all profiles)'}`,
      models: Object.values(modelMap).sort((a, b) => b.tokens - a.tokens),
      platforms: Object.values(platformMap).sort((a, b) => b.sessions - a.sessions),
      topTools,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

function parseInsights(raw) {
  const data = {
    sessions: 0, messages: 0, toolCalls: 0, userMessages: 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: '$0.00',
    activeTime: '', avgSession: '', period: '',
    models: [], platforms: [], topTools: [], activity: {},
    notable: {},
  };
  try {
    // Period
    const periodMatch = raw.match(/Period:\s*(.+)/);
    if (periodMatch) data.period = periodMatch[1].trim();

    // Overview
    const sessionsMatch = raw.match(/Sessions:\s+([\d,]+)/);
    if (sessionsMatch) data.sessions = parseInt(sessionsMatch[1].replace(/,/g, ''), 10);
    const messagesMatch = raw.match(/Messages:\s+([\d,]+)/);
    if (messagesMatch) data.messages = parseInt(messagesMatch[1].replace(/,/g, ''), 10);
    const toolCallsMatch = raw.match(/Tool calls:\s+([\d,]+)/);
    if (toolCallsMatch) data.toolCalls = parseInt(toolCallsMatch[1].replace(/,/g, ''), 10);
    const userMsgMatch = raw.match(/User messages:\s+([\d,]+)/);
    if (userMsgMatch) data.userMessages = parseInt(userMsgMatch[1].replace(/,/g, ''), 10);
    const inputMatch = raw.match(/Input tokens:\s+([\d,]+)/);
    if (inputMatch) data.inputTokens = parseInt(inputMatch[1].replace(/,/g, ''), 10);
    const outputMatch = raw.match(/Output tokens:\s+([\d,]+)/);
    if (outputMatch) data.outputTokens = parseInt(outputMatch[1].replace(/,/g, ''), 10);
    const totalMatch = raw.match(/Total tokens:\s+([\d,]+)/);
    if (totalMatch) data.totalTokens = parseInt(totalMatch[1].replace(/,/g, ''), 10);
    const costMatch = raw.match(/Est\.\s*cost:\s+(\$[\d,.]+)/);
    if (costMatch) data.cost = costMatch[1];
    const activeMatch = raw.match(/Active time:\s+(.+)/);
    if (activeMatch) data.activeTime = activeMatch[1].trim();
    const avgSessionMatch = raw.match(/Avg session:\s+(.+)/);
    if (avgSessionMatch) data.avgSession = avgSessionMatch[1].trim();

    // Models
    const modelsSection = raw.match(/🤖 Models Used[\s\S]*?──+\n([\s\S]*?)(?=\n\s*📱|\n\s*🔧|\n\s*📅|\n\s*🏆|$)/);
    if (modelsSection) {
      const lines = modelsSection[1].trim().split('\n').filter(l => l.trim() && !l.includes('Model'));
      data.models = lines.map(l => {
        const parts = l.trim().split(/\s{2,}/);
        return { name: parts[0]?.trim() || '', sessions: parts[1]?.trim() || '', tokens: parts[2]?.trim() || '', cost: parts[3]?.trim() || '' };
      });
    }

    // Top tools
    const toolsSection = raw.match(/🔧 Top Tools[\s\S]*?──+\n([\s\S]*?)(?=\n\s*📅|\n\s*🏆|$)/);
    if (toolsSection) {
      const lines = toolsSection[1].trim().split('\n').filter(l => l.trim() && !l.includes('Tool'));
      data.topTools = lines.slice(0, 5).map(l => {
        const parts = l.trim().split(/\s{2,}/);
        return { name: parts[0]?.trim() || '', calls: parts[1]?.trim() || '', pct: parts[2]?.trim() || '' };
      });
    }

    // Platforms
    const platSection = raw.match(/📱 Platforms[\s\S]*?──+\n([\s\S]*?)(?=\n\s*🔧|\n\s*📅|\n\s*🏆|$)/);
    if (platSection) {
      const lines = platSection[1].trim().split('\n').filter(l => l.trim() && !l.includes('Platform'));
      data.platforms = lines.map(l => {
        const parts = l.trim().split(/\s{2,}/);
        return { name: parts[0]?.trim() || '', sessions: parts[1]?.trim() || '', messages: parts[2]?.trim() || '', tokens: parts[3]?.trim() || '' };
      });
    }
  } catch {}
  return data;
}

// Daily usage breakdown (for charts) — queries state.db directly
app.get('/api/usage/daily/:days', requireAuth, requirePerm('usage.view'), async (req, res) => {
  try {
    const days = Math.min(parseInt(req.params.days || '7', 10), 90);
    const profile = sanitizeProfileName(req.query.profile);
    const stateDbPath = profile && profile !== 'default'
      ? path.join(os.homedir(), '.hermes', 'profiles', profile, 'state.db')
      : path.join(os.homedir(), '.hermes', 'state.db');

    if (!fs.existsSync(stateDbPath)) {
      return res.json({ ok: false, error: 'state.db not found' });
    }

    const db = new Database(stateDbPath, { readonly: true });
    try {
      const since = `-${days}`;

      // Raw sessions for dynamic cost calculation
      const rawSessions = db.prepare(`
        SELECT
          DATE(started_at, 'unixepoch', 'localtime') as date,
          model,
          source,
          billing_provider,
          input_tokens,
          output_tokens,
          cache_read_tokens,
          message_count,
          tool_call_count
        FROM sessions
        WHERE started_at > strftime('%s', 'now', ? || ' days')
      `).all(since);

      // Calculate costs dynamically and aggregate
      const dailyMap = {};
      const modelMap = {};
      const platformMap = {};
      let totalSessions = 0, totalInput = 0, totalOutput = 0, totalCost = 0;
      let totalMessages = 0, totalToolCalls = 0;

      for (const s of rawSessions) {
        const cost = calculateCost(s.model, s.input_tokens || 0, s.output_tokens || 0, s.cache_read_tokens || 0, s.billing_provider);
        const tokens = (s.input_tokens || 0) + (s.output_tokens || 0);

        // Daily
        if (!dailyMap[s.date]) dailyMap[s.date] = { date: s.date, sessions: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost: 0, messages: 0, tool_calls: 0 };
        const d = dailyMap[s.date];
        d.sessions++; d.input_tokens += s.input_tokens || 0; d.output_tokens += s.output_tokens || 0;
        d.total_tokens += tokens; d.cost += cost; d.messages += s.message_count || 0; d.tool_calls += s.tool_call_count || 0;

        // By model
        const mKey = s.model || 'unknown';
        if (!modelMap[mKey]) modelMap[mKey] = { model: mKey, sessions: 0, total_tokens: 0, cost: 0 };
        modelMap[mKey].sessions++; modelMap[mKey].total_tokens += tokens; modelMap[mKey].cost += cost;

        // By platform
        const pKey = s.source || 'unknown';
        if (!platformMap[pKey]) platformMap[pKey] = { platform: pKey, sessions: 0, total_tokens: 0, cost: 0 };
        platformMap[pKey].sessions++; platformMap[pKey].total_tokens += tokens; platformMap[pKey].cost += cost;

        totalSessions++; totalInput += s.input_tokens || 0; totalOutput += s.output_tokens || 0;
        totalCost += cost; totalMessages += s.message_count || 0; totalToolCalls += s.tool_call_count || 0;
      }

      const daily = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
      const byModel = Object.values(modelMap).sort((a, b) => b.total_tokens - a.total_tokens);
      const byPlatform = Object.values(platformMap).sort((a, b) => b.total_tokens - a.total_tokens);

      // By hour of day
      const byHour = db.prepare(`
        SELECT
          CAST(strftime('%H', started_at, 'unixepoch', 'localtime') AS INTEGER) as hour,
          COUNT(*) as sessions,
          SUM(input_tokens + output_tokens) as total_tokens
        FROM sessions
        WHERE started_at > strftime('%s', 'now', ? || ' days')
        GROUP BY hour
        ORDER BY hour ASC
      `).all(since);

      // Top tools
      const topTools = db.prepare(`
        SELECT tool_name, COUNT(*) as calls
        FROM messages
        WHERE tool_name IS NOT NULL
          AND tool_name != ''
          AND timestamp > strftime('%s', 'now', ? || ' days')
        GROUP BY tool_name
        ORDER BY calls DESC
        LIMIT 10
      `).all(since);

      // Avg duration
      const avgDur = db.prepare(`
        SELECT AVG(ended_at - started_at) as avg_duration
        FROM sessions
        WHERE started_at > strftime('%s', 'now', ? || ' days')
      `).get(since);

      res.json({
        ok: true,
        days,
        daily,
        byModel,
        byPlatform,
        byHour: byHour || [],
        topTools: topTools || [],
        totals: {
          sessions: totalSessions,
          input_tokens: totalInput,
          output_tokens: totalOutput,
          total_tokens: totalInput + totalOutput,
          cost: totalCost,
          messages: totalMessages,
          tool_calls: totalToolCalls,
          avg_duration: avgDur?.avg_duration || 0,
        },
      });
    } finally {
      db.close();
    }
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Create agent (profile)
app.post('/api/profiles/create', requireRole('admin'), requireCsrf, async (req, res) => {
  try {
    const rawName = String(req.body?.name || '').trim();
    const safeName = sanitizeProfileName(rawName);
    if (!safeName) return res.status(400).json({ ok: false, error: 'invalid profile name (allowed: a-z, A-Z, 0-9, _, -)' });
    const cloneArg = req.body?.cloneArg;
    const cloneSource = sanitizeProfileName(req.body?.cloneSource);
    let cmd = `hermes profile create ${safeName}`;
    if (cloneArg === '--clone') cmd += ' --clone';
    else if (cloneArg === '--clone-from' && cloneSource) cmd += ` --clone-from ${cloneSource.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const output = await shell(`${cmd} 2>&1`);
    audit(req.hciUser?.username || 'unknown', req.hciUser?.role || 'unknown', 'PROFILE_CREATE', safeName);
    addNotification('success', `Profile created: ${safeName}`);

    // Auto-inject api_server config for Gateway API chat (after CLI writes config.yaml)
    try {
      const confPath = path.join(HERMES_HOME, 'profiles', safeName, 'config.yaml');
      console.log(`[ProfileCreate] Checking config at: ${confPath}, exists: ${fs.existsSync(confPath)}`);
      if (fs.existsSync(confPath)) {
        let raw = fs.readFileSync(confPath, 'utf8');
        const cfg = yaml.load(raw) || {};
        console.log(`[ProfileCreate] Config loaded, platforms: ${JSON.stringify(cfg.platforms)}`);
        if (!cfg.platforms?.api_server?.enabled) {
          // Find next available port
          const usedPorts = new Set(Object.values(discoverGatewayPorts()));
          let port = 8650;
          while (usedPorts.has(port)) port++;
          // Inject platforms config at top level
          cfg.platforms = cfg.platforms || {};
          cfg.platforms.api_server = {
            enabled: true,
            extra: {
              host: '127.0.0.1',
              port,
              key: GATEWAY_API_KEY,
              cors_origins: resolveCorsOrigins(req),
            },
          };
          fs.writeFileSync(confPath, yaml.dump(cfg, { lineWidth: 120 }));
          console.log(`[ProfileCreate] Injected api_server on port ${port} for ${safeName}`);
          addNotification('info', `Gateway API enabled on port ${port} for ${safeName}`);
        } else {
          console.log(`[ProfileCreate] api_server already enabled for ${safeName}, skipping`);
        }
      }
    } catch (apiErr) {
      console.error(`[ProfileCreate] Gateway API setup failed for ${safeName}:`, apiErr.message);
      addNotification('warning', `Profile created but Gateway API setup failed: ${apiErr.message}`);
    }

    // Install gateway service (after config is finalized with api_server)
    try {
      await shell(`bash /root/projects/hci-staging/scripts/setup-gateway-service.sh --profile ${safeName} --user root --force 2>&1`, '30s');
    } catch {}
    // Refresh port discovery
    gatewayPorts = discoverGatewayPorts();

    // Invalidate cache
    getProfiles.cache = { at: 0, data: [] };
    res.json({ ok: true, output });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Delete agent (profile)
app.delete('/api/profiles/:name', requireRole('admin'), requireCsrf, async (req, res) => {
  try {
    const name = sanitizeProfileName(req.params.name);
    if (!name) return res.status(400).json({ ok: false, error: 'invalid profile name' });
    if (name === 'default') return res.status(400).json({ ok: false, error: 'Cannot delete default profile' });
    const output = await shell(`hermes profile delete ${name} -y 2>&1`);
    audit(req.hciUser?.username || 'unknown', req.hciUser?.role || 'unknown', 'PROFILE_DELETE', name);
    addNotification('info', `Profile deleted: ${name}`);
    // Clean up gateway service
    try {
      await shell(`systemctl stop hermes-gateway-${name} 2>/dev/null; systemctl disable hermes-gateway-${name} 2>/dev/null; rm -f /etc/systemd/system/hermes-gateway-${name}.service; systemctl daemon-reload 2>&1`, '10s');
      console.log(`[ProfileDelete] Cleaned up gateway service for ${name}`);
    } catch {}
    // Refresh port discovery
    gatewayPorts = discoverGatewayPorts();
    // Invalidate cache
    getProfiles.cache = { at: 0, data: [] };
    res.json({ ok: true, output });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Agent insights (per profile)
app.get('/api/insights/:profile/:days', requireAuth, requirePerm('usage.view'), async (req, res) => {
  try {
    const profile = sanitizeProfileName(req.params.profile);
    if (!profile) return res.status(400).json({ ok: false, error: 'invalid profile name' });
    const days = Math.min(parseInt(req.params.days || '7', 10), 90);
    const output = await execHermes(['--profile', profile, 'insights', '--days', String(days)], 60000);
    res.json({ ok: true, output });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ============================================
// Hermes Cron (per-profile)
// ============================================

// Parse hermes cron list output into structured JSON
function parseCronList(raw) {
  const jobs = [];
  const blocks = raw.split(/\n\s*(?=[a-f0-9]{12}\s)/);
  for (const block of blocks) {
    const idMatch = block.match(/^([a-f0-9]{12})\s+\[(\w+)\]/);
    if (!idMatch) continue;
    const nameMatch = block.match(/Name:\s+(.+)/);
    const scheduleMatch = block.match(/Schedule:\s+(.+)/);
    const repeatMatch = block.match(/Repeat:\s+(.+)/);
    const nextMatch = block.match(/Next run:\s+(.+)/);
    const deliverMatch = block.match(/Deliver:\s+(.+)/);
    jobs.push({
      id: idMatch[1],
      status: idMatch[2],
      name: nameMatch?.[1]?.trim() || '',
      schedule: scheduleMatch?.[1]?.trim() || '',
      repeat: repeatMatch?.[1]?.trim() || '',
      nextRun: nextMatch?.[1]?.trim() || '',
      deliver: deliverMatch?.[1]?.trim() || 'local',
    });
  }
  return jobs;
}

// List jobs
app.get('/api/hermes-cron/:profile', requireAuth, async (req, res) => {
  try {
    const profile = sanitizeProfileName(req.params.profile);
    if (!profile) return res.status(400).json({ ok: false, error: 'invalid profile name' });
    const [listRaw, statusRaw] = await Promise.all([
      shell(`hermes -p ${profile} cron list --all 2>&1`, '10s'),
      shell(`hermes -p ${profile} cron status 2>&1`, '10s'),
    ]);
    const jobs = parseCronList(listRaw);
    const schedulerRunning = statusRaw.includes('running') || statusRaw.includes('active');
    res.json({ ok: true, jobs, schedulerRunning, profile });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Create job
app.post('/api/hermes-cron/:profile/create', requireCsrf, async (req, res) => {
  try {
    const profile = sanitizeProfileName(req.params.profile);
    if (!profile) return res.status(400).json({ ok: false, error: 'invalid profile name' });
    const { schedule, prompt, name, deliver, repeat } = req.body || {};
    if (!schedule) return res.status(400).json({ ok: false, error: 'schedule required' });
    if (prompt && (typeof prompt !== 'string' || prompt.length > 10000)) return res.status(400).json({ ok: false, error: 'invalid prompt (max 10000 chars)' });
    if (name && (typeof name !== 'string' || name.length > 128 || !/^[\w\s.\-:]+$/.test(name))) return res.status(400).json({ ok: false, error: 'invalid name (allowed: a-z, A-Z, 0-9, spaces, . - :, max 128 chars)' });
    const args = ['-p', profile, 'cron', 'create'];
    if (name) args.push('--name', name);
    if (deliver) args.push('--deliver', deliver);
    if (repeat && repeat !== 'forever') args.push('--repeat', String(repeat));
    args.push(schedule);
    if (prompt) args.push(prompt);
    const output = await execHermes(args, 15000);
    const idMatch = output.match(/Created job:\s+([a-f0-9]+)/);
    addNotification('success', `Cron job created: ${name || idMatch?.[1] || schedule}`);
    res.json({ ok: true, output, jobId: idMatch?.[1] });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Pause/Resume/Run/Remove job
app.post('/api/hermes-cron/:profile/:jobId/:action', requireCsrf, async (req, res) => {
  try {
    const profile = sanitizeProfileName(req.params.profile);
    const jobId = req.params.jobId;
    const action = req.params.action;
    if (!profile) return res.status(400).json({ ok: false, error: 'invalid profile name' });
    if (!/^[a-f0-9]+$/.test(jobId)) return res.status(400).json({ ok: false, error: 'invalid job id' });
    if (!['pause', 'resume', 'run', 'remove'].includes(action)) return res.status(400).json({ ok: false, error: 'invalid action' });
    const output = await execHermes(['-p', profile, 'cron', action, jobId], 10000);
    addNotification('info', `Cron ${action}: ${jobId.slice(0, 8)}…`);
    res.json({ ok: true, output });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Cron edit endpoint
app.put('/api/hermes-cron/:profile/:jobId', requireCsrf, async (req, res) => {
  try {
    const profile = sanitizeProfileName(req.params.profile);
    const jobId = req.params.jobId;
    if (!profile) return res.status(400).json({ ok: false, error: 'invalid profile name' });
    if (!/^[a-f0-9]+$/.test(jobId)) return res.status(400).json({ ok: false, error: 'invalid job id' });
    const { schedule, prompt, name, deliver, repeat } = req.body || {};
    const args = ['-p', profile, 'cron', 'edit', jobId];
    if (schedule) args.push('--schedule', schedule);
    if (prompt !== undefined) args.push('--prompt', prompt);
    if (name !== undefined) args.push('--name', name);
    if (deliver !== undefined) args.push('--deliver', deliver);
    if (repeat !== undefined) args.push('--repeat', String(repeat));
    const output = await execHermes(args, 10000);
    res.json({ ok: true, output });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

const server = (() => {
  const sslCert = cfg.ssl.certFile;
  const sslKey = cfg.ssl.keyFile;
  if (sslCert && sslKey) {
    if (!fs.existsSync(sslCert) || !fs.existsSync(sslKey)) {
      console.error(`SSL cert/key not found — cert: ${sslCert}, key: ${sslKey}`);
      console.error('Falling back to HTTP.');
    } else {
      try {
        const server = https.createServer({
          cert: fs.readFileSync(sslCert),
          key: fs.readFileSync(sslKey),
          minVersion: 'TLSv1.2',
        }, app);
        server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
          console.log(`Hermes Control Interface running on https://${process.env.HOST || '127.0.0.1'}:${PORT}`);
          console.log('Password gate: env-secret only');
          console.log(`Identity: ${HCI_IDENTITY}`);
        });
        return server;
      } catch (e) {
        console.error(`SSL setup failed: ${e.message}`);
        console.error('Falling back to HTTP.');
      }
    }
  }
  const server = app.listen(PORT, process.env.HOST || '127.0.0.1', () => {
    console.log(`Hermes Control Interface running on http://${process.env.HOST || '127.0.0.1'}:${PORT}`);
    console.log('Password gate: env-secret only');
    console.log(`Identity: ${HCI_IDENTITY}`);
  });
  return server;
})();

// ── WebSocket Chat Gateway Bridge ──
// Proxies Gateway API /v1/responses via WebSocket for real-time event streaming.
async function handleWsChatStart(socket, msg) {
  const { message, profile, session_id, model } = msg;
  if (!message || typeof message !== 'string') {
    socket.send(JSON.stringify({ type: 'chat.error', error: 'message required' }));
    return;
  }

  const gatewayBase = getGatewayBase(profile || 'default');
  if (!gatewayBase) {
    socket.send(JSON.stringify({ type: 'chat.error', error: 'Gateway API not available for profile: ' + (profile || 'default') }));
    return;
  }

  const gatewayBody = { model: model || getDefaultModel(profile || 'default'), input: message, stream: true };
  const gwHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GATEWAY_API_KEY}` };
  if (session_id) gwHeaders['X-Hermes-Session-Id'] = session_id;

  try {
    const gatewayRes = await fetch(`${gatewayBase}/v1/responses`, {
      method: 'POST', headers: gwHeaders, body: JSON.stringify(gatewayBody),
    });

    if (!gatewayRes.ok) {
      const errText = await gatewayRes.text();
      socket.send(JSON.stringify({ type: 'chat.error', error: `Gateway ${gatewayRes.status}: ${errText}` }));
      return;
    }

    const hermesSessionId = gatewayRes.headers.get('x-hermes-session-id') || '';
    if (hermesSessionId) {
      socket.send(JSON.stringify({ type: 'chat.session', session_id: hermesSessionId }));
    }

    const reader = gatewayRes.body.getReader();
    socket.activeChatReader = reader;
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (socket.readyState !== 1) break; // socket closed
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          const lines = part.split('\n');
          let dataLine = '';
          for (const line of lines) {
            if (line.startsWith('data: ')) dataLine = line.slice(6);
          }
          if (!dataLine) continue;
          try {
            const evt = JSON.parse(dataLine);
            // Transform SSE events to WS chat events
            const wsEvent = transformGatewayEvent(evt);
            if (wsEvent) {
              socket.send(JSON.stringify({ type: 'chat.event', event: wsEvent }));
            }
          } catch {}
        }
      }
    } catch (pipeErr) {
      console.error('[WS Chat] pipe error:', pipeErr.message);
    } finally {
      socket.activeChatReader = null;
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'chat.done' }));
      }
    }
  } catch (e) {
    console.error('[WS Chat] error:', e.message);
    socket.send(JSON.stringify({ type: 'chat.error', error: e.message }));
    socket.activeChatReader = null;
  }
}

function transformGatewayEvent(evt) {
  const t = evt.type;
  // Text streaming
  if (t === 'response.output_text.delta') {
    return { type: 'text.delta', delta: evt.delta || '' };
  }
  // Tool call started
  if (t === 'response.output_item.added') {
    const item = evt.item || {};
    if (item.type === 'function_call' || item.type === 'tool_call') {
      return { type: 'tool.start', call_id: item.call_id || item.id || ('tc_' + Date.now()), name: item.name, arguments: item.arguments || item.args };
    }
  }
  // Tool progress
  if (t === 'hermes.tool.progress') {
    return { type: 'tool.progress', name: evt.name, preview: evt.preview };
  }
  // Tool call done
  if (t === 'response.output_item.done') {
    const item = evt.item || {};
    if (item.type === 'function_call' || item.type === 'tool_call') {
      return { type: 'tool.done', call_id: item.call_id || item.id, result: item.result || item.output || '' };
    }
  }
  // Response completed
  if (t === 'response.completed') {
    return { type: 'response.completed', response_id: evt.response?.id };
  }
  // Session info (injected by HCI)
  if (t === 'hci.session') {
    return { type: 'session', session_id: evt.session_id };
  }
  // Reasoning / thinking
  if (t === 'response.reasoning.delta' || t === 'response.thinking.delta') {
    return { type: 'thinking.delta', delta: evt.delta || evt.text || '' };
  }
  // Status update
  if (t === 'status.update') {
    return { type: 'status', status: evt.status, kind: evt.kind };
  }
  return null;
}

const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: (info, done) => {
    // Strict origin check — exact match with host header
    const origin = info.req.headers.origin || '';
    const host = info.req.headers.host || '';
    if (!origin) {
      // Allow requests without Origin header (same-origin fetch, curl, etc.)
      return done(true);
    }
    const expected = [`http://${host}`, `https://${host}`];
    if (expected.includes(origin)) {
      done(true);
    } else {
      log('websocket.rejected', `origin: ${origin}`);
      done(false, 403, 'Forbidden');
    }
  },
});

async function broadcast() {
  const state = await buildDashboardState(true);
  const payload = JSON.stringify({ type: 'snapshot', payload: state });
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.authed) client.send(payload);
  }
}

wss.on('connection', async (socket, req) => {
  socket.authed = isAuthed(req);
  socket.clientId = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  socket.activeChatReader = null; // for cancelling gateway streams
  if (!socket.authed) {
    socket.send(JSON.stringify({ type: 'auth-required', message: 'authentication required' }));
    return;
  }
  const state = await buildDashboardState(true);
  socket.send(JSON.stringify({ type: 'snapshot', payload: state }));
  if (terminalSession.buffer) {
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
  socket.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      if (msg.type === 'terminal-input' && socket.authed) {
        let data = String(msg.data || '');
        if (data.length > 4096) return;
        data = data.replace(/\x1b\[[0-9;]*R/g, '').replace(/;[0-9]+R/g, '');
        if (!data) return;
        const command = data.replace(/[\r\n]+$/g, '');
        if (/^\/cron\s+/i.test(command)) {
          try {
            await maybeHandleSpecialTerminalCommand(command);
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
      // ── Chat via WebSocket (TUI Gateway) ──
      if (msg.type === 'chat.start' && socket.authed) {
        console.log(`[WS] chat.start received profile="${msg.profile || 'default'}" session_id="${msg.session_id || 'null'}"`);
        const bridge = getBridge(msg.profile || 'default');
        if (!bridge.proc) {
          let startErr = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              await bridge.start();
              startErr = null;
              break;
            } catch (e) {
              startErr = e;
              console.error(`[WS] Bridge start attempt ${attempt}/3 failed:`, e.message);
              if (attempt < 3) await new Promise(r => setTimeout(r, 500));
            }
          }
          if (startErr) {
            socket.send(JSON.stringify({ type: 'chat.error', error: 'TUI gateway unavailable after 3 retries. Falling back to CLI mode...' }));
            // Don't return — let frontend fallback to CLI
            // (frontend already has CLI fallback in sendChatMessage)
            return;
          }
        }
        bridge.addClient(socket);
        socket.tuiBridge = bridge;
        try {
          const result = await bridge.chatStart(msg);
          socket.tuiSessionId = result.session_id;
        } catch (err) {
          socket.send(JSON.stringify({ type: 'chat.error', error: err.message }));
        }
      }
      if (msg.type === 'chat.stop' && socket.authed && socket.tuiBridge) {
        socket.tuiBridge.chatStop(socket.tuiSessionId);
      }
      if (msg.type === 'clarify.respond' && socket.authed && socket.tuiBridge) {
        try {
          await socket.tuiBridge.respondClarify(msg.request_id, msg.text, msg.choice);
        } catch (err) {
          socket.send(JSON.stringify({ type: 'chat.error', error: err.message }));
        }
      }
      if (msg.type === 'approval.respond' && socket.authed && socket.tuiBridge) {
        try {
          await socket.tuiBridge.respondApproval(msg.approve, msg.command);
        } catch (err) {
          socket.send(JSON.stringify({ type: 'chat.error', error: err.message }));
        }
      }
      if (msg.type === 'sudo.respond' && socket.authed && socket.tuiBridge) {
        try {
          await socket.tuiBridge.respondSudo(msg.request_id, msg.password);
        } catch (err) {
          socket.send(JSON.stringify({ type: 'chat.error', error: err.message }));
        }
      }
      if (msg.type === 'secret.respond' && socket.authed && socket.tuiBridge) {
        try {
          await socket.tuiBridge.respondSecret(msg.request_id, msg.value);
        } catch (err) {
          socket.send(JSON.stringify({ type: 'chat.error', error: err.message }));
        }
      }
    } catch {}
  });
  socket.on('close', () => {
    if (socket.tuiBridge) {
      socket.tuiBridge.removeClient(socket);
      socket.tuiBridge = null;
    }
    if (socket.activeChatReader) {
      socket.activeChatReader.cancel().catch(() => {});
      socket.activeChatReader = null;
    }
  });
});

// Broadcast only on actual state changes (avatar upload/delete, cron actions).
// No periodic broadcast — clients get updates via WS events and targeted API calls.

log('system.started', 'Hermes Control Interface booted');

// Warm up insights cache in background — so first WebSocket doesn't timeout
getInsights().catch(() => {});

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
  // Kill TUI bridges
  killAllBridges();
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

// Error handlers — prevent silent crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]', reason);
  log('system.error', `unhandled rejection: ${reason?.message || reason}`);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  log('system.error', `uncaught exception: ${err.message}`);
  // Give time to log, then exit
  setTimeout(() => process.exit(1), 1000);
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
