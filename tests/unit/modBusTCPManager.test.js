// tests/unit/modBusTCPManager.test.js
// Юнит-тесты класса ModbusManager/ModbusDevice (classes/modBusTCPManager.js).
// Вместо мока net-сокетов поднимается настоящий TCP-слейв (ModbusSlaveMock),
// это даёт уверенность, что реальный протокол (MBAP-заголовок, таймауты,
// исключения, переподключение) действительно работает, а не просто
// "мок ответил, что мы ожидали".

'use strict';

const { ModbusManager } = require('../../classes/modBusTCPManager');
const ModbusSlaveMock = require('../helpers/modbusSlaveMock');
const { waitEvent } = require('../helpers/async');

describe('ModbusManager + ModbusDevice (реальный TCP-сокет к мок-слейву)', () => {
  let slave;
  let manager;
  let port;

  beforeEach(async () => {
    slave = new ModbusSlaveMock();
    port = await slave.start();
    manager = new ModbusManager();
  });

  afterEach(async () => {
    manager.cleanup();
    await slave.stop();
  });

  test('устанавливает соединение и читает holding-регистры', async () => {
    slave.setHoldingRegisters(100, [10, 20, 30]);
    const device = manager.addDevice('dev1', { host: '127.0.0.1', port, unitId: 1, timeout: 500 });

    await waitEvent(manager, 'connect');
    expect(device.connected).toBe(true);

    const values = await device.readHoldingRegisters(100, 3);
    expect(values).toEqual([10, 20, 30]);
  });

  test('writeSingleRegister записывает значение на слейв', async () => {
    const device = manager.addDevice('dev2', { host: '127.0.0.1', port, unitId: 1, timeout: 500 });
    await waitEvent(manager, 'connect');

    await device.writeSingleRegister(50, 777);
    expect(slave.getHoldingRegisters(50, 1)).toEqual([777]);
  });

  test('writeMultipleRegisters записывает несколько значений подряд', async () => {
    const device = manager.addDevice('dev3', { host: '127.0.0.1', port, unitId: 1, timeout: 500 });
    await waitEvent(manager, 'connect');

    await device.writeMultipleRegisters(60, [1, 2, 3, 4]);
    expect(slave.getHoldingRegisters(60, 4)).toEqual([1, 2, 3, 4]);
  });

  test('modbus-исключение от слейва отражается ошибкой с кодом EEXCEPTION', async () => {
    const device = manager.addDevice('dev4', { host: '127.0.0.1', port, unitId: 1, timeout: 500 });
    await waitEvent(manager, 'connect');

    slave.exceptionOnce = { fc: 0x03, code: 2 }; // ILLEGAL_DATA_ADDRESS
    await expect(device.readHoldingRegisters(0, 1)).rejects.toMatchObject({
      name: 'ModbusError',
      code: 'EEXCEPTION',
      exceptionCode: 2
    });
  });

  test('при отсутствии ответа от слейва падает по таймауту (ETIMEOUT)', async () => {
    const device = manager.addDevice('dev5', { host: '127.0.0.1', port, unitId: 1, timeout: 300 });
    await waitEvent(manager, 'connect');

    slave.silentCount = 1; // слейв "молчит" на один запрос
    await expect(device.readHoldingRegisters(0, 1)).rejects.toMatchObject({
      name: 'ModbusError',
      code: 'ETIMEOUT'
    });
  });

  test('переподключается после разрыва соединения', async () => {
    const device = manager.addDevice('dev6', {
      host: '127.0.0.1', port, unitId: 1, timeout: 300, reconnectMin: 100, reconnectMax: 300
    });
    await waitEvent(manager, 'connect');
    expect(device.connected).toBe(true);

    await slave.stop();
    await waitEvent(manager, 'disconnect');
    expect(device.connected).toBe(false);

    // поднимаем слейв заново на том же порту - устройство должно само вернуться
    slave = new ModbusSlaveMock();
    await slave.start(port);

    await waitEvent(manager, 'connect', 3000);
    expect(device.connected).toBe(true);
  }, 10000);

  test('getAllStatus отражает состояние подключённых устройств', async () => {
    manager.addDevice('dev7', { host: '127.0.0.1', port, unitId: 1, timeout: 500 });
    await waitEvent(manager, 'connect');

    const status = manager.getAllStatus();
    expect(status).toEqual([
      expect.objectContaining({ id: 'dev7', host: '127.0.0.1', port, connected: true })
    ]);
  });
});
