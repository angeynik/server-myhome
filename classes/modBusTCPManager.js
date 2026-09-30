// classes/modBusTCPManager.js
// Modbus TCP master (без внешних зависимостей, только net + events).
// - ModbusDevice: одно TCP-соединение со slave, очередь запросов (1 запрос "в полёте"),
//   таймауты, автопереподключение с экспоненциальной паузой
// - ModbusManager: реестр устройств, опрос (polling), события, загрузка из env
//
// Логирование (logger.js):
//   logInfoMessage  - значимые события жизненного цикла: подключение, отключение,
//                      добавление/удаление устройства, старт/стоп опроса
//   logDevMessage   - подробности каждого запроса/ответа, полезно при отладке протокола
//   logErrorMessage - таймауты, ошибки сокета, modbus-исключения, невалидные ответы

'use strict';

const net = require('net');
const EventEmitter = require('events');
const logger = require('../services/logger.js');
logger.initLogging();

const FC = {
  READ_COILS: 0x01,
  READ_DISCRETE_INPUTS: 0x02,
  READ_HOLDING_REGISTERS: 0x03,
  READ_INPUT_REGISTERS: 0x04,
  WRITE_SINGLE_COIL: 0x05,
  WRITE_SINGLE_REGISTER: 0x06,
  WRITE_MULTIPLE_COILS: 0x0f,
  WRITE_MULTIPLE_REGISTERS: 0x10
};

const FC_NAMES = {
  0x01: 'READ_COILS', 0x02: 'READ_DISCRETE_INPUTS',
  0x03: 'READ_HOLDING_REGISTERS', 0x04: 'READ_INPUT_REGISTERS',
  0x05: 'WRITE_SINGLE_COIL', 0x06: 'WRITE_SINGLE_REGISTER',
  0x0f: 'WRITE_MULTIPLE_COILS', 0x10: 'WRITE_MULTIPLE_REGISTERS'
};

const EXCEPTIONS = {
  1: 'ILLEGAL_FUNCTION',
  2: 'ILLEGAL_DATA_ADDRESS',
  3: 'ILLEGAL_DATA_VALUE',
  4: 'SERVER_DEVICE_FAILURE',
  5: 'ACKNOWLEDGE',
  6: 'SERVER_DEVICE_BUSY',
  8: 'MEMORY_PARITY_ERROR',
  10: 'GATEWAY_PATH_UNAVAILABLE',
  11: 'GATEWAY_TARGET_FAILED'
};

class ModbusError extends Error {
  // code: ETIMEOUT | ENOTCONNECTED | ECLOSED | EPROTOCOL | EARGS | EEXCEPTION
  constructor(message, { code = 'EPROTOCOL', exceptionCode = null } = {}) {
    super(message);
    this.name = 'ModbusError';
    this.code = code;
    this.exceptionCode = exceptionCode;
  }
}

const isUInt16 = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffff;

function checkRange(address, quantity, maxQty) {
  if (!isUInt16(address) || !Number.isInteger(quantity) || quantity < 1 || quantity > maxQty ||
      address + quantity > 0x10000) {
    throw new ModbusError(`Bad address/quantity: ${address}/${quantity} (max ${maxQty})`, { code: 'EARGS' });
  }
}

// ---------------------------------------------------------------------------
class ModbusDevice extends EventEmitter {
  constructor(id, opts = {}) {
    super();
    this.id = id;
    this.host = opts.host;
    this.port = opts.port || 502;
    this.unitId = opts.unitId ?? 1;
    this.timeout = opts.timeout || 3000;
    this.reconnectMin = opts.reconnectMin || 1000;
    this.reconnectMax = opts.reconnectMax || 30000;

    if (!this.host) throw new ModbusError(`Device "${id}": host is required`, { code: 'EARGS' });

    this.socket = null;
    this.connected = false;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    this.current = null;
    this.tid = 0;
    this.attempt = 0;
    this.reconnectTimer = null;
    this.lastError = null;
    this.lastActivity = null;

    this.tag = `${this.id}(${this.host}:${this.port})`;
  }

  // ---- соединение ---------------------------------------------------------
  connect() {
    if (this.closed || this.socket) return;

    logger.logInfoMessage(`[ModbusDevice] - 🔌 ${this.tag} - устанавливаем соединение (попытка ${this.attempt + 1})`);

    const sock = new net.Socket();
    this.socket = sock;
    this.buffer = Buffer.alloc(0);
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 10000);
    sock.setTimeout(this.timeout); // таймаут на установку соединения

    sock.on('connect', () => {
      if (sock !== this.socket) return;
      sock.setTimeout(0);
      this.connected = true;
      this.attempt = 0;
      this.lastActivity = Date.now();
      logger.logInfoMessage(`[ModbusDevice] - ✅ ${this.tag} - соединение установлено`);
      this.emit('connect');
      this._next();
    });
    sock.on('timeout', () => {
      logger.logErrorMessage(`[ModbusDevice] - ⏱ ${this.tag} - таймаут установки соединения (${this.timeout} мс)`);
      sock.destroy(new ModbusError('Connect timeout', { code: 'ETIMEOUT' }));
    });
    sock.on('data', (chunk) => {
      if (sock === this.socket) this._onData(chunk);
    });
    sock.on('error', (err) => {
      this.lastError = err.message;
      logger.logErrorMessage(`[ModbusDevice] - ❌ ${this.tag} - ошибка сокета: ${err.message}`);
      this.emit('fault', err); // не 'error', чтобы не падать без слушателя
    });
    sock.on('close', () => {
      if (sock !== this.socket) return;
      const wasConnected = this.connected;
      this.socket = null;
      this.connected = false;
      this._failAll(new ModbusError('Connection closed', { code: 'ECLOSED' }));
      if (wasConnected) {
        logger.logInfoMessage(`[ModbusDevice] - ⚠️ ${this.tag} - соединение закрыто`);
        this.emit('disconnect');
      }
      this._scheduleReconnect();
    });

    sock.connect(this.port, this.host);
  }

  _scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(this.reconnectMin * 2 ** this.attempt, this.reconnectMax);
    this.attempt++;
    logger.logInfoMessage(`[ModbusDevice] - 🔁 ${this.tag} - переподключение через ${delay} мс`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  close() {
    logger.logInfoMessage(`[ModbusDevice] - 🛑 ${this.tag} - закрываем устройство`);
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._failAll(new ModbusError('Device closed', { code: 'ECLOSED' }));
    if (this.socket) this.socket.destroy();
    this.socket = null;
    this.connected = false;
  }

  // ---- очередь запросов ---------------------------------------------------
  _request(pdu) {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.connected) {
        logger.logErrorMessage(`[ModbusDevice] - ❌ ${this.tag} - запрос отклонён: нет соединения`);
        return reject(new ModbusError(`Device "${this.id}" not connected`, { code: 'ENOTCONNECTED' }));
      }
      logger.logDevMessage(`[ModbusDevice] - 📥 ${this.tag} - запрос поставлен в очередь: fc=${FC_NAMES[pdu[0]] || pdu[0]}, очередь: ${this.queue.length + (this.current ? 1 : 0)}`);
      this.queue.push({ pdu, fc: pdu[0], resolve, reject, tid: 0, timer: null });
      this._next();
    });
  }

  _next() {
    if (this.current || !this.connected || this.queue.length === 0) return;

    const req = this.queue.shift();
    this.current = req;
    this.tid = (this.tid + 1) & 0xffff;
    req.tid = this.tid;

    const frame = Buffer.alloc(7 + req.pdu.length);
    frame.writeUInt16BE(req.tid, 0);
    frame.writeUInt16BE(0, 2);                      // protocol id
    frame.writeUInt16BE(req.pdu.length + 1, 4);     // unitId + pdu
    frame.writeUInt8(this.unitId, 6);
    req.pdu.copy(frame, 7);

    logger.logDevMessage(`[ModbusDevice] - 📤 ${this.tag} - отправляем tid=${req.tid} fc=${FC_NAMES[req.fc] || req.fc} unit=${this.unitId} (${frame.length} байт)`);

    req.timer = setTimeout(() => {
      if (this.current !== req) return;
      this.current = null;
      logger.logErrorMessage(`[ModbusDevice] - ⏱ ${this.tag} - таймаут ответа (${this.timeout} мс) на tid=${req.tid} fc=${FC_NAMES[req.fc] || req.fc}`);
      req.reject(new ModbusError(`Timeout (${this.timeout} ms) on "${this.id}"`, { code: 'ETIMEOUT' }));
      // позднего ответа быть не должно -> пересоздаём соединение, чтобы не потерять синхронизацию
      if (this.socket) this.socket.destroy();
    }, this.timeout);

    this.socket.write(frame, (err) => {
      if (err && this.current === req) {
        logger.logErrorMessage(`[ModbusDevice] - ❌ ${this.tag} - ошибка записи в сокет: ${err.message}`);
        this.socket?.destroy(err);
      }
    });
  }

  _failAll(err) {
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.reject(err);
      this.current = null;
    }
    if (this.queue.length) {
      logger.logErrorMessage(`[ModbusDevice] - ${this.tag} - отменено запросов в очереди: ${this.queue.length} (${err.message})`);
    }
    for (const req of this.queue) req.reject(err);
    this.queue = [];
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.lastActivity = Date.now();
    logger.logDevMessage(`[ModbusDevice] - 📩 ${this.tag} - получено ${chunk.length} байт, в буфере ${this.buffer.length}`);

    while (this.buffer.length >= 7) {
      const protocolId = this.buffer.readUInt16BE(2);
      const length = this.buffer.readUInt16BE(4);
      if (protocolId !== 0 || length < 2 || length > 254) {
        // поток рассинхронизирован
        logger.logErrorMessage(`[ModbusDevice] - ❌ ${this.tag} - невалидный MBAP заголовок (protocolId=${protocolId}, length=${length}), пересоздаём соединение`);
        this.socket?.destroy(new ModbusError('Invalid MBAP header', { code: 'EPROTOCOL' }));
        return;
      }
      const total = 6 + length;
      if (this.buffer.length < total) return; // ждём остаток

      const frame = this.buffer.subarray(0, total);
      this.buffer = this.buffer.subarray(total);
      this._onFrame(frame);
    }
  }

  _onFrame(frame) {
    const tid = frame.readUInt16BE(0);
    const unit = frame.readUInt8(6);
    const pdu = Buffer.from(frame.subarray(7));
    const req = this.current;

    // ответ на уже отменённый запрос или чужой unit - игнорируем
    if (!req || req.tid !== tid || unit !== this.unitId) {
      logger.logDevMessage(`[ModbusDevice] - ⚠️ ${this.tag} - получен неожиданный кадр tid=${tid} unit=${unit}, игнорируем`);
      return;
    }

    clearTimeout(req.timer);
    this.current = null;

    const fc = pdu[0];
    if (fc === (req.fc | 0x80)) {
      const ec = pdu[1];
      logger.logErrorMessage(`[ModbusDevice] - ❌ ${this.tag} - modbus-исключение ${ec} ${EXCEPTIONS[ec] || ''} на tid=${tid} fc=${FC_NAMES[req.fc] || req.fc}`);
      req.reject(new ModbusError(`Modbus exception ${ec} ${EXCEPTIONS[ec] || ''}`.trim(),
        { code: 'EEXCEPTION', exceptionCode: ec }));
    } else if (fc !== req.fc) {
      logger.logErrorMessage(`[ModbusDevice] - ❌ ${this.tag} - неожиданный fc=${fc} в ответе на tid=${tid} (ожидался ${req.fc})`);
      req.reject(new ModbusError(`Unexpected function code ${fc}`, { code: 'EPROTOCOL' }));
    } else {
      logger.logDevMessage(`[ModbusDevice] - ✅ ${this.tag} - получен корректный ответ tid=${tid} fc=${FC_NAMES[fc] || fc}`);
      req.resolve(pdu);
    }
    this._next();
  }

  // ---- чтение -------------------------------------------------------------
  async _readBits(fc, address, quantity) {
    checkRange(address, quantity, 2000);
    const pdu = Buffer.from([fc, address >> 8, address & 0xff, quantity >> 8, quantity & 0xff]);
    const res = await this._request(pdu);
    const byteCount = res[1];
    if (byteCount !== Math.ceil(quantity / 8) || res.length < 2 + byteCount) {
      throw new ModbusError('Bad response length', { code: 'EPROTOCOL' });
    }
    const out = [];
    for (let i = 0; i < quantity; i++) out.push(Boolean((res[2 + (i >> 3)] >> (i & 7)) & 1));
    return out;
  }

  async _readRegs(fc, address, quantity) {
    checkRange(address, quantity, 125);
    const pdu = Buffer.from([fc, address >> 8, address & 0xff, quantity >> 8, quantity & 0xff]);
    const res = await this._request(pdu);
    const byteCount = res[1];
    if (byteCount !== quantity * 2 || res.length < 2 + byteCount) {
      throw new ModbusError('Bad response length', { code: 'EPROTOCOL' });
    }
    const out = [];
    for (let i = 0; i < quantity; i++) out.push(res.readUInt16BE(2 + i * 2));
    return out;
  }

  readCoils(address, quantity = 1) { return this._readBits(FC.READ_COILS, address, quantity); }
  readDiscreteInputs(address, quantity = 1) { return this._readBits(FC.READ_DISCRETE_INPUTS, address, quantity); }
  readHoldingRegisters(address, quantity = 1) { return this._readRegs(FC.READ_HOLDING_REGISTERS, address, quantity); }
  readInputRegisters(address, quantity = 1) { return this._readRegs(FC.READ_INPUT_REGISTERS, address, quantity); }

  // ---- запись -------------------------------------------------------------
  async writeSingleCoil(address, value) {
    checkRange(address, 1, 1);
    const pdu = Buffer.alloc(5);
    pdu.writeUInt8(FC.WRITE_SINGLE_COIL, 0);
    pdu.writeUInt16BE(address, 1);
    pdu.writeUInt16BE(value ? 0xff00 : 0x0000, 3);
    logger.logInfoMessage(`[ModbusDevice] - ✍️ ${this.tag} - запись coil[${address}] = ${value}`);
    await this._request(pdu);
    return true;
  }

  async writeSingleRegister(address, value) {
    checkRange(address, 1, 1);
    if (!isUInt16(value)) throw new ModbusError(`Bad register value: ${value}`, { code: 'EARGS' });
    const pdu = Buffer.alloc(5);
    pdu.writeUInt8(FC.WRITE_SINGLE_REGISTER, 0);
    pdu.writeUInt16BE(address, 1);
    pdu.writeUInt16BE(value, 3);
    logger.logInfoMessage(`[ModbusDevice] - ✍️ ${this.tag} - запись register[${address}] = ${value}`);
    await this._request(pdu);
    return true;
  }

  async writeMultipleCoils(address, values) {
    if (!Array.isArray(values)) throw new ModbusError('values must be an array', { code: 'EARGS' });
    const qty = values.length;
    checkRange(address, qty, 1968);
    const byteCount = Math.ceil(qty / 8);
    const pdu = Buffer.alloc(6 + byteCount);
    pdu.writeUInt8(FC.WRITE_MULTIPLE_COILS, 0);
    pdu.writeUInt16BE(address, 1);
    pdu.writeUInt16BE(qty, 3);
    pdu.writeUInt8(byteCount, 5);
    values.forEach((v, i) => { if (v) pdu[6 + (i >> 3)] |= 1 << (i & 7); });
    logger.logInfoMessage(`[ModbusDevice] - ✍️ ${this.tag} - запись coils[${address}..${address + qty - 1}] = [${values}]`);
    await this._request(pdu);
    return true;
  }

  async writeMultipleRegisters(address, values) {
    if (!Array.isArray(values) || !values.every(isUInt16)) {
      throw new ModbusError('values must be an array of uint16', { code: 'EARGS' });
    }
    const qty = values.length;
    checkRange(address, qty, 123);
    const pdu = Buffer.alloc(6 + qty * 2);
    pdu.writeUInt8(FC.WRITE_MULTIPLE_REGISTERS, 0);
    pdu.writeUInt16BE(address, 1);
    pdu.writeUInt16BE(qty, 3);
    pdu.writeUInt8(qty * 2, 5);
    values.forEach((v, i) => pdu.writeUInt16BE(v, 6 + i * 2));
    logger.logInfoMessage(`[ModbusDevice] - ✍️ ${this.tag} - запись registers[${address}..${address + qty - 1}] = [${values}]`);
    await this._request(pdu);
    return true;
  }

  getStatus() {
    return {
      id: this.id,
      host: this.host,
      port: this.port,
      unitId: this.unitId,
      connected: this.connected,
      queueLength: this.queue.length,
      lastActivity: this.lastActivity,
      lastError: this.lastError
    };
  }
}

// ---------------------------------------------------------------------------
class ModbusManager extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map(); // id -> ModbusDevice
    this.polls = new Map();   // `${id}:${name}` -> { active, timer }
  }

  addDevice(id, opts = {}) {
    if (this.devices.has(id)) {
      logger.logInfoMessage(`[ModbusManager] - 🔄 Устройство ${id} уже зарегистрировано`);
      return this.devices.get(id);
    }
    logger.logInfoMessage(`[ModbusManager] - ➕ Добавляем устройство ${id} (${opts.host}:${opts.port || 502}, unitId=${opts.unitId ?? 1})`);

    const device = new ModbusDevice(id, {
      timeout: Number(process.env.MODBUS_TIMEOUT) || undefined,
      reconnectMin: Number(process.env.MODBUS_RECONNECT_MIN) || undefined,
      reconnectMax: Number(process.env.MODBUS_RECONNECT_MAX) || undefined,
      ...opts
    });

    device.on('connect', () => this.emit('connect', id));
    device.on('disconnect', () => this.emit('disconnect', id));
    device.on('fault', (err) => {
      // событие уже залогировано внутри ModbusDevice; здесь только прокидываем дальше
      this.emit('fault', id, err);
    });

    this.devices.set(id, device);
    device.connect();

    (opts.polls || []).forEach((p) => this.startPoll(id, p.name, p));
    return device;
  }

  removeDevice(id) {
    const device = this.devices.get(id);
    if (!device) return false;
    for (const key of [...this.polls.keys()]) {
      if (key.startsWith(`${id}:`)) this._stopPollKey(key);
    }
    device.close();
    this.devices.delete(id);
    logger.logInfoMessage(`[ModbusManager] - 🗑 Устройство удалено: ${id}`);
    return true;
  }

  hasDevice(id) { return this.devices.has(id); }
  getDevice(id) { return this.devices.get(id) || null; }
  isConnected(id) { return Boolean(this.devices.get(id)?.connected); }
  getAllStatus() { return [...this.devices.values()].map((d) => d.getStatus()); }

  // Универсальный вызов: manager.call('relay1', 'readHoldingRegisters', 0, 10)
  call(id, method, ...args) {
    const device = this.devices.get(id);
    if (!device) return Promise.reject(new ModbusError(`Unknown device "${id}"`, { code: 'EARGS' }));
    if (typeof device[method] !== 'function' || method.startsWith('_')) {
      return Promise.reject(new ModbusError(`Unknown method "${method}"`, { code: 'EARGS' }));
    }
    return device[method](...args);
  }

  // ---- опрос --------------------------------------------------------------
  // cfg: { method: 'readHoldingRegisters', address: 0, quantity: 4, interval: 1000 }
  // Событие: manager.on('data', ({ deviceId, name, values, ts }) => ...)
  startPoll(deviceId, name, cfg) {
    const key = `${deviceId}:${name}`;
    this._stopPollKey(key);
    const { method = 'readHoldingRegisters', address = 0, quantity = 1, interval = 1000 } = cfg;
    logger.logInfoMessage(`[ModbusManager] - ▶️ Старт опроса ${key}: ${method}(${address}, ${quantity}) каждые ${interval} мс`);
    const state = { active: true, timer: null };
    this.polls.set(key, state);

    // setTimeout-цепочка: следующий опрос только после завершения предыдущего
    const tick = async () => {
      if (!state.active) return;
      const device = this.devices.get(deviceId);
      if (device?.connected) {
        try {
          const values = await device[method](address, quantity);
          logger.logDevMessage(`[ModbusManager] - 📊 ${key} - опрос успешен: [${values}]`);
          if (state.active) this.emit('data', { deviceId, name, values, ts: Date.now() });
        } catch (err) {
          logger.logErrorMessage(`[ModbusManager] - ❌ ${key} - ошибка опроса: ${err.message}`);
          if (state.active) this.emit('pollError', { deviceId, name, error: err });
        }
      }
      if (state.active) {
        state.timer = setTimeout(tick, interval);
        state.timer.unref?.();
      }
    };
    tick();
  }

  stopPoll(deviceId, name) {
    logger.logInfoMessage(`[ModbusManager] - ⏹ Стоп опроса ${deviceId}:${name}`);
    this._stopPollKey(`${deviceId}:${name}`);
  }

  _stopPollKey(key) {
    const state = this.polls.get(key);
    if (!state) return;
    state.active = false;
    clearTimeout(state.timer);
    this.polls.delete(key);
  }

  // ---- конфигурация -------------------------------------------------------
  // MODBUS_DEVICES=[{"id":"relay1","host":"192.168.1.50","port":502,"unitId":1,
  //   "polls":[{"name":"state","method":"readCoils","address":0,"quantity":8,"interval":1000}]}]
  loadFromEnv() {
    const raw = process.env.MODBUS_DEVICES;
    if (!raw) {
      logger.logInfoMessage('[ModbusManager] - MODBUS_DEVICES не задан, устройства не загружены');
      return 0;
    }
    let list;
    try {
      list = JSON.parse(raw);
    } catch (e) {
      logger.logErrorMessage(`[ModbusManager] - ❌ MODBUS_DEVICES: невалидный JSON: ${e.message}`);
      return 0;
    }
    let count = 0;
    for (const cfg of list) {
      try {
        this.addDevice(cfg.id, cfg);
        count++;
      } catch (e) {
        logger.logErrorMessage(`[ModbusManager] - ❌ Не удалось добавить ${cfg?.id}: ${e.message}`);
      }
    }
    logger.logInfoMessage(`[ModbusManager] - Загружено устройств из env: ${count}`);
    return count;
  }

  cleanup() {
    logger.logInfoMessage('[ModbusManager] - Останавливаем все устройства и опросы');
    for (const key of [...this.polls.keys()]) this._stopPollKey(key);
    for (const device of this.devices.values()) device.close();
    this.devices.clear();
    logger.logInfoMessage('[ModbusManager] - All devices cleaned up');
  }
}

const modbusManager = new ModbusManager();
module.exports = modbusManager;
module.exports.ModbusManager = ModbusManager;
module.exports.ModbusDevice = ModbusDevice;
module.exports.ModbusError = ModbusError;
module.exports.FC = FC;
