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

/**
 * Из username делает валидный dID.
 *   angey_bmax  → angey_bmax_base
 *   john.doe    → john_doe_base
 *   Ivan-2024   → ivan-2024_base
 * Точки и любые недопустимые символы заменяются на `_`, регистр — в нижний,
 * в конце добавляется суффикс `_base`. Результат гарантированно проходит DID_RE.
 */
function deriveDID(username) {
  const base = String(username || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_'); // всё, что не буква/цифра/_/- → '_'
  return `${base}_base`;
}

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
// Сигнатура: registerUser(username, password, level, dID?, sourceName?)
// Если dID не передан — выводится из username как "<username>_base".
async function registerUser(username, password, level, dID, sourceName) {
  username = String(username || '').trim();
  const lvl = parseInt(level, 10);

  if (!USERNAME_RE.test(username)) throw authError('BAD_USERNAME', 'Имя: 3–32 символа (буквы, цифры, _ . -)');
  checkPasswordPolicy(password);
  if (![1, 2, 3].includes(lvl)) throw authError('BAD_LEVEL', 'Уровень доступа должен быть 1, 2 или 3');

  // Если dID не передан явно — выводим из username
  const finalDID = dID ? String(dID).trim() : deriveDID(username);
  if (!cfg.isValidDID(finalDID)) {
    throw authError('BAD_DID', 'Недопустимый dID (латиница, цифры, _ и -)');
  }
  const finalSource = sourceName || finalDID;

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
      dID: finalDID,
      dataSourceName: finalSource,
      tokenVersion: 0,
      mustChangePassword: false,
      createdAt: new Date().toISOString(),
    };
    data.users.push(user);
    if (!data.datasources.some((d) => d.did === finalDID)) {
      data.datasources.push({
        id: data.datasources.reduce((m, d) => Math.max(m, d.id || 0), 0) + 1,
        did: finalDID,
        name: finalSource,
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

// Смена источника данных (dID) существующего пользователя.
// Используется, например, чтобы отвязать пользователя от чужого dID.
// Возвращает публичный объект пользователя.
async function changeUserDID(username, newDID, sourceName) {
  const did = String(newDID || '').trim();
  if (!cfg.isValidDID(did)) throw authError('BAD_DID', 'Недопустимый dID (латиница, цифры, _ и -)');
  const src = sourceName || did;

  return mutate((data) => {
    const u = data.users.find((x) => norm(x.username) === norm(username));
    if (!u) throw authError('NO_USER', 'Пользователь не найден');

    // Если пользователь уже был привязан к этому dID — просто обновим имя источника
    u.dID = did;
    u.dataSourceName = src;
    // Отзываем все прежние JWT: у пользователя меняется контекст доступа
    u.tokenVersion = (u.tokenVersion || 0) + 1;

    if (!data.datasources.some((d) => d.did === did)) {
      data.datasources.push({
        id: data.datasources.reduce((m, d) => Math.max(m, d.id || 0), 0) + 1,
        did,
        name: src,
      });
    }
    return toPublic(u);
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
async function deleteUser(username) {
  const uname = String(username || '').trim();
  if (!uname) {
    const e = new Error('Имя не указано');
    e.code = 'BAD_USERNAME';
    throw e;
  }

  return mutate((state) => {
    const idx = state.users.findIndex(
      (u) => u.username.toLowerCase() === uname.toLowerCase()
    );
    if (idx === -1) {
      const e = new Error('Пользователь не найден');
      e.code = 'NO_USER';
      throw e;
    }

    const [removed] = state.users.splice(idx, 1);

    // Сколько пользователей (если есть) осталось на том же dID
    const otherUsersOnSameDID = state.users.filter(
      (u) => u.dID === removed.dID
    ).length;

    // Запись в datasources НЕ трогаем — даже если это последний пользователь.
    // Причины: (1) файл configData/<dID>.json остаётся и может быть нужен;
    // (2) возможен внешний потребитель (NodeRED и т.п.), знающий этот dID;
    // (3) удаление легко сделать отдельной командой, а откатить — нет.

    return {
      username: removed.username,
      dID: removed.dID,
      otherUsersOnSameDID,
    };
  });
}

// Удаление одного источника данных. Отказывается, если на нём ещё есть пользователи.
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

// Массовая чистка: удаляем все datasources, на которые не ссылается ни один пользователь.
// Ничего не делает с файлами configData/*.json — их судьба на усмотрение админа.
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

    return {
      removed,
      removedCount: removed.length,
      keptCount: state.datasources.length,
      before,
    };
  });
}

module.exports = {
  loadUsers,
  findUser,
  verifyCredentials,
  registerUser,
  changePassword,
  setPassword,
  bumpTokenVersion,
  changeUserDID,
  fetchUsers,
  fetchDataSources,
  toPublic,
  deleteUser,
  deleteDataSource,
  cleanDataSources,
};
