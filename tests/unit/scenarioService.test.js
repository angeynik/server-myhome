// tests/unit/scenarioService.test.js
// Служба сценариев: правка, рассылка Vue (уровень ≥ 2) и доставка в Node-RED.
'use strict';

const WebSocket = require('ws');
const { createScenarioService } = require('../../services/scenarioService');

const DATA = { settings: { tzOffsetMin: 180 }, scenarios: { a: { id: 'a' } } };

function setup({ nred = 1 } = {}) {
  const ws = (open = true) => ({ readyState: open ? WebSocket.OPEN : WebSocket.CLOSED, send: jest.fn() });
  const vue = { v1: ws(), v2: ws(), v3: ws(), v4: ws(false) };
  const red = Array.from({ length: nred }, () => ws());
  const sessions = {
    v1: { dID: 'd1', level: 2 }, v2: { dID: 'd1', level: 1 }, v3: { dID: 'other', level: 3 }, v4: { dID: 'd1', level: 3 },
  };
  const wsManager = {
    getUserConnections: jest.fn((type) => (type === 'VUE_connections'
      ? Object.entries(vue).map(([clientId, w]) => ({ clientId, connection: { ws: w } }))
      : red.map((w, i) => ({ clientId: `r${i}`, connection: { ws: w } })))),
  };
  const auth = { getSession: (id) => sessions[id] };
  const store = {
    read: jest.fn(async () => DATA),
    save: jest.fn(async (dID, raw) => ({ id: raw.id, created: true, data: DATA })),
    remove: jest.fn(async (dID, id) => ({ id, data: DATA })),
    setEnabled: jest.fn(async (dID, id) => ({ id, data: DATA })),
    saveSettings: jest.fn(async () => ({ id: null, data: DATA })),
  };
  return { svc: createScenarioService({ store, wsManager, auth }), vue, red, store };
}

const parsed = (w) => JSON.parse(w.send.mock.calls[0][0]);

test('правка: набор — Vue своего dID с уровнем ≥ 2 и Node-RED', async () => {
  const { svc, vue, red, store } = setup();
  const r = await svc.applyChange('d1', 'create', { id: 'a' }, { username: 'u' });
  expect(store.save).toHaveBeenCalledWith('d1', { id: 'a' }, { username: 'u' }, { mustBeNew: true });
  expect(r).toMatchObject({ id: 'a', delivered: 1 });
  expect(parsed(vue.v1)).toEqual({ type: 'response', request: 'scenarios', name: 'd1', payload: DATA });
  expect(vue.v2.send).not.toHaveBeenCalled(); // уровень 1
  expect(vue.v3.send).not.toHaveBeenCalled(); // чужой dID
  expect(vue.v4.send).not.toHaveBeenCalled(); // закрыто
  expect(parsed(red[0])).toMatchObject({ type: 'post', request: 'scenarios', name: 'd1', payload: DATA });
});

test('действия передаются хранилищу; неизвестное — BAD_ACTION', async () => {
  const { svc, store } = setup();
  await svc.applyChange('d1', 'edit', { id: 'a' });
  expect(store.save).toHaveBeenLastCalledWith('d1', { id: 'a' }, null, { mustExist: true });
  await svc.applyChange('d1', 'delete', { id: 'a' });
  expect(store.remove).toHaveBeenCalledWith('d1', 'a');
  await svc.applyChange('d1', 'enable', { id: 'a', enabled: false });
  expect(store.setEnabled).toHaveBeenCalledWith('d1', 'a', false, null);
  await svc.applyChange('d1', 'settings', { tzOffsetMin: 120 });
  expect(store.saveSettings).toHaveBeenCalledWith('d1', { tzOffsetMin: 120 });
  await expect(svc.applyChange('d1', 'drop', {})).rejects.toMatchObject({ code: 'BAD_ACTION' });
});

test('ошибка хранилища не рассылается', async () => {
  const { svc, vue, red, store } = setup();
  store.save.mockRejectedValue(Object.assign(new Error('bad'), { code: 'BAD_SCENARIO' }));
  await expect(svc.applyChange('d1', 'create', {})).rejects.toMatchObject({ code: 'BAD_SCENARIO' });
  expect(vue.v1.send).not.toHaveBeenCalled();
  expect(red[0].send).not.toHaveBeenCalled();
});

test('Node-RED подключился: сценарии есть — отправляются, файла нет — ничего; без Node-RED — 0', async () => {
  const { svc, red, store } = setup();
  expect(await svc.sendToNodeRED('d1')).toBe(1);
  expect(parsed(red[0]).payload).toEqual(DATA);
  store.read.mockResolvedValue(null);
  expect(await svc.sendToNodeRED('d1')).toBe(0);
  const none = setup({ nred: 0 });
  expect((await none.svc.applyChange('d1', 'delete', { id: 'a' })).delivered).toBe(0);
});
