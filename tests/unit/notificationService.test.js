// tests/unit/notificationService.test.js
// Служба уведомлений: активация и сброс, окно контроля, каналы, кадры камер, правки из клиента.
// Хранилище, WebSocket, Telegram и камеры — подделки в памяти.
'use strict';

const { createNotificationService } = require('../../services/notificationService');

const OPEN = 1;
const msk = (s) => Date.parse(`${s}:00+03:00`);

const ITEM = {
  id: 'room01:sensors:dTemp01', room: 'room01', section: 'sensors', item: 'dTemp01',
  group: 'Гостиная', roomTitle: 'Гостиная', title: 'Температура', unit: '°C',
  condition: { op: 'gt', value: 25 }, intervals: [], periods: [], cameras: [], channel: 'web',
};

function setup({ items = { [ITEM.id]: ITEM }, value = 20, users = [], frames = {} } = {}) {
  const files = { items, status: null, media: new Map() };
  let values = { room01: { sensors: { dTemp01: { value } } } };
  let t = msk('2026-06-15T10:00');
  let n = 0;

  const store = {
    list: jest.fn(async () => files.items),
    readStatus: jest.fn(async () => files.status),
    writeStatus: jest.fn(async (_, s) => { files.status = JSON.parse(JSON.stringify(s)); }),
    saveMedia: jest.fn(async (dID, ev, cam, jpeg) => { files.media.set(`${ev}_${cam}`, jpeg); }),
    readMedia: jest.fn(async (dID, ev, cam) => files.media.get(`${ev}_${cam}`) || null),
    removeMedia: jest.fn(async (dID, ev, cams) => cams.forEach((c) => files.media.delete(`${ev}_${c}`))),
    listDIDs: jest.fn(async () => ['igumen']),
    save: jest.fn(async (dID, item) => {
      const id = `${item.room}:${item.section}:${item.item}`;
      files.items = { ...files.items, [id]: { id, intervals: [], periods: [], cameras: [], channel: 'web', ...item } };
      return { items: files.items, id, created: true };
    }),
    remove: jest.fn(async (dID, { id }) => {
      const next = { ...files.items };
      delete next[id];
      files.items = next;
      return { items: next, id };
    }),
  };

  const sockets = { a: { readyState: OPEN, send: jest.fn() }, other: { readyState: OPEN, send: jest.fn() } };
  const wsManager = {
    getUserConnections: jest.fn((_, dID) => (dID === 'igumen'
      ? [{ clientId: 'a', connection: { ws: sockets.a } }]
      : [{ clientId: 'other', connection: { ws: sockets.other } }])),
  };
  const auth = { getSession: jest.fn((id) => ({ a: { dID: 'igumen', level: 1 }, other: { dID: 'x', level: 3 } }[id])) };
  const tg = { sendNotificationEvent: jest.fn(async (u) => u.length) };

  const svc = createNotificationService({
    store,
    readConfig: async () => values,
    wsManager,
    auth,
    userStore: { findUsersForNotification: jest.fn(async () => users) },
    getTelegram: () => tg,
    getFrame: (dID, cam) => frames[cam] || null,
    config: { NOTIFICATION_CHECK_INTERVAL_MS: 1000 },
    now: () => t,
    uuid: () => `ev-${++n}`,
  });

  const events = () => sockets.a.send.mock.calls.map(([raw]) => JSON.parse(raw)).filter((m) => m.request === 'notificationEvent');
  return {
    svc, store, files, tg, sockets, events,
    setValue: (v) => { values = { room01: { sensors: { dTemp01: { value: v } } } }; },
    setTime: (s) => { t = msk(s); },
  };
}

describe('notificationService: события', () => {
  test('условие выполнено — событие ON в веб, статус ON / прочитано OFF в файле', async () => {
    const { svc, setValue, events, files } = setup();
    await svc.checkDID('igumen');
    expect(events()).toHaveLength(0);

    setValue(26);
    await svc.checkDID('igumen');
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      type: 'post', request: 'notificationEvent', name: 'igumen',
      payload: {
        id: ITEM.id, eventId: 'ev-1', status: 'ON', value: 26, channel: 'web', room: 'room01', section: 'sensors', item: 'dTemp01',
        group: 'Гостиная', text: 'Гостиная · Температура: 26 °C (условие > 25 °C)',
      },
    });
    expect(files.status[ITEM.id]).toMatchObject({
      status: 'ON', read: 'OFF', eventId: 'ev-1', value: 26, channel: 'web', text: 'Гостиная · Температура: 26 °C (условие > 25 °C)',
    });
  });

  test('событие рассылается после записи статуса: кадр доступен сразу по событию', async () => {
    const frames = { cam01: { jpeg: Buffer.from('JPEG1'), timestamp: 5, cameraId: 'cam01', title: 'Ворота' } };
    const { svc, store, sockets } = setup({ items: { [ITEM.id]: { ...ITEM, cameras: ['cam01'] } }, value: 26, frames });
    let snapshotOnEvent;
    sockets.a.send.mockImplementation((raw) => {
      if (JSON.parse(raw).request === 'notificationEvent') snapshotOnEvent = svc.getSnapshot('igumen', ITEM.id, 'cam01');
    });
    await svc.checkDID('igumen');
    expect(store.writeStatus.mock.invocationCallOrder[0]).toBeLessThan(sockets.a.send.mock.invocationCallOrder[0]);
    expect(await snapshotOnEvent).toMatchObject({ cameraId: 'cam01', image: Buffer.from('JPEG1').toString('base64') });
  });

  test('пока условие выполняется — повторного события нет', async () => {
    const { svc, events } = setup({ value: 26 });
    await svc.checkDID('igumen');
    await svc.checkDID('igumen');
    expect(events()).toHaveLength(1);
  });

  test('условие перестало выполняться — сброс OFF с причиной condition', async () => {
    const { svc, setValue, events, files } = setup({ value: 26 });
    await svc.checkDID('igumen');
    setValue(24);
    await svc.checkDID('igumen');
    expect(events()[1].payload).toMatchObject({ status: 'OFF', reason: 'condition', value: 24, eventId: 'ev-1' });
    expect(files.status[ITEM.id]).toMatchObject({ status: 'OFF', read: 'OFF', attachments: [] });
  });

  test('вне интервала контроля — сброс (window), снова в окне — новое событие', async () => {
    const item = { ...ITEM, intervals: [{ from: '08:00', to: '20:00' }] };
    const { svc, setTime, events } = setup({ items: { [ITEM.id]: item }, value: 26 });
    await svc.checkDID('igumen');
    setTime('2026-06-15T21:00');
    await svc.checkDID('igumen');
    setTime('2026-06-16T09:00');
    await svc.checkDID('igumen');
    expect(events().map((e) => [e.payload.status, e.payload.reason, e.payload.eventId])).toEqual([
      ['ON', undefined, 'ev-1'], ['OFF', 'window', 'ev-1'], ['ON', undefined, 'ev-2'],
    ]);
  });

  test('нет значения параметра — условие не выполнено', async () => {
    const { svc, setValue, events } = setup({ value: 26 });
    await svc.checkDID('igumen');
    setValue(undefined);
    await svc.checkDID('igumen');
    expect(events()[1].payload.status).toBe('OFF');
  });

  test('события получают только соединения этого dID', async () => {
    const { svc, sockets } = setup({ value: 26 });
    await svc.checkDID('igumen');
    expect(sockets.other.send).not.toHaveBeenCalled();
  });
});

describe('notificationService: каналы и кадры', () => {
  const users = [
    { username: 'a', telegram: { chatId: 1 }, notify: {} },
    { username: 'b', telegram: { chatId: 2 }, notify: { telegram: false } },
    { username: 'c' },
  ];

  test('канал web — Telegram не используется', async () => {
    const { svc, tg } = setup({ value: 26, users });
    await svc.checkDID('igumen');
    expect(tg.sendNotificationEvent).not.toHaveBeenCalled();
  });

  test('канал both — веб и Telegram привязанным пользователям, у кого Telegram не выключен', async () => {
    const { svc, tg, events, setValue } = setup({ items: { [ITEM.id]: { ...ITEM, channel: 'both' } }, value: 26, users });
    await svc.checkDID('igumen');
    await new Promise((r) => setImmediate(r));
    expect(events()).toHaveLength(1);
    const [recipients, event] = tg.sendNotificationEvent.mock.calls[0];
    expect(recipients.map((u) => u.username)).toEqual(['a']);
    expect(event).toEqual({
      dID: 'igumen', status: 'ON', place: 'Гостиная · Температура', detail: '26 °C (условие > 25 °C)', time: '2026-06-15T07:00:00.000Z',
    });

    setValue(20); // сброс тоже уходит в Telegram — с причиной
    await svc.checkDID('igumen');
    await new Promise((r) => setImmediate(r));
    expect(tg.sendNotificationEvent.mock.calls[1][1]).toMatchObject({
      status: 'OFF', detail: 'условие больше не выполняется, сейчас 20 °C',
    });
  });

  test('канал telegram — в веб всё равно приходит статус (обводка плашки)', async () => {
    const { svc, events } = setup({ items: { [ITEM.id]: { ...ITEM, channel: 'telegram' } }, value: 26, users });
    await svc.checkDID('igumen');
    expect(events()[0].payload).toMatchObject({ status: 'ON', channel: 'telegram' });
  });

  test('кадры камер: сохраняются, уходят в Telegram, отдаются по запросу, удаляются при сбросе', async () => {
    const frames = { cam01: { jpeg: Buffer.from('JPEG1'), timestamp: 5, cameraId: 'cam01', title: 'Ворота' } };
    const item = { ...ITEM, cameras: ['cam01', 'cam02'], channel: 'both' };
    const { svc, setValue, files, tg, events } = setup({ items: { [ITEM.id]: item }, value: 26, users, frames });
    await svc.checkDID('igumen');
    await new Promise((r) => setImmediate(r));

    expect(events()[0].payload.attachments).toEqual([{ cameraId: 'cam01', title: 'Ворота', timestamp: 5 }]); // у cam02 кадра нет
    expect(tg.sendNotificationEvent.mock.calls[0][2]).toEqual([{ jpeg: frames.cam01.jpeg, caption: 'Ворота · Гостиная · igumen' }]);
    expect(await svc.getSnapshot('igumen', ITEM.id, 'cam01')).toMatchObject({ image: Buffer.from('JPEG1').toString('base64'), title: 'Ворота' });

    setValue(1);
    await svc.checkDID('igumen');
    expect(files.media.size).toBe(0);
    expect(await svc.getSnapshot('igumen', ITEM.id, 'cam01')).toBeNull();
  });
});

describe('notificationService: правки из клиента', () => {
  test('create — запись, конфигурация всем клиентам dID, немедленная проверка', async () => {
    const { svc, store, sockets, events } = setup({ items: {}, value: 30 });
    await svc.applyChange('igumen', 'create', { room: 'room01', section: 'sensors', item: 'dTemp01', condition: { op: 'gt', value: 25 } }, { username: 'anna' });
    expect(store.save).toHaveBeenCalledWith('igumen', expect.objectContaining({ item: 'dTemp01' }), { username: 'anna' });
    const cfg = JSON.parse(sockets.a.send.mock.calls[0][0]);
    expect(cfg).toMatchObject({ type: 'response', request: 'notification', name: 'igumen' });
    expect(Object.keys(cfg.payload)).toEqual(['room01:sensors:dTemp01']);
    await new Promise((r) => setImmediate(r));
    await svc.checkDID('igumen');
    expect(events()[0].payload.status).toBe('ON');
  });

  test('delete активного — сброс removed, запись статуса убирается', async () => {
    const { svc, files, events } = setup({ value: 26 });
    await svc.checkDID('igumen');
    await svc.applyChange('igumen', 'delete', { id: ITEM.id });
    await svc.checkDID('igumen');
    expect(events().at(-1).payload).toMatchObject({ id: ITEM.id, status: 'OFF', reason: 'removed' });
    expect(files.status).toEqual({});
  });

  test('неизвестное действие — ошибка BAD_ACTION', async () => {
    const { svc } = setup();
    await expect(svc.applyChange('igumen', 'drop', {})).rejects.toMatchObject({ code: 'BAD_ACTION' });
  });

  test('checkAll обходит dID из хранилища; start/stop', async () => {
    jest.useFakeTimers();
    try {
      const { svc, store } = setup();
      svc.start();
      expect(store.listDIDs).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1000);
      expect(store.listDIDs).toHaveBeenCalledTimes(2);
      svc.stop();
      await jest.advanceTimersByTimeAsync(5000);
      expect(store.listDIDs).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
