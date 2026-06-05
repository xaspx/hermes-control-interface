import { state, t, wsClient } from '../core/state.js';;
import { addToolCallCard, finalizeToolCard, highlightCodeBlocks, renderChatContent, swapOptimisticMessage, updateStreamContent, updateToolProgress } from './cli.js';
import { handleArtifact, playChatComplete, refreshChatSidebar, reloadCurrentSessionMessages, sendChatMessage, updateChatHeader, updateQueueBadge, updateToolCountUI } from './core.js';
import { showModal } from '../components/modal.js';
import { escapeHtml } from '../core/utils.js';

async function sendViaGatewayAPI(text, profile, sessionId, contentDiv, messagesDiv, startTime) {
  const toolCards = new Map();
  const bodyObj = { message: text, profile, stream: true };
  if (sessionId) bodyObj.session_id = sessionId;

  const response = await fetch('/api/gateway/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
    credentials: 'include',
    body: JSON.stringify(bodyObj),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gateway ${response.status}: ${err}`);
  }

  // Try to get session ID from response header first
  const headerSessionId = response.headers.get('x-hermes-session-id') || '';
  if (headerSessionId && !state._currentChatSession) state._currentChatSession = headerSessionId;

  // Set up stop button
  const stopBtn = document.getElementById('chat-stop-btn');
  state._currentAbortController = null; // we use reader.cancel() instead

  let fullContent = '';
  let fullReasoning = '';
  const reader = response.body.getReader();
  state._currentStreamReader = reader; // for stop button
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on double-newline (SSE boundary)
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
          handleGatewayEvent(evt, contentDiv, messagesDiv, toolCards);
          if (evt.type === 'hci.session' && evt.session_id && !state._currentChatSession) {
            state._currentChatSession = evt.session_id;
          }
          if (evt.type === 'response.output_text.delta') {
            fullContent += evt.delta || '';
          }
        } catch (e) { /* skip */ }
      }
    }
  } catch (readErr) {
    // User cancelled or connection error
    console.log('[Chat] stream ended:', readErr.message);
  }

  // Finalize — remove cursor, show elapsed
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const elapsedEl = document.getElementById('chat-status-elapsed');
  if (elapsedEl) elapsedEl.textContent = elapsed + 's';
  state._currentStreamReader = null;

  // Reload messages from DB to get clean, properly rendered messages
  // (same as loading a session — ensures streaming view matches final view)
  if (state._currentChatSession) {
    await reloadCurrentSessionMessages();
  }

  await refreshChatSidebar();
  updateChatHeader();
}

function handleGatewayEvent(evt, contentDiv, messagesDiv, toolCards) {
  const t = evt.type;
  if (t === 'response.output_text.delta') {
    updateStreamContent(contentDiv, null, toolCards, messagesDiv);
  } else if (t === 'response.output_item.added') {
    const item = evt.item || {};
    if (item.type === 'function_call' || item.type === 'tool_call') {
      const callId = item.call_id || item.id || ('tc_' + Date.now());
      const cardEl = addToolCallCard(contentDiv, callId, item.name, item.arguments || item.args);
      toolCards.set(callId, cardEl);
      if (messagesDiv) messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
  } else if (t === 'response.function_call_arguments.delta' || t === 'response.tool_call_arguments.delta') {
    // Accumulate arguments for current tool call — update preview
  } else if (t === 'hermes.tool.progress') {
    updateToolProgress(toolCards, evt.name, evt.preview);
  } else if (t === 'response.output_item.done') {
    const item = evt.item || {};
    if (item.type === 'function_call' || item.type === 'tool_call') {
      const callId = item.call_id || item.id;
      const result = item.result || item.output || '';
      finalizeToolCard(toolCards, callId, result);
      if (messagesDiv) messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
  } else if (t === 'response.completed') {
    if (evt.response?.id) {
      // Don't overwrite session_id from hci.session or header
      if (!state._currentChatSession) state._currentChatSession = evt.response.id;
    }
  } else if (t === 'artifact.created') {
    handleArtifact(evt.artifact || evt);
  } else if (t === 'artifact.chunk') {
    // Accumulate artifact chunks — append to latest artifact card
    const messagesDiv = document.getElementById('chat-messages');
    const lastArtifact = messagesDiv?.querySelector('.artifact-card:last-of-type');
    if (lastArtifact) {
      const contentEl = lastArtifact.querySelector('.artifact-content');
      if (contentEl && evt.chunk) {
        contentEl.textContent = (contentEl.textContent || '') + evt.chunk;
      }
    }
  } else if (t === 'subagent.completed' || t === 'chat.subagent.done') {
    handleSubagentEvent('done', evt.payload || evt);
  }
}

function setupWsChatHandlers() {
  wsClient.addEventListener('message', (ev) => {
    const msg = ev.detail;
    switch (msg.type) {
      case 'chat.thinking':
        handleThinkingDelta(msg.delta);
        break;
      case 'chat.reasoning':
        handleReasoningDelta(msg.delta);
        break;
      case 'chat.start':
        handleMessageStart();
        break;
      case 'chat.text':
        handleTextDelta(msg.delta);
        break;
      case 'chat.status':
        handleStatusUpdate(msg.status, msg.kind);
        break;
      case 'chat.tool.generating':
        handleToolGenerating(msg.name);
        break;
      case 'chat.tool.start':
        handleToolStart(msg.tool_id, msg.name, msg.context);
        break;
      case 'chat.tool.progress':
        handleToolProgress(msg.name, msg.preview);
        break;
      case 'chat.tool.done':
        handleToolDone(msg.tool_id, msg.name, msg.summary, msg.error, msg.inline_diff);
        break;
      case 'chat.artifact':
        handleArtifact(msg.artifact || msg);
        break;
      case 'chat.session':
        if (!state._currentChatSession) state._currentChatSession = msg.session_id;
        state._sessionInfo = msg.info;
        swapOptimisticMessage(msg.session_id);
        updateChatHeader();
        break;
      case 'chat.done':
        finalizeWsChat();
        break;
      case 'chat.error':
        // Bridge errors are recoverable — CLI fallback handles it.
        // Show as warning, not fatal error.
        showChatWarning(msg.error);
        break;
      case 'chat.clarify':
        showClarifyModal(msg.question, msg.choices, msg.request_id);
        break;
      case 'chat.approval':
        showApprovalModal(msg.command, msg.description);
        break;
      case 'chat.sudo':
        showSudoModal(msg.request_id);
        break;
      case 'chat.secret':
        showSecretModal(msg.env_var, msg.prompt, msg.request_id);
        break;
      case 'chat.subagent.start':
      case 'chat.subagent.progress':
      case 'chat.subagent.complete':
        handleSubagentEvent(msg.type, msg.payload);
        break;
      case 'tui.ready':
        console.log('[TUI] Gateway ready');
        break;
      case 'tui.stderr':
        // Surface actionable TUI messages; filter routine noise
        if (msg.line && !/(?:INFO|DEBUG|^\s*$)/.test(msg.line)) {
          showChatWarning(msg.line);
        }
        break;
      case 'tui.error':
        showChatError('TUI gateway error: ' + (msg.error || 'unknown'));
        break;
    }
  });
}

function handleThinkingDelta(delta) {
  const messagesDiv = document.getElementById('chat-messages');
  if (!messagesDiv) return;
  const panel = ensureThinkingPanel(messagesDiv);
  const textEl = panel.querySelector('.thinking-text');
  if (textEl) {
    textEl.textContent += delta;
    panel.scrollTop = panel.scrollHeight;
  }
}

function handleReasoningDelta(delta) {
  // Same as thinking for now
  handleThinkingDelta(delta);
}

function handleMessageStart() {
  hideThinkingPanel();
  const messagesDiv = document.getElementById('chat-messages');
  if (!messagesDiv) return;
  let streamEl = document.getElementById('chat-streaming');
  if (!streamEl) {
    streamEl = document.createElement('div');
    streamEl.id = 'chat-streaming';
    streamEl.className = 'chat-msg msg-assistant chat-streaming';
    streamEl.innerHTML = '<div class="msg-header"><span class="msg-header-label" data-i18n="auto.assistant">🤖 Assistant</span></div><div class="msg-body"><span id="gw-stream-text"></span><span class="chat-cursor" style="animation:blink 1s infinite;">▊</span></div>';
    messagesDiv.appendChild(streamEl);
  }
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function handleTextDelta(delta) {
  const messagesDiv = document.getElementById('chat-messages');
  if (!messagesDiv) return;
  // Re-query each time — streaming element may have been replaced by
  // reloadCurrentSessionMessages() between callback invocations.
  const streamEl = document.getElementById('chat-streaming');
  if (!streamEl || !document.contains(streamEl)) return;
  const body = streamEl.querySelector('.msg-body');
  if (!body) return;
  let span = body.querySelector('#gw-stream-text');
  const cursor = body.querySelector('.chat-cursor');
  if (!span) {
    span = document.createElement('span');
    span.id = 'gw-stream-text';
    // Guard: cursor may have been removed by reloadCurrentSessionMessages
    if (cursor && body.contains(cursor)) {
      body.insertBefore(span, cursor);
    } else {
      body.appendChild(span);
    }
  }
  // Smart delta: handle both cumulative and incremental deltas
  // Cumulative deltas include all previous text (Hermes TUI gateway behavior)
  // Incremental deltas only include the new portion
  const currentText = span.textContent || '';
  if (delta.startsWith(currentText) && delta.length > currentText.length) {
    // Cumulative delta — replace, keeping only the new portion
    span.textContent = delta;
  } else if (currentText && delta.startsWith(currentText.substring(currentText.lastIndexOf(' ') + 1))) {
    // Edge case: last word boundary — replace full
    span.textContent = currentText.substring(0, currentText.lastIndexOf(' ') + 1) + delta;
  } else {
    // Incremental delta — append
    span.textContent = currentText + delta;
  }
  // Remove cursor if it got absorbed into textContent
  if (cursor && !body.contains(cursor)) {
    const newCursor = document.createElement('span');
    newCursor.className = 'chat-cursor';
    newCursor.style.cssText = 'animation:blink 1s infinite;';
    newCursor.textContent = '▊';
    body.appendChild(newCursor);
  }
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function handleStatusUpdate(status, kind) {
  const statusEl = document.getElementById('chat-status-bar');
  if (statusEl) {
    const sessionSpan = statusEl.querySelector('#chat-status-session');
    if (sessionSpan) sessionSpan.textContent = status || '';
  }
  // Also update a global status indicator
  const indicator = document.getElementById('agent-status-indicator');
  if (indicator) {
    indicator.textContent = status || 'ready';
    indicator.className = `status-${kind || 'idle'}`;
  }
}

function handleToolGenerating(name) {
  // Tool schema being generated — show subtle indicator
  console.log('[Tool] Generating:', name);
}

function handleToolStart(toolId, name, context) {
  hideThinkingPanel();
  const tc = ensureToolCards();
  const messagesDiv = document.getElementById('chat-messages');
  const streamEl = document.getElementById('chat-streaming');
  // Guard: if streaming element is no longer in the DOM (e.g. replaced by
  // finalizeWsChat or a new message cycle), skip tool card insertion.
  // The messages will be reloaded from DB when the stream finalizes.
  if (!streamEl || !document.contains(streamEl)) return;
  const targetDiv = streamEl.querySelector('.msg-body');
  if (!targetDiv || !document.contains(targetDiv)) return;
  const card = addToolCallCard(targetDiv, toolId, name, context);
  tc.set(toolId, card);
  if (messagesDiv) messagesDiv.scrollTop = messagesDiv.scrollHeight;
  // Live tool count indicator
  state._wsToolCount = (state._wsToolCount || 0) + 1;
  updateToolCountUI();
}

function handleToolProgress(name, preview) {
  const tc = ensureToolCards();
  for (const [id, el] of tc) {
    // Guard: skip if card is no longer in DOM (orphaned by finalizeWsChat)
    if (!document.contains(el)) continue;
    const previewEl = el.querySelector('.tool-card-preview');
    if (previewEl && preview) previewEl.textContent = preview;
  }
}

function handleToolDone(toolId, name, summary, error, inlineDiff) {
  const tc = ensureToolCards();
  const card = tc.get(toolId);
  if (!card) return; // card already removed (e.g. by finalizeWsChat)
  // Guard: if the card is no longer in the DOM (streaming element replaced),
  // skip DOM update — messages will be reloaded from DB.
  if (!document.contains(card)) return;
  const streamEl = document.getElementById('chat-streaming');
  if (!streamEl || !document.contains(streamEl)) return;
  const statusEl = card.querySelector('.tool-card-status');
  if (statusEl) {
    statusEl.textContent = error ? 'error' : 'done';
    statusEl.className = `tool-card-status ${error ? 'error' : 'done'}`;
  }
  const resultEl = card.querySelector('.tool-card-result');
  if (resultEl) {
    let resultText = error || '';
    if (!error && inlineDiff) {
      resultText = inlineDiff;
    } else if (!error && summary) {
      resultText = summary;
    }
    // 4000-char truncation with expand-on-click
    if (resultText.length > 4000) {
      resultEl.innerHTML = `
        <pre class="tool-result-truncated">${escapeHtml(resultText.substring(0, 4000))}</pre>
        <button class="tool-expand-btn" onclick="this.previousElementSibling.classList.toggle('tool-result-truncated'); this.previousElementSibling.classList.toggle('tool-result-full'); this.textContent = this.previousElementSibling.classList.contains('tool-result-full') ? 'Show less' : 'Show more (${(resultText.length - 4000).toLocaleString()} more chars)';">Show more (${(resultText.length - 4000).toLocaleString()} more chars)</button>`;
      resultEl.classList.add('has-expand');
    } else {
      resultEl.innerHTML = `<pre>${escapeHtml(resultText)}</pre>`;
    }
  }
  tc.delete(toolId);
  // Decrement live tool count
  state._wsToolCount = Math.max(0, (state._wsToolCount || 1) - 1);
  updateToolCountUI();
}

function handleSubagentEvent(type, payload) {
  // Show panel if hidden
  const panel = document.getElementById('subagent-panel');
  if (panel) panel.style.display = '';
  
  const id = payload.subagent_id;
  let el = document.getElementById(`subagent-${id}`);
  
  if (type === 'chat.subagent.start') {
    if (!el) {
      el = document.createElement('div');
      el.id = `subagent-${id}`;
      el.className = 'subagent-item';
      panel.appendChild(el);
    }
    el.innerHTML = `<span class="subagent-status running">●</span> ${escapeHtml(payload.goal?.slice(0, 40) || 'Subagent')} <span class="subagent-model">${escapeHtml(payload.model || '')}</span>`;
  } else if (type === 'chat.subagent.progress') {
    if (el) {
      const progress = payload.iteration ? ` (${payload.iteration}/${payload.tool_count || '?'})` : '';
      el.innerHTML = `<span class="subagent-status running">●</span> ${escapeHtml(payload.goal?.slice(0, 40) || 'Subagent')}${progress}`;
    }
  } else if (type === 'chat.subagent.complete') {
    if (el) {
      const status = payload.status === 'completed' ? 'completed' : 'failed';
      const icon = payload.status === 'completed' ? '✅' : '❌';
      el.innerHTML = `${icon} ${escapeHtml(payload.goal?.slice(0, 40) || 'Subagent')} <span class="subagent-status ${status}">${escapeHtml(payload.status || '')}</span>`;
      // Auto-remove after 5 seconds
      setTimeout(() => el?.remove(), 5000);
    }
  }
  
  // Hide panel if empty
  if (panel && panel.children.length <= 1) {
    panel.style.display = 'none';
  }
}

// The four agent-prompted modals use showModal's {message, inputs, buttons}
// shape from src/js/components/modal.js. A null result (click-outside or
// Cancel) sends a negative response so the agent unblocks and the chat
// lock clears naturally via chat.done/chat.error.
async function showClarifyModal(question, choices, requestId) {
  if (!choices || choices.length === 0) {
    const result = await showModal({
      title: 'Clarification Needed',
      message: `<p>${escapeHtml(question)}</p>`,
      inputs: [{ type: 'text', placeholder: 'Your answer...' }],
      buttons: [
        { text: 'Cancel', value: null },
        { text: 'Submit', primary: true, value: 'ok' },
      ],
    });
    if (!result || result.action === null) {
      wsClient.clarifyRespond(requestId, '');
    } else {
      wsClient.clarifyRespond(requestId, result.inputs?.[0] || '');
    }
  } else {
    const result = await showModal({
      title: 'Clarification Needed',
      message: `<p>${escapeHtml(question)}</p>`,
      buttons: choices.map(c => ({ text: c, value: c })),
    });
    if (!result) {
      wsClient.clarifyRespond(requestId, null, null);
    } else {
      wsClient.clarifyRespond(requestId, null, result.action);
    }
  }
}

async function showApprovalModal(command, description) {
  const result = await showModal({
    title: 'Approval Required',
    message: `
      <p>${escapeHtml(description || 'The agent wants to run a command:')}</p>
      <pre style="margin-top:12px;padding:12px;background:var(--bg-dark);border-radius:8px;overflow-x:auto;"><code>${escapeHtml(command)}</code></pre>
    `,
    buttons: [
      { text: '❌ Deny', value: false },
      { text: '✅ Approve', primary: true, value: true },
    ],
  });
  if (result?.action === true) {
    wsClient.approvalRespond(true, command);
  } else {
    wsClient.approvalRespond(false, command);
  }
}

async function showSudoModal(requestId) {
  const result = await showModal({
    title: 'Sudo Password Required',
    message: '<p data-i18n="auto.theAgentNeedsSudoPrivilegesEnterYourPassword">The agent needs sudo privileges. Enter your password:</p>',
    inputs: [{ type: 'password', placeholder: 'Password' }],
    buttons: [
      { text: 'Cancel', value: null },
      { text: 'Submit', primary: true, value: 'ok' },
    ],
  });
  const password = (result && result.action !== null) ? (result.inputs?.[0] || '') : '';
  wsClient.sudoRespond(requestId, password);
}

async function showSecretModal(envVar, prompt, requestId) {
  const result = await showModal({
    title: `Secret Required: ${escapeHtml(envVar)}`,
    message: `<p>${escapeHtml(prompt || `Enter value for ${envVar}:`)}</p>`,
    inputs: [{ type: 'password', placeholder: 'Value' }],
    buttons: [
      { text: 'Cancel', value: null },
      { text: 'Submit', primary: true, value: 'ok' },
    ],
  });
  const value = (result && result.action !== null) ? (result.inputs?.[0] || '') : '';
  wsClient.secretRespond(requestId, value);
}

function ensureThinkingPanel(messagesDiv) {
  let panel = document.getElementById('chat-thinking-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'chat-thinking-panel';
    panel.className = 'chat-thinking-panel';
    panel.innerHTML = '<div class="thinking-header" data-i18n="auto.thinking">💭 Thinking</div><div class="thinking-text"></div>';
    // Insert before the streaming message or at the end
    const streamEl = document.getElementById('chat-streaming');
    // Guard: streamEl might have been removed/replaced by reloadCurrentSessionMessages
    // between check and insert. Use contains() for safety.
    if (streamEl && messagesDiv.contains(streamEl)) {
      messagesDiv.insertBefore(panel, streamEl);
    } else {
      messagesDiv.appendChild(panel);
    }
  }
  return panel;
}

function hideThinkingPanel() {
  const panel = document.getElementById('chat-thinking-panel');
  if (panel) panel.style.display = 'none';
}

function ensureToolCards() {
  if (!state._wsToolCards) state._wsToolCards = new Map();
  return state._wsToolCards;
}

function finalizeWsChat() {
  // Guard: prevent double-call race. chat.done fires once from WS,
  // but sendViaWebSocket also calls finalizeWsChat from onDone handler,
  // and the finally block (sendChatMessage) also runs cleanup. Two calls
  // cause reloadCurrentSessionMessages to race and destroy captured text.
  if (state._finalizeInProgress) return;
  state._finalizeInProgress = true;

  state._wsToolCards = null;
  const elapsed = ((Date.now() - (state._chatStartTime || 0)) / 1000).toFixed(1);
  const elapsedEl = document.getElementById('chat-status-elapsed');
  if (elapsedEl) elapsedEl.textContent = elapsed + 's';
  const stopBtn = document.getElementById('chat-stop-btn');
  if (stopBtn) stopBtn.style.display = 'none';
  const sendBtn = document.getElementById('chat-send-btn');
  if (sendBtn) { sendBtn.style.display = ''; sendBtn.disabled = false; sendBtn.textContent = t('ui.send'); }

  // Reset status indicator
  const indicator = document.getElementById('agent-status-indicator');
  if (indicator) {
    indicator.textContent = 'ready';
    indicator.className = 'status-idle';
  }

  // Hide subagent panel after delay
  setTimeout(() => {
    const panel = document.getElementById('subagent-panel');
    if (panel && panel.children.length <= 1) panel.style.display = 'none';
  }, 6000);

  // CAPTURE streaming text BEFORE removing streamEl.
  // chat.done fires BEFORE Hermes finishes writing the final message to SQLite,
  // so reloadCurrentSessionMessages() may miss the streaming content.
  const streamEl = document.getElementById('chat-streaming');
  let capturedText = '';
  if (streamEl) {
    const span = streamEl.querySelector('#gw-stream-text');
    if (span) capturedText = span.textContent || '';
    streamEl.remove();
  }
  // Also remove any orphaned thinking panel
  const thinkEl = document.getElementById('chat-thinking-panel');
  if (thinkEl) thinkEl.remove();

  // Reload from DB for clean final render, then merge captured streaming text
  // in case the final message hadn't been written to DB yet.
  if (state._currentChatSession) {
    reloadCurrentSessionMessages().then(() => {
      // Merge captured streaming text if the DB didn't persist the response in time.
      // chat.done fires before Hermes writes to SQLite, so two cases arise:
      //   1. DB wrote an empty assistant entry → fill its body
      //   2. DB hasn't written the response yet → last element is the user message → append a new assistant bubble
      if (capturedText) {
        const messagesDiv = document.getElementById('chat-messages');
        if (messagesDiv) {
          const lastAssistant = messagesDiv.querySelector('.msg-assistant:last-child');
          const lastBody = lastAssistant?.querySelector('.msg-body');
          if (lastAssistant && lastBody && !lastBody.textContent?.trim()) {
            // Case 1: empty assistant entry in DB
            lastBody.innerHTML = renderChatContent(capturedText.substring(0, 8000));
            highlightCodeBlocks(lastBody);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
          } else if (!lastAssistant) {
            // Case 2: response not in DB yet — show captured streaming text as a placeholder bubble
            const div = document.createElement('div');
            div.className = 'chat-msg msg-assistant';
            const header = document.createElement('div');
            header.className = 'msg-header';
            header.innerHTML = '<span class="msg-header-label">🤖 Assistant</span>';
            const body = document.createElement('div');
            body.className = 'msg-body';
            body.innerHTML = renderChatContent(capturedText.substring(0, 8000));
            div.appendChild(header);
            div.appendChild(body);
            messagesDiv.appendChild(div);
            highlightCodeBlocks(div);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
          }
        }
      }
    }).finally(() => {
      state._finalizeInProgress = false;
    }).catch((e) => {
      state._finalizeInProgress = false;
      console.error('[Chat] reload error:', e);
    });
  } else {
    state._finalizeInProgress = false;
  }
  refreshChatSidebar();
  updateChatHeader();
  state._chatLock = false;
  // Play completion sound if enabled
  playChatComplete();

  // Dequeue pending messages
  if (state._chatQueue && state._chatQueue.length > 0) {
    const next = state._chatQueue.shift();
    updateQueueBadge();
    const input = document.getElementById('chat-input');
    if (input) { input.value = next; input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; }
    setTimeout(() => sendChatMessage(), 300);
  }
}

function showChatError(error) {
  const messagesDiv = document.getElementById('chat-messages');
  if (messagesDiv) {
    messagesDiv.innerHTML += `<div class="chat-msg msg-system"><div class="msg-body" style="color:var(--red)">❌ ${escapeHtml(error)}</div></div>`;
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }
  const stopBtn = document.getElementById('chat-stop-btn');
  if (stopBtn) stopBtn.style.display = 'none';
  const sendBtn = document.getElementById('chat-send-btn');
  if (sendBtn) sendBtn.style.display = '';
}

function showChatWarning(msg) {
  const messagesDiv = document.getElementById('chat-messages');
  if (messagesDiv) {
    messagesDiv.innerHTML += `<div class="chat-msg msg-system"><div class="msg-body" style="color:var(--amber)">⚠️ ${escapeHtml(msg)}</div></div>`;
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }
}

export { sendViaGatewayAPI, handleGatewayEvent, setupWsChatHandlers, handleThinkingDelta, handleReasoningDelta, handleMessageStart, handleTextDelta, handleStatusUpdate, handleToolGenerating, handleToolStart, handleToolProgress, handleToolDone, handleSubagentEvent, showClarifyModal, showApprovalModal, showSudoModal, showSecretModal, ensureThinkingPanel, hideThinkingPanel, ensureToolCards, finalizeWsChat, showChatError, showChatWarning };
