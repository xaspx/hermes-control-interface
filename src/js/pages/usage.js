import { Chart, state, t } from '../core/state.js';;
import { api } from '../core/api.js';
import { escapeHtml } from '../core/utils.js';

let _lastUsageData = null;
const _charts = {};

async function loadUsage(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title" data-i18n="auto.usageAnalytics">Usage & Analytics</div>
        <div class="page-subtitle" data-i18n="auto.tokenUsageCostsAndActivityBreakdown">Token usage, costs, and activity breakdown</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <select id="usage-days" class="log-level-select">
          <option value="1" data-i18n="auto.today">Today</option>
          <option value="7" selected data-i18n="auto.7Days">7 days</option>
          <option value="30" data-i18n="auto.30Days">30 days</option>
          <option value="90" data-i18n="auto.90Days">90 days</option>
        </select>
        <select id="usage-agent" class="log-level-select">
          <option value="" data-i18n="auto.allAgents">All agents</option>
        </select>
        <button class="btn btn-primary" id="usage-apply-btn" onclick="fetchUsageData()" data-i18n="auto.apply">Apply</button>
        <div style="display:flex;align-items:center;gap:4px;">
          <label style="font-size:11px;color:var(--fg-muted);white-space:nowrap;" data-i18n="auto.budget">Budget $</label>
          <input type="number" id="usage-budget" class="log-level-select" style="width:72px;" min="0" step="1" placeholder="0" value="${localStorage.getItem('hci_budget_limit') || ''}" />
        </div>
        <span id="budget-status-badge" style="display:none;font-size:11px;padding:3px 8px;border-radius:999px;font-weight:600;"></span>
      </div>
    </div>

    <!-- Overview stats bar -->
    <div id="usage-overview-bar" class="card" style="margin-top:12px;">
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;">
        <span class="stat-label" style="white-space:nowrap;" data-i18n="home.sessions">Sessions</span>
        <span class="stat-label" style="white-space:nowrap;" data-i18n="auto.messages">Messages</span>
        <span class="stat-label" style="white-space:nowrap;" data-i18n="auto.inputTokens">Input Tokens</span>
        <span class="stat-label" style="white-space:nowrap;" data-i18n="auto.outputTokens">Output Tokens</span>
        <span class="stat-label" style="white-space:nowrap;" data-i18n="auto.totalTokens">Total Tokens</span>
        <span class="stat-label" style="white-space:nowrap;" data-i18n="auto.estCost">Est. Cost</span>
        <span class="stat-label" style="white-space:nowrap;" data-i18n="auto.activeTime">Active Time</span>
        <span class="stat-label" style="white-space:nowrap;" data-i18n="auto.avgSession">Avg Session</span>
      </div>
    </div>

    <!-- Charts: 2-column layout -->
    <div class="card-grid" style="margin-top:16px;">
      <div class="card">
        <div class="card-title" data-i18n="auto.dailyTokenTrend">Daily Token Trend</div>
        <div style="min-height:200px"><canvas id="usage-chart-tokens" height="160"></canvas></div>
      </div>
      <div class="card">
        <div style="display:flex;flex-direction:column;gap:16px;">
          <div>
            <div class="card-title" style="margin-bottom:8px;display:flex;align-items:center;gap:8px;">Daily Cost <span id="monthly-pace-label" style="font-size:11px;font-weight:normal;color:var(--fg-muted);"></span></div>
            <canvas id="usage-chart-cost" height="100"></canvas>
          </div>
          <div>
            <div class="card-title" style="margin-bottom:8px;" data-i18n="auto.modelDistribution">Model Distribution</div>
            <canvas id="usage-chart-models" height="120"></canvas>
          </div>
        </div>
      </div>
    </div>

    <!-- Models + Platforms + Top Tools in one row -->
    <div class="card-grid" style="margin-top:16px;">
      <div class="card">
        <div class="card-title" data-i18n="auto.models">Models</div>
        <div id="usage-models-list"></div>
      </div>
      <div class="card">
        <div class="card-title" data-i18n="home.platforms">Platforms</div>
        <div id="usage-platforms-list"></div>
      </div>
      <div class="card">
        <div class="card-title" data-i18n="auto.topTools">Top Tools</div>
        <div id="usage-tools-list"></div>
      </div>
    </div>
  `;

  try {
    // Load profiles for agent filter dropdown — clear first to prevent double data
    const profilesRes = await api('/api/profiles');
    const agentSelect = document.getElementById('usage-agent');
    if (profilesRes.ok && profilesRes.profiles) {
      agentSelect.innerHTML = '<option value="">All agents</option>';
      profilesRes.profiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        agentSelect.appendChild(opt);
      });
    }
  } catch (e) {
    // ignore
  }
  // Budget input change handler — prevent duplicate listeners
  const budgetInput = document.getElementById('usage-budget');
  if (budgetInput && !budgetInput.dataset._bound) {
    budgetInput.dataset._bound = '1';
    budgetInput.addEventListener('change', () => {
      const val = parseFloat(budgetInput.value);
      if (!isNaN(val) && val > 0) {
        localStorage.setItem('hci_budget_limit', val);
      } else {
        localStorage.removeItem('hci_budget_limit');
      }
      // Re-render cost chart with new budget
      if (_lastUsageData) renderUsageCharts(_lastUsageData.d, _lastUsageData.daily);
    });
  }
}

async function fetchUsageData() {
  const btn = document.getElementById('usage-apply-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('ui.loadingEllipsis'); }

  // Overview bar — show loading
  const barEl = document.getElementById('usage-overview-bar');
  if (barEl) {
    barEl.innerHTML = `<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center;">
      <span style="color:var(--fg-muted);font-size:13px;" data-i18n="auto.loading3">Loading…</span>
    </div>`;
  }

  try {
    const days = document.getElementById('usage-days')?.value || '7';
    const agent = document.getElementById('usage-agent')?.value || '';
    const query = agent ? `?profile=${agent}` : '';

    const [res, dailyRes] = await Promise.all([
      api(`/api/usage/${days}${query}`),
      api(`/api/usage/daily/${days}${query}`),
    ]);

    if (!res.ok) {
      if (barEl) barEl.innerHTML = `<div class="error-msg">${escapeHtml(res.error || 'Failed to load')}</div>`;
      return;
    }

    const d = res;

    // Render compact overview bar
    if (barEl) {
      barEl.innerHTML = `
        <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center;">
          <div style="text-align:center;min-width:60px;">
            <div style="font-size:20px;font-weight:700;color:var(--gold);">${d.sessions}</div>
            <div style="font-size:10px;color:var(--fg-muted);" data-i18n="home.sessions">Sessions</div>
          </div>
          <div style="text-align:center;min-width:70px;">
            <div style="font-size:20px;font-weight:700;color:var(--gold);">${(d.messages || 0).toLocaleString()}</div>
            <div style="font-size:10px;color:var(--fg-muted);" data-i18n="auto.messages">Messages</div>
          </div>
          <div style="text-align:center;min-width:90px;">
            <div style="font-size:20px;font-weight:700;color:var(--teal);">${formatNumber(d.inputTokens)}</div>
            <div style="font-size:10px;color:var(--fg-muted);" data-i18n="auto.inputTokens">Input Tokens</div>
          </div>
          <div style="text-align:center;min-width:90px;">
            <div style="font-size:20px;font-weight:700;color:var(--coral);">${formatNumber(d.outputTokens)}</div>
            <div style="font-size:10px;color:var(--fg-muted);" data-i18n="auto.outputTokens">Output Tokens</div>
          </div>
          <div style="text-align:center;min-width:90px;">
            <div style="font-size:20px;font-weight:700;color:var(--gold);">${formatNumber(d.totalTokens)}</div>
            <div style="font-size:10px;color:var(--fg-muted);" data-i18n="auto.totalTokens">Total Tokens</div>
          </div>
          <div style="text-align:center;min-width:70px;">
            <div style="font-size:20px;font-weight:700;color:var(--gold);">${d.cost || '$0.00'}</div>
            <div style="font-size:10px;color:var(--fg-muted);" data-i18n="auto.estCost">Est. Cost</div>
          </div>
          <div style="text-align:center;min-width:80px;">
            <div style="font-size:16px;font-weight:600;color:var(--fg-muted);">${d.activeTime || '—'}</div>
            <div style="font-size:10px;color:var(--fg-muted);" data-i18n="auto.activeTime">Active Time</div>
          </div>
          <div style="text-align:center;min-width:80px;">
            <div style="font-size:16px;font-weight:600;color:var(--fg-muted);">${d.avgSession || '—'}</div>
            <div style="font-size:10px;color:var(--fg-muted);" data-i18n="auto.avgSession">Avg Session</div>
          </div>
        </div>
      `;
    }

    // Models
    const modelsEl = document.getElementById('usage-models-list');
    if (modelsEl) {
      modelsEl.innerHTML = d.models && d.models.length > 0
        ? d.models.map(m => `<div class="stat-row"><span class="stat-label">${escapeHtml(m.name)}</span><span class="stat-value">${m.sessions} · ${formatNumber(m.tokens)}</span></div>`).join('')
        : '<div class="stat-row"><span class="stat-label" data-i18n="auto.noData">No data</span></div>';
    }

    // Platforms
    const platEl = document.getElementById('usage-platforms-list');
    if (platEl) {
      platEl.innerHTML = d.platforms && d.platforms.length > 0
        ? d.platforms.map(p => `<div class="stat-row"><span class="stat-label">${escapeHtml(p.name)}</span><span class="stat-value">${p.sessions} · ${formatNumber(p.tokens)}</span></div>`).join('')
        : '<div class="stat-row"><span class="stat-label" data-i18n="auto.noData">No data</span></div>';
    }

    // Top Tools
    const toolsEl = document.getElementById('usage-tools-list');
    if (toolsEl) {
      toolsEl.innerHTML = d.topTools && d.topTools.length > 0
        ? d.topTools.slice(0, 5).map(t => `<div class="stat-row"><span class="stat-label">${escapeHtml(t.name)}</span><span class="stat-value">${t.calls} (${t.pct})</span></div>`).join('')
        : '<div class="stat-row"><span class="stat-label" data-i18n="auto.noData">No data</span></div>';
    }

    // Charts
    renderUsageCharts(d, dailyRes.ok ? dailyRes : null);

  } catch (e) {
    if (barEl) barEl.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('ui.apply'); }
  }
}

function renderUsageCharts(d, daily) {
  // Cache data for budget re-render
  _lastUsageData = { d, daily };
  // Debounce: batch chart renders in next frame to prevent layout jitter
  if (state._chartRAF) cancelAnimationFrame(state._chartRAF);
  state._chartRAF = requestAnimationFrame(() => {
    _renderUsageChartsNow(d, daily);
  });
}

function _renderUsageChartsNow(d, daily) {
  const theme = state.theme === 'light' ? 'light' : 'dark';
  const gridColor = theme === 'dark' ? 'rgba(220,203,181,0.08)' : 'rgba(11,32,31,0.08)';
  const textColor = theme === 'dark' ? '#dccbb5' : '#0b201f';
  const colors = ['#ffac02', '#4ecdc4', '#ff6b6b', '#a78bfa', '#34d399', '#60a5fa', '#fb923c', '#f472b6'];

  // Destroy existing charts
  Object.values(_charts).forEach(c => { try { c.destroy(); } catch {} });

  // Daily Token Trend
  const tokenCanvas = document.getElementById('usage-chart-tokens');
  if (tokenCanvas && daily?.daily && daily.daily.length > 0) {
    const labels = daily.daily.map(r => r.date);
    const inputData = daily.daily.map(r => r.input_tokens || 0);
    const outputData = daily.daily.map(r => r.output_tokens || 0);
    const cacheData = daily.daily.map(r => r.cache_read_tokens || 0);

    _charts.tokens = new Chart(tokenCanvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Input', data: inputData, backgroundColor: '#ffac02', borderRadius: 4 },
          { label: 'Output', data: outputData, backgroundColor: '#4ecdc4', borderRadius: 4 },
          { label: 'Cache', data: cacheData, backgroundColor: '#a78bfa', borderRadius: 4 },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: textColor } } },
        scales: {
          x: { stacked: true, ticks: { color: textColor, maxRotation: 45 }, grid: { color: gridColor } },
          y: { stacked: true, ticks: { color: textColor, callback: v => formatNumber(v) }, grid: { color: gridColor } },
        },
      },
    });
  } else if (tokenCanvas && d.models && d.models.length > 0) {
    // Fallback: model distribution
    const labels = d.models.map(m => m.name).slice(0, 8);
    _charts.tokens = new Chart(tokenCanvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: 'Tokens', data: d.models.slice(0, 8).map(m => m.tokens || 0), backgroundColor: colors.slice(0, 8), borderRadius: 4 }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { x: { ticks: { color: textColor }, grid: { color: gridColor } }, y: { ticks: { color: textColor, callback: v => formatNumber(v) }, grid: { color: gridColor } } },
      },
    });
  }

  // Daily Cost Trend (with monthly projection + budget line)
  const costCanvas = document.getElementById('usage-chart-cost');
  if (costCanvas && daily?.daily && daily.daily.length > 0) {
    const baseLabels = daily.daily.map(r => r.date);
    const costData = daily.daily.map(r => r.cost || 0);

    // Budget from localStorage
    const budgetLimit = parseFloat(localStorage.getItem('hci_budget_limit')) || 0;

    // Monthly projection: extend labels through end of current month
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const endOfMonth = `${year}-${String(month + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

    // Build extended labels (existing + remaining days of month)
    const lastDate = baseLabels[baseLabels.length - 1];
    const extendedLabels = [...baseLabels];
    const projectionData = new Array(baseLabels.length).fill(null);
    let cursor = new Date(lastDate + 'T00:00:00');
    const endDate = new Date(endOfMonth + 'T00:00:00');
    while (cursor < endDate) {
      cursor.setDate(cursor.getDate() + 1);
      const ds = cursor.toISOString().slice(0, 10);
      extendedLabels.push(ds);
      projectionData.push(null);
    }

    // Calculate weighted average daily cost (recent days weighted more)
    // Exponential decay: most recent day gets weight 1.0, each older day × 0.85
    const totalCost = costData.reduce((s, v) => s + v, 0);
    let weightedSum = 0, weightTotal = 0;
    for (let i = 0; i < costData.length; i++) {
      const w = Math.pow(0.85, costData.length - 1 - i); // recent = higher weight
      weightedSum += costData[i] * w;
      weightTotal += w;
    }
    const avgDailyCost = weightTotal > 0 ? weightedSum / weightTotal : 0;
    const monthlyPace = avgDailyCost * 30;
    const simpleAvg = costData.length > 0 ? totalCost / costData.length : 0;
    // Use weighted if we have 3+ days, otherwise simple average
    const projAvg = costData.length >= 3 ? avgDailyCost : simpleAvg;

    // Build cumulative cost array for projection (starts from last cumulative cost)
    const cumulativeActual = [];
    let cumSum = 0;
    for (const c of costData) { cumSum += c; cumulativeActual.push(cumSum); }
    // Fill projection from last actual cumulative
    const lastCumCost = cumulativeActual.length > 0 ? cumulativeActual[cumulativeActual.length - 1] : 0;
    const projStart = baseLabels.length;
    for (let i = 0; i < projectionData.length - projStart; i++) {
      projectionData[projStart + i] = lastCumCost + projAvg * (i + 1);
    }
    // Pad actual cumulative with nulls for the projection range
    const actualPadded = [...cumulativeActual, ...new Array(extendedLabels.length - cumulativeActual.length).fill(null)];

    // Budget line: constant value across all labels
    const budgetLine = budgetLimit > 0 ? new Array(extendedLabels.length).fill(budgetLimit) : [];

    // Build datasets
    const datasets = [
      {
        label: 'Cumulative Cost ($)',
        data: actualPadded,
        borderColor: '#ffac02',
        backgroundColor: 'rgba(255,172,2,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        spanGaps: false,
      },
      {
        label: 'Monthly Projection',
        data: projectionData,
        borderColor: 'rgba(255,172,2,0.45)',
        borderDash: [6, 4],
        backgroundColor: 'transparent',
        fill: false,
        tension: 0.3,
        pointRadius: 0,
        spanGaps: false,
      },
    ];
    if (budgetLimit > 0) {
      datasets.push({
        label: `Budget ($${budgetLimit})`,
        data: budgetLine,
        borderColor: '#ff6b6b',
        borderDash: [8, 4],
        backgroundColor: 'transparent',
        fill: false,
        pointRadius: 0,
        borderWidth: 2,
        spanGaps: true,
      });
    }

    _charts.cost = new Chart(costCanvas, {
      type: 'line',
      data: { labels: extendedLabels, datasets },
      options: {
        responsive: true,
        plugins: {
          legend: { display: true, labels: { color: textColor, font: { size: 10 }, boxWidth: 12, padding: 8 } },
          tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: $${ctx.parsed.y.toFixed(4)}` } },
        },
        scales: {
          x: { ticks: { color: textColor, maxRotation: 45 }, grid: { color: gridColor } },
          y: { ticks: { color: textColor, callback: v => '$' + v.toFixed(2) }, grid: { color: gridColor }, beginAtZero: true },
        },
      },
    });

    // Update budget status badge
    const badge = document.getElementById('budget-status-badge');
    if (badge) {
      if (budgetLimit > 0) {
        badge.style.display = 'inline-block';
        if (monthlyPace > budgetLimit) {
          const over = ((monthlyPace / budgetLimit - 1) * 100).toFixed(0);
          badge.textContent = `⚠ Over budget by ${over}%`;
          badge.style.backgroundColor = 'rgba(255,107,107,0.15)';
          badge.style.color = '#ff6b6b';
        } else {
          const remaining = ((1 - monthlyPace / budgetLimit) * 100).toFixed(0);
          badge.textContent = `✓ ${remaining}% under budget`;
          badge.style.backgroundColor = 'rgba(78,205,196,0.15)';
          badge.style.color = '#4ecdc4';
        }
      } else {
        badge.style.display = 'none';
      }
    }
    // Update monthly pace label in card title
    const paceLabel = document.getElementById('monthly-pace-label');
    if (paceLabel) {
      paceLabel.textContent = `· ~$${monthlyPace.toFixed(2)}/mo pace`;
    }
  } else if (costCanvas) {
    // Fallback: model cost distribution
    const models = (d.models || []).slice(0, 6);
    _charts.cost = new Chart(costCanvas, {
      type: 'bar',
      data: {
        labels: models.map(m => m.name),
        datasets: [{ label: 'Sessions', data: models.map(m => m.sessions || 0), backgroundColor: colors.slice(0, 6), borderRadius: 4 }],
      },
      options: {
        responsive: true,
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: { x: { ticks: { color: textColor }, grid: { color: gridColor } }, y: { ticks: { color: textColor }, grid: { color: gridColor } } },
      },
    });
  }

  // Model Distribution (doughnut)
  const modelCanvas = document.getElementById('usage-chart-models');
  const models = daily?.byModel || d.models;
  if (modelCanvas && models && models.length > 0) {
    const top = models.slice(0, 6);
    _charts.models = new Chart(modelCanvas, {
      type: 'doughnut',
      data: {
        labels: top.map(m => m.name || m.model),
        datasets: [{
          data: top.map(m => m.tokens || m.total_tokens || 0),
          backgroundColor: colors.slice(0, 6),
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        cutout: '60%',
        plugins: { legend: { position: 'bottom', labels: { color: textColor, font: { size: 10 }, padding: 8 } } },
      },
    });
  }
}

window.fetchUsageData = fetchUsageData;
window.renderUsageCharts = renderUsageCharts;
export { loadUsage, fetchUsageData, renderUsageCharts };
