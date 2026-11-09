// modbus/modbusMaster.js
// Master (ведущее устройство) Modbus RTU: последовательно опрашивает заданный
// в конфиге список slave-устройств на шине и умеет писать в них по запросу.
//
// Важно: на одной физической шине RS-485 запросы должны идти СТРОГО последовательно
// (один запрос - дождались ответа/таймаута - следующий), поэтому опрос всех
// устройств и регистров реализован как последовательная асинхронная цепочка,
// а не через параллельные Promise.all().

const EventEmitter = require('events');
const ModbusRTU = require('modbus-serial');
const { REGISTER_SIZE, decodeRegisters, encodeToRegisters } = require('./modbusUtils');
const logger = require('../services/logger.js');

class ModbusMasterManager extends EventEmitter {
  /**
   * @param {object} config
   * @param {string} config.port - путь к серийному порту, например '/dev/ttyS3'
   * @param {number} [config.baudRate=9600]
   * @param {number} [config.dataBits=8]
   * @param {number} [config.stopBits=1]
   * @param {string} [config.parity='none']
   * @param {number} [config.pollIntervalMs=2000] - пауза между полными циклами опроса
   * @param {number} [config.requestTimeoutMs=300] - таймаут ожидания ответа slave
   * @param {number} [config.interRequestDelayMs=20] - пауза между отдельными запросами на шине
   * @param {Array}  config.devices - список опрашиваемых устройств (см. modbusConf.example.json)
   */
  constructor(config) {
    super();
    if (!config || !config.port) {
      throw new Error('[ModbusMaster] Не указан config.port для Master-подключения');
    }
    this.config = config;
    this.client = new ModbusRTU();
    this.connected = false;
    this.polling = false;
    this.stopped = false;
    this.pollIntervalMs = config.pollIntervalMs || 2000;
    this.requestTimeoutMs = config.requestTimeoutMs || 300;
    this.interRequestDelayMs = config.interRequestDelayMs ?? 20;
    this.devices = config.devices || [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.client.connectRTUBuffered(
        this.config.port,
        {
          baudRate: this.config.baudRate || 9600,
          dataBits: this.config.dataBits || 8,
          stopBits: this.config.stopBits || 1,
          parity: this.config.parity || 'none',
        },
        (err) => {
          if (err) {
            logger.logErrorMessage(`[ModbusMaster] - Ошибка открытия порта ${this.config.port}: ${err.message}`);
            return reject(err);
          }
          this.client.setTimeout(this.requestTimeoutMs);
          this.connected = true;
          logger.logInfoMessage(
            `[ModbusMaster] - Порт ${this.config.port} открыт (baudRate=${this.config.baudRate || 9600})`
          );
          resolve();
        }
      );
    });
  }

  start() {
    if (this.polling) return;
    this.polling = true;
    this.stopped = false;
    this._pollLoop();
  }

  stop() {
    this.stopped = true;
    this.polling = false;
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async _pollLoop() {
    if (this.stopped) return;

    for (const device of this.devices) {
      if (this.stopped) break;
      await this._pollDevice(device);
      await this._sleep(this.interRequestDelayMs);
    }

    if (!this.stopped) {
      setTimeout(() => this._pollLoop(), this.pollIntervalMs);
    }
  }

  async _pollDevice(device) {
    if (!this.connected) return;

    for (const reg of device.registers) {
      if (this.stopped) break;
      try {
        this.client.setID(device.slaveId);
        const value = await this._readRegister(reg);

        // Событие 'data' - на него подписывается serverapp.js и делает broadcast()
        // клиентам VUE (Dashboard) / NodeRED в том же формате, что и остальные
        // сообщения приложения (type/request/payload).
        this.emit('data', {
          dID: device.dID,
          type: 'post',
          request: 'modbusUpdate',
          payload: {
            room: device.room || device.dID,
            item_name: reg.name,
            item_value: value,
          },
        });
      } catch (regErr) {
        logger.logErrorMessage(
          `[ModbusMaster] - Ошибка чтения ${device.dID}.${reg.name} (slaveId=${device.slaveId}): ${regErr.message}`
        );
        this.emit('deviceError', {
          dID: device.dID,
          slaveId: device.slaveId,
          register: reg.name,
          error: regErr.message,
        });
      }
      await this._sleep(this.interRequestDelayMs);
    }
  }

  async _readRegister(reg) {
    const length = reg.length || REGISTER_SIZE[reg.dataType] || 1;
    let result;

    switch (reg.type) {
      case 'holding':
        result = await this.client.readHoldingRegisters(reg.address, length);
        return decodeRegisters(result.data, reg.dataType, {
          swapWords: reg.swapWords,
          scale: reg.scale,
        });
      case 'input':
        result = await this.client.readInputRegisters(reg.address, length);
        return decodeRegisters(result.data, reg.dataType, {
          swapWords: reg.swapWords,
          scale: reg.scale,
        });
      case 'coil':
        result = await this.client.readCoils(reg.address, length);
        return !!result.data[0];
      case 'discrete':
        result = await this.client.readDiscreteInputs(reg.address, length);
        return !!result.data[0];
      default:
        throw new Error(`Неизвестный тип регистра: ${reg.type}`);
    }
  }

  /**
   * Запись значения в регистр устройства по логическому имени (dID + registerName),
   * как это описано в modbusConf.json. Используется, например, когда Dashboard (VUE)
   * присылает команду на изменение уставки/включение реле физического Modbus-устройства.
   */
  async writeToDevice(dID, registerName, value) {
    const device = this.devices.find((d) => d.dID === dID);
    if (!device) throw new Error(`[ModbusMaster] Устройство с dID="${dID}" не найдено в конфигурации`);

    const reg = device.registers.find((r) => r.name === registerName);
    if (!reg) throw new Error(`[ModbusMaster] Регистр "${registerName}" не найден у устройства "${dID}"`);

    this.client.setID(device.slaveId);

    if (reg.type === 'coil') {
      await this.client.writeCoil(reg.address, !!value);
    } else if (reg.type === 'holding') {
      const regs = encodeToRegisters(value, reg.dataType, {
        swapWords: reg.swapWords,
        scale: reg.scale,
      });
      if (regs.length === 1) {
        await this.client.writeRegister(reg.address, regs[0]);
      } else {
        await this.client.writeRegisters(reg.address, regs);
      }
    } else {
      throw new Error(`[ModbusMaster] Регистр "${registerName}" (${reg.type}) доступен только для чтения`);
    }

    logger.logDevMessage(`[ModbusMaster] - Записано ${dID}.${registerName} = ${value}`);
  }

  close() {
    this.stop();
    if (this.client && this.connected) {
      try {
        this.client.close(() => {});
      } catch (e) {
        // порт мог уже быть закрыт - игнорируем
      }
      this.connected = false;
    }
  }
}

module.exports = ModbusMasterManager;
