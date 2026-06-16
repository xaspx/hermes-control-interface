import { state, t } from '../core/state.js';
import { api } from '../core/api.js';
import { escapeHtml } from '../core/utils.js';
import { showToast } from '../components/toast.js';

// ── State ───────────────────────────────────────────────────────────────
let _workspacePath = '';
let _currentDir = '/';
let _chatMessages = [];
let _streamActive = false;
let _abortController = null;
let _currentFile = null;
let _editorDirty = false;

// ── Page Load ───────────────────────────────────────────────────────────
async function loadWorkspace(container) {
  container.innerHTML = `
    <div class="workspace-layout">
      <div class="workspace-header">
        <div class="workspace-path-bar">
          <input type="text" id="workspace-path-input"
            class="workspace-path-input"
            placeholder="Enter workspace path, e.g. /home/dpatel/my-project"
            spellcheck="false" />
          <button class="btn btn-primary" id="workspace-set-btn" onclick="setWorkspace()">Set Workspace</button>
          <button class="btn btn-ghost" id="workspace-browse-btn" onclick="browseWorkspace()" title="Open in Files panel">📂</button>
        </div>
        <div class="workspace-info" id="workspace-info"></div>
      </div>
      <div class="workspace-body">
        <div class="workspace-files-panel" id="workspace-files-panel">
          <div class="workspace-files-header">
            <span class="workspace-files-title" id="workspace-files-title">Files</span>
            <button class="btn btn-ghost btn-xs" id="workspace-files-refresh" onclick="refreshFileTree()" title="Refresh">🔄</button>
          </div>
          <div class="workspace-file-tree" id="workspace-file-tree">
            <div class="workspace-empty" data-i18n="workspace.setPath">Set a workspace directory above to view files</div>
          </div>
        </div>
        <div class="workspace-files-divider" id="workspace-files-divider"></div>
        <!-- Editor panel (hidden when no file selected) -->
        <div class="workspace-editor-panel" id="workspace-editor-panel" style="display:none;">
          <div class="workspace-editor-header">
            <span class="workspace-editor-filename" id="workspace-editor-filename"></span>
            <div class="workspace-editor-actions">
              <span class="workspace-editor-status" id="workspace-editor-status"></span>
              <button class="btn btn-primary btn-xs" id="workspace-editor-save" onclick="saveWsFile()">💾 Save</button>
              <button class="btn btn-ghost btn-xs" onclick="closeWsEditor()">✕</button>
            </div>
          </div>
          <textarea class="workspace-editor-textarea" id="workspace-editor-textarea"
            spellcheck="false" wrap="off"></textarea>
        </div>
        <div class="workspace-editor-divider" id="workspace-editor-divider"></div>
        <!-- Chat panel -->
        <div class="workspace-chat-panel">
            <div class="workspace-chat-header">
              <span class="workspace-chat-title">Workspace Chat</span>
              <div class="workspace-chat-actions">
                <button class="btn btn-ghost btn-xs" onclick="clearWsChat()" title="Clear chat">🗑️</button>
              </div>
            </div>
            <div class="workspace-chat-messages" id="workspace-chat-messages">
              <div class="workspace-chat-welcome">
                <div class="workspace-chat-welcome-icon">💻</div>
                <div class="workspace-chat-welcome-text">
                  Set a workspace directory, then ask Hermes to interrogate code, fix bugs, or refactor.
                </div>
              </div>
            </div>
            <div class="workspace-chat-input-bar">
              <textarea id="workspace-chat-input"
                class="workspace-chat-input"
                placeholder="Ask Hermes to work on this codebase..."
                rows="2"
                spellcheck="false"></textarea>
              <button class="btn btn-primary" id="workspace-chat-send" onclick="sendWsChat()">Send</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Load current workspace
  try {
    const res = await api('/api/workspace');
    if (res.ok && res.path) {
      _workspacePath = res.path;
      document.getElementById('workspace-path-input').value = _workspacePath;
      updateWsInfo();
      await loadWsFileTree('/');
    }
  } catch {}

  // Enter to send
  const input = document.getElementById('workspace-chat-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendWsChat();
    }
  });

  // ── Divider Drag Handlers ──────────────────────────────────────────
  setupDividerDrag('workspace-files-divider', 'workspace-files-panel', 'width', 'ws-files-width', 120);
  setupDividerDrag('workspace-editor-divider', 'workspace-editor-panel', 'width', null, 200);

  // Track editor changes
  document.getElementById('workspace-editor-textarea').addEventListener('input', onEditorInput);
  // Ctrl+S to save
  document.addEventListener('keydown', onEditorKeydown);
}

function onEditorInput(e) {
  if (_currentFile) {
    _editorDirty = e.target.value !== _currentFile.originalContent;
    updateWsEditorStatus();
  }
}

function onEditorKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    if (_currentFile) { e.preventDefault(); saveWsFile(); }
  }
}

// ── Workspace Path ──────────────────────────────────────────────────────
window.setWorkspace = async function() {
  const input = document.getElementById('workspace-path-input');
  const wsPath = input.value.trim();
  if (!wsPath) { showToast('Please enter a directory path', 'warning'); return; }
  try {
    const res = await api('/api/workspace', {
      method: 'POST',
      body: JSON.stringify({ path: wsPath }),
      headers: { 'Content-Type': 'application/json' }
    });
    if (res.ok) {
      _workspacePath = res.path;
      input.value = res.path;
      updateWsInfo();
      _currentDir = '/';
      closeWsEditor();
      await loadWsFileTree('/');
      showToast('Workspace set to: ' + res.path, 'success');
    } else {
      showToast(res.error || 'Failed to set workspace', 'error');
    }
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
};

window.browseWorkspace = function() {
  if (_workspacePath) window.navigate('files');
};

function updateWsInfo() {
  const info = document.getElementById('workspace-info');
  if (_workspacePath) {
    const parts = _workspacePath.split('/').filter(Boolean);
    const name = parts[parts.length - 1] || _workspacePath;
    info.innerHTML = `<span class="workspace-badge">📁 ${escapeHtml(name)}</span> <span class="workspace-path-text">${escapeHtml(_workspacePath)}</span>`;
  } else {
    info.innerHTML = '<span class="workspace-path-text muted">No workspace set</span>';
  }
}

// ── File Tree ───────────────────────────────────────────────────────────
window.refreshFileTree = async function() {
  if (_workspacePath) await loadWsFileTree(_currentDir);
};

async function loadWsFileTree(dir) {
  if (!_workspacePath) return;
  _currentDir = dir || '/';
  const treeEl = document.getElementById('workspace-file-tree');
  if (!treeEl) return;
  treeEl.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const res = await api(`/api/workspace?listDir=${encodeURIComponent(_currentDir)}`);
    if (!res.ok || !res.files || res.files.error) {
      treeEl.innerHTML = `<div class="workspace-empty">${escapeHtml(res.files?.error || 'Failed to load files')}</div>`;
      return;
    }
    const { items, parent } = res.files;
    let html = '';
    if (parent) {
      html += `<div class="workspace-file-item dir" onclick="loadWsDir('${escapeHtml(parent)}')">
        <span class="file-icon">📁</span><span class="file-name">..</span></div>`;
    }
    for (const item of items) {
      const isDir = item.type === 'directory';
      const icon = isDir ? '📁' : getWsFileIcon(item.name);
      const childPath = _currentDir === '/' ? item.name : _currentDir + '/' + item.name;
      const isActive = _currentFile && item.name === _currentFile.relPath.split('/').pop() && _currentDir === (_currentFile.relPath.includes('/') ? _currentFile.relPath.split('/').slice(0, -1).join('/') : '/');
      if (isDir) {
        html += `<div class="workspace-file-item dir" onclick="loadWsDir('${escapeHtml(childPath)}')">
          <span class="file-icon">${icon}</span><span class="file-name">${escapeHtml(item.name)}</span></div>`;
      } else {
        html += `<div class="workspace-file-item file${isActive ? ' active' : ''}"
          onclick="openWsFile('${escapeHtml(childPath)}')"
          title="${escapeHtml(formatWsSize(item.size))}">
          <span class="file-icon">${icon}</span><span class="file-name">${escapeHtml(item.name)}</span></div>`;
      }
    }
    if (items.length === 0) html = '<div class="workspace-empty">Empty directory</div>';
    treeEl.innerHTML = html;
    const dirName = _currentDir === '/' ? _workspacePath.split('/').filter(Boolean).pop() || _workspacePath : _currentDir.split('/').pop();
    document.getElementById('workspace-files-title').textContent = dirName || 'Files';
  } catch (e) {
    treeEl.innerHTML = `<div class="workspace-empty">Error: ${escapeHtml(e.message)}</div>`;
  }
}

window.loadWsDir = async function(dir) {
  await loadWsFileTree(dir);
};

// ── File Editor ─────────────────────────────────────────────────────────
window.openWsFile = async function(filePath) {
  if (!_workspacePath) return;

  // Prompt to save unsaved changes
  if (_editorDirty && _currentFile) {
    const save = await window.customConfirm('Save changes to ' + _currentFile.relPath + '?');
    if (save) await saveWsFile();
    closeWsEditor();
  }

  try {
    const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(filePath)}`, {
      headers: { 'X-CSRF-Token': window.__csrfToken || '' }
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      showToast(data.error || 'Failed to load file', 'error');
      return;
    }

    _currentFile = { relPath: filePath, content: data.content, originalContent: data.content };
    _editorDirty = false;

    const editorPanel = document.getElementById('workspace-editor-panel');
    editorPanel.style.display = 'flex';
    const ed = document.getElementById('workspace-editor-divider');
    if (ed) ed.style.display = '';
    document.getElementById('workspace-editor-filename').textContent = filePath;
    document.getElementById('workspace-editor-textarea').value = data.content;
    updateWsEditorStatus();

    // Re-render tree to highlight active file
    await loadWsFileTree(_currentDir);
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
};

window.saveWsFile = async function() {
  if (!_currentFile) return;
  const content = document.getElementById('workspace-editor-textarea').value;
  try {
    const res = await fetch('/api/workspace/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.__csrfToken || '' },
      body: JSON.stringify({ path: _currentFile.relPath, content })
    });
    const data = await res.json();
    if (data.ok) {
      _currentFile.originalContent = content;
      _currentFile.content = content;
      _editorDirty = false;
      updateWsEditorStatus();
      showToast('Saved: ' + _currentFile.relPath, 'success');
    } else {
      showToast(data.error || 'Save failed', 'error');
    }
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
};

window.closeWsEditor = function() {
  if (_editorDirty && _currentFile) {
    window.customConfirm('Discard unsaved changes?').then(confirmed => {
      if (confirmed) { _currentFile = null; _editorDirty = false; hideWsEditor(); }
    });
  } else {
    _currentFile = null;
    _editorDirty = false;
    hideWsEditor();
  }
};

function hideWsEditor() {
  document.getElementById('workspace-editor-panel').style.display = 'none';
  const ed = document.getElementById('workspace-editor-divider');
  if (ed) ed.style.display = 'none';
  loadWsFileTree(_currentDir);
}

function updateWsEditorStatus() {
  const statusEl = document.getElementById('workspace-editor-status');
  if (!statusEl) return;
  if (_editorDirty) {
    statusEl.textContent = '● unsaved';
    statusEl.className = 'workspace-editor-status dirty';
  } else {
    statusEl.textContent = '✓ saved';
    statusEl.className = 'workspace-editor-status clean';
  }
}

// ── Chat ────────────────────────────────────────────────────────────────
window.sendWsChat = async function() {
  const input = document.getElementById('workspace-chat-input');
  const message = input.value.trim();
  if (!message || _streamActive) return;
  if (!_workspacePath) { showToast('Set a workspace directory first', 'warning'); return; }

  _streamActive = true;
  input.value = '';
  input.disabled = true;
  document.getElementById('workspace-chat-send').disabled = true;

  const welcomeEl = document.querySelector('.workspace-chat-welcome');
  if (welcomeEl) welcomeEl.style.display = 'none';

  appendWsMsg('user', message);
  const msgId = appendWsMsg('assistant', '<div class="workspace-streaming">▊</div>');

  _abortController = new AbortController();
  try {
    const resp = await fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.__csrfToken || '' },
      body: JSON.stringify({ message, workspace: _workspacePath, profile: 'default' }),
      signal: _abortController.signal
    });
    if (!resp.ok) {
      updateWsMsg(msgId, `<div class="workspace-error">Error: ${resp.status} ${resp.statusText}</div>`);
      _streamActive = false; input.disabled = false; document.getElementById('workspace-chat-send').disabled = false;
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'token') { fullText += data.content; updateWsMsg(msgId, formatWsContent(fullText)); }
          else if (data.type === 'done') { updateWsMsg(msgId, formatWsContent(fullText)); }
          else if (data.type === 'error') { updateWsMsg(msgId, `<div class="workspace-error">${escapeHtml(data.content)}</div>`); }
        } catch {}
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') updateWsMsg(msgId, `<div class="workspace-error">Error: ${escapeHtml(e.message)}</div>`);
  }
  _streamActive = false; input.disabled = false; document.getElementById('workspace-chat-send').disabled = false;
  input.focus();
  document.getElementById('workspace-chat-messages').scrollTop = document.getElementById('workspace-chat-messages').scrollHeight;
};

window.clearWsChat = function() {
  const msgsEl = document.getElementById('workspace-chat-messages');
  msgsEl.innerHTML = `<div class="workspace-chat-welcome">
    <div class="workspace-chat-welcome-icon">💻</div>
    <div class="workspace-chat-welcome-text">
      Set a workspace directory, then ask Hermes to interrogate code, fix bugs, or refactor.
    </div>
  </div>`;
};

function appendWsMsg(role, content) {
  const msgsEl = document.getElementById('workspace-chat-messages');
  const id = 'wsm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const div = document.createElement('div');
  div.className = `workspace-msg workspace-msg-${role}`;
  div.id = id;
  div.innerHTML = `<div class="workspace-msg-avatar">${role === 'user' ? '👤' : '🤖'}</div><div class="workspace-msg-content">${content}</div>`;
  msgsEl.appendChild(div);
  msgsEl.scrollTop = msgsEl.scrollHeight;
  return id;
}

function updateWsMsg(id, content) {
  const el = document.getElementById(id);
  if (el) {
    const contentEl = el.querySelector('.workspace-msg-content');
    if (contentEl) contentEl.innerHTML = content;
  }
}

function formatWsContent(text) {
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

// ── Divider Drag ──────────────────────────────────────────────────
function setupDividerDrag(dividerId, targetId, cssProp, varName, minSize) {
  const divider = document.getElementById(dividerId);
  if (!divider) return;

  let isDragging = false;
  let startX = 0;
  let startSize = 0;
  const body = divider.closest('.workspace-body');
  if (!body) return;

  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDragging = true;
    startX = e.clientX;
    const target = document.getElementById(targetId);
    if (target) {
      startSize = target.getBoundingClientRect().width;
      target.style.flex = 'none';
    }
    divider.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const target = document.getElementById(targetId);
    if (!target) return;
    const dx = e.clientX - startX;
    const bodyRect = body.getBoundingClientRect();
    const maxSize = bodyRect.width * 0.5;
    let newSize = Math.max(minSize, Math.min(maxSize, startSize + dx));
    target.style.width = newSize + 'px';
    if (varName) {
      body.style.setProperty('--' + varName, newSize + 'px');
    }
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      divider.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

// ── Utilities ───────────────────────────────────────────────────────────
function getWsFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const m = {
    js: '🟨', jsx: '⚛️', ts: '🔵', tsx: '⚛️', py: '🐍',
    json: '📋', yaml: '📋', yml: '📋', md: '📝', txt: '📄',
    html: '🌐', css: '🎨', sh: '💻', bash: '💻',
    c: '⚙️', cpp: '⚙️', go: '🔷', rs: '🦀', java: '☕',
    toml: '📋', xml: '📋', svg: '🖼️', gitignore: '🙈',
    dockerfile: '🐳', png: '🖼️', jpg: '🖼️', gif: '🖼️'
  };
  return m[ext] || '📄';
}

function formatWsSize(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let s = bytes;
  while (s >= 1024 && i < u.length - 1) { s /= 1024; i++; }
  return s.toFixed(1) + ' ' + u[i];
}

export { loadWorkspace };
