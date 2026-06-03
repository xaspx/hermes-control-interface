import { state, t } from '../core/state.js';;
import { customAlert, customConfirm, showModal } from '../components/modal.js';
import { startNotifPolling } from '../components/notifications.js';
import { showToast } from '../components/toast.js';
import { api } from '../core/api.js';
import { escapeHtml } from '../core/utils.js';
import { loadAgents, sseProgressModal } from './agents.js';
import { checkHCIUpdates, hcirestart, runUpdateStream, updateHCIInfo } from './home.js';

async function loadMaintenance(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title" data-i18n="auto.maintenance">Maintenance</div>
        <div class="page-subtitle" data-i18n="auto.systemToolsAndDiagnostics">System tools and diagnostics</div>
      </div>
    </div>
    <div class="card-grid" id="maintenance-grid">
      <div class="card">
        <div class="card-title" data-i18n="auto.healthCheck">Health Check</div>
        <div id="health-check-results">
          <div style="font-size:12px;color:var(--fg-muted);margin-bottom:8px;" data-i18n="auto.testAllHciApiEndpoints">Test all HCI API endpoints</div>
        </div>
        <div class="card-actions" style="margin-top:8px;">
          <button class="btn btn-ghost" onclick="runHealthCheck()" data-i18n="auto.checkApis">🔌 Check APIs</button>
          <button class="btn btn-ghost" onclick="hcirestart()" data-i18n="auto.restartHci">⟲ Restart HCI</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title" data-i18n="auto.hciUpdate2">🎯 HCI Update</div>
        <div class="hci-version-info" style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
          <div class="stat-item">
            <span class="stat-label" data-i18n="auto.version">Version</span>
            <span class="stat-value" id="hci-current-version">—</span>
          </div>
          <div class="stat-item">
            <span class="stat-label" data-i18n="auto.commit">Commit</span>
            <span class="stat-value"><code id="hci-current-commit">—</code></span>
          </div>
          <div class="stat-item">
            <span class="stat-label" data-i18n="auto.branch">Branch</span>
            <span class="stat-value"><code id="hci-current-branch">—</code></span>
          </div>
          <div class="stat-item" id="hci-behind-badge" style="display:none;">
            <span class="stat-label" data-i18n="auto.behind">Behind</span>
            <span class="stat-value"><span class="badge badge-warning" id="hci-commits-behind">0</span></span>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="checkHCIUpdates()" data-i18n="auto.checkUpdates2">Check Updates</button>
          <button class="btn btn-outline" onclick="runUpdateStream('/api/hci/update')" data-i18n="auto.updateAll">Update All</button>
          <button class="btn btn-ghost" onclick="runUpdateStream('/api/hci/rollback')" data-i18n="auto.rollback">⟲ Rollback</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title" data-i18n="auto.doctor">Doctor</div>
        <div class="stat-row"><span class="stat-label" data-i18n="auto.runDiagnostics">Run diagnostics</span></div>
        <div class="card-actions" style="margin-top:8px;">
          <button class="btn btn-ghost" onclick="runDoctor()" data-i18n="auto.runDiagnose">Run Diagnose</button>
          <button class="btn btn-ghost" onclick="runDoctor(true)" data-i18n="auto.autofix2">Auto-fix</button>
        </div>
        <div id="doctor-result" style="margin-top:8px;max-height:500px;overflow-y:auto;"></div>
      </div>
      <div class="card">
        <div class="card-title" data-i18n="auto.dump">Dump</div>
        <div class="stat-row"><span class="stat-label" data-i18n="auto.setupSummaryForDebugging">Setup summary for debugging</span></div>
        <div class="card-actions" style="margin-top:8px;">
          <button class="btn btn-ghost" onclick="runDump()" data-i18n="auto.generateDump">Generate Dump</button>
        </div>
        <div id="dump-result" style="margin-top:8px;"></div>
      </div>
      <div class="card">
        <div class="card-title" data-i18n="auto.hermesUpdate">Hermes Update</div>
        <div class="stat-row"><span class="stat-label" data-i18n="auto.version">Version</span><span class="stat-value" id="update-version">—</span></div>
        <div class="card-actions" style="margin-top:8px;">
          <button class="btn btn-ghost" onclick="runUpdate()" data-i18n="auto.updateHermes">Update Hermes</button>
        </div>
        <div id="update-result" style="margin-top:8px;"></div>
      </div>
      <div class="card">
        <div class="card-title" data-i18n="auto.backupImport">Backup & Import</div>
        <div style="font-size:12px;color:var(--fg-muted);margin-bottom:10px;" data-i18n="auto.createAndRestoreHermesDataBackups">Create and restore Hermes data backups</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-ghost" onclick="createBackup()" data-i18n="auto.createBackup">📦 Create Backup</button>
          <label class="btn btn-ghost" style="cursor:pointer;margin:0;">
            📥 Import<input type="file" accept=".zip" onchange="importBackup(this)" style="display:none;" />
          </label>
        </div>
        <div id="backup-result" style="margin-top:8px;"></div>
      </div>
      <div class="card">
        <div class="card-title" data-i18n="auto.hciInfo">HCI Info</div>
        <div class="stat-row"><span class="stat-label">GitHub</span><span class="stat-value"><a href="https://github.com/xaspx/hermes-control-interface" target="_blank" style="color:var(--accent);text-decoration:none;">🔗 xaspx/hermes-control-interface</a></span></div>
        <div class="stat-row"><span class="stat-label">Twitter</span><span class="stat-value"><a href="https://x.com/bayendor" target="_blank" style="color:var(--accent);text-decoration:none;">@bayendor</a></span></div>
      </div>
    </div>
  `;

  // Load version
  try {
    const healthRes = await api('/api/system/health');
    if (healthRes.ok) {
      document.getElementById('update-version').textContent = healthRes.hermes_version || '—';
    }
  } catch {}

  // Auto-check HCI updates on page load (silent — no modal)
  updateHCIInfo();
}

async function createBackup() {
  if (!await customConfirm(t('dialog.confirmBackup'), 'Create Backup')) return;
  await sseProgressModal('📦 Creating Backup', '/api/backup/create', {
    method: 'POST',
    headers: { 'X-CSRF-Token': state.csrfToken || '' },
    autoCloseMs: 3000,
    onSuccess: () => { showToast(t('toast.backupDownloaded'), 'success'); },
  });
}

async function importBackup(input) {
  if (!input.files?.[0]) return;
  const file = input.files[0];
  if (!file.name.endsWith('.zip')) return showToast(t('toast.selectZipFile'), 'error');
  if (!await customConfirm(t('dialog.confirmImport'), 'Import Backup')) { input.value = ''; return; }

  const formData = new FormData();
  formData.append('backup', file);

  await sseProgressModal('📥 Importing Backup', '/api/backup/import', {
    method: 'POST',
    headers: { 'X-CSRF-Token': state.csrfToken || '' },
    body: formData,
    autoCloseMs: 4000,
    onSuccess: () => { showToast(t('toast.backupImported'), 'success'); },
  });
  input.value = '';
}

async function loadAuth() {
  try {
    const res = await api('/api/auth/providers');
    const el = document.getElementById('auth-list');
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
    document.getElementById('auth-list').innerHTML = '<div class="stat-row"><span class="stat-label" data-i18n="auto.authInfoUnavailable">Auth info unavailable</span></div>';
  }
}

async function loadAudit() {
  try {
    const res = await api('/api/audit');
    const el = document.getElementById('audit-log');
    if (res.ok && res.entries && res.entries.length > 0) {
      el.innerHTML = res.entries.slice(0, 10).map(line => {
        // Parse: [timestamp] [user] [role] ACTION: details
        const match = line.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.+)$/);
        if (match) {
          const [, ts, user, role, action] = match;
          const time = new Date(ts).toLocaleString();
          const isDenied = action.includes('DENIED');
          return `<div style="font-size:11px;padding:3px 0;color:${isDenied ? 'var(--red)' : 'var(--fg-muted)'};">
            <span style="color:var(--fg-subtle);">${time}</span>
            <span style="color:var(--accent);margin:0 4px;">${user}</span>
            ${action}
          </div>`;
        }
        return `<div style="font-size:11px;padding:2px 0;color:var(--fg-muted);">${escapeHtml(line)}</div>`;
      }).join('');
    } else {
      el.innerHTML = '<div class="stat-row"><span class="stat-label" data-i18n="auto.noAuditEntries">No audit entries</span></div>';
    }
  } catch {
    document.getElementById('audit-log').innerHTML = '<div class="stat-row"><span class="stat-label" data-i18n="auto.auditUnavailable">Audit unavailable</span></div>';
  }
}

function parseDoctorOutput(raw) {
  const lines = raw.split(/\r?\n/);
  const sections = [];
  let current = null;
  let totalPass = 0, totalFail = 0, totalWarn = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip header box
    if (/^[┌└─│┐┘]+$/.test(trimmed)) continue;
    if (/🩺/.test(trimmed)) continue;
    // Empty line flushes current section
    if (!trimmed) { if (current && current.items.length) { sections.push(current); current = null; } continue; }
    // Section header: ◆ Name
    const secMatch = trimmed.match(/^◆\s+(.+)/);
    if (secMatch) {
      if (current && current.items.length) sections.push(current);
      current = { name: secMatch[1], items: [] };
      continue;
    }
    if (!current) continue;
    // Item: ✓ pass, ✗ fail, ⚠ warning
    const itemMatch = trimmed.match(/^([✓✗⚠])\s+(.+)/);
    if (itemMatch) {
      const status = itemMatch[1] === '✓' ? 'pass' : itemMatch[1] === '✗' ? 'fail' : 'warn';
      if (status === 'pass') totalPass++;
      else if (status === 'fail') totalFail++;
      else totalWarn++;
      current.items.push({ status, text: itemMatch[2], suggestion: null });
      continue;
    }
    // Suggestion: → text
    const sugMatch = trimmed.match(/^→\s+(.+)/);
    if (sugMatch && current.items.length) {
      current.items[current.items.length - 1].suggestion = sugMatch[1];
      continue;
    }
  }
  if (current && current.items.length) sections.push(current);
  return { sections, totalPass, totalFail, totalWarn };
}

function renderDoctorOutput(raw) {
  const { sections, totalPass, totalFail, totalWarn } = parseDoctorOutput(raw);
  const total = totalPass + totalFail + totalWarn;
  if (!sections.length) return `<pre style="font-size:11px;white-space:pre-wrap;color:var(--fg-muted);">${escapeHtml(raw)}</pre>`;

  const statusIcon = (s) => s === 'pass' ? '✓' : s === 'fail' ? '✗' : '⚠';
  const statusClass = (s) => s === 'pass' ? 'doctor-pass' : s === 'fail' ? 'doctor-fail' : 'doctor-warn';

  let html = '';

  // Summary bar
  html += `<div class="doctor-summary">`;
  html += `<div class="doctor-summary-item doctor-pass"><span class="doctor-dot"></span>${totalPass} passed</div>`;
  if (totalWarn) html += `<div class="doctor-summary-item doctor-warn"><span class="doctor-dot"></span>${totalWarn} warnings</div>`;
  if (totalFail) html += `<div class="doctor-summary-item doctor-fail"><span class="doctor-dot"></span>${totalFail} failed</div>`;
  html += `<div class="doctor-summary-total">${total} checks</div>`;
  html += `</div>`;

  // Sections
  for (const sec of sections) {
    const hasFail = sec.items.some(i => i.status === 'fail');
    const hasWarn = sec.items.some(i => i.status === 'warn');
    const secStatus = hasFail ? 'fail' : hasWarn ? 'warn' : 'pass';
    html += `<div class="doctor-section ${statusClass(secStatus)}">`;
    html += `<div class="doctor-section-header"><span class="doctor-dot"></span>${escapeHtml(sec.name)}</div>`;
    for (const item of sec.items) {
      html += `<div class="doctor-item">`;
      html += `<span class="doctor-item-icon ${statusClass(item.status)}">${statusIcon(item.status)}</span>`;
      html += `<span class="doctor-item-text">${escapeHtml(item.text)}</span>`;
      html += `</div>`;
      if (item.suggestion) {
        html += `<div class="doctor-suggestion">→ ${escapeHtml(item.suggestion)}</div>`;
      }
    }
    html += `</div>`;
  }
  return html;
}

async function runHealthCheck() {
  if (!await customConfirm(t('dialog.confirmHealthCheck'), 'Health Check')) return;
  const el = document.getElementById('health-check-results');
  if (!el) return;
  el.innerHTML = '<div class="loading" data-i18n="auto.testingApis">Testing APIs...</div>';
  const endpoints = [
    { name: 'Health', url: '/api/health' },
    { name: 'System', url: '/api/system/health' },
    { name: 'Auth Status', url: '/api/auth/status' },
    { name: 'Profiles', url: '/api/profiles' },
    { name: 'Sessions', url: '/api/all-sessions?profile=default' },
  ];
  const results = [];
  for (const ep of endpoints) {
    const start = performance.now();
    try {
      const res = await api(ep.url);
      const ms = Math.round(performance.now() - start);
      results.push({ name: ep.name, ok: res.ok !== false, ms, error: res.error });
    } catch (e) {
      results.push({ name: ep.name, ok: false, ms: Math.round(performance.now() - start), error: e.message });
    }
  }
  const allOk = results.every(r => r.ok);
  el.innerHTML = results.map(r => `
    <div class="stat-row">
      <span class="stat-label">${r.name}</span>
      <span class="stat-value ${r.ok ? 'status-ok' : 'status-off'}">${r.ok ? '● OK' : '○ FAIL'} <span style="font-size:10px;opacity:0.6;">${r.ms}ms</span></span>
    </div>
  `).join('') + `<div style="margin-top:8px;font-size:11px;color:var(--fg-muted);">${allOk ? 'All endpoints healthy' : 'Some endpoints failed'}</div>`;
}

async function runDoctor(fix = false) {
  const msg = fix ? 'Run diagnostics with auto-fix? This may modify system settings.' : 'Run diagnostics? This is read-only.';
  if (!await customConfirm(msg, fix ? 'Auto-fix' : 'Diagnostics')) return;
  const el = document.getElementById('doctor-result');
  el.innerHTML = '<div class="loading" data-i18n="auto.runningDiagnostics">Running diagnostics...</div>';
  try {
    const csrfToken = state.csrfToken || '';
    const response = await fetch('/api/doctor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      credentials: 'include',
      body: JSON.stringify({ fix }),
    });
    if (!response.ok) {
      el.innerHTML = `<div class="error-msg">HTTP ${response.status}</div>`;
      return;
    }
    // Read SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullOutput = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';
      for (const line of parts) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'progress') {
            fullOutput += data.line + '\n';
          } else if (data.type === 'done') {
            fullOutput = data.output || fullOutput;
          }
        } catch {}
      }
    }
    if (fullOutput.trim()) {
      el.innerHTML = renderDoctorOutput(fullOutput.trim());
    } else {
      el.innerHTML = '<div class="error-msg" data-i18n="auto.noOutputReceived">No output received</div>';
    }
  } catch (e) {
    el.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
  }
}

async function runDump() {
  if (!await customConfirm(t('dialog.confirmSystemDump'), 'Generate Dump')) return;
  const el = document.getElementById('dump-result');
  el.innerHTML = '<div class="loading" data-i18n="auto.generatingDump">Generating dump...</div>';
  try {
    const res = await api('/api/dump');
    el.innerHTML = `<pre style="font-size:10px;white-space:pre-wrap;max-height:300px;overflow-y:auto;color:var(--fg-muted);">${escapeHtml(res.output || 'No output')}</pre>`;
  } catch (e) {
    el.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
  }
}

async function runUpdate() {
  if (!await customConfirm(t('dialog.confirmUpdateHermes'))) return;
  // Pause notification polling during update to avoid false network errors
  const wasPolling = state.notifInterval;
  if (state.notifInterval) { clearInterval(state.notifInterval); state.notifInterval = null; }
  await sseProgressModal('⬆ Updating Hermes', '/api/update', {
    method: 'POST',
    headers: { 'X-CSRF-Token': state.csrfToken || '' },
    autoCloseMs: 3000,
    onSuccess: () => { if (wasPolling) startNotifPolling(); },
    onError: () => { if (wasPolling) startNotifPolling(); },
  });
}

async function showCreateAgent() {
  const result = await showModal({
    title: 'Create Agent',
    message: 'Create a new Hermes profile.',
    inputs: [
      { placeholder: 'Agent name (e.g. worker, analyst)', type: 'text' },
    ],
    buttons: [
      { text: 'Cancel', value: null },
      { text: 'Create Fresh', primary: true, value: 'fresh' },
      { text: 'Clone From...', value: 'clone_from' },
    ],
  });

  if (!result || result.action === null) return;

  const name = result.inputs[0] || '';
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
  if (!safeName) {
    await customAlert(t('dialog.enterAgentName'), 'Name Required');
    return;
  }

  let body = { name: safeName };

  if (result.action === 'clone_from') {
    const sourceResult = await showModal({
      title: `Clone "${safeName}" From`,
      message: `Clone settings from which profile?`,
      inputs: [{ placeholder: 'Source profile (e.g. david)', value: 'david' }],
      buttons: [
        { text: 'Cancel', value: null },
        { text: 'Clone', primary: true, value: 'ok' },
      ],
    });
    if (!sourceResult || sourceResult.action === null) return;
    const source = (sourceResult.inputs[0] || 'david').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!source) {
      await customAlert(t('dialog.invalidProfileName'), 'Error');
      return;
    }
    body.cloneArg = '--clone-from';
    body.cloneSource = source;
  }

  try {
    const csrfToken = state.csrfToken || '';
    const res = await api('/api/profiles/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      showToast(`Agent ${safeName} created!`, 'success');
      loadAgents(document.querySelector('.page.active'));
    } else {
      await customAlert(res.error || 'Failed to create agent', 'Error');
    }
  } catch (e) {
    await customAlert(e.message, 'Error');
  }
}

window.loadMaintenance = loadMaintenance;
window.createBackup = createBackup;
window.importBackup = importBackup;
window.loadAuth = loadAuth;
window.loadAudit = loadAudit;
window.runHealthCheck = runHealthCheck;
window.runDoctor = runDoctor;
window.runDump = runDump;
window.runUpdate = runUpdate;
window.showCreateAgent = showCreateAgent;
export { loadMaintenance, createBackup, importBackup, loadAuth, loadAudit, parseDoctorOutput, renderDoctorOutput, runHealthCheck, runDoctor, runDump, runUpdate, showCreateAgent };
