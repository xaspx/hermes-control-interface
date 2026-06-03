import { state, t, wsClient } from '../core/state.js';;
import { sendChatMessage } from './core.js';
import { finalizeWsChat, showChatWarning } from './gateway.js';

async function sendViaWebSocket(text, profile, sessionId) {
  return new Promise((resolve, reject) => {
    const messagesDiv = document.getElementById('chat-messages');
    if (!messagesDiv) { reject(new Error('No chat container')); return; }

    // User message ALREADY added by sendChatMessage() — don't add again
    state._chatStartTime = Date.now();
    state._wsToolCards = new Map();

    // Use the streaming element created by sendChatMessage()
    let streamEl = document.getElementById('chat-streaming');
    if (!streamEl) {
      // Fallback: create if missing
      streamEl = document.createElement('div');
      streamEl.id = 'chat-streaming';
      streamEl.className = 'chat-msg msg-assistant';
      streamEl.innerHTML = '<div class="msg-header"><span class="msg-header-label" data-i18n="auto.assistant">🤖 Assistant</span></div><div class="msg-body"><span id="gw-stream-text"></span></div>';
      messagesDiv.appendChild(streamEl);
    }
    messagesDiv.scrollTop = messagesDiv.scrollHeight;

    // Show stop button, hide send
    const stopBtn = document.getElementById('chat-stop-btn');
    const sendBtn = document.getElementById('chat-send-btn');
    if (stopBtn) stopBtn.style.display = '';
    if (sendBtn) sendBtn.style.display = 'none';

    // One-time listener for completion
    function onDone(ev) {
      const msg = ev.detail;
      if (msg.type === 'chat.done') {
        wsClient.removeEventListener('message', onDone);
        finalizeWsChat();
        resolve();
      } else if (msg.type === 'chat.error') {
        wsClient.removeEventListener('message', onDone);
        // Recoverable — CLI fallback will handle this
        showChatWarning(msg.error);
        reject(new Error(msg.error));
      }
    }
    wsClient.addEventListener('message', onDone);

    // Send via WS — use chatStart for first message, chatSend for subsequent
    let ok;
    if (sessionId) {
      ok = wsClient.chatSend({ message: text, session_id: sessionId });
    } else {
      ok = wsClient.chatStart({ message: text, profile, session_id: sessionId });
    }
    if (!ok) {
      wsClient.removeEventListener('message', onDone);
      reject(new Error('WebSocket not connected'));
    }
  });
}

export { sendViaWebSocket };
