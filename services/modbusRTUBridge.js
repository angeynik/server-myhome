// services/modbusRTUBridge.js
// Мост между Modbus RTU (modBus/modbusManager.js) и потоком сообщений сервера — аналог modbusTCPBridge.
//
//  RTU-устройство --опрос Master--> onData --> {type:'post', ...} --> addMessageToQueue (config-файл dID)
//                                                              \--> broadcast (Vue того же dID)
//  Vue 'post' --> handleCommand --> master.writeToDevice --> publish (подтверждение всем Vue)
//  внешний Master пишет в наш Slave --> onSlaveWrite --> publish текущего значения тега
//
// Включается MODBUS_RTU_ENABLED=true, конфигурация — MODBUS_RTU_CONF (по умолчанию ./modBus/modbusConf.json).
// Поля регистра сверх описанных в modBus/MODBUS_README.md:
//   request   — раздел конфига dID: sensors (по умолчанию у Master) | system (у Slave) | setpoints | ...
//   item_type — тип для Vue ('num' | 'bool'); по умолчанию определяется по значению
//   writable  — true разрешает запись из Vue (только coil/holding устройств Master)
//   deadband  — минимальное изменение числа для рассылки клиентам (по умолчанию 0)
//   room, title, group — как у NodeRED; room по умолчанию — room устройства или его dID
// Поле устройства Master "id" — уникальное имя устройства на шине (по умолчанию dID). Нужно, когда
// несколько устройств относятся к одному пользователю (одинаковый dID): команды и теги различаются по id.
'use strict';

const cfg = require('./authConfig');
const wsManager = require('../classes/wsManager');
const { addMessageToQueue } = require('./messageStore.js');
const logger = require('./logger.js');

const BRIDGE_ID = 'modbus-rtu-bridge';
const DEFAULT_CONF = './modBus/modbusConf.json';
const REPUBLISH_MS = 60000;
const WRITABLE_TABLES = new Set(['coil', 'holding']);

const toBool = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const tagKey = (dID, request, room, item) => `${dID}|${request}|${room}|${item}`;

function createModbusRtuBridge({
  loadManager = () => require('../modBus/modbusManager'),
  queue = addMessageToQueue,
  ws = wsManager,
  now = Date.now,
} = {}) {
  let manager = null;
  let broadcastFn = null;
  const masterTags = new Map(); // `${deviceId}|${regName}` -> tag
  const slaveTags = new Map();  // regName -> tag
  const byKey = new Map();      // tagKey -> tag устройства Master (для команд из Vue)

  function makeTag(reg, { dID, room, deviceName, request, source }) {
    return {
      source,
      dID,
      deviceName,
      name: reg.name,
      table: reg.type,
      request: reg.request || request,
      room: reg.room || room,
      item_name: reg.name,
      item_type: reg.item_type,
      title: reg.title || '',
      group: reg.group || '',
      writable: source === 'master' && reg.writable === true && WRITABLE_TABLES.has(reg.type),
      deadband: Number(reg.deadband) || 0,
      _last: null,
    };
  }

  function indexTags(config) {
    const deviceIds = new Set();
    for (const device of config.master?.devices || []) {
      if (!cfg.isValidDID(device.dID)) {
        logger.logErrorMessage(`[modbusRtuBridge] - устройство с недопустимым dID "${device.dID}" пропущено`);
        continue;
      }
      const deviceId = device.id ?? device.dID;
      if (deviceIds.has(deviceId)) {
        logger.logErrorMessage(
          `[modbusRtuBridge] - устройство "${deviceId}" повторяется — задайте каждому устройству уникальный "id" ` +
          '(несколько устройств одного dID); теги повтора пропущены'
        );
        continue;
      }
      deviceIds.add(deviceId);
      for (const reg of device.registers || []) {
        const tag = makeTag(reg, {
          dID: device.dID, room: device.room || device.dID, deviceName: deviceId, request: 'sensors', source: 'master',
        });
        const key = tagKey(tag.dID, tag.request, tag.room, tag.item_name);
        if (byKey.has(key)) {
          logger.logErrorMessage(
            `[modbusRtuBridge] - тег ${key} (устройство ${deviceId}) повторяет тег другого устройства — ` +
            'задайте разные "room" или имена регистров; пропущен'
          );
          continue;
        }
        masterTags.set(`${deviceId}|${reg.name}`, tag);
        byKey.set(key, tag);
      }
    }
    const slave = config.slave;
    if (slave) {
      for (const reg of slave.registerMap || []) {
        const dID = reg.dID || slave.dID;
        if (!cfg.isValidDID(dID)) {
          logger.logErrorMessage(`[modbusRtuBridge] - регистр Slave "${reg.name}" без допустимого dID пропущен`);
          continue;
        }
        slaveTags.set(reg.name, makeTag(reg, { dID, room: slave.room || dID, request: 'system', source: 'slave' }));
      }
    }
  }

  function publish(tag, value, { toClients = true } = {}) {
    tag._last = { value, ts: now() };
    const message = {
      type: 'post',
      request: tag.request,
      name: tag.dID,
      payload: {
        room: tag.room,
        item_name: tag.item_name,
        item_value: value,
        item_type: tag.item_type || (typeof value === 'boolean' ? 'bool' : 'num'),
        title: tag.title,
        group: tag.group,
      },
    };
    try {
      queue(tag.dID, message);
      if (toClients && broadcastFn) {
        // получатели — как у modbusTCPBridge: Vue и NodeRED (если включён) того же dID
        broadcastFn(BRIDGE_ID, tag.dID, { ...message, payload: { ...message.payload } });
      }
    } catch (e) {
      logger.logErrorMessage(`[modbusRtuBridge] - publish ${tag.item_name}: ${e.message}`);
    }
  }

  function publishIfNeeded(tag, value) {
    const last = tag._last;
    if (!last) return publish(tag, value);
    const changed = typeof value === 'number' && typeof last.value === 'number'
      ? Math.abs(value - last.value) > tag.deadband
      : value !== last.value;
    if (changed) return publish(tag, value);
    if (now() - last.ts >= REPUBLISH_MS) publish(tag, value, { toClients: false });
  }

  function onData({ deviceId, dID, payload }) {
    const tag = masterTags.get(`${deviceId ?? dID}|${payload?.item_name}`);
    if (tag) publishIfNeeded(tag, payload.item_value);
  }

  function onDeviceError({ deviceId, dID, register, error }) {
    logger.logErrorMessage(`[modbusRtuBridge] - опрос ${deviceId ?? dID}.${register}: ${error}`);
  }

  function onSlaveWrite(write) {
    const tag = write.name ? slaveTags.get(write.name) : null;
    if (!tag || !manager?.slave) return;
    try {
      publishIfNeeded(tag, manager.slave.getValueByName(write.name));
    } catch (e) {
      logger.logErrorMessage(`[modbusRtuBridge] - запись внешнего Master в ${write.name}: ${e.message}`);
    }
  }

  async function init({ broadcast, confPath = process.env.MODBUS_RTU_CONF || DEFAULT_CONF } = {}) {
    broadcastFn = broadcast;
    const ModbusManager = loadManager();
    manager = new ModbusManager(confPath);
    indexTags(manager.config);
    await manager.start({ onData, onDeviceError, onSlaveWrite });
    logger.logInfoMessage(
      `[modbusRtuBridge] - запущен (${confPath}): тегов Master ${masterTags.size}, Slave ${slaveTags.size}`
    );
    return { master: masterTags.size, slave: slaveTags.size };
  }

  // Команда из Vue. true — команда относится к RTU-тегу и обработана здесь (дальше её не пересылать).
  // onResult({ ok, value?, error?, code? }) — результат записи для вызывающего (commandGateway, бот)
  function handleCommand(clientId, message, { onResult = () => {} } = {}) {
    if (!manager?.master) return false;
    const p = message?.payload || {};
    const room = Array.isArray(p.room) ? p.room[0] : p.room;
    const item = message.request === 'setpoints'
      ? (p.setKey ?? p.item_name ?? (p.key !== undefined ? `s${p.key}` : null))
      : (p.item_name ?? p.key ?? null);
    const tag = item ? byKey.get(tagKey(message.name, message.request, room, item)) : null;
    if (!tag) return false;

    const sendError = (msg, code) => {
      ws.sendToConnection('VUE_connections', clientId, 'error', 'modbusWriteError', message.name, {
        room: tag.room, item_name: tag.item_name, message: msg, code,
      });
      onResult({ ok: false, error: msg, code });
    };
    if (!tag.writable) {
      sendError(`Тег ${tag.item_name} доступен только для чтения`, 'READ_ONLY');
      return true;
    }

    const input = p.item_value ?? p.value;
    const value = tag.table === 'coil' ? toBool(input) : Number(input);
    if (typeof value === 'number' && !Number.isFinite(value)) {
      sendError(`Некорректное значение: ${input}`, 'BAD_VALUE');
      return true;
    }
    manager.writeToDevice(tag.deviceName, tag.name, value)
      .then(() => {
        logger.logInfoMessage(`[modbusRtuBridge] - записано ${tag.dID}/${tag.item_name} = ${value}`);
        publish(tag, value);
        onResult({ ok: true, value });
      })
      .catch((e) => {
        logger.logErrorMessage(`[modbusRtuBridge] - запись ${tag.dID}/${tag.item_name}: ${e.message}`);
        sendError('Не удалось записать значение в устройство', 'MODBUS_ERROR');
      });
    return true;
  }

  // Обновить значение, которое видит внешний Master (например, из GPIO)
  function setSlaveValue(name, value) {
    if (!manager?.slave) throw new Error('Modbus RTU Slave не запущен');
    manager.updateSlaveValueByName(name, value);
  }

  function stop() {
    if (manager) manager.close();
    manager = null;
    masterTags.clear();
    slaveTags.clear();
    byKey.clear();
  }

  return { init, handleCommand, setSlaveValue, stop };
}

const defaultBridge = createModbusRtuBridge();

module.exports = {
  createModbusRtuBridge,
  init: (...a) => defaultBridge.init(...a),
  handleCommand: (...a) => defaultBridge.handleCommand(...a),
  setSlaveValue: (...a) => defaultBridge.setSlaveValue(...a),
  stop: (...a) => defaultBridge.stop(...a),
};
