// services/logger.js
// Единый логгер сервера. Уровень задаётся LOG_LEVEL в conf.env:
//   error              — только ошибки;
//   info, production   — ошибки и информационные сообщения (по умолчанию);
//   dev                — всё, включая отладочные сообщения;
//   none               — ничего (для тестов, задаётся в tests/setup.js).
// Каждый уровень включает все более важные, поэтому вне тестов ошибки пишутся всегда.
// Функции принимают несколько аргументов: строки выводятся как есть,
// Error — своим message, остальные значения — через util.inspect в одну строку.
'use strict';

const util = require('util');
// Без override: переменные, заданные снаружи (systemd, docker), важнее conf.env
require('dotenv').config({ path: './conf.env' });

const LEVELS = {
  none: { error: false, info: false, dev: false },
  error: { error: true, info: false, dev: false },
  info: { error: true, info: true, dev: false },
  production: { error: true, info: true, dev: false },
  dev: { error: true, info: true, dev: true },
};

let logInfo = true;
let logDev = false;
let logError = true;

// Читает LOG_LEVEL в момент вызова; неизвестное значение работает как 'info'
function initLogging() {
  const level = String(process.env.LOG_LEVEL || 'info').trim().toLowerCase();
  const flags = LEVELS[level] || LEVELS.info;
  logError = flags.error;
  logInfo = flags.info;
  logDev = flags.dev;
}

function format(args) {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.message;
      return util.inspect(a, { depth: 4, breakLength: Infinity });
    })
    .join(' ');
}

function logInfoMessage(...args) {
  if (logInfo) console.log(format(args));
}

function logDevMessage(...args) {
  if (logDev) console.log(`[DEV] ${format(args)}`);
}

function logErrorMessage(...args) {
  if (logError) console.error(`[ERROR] ${format(args)}`);
}

const SECRET_RE = /("(?:password|oldPassword|newPassword|token)"\s*:\s*")(?:[^"\\]|\\.)*(")/g;

function redactSecrets(text) {
  return String(text).replace(SECRET_RE, '$1***$2');
}

initLogging();

module.exports = {
  redactSecrets,
  logInfo: () => logInfo,
  logDev: () => logDev,
  logError: () => logError,
  logInfoMessage,
  logDevMessage,
  logErrorMessage,
  initLogging,
};
