
const { createNotifyService } = require('../services/notifyService');
const nc = require('../services/notifyConfig');

const OPEN = 1;

function setup({ sessions = {}, connections = [], users = [], telegram = true } = {}) {
  const time = { t: 1000000 };
  const wsManager = { getUserConnections: jest.fn(() => connections) };
  const auth = { getSession: jest.fn((id) => sessions[id] || null) };
  const userStore = { findUsersForNotification: jest.fn(async () => users) };
  const tg = { sendToUsers: jest.fn(async (list) => list.length) };
  const service = createNotifyService({
    wsManager,
    auth,
    userStore,
    getTelegram: () => (telegram ? tg : null),
    config: { NOTIFY_DEDUP_TTL_MS: 1000, NOTIFY_HISTORY_SIZE: 3, SEVERITY_RANK: nc.SEVERITY_RANK },
    now: () => time.t,
    uuid: () => 'uuid-1',
  });
  return { service, tg, userStore, time };
}

const conn = (id, state = OPEN) => ({ clientId: id, connection: { ws: { readyState: state, send: jest.fn() } } });
const msg = (payload = {}, name = 'd1') => ({ type: 'message', name, payload: { message: 'Тест', ...payload } });

describe('notifyService.dispatch', () => {
  test('отклоняет некорректное сообщение', async () => {
    const { service } = setup();
    const res = await service.dispatch({ type: 'message', name: 'd1', payload: {} });
    expect(res.ok).toBe(false);
  });

  test('WS: доставляет только сессиям с нужным уровнем и dID', async () => {
    const a = conn('a');
    const b = conn('b');
    const c = conn('c');
    const d = conn('d');
    const { service } = setup({
      connections: [a, b, c, d],
      sessions: {
        a: { dID: 'd1', level: 2 },
        b: { dID: 'd1', level: 1 },
        c: { dID: 'other', level: 3 },
      },
    });
    const res = await service.dispatch(msg({ level: 2 }), { source: 'test' });
    expect(res.ok).toBe(true);
    expect(res.recipients.ws).toBe(1);
    expect(a.connection.ws.send).toHaveBeenCalledTimes(1);
    expect(b.connection.ws.send).not.toHaveBeenCalled();
    expect(c.connection.ws.send).not.toHaveBeenCalled();
    expect(d.connection.ws.send).not.toHaveBeenCalled();

    const sent = JSON.parse(a.connection.ws.send.mock.calls[0][0]);
    expect(sent).toMatchObject({ type: 'message', request: 'notify', name: 'd1' });
    expect(sent.payload).toMatchObject({ id: 'uuid-1', source: 'test', level: 2, message: 'Тест' });
    expect(sent.time).toBeDefined();
  });

  test('WS: закрытые сокеты пропускаются', async () => {
    const a = conn('a', 3);
    const { service } = setup({ connections: [a], sessions: { a: { dID: 'd1', level: 3 } } });
    expect((await service.dispatch(msg())).recipients.ws).toBe(0);
    expect(a.connection.ws.send).not.toHaveBeenCalled();
  });

  test('подавляет дубликаты в окне TTL и пропускает после', async () => {
    const { service, time } = setup();
    expect((await service.dispatch(msg())).deduped).toBe(false);
    expect((await service.dispatch(msg())).deduped).toBe(true);
    time.t += 1500;
    expect((await service.dispatch(msg())).deduped).toBe(false);
  });

  test('Telegram: фильтрует по chatId, mute и minSeverity', async () => {
    const mk = (username, extra = {}) => ({
      username,
      telegram: { chatId: '1' },
      notify: { telegram: true, minSeverity: 'info' },
      ...extra,
    });
    const users = [
      mk('ok'),
      mk('muted', { notify: { telegram: false, minSeverity: 'info' } }),
      mk('nochat', { telegram: { chatId: null } }),
      mk('alarmOnly', { notify: { telegram: true, minSeverity: 'alarm' } }),
    ];
    const { service, tg, userStore } = setup({ users });

    const res = await service.dispatch(msg({ severity: 'warning', level: 2 }));
    expect(userStore.findUsersForNotification).toHaveBeenCalledWith({ dID: 'd1', minLevel: 2 });
    expect(tg.sendToUsers.mock.calls[0][0].map((u) => u.username)).toEqual(['ok']);
    expect(res.recipients.telegram).toBe(1);
  });

  test('Telegram: alarm доходит до пользователей с minSeverity=alarm', async () => {
    const users = [{ username: 'x', telegram: { chatId: '1' }, notify: { telegram: true, minSeverity: 'alarm' } }];
    const { service, tg } = setup({ users });
    await service.dispatch(msg({ severity: 'alarm' }));
    expect(tg.sendToUsers).toHaveBeenCalledTimes(1);
  });

  test('сбой Telegram не ломает доставку по WS', async () => {
    const a = conn('a');
    const { service, tg } = setup({
      connections: [a],
      sessions: { a: { dID: 'd1', level: 1 } },
      users: [{ username: 'x', telegram: { chatId: '1' }, notify: {} }],
    });
    tg.sendToUsers.mockRejectedValue(new Error('boom'));
    const res = await service.dispatch(msg());
    expect(res.ok).toBe(true);
    expect(res.recipients).toEqual({ ws: 1, telegram: 0 });
  });

  test('без Telegram-сервиса работает только WS', async () => {
    const { service, userStore } = setup({ telegram: false });
    const res = await service.dispatch(msg());
    expect(res.recipients.telegram).toBe(0);
    expect(userStore.findUsersForNotification).not.toHaveBeenCalled();
  });
});

describe('notifyService.getRecent', () => {
  test('хранит ограниченную историю и фильтрует по уровню', async () => {
    const { service, time } = setup();
    for (let i = 1; i <= 4; i++) {
      await service.dispatch(msg({ message: `m${i}`, level: i === 3 ? 3 : 1 }));
      time.t += 10;
    }
    const lvl1 = service.getRecent('d1', 1).map((m) => m.payload.message);
    expect(lvl1).toEqual(['m2', 'm4']);
    const lvl3 = service.getRecent('d1', 3).map((m) => m.payload.message);
    expect(lvl3).toEqual(['m2', 'm3', 'm4']);
    expect(service.getRecent('unknown', 3)).toEqual([]);
  });
});
