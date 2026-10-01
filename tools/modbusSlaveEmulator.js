#!/usr/bin/env node
// tools/modbusSlaveEmulator.js
//
// Автономный эмулятор Modbus TCP slave для ручного тестирования рядом с
// работающим serverapp.js — без физического ПР205.
//
// Запуск:
//   node tools/modbusSlaveEmulator.js [--map ./modbusMap.json] [--port 5020] [--host 0.0.0.0] [--jitter]
//
// Дальше в conf.env сервера временно указываете:
//   MODBUS_DEVICES='[{"id":"pr205","host":"127.0.0.1","port":5020,"unitId":1}]'
// (unitId эмулятор не проверяет — отвечает на любой)
//
// Консольные команды во время работы:
//   list                       - все теги из карты, их адрес и текущее значение
//   get <item_name>            - прочитать значение тега
//   set <item_name> <value>    - записать значение тега (bool: 1/0/true/false)
//   jitter on|off              - вкл/выкл случайный дрейф числовых датчиков
//   help
//   quit / exit
//
// Это упрощённый клон логики кодирования/декодирования из services/modbusTCPBridge.js,
// специально продублированный здесь, чтобы инструмент был автономным и не тянул
// за собой logger.js/messageStore.js и остальной сервер.

'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const readline = require('readline');

// ---------------------------------------------------------------------------
// CLI-аргументы
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { map: './modbusMap.json', port: 5020, host: '0.0.0.0', jitter: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--map') opts.map = argv[++i];
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--jitter') opts.jitter = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Использование: node tools/modbusSlaveEmulator.js [--map ./modbusMap.json] [--port 5020] [--host 0.0.0.0] [--jitter]`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Теги (упрощённая версия normalizeTag из modbusTCPBridge.js)
// ---------------------------------------------------------------------------
const WIDTH = { bool: 1, uint16: 1, int16: 1, uint32: 2, int32: 2, float32: 2 };
const TABLE_BANK = { coil: 'coil', discrete: 'discrete', holding: 'holding', input: 'input' };

function loadTags(mapFile) {
  const file = path.resolve(mapFile);
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tags = [];
  (map.tags || []).forEach((raw, i) => {
    const t = {
      request: 'sensors', dataType: null, scale: 1, offset: 0, decimals: 3,
      writable: false, wordOrder: 'BE', item_type: '', ...raw
    };
    if (!t.item_name || !t.table || !TABLE_BANK[t.table] || !Number.isInteger(t.address)) {
      console.error(`[emulator] пропущен тег #${i}: не хватает полей (item_name/table/address)`);
      return;
    }
    if (!t.dataType) t.dataType = (t.table === 'coil' || t.table === 'discrete') ? 'bool' : 'uint16';
    t.width = WIDTH[t.dataType] || 1;
    t.bank = TABLE_BANK[t.table];
    tags.push(t);
  });
  console.log(`[emulator] загружено тегов: ${tags.length} из ${file}`);
  return tags;
}

// ---------------------------------------------------------------------------
// Кодирование / декодирование (как в модсте, но без привязки к его модулю)
// ---------------------------------------------------------------------------
function decode(tag, words) {
  if (tag.dataType === 'bool') return Boolean(words[0]);
  const buf = Buffer.alloc(tag.width * 2);
  const w = tag.wordOrder === 'LE' ? [...words].reverse() : words;
  w.forEach((v, i) => buf.writeUInt16BE(v, i * 2));
  let raw;
  switch (tag.dataType) {
    case 'uint16': raw = buf.readUInt16BE(0); break;
    case 'int16': raw = buf.readInt16BE(0); break;
    case 'uint32': raw = buf.readUInt32BE(0); break;
    case 'int32': raw = buf.readInt32BE(0); break;
    case 'float32': raw = buf.readFloatBE(0); break;
  }
  return Number((raw * tag.scale + tag.offset).toFixed(tag.decimals));
}

// границы диапазона для каждого целочисленного типа - защита от RangeError
// при записи в буфер (переполнение/уход в минус на джиттере или ручном вводе)
const INT_RANGE = {
  uint16: [0, 0xffff],
  int16: [-0x8000, 0x7fff],
  uint32: [0, 0xffffffff],
  int32: [-0x80000000, 0x7fffffff]
};

function encode(tag, value) {
  if (tag.dataType === 'bool') return [value ? 1 : 0];
  let raw = (value - tag.offset) / tag.scale;
  if (tag.dataType !== 'float32') {
    raw = Math.round(raw);
    const [min, max] = INT_RANGE[tag.dataType];
    if (raw < min) raw = min;
    if (raw > max) raw = max;
  } else if (!Number.isFinite(raw)) {
    raw = 0;
  }
  const buf = Buffer.alloc(tag.width * 2);
  switch (tag.dataType) {
    case 'uint16': buf.writeUInt16BE(raw, 0); break;
    case 'int16': buf.writeInt16BE(raw, 0); break;
    case 'uint32': buf.writeUInt32BE(raw, 0); break;
    case 'int32': buf.writeInt32BE(raw, 0); break;
    case 'float32': buf.writeFloatBE(raw, 0); break;
  }
  const words = [];
  for (let i = 0; i < tag.width; i++) words.push(buf.readUInt16BE(i * 2));
  return tag.wordOrder === 'LE' ? words.reverse() : words;
}

/** Джиттером имеет смысл трогать только "аналоговые" величины (scale != 1) -
 *  температуры и т.п. Флаги связи/статусы/режимы (обычно scale=1, целые коды)
 *  джиттером не трогаем - у них нет смысла "случайно меняться" самим по себе. */
function canJitter(tag) {
  return tag.request === 'sensors' && tag.dataType !== 'bool' && tag.scale !== 1;
}

// разумное значение по умолчанию, чтобы дашборд сразу показывал что-то похожее на жизнь
function defaultValue(tag) {
  if (tag.dataType === 'bool') return false;
  const looksLikeTemp = /temp/i.test(tag.item_name) || /temp/i.test(tag.item_type || '');
  if (looksLikeTemp) return 20; // стартовая температура, °C
  return 0;
}

// ---------------------------------------------------------------------------
// Банки регистров: coil/discrete (bool), holding/input (uint16-слова)
// ---------------------------------------------------------------------------
class RegisterBank {
  constructor() {
    this.coil = new Map();
    this.discrete = new Map();
    this.holding = new Map();
    this.input = new Map();
  }
  readWords(bank, address, qty) {
    const m = this[bank];
    const out = [];
    for (let i = 0; i < qty; i++) out.push(m.get(address + i) ?? 0);
    return out;
  }
  writeWords(bank, address, words) {
    const m = this[bank];
    words.forEach((v, i) => m.set(address + i, v & 0xffff));
  }
}

const bank = new RegisterBank();
let tags = loadTags(args.map);
const byName = new Map(tags.map((t) => [t.item_name, t]));

// начальное заполнение
for (const t of tags) bank.writeWords(t.bank, t.address, encode(t, defaultValue(t)));

function setTagValue(itemName, value, { silent = false } = {}) {
  const t = byName.get(itemName);
  if (!t) {
    console.log(`[emulator] тег "${itemName}" не найден`);
    return false;
  }
  bank.writeWords(t.bank, t.address, encode(t, value));
  if (!silent) console.log(`[emulator] ✍️  ${itemName} = ${decode(t, bank.readWords(t.bank, t.address, t.width))}`);
  return true;
}

function getTagValue(itemName) {
  const t = byName.get(itemName);
  if (!t) return undefined;
  return decode(t, bank.readWords(t.bank, t.address, t.width));
}

// ---------------------------------------------------------------------------
// Джиттер: раз в 2 секунды слегка "дышат" только числовые sensors-теги
// ---------------------------------------------------------------------------
let jitterEnabled = args.jitter;
let jitterTimer = null;
function startJitter() {
  if (jitterTimer) return;
  jitterTimer = setInterval(() => {
    if (!jitterEnabled) return;
    for (const t of tags) {
      if (!canJitter(t)) continue;
      const cur = getTagValue(t.item_name) ?? 0;
      const step = (Math.random() - 0.5) * 2 * Math.max(t.scale, 0.1); // небольшой случайный шаг
      setTagValue(t.item_name, Number((cur + step).toFixed(t.decimals)), { silent: true });
    }
  }, 2000).unref();
}
startJitter();

// ---------------------------------------------------------------------------
// TCP-сервер Modbus
// ---------------------------------------------------------------------------
const sockets = new Set();

function handleFrame(socket, frame) {
  const tid = frame.readUInt16BE(0);
  const unit = frame.readUInt8(6);
  const fc = frame.readUInt8(7);

  const respond = (pdu) => {
    const out = Buffer.alloc(7 + pdu.length);
    out.writeUInt16BE(tid, 0);
    out.writeUInt16BE(0, 2);
    out.writeUInt16BE(pdu.length + 1, 4);
    out.writeUInt8(unit, 6);
    pdu.copy(out, 7);
    socket.write(out);
  };
  const exception = (code) => respond(Buffer.from([fc | 0x80, code]));

  try {
    switch (fc) {
      case 0x03: case 0x04: { // read holding / input registers
        const address = frame.readUInt16BE(8);
        const qty = frame.readUInt16BE(10);
        const b = fc === 0x03 ? 'holding' : 'input';
        const values = bank.readWords(b, address, qty);
        console.log(`[emulator] 📤 readHolding/Input[${b}] @${address} x${qty} -> [${values}]`);
        const data = Buffer.alloc(2 + qty * 2);
        data.writeUInt8(fc, 0);
        data.writeUInt8(qty * 2, 1);
        values.forEach((v, i) => data.writeUInt16BE(v, 2 + i * 2));
        respond(data);
        break;
      }
      case 0x01: case 0x02: { // read coils / discrete inputs
        const address = frame.readUInt16BE(8);
        const qty = frame.readUInt16BE(10);
        const b = fc === 0x01 ? 'coil' : 'discrete';
        const byteCount = Math.ceil(qty / 8);
        const data = Buffer.alloc(2 + byteCount);
        data.writeUInt8(fc, 0);
        data.writeUInt8(byteCount, 1);
        for (let i = 0; i < qty; i++) {
          if (bank[b].get(address + i)) data[2 + (i >> 3)] |= 1 << (i & 7);
        }
        console.log(`[emulator] 📤 readBits[${b}] @${address} x${qty}`);
        respond(data);
        break;
      }
      case 0x06: { // write single register
        const address = frame.readUInt16BE(8);
        const value = frame.readUInt16BE(10);
        bank.writeWords('holding', address, [value]);
        console.log(`[emulator] 📥 writeSingleRegister holding[${address}] = ${value}`);
        respond(frame.subarray(7));
        break;
      }
      case 0x10: { // write multiple registers
        const address = frame.readUInt16BE(8);
        const qty = frame.readUInt16BE(10);
        const words = [];
        for (let i = 0; i < qty; i++) words.push(frame.readUInt16BE(13 + i * 2));
        bank.writeWords('holding', address, words);
        console.log(`[emulator] 📥 writeMultipleRegisters holding[${address}..${address + qty - 1}] = [${words}]`);
        const data = Buffer.alloc(5);
        data.writeUInt8(fc, 0);
        data.writeUInt16BE(address, 1);
        data.writeUInt16BE(qty, 3);
        respond(data);
        break;
      }
      case 0x05: { // write single coil
        const address = frame.readUInt16BE(8);
        const raw = frame.readUInt16BE(10);
        bank.coil.set(address, raw === 0xff00);
        console.log(`[emulator] 📥 writeSingleCoil[${address}] = ${raw === 0xff00}`);
        respond(frame.subarray(7));
        break;
      }
      default:
        exception(0x01); // ILLEGAL_FUNCTION
    }
  } catch (err) {
    console.error(`[emulator] ❌ ошибка обработки fc=${fc}: ${err.message}`);
    exception(0x04); // SERVER_DEVICE_FAILURE
  }
}

const server = net.createServer((socket) => {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[emulator] 🔌 клиент подключился: ${remote}`);
  sockets.add(socket);

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 7) {
      const length = buf.readUInt16BE(4);
      const total = 6 + length;
      if (buf.length < total) return;
      const frame = buf.subarray(0, total);
      buf = buf.subarray(total);
      handleFrame(socket, frame);
    }
  });
  socket.on('close', () => { sockets.delete(socket); console.log(`[emulator] ⚠️ клиент отключился: ${remote}`); });
  socket.on('error', (err) => console.error(`[emulator] сокет ${remote}: ${err.message}`));
});

server.listen(args.port, args.host, () => {
  console.log(`[emulator] ✅ Modbus TCP slave слушает ${args.host}:${args.port}`);
  console.log(`[emulator] джиттер: ${jitterEnabled ? 'включён' : 'выключен'} (переключить: "jitter on" / "jitter off")`);
  console.log(`[emulator] наберите "help" для списка команд`);
});

// ---------------------------------------------------------------------------
// Консоль управления
// ---------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });

function printHelp() {
  console.log(`
  list                       - все теги: адрес, таблица, текущее значение
  get <item_name>            - прочитать значение тега
  set <item_name> <value>    - записать значение (bool: 1/0/true/false)
  jitter on|off              - вкл/выкл случайный дрейф датчиков
  reload                     - перечитать modbusMap.json
  help
  quit / exit
  `);
}

function cmdList() {
  const rows = tags.map((t) => ({
    item_name: t.item_name, table: t.table, address: t.address,
    value: getTagValue(t.item_name), writable: t.writable
  }));
  console.table(rows);
}

rl.prompt();
rl.on('line', (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  switch (cmd) {
    case '': break;
    case 'help': printHelp(); break;
    case 'list': cmdList(); break;
    case 'get': {
      const v = getTagValue(rest[0]);
      console.log(v === undefined ? `тег "${rest[0]}" не найден` : `${rest[0]} = ${v}`);
      break;
    }
    case 'set': {
      const [name, rawValue] = rest;
      let value = rawValue;
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (!Number.isNaN(Number(value))) value = Number(value);
      setTagValue(name, value);
      break;
    }
    case 'jitter':
      jitterEnabled = rest[0] === 'on';
      console.log(`[emulator] джиттер: ${jitterEnabled ? 'включён' : 'выключен'}`);
      break;
    case 'reload':
      try {
        tags = loadTags(args.map);
        byName.clear();
        tags.forEach((t) => byName.set(t.item_name, t));
        console.log('[emulator] карта тегов перечитана');
      } catch (err) {
        console.error(`[emulator] не удалось перечитать карту: ${err.message}`);
      }
      break;
    case 'quit': case 'exit':
      shutdown();
      return;
    default:
      console.log(`неизвестная команда "${cmd}", наберите "help"`);
  }
  rl.prompt();
});

function shutdown() {
  console.log('\n[emulator] остановка...');
  clearInterval(jitterTimer);
  for (const s of sockets) s.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
