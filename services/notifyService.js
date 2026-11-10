// services/notifyService.js
// Рассылка оповещений (type: 'message') получателям.
//
// Формат входящего сообщения (NodeRED / HTTP):
//   { type: 'message', request: 'notify', name: <dID>,
//     payload: { level: 1..3, message: '...', title?, severity?, room?, item_name? } }
//
// name — dID группы получателей, payload.level — МИНИМАЛЬНЫЙ уровень получателя (permissionLevel >= level).
// Каналы: WebSocket (VUE-сессии с нужным dID и уровнем) и Telegram (привязанные пользователи).
// Одинаковые сообщения подавляются на NOTIFY_DEDUP_TTL_MS; последние N сообщений хранятся в памяти.
'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');
const logger = require('./logger.js');
logger.initLogging();
const nc = require('./notifyConfig.js');
const { validMessage } = require('./validate.js');

function createNotifyService({
  wsManager,
  auth,
  userStore,
  getTelegram = () => null,
  config = nc,
  now = Date.now,
  uuid = () => crypto.randomUUID(),
}) {
  const recent = new Map();
  const seen = new Map();

  function isDuplicate(msg) {
    const t = now();
    for (const [k, ts] of seen) {
      if (t - ts > config.NOTIFY_DEDUP_TTL_MS) seen.delete(k);
    }
    const p = msg.payload;
    const key = crypto
      .createHash('sha1')
      .update([msg.name, p.level, p.severity, p.title || '', p.message, p.room || '', p.item_name || ''].join('\u0000'))
      .digest('hex');
    if (seen.has(key)) return true;
    seen.set(key, t);
    return false;
  }

  function remember(msg) {
    const list = recent.get(msg.name) || [];
    list.push(msg);
    while (list.length > config.NOTIFY_HISTORY_SIZE) list.shift();
    recent.set(msg.name, list);
  }

  function getRecent(dID, level = 1, limit = config.NOTIFY_HISTORY_SIZE) {
    const list = (recent.get(dID) || []).filter((m) => m.payload.level <= level);
    return list.slice(-limit).map((m) => ({ ...m, payload: { ...m.payload } }));
  }

  function deliverWs(msg) {
    let sent = 0;
    const raw = JSON.stringify(msg);
    for (const { clientId, connection } of wsManager.getUserConnections('VUE_connections', msg.name)) {
      const session = auth.getSession(clientId);
      if (!session || session.dID !== msg.name || session.level < msg.payload.level) continue;
      if (!connection.ws || connection.ws.readyState !== WebSocket.OPEN) continue;
      try {
        connection.ws.send(raw);
        sent++;
      } catch (e) {
        logger.logErrorMessage(`[notifyService] - deliverWs(${clientId}): ${e.message}`);
      }
    }
    return sent;
  }

  async function deliverTelegram(msg) {
    const tg = getTelegram();
    if (!tg) return 0;
    const users = await userStore.findUsersForNotification({ dID: msg.name, minLevel: msg.payload.level });
    const rank = (s) => config.SEVERITY_RANK[s] ?? 0;
    const recipients = users.filter((u) =>
      u.telegram?.chatId &&
      u.notify?.telegram !== false &&
      rank(msg.payload.severity) >= rank(u.notify?.minSeverity || 'info')
    );
    if (recipients.length === 0) return 0;
    return tg.sendToUsers(recipients, msg);
  }

  async function dispatch(raw, { source = 'unknown' } = {}) {
    const checked = validMessage(raw);
    if (checked.error) return { ok: false, error: checked.error.message };

    if (isDuplicate(checked.value)) {
      logger.logDevMessage(`[notifyService] - dispatch: дубликат подавлен (${checked.value.name})`);
      return { ok: true, id: null, deduped: true, recipients: { ws: 0, telegram: 0 } };
    }

    const msg = {
      ...checked.value,
      time: new Date(now()).toISOString(),
      payload: { ...checked.value.payload, id: uuid(), source },
    };
    remember(msg);

    const recipients = { ws: 0, telegram: 0 };
    try {
      recipients.ws = deliverWs(msg);
    } catch (e) {
      logger.logErrorMessage(`[notifyService] - dispatch/ws: ${e.message}`);
    }
    try {
      recipients.telegram = await deliverTelegram(msg);
    } catch (e) {
      logger.logErrorMessage(`[notifyService] - dispatch/telegram: ${e.message}`);
    }

    logger.logInfoMessage(
      `[notifyService] - ${msg.payload.id} ${source} → ${msg.name} (level>=${msg.payload.level}, ` +
      `${msg.payload.severity}): ws=${recipients.ws}, telegram=${recipients.telegram}`
    );
    return { ok: true, id: msg.payload.id, deduped: false, recipients };
  }

  return { dispatch, getRecent };
}

const defaultService = createNotifyService({
  wsManager: require('../classes/wsManager.js'),
  auth: require('./auth.js'),
  userStore: require('./userStore.js'),
  getTelegram: () => require('./telegramService.js').get(),
});

module.exports = {
  createNotifyService,
  dispatch: (...args) => defaultService.dispatch(...args),
  getRecent: (...args) => defaultService.getRecent(...args),
};
