/**
 * HCI TUI Gateway Bridge
 * Spawns python -m tui_gateway.entry, bridges JSON-RPC events to WebSocket clients.
 */

const { spawn } = require('child_process');
const { createInterface } = require('readline');
const path = require('path');
const os = require('os');

const MAX_LOG_LINES = 200;
const MAX_LOG_BYTES = 4096;
const STARTUP_TIMEOUT_MS = 20000;
const REQUEST_TIMEOUT_MS = 120000;

function truncateLine(line) {
  return line.length > MAX_LOG_BYTES ? line.slice(0, MAX_LOG_BYTES) + '…' : line;
}

class TuiGatewayBridge {
  constructor(profile = 'default') {
    this.profile = profile;
    this.proc = null;
    this.clients = new Set(); // WebSocket sockets
    this.ready = false;
    this.reqId = 0;
    this.pending = new Map();
    this.logs = [];
    this.readyTimer = null;
    this.stdoutRl = null;
    this.stderrRl = null;
    this.sessionInfo = null;
    this._readyPromise = null;
    this._readyResolve = null;
    this._readyReject = null;
    this._sidMap = new Map();       // internal TUI sid → canonical DB session_key
    this._canonicalSid = null;      // active canonical session ID
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  start() {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
      console.log(`[TUI:${this.profile}] already running`);
      return this._readyPromise || Promise.resolve();
    }

    const root = process.env.HERMES_PYTHON_SRC_ROOT || '/root/.hermes/hermes-agent';
    const python = this._resolvePython(root);
    const cwd = root;
    const env = { ...process.env };

    // Python path
    const pyPath = env.PYTHONPATH?.trim();
    const delimiter = process.platform === 'win32' ? ';' : ':';
    env.PYTHONPATH = pyPath ? `${root}${delimiter}${pyPath}` : root;

    // Profile-specific env
    env.HERMES_PROFILE = this.profile === 'default' ? '' : this.profile;

    console.log(`[TUI:${this.profile}] spawning: ${python} -m tui_gateway.entry`);

    this.ready = false;
    this.logs = [];
    this.stdoutRl?.close();
    this.stderrRl?.close();

    this._readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });

    this.readyTimer = setTimeout(() => {
      if (!this.ready) {
        this._pushLog(`[startup] timed out waiting for gateway.ready`);
        this._broadcast({ type: 'tui.error', error: 'TUI gateway startup timeout' });
        if (this._readyReject) {
          this._readyReject(new Error('TUI gateway startup timeout'));
          this._readyReject = null;
          this._readyResolve = null;
        }
      }
    }, STARTUP_TIMEOUT_MS);

    this.proc = spawn(python, ['-m', 'tui_gateway.entry'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // stdout → JSON-RPC
    this.stdoutRl = createInterface({ input: this.proc.stdout });
    this.stdoutRl.on('line', (raw) => {
      try {
        const msg = JSON.parse(raw);
        this._dispatch(msg);
      } catch {
        const preview = raw.trim().slice(0, 240) || '(empty)';
        this._pushLog(`[protocol] malformed stdout: ${preview}`);
        this._broadcast({ type: 'tui.protocol_error', preview });
      }
    });

    // stderr → logs
    this.stderrRl = createInterface({ input: this.proc.stderr });
    this.stderrRl.on('line', (raw) => {
      const line = truncateLine(raw.trim());
      if (!line) return;
      this._pushLog(line);
      this._broadcast({ type: 'tui.stderr', line });
    });

    this.proc.on('error', (err) => {
      console.error(`[TUI:${this.profile}] spawn error:`, err.message);
      this._rejectPending(new Error(`spawn error: ${err.message}`));
      this._broadcast({ type: 'tui.error', error: err.message });
      if (this._readyReject) {
        this._readyReject(new Error(`spawn error: ${err.message}`));
        this._readyReject = null;
        this._readyResolve = null;
      }
    });

    this.proc.on('exit', (code) => {
      if (this.readyTimer) {
        clearTimeout(this.readyTimer);
        this.readyTimer = null;
      }
      this.ready = false;
      console.log(`[TUI:${this.profile}] exited (${code})`);
      this._rejectPending(new Error(`gateway exited${code === null ? '' : ` (${code})`}`));
      this._broadcast({ type: 'tui.exit', code });
      if (this._readyReject) {
        this._readyReject(new Error(`gateway exited${code === null ? '' : ` (${code})`}`));
        this._readyReject = null;
        this._readyResolve = null;
      }
    });

    return this._readyPromise;
  }

  kill() {
    this.stdoutRl?.close();
    this.stderrRl?.close();
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.proc && !this.proc.killed) {
      this.proc.kill();
    }
    this.proc = null;
    this.ready = false;
    this._rejectPending(new Error('gateway killed'));
  }

  // ── JSON-RPC Dispatch ──────────────────────────────────────────────

  _dispatch(msg) {
    const id = msg.id;
    const p = id ? this.pending.get(id) : undefined;

    if (p) {
      // Response to pending request
      this._settle(p, msg.error ? new Error(msg.error.message || 'request failed') : null, msg.result);
      return;
    }

    if (msg.method === 'event') {
      const ev = msg.params;
      if (ev && typeof ev === 'object' && typeof ev.type === 'string') {
        if (ev.type === 'gateway.ready') {
          this.ready = true;
          if (this.readyTimer) {
            clearTimeout(this.readyTimer);
            this.readyTimer = null;
          }
          console.log(`[TUI:${this.profile}] gateway.ready`);
          if (this._readyResolve) {
            this._readyResolve();
            this._readyResolve = null;
            this._readyReject = null;
          }
        }
        if (ev.type === 'session.info') {
          this.sessionInfo = ev.payload;
        }
        this._broadcast(this._transformEvent(ev));
      }
    }
  }

  _settle(p, err, result) {
    clearTimeout(p.timeout);
    this.pending.delete(p.id);
    if (err) p.reject(err);
    else p.resolve(result);
  }

  _rejectPending(err) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timeout);
      p.reject(err);
    }
    this.pending.clear();
  }

  // ── Requests ───────────────────────────────────────────────────────

  request(method, params = {}) {
    if (!this.proc?.stdin || this.proc.killed || this.proc.exitCode !== null) {
      return Promise.reject(new Error('TUI gateway not running'));
    }

    const id = `r${++this.reqId}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          pending.reject(new Error(`timeout: ${method}`));
        }
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { id, method, reject, resolve, timeout });

      try {
        const line = JSON.stringify({ id, jsonrpc: '2.0', method, params }) + '\n';
        this.proc.stdin.write(line);
      } catch (e) {
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(id);
        }
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  // ── Event Transformation ───────────────────────────────────────────

  _transformEvent(ev) {
    const t = ev.type;
    const payload = ev.payload || {};
    let sessionId = ev.session_id || '';

    // Map internal TUI sid to canonical DB session_key
    if (sessionId && this._sidMap.has(sessionId)) {
      sessionId = this._sidMap.get(sessionId);
    } else if (!sessionId && this._canonicalSid) {
      sessionId = this._canonicalSid;
    }

    // Map TUI events to HCI WS events
    switch (t) {
      case 'gateway.ready':
        return { type: 'tui.ready', session_id: sessionId, skin: payload.skin };

      case 'session.info':
        return { type: 'chat.session', session_id: sessionId, info: payload };

      case 'thinking.delta':
        return { type: 'chat.thinking', session_id: sessionId, delta: payload.text || '' };

      case 'reasoning.delta':
      case 'reasoning.available':
        return { type: 'chat.reasoning', session_id: sessionId, delta: payload.text || '' };

      case 'message.start':
        return { type: 'chat.start', session_id: sessionId };

      case 'message.delta':
        return { type: 'chat.text', session_id: sessionId, delta: payload.text || '', rendered: payload.rendered };

      case 'message.complete':
        return { type: 'chat.done', session_id: sessionId, text: payload.text, reasoning: payload.reasoning, usage: payload.usage };

      case 'status.update':
        return { type: 'chat.status', session_id: sessionId, status: payload.status, kind: payload.kind };

      case 'tool.generating':
        return { type: 'chat.tool.generating', session_id: sessionId, name: payload.name };

      case 'tool.start':
        return { type: 'chat.tool.start', session_id: sessionId, tool_id: payload.tool_id, name: payload.name, context: payload.context };

      case 'tool.progress':
        return { type: 'chat.tool.progress', session_id: sessionId, name: payload.name, preview: payload.preview };

      case 'tool.complete':
        return { type: 'chat.tool.done', session_id: sessionId, tool_id: payload.tool_id, name: payload.name, summary: payload.summary, error: payload.error, inline_diff: payload.inline_diff };

      case 'clarify.request':
        return { type: 'chat.clarify', session_id: sessionId, question: payload.question, choices: payload.choices, request_id: payload.request_id };

      case 'approval.request':
        return { type: 'chat.approval', session_id: sessionId, command: payload.command, description: payload.description };

      case 'sudo.request':
        return { type: 'chat.sudo', session_id: sessionId, request_id: payload.request_id };

      case 'secret.request':
        return { type: 'chat.secret', session_id: sessionId, env_var: payload.env_var, prompt: payload.prompt, request_id: payload.request_id };

      case 'subagent.spawn_requested':
      case 'subagent.start':
      case 'subagent.thinking':
      case 'subagent.tool':
      case 'subagent.progress':
      case 'subagent.complete':
        return { type: `chat.${t}`, session_id: sessionId, payload };

      case 'error':
        return { type: 'chat.error', session_id: sessionId, error: payload.message || 'Unknown error' };

      default:
        // Passthrough unknown events
        return { type: `tui.${t}`, session_id: sessionId, payload };
    }
  }

  // ── WebSocket Broadcast ────────────────────────────────────────────

  addClient(socket) {
    this.clients.add(socket);
    // Send buffered logs if any
    if (this.logs.length > 0) {
      socket.send(JSON.stringify({ type: 'tui.logs', lines: this.logs.slice(-20) }));
    }
  }

  removeClient(socket) {
    this.clients.delete(socket);
  }

  _broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const socket of this.clients) {
      if (socket.readyState === 1) { // WebSocket.OPEN
        try {
          socket.send(data);
        } catch (e) {
          // Ignore send errors
        }
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  _pushLog(line) {
    this.logs.push(truncateLine(line));
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs.shift();
    }
  }

  _resolvePython(root) {
    const configured = process.env.HERMES_PYTHON?.trim() || process.env.PYTHON?.trim();
    if (configured) return configured;

    const venv = process.env.VIRTUAL_ENV?.trim();
    const candidates = [
      venv && path.resolve(venv, 'bin/python'),
      venv && path.resolve(venv, 'bin/python3'),
      path.resolve(root, '.venv/bin/python'),
      path.resolve(root, '.venv/bin/python3'),
      path.resolve(root, 'venv/bin/python'),
      path.resolve(root, 'venv/bin/python3'),
      'python3',
      'python',
    ];
    for (const p of candidates) {
      if (p) return p;
    }
    return 'python3';
  }

  // ── High-level Chat API ────────────────────────────────────────────

  async chatStart({ message, session_id, model }) {
    if (!this.ready) {
      throw new Error('TUI gateway not ready');
    }

    let canonicalSid = session_id || null;
    let internalSid;

    if (!canonicalSid) {
      console.log(`[TUI:${this.profile}] session.create (new chat)`);
      const result = await this.request('session.create', { model: model || undefined });
      internalSid = result.session_id;
      canonicalSid = result.session_key || internalSid;
      this._sidMap.set(internalSid, canonicalSid);
      this._canonicalSid = canonicalSid;
    } else {
      // canonicalSid bisa jadi DB ID (dari frontend) atau internal sid lama
      try {
        console.log(`[TUI:${this.profile}] session.resume(${canonicalSid})`);
        const result = await this.request('session.resume', { session_id: canonicalSid });
        internalSid = result.session_id;
        const resumedId = result.resumed || canonicalSid;
        this._sidMap.set(internalSid, resumedId);
        this._canonicalSid = resumedId;
        canonicalSid = resumedId;
        console.log(`[TUI:${this.profile}] session.resume OK → ${resumedId}`);
      } catch (err) {
        console.log(`[TUI:${this.profile}] session.resume FAILED (${err.message}), creating new session`);
        const result = await this.request('session.create', { model: model || undefined });
        internalSid = result.session_id;
        canonicalSid = result.session_key || internalSid;
        this._sidMap.set(internalSid, canonicalSid);
        this._canonicalSid = canonicalSid;
      }
    }

    await this.request('prompt.submit', { session_id: internalSid, text: message });
    return { session_id: canonicalSid };
  }

  async chatStop(session_id) {
    if (!session_id) return;
    try {
      await this.request('session.interrupt', { session_id });
    } catch {
      // Ignore
    }
  }

  async respondClarify(request_id, text, choice) {
    return this.request('clarify.respond', { request_id, text, choice });
  }

  async respondApproval(approve, command) {
    return this.request('approval.respond', { approve, command });
  }

  async respondSudo(request_id, password) {
    return this.request('sudo.respond', { request_id, password });
  }

  async respondSecret(request_id, value) {
    return this.request('secret.respond', { request_id, value });
  }
}

// Profile-scoped bridges
const bridges = new Map();

function getBridge(profile = 'default') {
  if (!bridges.has(profile)) {
    bridges.set(profile, new TuiGatewayBridge(profile));
  }
  return bridges.get(profile);
}

function killAllBridges() {
  for (const [profile, bridge] of bridges) {
    console.log(`[TUI] killing bridge for ${profile}`);
    bridge.kill();
  }
  bridges.clear();
}

module.exports = { TuiGatewayBridge, getBridge, killAllBridges };
