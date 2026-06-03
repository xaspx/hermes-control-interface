import { state } from '../core/state.js';
import { api } from '../core/api.js';
import { escapeHtml } from '../core/utils.js';

async function fetchNotifications() {
  try {
    const res = await api('/api/notifications');
    if (res.ok && res.notifications) {
      const prevUnread = state.notifications.filter((n) => !n.dismissed).length;
      state.notifications = res.notifications;
      state.notifFailCount = 0;
      updateNotifBadge();
      // Re-render dropdown if it's open
      const dropdown = document.getElementById('notif-dropdown');
      if (dropdown && dropdown.style.display !== 'none') {
        renderNotifications();
      }
      // Flash badge if new unread notifications arrived
      const newUnread = state.notifications.filter((n) => !n.dismissed).length;
      if (newUnread > prevUnread && badgeFlashTimeout) clearTimeout(badgeFlashTimeout);
      const badge = document.getElementById('notif-badge');
      if (badge && newUnread > prevUnread) {
        badge.style.transform = 'scale(1.3)';
        badgeFlashTimeout = setTimeout(() => { badge.style.transform = 'scale(1)'; }, 300);
      }
    } else if (res.error === 'network' || res.error === 'rate-limited') {
      state.notifFailCount = (state.notifFailCount || 0) + 1;
      if (state.notifFailCount === 3 || state.notifFailCount === 6) startNotifPolling();
    }
  } catch {
    state.notifFailCount = (state.notifFailCount || 0) + 1;
    if (state.notifFailCount === 3 || state.notifFailCount === 6) startNotifPolling();
  }
}

function updateNotifBadge() {
  const badge = document.getElementById('notif-badge');
  const unread = state.notifications.filter((n) => !n.dismissed).length;
  if (unread > 0) {
    badge.textContent = unread > 99 ? '99+' : unread;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function startNotifPolling() {
  if (state.notifInterval) clearInterval(state.notifInterval);
  fetchNotifications();
  const failCount = state.notifFailCount || 0;
  const interval = failCount >= 6 ? 120000 : failCount >= 3 ? 60000 : 15000;
  state.notifInterval = setInterval(fetchNotifications, interval);
}

function notifColor(type) {
  const colors = {
    error: 'var(--coral, #ff6b6b)',
    warning: 'var(--amber, #fbbf24)',
    success: 'var(--green, #34d399)',
    info: 'var(--teal, #4ecdc4)',
  };
  return colors[type] || colors.info;
}

function notifIcon(type) {
  const icons = {
    error: '🔴',
    warning: '🟡',
    success: '🟢',
    info: '🔵',
  };
  return icons[type] || icons.info;
}

function renderNotifications() {
  const listEl = document.getElementById('notif-list');
  if (!listEl) return;
  const limit = state.notifDisplayLimit;
  const all = state.notifications.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  const shown = all.slice(0, limit);
  if (shown.length === 0) {
    listEl.innerHTML = '<div class="notif-empty" data-i18n="auto.noNotifications">No notifications</div>';
    return;
  }
  listEl.innerHTML = shown.map(n => {
    const color = notifColor(n.type);
    const icon = notifIcon(n.type);
    return `
      <div class="notif-item ${n.dismissed ? 'notif-read' : ''}" data-notif-id="${n.id || ''}" style="padding:8px;border-bottom:1px solid var(--border);font-size:11px;cursor:pointer;${n.dismissed ? 'opacity:0.5;' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;">
          <div style="flex-shrink:0;">${icon}</div>
          <div style="flex:1;color:${n.dismissed ? 'var(--fg-muted)' : 'var(--fg)'};">
            <span style="color:${color};font-weight:600;font-size:10px;text-transform:uppercase;">${n.type || 'info'}</span><br>${escapeHtml(n.message || '')}
          </div>
          <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();dismissNotifItem('${n.id || ''}')" style="padding:2px 6px;font-size:10px;color:var(--fg-muted);" title="Dismiss">✕</button>
        </div>
        <div style="color:var(--fg-subtle);font-size:10px;margin-top:2px;margin-left:22px;">${n.timestamp ? new Date(n.timestamp).toLocaleString() : ''}</div>
      </div>
    `;
  }).join('');

  // Click to mark as read
  listEl.querySelectorAll('.notif-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.notifId;
      if (id) markNotifRead(id);
      el.style.opacity = '0.5';
      el.classList.add('notif-read');
    });
  });

  // Load more button
  if (all.length > limit) {
    listEl.innerHTML += `<div style="padding:8px;text-align:center;"><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();loadMoreNotifs(${limit + 5})">Load more (${all.length - limit} remaining)</button></div>`;
  }
}

function loadMoreNotifs(newLimit) {
  state.notifDisplayLimit = newLimit || 10;
  renderNotifications();
}

async function markNotifRead(id) {
  const n = state.notifications.find(n => n.id === id);
  if (n) n.dismissed = true;
  updateNotifBadge();
  try { await api('/api/notifications/dismiss', { method: 'POST', body: JSON.stringify({ id }) }); } catch {}
}

async function dismissNotifItem(id) {
  const idx = state.notifications.findIndex(n => n.id === id);
  if (idx >= 0) { state.notifications[idx].dismissed = true; updateNotifBadge(); }
  try { await api('/api/notifications/dismiss', { method: 'POST', body: JSON.stringify({ id }) }); } catch {}
  state.notifDisplayLimit = Math.max(state.notifDisplayLimit, 5);
  renderNotifications();
}

async function markAllNotifRead() {
  state.notifications.forEach(n => n.dismissed = true);
  updateNotifBadge();
  try { await api('/api/notifications/clear', { method: 'POST' }); } catch {}
  state.notifDisplayLimit = 5;
  renderNotifications();
}

export { fetchNotifications, updateNotifBadge, startNotifPolling, notifColor, notifIcon, renderNotifications, markNotifRead, dismissNotifItem, loadMoreNotifs, markAllNotifRead };
