// services/userStore.js
'use strict';

const fs   = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const logger = require('./logger.js');
logger.initLogging();

const USERS_FILE = process.env.USERS_FILE || './data/users.enc';
const KEY_FILE   = process.env.AUTH_KEY_FILE || './data/auth.key';
const DEFAULT_DID    = process.env.DEFAULT_USER_DID || 'poddy_base';
const DEFAULT_NAME   = process.env.DEFAULT_USER_NAME || 'poddy';
const DEFAULT_PASS   = process.env.DEFAULT_USER_PASSWORD || 'poddyPASS';
const DEFAULT_LEVEL  = parseInt(process.env.DEFAULT_USER_LEVEL, 10) || 3;
const DEFAULT_SOURCE = process.env.DEFAULT_USER_SOURCE || 'PoddyBase';

let cache = null;      // расшифрованный объект в памяти
let masterKey = null;  // Buffer(32)

// ── ключ ───────────────────────────────────────────────────────────────
async function loadOrCreateKey() {
  if (masterKey) return masterKey;

  // 1) если задан в env — используем его (hex, 64 символа)
  if (process.env.AUTH_MASTER_KEY) {
    masterKey = Buffer.from(process.env.AUTH_MASTER_KEY, 'hex');
    if (masterKey.length !== 32) throw new Error('AUTH_MASTER_KEY must be 32 bytes hex');
    return masterKey;
  }

  // 2) иначе файл рядом с users.enc, права 0600
  await fs.mkdir(path.dirname(KEY_FILE), { recursive: true });
  try {
    const hex = (await fs.readFile(KEY_FILE, 'utf8')).trim();
    masterKey = Buffer.from(hex, 'hex');
    if (masterKey.length !== 32) throw new Error('key file corrupt');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    masterKey = crypto.randomBytes(32);
    await fs.writeFile(KEY_FILE, masterKey.toString('hex'), { mode: 0o600 });
    logger.logInfoMessage(`[userStore] - сгенерирован новый ключ ${KEY_FILE}`);
  }
  return masterKey;
}

// ── шифрование файла ───────────────────────────────────────────────────
async function saveUsers(data) {
  const key = await loadOrCreateKey();
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain  = Buffer.from(JSON.stringify(data), 'utf8');
  const enc    = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag    = cipher.getAuthTag();

  // формат: [iv(12)] [tag(16)] [ciphertext]
  const out = Buffer.concat([iv, tag, enc]);

  await fs.mkdir(path.dirname(USERS_FILE), { recursive: true });
  const tmp = `${USERS_FILE}.tmp`;
  await fs.writeFile(tmp, out, { mode: 0o600 });
  await fs.rename(tmp, USERS_FILE);

  cache = data;
}

async function loadUsers() {
  if (cache) return cache;
  const key = await loadOrCreateKey();
  try {
    const raw = await fs.readFile(USERS_FILE);
    const iv  = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
    cache = JSON.parse(plain.toString('utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    cache = await bootstrap();
    await saveUsers(cache);
  }
  return cache;
}

// ── начальное наполнение ───────────────────────────────────────────────
async function bootstrap() {
  const hash = await bcrypt.hash(DEFAULT_PASS, 10);
  return {
    users: [{
      id: 1,
      username: DEFAULT_NAME,
      password: hash,
      email: null,
      permissionLevel: DEFAULT_LEVEL,
      dID: DEFAULT_DID,
      dataSourceName: DEFAULT_SOURCE,
      createdAt: new Date().toISOString(),
    }],
    datasources: [{ id: 1, did: DEFAULT_DID, name: DEFAULT_SOURCE }],
  };
}

// ── публичный API (тот же, что раньше давал DBManager/tableDB) ─────────
async function findUser(username) {
  const { users } = await loadUsers();
  return users.find(u => u.username === username) || null;
}

async function loginUser(username, password) {
  const user = await findUser(username);
  if (!user) return { error: 'Пользователь не найден', code: 'NO_USER' };
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return { error: 'Неверный пароль', code: 'BAD_PASSWORD' };
  return {
    username: user.username,
    dID: user.dID,
    userlevel: user.permissionLevel,
    token: null, // JWT не нужен, если WS-сессия уже привязана к clientId
  };
}

async function registerUser(username, password, level, dID, sourceName) {
  if (!username || !password || !level || !dID) throw new Error('missing fields');
  const data = await loadUsers();
  if (data.users.some(u => u.username === username)) {
    return { user: data.users.find(u => u.username === username), userCreated: false };
  }
  const user = {
    id: data.users.length + 1,
    username,
    password: await bcrypt.hash(password, 10),
    email: null,
    permissionLevel: level,
    dID,
    dataSourceName: sourceName || dID,
    createdAt: new Date().toISOString(),
  };
  data.users.push(user);
  if (!data.datasources.some(d => d.did === dID)) {
    data.datasources.push({ id: data.datasources.length + 1, did: dID, name: sourceName || dID });
  }
  await saveUsers(data);
  return { user, userCreated: true };
}

async function fetchUsers() {
  const { users } = await loadUsers();
  return users.map(u => ({ id: u.id, username: u.username }));
}

async function fetchDataSources() {
  const { datasources } = await loadUsers();
  return datasources.map(d => ({ id: d.id, did: d.did }));
}

module.exports = { findUser, loginUser, registerUser, fetchUsers, fetchDataSources, loadUsers };