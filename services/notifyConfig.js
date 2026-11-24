// services/notifyConfig.js
// Настройки подсистемы оповещений (type: 'message'), уведомлений по условиям (notificationService) и Telegram.
// authConfig подключается первым: он загружает conf.env.
'use strict';

require('./authConfig');

const env = process.env;
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const bool = (v, d) => (v === undefined ? d : String(v).toLowerCase() === 'true');

const SEVERITIES = ['info', 'ok', 'warning', 'alarm'];
const MIN_SEVERITIES = ['info', 'warning', 'alarm'];
const SEVERITY_RANK = { info: 0, ok: 0, warning: 1, alarm: 2 };

const telegramRequested = bool(env.TELEGRAM_ENABLED, false);
const telegramToken = env.TELEGRAM_BOT_TOKEN || '';

module.exports = {
  SEVERITIES,
  MIN_SEVERITIES,
  SEVERITY_RANK,

  TELEGRAM_REQUESTED: telegramRequested,
  TELEGRAM_ENABLED: telegramRequested && Boolean(telegramToken),
  TELEGRAM_BOT_TOKEN: telegramToken,
  TELEGRAM_API_BASE: env.TELEGRAM_API_BASE || 'https://api.telegram.org',
  TELEGRAM_POLL_TIMEOUT_S: int(env.TELEGRAM_POLL_TIMEOUT_S, 25),
  TELEGRAM_LINK_TTL_MS: int(env.TELEGRAM_LINK_TTL_MS, 10 * 60 * 1000),
  TELEGRAM_MAX_INPUT_LEN: int(env.TELEGRAM_MAX_INPUT_LEN, 1000),
  TELEGRAM_RATE_PER_MIN: int(env.TELEGRAM_RATE_PER_MIN, 20),
  // Ошибок регистрации (неверный код, логин/пароль) до блокировки чата; блокировка — на сутки
  TELEGRAM_BAD_CODE_LIMIT: int(env.TELEGRAM_BAD_CODE_LIMIT, 5),
  TELEGRAM_BAD_CODE_LOCK_MS: int(env.TELEGRAM_BAD_CODE_LOCK_MS, 24 * 60 * 60 * 1000),
  // Код регистрации в боте (диалог «код → логин → пароль»). Пусто — регистрация через бота выключена
  TELEGRAM_REGISTRATION_CODE: String(env.TELEGRAM_REGISTRATION_CODE || '').trim(),
  // ВРЕМЕННО: подробный лог подключения к боту (без кода и пароля). По умолчанию включён — отладка регистрации
  TELEGRAM_DEBUG: bool(env.TELEGRAM_DEBUG, true),
  TELEGRAM_DIALOG_TTL_MS: int(env.TELEGRAM_DIALOG_TTL_MS, 10 * 60 * 1000),   // сколько ждать ответа в диалоге
  // Блокировки чатов (переживают перезапуск сервера)
  TELEGRAM_BLOCKS_FILE: env.TELEGRAM_BLOCKS_FILE
    || require('path').join(env.DATA_DIR || '.configData', 'telegram_blocks.json'),
  // Выбранный в чате объект (/object): { chatId: dID }
  TELEGRAM_CHATS_FILE: env.TELEGRAM_CHATS_FILE
    || require('path').join(env.DATA_DIR || '.configData', 'telegram_chats.json'),

  NOTIFY_DEDUP_TTL_MS: int(env.NOTIFY_DEDUP_TTL_MS, 30 * 1000),
  NOTIFY_HISTORY_SIZE: int(env.NOTIFY_HISTORY_SIZE, 50),

  // Уведомления по условиям (docs/notifications.md)
  NOTIFICATION_ENABLED: bool(env.NOTIFICATION_ENABLED, true),
  // Как часто служба проверяет условия, мс (не чаще раза в секунду)
  NOTIFICATION_CHECK_INTERVAL_MS: Math.max(1000, int(env.NOTIFICATION_CHECK_INTERVAL_MS, 10 * 1000)),
  NOTIFICATION_MAX_ITEMS: int(env.NOTIFICATION_MAX_ITEMS, 200),          // уведомлений на один dID
  // Кадры камер активных уведомлений: <каталог>/<dID>/<eventId>_<cameraId>.jpg
  NOTIFICATION_MEDIA_DIR: env.NOTIFICATION_MEDIA_DIR
    || require('path').join(env.DATA_DIR || '.configData', 'notification_media'),
};
