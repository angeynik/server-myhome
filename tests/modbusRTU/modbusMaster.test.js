// tests/modbusRTU/modbusMaster.test.js
// Modbus RTU Master: транзакции на шине (опрос и запись) не должны пересекаться.
'use strict';

jest.mock('../../services/logger.js', () => ({
  initLogging: jest.fn(),
  logInfoMessage: jest.fn(),
  logDevMessage: jest.fn(),
  logErrorMessage: jest.fn(),
}));

// Фейковый клиент modbus-serial: каждый запрос занимает время и отмечает,
// не идёт ли параллельно другой запрос (на RS-485 это столкновение кадров)
jest.mock('modbus-serial', () => {
  class FakeClient {
    constructor() {
      this.id = null;
      this.active = 0;
      this.maxActive = 0;
      this.log = [];
      this.regs = new Map();
      FakeClient.last = this;
    }
    setID(id) { this.id = id; }
    setTimeout() {}
    connectRTUBuffered(port, opts, cb) { cb(null); }
    close(cb) { if (cb) cb(); }
    async _op(name, fn) {
      this.active++;
      this.maxActive = Math.max(this.maxActive, this.active);
      const id = this.id;
      await new Promise((r) => setTimeout(r, 5));
      this.log.push(`${name}@${id}`);
      if (this.id !== id) throw new Error('slave id изменился посреди запроса');
      this.active--;
      return fn();
    }
    readHoldingRegisters(addr, len) {
      return this._op('read', () => ({ data: Array.from({ length: len }, (_, i) => this.regs.get(addr + i) ?? 0) }));
    }
    writeRegister(addr, v) { return this._op('write', () => { this.regs.set(addr, v); }); }
    writeRegisters(addr, vs) { return this._op('writeMulti', () => vs.forEach((v, i) => this.regs.set(addr + i, v))); }
    writeCoil() { return this._op('coil', () => {}); }
  }
  return FakeClient;
});

const ModbusRTU = require('modbus-serial');
const ModbusMasterManager = require('../../modBus/modbusMaster');

function makeMaster() {
  return new ModbusMasterManager({
    port: '/dev/fake',
    pollIntervalMs: 1,
    interRequestDelayMs: 0,
    devices: [
      { dID: 'a', slaveId: 1, registers: [
        { name: 't1', type: 'holding', address: 0, dataType: 'int16', scale: 0.1 },
        { name: 't2', type: 'holding', address: 1, dataType: 'int16' },
      ] },
      { dID: 'b', slaveId: 2, registers: [
        { name: 'p', type: 'holding', address: 10, dataType: 'float32' },
      ] },
    ],
  });
}

describe('ModbusMasterManager: очередь шины', () => {
  test('запись во время опроса не пересекается с запросами опроса', async () => {
    const master = makeMaster();
    await master.connect();
    const client = ModbusRTU.last;
    master.start();

    await Promise.all([
      master.writeToDevice('a', 't1', 23.4),
      master.writeToDevice('b', 'p', 1.5),
      master.writeToDevice('a', 't2', 7),
    ]);
    await new Promise((r) => setTimeout(r, 30));
    master.close();

    expect(client.maxActive).toBe(1);
    expect(client.log).toEqual(expect.arrayContaining(['write@1', 'writeMulti@2', 'write@1']));
    expect(client.regs.get(0)).toBe(234);
    expect(client.regs.get(1)).toBe(7);
  });

  test('ошибка одной транзакции не блокирует очередь', async () => {
    const master = makeMaster();
    await master.connect();
    const client = ModbusRTU.last;
    client.writeRegister = () => Promise.reject(new Error('Timed out'));

    await expect(master.writeToDevice('a', 't1', 1)).rejects.toThrow('Timed out');
    await expect(master.writeToDevice('b', 'p', 2)).resolves.toBeUndefined();
    master.close();
  });

  test('запись в регистр только для чтения отклоняется до обращения к шине', async () => {
    const master = new ModbusMasterManager({ port: '/dev/fake', devices: [
      { dID: 'a', slaveId: 1, registers: [{ name: 'in', type: 'input', address: 0, dataType: 'int16' }] },
    ] });
    await master.connect();
    await expect(master.writeToDevice('a', 'in', 1)).rejects.toThrow(/только для чтения/);
    expect(ModbusRTU.last.log).toEqual([]);
  });
});
