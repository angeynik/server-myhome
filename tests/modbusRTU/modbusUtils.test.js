// tests/modbusRTU/modbusUtils.test.js
'use strict';

const { decodeRegisters, encodeToRegisters, crc16, isValidRtuFrame } = require('../../modBus/modbusUtils');

describe('modbusUtils', () => {
  test('масштаб округляется до своей точности', () => {
    expect(decodeRegisters([234], 'int16', { scale: 0.1 })).toBe(23.4);
    expect(decodeRegisters(encodeToRegisters(-1234.56, 'int32', { scale: 0.01 }), 'int32', { scale: 0.01 })).toBe(-1234.56);
    expect(decodeRegisters([7], 'uint16', { scale: 1e-7 })).toBe(7e-7);
  });

  test('float32 с перестановкой слов', () => {
    const regs = encodeToRegisters(3.25, 'float32', { swapWords: true });
    expect(decodeRegisters(regs, 'float32', { swapWords: true })).toBe(3.25);
    expect(decodeRegisters(regs, 'float32')).not.toBe(3.25);
  });

  test('bool', () => {
    expect(encodeToRegisters(true, 'bool')).toEqual([1]);
    expect(decodeRegisters([0], 'bool')).toBe(false);
  });
});

describe('modbusUtils: CRC-16/MODBUS', () => {
  test('эталонные значения', () => {
    // FC3 slave 1, holding 0 x10 → CRC C5CD (в кадре младшим байтом вперёд: C5 CD)
    expect(crc16(Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x0a]))).toBe(0xcdc5);
    expect(crc16(Buffer.from('123456789'))).toBe(0x4b37);
  });

  test('isValidRtuFrame', () => {
    const frame = Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x0a, 0xc5, 0xcd]);
    expect(isValidRtuFrame(frame)).toBe(true);
    const bad = Buffer.from(frame);
    bad[3] ^= 1;
    expect(isValidRtuFrame(bad)).toBe(false);
    expect(isValidRtuFrame(Buffer.from([1, 3, 0]))).toBe(false);
    expect(isValidRtuFrame('01030000')).toBe(false);
  });
});
