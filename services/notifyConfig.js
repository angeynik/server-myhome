// services/notifyConfig.js
// Настройки подсистемы оповещений (type: 'message') и Telegram.
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
  TELEGRAM_BAD_CODE_LIMIT: int(env.TELEGRAM_BAD_CODE_LIMIT, 5),
  TELEGRAM_BAD_CODE_LOCK_MS: int(env.TELEGRAM_BAD_CODE_LOCK_MS, 15 * 60 * 1000),

  NOTIFY_DEDUP_TTL_MS: int(env.NOTIFY_DEDUP_TTL_MS, 30 * 1000),
  NOTIFY_HISTORY_SIZE: int(env.NOTIFY_HISTORY_SIZE, 50),
};
