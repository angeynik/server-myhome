// auth.js
'use strict';

const jwt = require('jsonwebtoken');
const cfg = require('./authConfig');
const userStore = require('./userStore');
const logger = require('./logger.js');
logger.initLogging();

// ── Сессии, привязанные к clientId WS-соединения ────────────────────────
const sessions = new Map();
// clientId -> { userId, username, dID, level, tokenVersion, mustChangePassword, lastActivity }

// ── Rate-limit ──────────────────────────────────────────────────────────
const loginAttempts = new Map(); // "u:<username>" -> { count, until }
const ipAttempts    = new Map(); // "i:<ip>"       -> { count, until }

// ── JWT ─────────────────────────────────────────────────────────────────
function issueToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, dID: user.dID, tv: user.tokenVersion || 0 },
    cfg.JWT_SECRET,
    { expiresIn: cfg.JWT_EXPIRES, issuer: cfg.JWT_ISSUER }
  );
}

function verifyToken(token) {
  if (!token) throw new Error('No token provided');
  return jwt.verify(token, cfg.JWT_SECRET, { issuer: cfg.JWT_ISSUER });
}

// ── Сессии ──────────────────────────────────────────────────────────────
const getSession   = (clientId) => sessions.get(clientId) || null;
const clearSession = (clientId) => sessions.delete(clientId);
const setSession   = (clientId, s) => sessions.set(clientId, { ...s, lastActivity: Date.now() });
const touchSession = (clientId) => { const s = sessions.get(clientId); if (s) s.lastActivity = Date.now(); };

function isSessionTimedOut(clientId) {
  if (!cfg.AUTH_TIMEOUT_MS) return false;
  const s = sessions.get(clientId);
  if (!s) return false;
  return Date.now() - s.lastActivity > cfg.AUTH_TIMEOUT_MS;
}

function cleanupSessions() {
  // 1. Протухшие сессии
  let n = 0;
  if (cfg.AUTH_TIMEOUT_MS) {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastActivity > cfg.AUTH_TIMEOUT_MS) { sessions.delete(id); n++; }
    }
  }

  // 2. Rate-limit: снимаем протухшие записи (иначе карты растут вечно)
  const now = Date.now();
  for (const [k, v] of loginAttempts) {
    if (v.until && v.until < now) loginAttempts.delete(k);
  }
  for (const [k, v] of ipAttempts) {
    if (v.until && v.until < now) ipAttempts.delete(k);
  }

  if (n) logger.logInfoMessage(`[auth] - cleanupSessions: удалено сессий ${n}`);
  return n;
}

// ── Rate-limit helpers ──────────────────────────────────────────────────
function checkLoginLock(username, ip) {
  const now = Date.now();
  const u = loginAttempts.get(`u:${username}`);
  const i = ipAttempts.get(`i:${ip}`);
  if (u && u.count >= cfg.LOGIN_MAX_ATTEMPTS && u.until > now) {
    return { locked: true, retryAfter: Math.ceil((u.until - now) / 1000) };
  }
  if (i && i.count >= cfg.LOGIN_IP_MAX_ATTEMPTS && i.until > now) {
    return { locked: true, retryAfter: Math.ceil((i.until - now) / 1000) };
  }
  return { locked: false };
}

function bumpCounter(map, key, max, now) {
  const cur = map.get(key) || { count: 0, until: 0 };
  if (cur.until < now) { cur.count = 0; cur.until = 0; }
  cur.count++;
  if (cur.count >= max) cur.until = now + cfg.LOGIN_LOCK_MS;
  map.set(key, cur);
}

function recordLoginFailure(username, ip) {
  const now = Date.now();
  bumpCounter(loginAttempts, `u:${username}`, cfg.LOGIN_MAX_ATTEMPTS, now);
  bumpCounter(ipAttempts,    `i:${ip}`,       cfg.LOGIN_IP_MAX_ATTEMPTS, now);
}

function clearLoginFailures(username, ip) {
  loginAttempts.delete(`u:${username}`);
  ipAttempts.delete(`i:${ip}`);
}

// ── Логин ───────────────────────────────────────────────────────────────
async function loginUser(clientId, username, password, ip = 'unknown') {
  const uname = String(username || '').trim();
  if (!uname || !password) return { error: 'Не указан логин или пароль', code: 'MISSING_FIELDS' };

  const lock = checkLoginLock(uname, ip);
  if (lock.locked) {
    return { error: `Слишком много попыток. Повторите через ${lock.retryAfter} сек.`, code: 'LOCKED' };
  }

  const user = await userStore.verifyCredentials(uname, password);
  if (!user) {
    recordLoginFailure(uname, ip);
    return { error: 'Неверный логин или пароль', code: 'BAD_CREDENTIALS' };
  }

  if (user.disabled) return { error: 'Учётная запись отключена', code: 'ACCOUNT_DISABLED' };

  clearLoginFailures(uname, ip);
  const token = issueToken(user);
  userStore.recordLogin(user.username).catch((e) => logger.logErrorMessage(`[auth] - recordLogin: ${e.message}`));
  setSession(clientId, {
    userId: user.id,
    uid: user.uid,
    username: user.username,
    dID: user.dID,
    level: user.permissionLevel,
    tokenVersion: user.tokenVersion || 0,
    mustChangePassword: !!user.mustChangePassword,
  });

  logger.logInfoMessage(`[auth] - loginUser: ${uname} (${user.dID}, level=${user.permissionLevel})`);
  return {
    token,
    username: user.username,
    userlevel: user.permissionLevel,
    dID: user.dID,
    mustChangePassword: !!user.mustChangePassword,
    profile: userStore.toPublic(user),
  };
}

// ── Resume ──────────────────────────────────────────────────────────────
async function resumeSession(clientId, token) {
  try {
    const payload = verifyToken(token);
    const user = await userStore.findUser(payload.username);
    if (!user) return { error: 'Пользователь не найден', code: 'NO_USER' };
    if (user.disabled) return { error: 'Учётная запись отключена', code: 'ACCOUNT_DISABLED' };
    if ((user.tokenVersion || 0) !== (payload.tv || 0)) {
      return { error: 'Токен отозван', code: 'TOKEN_REVOKED' };
    }
    setSession(clientId, {
      userId: user.id,
      uid: user.uid,
      username: user.username,
      dID: user.dID,
      level: user.permissionLevel,
      tokenVersion: user.tokenVersion || 0,
      mustChangePassword: !!user.mustChangePassword,
    });
    return {
      token,
      username: user.username,
      userlevel: user.permissionLevel,
      dID: user.dID,
      mustChangePassword: !!user.mustChangePassword,
      profile: userStore.toPublic(user),
    };
  } catch (e) {
    return { error: 'Недействительный токен', code: 'BAD_TOKEN' };
  }
}

// ── Logout ──────────────────────────────────────────────────────────────
function logout(clientId) {
  const s = sessions.get(clientId);
  if (s) logger.logInfoMessage(`[auth] - logout: ${s.username}`);
  clearSession(clientId);
}

// ── Change own password ─────────────────────────────────────────────────
async function changeOwnPassword(clientId, oldPassword, newPassword) {
  const s = getSession(clientId);
  if (!s) return { error: 'Нет активной сессии', code: 'NO_SESSION' };
  try {
    const updated = await userStore.changePassword(s.username, oldPassword, newPassword);
    const token = issueToken(updated);
    s.tokenVersion = updated.tokenVersion || 0;
    s.mustChangePassword = false;
    return { token, message: 'Пароль изменён' };
  } catch (e) {
    return { error: e.message, code: e.code || 'CHANGE_ERROR' };
  }
}

// ── Refresh ─────────────────────────────────────────────────────────────
async function refresh(clientId) {
  const s = getSession(clientId);
  if (!s) return { error: 'Нет активной сессии', code: 'NO_SESSION' };
  const user = await userStore.findUser(s.username);
  if (!user) return { error: 'Пользователь не найден', code: 'NO_USER' };
  if (user.disabled || (user.tokenVersion || 0) !== s.tokenVersion) {
    clearSession(clientId);
    return { error: 'Токен отозван', code: 'TOKEN_REVOKED' };
  }
  touchSession(clientId);
  return { token: issueToken(user) };
}

// ── Профиль и сброс сессий ──────────────────────────────────────────────
async function getProfile(clientId) {
  const s = getSession(clientId);
  if (!s) return null;
  return userStore.toPublic(await userStore.findUser(s.username));
}

function invalidateUserSessions(username) {
  const n = String(username || '').trim().toLowerCase();
  let count = 0;
  for (const [id, s] of sessions) {
    if (String(s.username).toLowerCase() === n) {
      sessions.delete(id);
      count++;
    }
  }
  if (count) logger.logInfoMessage(`[auth] - invalidateUserSessions: ${username}, сессий ${count}`);
  return count;
}

// ── Права ───────────────────────────────────────────────────────────────
function requiredLevel(type, request) {
  const table = cfg.REQUIRED_LEVEL[type];
  if (!table) return null;
  return table[request] ?? table._default ?? null;
}

function hasLevel(clientId, type, request) {
  const s = getSession(clientId);
  if (!s) return false;
  const need = requiredLevel(type, request);
  if (need === null) return false;
  return s.level >= need;
}

// ── Главный middleware ──────────────────────────────────────────────────
function checkMessageAccess(clientId, type, request, name) {
  // 1. Публичные auth-запросы
  if (type === 'auth' && cfg.PUBLIC_AUTH_REQUESTS.has(request)) return { ok: true };

  // 2. Остальные auth — нужна сессия
  if (type === 'auth') {
    const s = getSession(clientId);
    if (!s) return { ok: false, code: 'NO_SESSION', message: 'Не авторизован' };
    if (isSessionTimedOut(clientId)) {
      clearSession(clientId);
      return { ok: false, code: 'TIMEOUT', message: 'Сессия истекла' };
    }
    return { ok: true };
  }

  // 3. Остальное — сессия + уровень
  const s = getSession(clientId);
  if (!s) return { ok: false, code: 'NO_SESSION', message: 'Не авторизован' };
  if (isSessionTimedOut(clientId)) {
    clearSession(clientId);
    return { ok: false, code: 'TIMEOUT', message: 'Сессия истекла' };
  }
  if (name !== undefined && s.level < 3 && name !== s.dID) {
    logger.logErrorMessage(`[auth] - DID_MISMATCH: ${s.username} (${s.dID}) -> ${name}`);
    return { ok: false, code: 'DID_MISMATCH', message: 'Нет доступа к чужому источнику данных' };
  }
  if (!hasLevel(clientId, type, request)) {
    logger.logErrorMessage(`[auth] - FORBIDDEN: ${s.username} (level=${s.level}) -> ${type}/${request}`);
    return { ok: false, code: 'FORBIDDEN', message: 'Недостаточно прав' };
  }
  touchSession(clientId);
  return { ok: true };
}

module.exports = {
  issueToken, verifyToken,
  loginUser, resumeSession, logout, refresh, changeOwnPassword,
  getSession, setSession, clearSession, touchSession, isSessionTimedOut, cleanupSessions,
  hasLevel, requiredLevel, checkMessageAccess,
  getProfile, invalidateUserSessions,
};