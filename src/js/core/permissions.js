import { state } from './state.js';

function hasPerm(perm) {
  if (!state.user) return false;
  if (state.user.role === "admin") return true;
  return !!state.user.permissions?.[perm];
}

function _isSessionPinned(sid) {
  try { return JSON.parse(localStorage.getItem('hci_pinned_sessions') || '[]').includes(sid); } catch { return false; }
}

export { hasPerm, _isSessionPinned };
