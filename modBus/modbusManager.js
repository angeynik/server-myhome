// modbus/modbusManager.js
// Точка входа для работы с Modbus RTU из serverapp.js. Читает modbusConf.json,
// поднимает Master и/или Slave (в зависимости от config.role / env MODBUS_ROLE)
// и связывает их события с остальным приложением через переданные колбэки.
//
// ВАЖНО про режим "both" (Master + Slave одновременно):
// Modbus RTU - это half-duplex шина с ОДНИМ ведущим. Если Master и Slave配置
// указывают на один и тот же физический serial-порт, они будут конкурировать
// за устройство (порт открывается монопольно), а входящие байты одновременно
// будут пытаться разобрать и как "чужой запрос", и как "наш ответ" - это приведёт
// к постоянным ошибкам разбора кадров. Поэтому для роли "both" нужны ДВА разных
// физических интерфейса, например: встроенный UART (/dev/ttyS*) под одну роль
// и USB-RS485 переходник (/dev/ttyUSB0) под другую. Если вы всё же уверены,
// что хотите один порт на обе роли (нестандартный сценарий), выставьте
// в modbusConf.json "allowSharedPort": true - но это на ваш риск.

const fs = require('fs');
const ModbusMasterManager = require('./modbusMaster');
const ModbusSlaveServer = require('./modbusSlave');
const logger = require('../services/logger.js');

class ModbusManager {
  constructor(confPath) {
    this.confPath = confPath;
    this.config = JSON.parse(fs.readFileSync(confPath, 'utf8'));
    this.master = null;
    this.slave = null;
  }

  /**
   * @param {object} handlers
   * @param {(data: object) => void} [handlers.onData] - новые показания от Master (вызывается на каждое прочитанное значение)
   * @param {(err: object) => void} [handlers.onDeviceError] - ошибка опроса конкретного устройства/регистра
   * @param {(data: object) => void} [handlers.onSlaveWrite] - внешний Master записал что-то в наш Slave
   */
  async start({ onData, onDeviceError, onSlaveWrite } = {}) {
    const role = (process.env.MODBUS_ROLE || this.config.role || 'master').toLowerCase();
    logger.logInfoMessage(`[ModbusManager] - Запуск в роли: ${role}`);

    if (role === 'both') {
      const masterPort = this.config.master && this.config.master.port;
      const slavePort = this.config.slave && this.config.slave.port;
      if (masterPort && slavePort && masterPort === slavePort && !this.config.allowSharedPort) {
        throw new Error(
          `[ModbusManager] - Master и Slave настроены на один и тот же порт (${masterPort}). ` +
            'Для одновременной работы обеих ролей нужны два разных физических интерфейса RS-485 ' +
            '(например, встроенный UART + USB-RS485 переходник). Если это осознанный выбор, ' +
            'установите "allowSharedPort": true в modbusConf.json.'
        );
      }
    }

    if ((role === 'master' || role === 'both') && this.config.master) {
      this.master = new ModbusMasterManager(this.config.master);
      if (onData) this.master.on('data', onData);
      if (onDeviceError) this.master.on('deviceError', onDeviceError);
      await this.master.connect();
      this.master.start();
    }

    if ((role === 'slave' || role === 'both') && this.config.slave) {
      this.slave = new ModbusSlaveServer(this.config.slave);
      if (onSlaveWrite) this.slave.on('write', onSlaveWrite);
      await this.slave.start();
    }

    if (!this.master && !this.slave) {
      logger.logErrorMessage(
        `[ModbusManager] - Роль "${role}" требует секцию config.${role} в modbusConf.json, но она отсутствует`
      );
    }
  }

  /** Запись значения в устройство на шине, где мы выступаем Master'ом (dID + имя регистра из modbusConf.json) */
  async writeToDevice(dID, registerName, value) {
    if (!this.master) throw new Error('[ModbusManager] Modbus Master не активен (роль не включает master)');
    return this.master.writeToDevice(dID, registerName, value);
  }

  /** Обновить значение, которое видит внешний Master, опрашивающий нас как Slave */
  updateSlaveValueByName(name, value) {
    if (!this.slave) throw new Error('[ModbusManager] Modbus Slave не активен (роль не включает slave)');
    return this.slave.setValueByName(name, value);
  }

  close() {
    if (this.master) this.master.close();
    if (this.slave) this.slave.close();
  }
}

module.exports = ModbusManager;
