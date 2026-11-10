const dotenv = require('dotenv'); // Подключаем .ENV файл с переменными окружения
dotenv.config({ path: './conf.env', override: true }); 

const logLevel = process.env.LOG_LEVEL || 'info';

let logInfo = false;
let logDev = false;
let logError = false;

// Инициализация уровней логирования
function initLogging() {
  if (logLevel === 'dev') {
    logDev = true;
    logInfo = true;
    logError = true;
  } else if (logLevel === 'error') {
    logInfo = true;
    logError = true;
  } else if (logLevel === 'info') {
    logInfo = true;
  }
}

// Функции для безопасного логирования
function logInfoMessage(message) {
  if (logInfo) console.log(`${message}`);
}

function logDevMessage(message) {
  if (logDev) console.log(`[DEV] ${message}`);
}

function logErrorMessage(message) {
  if (logError) console.error(`[ERROR] ${message}`);
}

const SECRET_RE = /("(?:password|oldPassword|newPassword|token)"\s*:\s*")(?:[^"\\]|\\.)*(")/g;

function redactSecrets(text) {
  return String(text).replace(SECRET_RE, '$1***$2');
}

module.exports = {
  redactSecrets,
  logInfo: () => logInfo,
  logDev: () => logDev,
  logError: () => logError,
  logInfoMessage,
  logDevMessage,
  logErrorMessage,
  initLogging
};