/* ============================================
   HCI Main Entry Point
   ============================================ */
import { Chart, registerables } from 'chart.js';
import { initI18n, applyTranslations as i18nApply, t } from '../../i18n/index.js';
import { toDisplayText } from '../chat-render-utils.mjs';
import { resolveSessionDisplayTitle } from '../session-title-utils.mjs';
import { SSE_EVENT_TYPES, mapWsType } from '../../../lib/sse-events.js';
import { wsClient } from '../ws-client.js';
import { initKanbanBoard, destroyKanbanBoard, startKanbanPoll, stopKanbanPoll } from '../office-kanban.js';
Chart.register(...registerables);


// State
const state = {
  user: null,
  page: 'home',
  theme: localStorage.getItem('hci-theme') || 'dark',
  notifications: [],
  notifDisplayLimit: 5,
  notifInterval: null,
  notifFailCount: 0,
  _currentChatSession: null,
  _optMessages: null, // Map<optId, {text, el, ts}>
  _recentMessages: null, // Ring buffer for dedup {role, content, ts}[]
  chatSidebarOpen: localStorage.getItem('hci-chat-sidebar') !== 'false',
  _wsConnected: false, // WebSocket connection state
  _soundEnabled: false, // Sound notification preference
  _soundReady: false, // Audio element initialized
  _soundEl: null, // Audio element ref
  _wsToolCount: 0, // Live count of running tools
  _artifactCount: 0, // Live count of artifacts created
  auditDisplayLimit: 15,
  _officeInterval: null,
};

// ============================================
// Theme
// ============================================

function initTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  updateThemeIcon();
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', state.theme);
  localStorage.setItem('hci-theme', state.theme);
  updateThemeIcon();
}

function updateThemeIcon() {
  const icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = state.theme === 'dark' ? '🌙' : '☀️';
}

export { Chart, registerables, initI18n, i18nApply, t, toDisplayText, resolveSessionDisplayTitle, SSE_EVENT_TYPES, mapWsType, wsClient, initKanbanBoard, destroyKanbanBoard, startKanbanPoll, stopKanbanPoll, state, initTheme, toggleTheme, updateThemeIcon };
