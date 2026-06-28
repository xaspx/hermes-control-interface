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

function createUser(username, password, role = 'viewer', allowed_profiles = ['*']) {
  const clean = sanitizeUsername(username);
  if (!clean) return { ok: false, error: 'Invalid username (2-32 chars, alphanumeric/_.- only)' };
  const data = loadUsers();
  if (data.users.find(u => u.username === clean)) {
    return { ok: false, error: 'Username already exists' };
  }
  const hash = bcrypt.hashSync(password, SALT_ROUNDS);
  data.users.push({
    username: clean,
    password_hash: hash,
    role,
    allowed_profiles: role === 'admin' ? ['*'] : allowed_profiles,
    created_at: new Date().toISOString(),
    last_login: null,
  });
  saveUsers(data);
  audit('system', 'admin', 'USER_CREATE', `created user ${clean} (${role}) profiles=${JSON.stringify(allowed_profiles)}`);
  return { ok: true };
}

function updateUserProfiles(username, allowed_profiles, currentUser) {
  const data = loadUsers();
  const user = data.users.find(u => u.username === username);
  if (!user) return { ok: false, error: 'User not found' };
  user.allowed_profiles = allowed_profiles;
  saveUsers(data);
  audit(currentUser, 'admin', 'USER_UPDATE_PROFILES', `${username} profiles=${JSON.stringify(allowed_profiles)}`);
  return { ok: true };
}

function canAccessProfile(user, profileName) {
  if (!user || !user.allowed_profiles) return true; // legacy users get full access
  if (user.allowed_profiles.includes('*')) return true;
  return user.allowed_profiles.includes(profileName);
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

  // Update last_login
  const data = loadUsers();
  const u = data.users.find(x => x.username === username);
  if (u) {
    u.last_login = new Date().toISOString();
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

// ============================================
// Permissions
// ============================================
const PERMISSIONS = [
  'sessions.view','sessions.messages','sessions.delete',
  'chat.use','chat.manage',
  'logs.view','usage.view','usage.export',
  'gateway.view','gateway.control',
  'config.view','config.edit',
  'secrets.view','secrets.reveal','secrets.edit',
  'skills.browse','skills.install',
  'cron.view','cron.manage',
  'files.read','files.write',
  'terminal',
  'users.view','users.manage',
  'system.update','system.backup','system.doctor','system.restart',
];

const PRESET_PERMISSIONS = {
  admin: PERMISSIONS.reduce((acc, p) => { acc[p] = true; return acc; }, {}),
  viewer: {
    'sessions.view': true, 'sessions.messages': true, 'chat.use': true,
    'logs.view': true, 'usage.view': true, 'skills.browse': true, 'files.read': true,
  },
  custom: {},
};

function resolvePermissions(role, permissions) {
  if (role === 'admin') return { ...PRESET_PERMISSIONS.admin };
  if (role === 'viewer') return { ...PRESET_PERMISSIONS.viewer };
  if (role === 'custom' && permissions) return { ...permissions };
  return { ...PRESET_PERMISSIONS.viewer };
}

function updateUserPermissions(username, role, permissions) {
  const data = loadUsers();
  const u = data.users.find(x => x.username === username);
  if (!u) return { ok: false, error: 'User not found' };
  if (!['admin', 'viewer', 'custom'].includes(role)) return { ok: false, error: 'Invalid role' };
  u.role = role;
  if (role === 'custom') {
    u.permissions = permissions || {};
  } else {
    delete u.permissions;
  }
  saveUsers(data);
  audit('system', 'admin', 'USER_UPDATE', `updated ${username} role to ${role}`);
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
    created_at: u.created_at,
    last_login: u.last_login,
  }));
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
  listUsers,
  updateUserPermissions,
  updateUserProfiles,
  canAccessProfile,
  PERMISSIONS,
  PRESET_PERMISSIONS,
  resolvePermissions,
  audit,
  getAuditLog,
  loadNotifications,
  addNotification,
  dismissNotification,
  clearNotifications,
};
