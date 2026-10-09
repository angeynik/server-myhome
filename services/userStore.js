// services/userStore.js
// Зашифрованное файловое хранилище пользователей (AES-256-GCM).
// Формат файла НЕ изменён: [iv(12)] [tag(16)] [ciphertext] — существующий
// data/users.enc читается как есть. Новые поля (tokenVersion, mustChangePassword)
// появляются у пользователей по мере изменения; их отсутствие трактуется как 0/false.
//
// Что изменилось по сравнению со старой версией:
//   • dotenv загружается ДО чтения env (через authConfig);
//   • все изменения идут через очередь (mutex) и пишутся атомарно,
//     кэш обновляется только после успешной записи;
//   • валидация username / пароля / уровня / dID;
//   • регистрация не возвращает хеш пароля;
//   • вход не раскрывает, существует ли пользователь (dummy-сравнение bcrypt);
//   • changePassword / setPassword / bumpTokenVersion (отзыв токенов).
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

const USERNAME_RE = /^[\p{L}\p{N}_.-]{3,32}$/u;

let cache = null;
let masterKey = null;
let loading = null;

// ── ошибки с кодом ──────────────────────────────────────────────────────
function authError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ── очередь записи ──────────────────────────────────────────────────────
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

// ── первичное наполнение ────────────────────────────────────────────────
async function bootstrap() {
  let pass = env.DEFAULT_USER_PASSWORD;
  if (!pass) {
    pass = crypto.randomBytes(9).toString('base64url'); // 12 символов
    // Единственное место, где пароль выводится: админ должен его увидеть.
    process.stderr.write(
      `\n[userStore] Создан пользователь "${DEFAULT_NAME}". Временный пароль: ${pass}\n` +
      `[userStore] Смените его сразу после входа.\n\n`
    );
  }
  return {
    users: [{
      id: 1,
      username: DEFAULT_NAME,
      password: await bcrypt.hash(pass, cfg.BCRYPT_ROUNDS),
      email: null,
      permissionLevel: DEFAULT_LEVEL,
      dID: DEFAULT_DID,
      dataSourceName: DEFAULT_SOURCE,
      tokenVersion: 0,
      mustChangePassword: true,
      createdAt: new Date().toISOString(),
    }],
    datasources: [{ id: 1, did: DEFAULT_DID, name: DEFAULT_SOURCE }],
  };
}

async function doLoad() {
  try {
    cache = await readEncrypted();
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

// Безопасное изменение: работаем с копией, кэш заменяем только после записи.
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

function toPublic(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    permissionLevel: u.permissionLevel,
    dID: u.dID,
    dataSourceName: u.dataSourceName,
    mustChangePassword: !!u.mustChangePassword,
    createdAt: u.createdAt,
  };
}

function checkPasswordPolicy(p) {
  if (typeof p !== 'string' || p.length < cfg.MIN_PASSWORD_LEN) {
    throw authError('WEAK_PASSWORD', `Пароль должен быть не короче ${cfg.MIN_PASSWORD_LEN} символов`);
  }
  if (Buffer.byteLength(p, 'utf8') > cfg.MAX_PASSWORD_LEN) {
    throw authError('WEAK_PASSWORD', `Пароль не должен превышать ${cfg.MAX_PASSWORD_LEN} байт`);
  }
}

// ── чтение ──────────────────────────────────────────────────────────────
async function findUser(username) {
  const { users } = await loadUsers();
  const n = norm(username);
  return users.find((u) => norm(u.username) === n) || null;
}

let dummyHash = null;
async function getDummyHash() {
  if (!dummyHash) dummyHash = await bcrypt.hash(crypto.randomBytes(8).toString('hex'), cfg.BCRYPT_ROUNDS);
  return dummyHash;
}

// Возвращает пользователя или null. Время ответа не зависит от существования логина.
async function verifyCredentials(username, password) {
  const user = await findUser(username);
  const ok = await bcrypt.compare(String(password), user ? user.password : await getDummyHash());
  return user && ok ? user : null;
}

// ── запись ──────────────────────────────────────────────────────────────
// Сигнатура сохранена: registerUser(username, password, level, dID, sourceName)
async function registerUser(username, password, level, dID, sourceName) {
  username = String(username || '').trim();
  const lvl = parseInt(level, 10);
  if (!USERNAME_RE.test(username)) throw authError('BAD_USERNAME', 'Имя: 3–32 символа (буквы, цифры, _ . -)');
  checkPasswordPolicy(password);
  if (![1, 2, 3].includes(lvl)) throw authError('BAD_LEVEL', 'Уровень доступа должен быть 1, 2 или 3');
  if (!cfg.isValidDID(dID)) throw authError('BAD_DID', 'Недопустимый dID (латиница, цифры, _ и -)');

  const hash = await bcrypt.hash(password, cfg.BCRYPT_ROUNDS);

  return mutate((data) => {
    if (data.users.some((u) => norm(u.username) === norm(username))) {
      throw authError('USER_EXISTS', 'Пользователь уже существует');
    }
    const user = {
      id: data.users.reduce((m, u) => Math.max(m, u.id || 0), 0) + 1,
      username,
      password: hash,
      email: null,
      permissionLevel: lvl,
      dID,
      dataSourceName: sourceName || dID,
      tokenVersion: 0,
      mustChangePassword: false,
      createdAt: new Date().toISOString(),
    };
    data.users.push(user);
    if (!data.datasources.some((d) => d.did === dID)) {
      data.datasources.push({
        id: data.datasources.reduce((m, d) => Math.max(m, d.id || 0), 0) + 1,
        did: dID,
        name: sourceName || dID,
      });
    }
    return { user: toPublic(user), userCreated: true };
  });
}

// Смена пароля самим пользователем. Возвращает обновлённого пользователя (внутренний объект).
async function changePassword(username, oldPassword, newPassword) {
  const current = await verifyCredentials(username, oldPassword);
  if (!current) throw authError('BAD_PASSWORD', 'Текущий пароль неверен');
  checkPasswordPolicy(newPassword);
  const hash = await bcrypt.hash(newPassword, cfg.BCRYPT_ROUNDS);
  return mutate((data) => {
    const u = data.users.find((x) => x.id === current.id);
    u.password = hash;
    u.tokenVersion = (u.tokenVersion || 0) + 1; // все прежние токены становятся недействительными
    u.mustChangePassword = false;
    return JSON.parse(JSON.stringify(u));
  });
}

// Сброс пароля администратором (используется scripts/authAdmin.js).
async function setPassword(username, newPassword) {
  checkPasswordPolicy(newPassword);
  const hash = await bcrypt.hash(newPassword, cfg.BCRYPT_ROUNDS);
  return mutate((data) => {
    const u = data.users.find((x) => norm(x.username) === norm(username));
    if (!u) throw authError('NO_USER', 'Пользователь не найден');
    u.password = hash;
    u.tokenVersion = (u.tokenVersion || 0) + 1;
    return toPublic(u);
  });
}

// «Выйти на всех устройствах».
async function bumpTokenVersion(username) {
  return mutate((data) => {
    const u = data.users.find((x) => norm(x.username) === norm(username));
    if (!u) throw authError('NO_USER', 'Пользователь не найден');
    u.tokenVersion = (u.tokenVersion || 0) + 1;
    return u.tokenVersion;
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

module.exports = {
  loadUsers,
  findUser,
  verifyCredentials,
  registerUser,
  changePassword,
  setPassword,
  bumpTokenVersion,
  fetchUsers,
  fetchDataSources,
  toPublic,
};
