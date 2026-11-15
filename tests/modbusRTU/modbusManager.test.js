// tests/modbusRTU/modbusManager.test.js
// Выбор роли и адресов: Master и Slave подменены фейками, порты не открываются.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../services/logger.js', () => ({
  initLogging: jest.fn(),
  logInfoMessage: jest.fn(),
  logDevMessage: jest.fn(),
  logErrorMessage: jest.fn(),
}));
jest.mock('../../modBus/modbusMaster', () => jest.fn().mockImplementation((cfg) => ({
  cfg, on: jest.fn(), connect: jest.fn(async () => {}), start: jest.fn(), close: jest.fn(),
})));
jest.mock('../../modBus/modbusSlave', () => jest.fn().mockImplementation((cfg) => ({
  cfg, on: jest.fn(), start: jest.fn(async () => {}), close: jest.fn(),
})));

const ModbusManager = require('../../modBus/modbusManager');

describe('ModbusManager', () => {
  let dir;
  const savedRole = process.env.MODBUS_ROLE;
  const write = (conf) => {
    const p = path.join(dir, 'modbusConf.json');
    fs.writeFileSync(p, JSON.stringify(conf));
    return p;
  };
  const conf = (role) => ({
    role,
    master: { port: '/dev/ttyS3', devices: [{ dID: 'x', slaveId: 1, registers: [] }] },
    slave: { port: '/dev/ttyUSB0', unitID: 10, registerMap: [] },
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modbus-mgr-'));
    delete process.env.MODBUS_ROLE;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedRole === undefined) delete process.env.MODBUS_ROLE;
    else process.env.MODBUS_ROLE = savedRole;
  });

  test('роль берётся из modbusConf.json', async () => {
    const mgr = new ModbusManager(write(conf('both')));
    await mgr.start();
    expect(mgr.master).not.toBeNull();
    expect(mgr.slave).not.toBeNull();
  });

  test('MODBUS_ROLE важнее роли из конфига', async () => {
    process.env.MODBUS_ROLE = 'master';
    const mgr = new ModbusManager(write(conf('both')));
    await mgr.start();
    expect(mgr.master).not.toBeNull();
    expect(mgr.slave).toBeNull();
  });

  test('неизвестная роль отклоняется', async () => {
    const mgr = new ModbusManager(write(conf('server')));
    await expect(mgr.start()).rejects.toThrow(/Неизвестная роль/);
  });

  test('both на одном порту запрещён без allowSharedPort', async () => {
    const c = conf('both');
    c.slave.port = c.master.port;
    await expect(new ModbusManager(write(c)).start()).rejects.toThrow(/один и тот же порт/);
  });

  test('applyUnitId задаёт unitId Slave и slaveId устройств Master', () => {
    const mgr = new ModbusManager(write(conf('both')), { unitId: 7 });
    expect(mgr.config.slave.unitId).toBe(7);
    expect(mgr.config.master.devices[0].slaveId).toBe(7);
  });
});
