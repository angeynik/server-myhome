// services/userStore.js
// Зашифрованное файловое хранилище пользователей (AES-256-GCM).
// Формат файла: [iv(12)] [tag(16)] [ciphertext]. Структура JSON внутри версионируется (data.version);
// записи старых версий автоматически дополняются недостающими полями при загрузке (migrate).
//
// Модель пользователя:
//   id, uid (UUID), username, password (bcrypt), email, displayName,
//   permissionLevel (1..3), dID, dataSourceName,
//   disabled, tokenVersion, mustChangePassword,
//   telegram { chatId, username, firstName, linkedAt },
//   notify   { telegram, minSeverity },
//   createdAt, updatedAt, lastLoginAt.
//
// Все изменения идут через очередь (mutex) и пишутся атомарно, кэш обновляется после записи.
'use strict';

const cfg = require('./authConfig');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const logger = require('./logger.js');
logger.initLogging();

const env = process.env;
const USERS_FILE = env.USERS_FILE || './data/users.enc';
const KEY_FILE = env.AUTH_KEY_FILE || './data/auth.key';
const DEFAULT_DID = env.DEFAULT_USER_DID || 'poddy_base';
const DEFAULT_NAME = env.DEFAULT_USER_NAME || 'poddy';
const DEFAULT_LEVEL = parseInt(env.DEFAULT_USER_LEVEL, 10) || 3;
const DEFAULT_SOURCE = env.DEFAULT_USER_SOURCE || 'PoddyBase';

const SCHEMA_VERSION = 2;
const USERNAME_RE = /^[\p{L}\p{N}_.-]{3,32}$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_SEVERITIES = ['info', 'warning', 'alarm'];
const ADMIN_LEVEL = 3;

let cache = null;
let masterKey = null;
let loading = null;

function authError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

// ── ключ шифрования ─────────────────────────────────────────────────────
async function loadOrCreateKey() {
  if (masterKey) return masterKey;

  if (env.AUTH_MASTER_KEY) {
    const k = Buffer.from(env.AUTH_MASTER_KEY, 'hex');
    if (k.length !== 32) throw new Error('AUTH_MASTER_KEY must be 32 bytes hex');
    masterKey = k;
    return masterKey;
  }

  await fs.mkdir(path.dirname(KEY_FILE), { recursive: true });
  try {
    const hex = (await fs.readFile(KEY_FILE, 'utf8')).trim();
    const k = Buffer.from(hex, 'hex');
    if (k.length !== 32) throw new Error('key file corrupt');
    masterKey = k;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    masterKey = crypto.randomBytes(32);
    await fs.writeFile(KEY_FILE, masterKey.toString('hex'), { mode: 0o600 });
    logger.logInfoMessage(`[userStore] - сгенерирован новый ключ ${KEY_FILE}`);
  }
  return masterKey;
}

// ── чтение/запись файла ─────────────────────────────────────────────────
async function writeEncrypted(data) {
  const key = await loadOrCreateKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(data), 'utf8')), cipher.final()]);
  const out = Buffer.concat([iv, cipher.getAuthTag(), enc]);

  await fs.mkdir(path.dirname(USERS_FILE), { recursive: true });
  const tmp = `${USERS_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, out, { mode: 0o600 });
  await fs.rename(tmp, USERS_FILE);
}

async function readEncrypted() {
  const key = await loadOrCreateKey();
  const raw = await fs.readFile(USERS_FILE);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// ── модель и миграция ───────────────────────────────────────────────────
const nowIso = () => new Date().toISOString();
const emptyTelegram = () => ({ chatId: null, username: null, firstName: null, linkedAt: null });
const defaultNotify = () => ({ telegram: true, minSeverity: 'info' });

function fillMissing(target, defaults) {
  let changed = false;
  for (const [k, v] of Object.entries(defaults)) {
    if (target[k] === undefined) {
      target[k] = v;
      changed = true;
    }
  }
  return changed;
}

function normalizeUser(u) {
  let changed = fillMissing(u, {
    uid: crypto.randomUUID(),
    email: null,
    displayName: null,
    disabled: false,
    tokenVersion: 0,
    mustChangePassword: false,
    createdAt: nowIso(),
    lastLoginAt: null,
  });
  if (u.updatedAt === undefined) {
    u.updatedAt = u.createdAt;
    changed = true;
  }
  if (!u.telegram || typeof u.telegram !== 'object') {
    u.telegram = emptyTelegram();
    changed = true;
  } else if (fillMissing(u.telegram, emptyTelegram())) {
    changed = true;
  }
  if (!u.notify || typeof u.notify !== 'object') {
    u.notify = defaultNotify();
    changed = true;
  } else if (fillMissing(u.notify, defaultNotify())) {
    changed = true;
  }
  return changed;
}

function migrate(data) {
  let changed = false;
  if (!Array.isArray(data.users)) {
    data.users = [];
    changed = true;
  }
  if (!Array.isArray(data.datasources)) {
    data.datasources = [];
    changed = true;
  }
  for (const u of data.users) {
    if (normalizeUser(u)) changed = true;
  }
  if (data.version !== SCHEMA_VERSION) {
    data.version = SCHEMA_VERSION;
    changed = true;
  }
  return changed;
}

function newUserRecord({ id, username, hash, level, did, source, email, displayName, mustChangePassword, notify }) {
  const t = nowIso();
  return {
    id,
    uid: crypto.randomUUID(),
    username,
    password: hash,
    email: email || null,
    displayName: displayName || null,
    permissionLevel: level,
    dID: did,
    dataSourceName: source,
    disabled: false,
    tokenVersion: 0,
    mustChangePassword: Boolean(mustChangePassword),
    telegram: emptyTelegram(),
    notify: { ...defaultNotify(), ...(notify || {}) },
    createdAt: t,
    updatedAt: t,
    lastLoginAt: null,
  };
}

// ── первичное наполнение ────────────────────────────────────────────────
async function bootstrap() {
  let pass = env.DEFAULT_USER_PASSWORD;
  if (!pass) {
    pass = crypto.randomBytes(9).toString('base64url');
    process.stderr.write(
      `\n[userStore] Создан пользователь "${DEFAULT_NAME}". Временный пароль: ${pass}\n` +
      '[userStore] Смените его сразу после входа.\n\n'
    );
  }
  return {
    version: SCHEMA_VERSION,
    users: [newUserRecord({
      id: 1,
      username: DEFAULT_NAME,
      hash: await bcrypt.hash(pass, cfg.BCRYPT_ROUNDS),
      level: DEFAULT_LEVEL,
      did: DEFAULT_DID,
      source: DEFAULT_SOURCE,
      mustChangePassword: true,
    })],
    datasources: [{ id: 1, did: DEFAULT_DID, name: DEFAULT_SOURCE }],
  };
}

async function doLoad() {
  try {
    cache = await readEncrypted();
    if (migrate(cache)) {
      await writeEncrypted(cache);
      logger.logInfoMessage(`[userStore] - данные пользователей обновлены до версии ${SCHEMA_VERSION}`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const fresh = await bootstrap();
    await writeEncrypted(fresh);
    cache = fresh;
  }
  return cache;
}

async function loadUsers() {
  if (cache) return cache;
  if (!loading) loading = doLoad().finally(() => { loading = null; });
  return loading;
}

function mutate(fn) {
  return withLock(async () => {
    const current = await loadUsers();
    const draft = JSON.parse(JSON.stringify(current));
    const result = await fn(draft);
    await writeEncrypted(draft);
    cache = draft;
    return result;
  });
}

// ── утилиты ─────────────────────────────────────────────────────────────
const norm = (s) => String(s || '').trim().toLowerCase();
const clone = (o) => JSON.parse(JSON.stringify(o));

function deriveDID(username) {
  const base = String(username || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_');
  return `${base}_base`;
}

function toPublic(u) {
  if (!u) return null;
  return {
    id: u.id,
    uid: u.uid,
    username: u.username,
    displayName: u.displayName || null,
    email: u.email || null,
    permissionLevel: u.permissionLevel,
    dID: u.dID,
    dataSourceName: u.dataSourceName,
    disabled: Boolean(u.disabled),
    mustChangePassword: Boolean(u.mustChangePassword),
    telegram: {
      linked: Boolean(u.telegram?.chatId),
      username: u.telegram?.username || null,
      linkedAt: u.telegram?.linkedAt || null,
    },
    notify: { ...defaultNotify(), ...(u.notify || {}) },
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
  };
}

function forNotify(u) {
  return clone({
    id: u.id,
    uid: u.uid,
    username: u.username,
    dID: u.dID,
    permissionLevel: u.permissionLevel,
    disabled: Boolean(u.disabled),
    telegram: u.telegram || emptyTelegram(),
    notify: { ...defaultNotify(), ...(u.notify || {}) },
  });
}

function checkPasswordPolicy(p) {
  if (typeof p !== 'string' || p.length < cfg.MIN_PASSWORD_LEN) {
    throw authError('WEAK_PASSWORD', `Пароль должен быть не короче ${cfg.MIN_PASSWORD_LEN} символов`);
  }
  if (Buffer.byteLength(p, 'utf8') > cfg.MAX_PASSWORD_LEN) {
    throw authError('WEAK_PASSWORD', `Пароль не должен превышать ${cfg.MAX_PASSWORD_LEN} байт`);
  }
}

function parseLevel(level) {
  const lvl = parseInt(level, 10);
  if (![1, 2, 3].includes(lvl)) throw authError('BAD_LEVEL', 'Уровень доступа должен быть 1, 2 или 3');
  return lvl;
}

function parseEmail(email) {
  if (email === null || email === undefined || email === '') return null;
  const e = String(email).trim();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw authError('BAD_EMAIL', 'Некорректный email');
  return e;
}

function parseDisplayName(name) {
  if (name === null || name === undefined || name === '') return null;
  const n = String(name).trim();
  if (n.length > 64) throw authError('BAD_NAME', 'Отображаемое имя не длиннее 64 символов');
  return n || null;
}

function parseNotify(patch, current) {
  if (!patch || typeof patch !== 'object') throw authError('BAD_NOTIFY', 'Некорректные настройки оповещений');
  const next = { ...defaultNotify(), ...(current || {}) };
  if (patch.telegram !== undefined) next.telegram = Boolean(patch.telegram);
  if (patch.minSeverity !== undefined) {
    if (!MIN_SEVERITIES.includes(patch.minSeverity)) {
      throw authError('BAD_NOTIFY', `minSeverity: ${MIN_SEVERITIES.join(' | ')}`);
    }
    next.minSeverity = patch.minSeverity;
  }
  return next;
}

function applyProfile(u, patch) {
  if (patch.email !== undefined) u.email = parseEmail(patch.email);
  if (patch.displayName !== undefined) u.displayName = parseDisplayName(patch.displayName);
  if (patch.notify !== undefined) u.notify = parseNotify(patch.notify, u.notify);
}

const hasAdmin = (data) => data.users.some((u) => u.permissionLevel >= ADMIN_LEVEL && !u.disabled);

function findIn(data, username) {
  const u = data.users.find((x) => norm(x.username) === norm(username));
  if (!u) throw authError('NO_USER', 'Пользователь не найден');
  return u;
}

function nextId(list) {
  return list.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
}

function ensureDataSource(data, did, name) {
  if (!data.datasources.some((d) => d.did === did)) {
    data.datasources.push({ id: nextId(data.datasources), did, name });
  }
}

function assignDID(data, u, did, name) {
  u.dID = did;
  u.dataSourceName = name;
  u.tokenVersion = (u.tokenVersion || 0) + 1;
  u.updatedAt = nowIso();
  ensureDataSource(data, did, name);
}

// ── чтение ──────────────────────────────────────────────────────────────
async function findUser(username) {
  const { users } = await loadUsers();
  const n = norm(username);
  return users.find((u) => norm(u.username) === n) || null;
}

async function findByTelegramChatId(chatId) {
  const { users } = await loadUsers();
  const id = String(chatId);
  const u = users.find((x) => x.telegram?.chatId === id);
  return u ? forNotify(u) : null;
}

async function findUsersForNotification({ dID, minLevel = 1 }) {
  const { users } = await loadUsers();
  return users
    .filter((u) => u.dID === dID && !u.disabled && u.permissionLevel >= minLevel)
    .map(forNotify);
}

async function listUsers() {
  const { users } = await loadUsers();
  return users.map(toPublic);
}

async function listDataSources() {
  const { users, datasources } = await loadUsers();
  return datasources.map((d) => ({
    id: d.id,
    did: d.did,
    name: d.name || null,
    users: users.filter((u) => u.dID === d.did).length,
  }));
}

let dummyHash = null;
async function getDummyHash() {
  if (!dummyHash) dummyHash = await bcrypt.hash(crypto.randomBytes(8).toString('hex'), cfg.BCRYPT_ROUNDS);
  return dummyHash;
}

async function verifyCredentials(username, password) {
  const user = await findUser(username);
  const ok = await bcrypt.compare(String(password), user ? user.password : await getDummyHash());
  return user && ok ? user : null;
}

// ── запись ──────────────────────────────────────────────────────────────
// registerUser(username, password, level, dID?, sourceName?, extra?)
// extra: { email, displayName, notify, mustChangePassword }
async function registerUser(username, password, level, dID, sourceName, extra = {}) {
  username = String(username || '').trim();
  if (!USERNAME_RE.test(username)) throw authError('BAD_USERNAME', 'Имя: 3–32 символа (буквы, цифры, _ . -)');
  checkPasswordPolicy(password);
  const lvl = parseLevel(level);

  const finalDID = dID ? String(dID).trim() : deriveDID(username);
  if (!cfg.isValidDID(finalDID)) throw authError('BAD_DID', 'Недопустимый dID (латиница, цифры, _ и -)');
  const finalSource = sourceName || finalDID;

  const email = parseEmail(extra.email);
  const displayName = parseDisplayName(extra.displayName);
  const notify = extra.notify !== undefined ? parseNotify(extra.notify, defaultNotify()) : undefined;
  const hash = await bcrypt.hash(password, cfg.BCRYPT_ROUNDS);

  return mutate((data) => {
    if (data.users.some((u) => norm(u.username) === norm(username))) {
      throw authError('USER_EXISTS', 'Пользователь уже существует');
    }
    const user = newUserRecord({
      id: nextId(data.users),
      username,
      hash,
      level: lvl,
      did: finalDID,
      source: finalSource,
      email,
      displayName,
      mustChangePassword: extra.mustChangePassword,
      notify,
    });
    data.users.push(user);
    ensureDataSource(data, finalDID, finalSource);
    return { user: toPublic(user), userCreated: true };
  });
}

async function changePassword(username, oldPassword, newPassword) {
  const current = await verifyCredentials(username, oldPassword);
  if (!current) throw authError('BAD_PASSWORD', 'Текущий пароль неверен');
  checkPasswordPolicy(newPassword);
  const hash = await bcrypt.hash(newPassword, cfg.BCRYPT_ROUNDS);
  return mutate((data) => {
    const u = data.users.find((x) => x.id === current.id);
    u.password = hash;
    u.tokenVersion = (u.tokenVersion || 0) + 1;
    u.mustChangePassword = false;
    u.updatedAt = nowIso();
    return clone(u);
  });
}

async function changeUserDID(username, newDID, sourceName) {
  const did = String(newDID || '').trim();
  if (!cfg.isValidDID(did)) throw authError('BAD_DID', 'Недопустимый dID (латиница, цифры, _ и -)');
  const src = sourceName || did;

  return mutate((data) => {
    const u = findIn(data, username);
    assignDID(data, u, did, src);
    return toPublic(u);
  });
}

async function linkUserToDataSource(userId, dataSourceId) {
  return mutate((data) => {
    const u = data.users.find((x) => x.id === userId);
    if (!u) throw authError('NO_USER', `Пользователь с id=${userId} не найден`);
    const d = data.datasources.find((x) => x.id === dataSourceId);
    if (!d) throw authError('NO_DATASOURCE', `Источник данных с id=${dataSourceId} не найден`);
    const changed = u.dID !== d.did;
    if (changed) assignDID(data, u, d.did, d.name || d.did);
    return { user: toPublic(u), revoked: changed };
  });
}

async function setPassword(username, newPassword, { mustChange = false } = {}) {
  checkPasswordPolicy(newPassword);
  const hash = await bcrypt.hash(newPassword, cfg.BCRYPT_ROUNDS);
  return mutate((data) => {
    const u = findIn(data, username);
    u.password = hash;
    u.tokenVersion = (u.tokenVersion || 0) + 1;
    if (mustChange) u.mustChangePassword = true;
    u.updatedAt = nowIso();
    return toPublic(u);
  });
}

async function bumpTokenVersion(username) {
  return mutate((data) => {
    const u = findIn(data, username);
    u.tokenVersion = (u.tokenVersion || 0) + 1;
    return u.tokenVersion;
  });
}

// Редактирование администратором. Возвращает { user, revoked }:
// revoked = true, если у пользователя нужно сбросить активные сессии.
async function updateUser(username, patch = {}) {
  const allowed = ['permissionLevel', 'email', 'displayName', 'disabled', 'notify', 'unlinkTelegram'];
  const unknown = Object.keys(patch).filter((k) => !allowed.includes(k));
  if (unknown.length) throw authError('BAD_FIELD', `Недопустимые поля: ${unknown.join(', ')}`);

  return mutate((data) => {
    const u = findIn(data, username);
    const hadAdmin = hasAdmin(data);
    let revoked = false;

    if (patch.permissionLevel !== undefined) {
      const lvl = parseLevel(patch.permissionLevel);
      if (lvl !== u.permissionLevel) {
        u.permissionLevel = lvl;
        revoked = true;
      }
    }
    if (patch.disabled !== undefined) {
      const d = Boolean(patch.disabled);
      if (d !== Boolean(u.disabled)) {
        u.disabled = d;
        if (d) revoked = true;
      }
    }
    if (patch.unlinkTelegram === true) u.telegram = emptyTelegram();
    applyProfile(u, patch);

    if (hadAdmin && !hasAdmin(data)) {
      throw authError('LAST_ADMIN', 'Нельзя лишить систему последнего администратора');
    }
    if (revoked) u.tokenVersion = (u.tokenVersion || 0) + 1;
    u.updatedAt = nowIso();
    return { user: toPublic(u), revoked };
  });
}

async function updateOwnProfile(username, patch = {}) {
  return mutate((data) => {
    const u = findIn(data, username);
    applyProfile(u, patch);
    u.updatedAt = nowIso();
    return toPublic(u);
  });
}

async function setTelegram(username, { chatId, username: tgUsername = null, firstName = null }) {
  if (!chatId) throw authError('BAD_CHAT', 'Не указан chatId');
  const id = String(chatId);
  return mutate((data) => {
    const u = findIn(data, username);
    const busy = data.users.find((x) => x !== u && x.telegram?.chatId === id);
    if (busy) throw authError('TELEGRAM_BUSY', 'Этот Telegram-чат уже привязан к другой учётной записи');
    u.telegram = { chatId: id, username: tgUsername, firstName, linkedAt: nowIso() };
    u.updatedAt = nowIso();
    return toPublic(u);
  });
}

async function clearTelegram(username) {
  return mutate((data) => {
    const u = findIn(data, username);
    u.telegram = emptyTelegram();
    u.updatedAt = nowIso();
    return toPublic(u);
  });
}

async function recordLogin(username) {
  return mutate((data) => {
    const u = findIn(data, username);
    u.lastLoginAt = nowIso();
    return u.lastLoginAt;
  });
}

async function fetchUsers() {
  const { users } = await loadUsers();
  return users.map((u) => ({ id: u.id, username: u.username }));
}

async function fetchDataSources() {
  const { datasources } = await loadUsers();
  return datasources.map((d) => ({ id: d.id, did: d.did }));
}

async function deleteUser(username) {
  const uname = String(username || '').trim();
  if (!uname) throw authError('BAD_USERNAME', 'Имя не указано');

  return mutate((state) => {
    const hadAdmin = hasAdmin(state);
    const idx = state.users.findIndex((u) => norm(u.username) === norm(uname));
    if (idx === -1) throw authError('NO_USER', 'Пользователь не найден');

    const [removed] = state.users.splice(idx, 1);
    if (hadAdmin && !hasAdmin(state)) {
      throw authError('LAST_ADMIN', 'Нельзя удалить последнего администратора');
    }
    const otherUsersOnSameDID = state.users.filter((u) => u.dID === removed.dID).length;
    return { username: removed.username, uid: removed.uid, dID: removed.dID, otherUsersOnSameDID };
  });
}

async function deleteDataSource(did) {
  const d = String(did || '').trim();
  if (!d) throw authError('BAD_DID', 'dID не указан');

  return mutate((state) => {
    const idx = state.datasources.findIndex((x) => x.did === d);
    if (idx === -1) throw authError('NO_DATASOURCE', 'Источник данных не найден');

    const usersOnIt = state.users.filter((u) => u.dID === d);
    if (usersOnIt.length > 0) {
      throw authError(
        'DATASOURCE_IN_USE',
        `На dID="${d}" ещё есть пользователи: ${usersOnIt.map((u) => u.username).join(', ')}`
      );
    }

    const [removed] = state.datasources.splice(idx, 1);
    return { did: removed.did, name: removed.name || null };
  });
}

async function cleanDataSources() {
  return mutate((state) => {
    const used = new Set(state.users.map((u) => u.dID).filter(Boolean));
    const before = state.datasources.length;
    const removed = [];

    state.datasources = state.datasources.filter((d) => {
      if (used.has(d.did)) return true;
      removed.push({ did: d.did, name: d.name || null });
      return false;
    });

    return { removed, removedCount: removed.length, keptCount: state.datasources.length, before };
  });
}

module.exports = {
  loadUsers,
  findUser,
  findByTelegramChatId,
  findUsersForNotification,
  verifyCredentials,
  registerUser,
  changePassword,
  setPassword,
  bumpTokenVersion,
  changeUserDID,
  linkUserToDataSource,
  updateUser,
  updateOwnProfile,
  setTelegram,
  clearTelegram,
  recordLogin,
  listUsers,
  listDataSources,
  fetchUsers,
  fetchDataSources,
  toPublic,
  deleteUser,
  deleteDataSource,
  cleanDataSources,
};
