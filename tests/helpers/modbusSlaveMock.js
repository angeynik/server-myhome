// tests/helpers/modbusSlaveMock.js
// Простой Modbus TCP slave на голом net для тестов: поднимает реальный сервер,
// отвечает на 01/03/04/05/06/10, умеет "молчать" (таймаут) и отдавать
// modbus-исключение один раз - чтобы проверять обработку ошибок на стороне мастера.

'use strict';

const net = require('net');

class ModbusSlaveMock {
  constructor() {
    this.server = null;
    this.port = null;
    this.sockets = new Set();
    this.holding = new Map(); // address -> uint16
    this.coils = new Map();   // address -> boolean
    this.silentCount = 0;     // следующие N запросов остаются без ответа (эмуляция таймаута)
    this.exceptionOnce = null; // { fc, code } - один раз ответить modbus-исключением
    this.delayMs = 0;
  }

  start(port = 0) {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this._handleSocket(socket));
      this.server.on('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      for (const s of this.sockets) s.destroy();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  setHoldingRegisters(start, values) {
    values.forEach((v, i) => this.holding.set(start + i, v & 0xffff));
  }

  getHoldingRegisters(start, count) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(this.holding.get(start + i) ?? 0);
    return out;
  }

  _handleSocket(socket) {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {}); // ECONNRESET при принудительном destroy - ожидаемо

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 7) {
        const length = buf.readUInt16BE(4);
        const total = 6 + length;
        if (buf.length < total) return;
        const frame = buf.subarray(0, total);
        buf = buf.subarray(total);
        this._handleFrame(socket, frame);
      }
    });
  }

  _handleFrame(socket, frame) {
    const tid = frame.readUInt16BE(0);
    const unit = frame.readUInt8(6);
    const fc = frame.readUInt8(7);

    const respond = (pdu) => {
      const send = () => {
        if (socket.destroyed) return;
        const out = Buffer.alloc(7 + pdu.length);
        out.writeUInt16BE(tid, 0);
        out.writeUInt16BE(0, 2);
        out.writeUInt16BE(pdu.length + 1, 4);
        out.writeUInt8(unit, 6);
        pdu.copy(out, 7);
        socket.write(out);
      };
      if (this.delayMs) setTimeout(send, this.delayMs); else send();
    };

    if (this.silentCount > 0) {
      this.silentCount--;
      return; // имитируем отсутствие ответа (таймаут на стороне мастера)
    }
    if (this.exceptionOnce && this.exceptionOnce.fc === fc) {
      const { code } = this.exceptionOnce;
      this.exceptionOnce = null;
      return respond(Buffer.from([fc | 0x80, code]));
    }

    try {
      switch (fc) {
        case 0x03:
        case 0x04: { // read holding / input registers (единый банк для тестов)
          const address = frame.readUInt16BE(8);
          const qty = frame.readUInt16BE(10);
          const values = this.getHoldingRegisters(address, qty);
          const data = Buffer.alloc(2 + qty * 2);
          data.writeUInt8(fc, 0);
          data.writeUInt8(qty * 2, 1);
          values.forEach((v, i) => data.writeUInt16BE(v, 2 + i * 2));
          respond(data);
          break;
        }
        case 0x06: { // write single register
          const address = frame.readUInt16BE(8);
          const value = frame.readUInt16BE(10);
          this.holding.set(address, value);
          respond(frame.subarray(7)); // эхо PDU
          break;
        }
        case 0x10: { // write multiple registers
          const address = frame.readUInt16BE(8);
          const qty = frame.readUInt16BE(10);
          for (let i = 0; i < qty; i++) {
            this.holding.set(address + i, frame.readUInt16BE(13 + i * 2));
          }
          const data = Buffer.alloc(5);
          data.writeUInt8(fc, 0);
          data.writeUInt16BE(address, 1);
          data.writeUInt16BE(qty, 3);
          respond(data);
          break;
        }
        case 0x01: { // read coils
          const address = frame.readUInt16BE(8);
          const qty = frame.readUInt16BE(10);
          const byteCount = Math.ceil(qty / 8);
          const data = Buffer.alloc(2 + byteCount);
          data.writeUInt8(fc, 0);
          data.writeUInt8(byteCount, 1);
          for (let i = 0; i < qty; i++) {
            if (this.coils.get(address + i)) data[2 + (i >> 3)] |= 1 << (i & 7);
          }
          respond(data);
          break;
        }
        case 0x05: { // write single coil
          const address = frame.readUInt16BE(8);
          const raw = frame.readUInt16BE(10);
          this.coils.set(address, raw === 0xff00);
          respond(frame.subarray(7));
          break;
        }
        default:
          respond(Buffer.from([fc | 0x80, 0x01])); // ILLEGAL_FUNCTION
      }
    } catch {
      respond(Buffer.from([fc | 0x80, 0x04])); // SERVER_DEVICE_FAILURE
    }
  }
}

module.exports = ModbusSlaveMock;
