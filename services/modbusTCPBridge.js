// services/modbusBridge.js
// Мост между ModBusTCPManager и существующим потоком сообщений сервера.
//
//  Modbus slave --poll--> decode --> {type:'post', ...} --> addMessageToQueue (запись в config-файл)
//                                                       \-> broadcast (VUE / NodeRED)
//  VUE 'post' --> handleCommand --> encode --> Modbus write --> publish (подтверждение всем VUE)
//
// Формат сообщений полностью совпадает с тем, что присылает NodeRED,
// поэтому VUE и handlePostNodeRED ничего не знают про Modbus.

'use strict';

const fs = require('fs');
const path = require('path');
const modbusManager = require('../classes/modBusTCPManager');
const wsManager = require('../classes/wsManager');
const { addMessageToQueue } = require('./messageStore.js');
const logger = require('./logger.js');

const BRIDGE_ID = 'modbus-bridge'; // исключается из рассылки как "отправитель"

const TABLES = {
  coil:     { read: 'readCoils',            bits: true,  maxSpan: 1000, writable: true  },
  discrete: { read: 'readDiscreteInputs',   bits: true,  maxSpan: 1000, writable: false },
  holding:  { read: 'readHoldingRegisters', bits: false, maxSpan: 100,  writable: true  },
  input:    { read: 'readInputRegisters',   bits: false, maxSpan: 100,  writable: false }
};
const WIDTH = { bool: 1, uint16: 1, int16: 1, uint32: 2, int32: 2, float32: 2 };

let cfg = { pollInterval: 1000, republishMs: 60000 };
let broadcastFn = null;
let broadcastTargets;             // undefined -> значение по умолчанию функции broadcast
const tagIndex = new Map();       // "dID|request|room|item_name" -> tag
const blocks = new Map();         // "deviceId:blockName" -> { start, end, table, tags }
const pollErrors = new Map();     // чтобы не спамить лог одинаковыми ошибками

// ---------------------------------------------------------------------------
// Теги
// ---------------------------------------------------------------------------
const tagKey = (dID, request, room, item) => `${dID}|${request}|${room}|${item}`;

function normalizeTag(raw, i) {
  const t = {
    request: 'sensors', dataType: null, scale: 1, offset: 0, decimals: 3,
    deadband: 0, writable: false, wordOrder: 'BE', item_type: '', title: '', group: '',
    ...raw
  };
  const fail = (msg) => {
    logger.logErrorMessage(`[modbusBridge] - тег #${i} (${raw?.item_name}): ${msg}`);
    return null;
  };

  for (const f of ['deviceId', 'dID', 'room', 'item_name', 'table']) {
    if (!t[f]) return fail(`не задано поле "${f}"`);
  }
  const tbl = TABLES[t.table];
  if (!tbl) return fail(`неизвестная table "${t.table}" (coil|discrete|holding|input)`);
  if (!Number.isInteger(t.address) || t.address < 0 || t.address > 0xffff) return fail('некорректный address');

  if (!t.dataType) t.dataType = tbl.bits ? 'bool' : 'uint16';
  if (!(t.dataType in WIDTH)) return fail(`неизвестный dataType "${t.dataType}"`);
  if (tbl.bits !== (t.dataType === 'bool')) return fail('bool допустим только для coil/discrete');
  if (t.writable && !tbl.writable) return fail(`таблица "${t.table}" только для чтения`);
  if (!Number.isFinite(t.scale) || t.scale === 0) return fail('scale должен быть ненулевым числом');

  t.width = WIDTH[t.dataType];
  t._last = null;
  return t;
}

// ---------------------------------------------------------------------------
// Кодирование / декодирование
// ---------------------------------------------------------------------------
function decode(tag, regs) {
  if (tag.dataType === 'bool') return Boolean(regs[0]);

  const buf = Buffer.alloc(tag.width * 2);
  const words = tag.wordOrder === 'LE' ? [...regs].reverse() : regs;
  words.forEach((w, i) => buf.writeUInt16BE(w, i * 2));

  let raw;
  switch (tag.dataType) {
    case 'uint16':  raw = buf.readUInt16BE(0); break;
    case 'int16':   raw = buf.readInt16BE(0); break;
    case 'uint32':  raw = buf.readUInt32BE(0); break;
    case 'int32':   raw = buf.readInt32BE(0); break;
    case 'float32': raw = buf.readFloatBE(0); break;
  }
  if (!Number.isFinite(raw)) return null;
  return Number((raw * tag.scale + tag.offset).toFixed(tag.decimals));
}

function encode(tag, value) {
  let raw = (value - tag.offset) / tag.scale;
  if (tag.dataType !== 'float32') raw = Math.round(raw);

  const buf = Buffer.alloc(tag.width * 2);
  try {
    switch (tag.dataType) {
      case 'uint16':  buf.writeUInt16BE(raw, 0); break;
      case 'int16':   buf.writeInt16BE(raw, 0); break;
      case 'uint32':  buf.writeUInt32BE(raw, 0); break;
      case 'int32':   buf.writeInt32BE(raw, 0); break;
      case 'float32': buf.writeFloatBE(raw, 0); break;
    }
  } catch {
    throw new Error(`Значение ${value} вне диапазона типа ${tag.dataType}`);
  }
  const words = [];
  for (let i = 0; i < tag.width; i++) words.push(buf.readUInt16BE(i * 2));
  return tag.wordOrder === 'LE' ? words.reverse() : words;
}

const toBool = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';

// ---------------------------------------------------------------------------
// Публикация в существующий поток сообщений
// ---------------------------------------------------------------------------
function publish(tag, value, { toClients = true } = {}) {
  tag._last = { value, ts: Date.now() };

  const message = {
    type: 'post',
    request: tag.request,
    name: tag.dID,
    payload: {
      room: tag.room,
      item_name: tag.item_name,
      item_value: value,
      item_type: tag.item_type,
      title: tag.title,
      group: tag.group
    }
  };

  try {
    addMessageToQueue(tag.dID, message); // сохранит в config-файл через handlePostNodeRED
    if (toClients && broadcastFn) {
      broadcastFn(BRIDGE_ID, tag.dID, { ...message, payload: { ...message.payload } }, broadcastTargets);
    }
  } catch (err) {
    logger.logErrorMessage(`[modbusBridge] - publish ${tag.item_name}: ${err.message}`);
  }
}

function publishIfNeeded(tag, value) {
  const last = tag._last;
  if (!last) return publish(tag, value);

  const changed = typeof value === 'boolean'
    ? value !== last.value
    : Math.abs(value - last.value) > tag.deadband;

  if (changed) return publish(tag, value);
  // значение не менялось, но периодически обновляем lastUpdate в файле (без рассылки клиентам)
  if (Date.now() - last.ts >= cfg.republishMs) publish(tag, value, { toClients: false });
}

// ---------------------------------------------------------------------------
// Опрос
// ---------------------------------------------------------------------------
function onData({ deviceId, name, values }) {
  const key = `${deviceId}:${name}`;
  const block = blocks.get(key);
  if (!block) return;
  pollErrors.delete(key);

  for (const tag of block.tags) {
    const i = tag.address - block.start;
    const slice = values.slice(i, i + tag.width);
    if (slice.length < tag.width) continue;
    const value = decode(tag, slice);
    if (value !== null) publishIfNeeded(tag, value);
  }
}

function onPollError({ deviceId, name, error }) {
  const key = `${deviceId}:${name}`;
  if (pollErrors.get(key) === error.message) return;
  pollErrors.set(key, error.message);
  logger.logErrorMessage(`[modbusBridge] - ошибка опроса ${key}: ${error.message}`);
}

// Объединяем теги в минимальное число запросов: (устройство, таблица, интервал) -> диапазоны
function buildBlocks() {
  const groups = new Map();
  for (const tag of tagIndex.values()) {
    const interval = tag.interval || cfg.pollInterval;
    const gk = `${tag.deviceId}|${tag.table}|${interval}`;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(tag);
  }

  for (const [gk, tags] of groups) {
    const [deviceId, table, intervalStr] = gk.split('|');
    const maxSpan = TABLES[table].maxSpan;
    tags.sort((a, b) => a.address - b.address);

    let cur = null;
    for (const tag of tags) {
      const end = tag.address + tag.width - 1;
      if (!cur || end - cur.start + 1 > maxSpan) {
        cur = { deviceId, table, interval: Number(intervalStr), start: tag.address, end, tags: [] };
        const name = `blk_${table}_${cur.start}`;
        cur.name = name;
        blocks.set(`${deviceId}:${name}`, cur);
      }
      cur.end = Math.max(cur.end, end);
      cur.tags.push(tag);
    }
  }

  for (const b of blocks.values()) {
    if (!modbusManager.hasDevice(b.deviceId)) {
      logger.logErrorMessage(`[modbusBridge] - устройство "${b.deviceId}" не найдено в MODBUS_DEVICES, опрос ${b.name} пропущен`);
      continue;
    }
    modbusManager.startPoll(b.deviceId, b.name, {
      method: TABLES[b.table].read,
      address: b.start,
      quantity: b.end - b.start + 1,
      interval: b.interval
    });
    logger.logInfoMessage(`[modbusBridge] - опрос ${b.deviceId}/${b.name}: ${b.table} ${b.start}..${b.end} каждые ${b.interval} мс, тегов: ${b.tags.length}`);
  }
}

// ---------------------------------------------------------------------------
// Команды от VUE
// ---------------------------------------------------------------------------
function findTag(message) {
  const p = message?.payload || {};
  const room = Array.isArray(p.room) ? p.room[0] : p.room;
  const item = p.item_name ??
    (message.request === 'setpoints' && p.key !== undefined ? `s${p.key}` : p.key);
  return tagIndex.get(tagKey(message.name, message.request, room, item));
}

/** true, если сообщение относится к Modbus-тегу (тогда его не надо пересылать в NodeRED) */
function isModbusItem(message) {
  return Boolean(findTag(message));
}

/**
 * Обрабатывает команду от VUE. Возвращает true, если сообщение "забрал" Modbus.
 * Запись выполняется асинхронно; результат уходит клиентам через publish / sendToConnection.
 */
function handleCommand(clientId, message) {
  const tag = findTag(message);
  if (!tag) return false;

  const p = message.payload || {};
  const input = p.item_value ?? p.value;

  const sendError = (msg, code) =>
    wsManager.sendToConnection('VUE_connections', clientId, 'error', 'modbusWriteError', message.name, {
      room: tag.room, item_name: tag.item_name, message: msg, code
    });

  if (!tag.writable) {
    sendError(`Тег ${tag.item_name} доступен только для чтения`, 'READ_ONLY');
    return true;
  }

  writeTag(tag, input)
    .then((value) => {
      logger.logDevMessage(`[modbusBridge] - записано ${tag.deviceId}/${tag.item_name} = ${value}`);
      publish(tag, value); // подтверждение всем VUE, включая отправителя; опрос затем сверит факт
    })
    .catch((err) => {
      logger.logErrorMessage(`[modbusBridge] - запись ${tag.deviceId}/${tag.item_name}: ${err.message}`);
      sendError(err.message, err.code || 'MODBUS_ERROR');
    });

  return true;
}

async function writeTag(tag, input) {
  if (tag.dataType === 'bool') {
    const v = toBool(input);
    await modbusManager.call(tag.deviceId, 'writeSingleCoil', tag.address, v);
    return v;
  }
  const num = Number(input);
  if (!Number.isFinite(num)) throw new Error(`Некорректное значение: ${input}`);

  const words = encode(tag, num);
  if (words.length === 1) {
    await modbusManager.call(tag.deviceId, 'writeSingleRegister', tag.address, words[0]);
  } else {
    await modbusManager.call(tag.deviceId, 'writeMultipleRegisters', tag.address, words);
  }
  return decode(tag, words); // значение с учётом округления/масштаба
}

// ---------------------------------------------------------------------------
// Жизненный цикл
// ---------------------------------------------------------------------------
/**
 * @param {object}   opts
 * @param {Function} opts.broadcast  функция broadcast из serverapp.js
 * @param {string}  [opts.mapFile]   путь к карте тегов (по умолчанию MODBUS_MAP_FILE или ./modbusMap.json)
 * @param {string[]}[opts.targets]   кому рассылать, по умолчанию ['VUE_connections','nRED_connections']
 */
function init({ broadcast, mapFile, targets } = {}) {
  broadcastFn = broadcast;
  broadcastTargets = targets;

  const file = path.resolve(mapFile || process.env.MODBUS_MAP_FILE || './modbusMap.json');
  let map;
  try {
    map = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    logger.logErrorMessage(`[modbusBridge] - не удалось прочитать карту тегов ${file}: ${err.message}`);
    return 0;
  }

  cfg = {
    pollInterval: Number(map.pollInterval) || cfg.pollInterval,
    republishMs: Number(map.republishMs) || cfg.republishMs
  };

  (map.tags || []).forEach((raw, i) => {
    const tag = normalizeTag(raw, i);
    if (!tag) return;
    const key = tagKey(tag.dID, tag.request, tag.room, tag.item_name);
    if (tagIndex.has(key)) {
      logger.logErrorMessage(`[modbusBridge] - дубликат тега ${key}, пропущен`);
      return;
    }
    tagIndex.set(key, tag);
  });

  modbusManager.on('data', onData);
  modbusManager.on('pollError', onPollError);
  buildBlocks();

  logger.logInfoMessage(`[modbusBridge] - загружено тегов: ${tagIndex.size}, блоков опроса: ${blocks.size}`);
  return tagIndex.size;
}

function stop() {
  modbusManager.removeListener('data', onData);
  modbusManager.removeListener('pollError', onPollError);
  for (const b of blocks.values()) modbusManager.stopPoll(b.deviceId, b.name);
  blocks.clear();
  tagIndex.clear();
  pollErrors.clear();
}

module.exports = { init, stop, isModbusItem, handleCommand };
