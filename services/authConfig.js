// services/authConfig.js
// Единая точка: загрузка conf.env, константы авторизации, таблица прав, проверка dID.
// ВАЖНО: этот модуль первым вызывает dotenv.config(), поэтому любой модуль,
// который делает require('./authConfig') до чтения process.env, получает уже
// загруженные переменные (раньше userStore читал env ДО dotenv.config()).
'use strict';

require('dotenv').config({ path: './conf.env' });
const crypto = require('crypto');

const env = process.env;
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v === undefined ? d : String(v).toLowerCase() === 'true');

const isProd = env.LOG_LEVEL === 'production';
const OLD_DEFAULT_SECRET = 'default-poDDysecret-key';

// ── JWT-секрет: в production без нормального секрета сервер не стартует ──
function resolveJwtSecret() {
  const s = env.JWT_SECRET;
  if (s && s !== OLD_DEFAULT_SECRET) {
    if (s.length < 32) {
      if (isProd) throw new Error('[authConfig] JWT_SECRET должен быть не короче 32 символов');
      console.warn('[authConfig] ⚠️ JWT_SECRET короче 32 символов. Сгенерируйте: openssl rand -hex 32');
    }
    return s;
  }
  if (isProd) throw new Error('[authConfig] JWT_SECRET не задан (или равен старому значению по умолчанию)');
  console.warn('[authConfig] ⚠️ JWT_SECRET не задан — создан временный. Токены перестанут действовать после перезапуска.');
  return crypto.randomBytes(48).toString('hex');
}

// ── dID: используется в именах файлов, поэтому строго ограничиваем алфавит ──
const DID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isValidDID = (v) => typeof v === 'string' && DID_RE.test(v);
function assertDID(v) {
  if (!isValidDID(v)) throw new Error('Недопустимый dID');
  return v;
}

// ── Таблица прав ────────────────────────────────────────────────────────
// Минимальный permissionLevel для каждого type → request.
// Уровни: 1 — просмотр/управление, 2 — настройки (расписания, уведомления),
//         3 — администратор (пользователи).
// Стартовые значения взяты из meta.requiredLevel в router/routes.js.
// Неизвестный request получает _default.
const REQUIRED_LEVEL = {
  get: {
    _default: 1,
    config: 1,
    statistics: 1,
    schedules: 2,
    notifications: 2,
  },
  post: {
    _default: 1,
    setpoints: 1,
    system: 1,
    sensors: 1,
    wsConnect: 1,
    addschedules: 2,
    delschedules: 2,
    updateschedules: 2,
    addnotifications: 2,
    delnotifications: 2,
    updatenotifications: 2,
    addstatistics: 2,
    delstatistics: 2,
    updatestatistics: 2,
    createUser: 3,
    linkUserToDataSource: 3,
    userConfigRequest: 3,
    userConfigEdit: 3,
  },
};

module.exports = {
  isProd,
  JWT_SECRET: resolveJwtSecret(),
  JWT_EXPIRES: env.JWT_EXPIRES || '7d',          // срок жизни токена
  JWT_ISSUER: env.JWT_ISSUER || 'myhome',

  BCRYPT_ROUNDS: int(env.AUTH_BCRYPT_ROUNDS, 10), // bcryptjs на Raspberry Pi: 10 — разумный максимум
  MIN_PASSWORD_LEN: int(env.AUTH_MIN_PASSWORD_LEN, 8),
  MAX_PASSWORD_LEN: 72,                           // лимит bcrypt

  LOGIN_MAX_ATTEMPTS: int(env.AUTH_LOGIN_MAX_ATTEMPTS, 5),
  LOGIN_IP_MAX_ATTEMPTS: int(env.AUTH_LOGIN_IP_MAX_ATTEMPTS, 20),
  LOGIN_WINDOW_MS: int(env.AUTH_LOGIN_WINDOW_MS, 15 * 60 * 1000),
  LOGIN_LOCK_MS: int(env.AUTH_LOGIN_LOCK_MS, 15 * 60 * 1000),

  AUTH_TIMEOUT_MS: int(env.AUTH_TIMEOUT_MS, 60 * 1000), // сколько можно висеть без логина (0 — выключено)

  // true → без настроенных токенов NodeRED подключиться не сможет
  STRICT: bool(env.AUTH_STRICT, isProd),
  TRUST_PROXY: bool(env.TRUST_PROXY, false),

  DID_RE,
  isValidDID,
  assertDID,

  REQUIRED_LEVEL,
  DASH_ALLOWED_TYPES: ['auth', 'get', 'post'],        // что вообще принимаем от Vue
  PUBLIC_AUTH_REQUESTS: new Set(['login', 'resume']), // доступны без сессии
  SESSION_AUTH_REQUESTS: new Set(['logout', 'refresh', 'changePassword']),
};
