// tests/modbus/modbusSlave.test.js
/**
 * Тесты для modbus/modbusSlave.js
 *
 * Покрывают:
 *  - Конструктор и инициализацию регистров из registerMap
 *  - Внутренний _vector() (get/set для holding/input/coil/discrete)
 *  - Событие 'write' при внешней записи
 *  - setValue / setValueByName
 *  - start() / close() (с моком modbus-serial)
 *  - Обработку ошибок конфигурации
 */

// Мокаем modbus-serial ДО импорта модуля
jest.mock('modbus-serial', () => {
  const EventEmitter = require('events');

  class MockServerSerial extends EventEmitter {
    constructor(vector, options) {
      super();
      this.vector = vector;
      this.options = options;
      this._closed = false;
      MockServerSerial.instances.push(this);
    }

    close(cb) {
      this._closed = true;
      if (typeof cb === 'function') cb();
    }
  }
  MockServerSerial.instances = [];

  return {
    ServerSerial: MockServerSerial,
  };
});

// Мокаем modbusUtils: encodeToRegisters — простая детерминированная реализация
jest.mock('../../modBus/modbusUtils', () => ({
  encodeToRegisters: jest.fn((value, dataType, opts = {}) => {
    const scale = opts.scale || 1;
    const scaled = Math.round(Number(value) / scale);
    if (dataType === 'int32' || dataType === 'uint32' || dataType === 'float') {
      // Возвращаем 2 регистра
      return [scaled & 0xffff, (scaled >> 16) & 0xffff];
    }
    // int16 / uint16 / bool — один регистр
    return [scaled & 0xffff];
  }),
}));

const ModbusRTU = require('modbus-serial');
const { encodeToRegisters } = require('../../modBus/modbusUtils');
const ModbusSlaveServer = require('../../modBus/modbusSlave');
const logger = require('../../services/logger.js');

describe('modbusSlave.js - ModbusSlaveServer', () => {
  const baseConfig = () => ({
    port: '/dev/ttyUSB0',
    baudRate: 9600,
    unitId: 10,
    dID: 'orangepi_gate',
    holdingRegistersSize: 100,
    inputRegistersSize: 100,
    coilsSize: 100,
    discreteInputsSize: 100,
    registerMap: [
      { name: 'door_sensor', type: 'discrete', address: 0, dataType: 'bool', dID: 'orangepi_gate', initial: false },
      { name: 'lock_sensor', type: 'discrete', address: 1, dataType: 'bool', dID: 'orangepi_gate', initial: false },
      { name: 'setpoint_temp', type: 'holding', address: 0, dataType: 'int16', scale: 0.1, dID: 'orangepi_gate', initial: 220 },
      { name: 'open_gate', type: 'coil', address: 0, dataType: 'bool', dID: 'orangepi_gate', initial: false },
    ],
  });

  beforeEach(() => {
    jest.clearAllMocks();
    ModbusRTU.ServerSerial.instances.length = 0;
  });

  describe('Конструктор', () => {
    test('Должен выбрасывать ошибку, если не передан config.port', () => {
      expect(() => new ModbusSlaveServer({})).toThrow('[ModbusSlave] Не указан config.port');
      expect(() => new ModbusSlaveServer()).toThrow('[ModbusSlave] Не указан config.port');
    });

    test('Должен корректно инициализировать размеры буферов', () => {
      const cfg = baseConfig();
      const slave = new ModbusSlaveServer(cfg);

      expect(slave.holdingRegisters.length).toBe(100);
      expect(slave.inputRegisters.length).toBe(100);
      expect(slave.coils.length).toBe(100);
      expect(slave.discreteInputs.length).toBe(100);
    });

    test('Должен использовать размеры по умолчанию (100), если не заданы', () => {
      const cfg = { port: '/dev/ttyUSB0', registerMap: [] };
      const slave = new ModbusSlaveServer(cfg);

      expect(slave.holdingRegisters.length).toBe(100);
      expect(slave.inputRegisters.length).toBe(100);
      expect(slave.coils.length).toBe(100);
      expect(slave.discreteInputs.length).toBe(100);
    });

    test('Должен применить unitId из конфига (по умолчанию 1)', () => {
      const cfg1 = { port: '/dev/ttyUSB0', registerMap: [] };
      const slave1 = new ModbusSlaveServer(cfg1);
      expect(slave1.unitID).toBe(1);

      const cfg2 = { port: '/dev/ttyUSB0', unitId: 42, registerMap: [] };
      const slave2 = new ModbusSlaveServer(cfg2);
      expect(slave2.unitID).toBe(42);
    });

    test('Должен применить initial-значения из registerMap', () => {
      const cfg = baseConfig();
      new ModbusSlaveServer(cfg);

      // encodeToRegisters вызывается для holding c initial=220 и scale=0.1
      expect(encodeToRegisters).toHaveBeenCalledWith(
        220,
        'int16',
        expect.objectContaining({ scale: 0.1 })
      );
    });

    test('Должен корректно сохранить registerMap и dID', () => {
      const cfg = baseConfig();
      const slave = new ModbusSlaveServer(cfg);

      expect(slave.registerMap).toEqual(cfg.registerMap);
      // dID не сохраняется отдельно, но используется через config.dID
      expect(slave.config.dID).toBe('orangepi_gate');
    });
  });

  describe('_findRegDef()', () => {
    test('Должен находить регистр по типу и адресу', () => {
      const slave = new ModbusSlaveServer(baseConfig());

      const reg = slave._findRegDef('holding', 0);
      expect(reg).toBeDefined();
      expect(reg.name).toBe('setpoint_temp');

      const coil = slave._findRegDef('coil', 0);
      expect(coil).toBeDefined();
      expect(coil.name).toBe('open_gate');

      const disc = slave._findRegDef('discrete', 1);
      expect(disc).toBeDefined();
      expect(disc.name).toBe('lock_sensor');
    });

    test('Должен возвращать undefined для отсутствующего регистра', () => {
      const slave = new ModbusSlaveServer(baseConfig());
      expect(slave._findRegDef('holding', 99)).toBeUndefined();
      expect(slave._findRegDef('coil', 99)).toBeUndefined();
    });
  });

  describe('_vector()', () => {
    let slave;
    let vector;

    beforeEach(() => {
      slave = new ModbusSlaveServer(baseConfig());
      vector = slave._vector();
    });

    test('getHoldingRegister возвращает 0 для пустого регистра', () => {
      expect(vector.getHoldingRegister(50)).toBe(0);
    });

    test('getInputRegister возвращает 0 для пустого регистра', () => {
      expect(vector.getInputRegister(50)).toBe(0);
    });

    test('getCoil возвращает false для пустого регистра', () => {
      expect(vector.getCoil(10)).toBe(false);
    });

    test('getDiscreteInput возвращает false для пустого регистра', () => {
      expect(vector.getDiscreteInput(10)).toBe(false);
    });

    test('setRegister записывает значение и эмитит write', () => {
      const writeSpy = jest.fn();
      slave.on('write', writeSpy);

      vector.setRegister(0, 1234, 10);

      expect(slave.holdingRegisters[0]).toBe(1234);
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          unitID: 10,
          type: 'holding',
          address: 0,
          value: 1234,
          name: 'setpoint_temp',
          dID: 'orangepi_gate',
        })
      );
    });

    test('setRegister маскирует значение до 0xffff', () => {
      vector.setRegister(0, 0x12345, 10);
      expect(slave.holdingRegisters[0]).toBe(0x2345);
    });

    test('setCoil записывает true/false и эмитит write', () => {
      const writeSpy = jest.fn();
      slave.on('write', writeSpy);

      vector.setCoil(0, true, 10);
      expect(slave.coils[0]).toBe(1);
      expect(writeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'coil', address: 0, value: true, name: 'open_gate' })
      );

      vector.setCoil(0, false, 10);
      expect(slave.coils[0]).toBe(0);
      expect(writeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'coil', address: 0, value: false })
      );
    });

    test('setCoil корректно реагирует на truthy/falsy значения', () => {
      vector.setCoil(0, 1, 10);
      expect(slave.coils[0]).toBe(1);

      vector.setCoil(0, 0, 10);
      expect(slave.coils[0]).toBe(0);

      vector.setCoil(0, 'yes', 10);
      expect(slave.coils[0]).toBe(1);
    });
  });

  describe('_emitWrite()', () => {
    test('Должен эмитить write с именем и dID из registerMap', () => {
      const slave = new ModbusSlaveServer(baseConfig());
      const writeSpy = jest.fn();
      slave.on('write', writeSpy);

      slave._emitWrite('holding', 0, 100, 10);

      expect(writeSpy).toHaveBeenCalledWith({
        unitID: 10,
        type: 'holding',
        address: 0,
        value: 100,
        name: 'setpoint_temp',
        dID: 'orangepi_gate',
      });

      expect(logger.logDevMessage).toHaveBeenCalledWith(
        expect.stringContaining('Внешний Master записал holding[0] = 100')
      );
    });

    test('Должен использовать config.dID, если регистр не найден', () => {
      const slave = new ModbusSlaveServer(baseConfig());
      const writeSpy = jest.fn();
      slave.on('write', writeSpy);

      slave._emitWrite('holding', 99, 1, 10);

      expect(writeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'holding',
          address: 99,
          value: 1,
          name: undefined,
          dID: 'orangepi_gate',
        })
      );
    });
  });

  describe('setValue()', () => {
    let slave;

    beforeEach(() => {
      slave = new ModbusSlaveServer(baseConfig());
    });

    test('setValue для holding записывает регистры через encodeToRegisters', () => {
      encodeToRegisters.mockReturnValueOnce([500]);
      slave.setValue({ type: 'holding', address: 5, dataType: 'int16', scale: 0.1 }, 50.0);

      expect(encodeToRegisters).toHaveBeenCalledWith(50.0, 'int16', {
        swapWords: undefined,
        scale: 0.1,
      });
      expect(slave.holdingRegisters[5]).toBe(500);
    });

    test('setValue для input записывает регистры', () => {
      encodeToRegisters.mockReturnValueOnce([777]);
      slave.setValue({ type: 'input', address: 3, dataType: 'uint16' }, 777);

      expect(slave.inputRegisters[3]).toBe(777);
    });

    test('setValue для coil записывает 0/1', () => {
      slave.setValue({ type: 'coil', address: 1 }, true);
      expect(slave.coils[1]).toBe(1);

      slave.setValue({ type: 'coil', address: 1 }, false);
      expect(slave.coils[1]).toBe(0);
    });

    test('setValue для discrete записывает 0/1', () => {
      slave.setValue({ type: 'discrete', address: 2 }, true);
      expect(slave.discreteInputs[2]).toBe(1);

      slave.setValue({ type: 'discrete', address: 2 }, false);
      expect(slave.discreteInputs[2]).toBe(0);
    });

    test('setValue для многорeгистрового типа записывает несколько регистров', () => {
      encodeToRegisters.mockReturnValueOnce([0x1234, 0x5678]);
      slave.setValue({ type: 'holding', address: 10, dataType: 'int32' }, 0x56781234);

      expect(slave.holdingRegisters[10]).toBe(0x1234);
      expect(slave.holdingRegisters[11]).toBe(0x5678);
    });

    test('setValue выбрасывает ошибку для неизвестного типа', () => {
      expect(() => slave.setValue({ type: 'unknown', address: 0 }, 1)).toThrow(
        '[ModbusSlave] Неизвестный тип регистра: unknown'
      );
    });
  });

  describe('setValueByName()', () => {
    let slave;

    beforeEach(() => {
      slave = new ModbusSlaveServer(baseConfig());
    });

    test('Должен найти регистр по имени и установить значение', () => {
      encodeToRegisters.mockReturnValueOnce([300]);
      slave.setValueByName('setpoint_temp', 30.0);

      expect(encodeToRegisters).toHaveBeenCalledWith(30.0, 'int16', expect.objectContaining({ scale: 0.1 }));
      expect(slave.holdingRegisters[0]).toBe(300);
    });

    test('Должен выбрасывать ошибку, если имя не найдено', () => {
      expect(() => slave.setValueByName('unknown_reg', 1)).toThrow(
        '[ModbusSlave] Регистр с именем "unknown_reg" не найден в registerMap'
      );
    });

    test('Должен корректно работать для coil по имени', () => {
      slave.setValueByName('open_gate', true);
      expect(slave.coils[0]).toBe(1);

      slave.setValueByName('open_gate', false);
      expect(slave.coils[0]).toBe(0);
    });

    test('Должен корректно работать для discrete по имени', () => {
      slave.setValueByName('door_sensor', true);
      expect(slave.discreteInputs[0]).toBe(1);
    });
  });

  describe('start()', () => {
    test('Должен создавать ServerSerial с правильными параметрами', async () => {
      const slave = new ModbusSlaveServer(baseConfig());

      const startPromise = slave.start();
      const instance = ModbusRTU.ServerSerial.instances[0];

      expect(instance).toBeDefined();
      expect(instance.options).toEqual({
        path: '/dev/ttyUSB0',
        baudRate: 9600,
        unitID: 10,
        debug: false,
      });

      instance.emit('open');
      await startPromise;

      expect(logger.logInfoMessage).toHaveBeenCalledWith(
        expect.stringContaining('Slave-сервер запущен на /dev/ttyUSB0, unitID=10')
      );
    });

    test('Должен использовать baudRate по умолчанию (9600), если не задан', async () => {
      const cfg = { port: '/dev/ttyUSB0', registerMap: [] };
      const slave = new ModbusSlaveServer(cfg);

      const startPromise = slave.start();
      const instance = ModbusRTU.ServerSerial.instances[0];

      expect(instance.options.baudRate).toBe(9600);

      instance.emit('open');
      await startPromise;
    });

    test('Должен пробрасывать debug-флаг из конфига', async () => {
      const cfg = { ...baseConfig(), debug: true };
      const slave = new ModbusSlaveServer(cfg);

      const startPromise = slave.start();
      const instance = ModbusRTU.ServerSerial.instances[0];

      expect(instance.options.debug).toBe(true);

      instance.emit('open');
      await startPromise;
    });

    test('Должен резолвить промис при событии open', async () => {
      const slave = new ModbusSlaveServer(baseConfig());
      const startPromise = slave.start();
      const instance = ModbusRTU.ServerSerial.instances[0];

      instance.emit('open');
      await expect(startPromise).resolves.toBeUndefined();
    });

    test('Должен эмитить error при ошибке сервера', async () => {
      const slave = new ModbusSlaveServer(baseConfig());
      const errorSpy = jest.fn();
      slave.on('error', errorSpy);

      const startPromise = slave.start();
      const instance = ModbusRTU.ServerSerial.instances[0];

      const err = new Error('Serial port error');
      instance.emit('error', err);

      expect(errorSpy).toHaveBeenCalledWith(err);
      expect(logger.logErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Ошибка Slave-сервера: Serial port error')
      );

      // Чтобы startPromise не остался висеть
      instance.emit('open');
      await startPromise;
    });

    test('Должен реджектить промис при ошибке конструктора ServerSerial', async () => {
      const ModbusRTU = require('modbus-serial');
      const original = ModbusRTU.ServerSerial;
      ModbusRTU.ServerSerial = jest.fn(() => {
        throw new Error('Не удалось открыть порт');
      });

      const slave = new ModbusSlaveServer(baseConfig());
      await expect(slave.start()).rejects.toThrow('Не удалось открыть порт');

      ModbusRTU.ServerSerial = original;
    });
  });

  describe('close()', () => {
    test('Должен вызывать close у сервера и логировать остановку', async () => {
      const slave = new ModbusSlaveServer(baseConfig());
      const startPromise = slave.start();
      const instance = ModbusRTU.ServerSerial.instances[0];
      instance.emit('open');
      await startPromise;

      slave.close();

      expect(instance._closed).toBe(true);
      expect(logger.logInfoMessage).toHaveBeenCalledWith(
        expect.stringContaining('Slave-сервер остановлен')
      );
    });

    test('Должен безопасно работать, если сервер ещё не запущен', () => {
      const slave = new ModbusSlaveServer(baseConfig());
      expect(() => slave.close()).not.toThrow();
    });
  });

  describe('Интеграционные сценарии', () => {
    test('Внешняя запись в holding → setValueByName → чтение через vector', async () => {
      const slave = new ModbusSlaveServer(baseConfig());
      const vector = slave._vector();
      const writes = [];
      slave.on('write', (data) => writes.push(data));

      // Внешний Master пишет в holding[0] значение 250
      vector.setRegister(0, 250, 10);

      expect(slave.holdingRegisters[0]).toBe(250);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toEqual(
        expect.objectContaining({ type: 'holding', address: 0, value: 250, name: 'setpoint_temp' })
      );

      // Теперь приложение (например, GPIO/БД) обновляет значение
      encodeToRegisters.mockReturnValueOnce([100]);
      slave.setValueByName('setpoint_temp', 10.0);

      expect(vector.getHoldingRegister(0)).toBe(100);
    });

    test('Внешняя запись в coil → приложение реагирует и обновляет discrete', () => {
      const slave = new ModbusSlaveServer(baseConfig());
      const vector = slave._vector();

      // Приложение "слушает" запись open_gate
      slave.on('write', (data) => {
        if (data.name === 'open_gate') {
          slave.setValueByName('door_sensor', data.value);
        }
      });

      vector.setCoil(0, true, 10);

      expect(slave.coils[0]).toBe(1);
      expect(slave.discreteInputs[0]).toBe(1);
      expect(vector.getDiscreteInput(0)).toBe(true);
    });

    test('Инициализация из registerMap: initial-значения видны через vector', () => {
      encodeToRegisters.mockImplementation((value, dataType, opts = {}) => {
        const scale = opts.scale || 1;
        return [Math.round(Number(value) / scale) & 0xffff];
      });

      const slave = new ModbusSlaveServer(baseConfig());
      const vector = slave._vector();

      // setpoint_temp.initial = 220, scale = 0.1 → 2200
      expect(vector.getHoldingRegister(0)).toBe(2200);
      expect(vector.getDiscreteInput(0)).toBe(false);
      expect(vector.getDiscreteInput(1)).toBe(false);
      expect(vector.getCoil(0)).toBe(false);
    });
  });
});