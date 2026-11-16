// modbus/modbusSlave.js
// Slave (ведомое устройство) Modbus RTU: Orange Pi отвечает на запросы внешнего
// Master (например, ПЛК, SCADA или другого контроллера) как обычное Modbus-устройство.
//
// Значения регистров хранятся в памяти (holdingRegisters/inputRegisters/coils/discreteInputs).
// Чтобы наружу "отдавать" актуальные данные (например, показания GPIO-датчиков или
// значения из БД), используйте setValue(regDef, value) - обновление можно делать
// в любой момент, сервер сразу начнёт отвечать новым значением.
//
// Когда внешний Master пишет что-то в наш регистр (setRegister/setCoil) - эмитится
// событие 'write', на которое можно подписаться в serverapp.js и, например,
// разослать это в Dashboard/NodeRED через существующий broadcast().

'use strict';

const EventEmitter = require('events');
const ModbusRTU = require('modbus-serial');
const { REGISTER_SIZE, encodeToRegisters, decodeRegisters, isValidRtuFrame } = require('./modbusUtils');
const logger = require('../services/logger.js');

class ModbusSlaveServer extends EventEmitter {
  /**
   * @param {object} config
   * @param {string} config.port - путь к серийному порту, например '/dev/ttyUSB0'
   * @param {number} [config.baudRate=9600]
   * @param {number} [config.dataBits=8]
   * @param {number} [config.stopBits=1]
   * @param {string} [config.parity='none'] - none | even | odd
   * @param {number} [config.unitId=21] - Modbus-адрес этого устройства (slave id); допускается и unitID
   * @param {number} [config.holdingRegistersSize=100]
   * @param {number} [config.inputRegistersSize=100]
   * @param {number} [config.coilsSize=100]
   * @param {number} [config.discreteInputsSize=100]
   * @param {Array}  [config.registerMap] - описание регистров (для имён в событиях 'write' и setValue)
   * @param {string} [config.dID] - логическое имя устройства по умолчанию для событий
   */
  constructor(config) {
    super();
    if (!config || !config.port) {
      throw new Error('[ModbusSlave] Не указан config.port для Slave-подключения');
    }
    this.config = config;
    this.unitID = config.unitId ?? config.unitID ?? 21;
    this.registerMap = config.registerMap || [];

    this.holdingRegisters = new Uint16Array(config.holdingRegistersSize || 100);
    this.inputRegisters = new Uint16Array(config.inputRegistersSize || 100);
    this.coils = new Uint8Array(config.coilsSize || 100);
    this.discreteInputs = new Uint8Array(config.discreteInputsSize || 100);

    this.server = null;
    // Проверка CRC входящих кадров (по умолчанию включена, отключается crcCheck: false)
    this.crcCheck = config.crcCheck !== false;
    this.stats = { frames: 0, crcErrors: 0 };

    // Применяем начальные значения из конфига, если заданы
    this.registerMap.forEach((reg) => {
      if (reg.initial !== undefined) {
        this.setValue(reg, reg.initial);
      }
    });
  }

  // Ищем тег, которому принадлежит регистр: 32-битные типы занимают два адреса подряд
  _findRegDef(type, addr) {
    return this.registerMap.find((r) => {
      if (r.type !== type) return false;
      const size = REGISTER_SIZE[r.dataType] || 1;
      return addr >= r.address && addr < r.address + size;
    });
  }

  _vector() {
    return {
      getHoldingRegister: (addr) => this.holdingRegisters[addr] || 0,
      getInputRegister: (addr) => this.inputRegisters[addr] || 0,
      getCoil: (addr) => this.coils[addr] === 1,
      getDiscreteInput: (addr) => this.discreteInputs[addr] === 1,

      setRegister: (addr, value, unitID) => {
        this.holdingRegisters[addr] = value & 0xffff;
        this._emitWrite('holding', addr, value, unitID);
      },
      setCoil: (addr, value, unitID) => {
        this.coils[addr] = value ? 1 : 0;
        this._emitWrite('coil', addr, value, unitID);
      },
    };
  }

  _emitWrite(regType, addr, value, unitID) {
    const regDef = this._findRegDef(regType, addr);
    logger.logDevMessage(`[ModbusSlave] - Внешний Master записал ${regType}[${addr}] = ${value} (unitID=${unitID})`);
    this.emit('write', {
      unitID,
      type: regType,
      address: addr,
      value,
      name: regDef ? regDef.name : undefined,
      dID: regDef?.dID ?? this.config.dID,
    });
  }

  // ServerSerial из modbus-serial не проверяет CRC входящих запросов: он пересчитывает его
  // и записывает поверх присланного, поэтому искажённый помехой кадр выполнялся бы как верный.
  // Встаём перед его обработчиком кадров ('data' потока-нарезчика ServerSerial._server):
  // кадр с неверным CRC отбрасывается без ответа (так требует Modbus RTU — Master
  // получит таймаут и повторит запрос). Если внутреннее устройство ServerSerial
  // изменилось (обновление библиотеки), лучше не стартовать, чем молча работать без проверки.
  _installCrcCheck() {
    const pipe = this.server && this.server._server;
    const listeners = pipe && typeof pipe.listeners === 'function' ? pipe.listeners('data') : [];
    if (listeners.length !== 1) {
      throw new Error(
        '[ModbusSlave] Не удалось включить проверку CRC: неожиданное устройство ServerSerial ' +
        '(проверьте версию modbus-serial или отключите проверку crcCheck: false)'
      );
    }
    const original = listeners[0];
    pipe.removeListener('data', original);
    pipe.on('data', (frame) => {
      this.stats.frames++;
      if (!isValidRtuFrame(frame)) {
        this.stats.crcErrors++;
        logger.logDevMessage(`[ModbusSlave] - отброшен кадр с неверным CRC (${frame.length} байт): ${frame.toString('hex')}`);
        if (this.listenerCount('crcError') > 0) this.emit('crcError', { frame: Buffer.from(frame) });
        return;
      }
      original.call(pipe, frame);
    });
  }

  // modbus-serial (ServerSerial) сообщает о готовности событием 'initialized',
  // а ошибку открытия порта передаёт только в openCallback — без него start() висел бы вечно.
  start() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      try {
        // Параметры порта — как у Master: без parity/dataBits/stopBits Slave на шине 8E1/8N2 не понимал Master
        this.server = new ModbusRTU.ServerSerial(this._vector(), {
          path: this.config.port,
          baudRate: this.config.baudRate || 9600,
          parity: this.config.parity || 'none',
          unitID: this.unitID,
          debug: !!this.config.debug,
          openCallback: (err) => {
            if (!err) return;
            logger.logErrorMessage(`[ModbusSlave] - Не удалось открыть ${this.config.port}: ${err.message}`);
            done(err);
          },
        }, {
          dataBits: this.config.dataBits || 8,
          stopBits: this.config.stopBits || 1,
        });
        if (this.crcCheck) this._installCrcCheck();
      } catch (err) {
        // порт мог уже начать открываться — не оставляем его занятым
        if (this.server && typeof this.server.close === 'function') {
          try { this.server.close(() => {}); } catch { /* уже закрыт */ }
        }
        this.server = null;
        return done(err);
      }

      this.server.on('initialized', () => {
        logger.logInfoMessage(
          `[ModbusSlave] - Slave-сервер запущен на ${this.config.port}, unitID=${this.unitID}`
        );
        done();
      });

      const onError = (err) => {
        logger.logErrorMessage(`[ModbusSlave] - Ошибка Slave-сервера: ${err.message}`);
        // emit('error') без подписчиков роняет процесс — пробрасываем, только если кто-то слушает
        if (this.listenerCount('error') > 0) this.emit('error', err);
      };
      this.server.on('error', onError);
      this.server.on('socketError', onError);
    });
  }

  /**
   * Обновление значения регистра "снаружи" - например, показание GPIO-датчика
   * или значение из БД, которое должен видеть внешний Modbus Master при опросе.
   * @param {object} regDef - описание регистра из registerMap ({type, address, dataType, scale, swapWords})
   * @param {number|boolean} value
   */
  setValue(regDef, value) {
    switch (regDef.type) {
      case 'holding': {
        const regs = encodeToRegisters(value, regDef.dataType, {
          swapWords: regDef.swapWords,
          scale: regDef.scale,
        });
        regs.forEach((r, i) => {
          this.holdingRegisters[regDef.address + i] = r;
        });
        break;
      }
      case 'input': {
        const regs = encodeToRegisters(value, regDef.dataType, {
          swapWords: regDef.swapWords,
          scale: regDef.scale,
        });
        regs.forEach((r, i) => {
          this.inputRegisters[regDef.address + i] = r;
        });
        break;
      }
      case 'coil':
        this.coils[regDef.address] = value ? 1 : 0;
        break;
      case 'discrete':
        this.discreteInputs[regDef.address] = value ? 1 : 0;
        break;
      default:
        throw new Error(`[ModbusSlave] Неизвестный тип регистра: ${regDef.type}`);
    }
  }

  /**
   * Текущее значение тега так, как его видит внешний Master: с учётом dataType, scale и swapWords.
   * @param {object} regDef - описание регистра из registerMap
   */
  getValue(regDef) {
    switch (regDef.type) {
      case 'holding':
      case 'input': {
        const bank = regDef.type === 'holding' ? this.holdingRegisters : this.inputRegisters;
        const size = REGISTER_SIZE[regDef.dataType] || 1;
        const regs = Array.from(bank.subarray(regDef.address, regDef.address + size));
        return decodeRegisters(regs, regDef.dataType, { swapWords: regDef.swapWords, scale: regDef.scale });
      }
      case 'coil':
        return this.coils[regDef.address] === 1;
      case 'discrete':
        return this.discreteInputs[regDef.address] === 1;
      default:
        throw new Error(`[ModbusSlave] Неизвестный тип регистра: ${regDef.type}`);
    }
  }

  getValueByName(name) {
    const regDef = this.registerMap.find((r) => r.name === name);
    if (!regDef) throw new Error(`[ModbusSlave] Регистр с именем "${name}" не найден в registerMap`);
    return this.getValue(regDef);
  }

  /** Обновление значения по имени регистра из registerMap (удобнее, чем передавать regDef целиком) */
  setValueByName(name, value) {
    const regDef = this.registerMap.find((r) => r.name === name);
    if (!regDef) throw new Error(`[ModbusSlave] Регистр с именем "${name}" не найден в registerMap`);
    this.setValue(regDef, value);
  }

  close() {
    if (this.server) {
      this.server.close(() => {
        logger.logInfoMessage('[ModbusSlave] - Slave-сервер остановлен');
      });
    }
  }
}

module.exports = ModbusSlaveServer;
