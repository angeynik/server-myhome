#!/usr/bin/env node
// tools/modbusRtuCheck.js
//
// Проверка Modbus RTU (modBus/) без железа: поднимает виртуальные последовательные порты
// (tools/ptyPair.py, нужен python3, Linux/macOS) и прогоняет сценарии:
//   master  — Master опрашивает Slave: все таблицы и типы, setValueByName, запись во время опроса;
//   crc     — Slave отвечает на кадр с верным CRC и молча отбрасывает искажённый;
//   manager — ModbusManager в роли "both" на двух шинах: свой Master и свой Slave одновременно.
//
// Запуск:  node tools/modbusRtuCheck.js [master] [crc] [manager]   (без аргументов — все)
// Код выхода: 0 — все проверки прошли, 1 — есть ошибки.
'use strict';

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { SerialPort } = require('serialport');

const root = path.resolve(__dirname, '..');
const ModbusSlaveServer = require(path.join(root, 'modBus/modbusSlave'));
const ModbusMasterManager = require(path.join(root, 'modBus/modbusMaster'));
const ModbusManager = require(path.join(root, 'modBus/modbusManager'));
const { crc16 } = require(path.join(root, 'modBus/modbusUtils'));

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-6;
const cleanups = [];

// Виртуальная шина: два конца, соединённых tools/ptyPair.py
async function openBus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtu-bus-'));
  const proc = spawn('python3', [path.join(__dirname, 'ptyPair.py'), dir], { stdio: ['ignore', 'pipe', 'inherit'] });
  cleanups.push(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const line = await new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.stdout.once('data', (d) => resolve(String(d).trim()));
    setTimeout(() => reject(new Error('ptyPair.py не запустился (нужен python3)')), 3000);
  });
  const [a, b] = line.split(' ');
  return { a, b };
}

async function scenarioMaster() {
  console.log('\n— master: опрос и запись через одну шину');
  const bus = await openBus();
  const regs = [
    { name: 'temp', type: 'holding', address: 0, dataType: 'int16', scale: 0.1 },
    { name: 'flow', type: 'holding', address: 2, dataType: 'float32', swapWords: true },
    { name: 'pump', type: 'coil', address: 0, dataType: 'bool' },
    { name: 'door', type: 'discrete', address: 1, dataType: 'bool' },
    { name: 'power', type: 'input', address: 4, dataType: 'int32', scale: 0.01 },
  ];
  const initial = { temp: 21.5, flow: 3.25, pump: true, door: false, power: -1234.56 };
  const slave = new ModbusSlaveServer({
    port: bus.a, baudRate: 19200, unitId: 10, dID: 'gate',
    registerMap: regs.map((r) => ({ ...r, initial: initial[r.name] })),
  });
  const writes = [];
  slave.on('write', (w) => writes.push(w));
  await slave.start();
  cleanups.push(() => slave.close());

  const master = new ModbusMasterManager({
    port: bus.b, baudRate: 19200, pollIntervalMs: 300, requestTimeoutMs: 500, interRequestDelayMs: 10,
    devices: [{ dID: 'gate', room: 'yard', slaveId: 10, registers: regs }],
  });
  const values = {};
  const errors = [];
  master.on('data', (d) => { values[d.payload.item_name] = d.payload.item_value; });
  master.on('deviceError', (e) => errors.push(e));
  await master.connect();
  master.start();
  cleanups.push(() => master.close());
  await sleep(1500);

  for (const [name, want] of Object.entries(initial)) {
    const got = values[name];
    ok(typeof want === 'number' ? near(got, want) : got === want, `${name}: ${got}`);
  }

  slave.setValueByName('door', true);
  slave.setValueByName('temp', 19.8);
  await sleep(900);
  ok(values.door === true && near(values.temp, 19.8), `setValueByName виден Master: door=${values.door}, temp=${values.temp}`);

  const results = await Promise.allSettled([
    master.writeToDevice('gate', 'temp', 23.4),
    master.writeToDevice('gate', 'pump', false),
    master.writeToDevice('gate', 'flow', 7.5),
  ]);
  ok(results.every((r) => r.status === 'fulfilled'), `3 записи во время опроса: ${results.map((r) => r.status).join(', ')}`);
  await sleep(900);
  ok(near(values.temp, 23.4) && values.pump === false && near(values.flow, 7.5),
    `записанное читается обратно: temp=${values.temp}, pump=${values.pump}, flow=${values.flow}`);
  ok(near(slave.getValueByName('flow'), 7.5), `getValueByName на стороне Slave: flow=${slave.getValueByName('flow')}`);
  ok(writes.length > 0 && writes.every((w) => w.name && w.dID === 'gate'), `события write с name и dID: ${[...new Set(writes.map((w) => w.name))].join(', ')}`);
  ok(errors.length === 0, `ошибок опроса: ${errors.length}`);
  master.close();
  slave.close();
}

async function scenarioCrc() {
  console.log('\n— crc: проверка контрольной суммы входящих кадров');
  const bus = await openBus();
  const slave = new ModbusSlaveServer({
    port: bus.a, baudRate: 19200, unitId: 10,
    registerMap: [{ name: 'temp', type: 'holding', address: 0, dataType: 'int16', initial: 215 }],
  });
  const crcErrors = [];
  slave.on('crcError', (e) => crcErrors.push(e));
  await slave.start();
  cleanups.push(() => slave.close());

  const port = new SerialPort({ path: bus.b, baudRate: 19200 });
  await new Promise((resolve, reject) => port.once('open', resolve).once('error', reject));
  cleanups.push(() => port.isOpen && port.close());
  let rx = Buffer.alloc(0);
  port.on('data', (d) => { rx = Buffer.concat([rx, d]); });

  const request = (pdu) => {
    const frame = Buffer.alloc(pdu.length + 2);
    pdu.copy(frame);
    frame.writeUInt16LE(crc16(pdu), pdu.length);
    return frame;
  };
  const exchange = async (frame) => {
    rx = Buffer.alloc(0);
    port.write(frame);
    await sleep(300);
    return rx;
  };
  const read = Buffer.from([10, 0x03, 0x00, 0x00, 0x00, 0x01]); // FC3: holding[0] x1

  const good = await exchange(request(read));
  ok(good.length === 7 && good.readUInt16BE(3) === 215 && good.readUInt16LE(5) === crc16(good.subarray(0, 5)),
    `кадр с верным CRC: ответ ${good.toString('hex')} (значение ${good.length >= 5 ? good.readUInt16BE(3) : '—'})`);

  const badCrc = request(read);
  badCrc[badCrc.length - 1] ^= 0xff;
  ok((await exchange(badCrc)).length === 0, 'кадр с искажённым CRC отброшен без ответа');

  const write = request(Buffer.from([10, 0x06, 0x00, 0x00, 0x03, 0xe7])); // FC6: holding[0] = 999
  write[4] ^= 0x01; // помеха в данных, CRC остался от исходного кадра
  ok((await exchange(write)).length === 0 && slave.getValueByName('temp') === 215,
    `запись с повреждёнными данными не выполнена: holding[0]=${slave.getValueByName('temp')}`);

  ok((await exchange(Buffer.from([10, 0x03]))).length === 0, 'обрывок кадра короче 4 байт отброшен');
  ok(slave.stats.crcErrors === 3 && crcErrors.length === 3, `stats.crcErrors=${slave.stats.crcErrors}, событий crcError=${crcErrors.length}`);
  ok((await exchange(request(read))).length === 7, 'после ошибок Slave продолжает отвечать на верные кадры');
  port.close();
  slave.close();
}

async function scenarioManager() {
  console.log('\n— manager: роль "both" на двух шинах');
  const field = await openBus(); // шина 1: Master менеджера -> внешнее устройство
  const scadaBus = await openBus(); // шина 2: внешний Master -> Slave менеджера
  const device = new ModbusSlaveServer({ port: field.a, baudRate: 9600, unitID: 3, registerMap: [
    { name: 'boilerTemp', type: 'holding', address: 0, dataType: 'int16', scale: 0.1, initial: 55.3 },
    { name: 'pump', type: 'coil', address: 0, dataType: 'bool', initial: false },
  ] });
  await device.start();
  cleanups.push(() => device.close());

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtu-conf-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const confPath = path.join(dir, 'modbusConf.json');
  fs.writeFileSync(confPath, JSON.stringify({
    role: 'both',
    master: { port: field.b, baudRate: 9600, pollIntervalMs: 300, requestTimeoutMs: 500, devices: [
      { dID: 'boiler', room: 'boiler_room', slaveId: 3, registers: [
        { name: 'boilerTemp', type: 'holding', address: 0, dataType: 'int16', scale: 0.1 },
        { name: 'pump', type: 'coil', address: 0, dataType: 'bool' },
      ] },
    ] },
    slave: { port: scadaBus.a, baudRate: 9600, unitID: 10, dID: 'gate', registerMap: [
      { name: 'door_sensor', type: 'discrete', address: 0, dataType: 'bool', initial: false },
      { name: 'setpoint_temp', type: 'holding', address: 0, dataType: 'int16', scale: 0.1, initial: 22 },
    ] },
  }));
  const savedRole = process.env.MODBUS_ROLE;
  delete process.env.MODBUS_ROLE;

  const mgr = new ModbusManager(confPath);
  const data = {};
  const slaveWrites = [];
  await mgr.start({
    onData: (d) => { data[d.payload.item_name] = d.payload.item_value; },
    onSlaveWrite: (w) => slaveWrites.push(w),
  });
  cleanups.push(() => mgr.close());
  ok(mgr.master && mgr.slave, 'подняты Master и Slave');

  const scada = new ModbusMasterManager({ port: scadaBus.b, baudRate: 9600, pollIntervalMs: 300, requestTimeoutMs: 500, devices: [
    { dID: 'gate', slaveId: 10, registers: [
      { name: 'door_sensor', type: 'discrete', address: 0, dataType: 'bool' },
      { name: 'setpoint_temp', type: 'holding', address: 0, dataType: 'int16', scale: 0.1 },
    ] },
  ] });
  const seen = {};
  scada.on('data', (d) => { seen[d.payload.item_name] = d.payload.item_value; });
  await scada.connect();
  scada.start();
  cleanups.push(() => scada.close());
  await sleep(1500);

  ok(data.boilerTemp === 55.3 && data.pump === false, `Master менеджера читает устройство: boilerTemp=${data.boilerTemp}, pump=${data.pump}`);
  ok(seen.door_sensor === false && seen.setpoint_temp === 22, `внешний Master читает Slave менеджера: door=${seen.door_sensor}, setpoint=${seen.setpoint_temp}`);

  await mgr.writeToDevice('boiler', 'pump', true);
  mgr.updateSlaveValueByName('door_sensor', true);
  await scada.writeToDevice('gate', 'setpoint_temp', 23.5);
  await sleep(1200);
  ok(data.pump === true, `writeToDevice дошёл до устройства: pump=${data.pump}`);
  ok(seen.door_sensor === true, `updateSlaveValueByName виден снаружи: door=${seen.door_sensor}`);
  ok(slaveWrites.some((w) => w.name === 'setpoint_temp' && w.dID === 'gate') && mgr.slave.getValueByName('setpoint_temp') === 23.5,
    `запись внешнего Master: onSlaveWrite + значение ${mgr.slave.getValueByName('setpoint_temp')}`);

  if (savedRole !== undefined) process.env.MODBUS_ROLE = savedRole;
  scada.close();
  mgr.close();
  device.close();
}

const SCENARIOS = { master: scenarioMaster, crc: scenarioCrc, manager: scenarioManager };

(async () => {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
  for (const name of names) {
    if (!SCENARIOS[name]) {
      console.error(`Неизвестный сценарий "${name}" (есть: ${Object.keys(SCENARIOS).join(', ')})`);
      process.exit(2);
    }
    await SCENARIOS[name]();
  }
  console.log(`\n=== ИТОГ: ${failed === 0 ? 'все проверки прошли' : `ошибок ${failed}`} ===`);
})()
  .catch((e) => {
    console.error(`❌ ${e.stack || e.message}`);
    failed++;
  })
  .finally(async () => {
    for (const fn of cleanups.reverse()) {
      try { fn(); } catch { /* уже закрыто */ }
    }
    await sleep(300);
    process.exit(failed === 0 ? 0 : 1);
  });
