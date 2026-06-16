import { state } from './state.js';
import { loadChat } from '../chat/core.js';
import { escapeHtml } from './utils.js';
import { loadAgentDetail, loadAgents } from '../pages/agents.js';
import { loadFileExplorer } from '../pages/file-explorer.js';
import { loadHome } from '../pages/home.js';
import { loadLogs, loadMonitoring, stopLogsAutoRefresh } from '../pages/logs.js';
import { loadMaintenance } from '../pages/maintenance.js';
import { loadOffice, stopOfficeAutoRefresh } from '../pages/office.js';
import { loadSkills } from '../pages/skills.js';
import { loadUsage } from '../pages/usage.js';
import { loadUsersPage } from '../pages/users.js';
import { loadMcp } from '../pages/mcp.js';
import { loadWorkspace } from '../pages/workspace.js';

function navigate(page, params = {}) {
  // Cleanup previous page resources
  stopLogsAutoRefresh();
  stopOfficeAutoRefresh();
  if (state._logsDebounce) { clearTimeout(state._logsDebounce); state._logsDebounce = null; }

  state.page = page;

  // Update nav active state
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.classList.toggle('active', link.dataset.page === page);
  });

  // Show/hide pages
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  const target = document.getElementById(`page-${page}`);
  if (target) target.classList.add('active');

  // Load page content
  loadPage(page, params);
}

async function loadPage(page, params = {}) {
  const container = document.getElementById(`page-${page}`);
  if (!container) return;

  // Show loading
  container.innerHTML = '<div class="loading" data-i18n="common.loading">Loading</div>';

  try {
    switch (page) {
      case 'home':
        await loadHome(container);
        break;
      case 'agents':
        await loadAgents(container);
        break;
      case 'agent-detail':
        await loadAgentDetail(container, params);
        break;
      case 'usage':
        await loadUsage(container);
        break;
      case 'skills':
        await loadSkills(container);
        break;
      case 'maintenance':
        await loadMaintenance(container);
        break;
      case 'files':
        await loadFileExplorer(container);
        break;
      case 'chat':
        await loadChat(container);
        break;
      case 'users':
        await loadUsersPage(container);
        break;
      case 'logs':
        await loadLogs(container);
        break;
      case 'mon':
        await loadMonitoring(container);
        break;
      case 'office':
        await loadOffice(container);
        break;
      case 'mcp':
        await loadMcp(container);
        break;
      case 'workspace':
        await loadWorkspace(container);
        break;
      default:
        container.innerHTML = `<div class="empty" data-i18n="auto.pageNotFound">Page not found</div>`;
    }
  } catch (err) {
    container.innerHTML = `<div class="empty">Error loading page: ${escapeHtml(err.message)}</div>`;
  }
}

window.navigate = navigate;
window.loadPage = loadPage;
export { navigate, loadPage };
