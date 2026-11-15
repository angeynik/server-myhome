#!/usr/bin/env node
// tools/modbusDiag.js
//
// Диагностика Modbus TCP: читает все теги из modbusMap.json и печатает сырые регистры
// и декодированные значения. Работает и с реальным ПР205, и с tools/modbusSlaveEmulator.js.
//
// Запуск:
//   node tools/modbusDiag.js [--host 192.168.10.5] [--port 502] [--unit 1] [--map ./modbusMap.json]
// Код выхода: 0 — все теги прочитаны, 1 — были ошибки, 2 — общий таймаут.
//
// Декодирование повторяет services/modbusTCPBridge.js: wordOrder для 32-битных типов,
// scale/offset (в том числе defaultScale/defaultOffset из корня карты), логические теги в регистрах.
'use strict';

const fs = require('fs');
const path = require('path');
const { ModbusDevice } = require('../classes/modBusTCPManager.js');

function parseArgs(argv) {
  const opts = { host: '192.168.10.5', port: 502, unit: 1, map: './modbusMap.json', timeoutMs: 60000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') opts.host = argv[++i];
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--unit') opts.unit = Number(argv[++i]);
    else if (a === '--map') opts.map = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('Использование: node tools/modbusDiag.js [--host 192.168.10.5] [--port 502] [--unit 1] [--map ./modbusMap.json]');
  process.exit(0);
}

const WIDTH = { bool: 1, uint16: 1, int16: 1, uint32: 2, int32: 2, float32: 2 };
const READ = {
  holding: 'readHoldingRegisters',
  input: 'readInputRegisters',
  coil: 'readCoils',
  discrete: 'readDiscreteInputs',
};

const mapFile = path.resolve(args.map);
const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));

function decode(tag, regs) {
  const dataType = tag.dataType || 'uint16';
  if (dataType === 'bool') return Boolean(regs[0]);

  const words = tag.wordOrder === 'LE' ? [...regs].reverse() : regs;
  const buf = Buffer.alloc(words.length * 2);
  words.forEach((w, i) => buf.writeUInt16BE(w, i * 2));

  let raw;
  switch (dataType) {
    case 'int16': raw = buf.readInt16BE(0); break;
    case 'uint32': raw = buf.readUInt32BE(0); break;
    case 'int32': raw = buf.readInt32BE(0); break;
    case 'float32': raw = buf.readFloatBE(0); break;
    default: raw = buf.readUInt16BE(0);
  }
  if (!Number.isFinite(raw)) return null;
  if (tag.item_type === 'bool' || tag.item_type === 'dBool') return raw !== 0;

  const scale = tag.scale ?? map.defaultScale ?? 1;
  const offset = tag.offset ?? map.defaultOffset ?? 0;
  return Number((raw * scale + offset).toFixed(tag.decimals ?? 3));
}

const device = new ModbusDevice('diag', {
  host: args.host,
  port: args.port,
  unitId: args.unit,
  timeout: 5000,
  reconnectMin: 500,
  reconnectMax: 2000,
});

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  try { device.close(); } catch (_) { /* соединение уже закрыто */ }
  setTimeout(() => process.exit(code), 200);
}

device.on('connect', async () => {
  console.log(`\n✅ Соединение с ${args.host}:${args.port} (unitId=${args.unit}) установлено`);
  console.log(`Тегов в карте ${mapFile}: ${map.tags.length}\n`);

  let ok = 0;
  let err = 0;
  const byAddress = new Map();

  for (const tag of map.tags) {
    const table = tag.table || 'holding';
    const width = (table === 'coil' || table === 'discrete') ? 1 : (WIDTH[tag.dataType] || 1);
    const addrHex = `0x${tag.address.toString(16).padStart(4, '0')}`;
    const where = `${table}[${tag.address} / ${addrHex}]`;
    const shared = `${table}:${tag.address}`;
    byAddress.set(shared, [...(byAddress.get(shared) || []), tag.item_name]);

    try {
      const regs = await device[READ[table]](tag.address, width);
      const value = decode(tag, regs);
      const raw = regs.map((r) => (typeof r === 'boolean' ? String(r) : `0x${r.toString(16).padStart(4, '0')}`)).join(' ');
      console.log(`✅ ${where.padEnd(24)} ${tag.item_name.padEnd(15)} (${String(tag.dataType || 'auto').padEnd(7)}) = ${String(value).padEnd(10)} raw=[${raw}]`);
      ok++;
    } catch (e) {
      console.log(`❌ ${where.padEnd(24)} ${tag.item_name.padEnd(15)} - ${e.message} (exc=${e.exceptionCode ?? 'n/a'})`);
      err++;
    }
  }

  for (const [addr, names] of byAddress) {
    if (names.length > 1) console.log(`⚠️  Один адрес ${addr} у нескольких тегов: ${names.join(', ')}`);
  }
  console.log(`\n=== ИТОГ: OK=${ok}, ERROR=${err} ===`);
  finish(err === 0 ? 0 : 1);
});

device.on('fault', (e) => console.error(`💥 fault: ${e.message}`));
device.on('disconnect', () => console.log('⚠️  disconnect'));

setTimeout(() => {
  console.error(`\n⏰ Общий таймаут (${args.timeoutMs / 1000} с).`);
  finish(2);
}, args.timeoutMs).unref();

device.connect();
