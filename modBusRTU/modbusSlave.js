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

const EventEmitter = require('events');
const ModbusRTU = require('modbus-serial');
const { encodeToRegisters } = require('./modbusUtils.js');
const logger = require('../logger.js');

class ModbusSlaveServer extends EventEmitter {
  /**
   * @param {object} config
   * @param {string} config.port - путь к серийному порту, например '/dev/ttyUSB0'
   * @param {number} [config.baudRate=9600]
   * @param {number} [config.unitID=1] - Modbus-адрес этого устройства (slave id)
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
    this.unitID = config.unitId || 21;
    this.registerMap = config.registerMap || [];

    this.holdingRegisters = new Uint16Array(config.holdingRegistersSize || 100);
    this.inputRegisters = new Uint16Array(config.inputRegistersSize || 100);
    this.coils = new Uint8Array(config.coilsSize || 100);
    this.discreteInputs = new Uint8Array(config.discreteInputsSize || 100);

    this.server = null;

    // Применяем начальные значения из конфига, если заданы
    this.registerMap.forEach((reg) => {
      if (reg.initial !== undefined) {
        this.setValue(reg, reg.initial);
      }
    });
  }

  _findRegDef(type, addr) {
    return this.registerMap.find((r) => r.type === type && r.address === addr);
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
      dID: regDef ? regDef.dID : this.config.dID,
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      try {
        this.server = new ModbusRTU.ServerSerial(this._vector(), {
          path: this.config.port,
          baudRate: this.config.baudRate || 9600,
          unitID: this.unitId,
          debug: !!this.config.debug,
        });
      } catch (err) {
        return reject(err);
      }

      this.server.on('open', () => {
        logger.logInfoMessage(
          `[ModbusSlave] - Slave-сервер запущен на ${this.config.port}, unitID=${this.unitId}`
        );
        resolve();
      });

      this.server.on('error', (err) => {
        logger.logErrorMessage(`[ModbusSlave] - Ошибка Slave-сервера: ${err.message}`);
        this.emit('error', err);
      });
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
