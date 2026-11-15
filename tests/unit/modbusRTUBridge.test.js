// tests/unit/modbusRTUBridge.test.js
// Мост Modbus RTU: ModbusManager подменён фейком, порты не открываются.
'use strict';

jest.mock('../../services/messageStore.js', () => ({ addMessageToQueue: jest.fn() }));
jest.mock('../../classes/wsManager', () => ({ sendToConnection: jest.fn() }));

const { createModbusRtuBridge } = require('../../services/modbusRTUBridge');

const CONFIG = {
  role: 'both',
  master: { port: '/dev/ttyS3', devices: [
    { dID: 'boiler', room: 'boiler_room', slaveId: 1, registers: [
      { name: 'temp', type: 'holding', address: 0, dataType: 'int16', scale: 0.1, deadband: 0.2 },
      { name: 'pump', type: 'coil', address: 0, dataType: 'bool', writable: true, request: 'system' },
      { name: 'sp', type: 'holding', address: 1, dataType: 'int16', writable: true, request: 'setpoints', room: 'room01' },
      { name: 'flow', type: 'input', address: 2, dataType: 'float32', writable: true },
    ] },
    { dID: '../evil', slaveId: 2, registers: [{ name: 'x', type: 'holding', address: 0, dataType: 'int16' }] },
  ] },
  slave: { port: '/dev/ttyUSB0', dID: 'gate', registerMap: [
    { name: 'setpoint_temp', type: 'holding', address: 0, dataType: 'int16', scale: 0.1 },
  ] },
};

function setup({ config = CONFIG } = {}) {
  let t = 1_000_000;
  const handlers = {};
  const manager = {
    config: JSON.parse(JSON.stringify(config)),
    master: {},
    slave: { getValueByName: jest.fn(() => 23.5) },
    start: jest.fn(async (h) => Object.assign(handlers, h)),
    writeToDevice: jest.fn(async () => {}),
    updateSlaveValueByName: jest.fn(),
    close: jest.fn(),
  };
  const queue = jest.fn();
  const ws = { sendToConnection: jest.fn() };
  const broadcast = jest.fn();
  const bridge = createModbusRtuBridge({
    loadManager: () => jest.fn(() => manager),
    queue,
    ws,
    now: () => t,
  });
  return { bridge, manager, handlers, queue, ws, broadcast, tick: (ms) => { t += ms; } };
}

const data = (dID, item, value) => ({ dID, type: 'post', request: 'modbusUpdate', payload: { room: 'r', item_name: item, item_value: value } });
const flush = () => new Promise((r) => setImmediate(r));

describe('modbusRTUBridge', () => {
  test('init индексирует теги, пропускает недопустимый dID и запускает менеджер', async () => {
    const { bridge, manager, broadcast } = setup();
    await expect(bridge.init({ broadcast, confPath: '/x/modbusConf.json' })).resolves.toEqual({ master: 4, slave: 1 });
    expect(manager.start).toHaveBeenCalledWith(expect.objectContaining({
      onData: expect.any(Function), onSlaveWrite: expect.any(Function), onDeviceError: expect.any(Function),
    }));
  });

  test('значение опроса уходит в очередь и клиентам в формате NodeRED; повтор без изменения — нет', async () => {
    const { bridge, handlers, queue, broadcast, tick } = setup();
    await bridge.init({ broadcast });

    handlers.onData(data('boiler', 'temp', 21.5));
    expect(queue).toHaveBeenCalledWith('boiler', {
      type: 'post', request: 'sensors', name: 'boiler',
      payload: { room: 'boiler_room', item_name: 'temp', item_value: 21.5, item_type: 'num', title: '', group: '' },
    });
    expect(broadcast).toHaveBeenCalledWith('modbus-rtu-bridge', 'boiler', expect.objectContaining({ request: 'sensors' }));

    handlers.onData(data('boiler', 'temp', 21.6)); // в пределах deadband 0.2
    expect(broadcast).toHaveBeenCalledTimes(1);
    handlers.onData(data('boiler', 'temp', 22));
    expect(broadcast).toHaveBeenCalledTimes(2);

    tick(60_000); // повторная запись в файл без рассылки
    handlers.onData(data('boiler', 'temp', 22));
    expect(queue).toHaveBeenCalledTimes(3);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  test('логическое значение публикуется с типом bool, неизвестный тег игнорируется', async () => {
    const { bridge, handlers, queue, broadcast } = setup();
    await bridge.init({ broadcast });
    handlers.onData(data('boiler', 'pump', true));
    handlers.onData(data('boiler', 'nope', 1));
    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0][1]).toMatchObject({ request: 'system', payload: { item_type: 'bool', item_value: true } });
  });

  test('команда Vue на записываемый тег пишется в устройство и подтверждается', async () => {
    const { bridge, manager, broadcast } = setup();
    await bridge.init({ broadcast });

    const handled = bridge.handleCommand('c1', { type: 'post', request: 'system', name: 'boiler',
      payload: { room: 'boiler_room', item_name: 'pump', value: 'true' } });
    expect(handled).toBe(true);
    await flush();
    expect(manager.writeToDevice).toHaveBeenCalledWith('boiler', 'pump', true);
    expect(broadcast).toHaveBeenCalledWith('modbus-rtu-bridge', 'boiler', expect.objectContaining({
      payload: expect.objectContaining({ item_name: 'pump', item_value: true }),
    }));
  });

  test('уставка находится по setKey, как у моста TCP', async () => {
    const { bridge, manager, broadcast } = setup();
    await bridge.init({ broadcast });
    expect(bridge.handleCommand('c1', { type: 'post', request: 'setpoints', name: 'boiler',
      payload: { room: 'room01', setKey: 'sp', value: 21 } })).toBe(true);
    await flush();
    expect(manager.writeToDevice).toHaveBeenCalledWith('boiler', 'sp', 21);
  });

  test('тег без writable и таблица input — READ_ONLY; чужая команда не перехватывается', async () => {
    const { bridge, manager, ws, broadcast } = setup();
    await bridge.init({ broadcast });

    for (const item of ['temp', 'flow']) {
      expect(bridge.handleCommand('c1', { type: 'post', request: 'sensors', name: 'boiler',
        payload: { room: 'boiler_room', item_name: item, value: 1 } })).toBe(true);
    }
    expect(ws.sendToConnection).toHaveBeenCalledTimes(2);
    expect(ws.sendToConnection.mock.calls[0][5]).toMatchObject({ code: 'READ_ONLY' });
    expect(manager.writeToDevice).not.toHaveBeenCalled();

    expect(bridge.handleCommand('c1', { type: 'post', request: 'sensors', name: 'boiler',
      payload: { room: 'other', item_name: 'temp', value: 1 } })).toBe(false);
  });

  test('ошибка записи уходит клиенту без внутренних деталей', async () => {
    const { bridge, manager, ws, broadcast } = setup();
    await bridge.init({ broadcast });
    manager.writeToDevice.mockRejectedValueOnce(new Error('Timed out /dev/ttyS3'));
    bridge.handleCommand('c1', { type: 'post', request: 'system', name: 'boiler',
      payload: { room: 'boiler_room', item_name: 'pump', value: 1 } });
    await flush();
    expect(ws.sendToConnection).toHaveBeenCalledWith('VUE_connections', 'c1', 'error', 'modbusWriteError', 'boiler',
      expect.objectContaining({ code: 'MODBUS_ERROR', message: 'Не удалось записать значение в устройство' }));
  });

  test('запись внешнего Master в Slave публикуется декодированным значением тега', async () => {
    const { bridge, manager, handlers, queue, broadcast } = setup();
    await bridge.init({ broadcast });
    handlers.onSlaveWrite({ type: 'holding', address: 0, value: 235, name: 'setpoint_temp', dID: 'gate' });
    expect(manager.slave.getValueByName).toHaveBeenCalledWith('setpoint_temp');
    expect(queue).toHaveBeenCalledWith('gate', expect.objectContaining({
      request: 'system', payload: expect.objectContaining({ item_name: 'setpoint_temp', item_value: 23.5 }),
    }));
  });

  test('без роли master команды не перехватываются; stop закрывает менеджер', async () => {
    const { bridge, manager, broadcast } = setup();
    await bridge.init({ broadcast });
    manager.master = null;
    expect(bridge.handleCommand('c1', { type: 'post', request: 'system', name: 'boiler',
      payload: { room: 'boiler_room', item_name: 'pump', value: 1 } })).toBe(false);
    bridge.stop();
    expect(manager.close).toHaveBeenCalled();
  });
});
