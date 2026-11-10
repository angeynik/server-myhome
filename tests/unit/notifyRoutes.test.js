
const express = require('express');
const { createNotifyRouter, toEnvelope } = require('../routes/notifyRoutes');

const KEY = 'k'.repeat(32);
let server;
let base;

async function start({ apiKey = KEY, rate = 60, dispatch } = {}) {
  const notifyService = { dispatch: dispatch || jest.fn(async () => ({ ok: true, id: 'id-1', deduped: false, recipients: { ws: 1, telegram: 0 } })) };
  const app = express();
  app.use(express.json());
  app.use(createNotifyRouter({
    notifyService,
    config: { NOTIFY_API_KEY: apiKey, NOTIFY_HTTP_RATE_PER_MIN: rate },
  }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  return notifyService;
}

const post = (body, headers = {}) => fetch(`${base}/api/notify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
});

describe('POST /api/notify', () => {
  test('401 без ключа и с неверным ключом', async () => {
    const svc = await start();
    expect((await post({ dID: 'd1', message: 'x' })).status).toBe(401);
    expect((await post({ dID: 'd1', message: 'x' }, { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect(svc.dispatch).not.toHaveBeenCalled();
  });

  test('503, если ключ не настроен', async () => {
    await start({ apiKey: '' });
    expect((await post({ dID: 'd1', message: 'x' }, { Authorization: `Bearer ${KEY}` })).status).toBe(503);
  });

  test('202 и преобразование короткой формы в сообщение', async () => {
    const svc = await start();
    const res = await post(
      { dID: 'd1', level: 2, message: 'Протечка', severity: 'alarm', room: 'room1' },
      { Authorization: `Bearer ${KEY}` }
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, id: 'id-1' });
    expect(svc.dispatch).toHaveBeenCalledWith(
      {
        type: 'message',
        request: 'notify',
        name: 'd1',
        payload: { level: 2, message: 'Протечка', title: undefined, severity: 'alarm', room: 'room1', item_name: undefined },
      },
      { source: 'http' }
    );
  });

  test('принимает X-API-Key и полную форму сообщения', async () => {
    const svc = await start();
    const full = { type: 'message', name: 'd1', payload: { message: 'x' } };
    expect((await post(full, { 'X-API-Key': KEY })).status).toBe(202);
    expect(svc.dispatch.mock.calls[0][0]).toEqual(full);
  });

  test('400 при ошибке валидации', async () => {
    await start({ dispatch: jest.fn(async () => ({ ok: false, error: '"payload.message" is required' })) });
    const res = await post({ dID: 'd1' }, { Authorization: `Bearer ${KEY}` });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('message');
  });

  test('500 при исключении без утечки деталей', async () => {
    await start({ dispatch: jest.fn(async () => { throw new Error('secret internals'); }) });
    const res = await post({ dID: 'd1', message: 'x' }, { Authorization: `Bearer ${KEY}` });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret internals');
  });

  test('429 при превышении лимита запросов', async () => {
    await start({ rate: 2 });
    const h = { Authorization: `Bearer ${KEY}` };
    expect((await post({ dID: 'd1', message: 'x' }, h)).status).toBe(202);
    expect((await post({ dID: 'd1', message: 'x' }, h)).status).toBe(202);
    expect((await post({ dID: 'd1', message: 'x' }, h)).status).toBe(429);
  });
});

describe('toEnvelope', () => {
  test('поддерживает name вместо dID', () => {
    expect(toEnvelope({ name: 'd1', message: 'x' }).name).toBe('d1');
  });

  test('пустое тело не падает', () => {
    expect(toEnvelope(undefined).type).toBe('message');
  });
});
