import { api } from '../core/api.js';
import { escapeHtml, parseSkillTable } from '../core/utils.js';
async function loadSkills(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title" data-i18n="auto.skillsHub">Skills Hub</div>
        <div class="page-subtitle" data-i18n="auto.browseInstallAndManageSkills">Browse, install, and manage skills</div>
      </div>
      <div style="display:flex;gap:8px;">
        <input type="text" id="skills-search-input" class="search-input" placeholder="Search skills..." />
        <button class="btn btn-ghost" onclick="loadSkills(document.querySelector('.page.active'))" data-i18n="home.refresh">↻ Refresh</button>
      </div>
    </div>
    <div id="skills-hub-content">
      <div class="loading" data-i18n="auto.loadingSkills">Loading skills...</div>
    </div>
  `;
  const contentEl = document.getElementById('skills-hub-content');
  let currentPage = 1;
  let totalPages = 1;
  let profiles = [];
  let installedSkills = new Set();
  // Load profiles + installed skills for button state tracking
  try {
    const profRes = await api('/api/profiles');
    if (profRes.ok) profiles = profRes.profiles || [];
    const activeProfile = profiles.find(p => p.active) || { name: 'default' };
    try {
      const instRes = await api(`/api/skills/list/${activeProfile.name}`);
      if (instRes.ok && instRes.output) {
        const lines = instRes.output.split('\n');
        for (const line of lines) {
          const match = line.match(/[│┃]\s*([^\s│┃][^\s│┃]*)\s*[│┃]/);
          if (match) installedSkills.add(match[1].trim());
        }
      }
    } catch {}
  } catch {}
  async function loadPage(page) {
    contentEl.innerHTML = '<div class="loading">Loading page ' + page + '...</div>';
    try {
      const res = await api(`/api/skills/browse/${page}`);
      if (!res.ok) {
        contentEl.innerHTML = `<div class="card"><div class="card-title" data-i18n="common.error">Error</div><div class="error-msg">${escapeHtml(res.error || 'Failed to load')}</div></div>`;
        return;
      }
      // Parse output for pagination info
      const output = res.output || '';
      const pageMatch = output.match(/page (\d+)\/(\d+)/);
      if (pageMatch) {
        currentPage = parseInt(pageMatch[1]);
        totalPages = parseInt(pageMatch[2]);
      }
      // Parse table rows
      const skills = [];
      const lines = output.split('\n');
      for (const line of lines) {
        const match = line.match(/[│|]\s*(\d+)\s*[│|]\s*([^\s│|]+)\s*[│|]\s*(.{10,}?)\s*[│|]\s*(\S+)\s*[│|]\s*(.+?)\s*[│|]/);
        if (match) {
          skills.push({
            num: match[1],
            name: match[2].trim(),
            description: match[3].trim().replace(/\.\.\.$/, ''),
            source: match[4].trim(),
            trust: match[5].trim(),
          });
        }
      }
      // Build HTML
      let html = '<div class="card-grid">';
      if (skills.length === 0) {
        html += `<div class="card"><div class="card-title">No skills found on page ${page}</div><pre style="font-size:10px;color:var(--fg-muted);max-height:400px;overflow-y:auto;white-space:pre-wrap;">${escapeHtml(output)}</pre></div>`;
      } else {
        for (const s of skills) {
          const isOfficial = s.source === 'official';
          const badgeColor = isOfficial ? 'var(--accent)' : 'var(--fg-muted)';
          html += `
            <div class="card" style="position:relative;">
              <div class="card-title">${escapeHtml(s.name)}</div>
              <div style="font-size:12px;color:var(--fg-muted);margin-top:4px;">${escapeHtml(s.description)}</div>
              <div style="margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                <span class="badge" style="font-size:10px;background:${badgeColor}22;color:${badgeColor};">${escapeHtml(s.source)}</span>
                ${s.trust ? `<span class="badge" style="font-size:10px;">${escapeHtml(s.trust)}</span>` : ''}
              </div>
              <div style="margin-top:10px;display:flex;gap:6px;">
                <button class="btn btn-ghost btn-sm" onclick="window.inspectSkill('${escapeHtml(s.name)}')" data-i18n="auto.preview">👁️ Preview</button>
                ${installedSkills.has(s.name)
                  ? `<button class="btn btn-ok btn-sm" disabled style="cursor:default;" data-i18n="auto.installed">✅ Installed</button>`
                  : `<button class="btn btn-primary btn-sm" onclick="window.installSkill('${escapeHtml(s.name)}')" data-i18n="auto.install">⬇️ Install</button>`}
              </div>
            </div>
          `;
        }
      }
      html += '</div>';
      // Pagination
      html += '<div style="display:flex;justify-content:center;gap:8px;margin-top:16px;">';
      if (currentPage > 1) {
        html += `<button class="btn btn-ghost" onclick="skillsLoadPage(${currentPage - 1})">← Page ${currentPage - 1}</button>`;
      }
      html += `<span style="color:var(--fg-muted);padding:8px;">Page ${currentPage} / ${totalPages}</span>`;
      if (currentPage < totalPages) {
        html += `<button class="btn btn-ghost" onclick="skillsLoadPage(${currentPage + 1})">Page ${currentPage + 1} →</button>`;
      }
      html += '</div>';
      contentEl.innerHTML = html;
    } catch (e) {
      contentEl.innerHTML = `<div class="card"><div class="card-title" data-i18n="common.error">Error</div><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
    }
  }
  // Expose pagination globally
  window.skillsLoadPage = loadPage;
  // Search handler
  document.getElementById('skills-search-input')?.addEventListener('input', async (e) => {
    const q = e.target.value.trim();
    if (q.length < 2) { loadPage(1); return; }
    contentEl.innerHTML = '<div class="loading" data-i18n="auto.searching">Searching...</div>';
    try {
      const res = await api(`/api/skills/search/${encodeURIComponent(q)}`);
      if (res.ok && res.output) {
        const skills = parseSkillTable(res.output);
        if (skills.length === 0) {
          contentEl.innerHTML = `<div class="card"><div class="card-title" data-i18n="auto.searchResults">Search Results</div><div class="stat-row"><span class="stat-label">No skills found for "${escapeHtml(q)}"</span></div></div>`;
        } else {
          contentEl.innerHTML = `<div class="card"><div class="card-title">Search Results (${skills.length})</div></div>` +
            '<div class="card-grid">' + skills.map(s => `
              <div class="card">
                <div class="card-title">${escapeHtml(s.name)}</div>
                <div style="font-size:12px;color:var(--fg-muted);margin:4px 0;">${escapeHtml(s.description)}</div>
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px;">
                  <span class="badge" style="font-size:10px;">${escapeHtml(s.source)}</span>
                  ${s.trust ? `<span class="badge" style="font-size:10px;opacity:0.7;">${escapeHtml(s.trust)}</span>` : ''}
                </div>
                <div style="margin-top:8px;display:flex;gap:6px;">
                  <button class="btn btn-ghost btn-sm" onclick="window.inspectSkill('${escapeHtml(s.identifier || s.name)}')" data-i18n="auto.preview2">🔍 Preview</button>
                  ${installedSkills.has(s.identifier || s.name)
                    ? `<button class="btn btn-ok btn-sm" disabled style="cursor:default;" data-i18n="auto.installed">✅ Installed</button>`
                    : `<button class="btn btn-primary btn-sm" onclick="window.installSkill('${escapeHtml(s.identifier || s.name)}')" data-i18n="auto.install2">⬇ Install</button>`}
                </div>
              </div>
            `).join('') + '</div>';
        }
      } else {
        contentEl.innerHTML = `<div class="card"><div class="card-title" data-i18n="auto.searchResults">Search Results</div><div class="error-msg">${escapeHtml(res.error || 'Search failed')}</div></div>`;
      }
    } catch (err) {
      contentEl.innerHTML = `<div class="card"><div class="error-msg">${escapeHtml(err.message)}</div></div>`;
    }
  });
  // Load first page
  loadPage(1);
}
export { loadSkills };

// Global exposure for onclick handlers
window.loadSkills = loadSkills;

window.inspectSkill = async function(name) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `<div class="modal-card" style="width:600px;max-width:90vw;"><div class="loading">Loading preview...</div></div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  try {
    const res = await api(`/api/skills/inspect/${encodeURIComponent(name)}`);
    overlay.querySelector('.modal-card').innerHTML = `
      <div class="modal-title">${escapeHtml(name)}</div>
      <pre style="background:var(--bg-inset);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow-y:auto;color:var(--fg);">${escapeHtml(res.ok ? res.output : res.error || 'Failed to load')}</pre>
      <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Close</button>
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove();window.installSkill('${escapeHtml(name)}')">⬇️ Install</button>
      </div>
    `;
  } catch (e) {
    overlay.querySelector('.modal-card').innerHTML = `<div class="modal-title">Error</div><div class="error-msg">${escapeHtml(e.message)}</div><button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()" style="margin-top:12px;">Close</button>`;
  }
};

window.installSkill = async function(skillName) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `<div class="modal-card" style="width:450px;max-width:90vw;"><div class="loading">Loading...</div></div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  let profiles = [];
  try {
    const res = await api('/api/profiles');
    if (res.ok) profiles = res.profiles || [];
  } catch {}

  const profilesList = profiles.map(p =>
    `<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;cursor:pointer;border:1px solid ${p.active ? 'var(--accent)33' : 'var(--border)'};background:${p.active ? 'var(--accent)11' : 'var(--bg-card)'};">
      <input type="radio" name="install-profile" value="${escapeHtml(p.name)}" ${p.active ? 'checked' : ''} />
      <span style="font-weight:600;">${escapeHtml(p.name)}</span>
      ${p.alias && p.alias !== p.name ? `<span style="color:var(--fg-muted);font-size:11px;">(${escapeHtml(p.alias)})</span>` : ''}
      ${p.active ? '<span class="badge" style="font-size:9px;background:var(--accent)22;color:var(--accent);">active</span>' : ''}
      <span style="color:var(--fg-muted);font-size:11px;margin-left:auto;">${escapeHtml(p.model || '')}</span>
    </label>`
  ).join('');

  overlay.querySelector('.modal-card').innerHTML = `
    <div class="modal-title">Install: ${escapeHtml(skillName)}</div>
    <div style="margin-bottom:16px;">
      <div style="font-size:12px;color:var(--fg-muted);margin-bottom:8px;">Select agent profile</div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        ${profilesList || '<div style="color:var(--fg-muted);padding:12px;">No profiles found</div>'}
      </div>
    </div>
    <div id="install-status"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
      <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
      <button class="btn btn-primary" onclick="window.doInstallSkill('${escapeHtml(skillName)}')">⬇️ Install</button>
    </div>
  `;
};

window.doInstallSkill = async function(skillName) {
  const overlay = document.querySelector('.modal-overlay:last-of-type');
  const profileEl = overlay?.querySelector('input[name="install-profile"]:checked');
  const profile = profileEl ? profileEl.value : '';
  const statusEl = overlay?.querySelector('#install-status');
  if (statusEl) statusEl.innerHTML = '<div class="loading">Installing...</div>';

  try {
    const res = await api('/api/skills/install', { method: 'POST', body: JSON.stringify({ skill: skillName, profile }) });
    if (res.ok) {
      if (statusEl) statusEl.innerHTML = `<div style="color:var(--ok);margin-top:8px;">✅ Installed to ${escapeHtml(profile || 'default')}!</div>`;
      setTimeout(() => {
        overlay?.remove();
        const skillsTab = document.querySelector('.tab[data-tab="skills"]');
        if (skillsTab) skillsTab.click();
      }, 1500);
    } else {
      if (statusEl) statusEl.innerHTML = `<div style="color:var(--err);margin-top:8px;">❌ ${escapeHtml(res.output || res.error || 'Install failed')}</div>`;
    }
  } catch (e) {
    if (statusEl) statusEl.innerHTML = `<div style="color:var(--err);margin-top:8px;">❌ ${escapeHtml(e.message)}</div>`;
  }
};
