// tests/integration/modbusPipeline.integration.js
// Интеграционный тест всей цепочки:
//   Modbus slave (реальный TCP) --poll--> modBusTCPManager --decode--> modbusTCPBridge
//     --> broadcast(...) "к VUE"  и  addMessageToQueue(...) "в очередь сохранения"
//   VUE 'post' --> modbusBridge.handleCommand --> encode --> запись в слейв --> подтверждение
//
// messageStore и wsManager подменены моками: нас интересует именно связка
// Modbus <-> мост <-> то, что должно уйти в пользовательское приложение,
// а не внутренняя кухня очереди сообщений и доставки по WebSocket.
//
// Очистка истории вызовов jest.fn() между тестами выполняется глобальным
// beforeEach(() => jest.clearAllMocks()) из tests/setup.js - отдельно её
// здесь не дублируем.

'use strict';

jest.mock('../../services/messageStore.js', () => ({
  addMessageToQueue: jest.fn()
}));
jest.mock('../../classes/wsManager.js', () => ({
  sendToConnection: jest.fn()
}));

const fs = require('fs');
const modbusManager = require('../../classes/modBusTCPManager');
const modbusBridge = require('../../services/modbusTCPBridge.js');
const { addMessageToQueue } = require('../../services/messageStore.js');
const wsManager = require('../../classes/wsManager.js');
const ModbusSlaveMock = require('../helpers/modbusSlaveMock');
const { waitFor } = require('../helpers/async');

const DEVICE_ID = 'testdev';
const DID = 'poddy_test';

describe('Modbus TCP -> modbusTCPBridge -> VUE (сквозной сценарий через реальный сокет)', () => {
  let slave;
  let port;
  let broadcast;

  beforeAll(async () => {
    slave = new ModbusSlaveMock();
    port = await slave.start();

    modbusManager.addDevice(DEVICE_ID, { host: '127.0.0.1', port, unitId: 1, timeout: 500 });
    await waitFor(() => modbusManager.isConnected(DEVICE_ID));

    const map = {
      pollInterval: 100,
      republishMs: 60000,
      tags: [
        {
          deviceId: DEVICE_ID, dID: DID, room: 'room1',
          request: 'sensors', item_name: 'dTemp1', item_type: 'dTemp',
          table: 'holding', address: 100, dataType: 'int16',
          scale: 0.1, decimals: 1, deadband: 0.05
        },
        {
          deviceId: DEVICE_ID, dID: DID, room: 'room1',
          request: 'actuators', item_name: 'dValve1', item_type: 'dActuator',
          table: 'holding', address: 110, dataType: 'uint16',
          writable: true
        }
      ]
    };
    fs.readFileSync.mockReturnValue(JSON.stringify(map));

    broadcast = jest.fn();
    modbusBridge.init({ broadcast, mapFile: '/any/path/modbusMap.json' });

    // дожидаемся, пока оба тега пройдут первый опрос (первое чтение всегда
    // публикуется, независимо от deadband) - это признак того, что конвейер жив
    await waitFor(() => addMessageToQueue.mock.calls.length >= 2);
  });

  afterAll(async () => {
    modbusBridge.stop();
    modbusManager.cleanup();
    await slave.stop();
  });

  test('значение с устройства доходит до VUE как post-сообщение с декодированным значением', async () => {
    slave.setHoldingRegisters(100, [215]); // int16 * scale 0.1 -> 21.5

    await waitFor(() => broadcast.mock.calls.some(
      (c) => c[2]?.payload?.item_name === 'dTemp1' && c[2].payload.item_value === 21.5
    ));

    const call = broadcast.mock.calls.find((c) => c[2]?.payload?.item_name === 'dTemp1');
    const [senderId, dID, message] = call;

    expect(senderId).toBe('modbus-bridge');
    expect(dID).toBe(DID);
    expect(message).toMatchObject({
      type: 'post',
      request: 'sensors',
      name: DID,
      payload: {
        room: 'room1',
        item_name: 'dTemp1',
        item_value: 21.5,
        item_type: 'dTemp'
      }
    });

    expect(addMessageToQueue).toHaveBeenCalledWith(DID, expect.objectContaining({
      payload: expect.objectContaining({ item_name: 'dTemp1', item_value: 21.5 })
    }));
  });

  test('повторный опрос без изменения значения не шлёт лишних сообщений клиентам (deadband)', async () => {
    slave.setHoldingRegisters(100, [215]); // то же самое значение, что уже было опубликовано
    await new Promise((r) => setTimeout(r, 350)); // 3+ цикла опроса по 100мс

    const tempCalls = broadcast.mock.calls.filter((c) => c[2]?.payload?.item_name === 'dTemp1');
    expect(tempCalls.length).toBe(0);
  });

  test('изменение значения на устройстве доходит до VUE при следующем опросе', async () => {
    slave.setHoldingRegisters(100, [180]); // 18.0 °C

    await waitFor(() => broadcast.mock.calls.some(
      (c) => c[2]?.payload?.item_name === 'dTemp1' && c[2].payload.item_value === 18
    ));
  });

  test('команда от VUE пишется в устройство и подтверждается рассылкой', async () => {
    const command = {
      type: 'post', request: 'actuators', name: DID,
      payload: { room: 'room1', item_name: 'dValve1', item_value: 42 }
    };

    const handled = modbusBridge.handleCommand('vue-client-1', command);
    expect(handled).toBe(true); // мост "забрал" команду - в NodeRED её пересылать не нужно

    await waitFor(() => slave.getHoldingRegisters(110, 1)[0] === 42);
    await waitFor(() => broadcast.mock.calls.some(
      (c) => c[2]?.payload?.item_name === 'dValve1' && c[2].payload.item_value === 42
    ));
  });

  test('запись в тег "только для чтения" отклоняется, клиенту уходит ошибка', async () => {
    const command = {
      type: 'post', request: 'sensors', name: DID,
      payload: { room: 'room1', item_name: 'dTemp1', item_value: 99 }
    };

    const handled = modbusBridge.handleCommand('vue-client-1', command);
    expect(handled).toBe(true);

    expect(wsManager.sendToConnection).toHaveBeenCalledWith(
      'VUE_connections', 'vue-client-1', 'error', 'modbusWriteError', DID,
      expect.objectContaining({ item_name: 'dTemp1', code: 'READ_ONLY' })
    );
  });

  test('команда к неизвестному тегу не перехватывается мостом (уйдёт в NodeRED как обычно)', () => {
    const command = {
      type: 'post', request: 'sensors', name: DID,
      payload: { room: 'roomX', item_name: 'unknownItem', item_value: 1 }
    };
    expect(modbusBridge.handleCommand('vue-client-1', command)).toBe(false);
  });
});
