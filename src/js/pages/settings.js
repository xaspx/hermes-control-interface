import { state, t } from '../core/state.js';
import { api } from '../core/api.js';
import { escapeHtml } from '../core/utils.js';
import { showToast } from '../components/toast.js';
import { customAlert, customConfirm } from '../components/modal.js';

function renderPlatformsTab(contentEl, config, profile, isEditMode) {
  const apiServer = config.platforms?.api_server || {};
  const enabled = apiServer.enabled || false;
  const extra = apiServer.extra || {};
  const port = extra.port || '—';
  const host = extra.host || '—';
  const cors = extra.cors_origins || '—';
  const keySet = extra.key ? '✅ Set' : '❌ Not set';

  if (isEditMode) {
    contentEl.innerHTML = `
      <div class="card">
        <div class="card-title" data-i18n="auto.platformsGatewayApi">🌐 Platforms — Gateway API</div>
        <div style="display:flex;flex-direction:column;gap:12px;margin-top:12px;">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" id="cfg-platforms-enabled" ${enabled ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--gold);" />
            <span style="font-size:13px;" data-i18n="auto.gatewayApiEnabled">Gateway API Enabled</span>
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;">
            <span style="font-size:12px;color:var(--fg-muted);" data-i18n="auto.host">Host</span>
            <input type="text" id="cfg-platforms-host" value="${escapeHtml(host)}" style="padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-size:13px;" />
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;">
            <span style="font-size:12px;color:var(--fg-muted);" data-i18n="auto.port">Port</span>
            <input type="number" id="cfg-platforms-port" value="${port !== '—' ? port : ''}" style="padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-size:13px;" />
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;">
            <span style="font-size:12px;color:var(--fg-muted);" data-i18n="auto.apiKey">API Key</span>
            <input type="password" id="cfg-platforms-key" value="${escapeHtml(extra.key || '')}" style="padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-size:13px;" />
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;">
            <span style="font-size:12px;color:var(--fg-muted);" data-i18n="auto.corsOriginsCommaseparated">CORS Origins (comma-separated)</span>
            <input type="text" id="cfg-platforms-cors" value="${escapeHtml(cors !== '—' ? cors : '')}" style="padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-size:13px;" />
          </label>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-primary" onclick="savePlatformsConfig('${escapeHtml(profile)}')" data-i18n="auto.save">💾 Save</button>
            <button class="btn" onclick="cancelEdit('platforms')" data-i18n="auto.cancel">Cancel</button>
          </div>
        </div>
      </div>
    `;
    return;
  }

  // Read-only view
  const statusColor = enabled ? 'var(--green)' : 'var(--red)';
  const statusText = enabled ? 'Active' : 'Disabled';
  contentEl.innerHTML = `
    <div class="card">
      <div class="card-title" data-i18n="auto.platformsGatewayApi">🌐 Platforms — Gateway API</div>
      <div class="stat-row">
        <span class="stat-label" data-i18n="auto.status">Status</span>
        <span style="color:${statusColor};font-weight:600;">${statusText}</span>
      </div>
      ${enabled ? `
      <div class="stat-row"><span class="stat-label" data-i18n="auto.host">Host</span><span>${escapeHtml(host)}</span></div>
      <div class="stat-row"><span class="stat-label" data-i18n="auto.port">Port</span><span style="color:var(--gold);font-weight:600;">${port}</span></div>
      <div class="stat-row"><span class="stat-label" data-i18n="auto.apiKey">API Key</span><span>${keySet}</span></div>
      <div class="stat-row"><span class="stat-label">CORS</span><span style="font-size:11px;">${escapeHtml(cors)}</span></div>
      ` : '<div class="stat-row"><span class="stat-label" style="color:var(--fg-muted);" data-i18n="auto.gatewayApiIsNotConfiguredClickEditToEnable">Gateway API is not configured. Click Edit to enable.</span></div>'}
      <div style="margin-top:12px;">
        <button class="btn btn-primary" onclick="enableEdit('platforms')" data-i18n="auto.edit">✏️ Edit</button>
      </div>
    </div>
  `;
}

function renderConfigCategory(catKey) {
  const contentEl = document.getElementById('config-content');
  if (!contentEl || !state._config) return;
  const isEditMode = contentEl.dataset.editMode === 'true';
  const { config, rawYaml, profile } = state._config;

  if (catKey === 'raw') {
    contentEl.innerHTML = `<div class="card"><div class="card-title" data-i18n="auto.rawConfig">Raw Config</div><pre style="font-size:11px;white-space:pre-wrap;max-height:500px;overflow-y:auto;color:var(--fg-muted);">${escapeHtml(rawYaml || JSON.stringify(config, null, 2))}</pre></div>`;
    return;
  }

  if (catKey === 'secrets') {
    loadSecretsTab(contentEl, profile, isEditMode);
    return;
  }

  if (catKey === 'platforms') {
    renderPlatformsTab(contentEl, config, profile, isEditMode);
    return;
  }

  const catConfig = config[catKey];
  if (!catConfig || (typeof catConfig === 'object' && Object.keys(catConfig).length === 0)) {
    contentEl.innerHTML = `<div class="card"><div class="card-title">${catKey}</div><div class="stat-row"><span class="stat-label" data-i18n="auto.noSettingsConfigured">No settings configured</span></div></div>`;
    return;
  }

  if (isEditMode) {
    // Form-based editing: each field gets its own input
    const fieldRows = Object.entries(catConfig).map(([k, v]) => {
      const isObj = typeof v === 'object' && v !== null;
      const isBool = typeof v === 'boolean';
      const isNum = typeof v === 'number';
      const isSensitive = /key|token|secret|password|passwd/i.test(k);

      if (isObj) {
        // Nested object — show collapsed with raw JSON viewer
        return `
          <div style="margin-bottom:12px;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;">
            <div style="background:var(--bg-inset);padding:8px 12px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
              <span style="font-size:12px;font-weight:600;color:var(--fg);">${escapeHtml(k)}</span>
              <span style="font-size:11px;color:var(--fg-muted);">${Object.keys(v).length} nested values ▾</span>
            </div>
            <div style="display:none;padding:8px;">
              <textarea id="cfg-nested-${escapeHtml(k)}" style="width:100%;min-height:120px;font-family:var(--font-mono,monospace);font-size:11px;background:var(--bg-input);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:8px;resize:vertical;" spellcheck="false">${escapeHtml(JSON.stringify(v, null, 2))}</textarea>
            </div>
          </div>
        `;
      }

      if (isBool) {
        return `
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;min-width:200px;">
              <input type="checkbox" id="cfg-${escapeHtml(k)}" ${v ? 'checked' : ''} data-cfg-key="${escapeHtml(k)}" data-cfg-type="bool"
                style="width:16px;height:16px;accent-color:var(--gold);cursor:pointer;" />
              <span style="font-size:12px;color:var(--fg);">${escapeHtml(k)}</span>
            </label>
            <span style="font-size:11px;color:var(--fg-muted);">boolean</span>
          </div>
        `;
      }

      if (isNum) {
        return `
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
            <label style="min-width:200px;">
              <span style="font-size:12px;color:var(--fg);">${escapeHtml(k)}</span>
            </label>
            <input type="number" id="cfg-${escapeHtml(k)}" value="${v}" data-cfg-key="${escapeHtml(k)}" data-cfg-type="num"
              style="flex:1;background:var(--bg-input);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:12px;" />
          </div>
        `;
      }

      // String value
      const inputType = isSensitive ? 'password' : 'text';
      return `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
          <label style="min-width:200px;">
            <span style="font-size:12px;color:var(--fg);">${escapeHtml(k)}</span>
          </label>
          <div style="display:flex;flex:1;gap:4px;">
            <input type="${inputType}" id="cfg-${escapeHtml(k)}" value="${escapeHtml(String(v ?? ''))}" data-cfg-key="${escapeHtml(k)}" data-cfg-type="str"
              style="flex:1;background:var(--bg-input);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:12px;" />
            ${isSensitive ? `<button type="button" onclick="this.previousElementSibling.type=this.previousElementSibling.type==='password'?'text':'password'" style="background:none;border:none;cursor:pointer;font-size:14px;padding:4px;color:var(--fg-muted);">👁</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    contentEl.innerHTML = `
      <div class="card">
        <div class="card-title">${catKey} — Editing</div>
        <div style="max-height:60vh;overflow-y:auto;padding-right:4px;">
          ${fieldRows}
        </div>
        <div style="display:flex;gap:8px;margin-top:14px;">
          <button class="btn btn-primary" onclick="window.saveConfigForm('${profile}','${catKey}')" data-i18n="auto.saveChanges2">💾 Save changes</button>
          <button class="btn btn-ghost" onclick="window.cancelEdit('${catKey}')" data-i18n="auto.revert">↺ Revert</button>
        </div>
      </div>
    `;
  } else {
    // View mode: stat rows with Edit button
    let rows = '';
    if (typeof catConfig === 'object') {
      rows = Object.entries(catConfig).map(([k, v]) => {
        const isObj = typeof v === 'object' && v !== null;
        const isBool = typeof v === 'boolean';
        let display, cls;
        if (isBool) {
          display = v ? '✓ enabled' : '✗ disabled';
          cls = v ? 'status-ok' : 'status-off';
        } else if (isObj) {
          display = `{${Object.keys(v).length} keys}`;
          cls = '';
        } else {
          display = String(v ?? '');
          cls = '';
        }
        return `<div class="stat-row"><span class="stat-label">${escapeHtml(k)}</span><span class="stat-value ${cls}">${escapeHtml(display)}</span></div>`;
      }).join('');
    }
    // Edit button at TOP (not bottom)
    const editBtn = `
      <div style="margin-bottom:12px;">
        <button class="btn btn-primary" onclick="window._enableEditLocal('${catKey}')">✏️ Edit ${state._config?.categories?.find(c => c.key === catKey)?.label || catKey}</button>
      </div>
    `;
    contentEl.innerHTML = `
      <div class="card">
        ${editBtn}
        <div class="card-title">${state._config?.categories?.find(c => c.key === catKey)?.label || catKey}</div>
        ${rows}
      </div>
    `;
  }
}

async function loadSecretsTab(contentEl, profile, isEditMode) {
  contentEl.innerHTML = `<div class="card"><div class="card-title" data-i18n="auto.environmentSecrets">Environment Secrets</div><div class="loading" data-i18n="auto.loadingSecrets">Loading secrets...</div></div>`;
  try {
    const res = await api(`/api/keys/${profile}`);
    if (!res.ok) {
      contentEl.innerHTML = `<div class="card"><div class="card-title" data-i18n="auto.secrets">Secrets</div><div class="error-msg">${escapeHtml(res.error || 'Failed to load')}</div></div>`;
      return;
    }

    const categories = res.categories || [];
    const allKeys = res.keys || [];

    // Check if there are advanced keys
    const hasAdvanced = allKeys.some(k => k.is_advanced);

    let html = `<div class="card">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span data-i18n="auto.environmentSecrets">Environment Secrets</span>
        <div style="display:flex;gap:8px;align-items:center;">
          ${hasAdvanced ? `<button class="btn btn-ghost btn-sm" id="adv-toggle-btn" onclick="window.toggleAdvancedSecrets()">Show Advanced (${allKeys.filter(k=>k.is_advanced).length})</button>` : ''}
          ${isEditMode
            ? `<button class="btn btn-primary btn-sm" onclick="window.saveSecrets('${profile}')" data-i18n="auto.save">💾 Save</button><button class="btn btn-ghost btn-sm" onclick="window.cancelEdit('secrets')" data-i18n="auto.revert">↺ Revert</button>`
            : `<button class="btn btn-primary btn-sm" onclick="window.enableEdit('secrets')" data-i18n="auto.edit">✏️ Edit</button>`}
        </div>
      </div>`;

    if (categories.length === 0) {
      html += `<div class="stat-row"><span class="stat-label" data-i18n="auto.noSecretsConfigured">No secrets configured</span></div>`;
    } else {
      categories.forEach((cat, ci) => {
        const catId = `sec-cat-${ci}`;
        const isAdvCat = cat.name === 'Advanced' || cat.name === 'MCP Keys';
        html += `
          <div style="margin-top:${ci > 0 ? '16px' : '0'};">
            <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer;" onclick="window.toggleSecretCat('${catId}')">
              <span style="font-size:13px;font-weight:600;color:var(--fg);">${escapeHtml(cat.name)}</span>
              <span style="font-size:11px;color:var(--fg-muted);">(${cat.keys.length})</span>
              <span style="font-size:11px;color:var(--fg-muted);margin-left:auto;">▾</span>
            </div>
            <div id="${catId}" class="secret-cat-body">
              ${cat.keys.map(k => {
                const rowId = `sec-row-${profile}-${k.name}`;
                const inputId = `sec-input-${k.name}`;
                if (isEditMode) {
                  return `
                    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-subtle);" id="${rowId}">
                      <div style="min-width:200px;">
                        <div style="font-family:var(--font-mono,monospace);font-size:12px;color:var(--fg);">${escapeHtml(k.name)}</div>
                        <div style="font-size:10px;color:var(--fg-muted);">${escapeHtml(k.description || '')}</div>
                      </div>
                      <div style="flex:1;display:flex;gap:4px;">
                        <input id="${inputId}" type="password" data-secret-name="${escapeHtml(k.name)}" data-secret-new="false" value="" placeholder="${k.has_value ? '••••••••' : 'Enter value...'}" style="flex:1;background:var(--bg-input);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:12px;" />
                        <button type="button" onclick="this.previousElementSibling.type=this.previousElementSibling.type==='password'?'text':'password'" style="background:none;border:none;cursor:pointer;font-size:13px;padding:4px;color:var(--fg-muted);">👁</button>
                      </div>
                      ${k.provider_url ? `<a href="${escapeHtml(k.provider_url)}" target="_blank" style="font-size:11px;color:var(--teal);text-decoration:none;white-space:nowrap;" data-i18n="auto.getKey">Get key →</a>` : '<span style="width:60px;"></span>'}
                      <button class="btn btn-ghost btn-sm" onclick="window.deleteSecret('${escapeHtml(k.name)}','${profile}')" title="Delete">✕</button>
                    </div>
                  `;
                } else {
                  return `
                    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-subtle);" id="${rowId}">
                      <div style="min-width:200px;">
                        <div style="font-family:var(--font-mono,monospace);font-size:12px;color:var(--fg);">${escapeHtml(k.name)}</div>
                        <div style="font-size:10px;color:var(--fg-muted);">${escapeHtml(k.description || '')}</div>
                      </div>
                      <div style="flex:1;">
                        <span class="secret-masked-value" style="font-size:12px;color:var(--fg-muted);font-family:var(--font-mono,monospace);" data-masked="${escapeHtml(k.masked)}">${escapeHtml(k.masked)}</span>
                      </div>
                      ${k.provider_url ? `<a href="${escapeHtml(k.provider_url)}" target="_blank" style="font-size:11px;color:var(--teal);text-decoration:none;white-space:nowrap;" data-i18n="auto.getKey">Get key →</a>` : '<span style="width:60px;"></span>'}
                      <button class="btn btn-ghost btn-sm" onclick="window.revealSecret('${escapeHtml(k.name)}','${profile}')" title="Reveal">👁</button>
                    </div>
                  `;
                }
              }).join('')}
            </div>
          </div>
        `;
      });
    }

    // Add new key section (edit mode only)
    if (isEditMode) {
      html += `
        <div style="margin-top:16px;padding:12px;border:1px dashed var(--border);border-radius:var(--radius);">
          <div style="font-size:12px;font-weight:600;color:var(--fg);margin-bottom:8px;" data-i18n="auto.addNewKey">+ Add new key</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <input id="new-secret-name" type="text" placeholder="KEY_NAME" style="width:180px;background:var(--bg-input);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:12px;font-family:var(--font-mono,monospace);" />
            <input id="new-secret-value" type="password" placeholder="value" style="flex:1;background:var(--bg-input);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:12px;" />
            <button type="button" onclick="this.previousElementSibling.type=this.previousElementSibling.type==='password'?'text':'password'" style="background:none;border:none;cursor:pointer;font-size:13px;padding:4px;color:var(--fg-muted);">👁</button>
            <button class="btn btn-primary btn-sm" onclick="window.addSecret('${profile}')" data-i18n="auto.add">Add</button>
          </div>
        </div>
      `;
    }

    html += `</div>`;
    contentEl.innerHTML = html;

    // In edit mode, load existing values into inputs
    if (isEditMode) {
      allKeys.forEach(k => {
        const input = document.getElementById(`sec-input-${k.name}`);
        if (input) {
          input.dataset.secretNew = 'false';
          // Load current value from reveal endpoint
          (async () => {
            try {
              const rv = await api(`/api/keys/${profile}/reveal/${k.name}`);
              if (rv.ok && rv.value) {
                input.value = rv.value;
                input.placeholder = '';
              }
            } catch {}
          })();
        }
      });
    }

    // Collapse advanced by default
    if (hasAdvanced) {
      allKeys.filter(k => k.is_advanced).forEach((k, i) => {
        const body = document.getElementById(`sec-cat-${categories.findIndex(c => c.name === k.category)}`);
        if (body && i === 0) {
          // collapse advanced categories
          const catIdx = categories.findIndex(c => c.name === k.category);
          if (catIdx > 0) {
            const catBody = document.getElementById(`sec-cat-${catIdx}`);
            if (catBody) catBody.style.display = 'none';
          }
        }
      });
      window._advancedSecretsVisible = false;
    }

  } catch {
    contentEl.innerHTML = `<div class="card"><div class="card-title" data-i18n="auto.secrets">Secrets</div><div class="error-msg" data-i18n="auto.failedToLoadSecrets">Failed to load secrets</div></div>`;
  }
}

window.renderConfigCategory = renderConfigCategory;
window.renderPlatformsTab = renderPlatformsTab;
window.loadSecretsTab = loadSecretsTab;

// ---- Config editing ----
window.enableEdit = function(type) {
  const contentEl = document.getElementById('config-content');
  if (contentEl) {
    contentEl.dataset.editMode = 'true';
    const cat = type === 'secrets' ? 'secrets' : (state._config?.activeCat || 'model');
    state._config && (state._config.activeCat = cat);
    renderConfigCategory(cat);
  }
};

window.cancelEdit = function(type) {
  const contentEl = document.getElementById('config-content');
  if (contentEl) {
    contentEl.dataset.editMode = 'false';
    const cat = type === 'secrets' ? 'secrets' : (state._config?.activeCat || 'model');
    state._config && (state._config.activeCat = cat);
    renderConfigCategory(cat);
  }
};

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

window.savePlatformsConfig = async function(profile) {
  const enabled = document.getElementById('cfg-platforms-enabled')?.checked;
  const host = document.getElementById('cfg-platforms-host')?.value || '127.0.0.1';
  const port = parseInt(document.getElementById('cfg-platforms-port')?.value || '8650');
  const key = document.getElementById('cfg-platforms-key')?.value || '';
  const cors = document.getElementById('cfg-platforms-cors')?.value || '';
  const newConfig = JSON.parse(JSON.stringify(state._config.config));
  newConfig.platforms = { api_server: { enabled, extra: { host, port, key, cors_origins: cors } } };
  try {
    const csrfToken = state.csrfToken || '';
    const res = await api('/api/config/' + encodeURIComponent(profile), {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ config: newConfig }),
    });
    if (res.ok) { showToast('Platforms saved!', 'success'); state._config.config = newConfig; cancelEdit('platforms'); }
    else showToast(res.error || 'Save failed', 'error');
  } catch (e) { showToast('Save failed: ' + e.message, 'error'); }
};

window.saveConfigForm = async function(profile, category) {
  const catConfig = state._config?.config[category];
  if (!catConfig) { showToast('Config not loaded', 'error'); return; }
  const updated = JSON.parse(JSON.stringify(catConfig));
  document.querySelectorAll('[data-cfg-key]').forEach(input => {
    const key = input.dataset.cfgKey;
    const type = input.dataset.cfgType;
    if (type === 'bool') updated[key] = input.checked;
    else if (type === 'num') updated[key] = Number(input.value);
    else updated[key] = input.value;
  });
  Object.keys(catConfig).forEach(k => {
    if (typeof catConfig[k] === 'object' && catConfig[k] !== null) {
      const ta = document.getElementById('cfg-nested-' + k);
      if (ta) { try { updated[k] = JSON.parse(ta.value); } catch { showToast(`Invalid JSON in "${k}"`, 'error'); return; } }
    }
  });
  try {
    const res = await api('/api/config/' + encodeURIComponent(profile), {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
      body: JSON.stringify({ config: { [category]: updated } })
    });
    if (res.ok) { state._config && (state._config.config[category] = updated); showToast('Config saved!', 'success'); window.cancelEdit(category); }
    else showToast(res.output || 'Save failed', 'error');
  } catch (e) { showToast(e.message, 'error'); }
};

// ---- Secrets management ----
window.toggleSecretCat = function(catId) {
  const body = document.getElementById(catId);
  if (!body) return;
  body.style.display = body.style.display === 'none' ? 'block' : 'none';
};

window._advancedSecretsVisible = false;
window.toggleAdvancedSecrets = function() {
  window._advancedSecretsVisible = !window._advancedSecretsVisible;
  const btn = document.getElementById('adv-toggle-btn');
  const allBodies = Array.from(document.querySelectorAll('[id^="sec-cat-"]'));
  allBodies.forEach(body => {
    if (body.id === 'sec-cat-0') return;
    body.style.display = window._advancedSecretsVisible ? 'block' : 'none';
  });
  if (btn) btn.textContent = window._advancedSecretsVisible ? 'Hide Advanced' : `Show Advanced (${allBodies.length - 1})`;
};

window.addSecret = async function(profile) {
  const nameInput = document.getElementById('new-secret-name');
  const valueInput = document.getElementById('new-secret-value');
  const name = nameInput?.value.trim();
  const value = valueInput?.value;
  if (!name) { showToast('Enter a key name', 'error'); return; }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { showToast('Key name invalid', 'error'); return; }
  try {
    const res = await api('/api/keys/' + encodeURIComponent(profile), {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
      body: JSON.stringify({ name, value: value || '' })
    });
    if (res.ok) { showToast(`Added ${name}`, 'success'); nameInput.value = ''; valueInput.value = ''; loadSecretsTab(document.getElementById('config-content'), profile, true); }
    else showToast(res.output || 'Failed to add', 'error');
  } catch (e) { showToast(e.message, 'error'); }
};

window.revealSecret = async function(keyName, profile) {
  const row = document.getElementById(`sec-row-${profile}-${keyName}`);
  const valueEl = row?.querySelector('.secret-masked-value');
  const btn = row?.querySelector('button[title="Reveal"]') || row?.querySelector('button[title="Hide"]');
  if (valueEl && valueEl.dataset.revealed === 'true') {
    valueEl.textContent = valueEl.dataset.masked || '••••••••';
    valueEl.dataset.revealed = 'false'; valueEl.style.color = 'var(--fg-muted)';
    if (btn) btn.title = 'Reveal'; return;
  }
  try {
    const res = await api(`/api/keys/${profile}/reveal/${keyName}`);
    if (res.ok && res.value) {
      if (valueEl) { valueEl.textContent = res.value; valueEl.dataset.revealed = 'true'; valueEl.dataset.masked = valueEl.dataset.masked || valueEl.textContent; valueEl.style.color = 'var(--fg)'; }
      if (btn) btn.title = 'Hide';
    } else showToast(res.error || 'Failed to reveal', 'error');
  } catch (e) { showToast(e.message, 'error'); }
};

window.editSecret = function(keyName, profile) {
  const el = document.querySelector(`#config-input-${keyName}`);
  if (el) { el.removeAttribute('readonly'); el.focus(); }
};

window.deleteSecret = async function(keyName, profile) {
  if (!await customConfirm(`Delete secret "${keyName}"?`)) return;
  try {
    const res = await api('/api/keys/' + encodeURIComponent(profile) + '/' + encodeURIComponent(keyName), { method: 'DELETE' });
    showToast(res.ok ? 'Secret deleted' : (res.output || 'Failed'), res.ok ? 'success' : 'error');
    if (res.ok) loadSecretsTab(document.getElementById('config-content'), profile, true);
  } catch (e) { showToast(e.message, 'error'); }
};

window.saveSecrets = async function(profile) {
  const inputs = document.querySelectorAll('[data-secret-name]');
  let saved = 0, failed = 0;
  for (const input of inputs) {
    const keyName = input.dataset.secretName;
    try {
      const res = await api('/api/keys/' + encodeURIComponent(profile), {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
        body: JSON.stringify({ name: keyName, value: input.value })
      });
      if (res.ok) saved++; else { failed++; showToast('Failed: ' + keyName, 'error'); }
    } catch (e) { failed++; showToast('Error: ' + keyName, 'error'); }
  }
  showToast(saved > 0 ? `Saved ${saved} secret(s)${failed > 0 ? ', ' + failed + ' failed' : ''}` : 'No changes', saved > 0 ? 'success' : 'info');
  window.cancelEdit('secrets');
};

window.saveSecretsLocal = async function(profile) {
  const inputs = document.querySelectorAll('[data-secret-name]');
  let saved = 0, failed = 0;
  for (const input of inputs) {
    const keyName = input.dataset.secretName;
    try {
      const res = await api('/api/keys/' + encodeURIComponent(profile), {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken || '' },
        body: JSON.stringify({ name: keyName, value: input.value })
      });
      if (res.ok) saved++; else { failed++; showToast('Failed: ' + keyName, 'error'); }
    } catch (e) { failed++; showToast('Error: ' + keyName, 'error'); }
  }
  showToast(saved > 0 ? `Saved ${saved} secret(s)${failed > 0 ? ', ' + failed + ' failed' : ''}` : 'No changes', saved > 0 ? 'success' : 'info');
  window._cancelEditLocal('secrets');
};

export { renderPlatformsTab, renderConfigCategory, loadSecretsTab };
