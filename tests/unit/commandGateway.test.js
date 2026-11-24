// tests/unit/commandGateway.test.js
// Единый механизм команд: мост Modbus (результат устройства) или handlePost + рассылка.
'use strict';

const { createCommandGateway } = require('../../services/commandGateway');

const msg = (request = 'setpoints', payload = { room: 'room01', setKey: 'sTemp01', value: 22 }) =>
  ({ type: 'post', request, name: 'igumen', payload });

function setup({ bridgeHandles = false, bridgeResult = { ok: true, value: 22 }, postResult = { ok: true }, timeoutMs = 50 } = {}) {
  const handlePost = jest.fn(async () => postResult);
  const broadcast = jest.fn();
  const bridge = {
    name: 'modbus',
    enabled: () => true,
    handleCommand: jest.fn((clientId, message, { onResult }) => {
      if (!bridgeHandles) return false;
      if (bridgeResult) setImmediate(() => onResult(bridgeResult));
      return true;
    }),
  };
  const gw = createCommandGateway({ handlePost, broadcast, bridges: [{ name: 'off', enabled: () => false, handleCommand: jest.fn() }, bridge], timeoutMs });
  return { gw, handlePost, broadcast, bridge };
}

describe('commandGateway', () => {
  test('не тег Modbus: handlePost, затем рассылка остальным клиентам dID (отправитель исключается)', async () => {
    const { gw, handlePost, broadcast } = setup();
    const res = await gw.execute({ dID: 'igumen', message: msg(), clientId: 'c1' });
    expect(res).toEqual({ ok: true, via: 'config' });
    expect(handlePost).toHaveBeenCalledWith('c1', msg());
    expect(broadcast).toHaveBeenCalledWith('c1', 'igumen', msg());
  });

  test('без соединения (бот): clientId null — рассылка всем клиентам dID', async () => {
    const { gw, broadcast } = setup();
    await gw.execute({ dID: 'igumen', message: msg() });
    expect(broadcast).toHaveBeenCalledWith(null, 'igumen', msg());
  });

  test('ошибка handlePost — результат с ошибкой, без рассылки', async () => {
    const { gw, broadcast } = setup({ postResult: { ok: false, error: 'нет комнаты', code: 'setpointError' } });
    expect(await gw.execute({ dID: 'igumen', message: msg() })).toEqual({ ok: false, error: 'нет комнаты', code: 'setpointError', via: 'config' });
    expect(broadcast).not.toHaveBeenCalled();
  });

  test('тег Modbus: результат устройства, handlePost и рассылка не вызываются (мост делает сам)', async () => {
    const { gw, handlePost, broadcast, bridge } = setup({ bridgeHandles: true });
    expect(await gw.execute({ dID: 'igumen', message: msg(), clientId: 'c1' })).toEqual({ ok: true, value: 22, via: 'modbus' });
    expect(bridge.handleCommand).toHaveBeenCalledWith('c1', msg(), { onResult: expect.any(Function) });
    expect(handlePost).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  test('устройство не ответило — TIMEOUT', async () => {
    const { gw } = setup({ bridgeHandles: true, bridgeResult: null });
    expect(await gw.execute({ dID: 'igumen', message: msg() })).toMatchObject({ ok: false, code: 'TIMEOUT', via: 'modbus' });
  });

  test('NO_BROADCAST_POST (служебные, пароли): мимо мостов и без рассылки', async () => {
    const { gw, bridge, broadcast, handlePost } = setup({ bridgeHandles: true });
    await gw.execute({ dID: 'igumen', message: msg('createUser', { username: 'x' }), clientId: 'c1' });
    expect(bridge.handleCommand).not.toHaveBeenCalled();
    expect(handlePost).toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });
});
