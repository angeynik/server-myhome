// services/notificationService.js
// Служба уведомлений: с интервалом NOTIFICATION_CHECK_INTERVAL_MS проверяет условия уведомлений
// каждого dID и при изменении состояния создаёт событие (ON) или сброс (OFF).
//
//   <dID>_notification.json ──┐
//   <dID>.json (значения)  ───┼─▶ checkDID ─▶ activate / reset ─▶ <dID>_notification_status.json
//   videoHub (кадры камер) ───┘                 │                 └▶ кадры: NOTIFICATION_MEDIA_DIR
//                                               ├─▶ веб: post/notificationEvent всем Vue этого dID
//                                               └─▶ Telegram (channel telegram|both): текст + кадры
//
// Уведомление ON, если параметр под контролем (интервал суток И период календаря) и условие
// выполняется. Иначе — OFF: вне окна контроля активное уведомление тоже сбрасывается.
// Статус ON держится до сброса: повторного события, пока условие выполняется, нет.
// Статус в вебе приходит всегда (обводка плашки), окно уведомления — если канал web|both.
// Подробно — docs/notifications.md.
'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');
const logger = require('./logger.js');
const nc = require('./notifyConfig.js');
const rules = require('./notificationRules.js');

const withWeb = (channel) => channel === 'web' || channel === 'both';
const withTelegram = (channel) => channel === 'telegram' || channel === 'both';

function createNotificationService({
  store,
  readConfig,                 // async (dID) => объект <dID>.json
  wsManager,
  auth,
  userStore,
  getTelegram = () => null,
  getFrame = () => null,      // (dID, cameraId) => { jpeg, timestamp, cameraId, title } | null
  config = nc,
  now = Date.now,
  uuid = () => crypto.randomUUID(),
}) {
  let timer = null;
  let running = false;
  const chains = new Map(); // dID -> Promise: проверки и правки одного dID по очереди

  // ── Веб: всем открытым соединениям Vue пользователей этого dID ──────
  function sendToDID(dID, type, request, payload) {
    const raw = JSON.stringify({ type, request, name: dID, payload });
    let sent = 0;
    for (const { clientId, connection } of wsManager.getUserConnections('VUE_connections', dID)) {
      const session = auth.getSession(clientId);
      if (!session || session.dID !== dID) continue;
      if (!connection.ws || connection.ws.readyState !== WebSocket.OPEN) continue;
      try {
        connection.ws.send(raw);
        sent++;
      } catch (e) {
        logger.logErrorMessage(`[notificationService] - send ${request} → ${clientId}: ${e.message}`);
      }
    }
    return sent;
  }

  // Конфигурация уведомлений изменилась — всем клиентам dID, в том числе автору правки
  function broadcastConfig(dID, items) {
    return sendToDID(dID, 'response', 'notification', items);
  }

  // ── Telegram ────────────────────────────────────────────────────────
  async function sendTelegram(dID, item, event, photos) {
    const tg = getTelegram();
    if (!tg) return 0;
    const users = await userStore.findUsersForNotification({ dID, minLevel: 1 });
    const recipients = users.filter((u) => u.telegram?.chatId && u.notify?.telegram !== false);
    if (recipients.length === 0) return 0;
    // Формат для Telegram: место, что произошло, время и dID (чат может получать несколько dID)
    const { place, detail } = rules.describeParts(item, { status: event.status, value: event.value, reason: event.reason });
    return tg.sendNotificationEvent(recipients, { dID, status: event.status, place, detail, time: event.time }, photos);
  }

  function eventPayload(item, entry, extra = {}) {
    return {
      id: item.id,
      eventId: entry.eventId || null,
      status: entry.status,
      time: entry.since,
      channel: item.channel,
      group: item.group,
      room: item.room,
      roomTitle: item.roomTitle,
      section: item.section,
      item: item.item,
      title: item.title,
      unit: item.unit,
      condition: item.condition,
      value: entry.value ?? null,
      attachments: entry.attachments || [],
      ...extra,
    };
  }

  // ── Событие ON ──────────────────────────────────────────────────────
  async function activate(dID, item, value, outbox) {
    const eventId = uuid();
    const since = new Date(now()).toISOString();
    const attachments = [];
    const photos = [];
    for (const cameraId of item.cameras || []) {
      const frame = getFrame(dID, cameraId);
      if (!frame) {
        logger.logDevMessage(`[notificationService] - ${dID}/${item.id}: нет кадра камеры ${cameraId}`);
        continue;
      }
      try {
        await store.saveMedia(dID, eventId, cameraId, frame.jpeg);
        attachments.push({ cameraId, title: frame.title, timestamp: frame.timestamp });
        photos.push({ jpeg: frame.jpeg, caption: `${frame.title} · ${item.roomTitle || item.room} · ${dID}` });
      } catch (e) {
        logger.logErrorMessage(`[notificationService] - кадр ${cameraId}: ${e.message}`);
      }
    }
    const text = rules.describe(item, { status: 'ON', value });
    // text и channel — чтобы клиент, открытый позже, показал непрочитанное без конфигурации
    const entry = { status: 'ON', read: 'OFF', eventId, since, value, text, channel: item.channel, attachments };
    outbox.push(() => deliver(dID, item, entry, text, photos));
    return entry;
  }

  // ── Сброс (OFF) ─────────────────────────────────────────────────────
  async function reset(dID, item, prev, { value, reason }, outbox) {
    await store.removeMedia(dID, prev.eventId, (prev.attachments || []).map((a) => a.cameraId))
      .catch((e) => logger.logErrorMessage(`[notificationService] - удаление кадров ${item.id}: ${e.message}`));
    const text = rules.describe(item, { status: 'OFF', value, reason });
    const entry = {
      status: 'OFF', read: 'OFF', eventId: prev.eventId || null, since: new Date(now()).toISOString(),
      text, channel: item.channel, attachments: [],
    };
    outbox.push(() => deliver(dID, item, { ...entry, value }, text, [], { reason }));
    return entry;
  }

  // Доставка не задерживает проверку: Telegram может отвечать секундами
  function deliver(dID, item, entry, text, photos, extra = {}) {
    const payload = eventPayload(item, entry, { text, ...extra });
    const ws = sendToDID(dID, 'post', 'notificationEvent', payload);
    logger.logInfoMessage(
      `[notificationService] - ${dID}/${item.id} ${entry.status}${extra.reason ? ` (${extra.reason})` : ''}: ` +
      `веб ${ws}, канал ${item.channel}`
    );
    if (withTelegram(item.channel)) {
      sendTelegram(dID, item, { ...payload }, photos)
        .then((n) => logger.logDevMessage(`[notificationService] - ${dID}/${item.id}: Telegram ${n}`))
        .catch((e) => logger.logErrorMessage(`[notificationService] - Telegram ${dID}/${item.id}: ${e.message}`));
    }
  }

  // ── Проверка одного dID ─────────────────────────────────────────────
  async function evaluate(dID) {
    const items = (await store.list(dID)) || {};
    const status = (await store.readStatus(dID)) || {};
    if (Object.keys(items).length === 0 && Object.keys(status).length === 0) return { changed: 0 };

    let values = {};
    try {
      values = (await readConfig(dID)) || {};
    } catch (e) {
      logger.logErrorMessage(`[notificationService] - значения ${dID}: ${e.message}`);
    }

    const t = now();
    const next = { ...status };
    const outbox = []; // события рассылаются после записи статуса
    let changed = 0;

    for (const item of Object.values(items)) {
      const raw = values[item.room]?.[item.section]?.[item.item]?.value;
      const monitored = rules.isMonitored(item, t);
      const met = monitored && rules.checkCondition(item.condition, raw);
      const active = status[item.id]?.status === 'ON';
      const value = rules.normalizeValue(raw);

      if (met && !active) {
        next[item.id] = await activate(dID, item, value, outbox);
        changed++;
      } else if (!met && active) {
        next[item.id] = await reset(dID, item, status[item.id], { value, reason: monitored ? 'condition' : 'window' }, outbox);
        changed++;
      }
    }

    // Уведомление удалено из конфигурации: активное — сбросить, запись статуса убрать
    for (const [id, entry] of Object.entries(status)) {
      if (items[id]) continue;
      if (entry.status === 'ON') {
        const [room, section, item] = id.split(':');
        await reset(dID, { id, room, section, item, channel: 'web', condition: null }, entry, { reason: 'removed' }, outbox);
      }
      delete next[id];
      changed++;
    }

    if (changed) await store.writeStatus(dID, next);
    // Рассылка — после записи статуса: клиент сразу по событию запрашивает кадры
    // (get/notificationSnapshot), а сервер ищет их в файле статусов
    outbox.forEach((send) => send());
    return { changed };
  }

  // Проверки одного dID не пересекаются (таймер + правка пользователя)
  function checkDID(dID) {
    const prev = chains.get(dID) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => evaluate(dID));
    chains.set(dID, run);
    run.finally(() => { if (chains.get(dID) === run) chains.delete(dID); }).catch(() => {});
    return run;
  }

  async function checkAll() {
    if (running) return; // предыдущий обход ещё идёт
    running = true;
    try {
      const dIDs = await store.listDIDs();
      for (const dID of dIDs) {
        try {
          await checkDID(dID);
        } catch (e) {
          logger.logErrorMessage(`[notificationService] - проверка ${dID}: ${e.message}`);
        }
      }
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { checkAll(); }, config.NOTIFICATION_CHECK_INTERVAL_MS);
    timer.unref?.();
    checkAll();
    logger.logInfoMessage(`[notificationService] - запущена, проверка раз в ${config.NOTIFICATION_CHECK_INTERVAL_MS} мс`);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  // Правка из клиента: create / edit / delete → запись, рассылка конфигурации, немедленная проверка
  async function applyChange(dID, action, configData, actor) {
    let result;
    if (action === 'create' || action === 'edit') {
      result = await store.save(dID, configData, actor);
    } else if (action === 'delete') {
      result = await store.remove(dID, configData);
    } else {
      const e = new Error(`Неизвестное действие: ${action} (create | edit | delete)`);
      e.code = 'BAD_ACTION';
      throw e;
    }
    broadcastConfig(dID, result.items);
    checkDID(dID).catch((e) => logger.logErrorMessage(`[notificationService] - проверка после правки ${dID}: ${e.message}`));
    logger.logInfoMessage(`[notificationService] - ${dID}: ${action} ${result.id} (${actor?.username || '—'})`);
    return result;
  }

  // Кадр активного уведомления: { id, cameraId, image (base64), mimeType, timestamp } | null
  async function getSnapshot(dID, id, cameraId) {
    const entry = ((await store.readStatus(dID)) || {})[id];
    const att = entry?.status === 'ON' ? (entry.attachments || []).find((a) => a.cameraId === cameraId) : null;
    if (!att) return null;
    const jpeg = await store.readMedia(dID, entry.eventId, cameraId);
    if (!jpeg) return null;
    return { id, cameraId, title: att.title, image: jpeg.toString('base64'), mimeType: 'image/jpeg', timestamp: att.timestamp };
  }

  return { start, stop, checkAll, checkDID, applyChange, broadcastConfig, getSnapshot, sendToDID };
}

let instance = null;

// Служба по умолчанию: настоящие зависимости сервера (создаётся при первом обращении)
function get() {
  if (!instance) {
    const { readFileIfExists } = require('./configStore');
    const videoHub = require('./videoHub.js');
    instance = createNotificationService({
      store: require('./notificationStore.js').createNotificationStore(),
      readConfig: async (dID) => (await readFileIfExists(dID, 'config'))?.data || {},
      wsManager: require('../classes/wsManager.js'),
      auth: require('./auth.js'),
      userStore: require('./userStore.js'),
      getTelegram: () => require('./telegramService.js').get(),
      getFrame: (dID, cameraId) => videoHub.getFrameFor(dID, cameraId),
    });
  }
  return instance;
}

module.exports = { createNotificationService, get };
