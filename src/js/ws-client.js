/**
 * HCI WebSocket Client
 * Manages connection, auto-reconnect, and event routing.
 */

class HciWsClient extends EventTarget {
  constructor() {
    super();
    this.socket = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.pingInterval = null;
    this.lastPong = 0;
  }

  connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws`;

    try {
      this.socket = new WebSocket(url);
    } catch (e) {
      console.error('[WS] Failed to create socket:', e);
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      console.log('[WS] connected');
      this.connected = true;
      this.reconnectDelay = 1000;
      this.lastPong = Date.now();
      this.startPing();
      this.dispatchEvent(new CustomEvent('open'));
    };

    this.socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'pong') {
          this.lastPong = Date.now();
          return;
        }
        this.dispatchEvent(new CustomEvent('message', { detail: msg }));
      } catch {}
    };

    this.socket.onclose = () => {
      console.log('[WS] disconnected');
      this.connected = false;
      this.stopPing();
      this.dispatchEvent(new CustomEvent('close'));
      this.scheduleReconnect();
    };

    this.socket.onerror = (err) => {
      console.error('[WS] error:', err);
      this.dispatchEvent(new CustomEvent('error', { detail: err }));
    };
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      console.log(`[WS] reconnecting in ${this.reconnectDelay}ms...`);
      this.connect();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    }, this.reconnectDelay);
  }

  startPing() {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'ping' }));
        // If no pong for 30s, force reconnect
        if (Date.now() - this.lastPong > 30000) {
          console.warn('[WS] ping timeout, forcing reconnect');
          this.socket.close();
        }
      }
    }, 10000);
  }

  stopPing() {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
  }

  send(data) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  chatStart({ message, profile, session_id, model }) {
    return this.send({ type: 'chat.start', message, profile, session_id, model });
  }

  chatStop() {
    return this.send({ type: 'chat.stop' });
  }

  clarifyRespond(request_id, text, choice) {
    return this.send({ type: 'clarify.respond', request_id, text, choice });
  }

  approvalRespond(approve, command) {
    return this.send({ type: 'approval.respond', approve, command });
  }

  sudoRespond(request_id, password) {
    return this.send({ type: 'sudo.respond', request_id, password });
  }

  secretRespond(request_id, value) {
    return this.send({ type: 'secret.respond', request_id, value });
  }

  disconnect() {
    this.stopPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.socket) { this.socket.close(); this.socket = null; }
    this.connected = false;
  }
}

// Singleton instance
export const wsClient = new HciWsClient();
