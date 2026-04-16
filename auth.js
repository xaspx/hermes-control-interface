/* ============================================
   HCI Multi-User Auth Module
   ============================================ */
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HERMES_HOME = path.join(os.homedir(), '.hermes');
const USERS_FILE = path.join(HERMES_HOME, 'hci-users.json');
const AUDIT_FILE = path.join(HERMES_HOME, 'hci-audit.log');
const SALT_ROUNDS = 10;

// ── Permission Constants ──
const PERMISSIONS = [
  'sessions.view',
  'sessions.messages',
  'logs.view',
  'usage.view',
  'gateway.control',
  'config.edit',
  'secrets.view',
  'secrets.reveal',
  'secrets.edit',
  'skills.browse',
  'skills.install',
  'cron.view',
  'cron.manage',
  'files.read',
  'files.write',
  'terminal',
  'users.manage',
  'hci.update',
  'backup',
  'doctor',
];

// Presets
const VIEW_PERMS = PERMISSIONS.filter(p =>
  p.endsWith('.view') || p === 'skills.browse' || p === 'files.read' || p === 'cron.view'
);
const PRESET_PERMISSIONS = {
  admin: Object.fromEntries(PERMISSIONS.map(p => [p, true])),
  viewer: Object.fromEntries(PERMISSIONS.map(p => [p, VIEW_PERMS.includes(p)])),
};

function resolvePermissions(role, customPerms) {
  if (role === 'admin') return PRESET_PERMISSIONS.admin;
  if (role === 'viewer') return PRESET_PERMISSIONS.viewer;
  // custom — merge provided with viewer defaults
  return { ...PRESET_PERMISSIONS.viewer, ...(customPerms || {}) };
}

// Username validation — prevent injection and log corruption
function sanitizeUsername(name) {
  const s = String(name || '').trim();
  if (s.length < 2 || s.length > 32) return null;
  if (!/^[a-zA-Z0-9_.-]+$/.test(s)) return null;
  return s;
}

// ============================================
// User Store
// ============================================
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return { users: [] };
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return { users: [] };
  }
}

function saveUsers(data) {
  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function isFirstRun() {
  const data = loadUsers();
  return data.users.length === 0;
}

function findUser(username) {
  const data = loadUsers();
  return data.users.find(u => u.username === username) || null;
}

function createUser(username, password, role = 'viewer', customPerms = null) {
  const clean = sanitizeUsername(username);
  if (!clean) return { ok: false, error: 'Invalid username (2-32 chars, alphanumeric/_.- only)' };
  const data = loadUsers();
  if (data.users.find(u => u.username === clean)) {
    return { ok: false, error: 'Username already exists' };
  }
  const hash = bcrypt.hashSync(password, SALT_ROUNDS);
  const permissions = resolvePermissions(role, customPerms);
  data.users.push({
    username: clean,
    password_hash: hash,
    role,
    permissions,
    created_at: new Date().toISOString(),
    last_login: null,
  });
  saveUsers(data);
  audit('system', 'admin', 'USER_CREATE', `created user ${clean} (${role})`);
  return { ok: true };
}

function deleteUser(username, currentUser) {
  if (username === currentUser) {
    return { ok: false, error: 'Cannot delete yourself' };
  }
  const data = loadUsers();
  const idx = data.users.findIndex(u => u.username === username);
  if (idx === -1) return { ok: false, error: 'User not found' };

  // Check if last admin
  const user = data.users[idx];
  if (user.role === 'admin') {
    const adminCount = data.users.filter(u => u.role === 'admin').length;
    if (adminCount <= 1) {
      return { ok: false, error: 'Cannot delete the last admin' };
    }
  }

  data.users.splice(idx, 1);
  saveUsers(data);
  audit(currentUser, 'admin', 'USER_DELETE', `deleted user ${username}`);
  return { ok: true };
}

function verifyUserPassword(username, password) {
  const user = findUser(username);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password_hash)) return null;

  // Resolve permissions for existing users without them
  if (!user.permissions) {
    user.permissions = resolvePermissions(user.role);
  }

  // Update last_login
  const data = loadUsers();
  const u = data.users.find(x => x.username === username);
  if (u) {
    u.last_login = new Date().toISOString();
    if (!u.permissions) u.permissions = resolvePermissions(u.role);
    saveUsers(data);
  }
  return user;
}

function changePassword(username, currentPassword, newPassword) {
  const user = verifyUserPassword(username, currentPassword);
  if (!user) return { ok: false, error: 'Current password is incorrect' };
  if (newPassword.length < 8) return { ok: false, error: 'Password must be at least 8 characters' };

  const data = loadUsers();
  const u = data.users.find(x => x.username === username);
  if (u) {
    u.password_hash = bcrypt.hashSync(newPassword, SALT_ROUNDS);
    saveUsers(data);
  }
  audit(username, user.role, 'PASSWORD_CHANGE', 'changed own password');
  return { ok: true };
}

function resetUserPassword(username, newPassword, adminUser) {
  if (newPassword.length < 8) return { ok: false, error: 'Password must be at least 8 characters' };
  const data = loadUsers();
  const u = data.users.find(x => x.username === username);
  if (!u) return { ok: false, error: 'User not found' };
  u.password_hash = bcrypt.hashSync(newPassword, SALT_ROUNDS);
  saveUsers(data);
  audit(adminUser, 'admin', 'PASSWORD_RESET', `reset password for ${username}`);
  return { ok: true };
}

function listUsers() {
  const data = loadUsers();
  return data.users.map(u => ({
    username: u.username,
    role: u.role,
    permissions: u.permissions || resolvePermissions(u.role),
    created_at: u.created_at,
    last_login: u.last_login,
  }));
}

function updateUserPermissions(username, role, customPerms) {
  const data = loadUsers();
  const u = data.users.find(x => x.username === username);
  if (!u) return { ok: false, error: 'User not found' };
  u.role = role;
  u.permissions = resolvePermissions(role, customPerms);
  saveUsers(data);
  audit('system', 'admin', 'USER_UPDATE', `updated permissions for ${username} (${role})`);
  return { ok: true };
}

// ============================================
// Audit Log
// ============================================
function audit(username, role, action, details = '') {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${username}] [${role}] ${action}: ${details}\n`;
  try {
    const dir = path.dirname(AUDIT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, line, 'utf8');
  } catch {}
}

function getAuditLog(limit = 100) {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return [];
    const content = fs.readFileSync(AUDIT_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-limit).reverse();
  } catch {
    return [];
  }
}

// ============================================
// Notifications
// ============================================
const NOTIF_FILE = path.join(HERMES_HOME, 'hci-notifications.json');

function loadNotifications() {
  try {
    if (!fs.existsSync(NOTIF_FILE)) return [];
    return JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveNotifications(notifs) {
  const dir = path.dirname(NOTIF_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Keep last 100
  const trimmed = notifs.slice(-100);
  fs.writeFileSync(NOTIF_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
}

function addNotification(type, message) {
  const notifs = loadNotifications();
  notifs.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type, // error, warning, info, success
    message,
    timestamp: new Date().toISOString(),
    dismissed: false,
  });
  saveNotifications(notifs);
}

function dismissNotification(id) {
  const notifs = loadNotifications();
  const n = notifs.find(x => x.id === id);
  if (n) n.dismissed = true;
  saveNotifications(notifs);
}

function clearNotifications() {
  saveNotifications([]);
}

module.exports = {
  USERS_FILE,
  AUDIT_FILE,
  loadUsers,
  saveUsers,
  isFirstRun,
  findUser,
  createUser,
  deleteUser,
  verifyUserPassword,
  changePassword,
  resetUserPassword,
  sanitizeUsername,
  PERMISSIONS,
  PRESET_PERMISSIONS,
  resolvePermissions,
  listUsers,
  updateUserPermissions,
  audit,
  getAuditLog,
  loadNotifications,
  addNotification,
  dismissNotification,
  clearNotifications,
};
