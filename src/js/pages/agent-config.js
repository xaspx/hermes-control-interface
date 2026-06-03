import { state, t } from '../core/state.js';;
import { customConfirm } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { api } from '../core/api.js';
import { escapeHtml } from '../core/utils.js';
import { renderConfigCategory } from './settings.js';

async function loadAgentConfig(container, name) {
  container.innerHTML = `<div class="loading">Loading config for ${name}...</div>`;

  try {
    const res = await api(`/api/config/${name}`);
    if (!res.ok) {
      container.innerHTML = `<div class="card"><div class="card-title" data-i18n="auto.config">Config</div><div class="error-msg">${res.error || 'Failed to load config'}</div></div>`;
      return;
    }

    const config = res.config || {};
    const rawYaml = res.raw_yaml || '';
    const categories = [
      { key: 'model', label: 'Model & Provider', icon: '⚡' },
      { key: 'agent', label: 'Agent Behavior', icon: '🤖' },
      { key: 'terminal', label: 'Terminal', icon: '💻' },
      { key: 'display', label: 'Display & Streaming', icon: '🖥' },
      { key: 'compression', label: 'Context & Compression', icon: '📦' },
      { key: 'platforms', label: 'Platforms', icon: '🌐' },
      { key: 'mcp', label: 'MCP Servers', icon: '🔌' },
    ];

    // Store in state for window functions
    state._config = { config, rawYaml, categories, profile: name };

    container.innerHTML = `
      <div style="margin-bottom:12px;">
        <div class="tabs" id="config-tabs" style="margin:0;">
          ${categories.map((c, i) => `<button class="tab ${i === 0 ? 'active' : ''}" data-cat="${c.key}">${c.label}</button>`).join('')}
          <button class="tab" data-cat="secrets" data-i18n="auto.secretsEnv">Secrets (.env)</button>
          <button class="tab" data-cat="raw" data-i18n="auto.rawYaml">Raw YAML</button>
        </div>
      </div>
      <div id="config-content">
        <div class="loading" data-i18n="auto.loading">Loading...</div>
      </div>
    `;

    // Edit helpers — delegate to global renderConfigCategory (set below)
    window._enableEditLocal = function(type) {
      const contentEl = document.getElementById('config-content');
      if (contentEl) {
        contentEl.dataset.editMode = 'true';
        state._config && (state._config.activeCat = type);
        window.renderConfigCategory(type);
      }
    };
    window._cancelEditLocal = function(type) {
      const contentEl = document.getElementById('config-content');
      if (contentEl) {
        contentEl.dataset.editMode = 'false';
        state._config && (state._config.activeCat = type);
        window.renderConfigCategory(type);
      }
    };
    window.saveSecretsLocal = async function(profile) {
      const inputs = document.querySelectorAll('[data-secret-name]');
      let saved = 0, failed = 0;
      for (const input of inputs) {
        const keyName = input.dataset.secretName;
        const newValue = input.value;
        try {
          const res = await api('/api/keys/' + encodeURIComponent(profile), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
            body: JSON.stringify({ name: keyName, value: newValue })
          });
          if (res.ok) saved++; else { failed++; showToast(t('toast.failedPrefix') + keyName, 'error'); }
        } catch (e) { failed++; showToast(t('toast.errorPrefix') + keyName, 'error'); }
      }
      showToast('Saved ' + saved + ' key(s)' + (failed ? ', ' + failed + ' failed' : ''), failed > 0 ? 'warning' : 'success');
      window.renderConfigCategory('secrets');
    };
    window._saveConfigLocal = async function(profile, catKey) {
      const catConfig = state._config?.config[catKey];
      if (!catConfig) { showToast(t('toast.configNotLoaded'), 'error'); return; }
      const updated = JSON.parse(JSON.stringify(catConfig));
      document.querySelectorAll('[data-cfg-key]').forEach(input => {
        const key = input.dataset.cfgKey;
        const type = input.dataset.cfgType;
        if (type === 'bool') updated[key] = input.checked;
        else if (type === 'num') updated[key] = Number(input.value);
        else updated[key] = input.value;
      });
      try {
        const res = await api('/api/config/' + encodeURIComponent(profile), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
          body: JSON.stringify({ config: { [catKey]: updated } })
        });
        if (res.ok) { state._config.config[catKey] = updated; showToast(t('toast.configSaved'), 'success'); window._cancelEditLocal(catKey); }
        else { showToast(res.output || 'Save failed', 'error'); }
      } catch (e) { showToast(e.message, 'error'); }
    };

    // renderConfigCategory is now global (defined below)

    // Initial render — use global renderConfigCategory (defined below)
    state._config.activeCat = categories[0].key;
    window.renderConfigCategory(categories[0].key);

    // Tab switching
    document.getElementById('config-tabs')?.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      document.querySelectorAll('#config-tabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state._config.activeCat = tab.dataset.cat;
      window.renderConfigCategory(tab.dataset.cat);
    });

  } catch (e) {
    container.innerHTML = `<div class="card"><div class="card-title" data-i18n="common.error">Error</div><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
  }
}

async function loadAgentMemory(container, name) {
  container.innerHTML = `<div class="loading">Loading memory for ${name}...</div>`;

  try {
    const [memoryRes, configRes] = await Promise.all([
      api(`/api/memory/${name}`),
      api(`/api/config/${name}`),
    ]);

    const provider = configRes.ok ? (configRes.config?.memory?.provider || 'built-in') : 'built-in';
    const memory = memoryRes.ok ? memoryRes : {};

    // Build provider-specific section
    let providerSection = '';
    if (provider === 'honcho') {
      const hd = memory.honcho_data || {};
      providerSection = `
        <div class="card">
          <div class="card-title" data-i18n="auto.honchoMemory">Honcho Memory</div>
          <div class="stat-row"><span class="stat-label" data-i18n="home.provider">Provider</span><span class="stat-value status-ok">honcho</span></div>
          <div class="stat-row"><span class="stat-label" data-i18n="auto.status">Status</span><span class="stat-value ${hd.connected ? 'status-ok' : 'status-off'}">${hd.connected ? '● Connected' : '○ Disconnected'}</span></div>
          ${hd.enabled !== undefined ? `<div class="stat-row"><span class="stat-label" data-i18n="auto.enabled">Enabled</span><span class="stat-value">${hd.enabled ? 'Yes' : 'No'}</span></div>` : ''}
          ${hd.host ? `<div class="stat-row"><span class="stat-label" data-i18n="auto.host">Host</span><span class="stat-value">${escapeHtml(hd.host)}</span></div>` : ''}
          ${hd.workspace ? `<div class="stat-row"><span class="stat-label" data-i18n="auto.workspace">Workspace</span><span class="stat-value">${escapeHtml(hd.workspace)}</span></div>` : ''}
          ${hd.ai_peer ? `<div class="stat-row"><span class="stat-label" data-i18n="auto.aiPeer">AI Peer</span><span class="stat-value">${escapeHtml(hd.ai_peer)}</span></div>` : ''}
          ${hd.user_peer ? `<div class="stat-row"><span class="stat-label" data-i18n="auto.userPeer">User Peer</span><span class="stat-value">${escapeHtml(hd.user_peer)}</span></div>` : ''}
          ${hd.session_key ? `<div class="stat-row"><span class="stat-label" data-i18n="auto.session">Session</span><span class="stat-value" style="font-size:11px">${escapeHtml(hd.session_key)}</span></div>` : ''}
          ${hd.recall_mode ? `<div class="stat-row"><span class="stat-label" data-i18n="auto.recallMode">Recall Mode</span><span class="stat-value">${escapeHtml(hd.recall_mode)}</span></div>` : ''}
          ${hd.write_freq ? `<div class="stat-row"><span class="stat-label" data-i18n="auto.writeFreq">Write Freq</span><span class="stat-value">${escapeHtml(hd.write_freq)}</span></div>` : ''}
          ${hd.config_path ? `<div class="stat-row"><span class="stat-label" data-i18n="auto.config">Config</span><span class="stat-value" style="font-size:10px;word-break:break-all">${escapeHtml(hd.config_path)}</span></div>` : ''}
          ${hd.representation ? `
            <details style="margin-top:8px;">
              <summary style="cursor:pointer;color:var(--fg);font-weight:600;font-size:12px;padding:4px 0;" data-i18n="auto.aiRepresentation">AI Representation</summary>
              <pre style="background:var(--bg-inset);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:10px;line-height:1.4;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto;color:var(--fg-muted);">${escapeHtml(hd.representation)}</pre>
            </details>
          ` : ''}
        </div>
      `;
    } else if (provider !== 'built-in') {
      providerSection = `
        <div class="card">
          <div class="card-title">${provider} Memory</div>
          <div class="stat-row"><span class="stat-label" data-i18n="home.provider">Provider</span><span class="stat-value">${provider}</span></div>
          <div class="stat-row"><span class="stat-label" data-i18n="auto.status">Status</span><span class="stat-value">${memory.connected ? '● Connected' : '○ Unknown'}</span></div>
        </div>
      `;
    } else {
      providerSection = `
        <div class="card">
          <div class="card-title" data-i18n="auto.externalProvider">External Provider</div>
          <div class="stat-row"><span class="stat-label" data-i18n="auto.status">Status</span><span class="stat-value" data-i18n="auto.builtinOnlyMemorymdUsermd">Built-in only (MEMORY.md + USER.md)</span></div>
        </div>
      `;
    }

    container.innerHTML = `
      <div class="card-grid">
        <div class="card">
          <div class="card-title" data-i18n="auto.builtinMemory">Built-in Memory</div>
          <div class="stat-row"><span class="stat-label">MEMORY.md</span><span class="stat-value">${memory.memory_chars || 0} / ${memory.memory_max || 2200} chars</span></div>
          <div style="margin-top:8px;">
            <div class="progress-bar">
              <div class="progress-fill ${((memory.memory_chars || 0) / (memory.memory_max || 2200)) > 0.9 ? 'red' : 'green'}" style="width:${Math.min(100, ((memory.memory_chars || 0) / (memory.memory_max || 2200)) * 100)}%;"></div>
            </div>
          </div>
          <div class="stat-row" style="margin-top:8px;"><span class="stat-label">USER.md</span><span class="stat-value">${memory.user_chars || 0} / ${memory.user_max || 1375} chars</span></div>
          <div class="stat-row"><span class="stat-label">SOUL.md</span><span class="stat-value">${memory.soul_chars || 0} chars</span></div>
        </div>
        <div class="card">
          <div class="card-title" data-i18n="auto.fileContents">File Contents</div>
          <details style="margin-bottom:12px;">
            <summary style="cursor:pointer;color:var(--fg);font-weight:600;font-size:13px;padding:8px 0;">MEMORY.md <span style="color:var(--fg-muted);font-weight:400;font-size:11px;">(${memory.memory_chars || 0} chars)</span></summary>
            <pre style="background:var(--bg-inset);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto;color:var(--fg);">${escapeHtml(memory.memory_content || '(empty)')}</pre>
          </details>
          <details style="margin-bottom:12px;">
            <summary style="cursor:pointer;color:var(--fg);font-weight:600;font-size:13px;padding:8px 0;">USER.md <span style="color:var(--fg-muted);font-weight:400;font-size:11px;">(${memory.user_chars || 0} chars)</span></summary>
            <pre style="background:var(--bg-inset);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto;color:var(--fg);">${escapeHtml(memory.user_content || '(empty)')}</pre>
          </details>
          <details>
            <summary style="cursor:pointer;color:var(--fg);font-weight:600;font-size:13px;padding:8px 0;">SOUL.md <span style="color:var(--fg-muted);font-weight:400;font-size:11px;">(${memory.soul_chars || 0} chars)</span></summary>
            <pre style="background:var(--bg-inset);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto;color:var(--fg);">${escapeHtml(memory.soul_content || '(empty)')}</pre>
          </details>
        </div>
        ${providerSection}
      </div>
      <div style="margin-top:16px;">
        <div class="card">
          <div class="card-title" data-i18n="auto.contextCompression">Context Compression</div>
          <div class="stat-row"><span class="stat-label" data-i18n="auto.enabled">Enabled</span><span class="stat-value">${configRes.config?.compression?.enabled ? '✓ Yes' : '✗ No'}</span></div>
          <div class="stat-row"><span class="stat-label" data-i18n="auto.threshold">Threshold</span><span class="stat-value">${configRes.config?.compression?.threshold || '—'}</span></div>
          <div class="stat-row"><span class="stat-label" data-i18n="auto.summaryModel">Summary Model</span><span class="stat-value">${configRes.config?.compression?.summary_model || '—'}</span></div>
        </div>
      </div>
    `;
  } catch (e) {
    container.innerHTML = `<div class="card"><div class="card-title" data-i18n="common.error">Error</div><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
  }
}

async function loadAgentCron(container, name) {
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <div style="display:flex;gap:8px;align-items:center;">
        <span id="cron-scheduler-status" class="badge" data-i18n="auto.loading2">loading...</span>
        <span style="font-size:11px;color:var(--fg-muted);" data-i18n="auto.scheduler">Scheduler</span>
      </div>
      <button class="btn btn-primary btn-sm" onclick="showCreateCronModal('${name}')" data-i18n="auto.createJob">+ Create Job</button>
    </div>
    <div id="cron-list"><div class="loading" data-i18n="auto.loadingCronJobs">Loading cron jobs...</div></div>
  `;
  await loadCronJobs(name);
}

async function loadCronJobs(profile) {
  const el = document.getElementById('cron-list');
  const statusEl = document.getElementById('cron-scheduler-status');
  try {
    const res = await api('/api/hermes-cron/' + encodeURIComponent(profile));
    if (!res.ok) { el.innerHTML = '<div class="error-msg">' + (res.error || 'Failed') + '</div>'; return; }
    if (statusEl) {
      statusEl.textContent = res.schedulerRunning ? '\u25CF running' : '\u25CB stopped';
      statusEl.className = 'badge ' + (res.schedulerRunning ? 'status-ok' : 'status-off');
    }
    const jobs = res.jobs || [];
    if (jobs.length === 0) { el.innerHTML = '<div class="card"><div class="card-title" data-i18n="auto.noCronJobs">No cron jobs</div></div>'; return; }
    el.innerHTML = '<table class="data-table"><thead><tr><th data-i18n="auto.name">Name</th><th data-i18n="auto.schedule">Schedule</th><th data-i18n="auto.status">Status</th><th data-i18n="auto.nextRun">Next Run</th><th data-i18n="auto.actions">Actions</th></tr></thead><tbody>' + jobs.map(function(j) {
      var sc = j.status === 'active' ? 'status-ok' : j.status === 'paused' ? 'status-off' : '';
      var nr = j.nextRun ? new Date(j.nextRun).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '\u2014';
      var act = j.status === 'active'
        ? '<button class="btn btn-ghost btn-sm" onclick="cronAction(\''+profile+'\',\''+j.id+'\',\'pause\')" title="Pause">\u23F8</button> <button class="btn btn-ghost btn-sm" onclick="cronAction(\''+profile+'\',\''+j.id+'\',\'run\')" title="Run">\u25B6</button>'
        : '<button class="btn btn-ghost btn-sm" onclick="cronAction(\''+profile+'\',\''+j.id+'\',\'resume\')" title="Resume">\u23F5</button>';
      return '<tr><td>'+(j.name||j.id)+'</td><td><code style="font-size:11px;">'+j.schedule+'</code></td><td><span class="badge '+sc+'">'+j.status+'</span></td><td style="font-size:11px;color:var(--fg-muted);">'+nr+'</td><td style="display:flex;gap:4px;">'+act+'<button class="btn btn-ghost btn-sm" onclick="showEditCronModal(\''+profile+'\',\''+j.id+'\')" title="Edit">\u270F</button><button class="btn btn-ghost btn-sm btn-danger" onclick="cronRemove(\''+profile+'\',\''+j.id+'\',\''+(j.name||j.id).replace(/'/g, "\\'")+'\')" title="Remove">\u00D7</button></td></tr>';
    }).join('') + '</tbody></table>';
  } catch (e) { el.innerHTML = '<div class="error-msg">'+e.message+'</div>'; }
}

async function cronAction(profile, jobId, action) {
  const labels = { run: 'Run', pause: 'Pause', resume: 'Resume' };
  if (!await customConfirm(`${labels[action] || action} cron job on ${profile}?`, (labels[action] || action) + ' Job')) return;
  try {
    await api('/api/hermes-cron/' + encodeURIComponent(profile) + '/' + jobId + '/' + action, { method: 'POST', headers: { 'X-CSRF-Token': state.csrfToken || '' } });
    showToast('Job ' + action + 'd', 'success');
    setTimeout(function() { loadCronJobs(profile); }, 500);
  } catch (e) { showToast(action + ' failed: ' + e.message, 'error'); }
}

async function cronRemove(profile, jobId, name) {
  if (!await customConfirm('Remove job "' + name + '"?')) return;
  try {
    await api('/api/hermes-cron/' + encodeURIComponent(profile) + '/' + jobId + '/remove', { method: 'POST', headers: { 'X-CSRF-Token': state.csrfToken || '' } });
    showToast(t('toast.jobRemoved'), 'success');
    setTimeout(function() { loadCronJobs(profile); }, 500);
  } catch (e) { showToast(t('toast.removeFailedPrefix') + e.message, 'error'); }
}

function showCreateCronModal(profile) {
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = '<div class="modal-card" style="width:500px;max-width:90vw;"><div class="modal-title" data-i18n="auto.createCronJob">Create Cron Job</div><form id="cron-create-form"><div style="margin-bottom:12px;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;" data-i18n="auto.name">Name</label><input type="text" id="cron-name" placeholder="e.g. Daily health check" style="width:100%;padding:8px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg);font-family:var(--font);font-size:12px;" /></div><div style="margin-bottom:12px;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;" data-i18n="auto.schedule">Schedule</label><div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;"><button type="button" class="btn btn-ghost btn-sm cron-preset" data-val="5m">5m</button><button type="button" class="btn btn-ghost btn-sm cron-preset" data-val="15m">15m</button><button type="button" class="btn btn-ghost btn-sm cron-preset" data-val="30m">30m</button><button type="button" class="btn btn-ghost btn-sm cron-preset" data-val="1h">1h</button><button type="button" class="btn btn-ghost btn-sm cron-preset" data-val="6h">6h</button><button type="button" class="btn btn-ghost btn-sm cron-preset" data-val="12h">12h</button><button type="button" class="btn btn-ghost btn-sm cron-preset" data-val="daily">daily</button></div><input type="text" id="cron-schedule" placeholder="e.g. every 30m or 0 9 * * *" style="width:100%;padding:8px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg);font-family:var(--font);font-size:12px;" required /></div><div style="margin-bottom:12px;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;" data-i18n="auto.promptTaskInstruction">Prompt (task instruction)</label><textarea id="cron-prompt" rows="3" placeholder="Check system health and report" style="width:100%;resize:vertical;font-family:var(--font);font-size:12px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg);padding:8px;"></textarea></div><div style="display:flex;gap:8px;margin-bottom:12px;"><div style="flex:1;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;" data-i18n="auto.deliver">Deliver</label><select id="cron-deliver" class="log-level-select" style="width:100%;"><option value="origin">origin</option><option value="local">local</option><option value="telegram">telegram</option><option value="discord">discord</option><option value="slack">slack</option><option value="whatsapp">whatsapp</option><option value="signal">signal</option><option value="matrix">matrix</option><option value="mattermost">mattermost</option><option value="email">email</option><option value="sms">sms</option><option value="homeassistant">homeassistant</option><option value="dingtalk">dingtalk</option><option value="feishu">feishu</option><option value="wecom">wecom</option><option value="weixin">weixin</option><option value="bluebubbles">bluebubbles</option></select></div><div style="flex:1;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;" data-i18n="auto.repeat">Repeat</label><select id="cron-repeat" class="log-level-select" style="width:100%;"><option value="">forever</option><option value="1">once</option><option value="5" data-i18n="auto.5Times">5 times</option><option value="10" data-i18n="auto.10Times">10 times</option><option value="50" data-i18n="auto.50Times">50 times</option></select></div></div><div class="modal-actions"><button type="button" class="btn btn-ghost" id="cron-cancel" data-i18n="auto.cancel">Cancel</button><button type="submit" class="btn btn-primary" data-i18n="auto.createJob2">Create Job</button></div></form></div>';
  document.body.appendChild(overlay);
  overlay.querySelectorAll('.cron-preset').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.getElementById('cron-schedule').value = btn.dataset.val;
      overlay.querySelectorAll('.cron-preset').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
    });
  });
  overlay.querySelector('#cron-cancel').addEventListener('click', function() { overlay.remove(); });
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#cron-create-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var schedule = document.getElementById('cron-schedule').value.trim();
    var prompt = document.getElementById('cron-prompt').value.trim();
    var name = document.getElementById('cron-name').value.trim();
    var deliver = document.getElementById('cron-deliver').value;
    var repeat = document.getElementById('cron-repeat').value;
    if (!schedule) { showToast(t('toast.scheduleRequired'), 'error'); return; }
    if (!prompt) { showToast(t('toast.promptRequired'), 'error'); return; }
    try {
      var res = await api('/api/hermes-cron/' + encodeURIComponent(profile) + '/create', {
        method: 'POST',
        headers: { 'X-CSRF-Token': state.csrfToken || '' },
        body: JSON.stringify({ schedule: schedule, prompt: prompt, name: name, deliver: deliver, repeat: repeat }),
      });
      if (res.ok) { showToast(t('toast.cronCreated'), 'success'); overlay.remove(); setTimeout(function() { loadCronJobs(profile); }, 500); }
      else { showToast(res.error || 'Create failed', 'error'); }
    } catch (err) { showToast(t('toast.createFailedPrefix') + err.message, 'error'); }
  });
}

window.loadAgentConfig = loadAgentConfig;
window.loadAgentMemory = loadAgentMemory;
window.loadAgentCron = loadAgentCron;
window.loadCronJobs = loadCronJobs;
window.cronAction = cronAction;
window.cronRemove = cronRemove;
window.showCreateCronModal = showCreateCronModal;

window.showEditCronModal = async function(profile, jobId) {
  let res;
  try { res = await api('/api/hermes-cron/' + encodeURIComponent(profile)); }
  catch (e) { showToast('Could not load job: ' + e.message, 'error'); return; }
  if (!res.ok || !res.jobs) { showToast('Could not load job', 'error'); return; }
  const job = res.jobs.find(j => j.id === jobId);
  if (!job) { showToast('Job not found', 'error'); return; }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = '<div class="modal-card" style="width:500px;max-width:90vw;"><div class="modal-title">Edit Cron Job</div><form id="cron-edit-form"><div style="margin-bottom:12px;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Name</label><input type="text" id="cron-edit-name" value="'+escapeHtml(job.name||'')+'" placeholder="e.g. Daily health check" style="width:100%;padding:8px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg);font-size:12px;" /></div><div style="margin-bottom:12px;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Schedule</label><div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;"><button type="button" class="btn btn-ghost btn-sm cron-edit-preset" data-val="5m">5m</button><button type="button" class="btn btn-ghost btn-sm cron-edit-preset" data-val="15m">15m</button><button type="button" class="btn btn-ghost btn-sm cron-edit-preset" data-val="30m">30m</button><button type="button" class="btn btn-ghost btn-sm cron-edit-preset" data-val="1h">1h</button><button type="button" class="btn btn-ghost btn-sm cron-edit-preset" data-val="6h">6h</button><button type="button" class="btn btn-ghost btn-sm cron-edit-preset" data-val="12h">12h</button><button type="button" class="btn btn-ghost btn-sm cron-edit-preset" data-val="daily">daily</button></div><input type="text" id="cron-edit-schedule" value="'+escapeHtml(job.schedule||'')+'" placeholder="e.g. every 30m or 0 9 * *" style="width:100%;padding:8px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg);font-size:12px;" required /></div><div style="margin-bottom:12px;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Prompt</label><textarea id="cron-edit-prompt" rows="4" style="width:100%;padding:8px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg);font-size:12px;resize:vertical;">'+escapeHtml(job.prompt||'')+'</textarea></div><div style="margin-bottom:12px;display:flex;gap:12px;"><div style="flex:1;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Deliver</label><select id="cron-edit-deliver" style="width:100%;padding:6px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg);font-size:12px;"><option value="origin">Origin (this chat)</option><option value="local">Local only</option><option value="all">All channels</option></select></div><div style="flex:1;"><label style="font-size:11px;color:var(--fg-muted);display:block;margin-bottom:4px;">Repeat (empty=forever)</label><input type="number" id="cron-edit-repeat" min="0" placeholder="e.g. 3" style="width:100%;padding:6px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg);font-size:12px;" /></div></div><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;"><button type="button" class="btn btn-ghost" id="cron-edit-cancel">Cancel</button><button type="submit" class="btn btn-primary">Save Changes</button></div></form></div>';
  document.body.appendChild(overlay);

  const deliver = job.deliver || 'origin';
  const repeat = job.repeat !== undefined ? String(job.repeat) : '';
  const delSel = overlay.querySelector('#cron-edit-deliver');
  if (delSel) delSel.value = Array.from(delSel.options).some(o => o.value === deliver) ? deliver : 'origin';
  const repSel = overlay.querySelector('#cron-edit-repeat');
  if (repSel) repSel.value = Array.from(repSel.options).some(o => o.value === repeat) ? repeat : '';

  overlay.querySelectorAll('.cron-edit-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('cron-edit-schedule').value = btn.dataset.val;
      overlay.querySelectorAll('.cron-edit-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  overlay.querySelector('#cron-edit-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#cron-edit-form').addEventListener('submit', async e => {
    e.preventDefault();
    const schedule = document.getElementById('cron-edit-schedule').value.trim();
    const prompt = document.getElementById('cron-edit-prompt').value.trim();
    const name = document.getElementById('cron-edit-name').value.trim();
    const deliverVal = document.getElementById('cron-edit-deliver').value;
    const repeatVal = document.getElementById('cron-edit-repeat').value;
    if (!schedule) { showToast('Schedule required', 'error'); return; }
    try {
      const res2 = await api('/api/hermes-cron/' + encodeURIComponent(profile) + '/' + jobId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
        body: JSON.stringify({ schedule, prompt, name, deliver: deliverVal, repeat: repeatVal || undefined }),
      });
      if (res2.ok) { showToast('Cron updated', 'success'); overlay.remove(); setTimeout(() => loadCronJobs(profile), 500); }
      else showToast(res2.error || 'Update failed', 'error');
    } catch (err) { showToast('Update failed: ' + err.message, 'error'); }
  });
};

export { loadAgentConfig, loadAgentMemory, loadAgentCron, loadCronJobs, cronAction, cronRemove, showCreateCronModal };
