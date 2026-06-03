import { state, t } from '../core/state.js';;
import { showToast } from '../components/toast.js';
import { api } from '../core/api.js';
import { escapeHtml, formatFileSize } from '../core/utils.js';

async function loadFileExplorer(container, dirPath = '') {
  const isMobile = window.innerWidth <= 768;
  const sidebarId = 'file-sidebar-overlay';
  const backdropId = 'file-sidebar-backdrop';

  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title" data-i18n="auto.fileExplorer">File Explorer</div>
        <div class="page-subtitle" data-i18n="auto.hermesDirectoryBrowser">.hermes directory browser</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        ${isMobile ? `<button class="btn btn-ghost" id="toggle-file-sidebar" onclick="toggleFileSidebar()" data-i18n="auto.files">☰ Files</button>` : ''}
        <button class="btn btn-ghost" onclick="loadFileExplorer(document.querySelector('.page.active'), '')" data-i18n="auto.root">⌂ Root</button>
        <button class="btn btn-ghost" onclick="loadFileExplorer(document.querySelector('.page.active'), '${dirPath}')" data-i18n="home.refresh">↻ Refresh</button>
      </div>
    </div>
    <div class="file-explorer-split">
      ${isMobile ? `<div id="${backdropId}" class="file-sidebar-backdrop" onclick="toggleFileSidebar()" style="display:none;"></div>` : ''}
      <div class="file-tree-panel" id="${sidebarId}" style="${isMobile ? 'display:none;position:fixed;top:0;left:0;bottom:0;width:280px;z-index:300;margin:0;transform:translateX(-100%);transition:transform .25s ease;' : ''}">
        <div id="file-tree"><div class="loading" data-i18n="auto.loading">Loading...</div></div>
      </div>
      <div class="file-editor-panel" id="file-editor-panel" style="display:none;">
        <div class="file-editor-toolbar">
          <span id="file-editor-path" class="file-editor-path" data-i18n="auto.selectAFile">Select a file</span>
          <div style="display:flex;gap:4px;">
            ${isMobile ? `<button class="btn btn-ghost btn-sm" onclick="toggleFileSidebar()" style="display:inline-flex;">☰</button>` : ''}
            <button class="btn btn-ghost btn-sm" id="file-save-btn" style="display:none;" onclick="saveCurrentFile()" data-i18n="auto.save2">Save</button>
          </div>
        </div>
        <textarea id="file-editor-text" class="file-editor-textarea" spellcheck="false" placeholder="Select a file from the tree"></textarea>
      </div>
    </div>
  `;

  // Store current dir in state
  state.fileExplorerDir = dirPath;

  try {
    const res = await api(`/api/files/list?path=${encodeURIComponent(dirPath)}`);
    const treeEl = document.getElementById('file-tree');

    if (!res.ok) {
      treeEl.innerHTML = `<div class="error-msg">${res.error || 'Failed to load'}</div>`;
      return;
    }

    // Breadcrumb — scrollable on mobile
    const parts = res.path ? res.path.split('/').filter(Boolean) : [];
    let breadcrumb = `<div class="file-breadcrumb" style="overflow-x:auto;white-space:nowrap;"><span class="file-link" onclick="loadFileExplorer(document.querySelector('.page.active'), '')">⌂ .hermes</span>`;
    let accum = '';
    for (const part of parts) {
      accum += '/' + part;
      breadcrumb += ` / <span class="file-link" onclick="loadFileExplorer(document.querySelector('.page.active'), '${accum.slice(1)}')">${part}</span>`;
    }
    breadcrumb += '</div>';

    // File list
    let itemsHtml = '';
    if (res.path) {
      itemsHtml += `<div class="file-item file-dir" style="min-height:44px;" onclick="loadFileExplorer(document.querySelector('.page.active'), '${res.parent}');${isMobile?'toggleFileSidebar();':''}"><span>📁 ..</span></div>`;
    }
    for (const item of res.items) {
      const icon = item.type === 'directory' ? '📁' : '📄';
      const size = item.type === 'file' ? ` <span class="file-meta">${formatFileSize(item.size)}</span>` : '';
      const action = item.type === 'directory'
        ? `loadFileExplorer(document.querySelector('.page.active'), '${item.path}');${isMobile?'toggleFileSidebar();':''}`
        : `openFileInEditor('${item.path}');${isMobile?'toggleFileSidebar();':''}`;
      itemsHtml += `<div class="file-item ${item.type === 'directory' ? 'file-dir' : 'file-file'}" style="min-height:44px;" onclick="${action}"><span>${icon} ${item.name}</span>${size}</div>`;
    }

    treeEl.innerHTML = breadcrumb + (itemsHtml || '<div class="empty" data-i18n="auto.emptyDirectory">Empty directory</div>');
  } catch (e) {
    document.getElementById('file-tree').innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
  }
}

async function openFileInEditor(filePath) {
  const panel = document.getElementById('file-editor-panel');
  const textEl = document.getElementById('file-editor-text');
  const pathEl = document.getElementById('file-editor-path');
  const saveBtn = document.getElementById('file-save-btn');

  panel.style.display = 'flex';
  pathEl.textContent = filePath;
  textEl.value = 'Loading...';
  textEl.disabled = true;
  saveBtn.style.display = 'none';
  window.currentFilePath = filePath;

  try {
    const res = await api(`/api/file?path=${encodeURIComponent(filePath)}`);
    if (res && res.ok) {
      textEl.value = res.content || '(empty file)';
      textEl.disabled = false;
      saveBtn.style.display = 'inline-flex';
      // Highlight active file in tree
      document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));
      const clicked = document.querySelector(`.file-item[onclick*="${filePath}"]`);
      if (clicked) clicked.classList.add('active');
    } else {
      textEl.value = `Error: ${(res && res.error) || 'Could not read file'}\nPath: ${filePath}\n\nTroubleshooting:\n- Check server logs\n- Verify file exists: ls -la ~/.hermes/${filePath}`;
    }
  } catch (e) {
    textEl.value = `Network error: ${e.message}`;
  }
}

async function saveCurrentFile() {
  if (!window.currentFilePath) return;
  const textEl = document.getElementById('file-editor-text');
  try {
    const csrfToken = state.csrfToken || '';
    const res = await api('/api/file', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ path: window.currentFilePath, content: textEl.value }),
    });
    if (res && res.ok) {
      showToast(t('toast.fileSaved'), 'success');
    } else {
      showToast(res?.error || 'Save failed', 'error');
    }
  } catch (e) {
    showToast(t('toast.saveFailedPrefix') + e.message, 'error');
  }
}

async function loadFileContent(filePath) {
  // Redirect to split view editor
  openFileInEditor(filePath);
}

window.loadFileExplorer = loadFileExplorer;
window.openFileInEditor = openFileInEditor;
window.saveCurrentFile = saveCurrentFile;
window.loadFileContent = loadFileContent;
export { loadFileExplorer, openFileInEditor, saveCurrentFile, loadFileContent };
