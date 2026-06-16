import { state, initTheme, toggleTheme, updateThemeIcon, t, i18nApply, initI18n } from './core/state.js';
import { api } from './core/api.js';
import { escapeHtml, formatRelativeTime, parseSkillTable, formatFileSize, formatNumber } from './core/utils.js';
import { checkAuth, showLogin, showSetup, showApp, updateUserMenu } from './core/auth.js';
import { navigate, loadPage } from './core/navigation.js';
import { hasPerm, _isSessionPinned } from './core/permissions.js';
import { toggleMsgMenu, closeMsgMenu, forkFromMessageIdx } from './core/messages.js';
import { showToast, createToastContainer } from './components/toast.js';
import { closeModal, showModal, customAlert, customConfirm, customPrompt } from './components/modal.js';
import { fetchNotifications, updateNotifBadge, startNotifPolling, notifColor, notifIcon, renderNotifications, markNotifRead, dismissNotifItem, loadMoreNotifs, markAllNotifRead } from './components/notifications.js';
import { loadChat, refreshChatSidebar, filterChatBySource, reloadCurrentSessionMessages, loadChatSession, renderChatMessage, newChatSession, toggleChatSidebar, updateChatAgentPanel, switchChatProfile, stopChatStream, renameChatSession, deleteChatSession, updateQueueBadge, updateChatHeader, sendChatMessage, forkFromMessage, playChatComplete, toggleChatSound, updateToolCountUI, handleArtifact, togglePinSession } from './chat/core.js';
import { sendViaGatewayAPI, handleGatewayEvent, setupWsChatHandlers, handleThinkingDelta, handleReasoningDelta, handleMessageStart, handleTextDelta, handleStatusUpdate, handleToolGenerating, handleToolStart, handleToolProgress, handleToolDone, handleSubagentEvent, showClarifyModal, showApprovalModal, showSudoModal, showSecretModal, ensureThinkingPanel, hideThinkingPanel, ensureToolCards, finalizeWsChat, showChatError, showChatWarning } from './chat/gateway.js';
import { sendViaWebSocket } from './chat/websocket.js';
import { sendViaCLI, addToolCallCard, updateToolProgress, finalizeToolCard, updateStreamContent, renderChatContent, highlightCodeBlocks, createMessageDiv, addToDedupBuf, isDuplicateUserMessage, swapOptimisticMessage, updateWsConnectionUI, updateGatewayBadge } from './chat/cli.js';
import { loadHome, hcirestart, hciupdate, runHCIUpdate, updateHCIInfo, checkHCIUpdates, showCommitListModal, showCommitDiff, checkoutCommit, runUpdateStream, hcidoctor, loadHomeAuth, loadTokenUsage } from './pages/home.js';
import { loadAgents, deleteAgent, setAgentDefault, loadAgentDetail, loadAgentTab, loadAgentDashboard, loadAgentSessions, toggleSessionDetail, loadSessionStats, resumeSession, openTerminalPanel, loadXtermAndConnect, renameSession, exportSession, deleteSession, loadAgentGateway, renderGatewayHealth, fixGateway, loadGatewayConnections, loadGatewayLogs, gatewayAction, sseProgressModal } from './pages/agents.js';
import { loadAgentConfig, loadAgentMemory, loadAgentCron, loadCronJobs, cronAction, cronRemove, showCreateCronModal } from './pages/agent-config.js';
import { loadUsage, fetchUsageData, renderUsageCharts } from './pages/usage.js';
import { loadSkills } from './pages/skills.js';
import { loadUsersPage, loadAuditLogPage, loadUsers, refreshUsersEverywhere, deleteUser, showCreateUser, createUser, showEditUser, showResetPassword } from './pages/users.js';
import { loadMaintenance, createBackup, importBackup, loadAuth, loadAudit, parseDoctorOutput, renderDoctorOutput, runHealthCheck, runDoctor, runDump, runUpdate, showCreateAgent } from './pages/maintenance.js';
import { loadFileExplorer, openFileInEditor, saveCurrentFile, loadFileContent } from './pages/file-explorer.js';
import { loadLogs, loadMonitoring, refreshMonitoring, refreshLogs, renderLogs, fmtLogTime, setLogsLevel, setLogsType, setLogsComponent, toggleLogsAuto, startLogsAutoRefresh, stopLogsAutoRefresh, updateLogsAutoBtn, setLogsMode, debounceLogsSearch, detectLogType } from './pages/logs.js';
import { stopOfficeAutoRefresh, loadOffice } from './pages/office.js';
import { terminalKey, toggleTerminalFullscreen } from './pages/terminal.js';
import { renderPlatformsTab, renderConfigCategory, loadSecretsTab } from './pages/settings.js';
import { loadMcp, showAddMcpModal, mcpAction, mcpSwitchTab, showMcpTestModal,
  showEditMcpConfigModal, submitAddMcp, submitMcpTest, submitMcpConfigEdit,
  selectMcpServer, toggleMcpAddType, renderServerListFiltered,
  toggleMcpLogs, clearMcpLogs } from './pages/mcp.js';
import { loadWorkspace } from './pages/workspace.js';

// ========================================================
// WINDOW BRIDGE — all module exports exposed globally
// so onclick handlers in rendered HTML can access them
// ========================================================
function toggleUserDropdown() {
  const dropdown = document.getElementById('user-dropdown');
  if (!dropdown) return;
  dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
}

function toggleNotifDropdown() {
  const dropdown = document.getElementById('notif-dropdown');
  if (!dropdown) return;
  const isVisible = dropdown.style.display !== 'none';
  dropdown.style.display = isVisible ? 'none' : 'block';
  if (!isVisible) {
    state.notifDisplayLimit = 5;
    renderNotifications();
  }
}

Object.assign(window, {
  // Core
  loadPage, navigate, toggleTheme, escapeHtml, formatNumber,
  formatRelativeTime, formatFileSize, showToast, customAlert, customConfirm,
  customPrompt, closeModal, showModal,

  // Messages
  toggleMsgMenu, closeMsgMenu, forkFromMessageIdx,

  // Chat
  loadChatSession, newChatSession, toggleChatSidebar,
  switchChatProfile, stopChatStream, renameChatSession,
  deleteChatSession, sendChatMessage, forkFromMessage, updateChatHeader,
  togglePinSession, filterChatBySource,

  // Home
  loadHome, hcirestart, hciupdate, runHCIUpdate, checkHCIUpdates, updateHCIInfo,
  showCommitListModal, showCommitDiff, checkoutCommit, runUpdateStream, hcidoctor,

  // Agents
  loadAgents, deleteAgent, setAgentDefault, loadAgentDetail, loadAgentTab,
  loadAgentDashboard, loadAgentSessions, toggleSessionDetail, loadSessionStats,
  resumeSession, openTerminalPanel, loadXtermAndConnect, renameSession,
  exportSession, deleteSession, loadAgentGateway, renderGatewayHealth,
  fixGateway, loadGatewayConnections, loadGatewayLogs, gatewayAction, sseProgressModal,

  // Agent Config
  loadAgentConfig, loadAgentMemory, loadAgentCron, loadCronJobs,
  cronAction, cronRemove, showCreateCronModal,

  // Usage
  fetchUsageData, renderUsageCharts, loadUsage,

  // Skills
  loadSkills,

  // Users
  loadUsers, refreshUsersEverywhere, deleteUser, showCreateUser,
  createUser, showEditUser, showResetPassword,

  // Maintenance
  loadMaintenance, createBackup, importBackup, loadAuth, loadAudit,
  runHealthCheck, runDoctor, runDump, runUpdate, showCreateAgent,

  // File Explorer
  loadFileExplorer, openFileInEditor, saveCurrentFile, loadFileContent,

  // Terminal
  terminalKey, toggleTerminalFullscreen,

  // Settings
  renderPlatformsTab, renderConfigCategory, loadSecretsTab,

  // Logs
  loadMonitoring, loadLogs, refreshLogs, setLogsLevel, setLogsType,
  setLogsComponent, toggleLogsAuto, debounceLogsSearch, setLogsMode,
  clearLogs, clearLogsComponent, scrollLogsBottom, copyLogLine,

  // Notifications
  markNotifRead, dismissNotifItem, loadMoreNotifs, markAllNotifRead,
  toggleNotifDropdown, toggleUserDropdown,

  // MCP
  loadMcp, showAddMcpModal, mcpAction, mcpSwitchTab, showMcpTestModal,
  showEditMcpConfigModal, submitAddMcp, submitMcpTest, submitMcpConfigEdit,
  selectMcpServer, toggleMcpAddType, renderServerListFiltered,
  toggleMcpLogs, clearMcpLogs,
});

function init() {
  console.log('BUILD: 2026-06-02-v7-fix');
  console.log('TOP: init() started');

  // PWA: Register service worker for offline support + installability
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js?v=3.6.0').then(reg => {
      console.log('SW: registered, scope:', reg.scope);
      // Auto-update: if new SW found, activate immediately
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showToast('Update available — refresh to apply', 'info');
          }
        });
      });
    }).catch(e => console.warn('SW: registration failed:', e.message));

    // Reload when new SW takes over (user explicitly refreshed)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      console.log('SW: new controller active');
    });
  }

  // Theme
  initTheme();
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);

  // Nav
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(link.dataset.page);
      // Close mobile nav after click
      document.getElementById('nav')?.classList.remove('mobile-open');
    });
  });

  // Mobile nav toggle
  document.getElementById('nav-toggle')?.addEventListener('click', () => {
    document.getElementById('nav')?.classList.toggle('mobile-open');
  });

  // User menu — handled by inline onclick="toggleUserDropdown()"

  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    state.user = null;
    if (state.notifInterval) clearInterval(state.notifInterval);
    showLogin();
  });

  // Password modal
  document.getElementById('change-password-btn')?.addEventListener('click', () => {
    document.getElementById('user-dropdown').style.display = 'none';
    document.getElementById('password-modal').style.display = 'flex';
  });

  document.getElementById('users-mgmt-btn')?.addEventListener('click', () => {
    document.getElementById('user-dropdown').style.display = 'none';
    navigate('users');
  });

  document.getElementById('password-cancel')?.addEventListener('click', () => {
    document.getElementById('password-error').textContent = '';
    document.getElementById('password-modal').style.display = 'none';
  });

  document.getElementById('password-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const current = document.getElementById('current-password').value;
    const newPass = document.getElementById('new-password').value;
    const confirm = document.getElementById('confirm-new-password').value;
    const errorEl = document.getElementById('password-error');

    if (newPass !== confirm) {
      errorEl.textContent = t('toast.passwordsDontMatch');
      return;
    }
    if (newPass.length < 8) {
      errorEl.textContent = t('toast.passwordTooShort');
      return;
    }

    try {
      const res = await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password: current, new_password: newPass }),
      });
      if (res.ok) {
        document.getElementById('password-modal').style.display = 'none';
        errorEl.textContent = '';
        document.getElementById('current-password').value = '';
        document.getElementById('new-password').value = '';
        document.getElementById('confirm-new-password').value = '';
      } else {
        errorEl.textContent = res.error || 'Failed to change password';
      }
    } catch {
      errorEl.textContent = t('ui.connectionError');
    }
  });

  // Notifications — handled by inline onclick="toggleNotifDropdown()"

  document.getElementById('notif-clear')?.addEventListener('click', async () => {
    await window.markAllNotifRead();
  });

  // Close dropdowns on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.user-menu')) {
      document.getElementById('user-dropdown').style.display = 'none';
    }
    if (!e.target.closest('#notif-btn') && !e.target.closest('#notif-dropdown')) {
      document.getElementById('notif-dropdown').style.display = 'none';
    }
  });

  // Hash routing
  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.slice(1) || 'home';
    const [page, ...rest] = hash.split('/');
    const params = rest.length ? { name: rest[0] } : {};
    navigate(page, params);
  });

  // Init
  checkAuth();
}


// === Auto-translate on DOM changes (i18n applyTranslations debounced) ===
(function() {
  let _i18nApplyTimer = null;
  const _scheduleApply = () => {
    if (_i18nApplyTimer) return;
    _i18nApplyTimer = setTimeout(() => {
      try { i18nApply(); } catch (e) {}
      _i18nApplyTimer = null;
    }, 50);
  };
  if (typeof MutationObserver !== 'undefined') {
    const obs = new MutationObserver(_scheduleApply);
    document.addEventListener('DOMContentLoaded', () => {
      obs.observe(document.body, { childList: true, subtree: true });
    });
  }
})();

initI18n().then(() => { init(); setTimeout(() => i18nApply(), 100); });
// Force cache bust 2026-06-02-v8-mcp
