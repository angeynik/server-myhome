// services/notificationStore.js
// Данные уведомлений на диске:
//   <DATA_DIR>/<dID>_notification.json        — условия: { "<id>": item }        (правит пользователь)
//   <DATA_DIR>/<dID>_notification_status.json — статусы: { "<id>": status }      (пишет только notificationService)
//   <NOTIFICATION_MEDIA_DIR>/<dID>/<eventId>_<cameraId>.jpg — кадры активных уведомлений
//
// id уведомления = '<room>:<section>:<item>' — одно уведомление на параметр.
// Формат item и status — docs/notifications.md.
'use strict';

const fs = require('fs').promises;
const path = require('path');
const Joi = require('joi');
const nc = require('./notifyConfig.js');
const { readFileSafely, readFileIfExists, writeFileSafely, resolveConfigPath } = require('./configStore');

const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;              // room, cameraId — как dID
const ITEM_RE = /^[\p{L}\p{N}_-]{1,64}$/u;            // item_name: бывает кириллица (dСurrent)
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;          // HH:MM
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/; // YYYY-MM-DD
const EVENT_RE = /^[A-Za-z0-9-]{1,64}$/;

const SECTIONS = ['sensors', 'system', 'setpoints'];
const CHANNELS = ['web', 'telegram', 'both'];

function storeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const makeId = (room, section, item) => `${room}:${section}:${item}`;

const periodSchema = Joi.alternatives().conditional('.type', {
  switch: [
    {
      is: 'dates',
      then: Joi.object({
        type: Joi.string().valid('dates').required(),
        from: Joi.string().pattern(DATE_RE).required(),
        to: Joi.string().pattern(DATE_RE).required(),
      }),
    },
    {
      is: 'monthDays',
      then: Joi.object({
        type: Joi.string().valid('monthDays').required(),
        days: Joi.array().items(Joi.number().integer().min(1).max(31)).min(1).max(31).unique().required(),
      }),
    },
    {
      is: 'weekDays',
      then: Joi.object({
        type: Joi.string().valid('weekDays').required(),
        days: Joi.array().items(Joi.number().integer().min(1).max(7)).min(1).max(7).unique().required(),
      }),
    },
  ],
  otherwise: Joi.forbidden().messages({ 'any.unknown': 'тип периода: dates | monthDays | weekDays' }),
});

// Что присылает клиент (configData). Лишние поля отбрасываются.
const itemSchema = Joi.object({
  room: Joi.string().pattern(KEY_RE).required(),
  section: Joi.string().valid(...SECTIONS).required(),
  item: Joi.string().pattern(ITEM_RE).required(),
  group: Joi.string().trim().max(100).allow('').default(''),
  roomTitle: Joi.string().trim().max(100).allow('').default(''),
  title: Joi.string().trim().max(100).allow('').default(''),
  unit: Joi.string().trim().max(16).allow('').default(''),
  condition: Joi.object({
    op: Joi.string().valid('gt', 'lt', 'eq', 'gte', 'lte', 'ne').required(),
    value: Joi.alternatives(Joi.number(), Joi.boolean()).required(),
  }).required(),
  intervals: Joi.array().items(Joi.object({
    from: Joi.string().pattern(TIME_RE).required(),
    to: Joi.string().pattern(TIME_RE).required(),
  })).max(10).default([]),
  periods: Joi.array().items(periodSchema).max(10).default([]),
  cameras: Joi.array().items(Joi.string().pattern(KEY_RE)).max(16).unique().default([]),
  channel: Joi.string().valid(...CHANNELS).default('web'),
}).prefs({ stripUnknown: true });

function validateItem(raw) {
  const { error, value } = itemSchema.validate(raw, { abortEarly: true });
  if (error) throw storeError('BAD_NOTIFICATION', `Неверные данные уведомления: ${error.message}`);
  const bad = value.periods.find((p) => p.type === 'dates' && p.from > p.to);
  if (bad) throw storeError('BAD_NOTIFICATION', `Период ${bad.from} — ${bad.to}: дата начала позже окончания`);
  return value;
}

function createNotificationStore({ config = nc, now = Date.now } = {}) {
  // Конфигурация уведомлений dID: null — файла нет (не создано ни одного уведомления)
  async function list(dID) {
    const file = await readFileIfExists(dID, 'notification');
    return file ? file.data : null;
  }

  // create / edit: запись по id параметра (повторный create того же параметра — правка)
  async function save(dID, rawItem, actor) {
    const item = validateItem(rawItem);
    const id = makeId(item.room, item.section, item.item);
    const { data, filePath } = await readFileSafely(dID, 'notification');
    const prev = data[id];
    if (!prev && Object.keys(data).length >= config.NOTIFICATION_MAX_ITEMS) {
      throw storeError('LIMIT', `Не больше ${config.NOTIFICATION_MAX_ITEMS} уведомлений`);
    }
    const stamp = new Date(now()).toISOString();
    const items = {
      ...data,
      [id]: {
        id,
        ...item,
        createdAt: prev?.createdAt || stamp,
        updatedAt: stamp,
        updatedBy: actor?.username || null,
      },
    };
    await writeFileSafely(filePath, JSON.stringify(items, null, 2));
    return { items, id, created: !prev };
  }

  // delete: по id или по { room, section, item }
  async function remove(dID, { id, room, section, item } = {}) {
    const key = id || (room && section && item ? makeId(room, section, item) : null);
    if (!key) throw storeError('BAD_NOTIFICATION', 'Не указано, какое уведомление удалить');
    const file = await readFileIfExists(dID, 'notification');
    if (!file || !file.data[key]) throw storeError('NOT_FOUND', 'Уведомление не найдено');
    const items = { ...file.data };
    delete items[key];
    await writeFileSafely(file.filePath, JSON.stringify(items, null, 2));
    return { items, id: key };
  }

  async function readStatus(dID) {
    const file = await readFileIfExists(dID, 'notification_status');
    return file ? file.data : null;
  }

  async function writeStatus(dID, status) {
    await writeFileSafely(resolveConfigPath(dID, 'notification_status'), JSON.stringify(status, null, 2));
  }

  // ── Кадры камер ───────────────────────────────────────────────────
  function mediaPath(dID, eventId, cameraId) {
    if (!KEY_RE.test(dID) || !EVENT_RE.test(eventId) || !KEY_RE.test(cameraId)) {
      throw storeError('BAD_MEDIA', 'Недопустимое имя кадра');
    }
    return path.join(config.NOTIFICATION_MEDIA_DIR, dID, `${eventId}_${cameraId}.jpg`);
  }

  async function saveMedia(dID, eventId, cameraId, jpeg) {
    const file = mediaPath(dID, eventId, cameraId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, jpeg);
  }

  async function readMedia(dID, eventId, cameraId) {
    try {
      return await fs.readFile(mediaPath(dID, eventId, cameraId));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async function removeMedia(dID, eventId, cameraIds = []) {
    await Promise.all(cameraIds.map((cam) => fs.rm(mediaPath(dID, eventId, cam), { force: true })));
  }

  // dID, у которых есть файл уведомлений или статусов (обход службы)
  async function listDIDs() {
    const dir = path.dirname(resolveConfigPath('x', 'notification'));
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const ids = new Set();
    for (const n of names) {
      const m = /^([A-Za-z0-9_-]{1,64})_notification(?:_status)?\.json$/.exec(n);
      if (m) ids.add(m[1]);
    }
    return [...ids];
  }

  return { list, save, remove, readStatus, writeStatus, saveMedia, readMedia, removeMedia, listDIDs };
}

module.exports = { createNotificationStore, validateItem, makeId, SECTIONS, CHANNELS };
