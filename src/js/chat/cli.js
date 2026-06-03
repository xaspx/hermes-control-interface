import { state, t, toDisplayText } from '../core/state.js';;
import { refreshChatSidebar, reloadCurrentSessionMessages, updateChatHeader } from './core.js';
import { escapeHtml } from '../core/utils.js';

async function sendViaCLI(text, profile, sessionId, contentDiv, messagesDiv, startTime) {
  let fullContent = '';
  const bodyObj = { message: text, profile };
  if (sessionId) bodyObj.sessionId = sessionId;
  const response = await fetch('/api/chat/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
    credentials: 'include',
    body: JSON.stringify(bodyObj),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  while (!done) {
    const { done: d, value } = await reader.read();
    if (d) { done = true; break; }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const evt = JSON.parse(line.slice(6));
        if (evt.type === 'token') {
          fullContent += evt.content;
          if (contentDiv) { contentDiv.innerHTML = renderChatContent(fullContent) + '<span class="chat-cursor" style="animation:blink 1s infinite;">▊</span>'; fixCodeBlockContent(contentDiv); }
          if (messagesDiv) messagesDiv.scrollTop = messagesDiv.scrollHeight;
        } else if (evt.type === 'done') {
          if (evt.sessionId && !state._currentChatSession) state._currentChatSession = evt.sessionId;
        } else if (evt.type === 'error') {
          fullContent += '\n[Error: ' + evt.content + ']';
        }
      } catch {}
    }
  }
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const elapsedEl = document.getElementById('chat-status-elapsed');
  if (elapsedEl) elapsedEl.textContent = elapsed + 's';

  // Reload messages from DB to get clean, properly rendered messages
  if (state._currentChatSession) {
    await reloadCurrentSessionMessages();
  }

  await refreshChatSidebar();
  updateChatHeader();
}

function addToolCallCard(contentDiv, callId, name, args) {
  const card = document.createElement('div');
  card.className = 'tool-call-card';
  card.id = `tool-card-${callId}`;
  const argsStr = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
  const argsPreview = argsStr.substring(0, 150) + (argsStr.length > 150 ? '...' : '');
  card.innerHTML = `
    <div class="tool-card-header" onclick="this.parentElement.classList.toggle('expanded')">
      <span class="tool-card-icon">⚡</span>
      <span class="tool-card-name">${escapeHtml(name || 'tool')}</span>
      <span class="tool-card-status running">running</span>
      <span class="tool-card-chevron">▶</span>
    </div>
    <div class="tool-card-body">
      <div class="tool-card-args"><code>${escapeHtml(argsPreview)}</code></div>
      <div class="tool-card-preview" id="tool-preview-${callId}"></div>
      <div class="tool-card-result" id="tool-result-${callId}"></div>
    </div>`;
  // Insert before cursor
  const cursor = contentDiv.querySelector('.chat-cursor');
  if (cursor && contentDiv.contains(cursor)) {
    contentDiv.insertBefore(card, cursor);
  } else {
    contentDiv.appendChild(card);
  }
  return card;
}

function updateToolProgress(toolCards, name, preview) {
  for (const [id, el] of toolCards) {
    const previewEl = el.querySelector('.tool-card-preview');
    if (previewEl && preview) previewEl.textContent = preview;
  }
}

function finalizeToolCard(toolCards, callId, result) {
  const el = toolCards.get(callId);
  if (!el) return;
  const statusEl = el.querySelector('.tool-card-status');
  if (statusEl) { statusEl.textContent = 'done'; statusEl.className = 'tool-card-status done'; }
  // Auto-expand when result arrives
  el.classList.add('expanded');
  const resultEl = el.querySelector(`#tool-result-${callId}`) || el.querySelector('.tool-card-result');
  if (resultEl && result) {
    const display = typeof result === 'string' ? result.substring(0, 4000) : JSON.stringify(result).substring(0, 4000);
    const fullLen = typeof result === 'string' ? result.length : JSON.stringify(result).length;
    if (fullLen > 4000) {
      resultEl.innerHTML = `
        <pre class="tool-result-truncated">${escapeHtml(display)}</pre>
        <button class="tool-expand-btn" onclick="this.previousElementSibling.classList.toggle('tool-result-truncated'); this.previousElementSibling.classList.toggle('tool-result-full'); this.textContent = this.previousElementSibling.classList.contains('tool-result-full') ? 'Show less' : 'Show more (${(fullLen - 4000).toLocaleString()} more chars)';">Show more (${(fullLen - 4000).toLocaleString()} more chars)</button>`;
      resultEl.classList.add('has-expand');
    } else {
      resultEl.innerHTML = `<pre>${escapeHtml(display)}</pre>`;
    }
  }
}

function updateStreamContent(contentDiv, fullContent, toolCards, messagesDiv, elapsed) {
  if (!contentDiv) return;
  // Guard: if contentDiv is no longer in the DOM (stream finalized), skip
  if (!document.contains(contentDiv)) return;
  // Use a dedicated text span for streaming content (avoid full DOM rebuild)
  let textSpan = contentDiv.querySelector('#gw-stream-text');
  if (!textSpan) {
    textSpan = document.createElement('span');
    textSpan.id = 'gw-stream-text';
    // Insert after any existing tool cards
    const lastCard = contentDiv.querySelector('.tool-call-card:last-of-type');
    if (lastCard && contentDiv.contains(lastCard) && lastCard.nextSibling && contentDiv.contains(lastCard.nextSibling)) {
      contentDiv.insertBefore(textSpan, lastCard.nextSibling);
    } else if (lastCard && contentDiv.contains(lastCard)) {
      lastCard.after(textSpan);
    } else {
      contentDiv.prepend(textSpan);
    }
  }
  if (fullContent !== null && fullContent !== undefined) {
    let html = renderChatContent(fullContent);
    if (elapsed) {
      html += `<div style="font-size:10px;color:var(--fg-subtle);margin-top:8px;">${elapsed}s</div>`;
    } else {
      html += '<span class="chat-cursor" style="animation:blink 1s infinite;">▊</span>';
    }
    textSpan.innerHTML = html;
  } else if (elapsed) {
    // Finalize: just add elapsed time
    const cursor = textSpan.querySelector('.chat-cursor');
    if (cursor) cursor.remove();
    textSpan.insertAdjacentHTML('beforeend', `<div style="font-size:10px;color:var(--fg-subtle);margin-top:8px;">${elapsed}s</div>`);
  }
  if (messagesDiv) messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function renderChatContent(text) {
  if (!text) return '';
  text = toDisplayText(text);

  // ── 1. Extract code blocks FIRST (before any escaping) ──
  const codeBlocks = [];
  let html = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    const id = codeBlocks.length;
    codeBlocks.push({ lang: lang || '', code: escapeHtml(code.trimEnd()) });
    return `\x00CODE${id}\x00`;
  });

  // ── 2. Escape everything outside code blocks ──
  html = escapeHtml(html);

  // ── 3. Markdown formatting (safe — text already escaped) ──
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h4 style="font-size:12px;font-weight:700;margin:8px 0 4px;color:var(--fg);">$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3 style="font-size:13px;font-weight:700;margin:10px 0 4px;color:var(--fg);">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 style="font-size:14px;font-weight:700;margin:12px 0 6px;color:var(--fg);">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 style="font-size:15px;font-weight:700;margin:14px 0 8px;color:var(--fg);">$1</h1>');
  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote style="border-left:3px solid var(--accent);padding-left:10px;margin:6px 0;color:var(--fg-subtle);">$1</blockquote>');
  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid var(--border);margin:10px 0;">');

  // ── 4. Restore code blocks with textContent (prevents hljs unescaped-HTML warning) ──
  codeBlocks.forEach((cb, i) => {
    const langClass = cb.lang ? `language-${cb.lang}` : '';
    const langLabel = cb.lang ? `<span style="position:absolute;top:4px;left:10px;font-size:9px;text-transform:uppercase;letter-spacing:0.06em;color:var(--fg-subtle);">${escapeHtml(cb.lang)}</span>` : '';
    // Use unique placeholder so we can find it after innerHTML
    const placeholder = `__CODE_CONTENT_${i}__`;
    html = html.replace(
      `\x00CODE${i}\x00`,
      `<pre style="position:relative;padding-top:22px;">${langLabel}<button class="code-copy-btn" onclick="copyCodeBlock(this)" data-i18n="auto.copy">Copy</button><code class="${langClass}">${placeholder}</code></pre>`
    );
  });
  // After innerHTML, restore code content via textContent (avoids DOM decoding escapeHtml)
  // This runs AFTER the caller sets innerHTML — caller must call fixCodeBlockContent()
  // We attach the blocks array so fixCodeBlockContent can use it
  window.__pendingCodeBlocks = codeBlocks;

  // ── 5. Lists (process after code blocks restored) ──
  // Collect ALL list items first, then wrap adjacent ones in <ul>/<ol>
  const listReplacements = [];
  // Unordered: capture individual - items (non-greedy, won't eat across items)
  html = html.replace(/^- ([\s\S]*?)$/gm, (_, content) => {
    const id = listReplacements.length;
    listReplacements.push({ type: 'ul', content, id });
    return `\x00LISTITEM${id}\x00`;
  });
  // Ordered: capture individual 1. items
  html = html.replace(/^\d+\. ([\s\S]*?)$/gm, (_, content) => {
    const id = listReplacements.length;
    listReplacements.push({ type: 'ol', content, id });
    return `\x00LISTITEM${id}\x00`;
  });
  // Group consecutive same-type list items
  const grouped = [];
  for (const item of listReplacements) {
    const last = grouped[grouped.length - 1];
    if (last && last.type === item.type) {
      last.items.push(item.content);
    } else {
      grouped.push({ type: item.type, items: [item.content] });
    }
  }
  // Restore as <ul>/<ol>
  grouped.forEach((g, gi) => {
    const items = g.items.map((c, i) => `<li>${c}</li>`).join('');
    const tag = `<${g.type}>${items}</${g.type}>`;
    html = html.replace(`\x00LISTITEM${gi}\x00`, tag);
  });
  // Clean up any stray unreplaced list placeholders (shouldn't happen)
  html = html.replace(/\x00LISTITEM\d+\x00/g, '');

  // ── 6. Paragraphs ──
  // Split on double newlines, wrap each chunk in <p>
  const chunks = html.split(/(?:&lt;br&gt;){2,}|\n\n/).filter(Boolean);
  if (chunks.length > 1) {
    html = chunks.map(c => {
      const trimmed = c.trim();
      if (trimmed.startsWith('<pre') || trimmed.startsWith('<blockquote') || trimmed.startsWith('<h') || trimmed.startsWith('<hr') || trimmed.startsWith('<ul') || trimmed.startsWith('<li')) return c;
      return `<p>${trimmed}</p>`;
    }).join('');
  } else if (!html.startsWith('<') || html.startsWith('<em>') || html.startsWith('<strong>')) {
    html = `<p>${html}</p>`;
  }

  // Single line breaks inside paragraphs → <br>
  html = html.replace(/\n/g, '<br>');

  return html;
}

function highlightCodeBlocks(container) {
  if (typeof hljs === 'undefined') return;
  // Fix code block content from textContent BEFORE highlighting (prevents hljs unescaped-HTML warning)
  fixCodeBlockContent(container);
  container.querySelectorAll('pre code:not(.hljs)').forEach(block => {
    try { hljs.highlightElement(block); } catch {}
  });
}

function createMessageDiv(role, content, optId) {
  const cls = { user: 'msg-user', assistant: 'msg-assistant' }[role] || 'msg-assistant';
  // Dedup: skip if exact user message with same content was sent in last 10s
  if (role === 'user' && isDuplicateUserMessage(content)) {
    console.warn('[Chat] Skipping duplicate user message');
    return document.createElement('div'); // empty, invisible
  }
  const div = document.createElement('div');
  div.className = `chat-msg ${cls}`;
  if (optId) div.dataset.optId = optId;
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = content;
  div.appendChild(body);
  return div;
}

function addToDedupBuf(role, content) {
  if (!state._recentMessages) state._recentMessages = { buf: [], max: 20 };
  const b = state._recentMessages;
  b.buf.unshift({ role, content, ts: Date.now() });
  if (b.buf.length > b.max) b.buf.length = b.max;
}

function isDuplicateUserMessage(content) {
  const b = state._recentMessages?.buf;
  if (!b?.length) return false;
  const win = 10000; // 10 seconds
  const recent = b.slice(0, 5);
  return recent.some(m => m.role === 'user' && m.content === content && Date.now() - m.ts < win);
}

function swapOptimisticMessage(sessionId) {
  if (!state._currentChatSession && sessionId) {
    state._currentChatSession = sessionId;
  }
  if (state._optMessages?.size > 0) {
    // Clear optimistic markers once we have a real session
    for (const [optId, entry] of state._optMessages) {
      if (entry.el) entry.el.dataset.optId = '';
    }
    state._optMessages.clear();
  }
}

function updateWsConnectionUI(connected) {
  // Find or create the connection indicator in chat header
  let indicator = document.getElementById('ws-conn-indicator');
  if (!indicator) {
    // Create it — insert into chat-header-right area
    const header = document.getElementById('chat-header-right');
    if (header) {
      indicator = document.createElement('span');
      indicator.id = 'ws-conn-indicator';
      indicator.title = 'WebSocket connection';
      header.appendChild(indicator);
    }
  }
  if (indicator) {
    indicator.textContent = connected ? '🟢 ws' : '🔴 ws';
    indicator.title = connected ? 'WebSocket connected' : 'WebSocket disconnected — reconnecting...';
    indicator.style.cssText = 'font-size:10px;margin-left:6px;cursor:default;';
  }
  // Also update agent-status-indicator if it exists
  const agentIndicator = document.getElementById('agent-status-indicator');
  if (agentIndicator) {
    if (!connected) {
      agentIndicator.textContent = 'reconnecting';
      agentIndicator.className = 'status-busy';
    }
  }
}

async function updateGatewayBadge() {
  const badge = document.getElementById('chat-gateway-badge');
  if (!badge) return;
  const profile = document.getElementById('chat-profile')?.value || 'default';
  try {
    const res = await fetch(`/api/gateway/${encodeURIComponent(profile)}/health`);
    if (!res.ok) throw new Error('not ok');
    const data = await res.json();
    if (data.healthy && data.port) {
      badge.textContent = `🌐 ${data.port}`;
      badge.className = 'chat-header-badge badge-healthy';
      badge.title = `Gateway healthy — mode: ${data.gatewayMode}`;
    } else {
      badge.textContent = '⚠️ DOWN';
      badge.className = 'chat-header-badge badge-down';
      badge.title = (data.issues || []).join('; ');
    }
  } catch {
    badge.textContent = '⚠️ ERR';
    badge.className = 'chat-header-badge badge-down';
    badge.title = 'Gateway health check failed';
  }
}

window.copyCodeBlock = function(btn) {
  const pre = btn.closest('pre');
  const code = pre.querySelector('code');
  const text = code.textContent;
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  }).catch(() => {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
};
// Fix code block content after innerHTML — uses textContent to prevent hljs security warning
function fixCodeBlockContent(container) {
  const blocks = window.__pendingCodeBlocks;
  if (!blocks || !blocks.length) return;
  container.querySelectorAll('pre code').forEach(code => {
    const text = code.textContent || '';
    const match = text.match(/^__CODE_CONTENT_(\d+)__$/);
    if (match) {
      const idx = parseInt(match[1]);
      if (blocks[idx]) {
        code.textContent = blocks[idx].code;
      }
    }
  });
  // Only clear pending blocks when all placeholders are resolved
  // (streaming may call this multiple times before all code blocks are extracted)
  const remaining = container.querySelector('pre code');
  if (!remaining || !remaining.textContent?.match(/^__CODE_CONTENT_/)) {
    window.__pendingCodeBlocks = null;
  }
}

export { sendViaCLI, addToolCallCard, updateToolProgress, finalizeToolCard, updateStreamContent, renderChatContent, fixCodeBlockContent, highlightCodeBlocks, createMessageDiv, addToDedupBuf, isDuplicateUserMessage, swapOptimisticMessage, updateWsConnectionUI, updateGatewayBadge };
