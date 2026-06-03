import { state, t } from '../core/state.js';;
import { closeModal, customConfirm, showModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { api } from '../core/api.js';
import { escapeHtml, formatRelativeTime } from '../core/utils.js';
import { openTerminalPanel, sseProgressModal } from './agents.js';

async function loadHome(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title" data-i18n="home.title">Home</div>
        <div class="page-subtitle" data-i18n="home.subtitle">System overview</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-primary" onclick="openTerminalPanel('Hermes CLI', '')" data-i18n="home.terminal">⌘ Terminal</button>
        <button class="btn btn-ghost" onclick="loadHome(document.querySelector('.page.active'))" data-i18n="home.refresh">↻ Refresh</button>
      </div>
    </div>
    <div class="card-grid" id="home-cards" style="grid-template-columns:repeat(4,1fr);">
      <div class="card" id="home-agent"><div class="card-title" data-i18n="home.agentOverview">Agent Overview</div><div class="loading" data-i18n="common.loading">Loading</div></div>
      <div class="card" id="home-gateways"><div class="card-title" data-i18n="home.gateways">Gateways</div><div class="loading" data-i18n="common.loading">Loading</div></div>
      <div class="card"><div class="card-title" data-i18n="home.hermesAuth">Hermes Auth</div><div id="home-auth-list"><div class="loading" data-i18n="home.loadingAuth">Loading auth...</div></div></div>
      <div class="card" id="home-setup"><div class="card-title" data-i18n="home.setupHealth">Setup Health</div><div class="loading" data-i18n="home.checking">Checking...</div></div>
    </div>
  `;

  try {
    const [profilesRes, agentRes, cronRes] = await Promise.all([
      api('/api/profiles'),
      api('/api/agent/status'),
      api('/api/cron/list', { method: 'POST', body: '{}' }),
    ]);

    // Row 1: Agent Overview only (System Health/Details moved to Monitor page)
    const agentCard = document.getElementById('home-agent');
    if (agentCard) {
      agentCard.innerHTML = `
        <div class="card-title" data-i18n="home.agentOverview">Agent Overview</div>
        <div class="stat-row"><span class="stat-label" data-i18n="home.model">Model</span><span class="stat-value">${agentRes.ok ? (agentRes.model || 'N/A') : 'N/A'}</span></div>
        <div class="stat-row"><span class="stat-label" data-i18n="home.provider">Provider</span><span class="stat-value">${agentRes.ok ? (agentRes.provider || 'N/A') : 'N/A'}</span></div>
        <div class="stat-row"><span class="stat-label" data-i18n="home.gateway">Gateway</span><span class="stat-value ${agentRes.ok && agentRes.gatewayStatus?.includes('running') ? 'status-ok' : 'status-off'}">${agentRes.ok ? (agentRes.gatewayStatus || 'N/A') : 'N/A'}</span></div>
        <div class="stat-row"><span class="stat-label" data-i18n="home.apiKeys">API Keys</span><span class="stat-value">${agentRes.ok ? `${agentRes.apiKeys?.active || 0}/${agentRes.apiKeys?.total || 0} active` : 'N/A'}</span></div>
        <div class="stat-row"><span class="stat-label" data-i18n="home.platforms">Platforms</span><span class="stat-value">${agentRes.ok ? (agentRes.platforms?.filter(p => p.configured).map(p => p.name).join(', ') || 'None') : 'N/A'}</span></div>
        <div class="stat-row"><span class="stat-label" data-i18n="home.cron">Cron</span><span class="stat-value">${cronRes?.jobs?.length || 0} jobs</span></div>
        <div class="stat-row"><span class="stat-label" data-i18n="home.sessions">Sessions</span><span class="stat-value">${agentRes.ok ? `${agentRes.activeSessions || 0} active` : 'N/A'}</span></div>
      `;
    }

    // Row 2: Gateways (update only this card, don't replace entire grid)
    const profiles = profilesRes.ok && profilesRes.profiles ? profilesRes.profiles : [];
    const gwHtml = profiles.map(p => {
      const cls = p.gateway === 'running' ? 'status-ok' : 'status-off';
      const txt = p.gateway === 'running' ? '● running' : '○ stopped';
      return `<div class="stat-row"><span class="stat-label">${p.name}</span><span class="stat-value ${cls}">${txt}</span></div>`;
    }).join('');
    const gwCard = document.getElementById('home-gateways');
    if (gwCard) {
      gwCard.innerHTML = `<div class="card-title" data-i18n="home.gateways">Gateways</div>${gwHtml || '<div class="stat-row"><span class="stat-label" data-i18n="home.noProfiles">No profiles</span></div>'}`;
    }

    // Load auth into home
    loadHomeAuth();

    // Load setup health
    try {
      const checkRes = await fetch('/api/setup/check');
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        const allOk = checkData.checks.every(c => c.ok);
        const items = checkData.checks.map(c =>
          `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px;">
            <span style="color:${c.ok ? 'var(--green)' : 'var(--red)'};">${c.ok ? '✅' : '❌'}</span>
            <span>${escapeHtml(c.label)}</span>
            <span style="color:var(--fg-muted);font-size:11px;margin-left:auto;">${escapeHtml(c.detail || '')}</span>
          </div>`
        ).join('');
        const setupCard = document.getElementById('home-setup');
        if (setupCard) {
          setupCard.innerHTML = `<div class="card-title" data-i18n="home.setupHealth">Setup Health</div>${items}`;
        }
      }
    } catch (e) {
      const setupCard = document.getElementById('home-setup');
      if (setupCard) setupCard.innerHTML = `<div class="card-title" data-i18n="home.setupHealth">Setup Health</div><div class="error-msg">${escapeHtml(e.message)}</div>`;
    }

  } catch (e) {
    const agentCard = document.getElementById('home-agent');
    if (agentCard) agentCard.innerHTML = `<div class="card-title" data-i18n="common.error">Error</div><div class="error-msg">${escapeHtml(e.message)}</div>`;
  }
}

async function hcirestart() {
  if (!await customConfirm(t('dialog.confirmRestartHci'), 'Restart')) return;
  try {
    const csrfToken = state.csrfToken || '';
    const res = await api('/api/hci-restart', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } });
    if (res.ok) {
      showToast(t('toast.hciRestarting'), 'success');
      // Wait 5s for server to come back up before reload (avoids 502)
      setTimeout(() => location.reload(), 5000);
    } else {
      showToast(res.error || 'Restart failed', 'error');
    }
  } catch (e) { showToast(t('toast.restartFailedPrefix') + e.message, 'error'); }
}

async function hciupdate() {
  if (!await customConfirm(t('dialog.confirmUpdateHci'), 'Update')) return;
  await sseProgressModal('⬆ Updating HCI', '/api/hci/update', {
    headers: { 'X-CSRF-Token': state.csrfToken || '' },
    autoCloseMs: 2000,
    onSuccess: () => { setTimeout(() => location.reload(), 4000); },
  });
}

async function runHCIUpdate() {
  if (!await customConfirm(t('dialog.confirmUpdateHci'), 'Update')) return;
  await sseProgressModal('⬆ Updating HCI', '/api/hci/update', {
    headers: { 'X-CSRF-Token': state.csrfToken || '' },
    autoCloseMs: 2000,
    onSuccess: () => { setTimeout(() => location.reload(), 4000); },
  });
}

async function updateHCIInfo() {
  try {
    const res = await api('/api/hci/check-update');
    if (!res.ok) return;
    const versionEl = document.getElementById('hci-current-version');
    if (versionEl) versionEl.textContent = res.local.version || '—';
    const hashEl = document.getElementById('hci-current-commit');
    if (hashEl) hashEl.textContent = res.local.hash || '—';
    const branchEl = document.getElementById('hci-current-branch');
    if (branchEl) branchEl.textContent = res.branch || '—';
    const behindEl = document.getElementById('hci-commits-behind');
    if (behindEl) behindEl.textContent = res.behind;
    const behindBadge = document.getElementById('hci-behind-badge');
    if (behindBadge) behindBadge.style.display = res.behind > 0 ? '' : 'none';
    // Store for modal use
    state._hciUpdateInfo = res;
  } catch {}
}

async function checkHCIUpdates() {
  await updateHCIInfo();
  const res = state._hciUpdateInfo;
  if (!res || !res.ok) { showModal({ title: 'Error', message: res?.error || 'Failed to check updates', buttons: [{ text: 'OK', value: true }] }); return; }
  if (res.behind > 0) {
    showCommitListModal(res);
  } else {
    showModal({
      title: 'Up to Date',
      message: `Already at latest commit on ${res.branch}.`,
      buttons: [{ text: 'OK', value: true }],
    });
  }
}

function showCommitListModal(data) {
  const commitsHtml = data.commits.map((c, i) => `
    <div class="commit-card" data-hash="${c.hash}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <code class="commit-hash">${c.shortHash}</code>
        <span style="flex:1;font-weight:600;font-size:13px;">${escapeHtml(c.msg)}</span>
        <button class="btn btn-xs btn-outline" onclick="showCommitDiff('${c.shortHash}')" data-i18n="auto.diff">Diff</button>
        <button class="btn btn-xs btn-primary" onclick="checkoutCommit('${c.shortHash}')" data-i18n="auto.checkout">Checkout</button>
      </div>
      <div style="font-size:11px;color:var(--fg-muted);">
        ${escapeHtml(c.author)} · ${formatRelativeTime(c.date)}
      </div>
    </div>
  `).join('');

  showModal({
    title: `${data.behind} commit(s) behind on ${data.branch}`,
    message: `<div class="commit-list-container">${commitsHtml}</div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
        <button class="btn btn-primary" onclick="runHCIUpdate(); closeModal();" data-i18n="auto.updateAllPullLatest">Update All (pull latest)</button>
      </div>`,
    buttons: [{ text: 'Close', value: false }],
  });
}

async function showCommitDiff(hash) {
  const res = await api(`/api/hci/commit/${hash}/diff`);
  if (!res.ok) { showModal({ title: 'Error', message: res.error, buttons: [{ text: 'OK', value: true }] }); return; }
  showModal({
    title: `${res.commit.shortHash}: ${res.commit.msg}`,
    message: `
      <div style="margin-bottom:8px;font-size:12px;color:var(--fg-muted);">${escapeHtml(res.commit.author)} · ${formatRelativeTime(res.commit.date)}</div>
      <div style="margin-bottom:8px;font-weight:600;font-size:12px;">${escapeHtml(res.shortstat)}</div>
      <div class="diff-files-list">${res.files.map(f => `
        <div style="display:flex;gap:8px;font-size:12px;padding:2px 0;">
          <span style="color:var(--green);">+${f.added}</span>
          <span style="color:var(--coral);">-${f.removed}</span>
          <span style="flex:1;font-family:monospace;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(f.file)}</span>
        </div>
      `).join('')}</div>`,
    buttons: [{ text: 'Close', value: true }],
  });
}

async function checkoutCommit(hash) {
  const confirmed = await showModal({
    title: 'Checkout Commit',
    message: `Checkout to <code>${hash}</code>? This will run npm install and rebuild.<br><br><strong data-i18n="auto.theServerWillRestart">The server will restart.</strong>`,
    buttons: [
      { text: 'Cancel', value: false },
      { text: 'Checkout', value: true, primary: true },
    ],
  });
  if (!confirmed?.action) return;
  runUpdateStream(`/api/hci/update/commit/${hash}`);
}

async function runUpdateStream(endpoint) {
  // Show progress modal
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'hci-update-progress';
  overlay.innerHTML = `<div class="modal-card" style="max-width:600px;">
    <div class="modal-header"><h3 data-i18n="auto.hciUpdate">HCI Update</h3>
      <button class="btn btn-xs btn-ghost" onclick="this.closest('.modal-overlay').remove()">✕</button>
    </div>
    <div class="modal-body">
      <pre id="hci-update-log" style="max-height:400px;overflow-y:auto;font-size:12px;font-family:var(--font-mono);background:var(--bg-input);padding:12px;border-radius:8px;white-space:pre-wrap;"></pre>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const logEl = document.getElementById('hci-update-log');
  let completed = false;

  // Safety timeout — 120s
  const safetyTimeout = setTimeout(() => {
    if (!completed) {
      logEl.textContent += '\n⚠ Update timed out. You may need to restart manually.';
    }
  }, 120000);

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
    const res = await fetch(endpoint, { method: 'POST', headers, body: '{}' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'progress') logEl.textContent += evt.line + '\n';
          if (evt.type === 'warning') logEl.textContent += '⚠ ' + evt.line + '\n';
          if (evt.type === 'error') logEl.textContent += '❌ ' + evt.message + '\n';
          if (evt.type === 'done') {
            completed = true;
            logEl.textContent += '\n✅ ' + evt.message;
            setTimeout(() => location.reload(), 2000);
          }
          logEl.scrollTop = logEl.scrollHeight;
        } catch {}
      }
    }
  } catch (e) {
    logEl.textContent += '\n❌ Connection error: ' + e.message;
  }
  clearTimeout(safetyTimeout);
}

async function hcidoctor() {
  if (!await customConfirm(t('dialog.confirmDiagnostics'), 'Diagnostics')) return;
  await sseProgressModal('🩺 Running Diagnostics', '/api/doctor', {
    method: 'POST',
    headers: { 'X-CSRF-Token': state.csrfToken || '' },
    autoCloseMs: 5000,
  });
}

async function loadHomeAuth() {
  try {
    const res = await api('/api/auth/providers');
    const el = document.getElementById('home-auth-list');
    if (!el) return;
    if (res.ok && res.providers) {
      el.innerHTML = res.providers.map(p => `
        <div class="stat-row">
          <span class="stat-label">${p.name}</span>
          <span class="stat-value ${p.set ? 'status-ok' : 'status-off'}">${p.set ? '● set' : '○ not set'}</span>
        </div>
      `).join('');
    } else {
      el.innerHTML = '<div class="stat-row"><span class="stat-label" data-i18n="auto.authInfoUnavailable">Auth info unavailable</span></div>';
    }
  } catch {
    const el = document.getElementById('home-auth-list');
    if (el) el.innerHTML = '<div class="stat-row"><span class="stat-label" data-i18n="auto.authInfoUnavailable">Auth info unavailable</span></div>';
  }
}

async function loadTokenUsage(elementId, days = 7) {
  const el = document.getElementById(elementId);
  if (!el) return;
  try {
    const res = await api(`/api/usage/${days}`);
    if (res.ok) {
      const d = res;
      el.innerHTML = `
        <div class="stat-row"><span class="stat-label" data-i18n="home.sessions">Sessions</span><span class="stat-value">${d.sessions}</span></div>
        <div class="stat-row"><span class="stat-label" data-i18n="auto.messages">Messages</span><span class="stat-value">${d.messages?.toLocaleString() || 0}</span></div>
        <div class="stat-row"><span class="stat-label" data-i18n="auto.inputTokens2">Input tokens</span><span class="stat-value">${formatNumber(d.inputTokens)}</span></div>
        <div class="stat-row"><span class="stat-label" data-i18n="auto.outputTokens2">Output tokens</span><span class="stat-value">${formatNumber(d.outputTokens)}</span></div>
        <div class="stat-row"><span class="stat-label" data-i18n="auto.totalTokens2">Total tokens</span><span class="stat-value">${formatNumber(d.totalTokens)}</span></div>
        <div class="stat-row"><span class="stat-label" data-i18n="auto.estCost2">Est. cost</span><span class="stat-value">${d.cost || '$0.00'}</span></div>
        <div class="stat-row"><span class="stat-label" data-i18n="auto.activeTime2">Active time</span><span class="stat-value">${d.activeTime || '—'}</span></div>
        ${d.models && d.models.length > 0 ? `
          <div style="margin-top:8px;font-size:10px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:0.06em;" data-i18n="auto.models">Models</div>
          ${d.models.slice(0, 3).map(m => `
            <div class="stat-row">
              <span class="stat-label">${m.name}</span>
              <span class="stat-value">${m.tokens} tokens</span>
            </div>
          `).join('')}
        ` : ''}
        ${d.platforms && d.platforms.length > 0 ? `
          <div style="margin-top:8px;font-size:10px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:0.06em;" data-i18n="home.platforms">Platforms</div>
          ${d.platforms.slice(0, 4).map(p => `
            <div class="stat-row">
              <span class="stat-label">${p.name}</span>
              <span class="stat-value">${p.tokens} tokens</span>
            </div>
          `).join('')}
        ` : ''}
        ${d.topTools && d.topTools.length > 0 ? `
          <div style="margin-top:8px;font-size:10px;color:var(--fg-subtle);text-transform:uppercase;letter-spacing:0.06em;" data-i18n="auto.topTools">Top Tools</div>
          ${d.topTools.slice(0, 3).map(t => `
            <div class="stat-row">
              <span class="stat-label">${t.name}</span>
              <span class="stat-value">${t.calls} (${t.pct})</span>
            </div>
          `).join('')}
        ` : ''}
      `;
    } else {
      el.innerHTML = '<div class="stat-row"><span class="stat-label" data-i18n="auto.noData">No data</span></div>';
    }
  } catch {
    el.innerHTML = '<div class="stat-row"><span class="stat-label" data-i18n="auto.unavailable">Unavailable</span></div>';
  }
}

window.loadHome = loadHome;
export { loadHome, hcirestart, hciupdate, runHCIUpdate, updateHCIInfo, checkHCIUpdates, showCommitListModal, showCommitDiff, checkoutCommit, runUpdateStream, hcidoctor, loadHomeAuth, loadTokenUsage };
