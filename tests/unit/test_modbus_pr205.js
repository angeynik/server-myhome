'use strict';

// Диагностический тест: читает все теги из modbusMap.json через Modbus TCP
// и выводит сырые регистры и декодированные значения.

const fs = require('fs');
const path = require('path');

const logger = require('../../services/logger.js');
logger.initLogging();

const { ModbusDevice } = require('../../classes/modBusTCPManager.js');

const HOST = '192.168.10.5';
const PORT = 502;
const UNIT_ID = 1;

const mapFile = path.join(__dirname, '../../modbusMap.json');
const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));

const WIDTH = { bool: 1, uint16: 1, int16: 1, uint32: 2, int32: 2, float32: 2 };

const device = new ModbusDevice('pr205', {
  host: HOST,
  port: PORT,
  unitId: UNIT_ID,
  timeout: 5000,
  reconnectMin: 500,
  reconnectMax: 2000
});

device.connect();

let finished = false;
const finish = (code) => {
  if (finished) return;
  finished = true;
  try { device.close(); } catch (_) {}
  setTimeout(() => process.exit(code), 200);
};

function decodeValue(tag, regs) {
  const dt = tag.dataType;

  if (dt === 'float32') {
    const buf = Buffer.alloc(4);
    if ((tag.wordOrder || 'BE') === 'LE') {
      buf.writeUInt16BE(regs[1], 0);
      buf.writeUInt16BE(regs[0], 2);
    } else {
      buf.writeUInt16BE(regs[0], 0);
      buf.writeUInt16BE(regs[1], 2);
    }
    const v = buf.readFloatBE(0);
    return Number.isFinite(v) ? Number(v.toFixed(tag.decimals ?? 3)) : null;
  }

  if (dt === 'int32') {
    const buf = Buffer.alloc(4);
    buf.writeUInt16BE(regs[0], 0);
    buf.writeUInt16BE(regs[1], 2);
    return buf.readInt32BE(0);
  }

  if (dt === 'uint32') {
    const buf = Buffer.alloc(4);
    buf.writeUInt16BE(regs[0], 0);
    buf.writeUInt16BE(regs[1], 2);
    return buf.readUInt32BE(0);
  }

  if (dt === 'int16') {
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(regs[0], 0);
    return buf.readInt16BE(0);
  }

  // uint16 / bool
  return regs[0];
}

device.on('connect', async () => {
  console.log(`\n✅ Соединение с ${HOST}:${PORT} (unitId=${UNIT_ID}) установлено\n`);
  console.log(`Загружено тегов из карты: ${map.tags.length}\n`);

  let ok = 0, err = 0;

  for (const tag of map.tags) {
    const width = WIDTH[tag.dataType] || 1;
    const addrHex = '0x' + tag.address.toString(16).padStart(4, '0');
    try {
      const regs = await device.readHoldingRegisters(tag.address, width);
      const value = decodeValue(tag, regs);
      const raw = regs.map(r => '0x' + r.toString(16).padStart(4, '0')).join(' ');
      console.log(`✅ [${tag.address} / ${addrHex}] ${tag.item_name.padEnd(15)} (${tag.dataType.padEnd(7)}) = ${String(value).padEnd(12)} raw=[${raw}]`);
      ok++;
    } catch (e) {
      const exc = e.exceptionCode ?? 'n/a';
      console.log(`❌ [${tag.address} / ${addrHex}] ${tag.item_name.padEnd(15)} - ${e.message} (exc=${exc})`);
      err++;
    }
  }

  console.log(`\n=== ИТОГ: OK=${ok}, ERROR=${err} ===`);
  finish(err === 0 ? 0 : 1);
});

device.on('fault', (err) => console.error(`💥 fault: ${err.message}`));
device.on('disconnect', () => console.log('⚠️  disconnect'));

setTimeout(() => {
  console.error('\n⏰ Общий таймаут теста (60 сек).');
  finish(2);
}, 60000);
