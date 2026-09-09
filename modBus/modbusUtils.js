// modbus/modbusUtils.js
// Вспомогательные функции для преобразования "сырых" 16-битных регистров Modbus
// в JS-значения (и обратно), с поддержкой масштаба и перестановки слов (swapWords)
// для 32-битных типов (это часто требуется многим китайским счётчикам/датчикам).

const REGISTER_SIZE = {
  bool: 1,
  int16: 1,
  uint16: 1,
  int32: 2,
  uint32: 2,
  float32: 2,
};

function regsToBuffer(regs) {
  const buf = Buffer.alloc(regs.length * 2);
  regs.forEach((r, i) => buf.writeUInt16BE(r & 0xffff, i * 2));
  return buf;
}

/**
 * Преобразует массив "сырых" регистров (как возвращает modbus-serial: result.data)
 * в число/boolean нужного типа.
 * @param {number[]} regs - массив 16-битных регистров
 * @param {string} dataType - 'bool' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32'
 * @param {{swapWords?: boolean, scale?: number}} options
 */
function decodeRegisters(regs, dataType, { swapWords = false, scale = 1 } = {}) {
  let words = regs.slice();
  if (swapWords && words.length === 2) {
    words = [words[1], words[0]];
  }
  const buf = regsToBuffer(words);

  let raw;
  switch (dataType) {
    case 'bool':
      return buf.readUInt16BE(0) !== 0;
    case 'int16':
      raw = buf.readInt16BE(0);
      break;
    case 'uint16':
      raw = buf.readUInt16BE(0);
      break;
    case 'int32':
      raw = buf.readInt32BE(0);
      break;
    case 'uint32':
      raw = buf.readUInt32BE(0);
      break;
    case 'float32':
      raw = buf.readFloatBE(0);
      break;
    default:
      throw new Error(`[modbusUtils] Неизвестный dataType: ${dataType}`);
  }

  return scale !== 1 ? raw * scale : raw;
}

/**
 * Преобразует JS-значение обратно в массив 16-битных регистров для записи в устройство.
 * @param {number|boolean} value
 * @param {string} dataType
 * @param {{swapWords?: boolean, scale?: number}} options
 */
function encodeToRegisters(value, dataType, { swapWords = false, scale = 1 } = {}) {
  let buf;
  const num = dataType === 'bool' ? (value ? 1 : 0) : Number(value) / scale;

  switch (dataType) {
    case 'bool':
    case 'uint16':
      buf = Buffer.alloc(2);
      buf.writeUInt16BE(Math.round(num) & 0xffff, 0);
      break;
    case 'int16':
      buf = Buffer.alloc(2);
      buf.writeInt16BE(Math.round(num), 0);
      break;
    case 'uint32':
      buf = Buffer.alloc(4);
      buf.writeUInt32BE(Math.round(num) >>> 0, 0);
      break;
    case 'int32':
      buf = Buffer.alloc(4);
      buf.writeInt32BE(Math.round(num), 0);
      break;
    case 'float32':
      buf = Buffer.alloc(4);
      buf.writeFloatBE(num, 0);
      break;
    default:
      throw new Error(`[modbusUtils] Неизвестный dataType: ${dataType}`);
  }

  const regs = [];
  for (let i = 0; i < buf.length; i += 2) {
    regs.push(buf.readUInt16BE(i));
  }
  if (swapWords && regs.length === 2) {
    regs.reverse();
  }
  return regs;
}

module.exports = { REGISTER_SIZE, decodeRegisters, encodeToRegisters };
