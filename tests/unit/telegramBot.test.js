
const TelegramBot = require('../classes/telegramBot');

const TOKEN = '123456:SECRET-TOKEN-VALUE';
const okResponse = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
const errResponse = (status, body) => ({ ok: false, status, json: async () => body });
const waitFor = async (fn, ms = 1000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('TelegramBot.call', () => {
  test('отправляет POST на метод Bot API и возвращает result', async () => {
    const fetchImpl = jest.fn(async () => okResponse({ id: 1 }));
    const bot = new TelegramBot({ token: TOKEN, fetchImpl });
    const result = await bot.sendMessage('42', 'привет', { disable_notification: true });
    expect(result).toEqual({ id: 1 });

    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(opts.body)).toMatchObject({
      chat_id: '42', text: 'привет', parse_mode: 'HTML', disable_notification: true,
    });
  });

  test('обрезает текст до 4096 символов', async () => {
    const fetchImpl = jest.fn(async () => okResponse({}));
    const bot = new TelegramBot({ token: TOKEN, fetchImpl });
    await bot.sendMessage('1', 'x'.repeat(5000));
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).text).toHaveLength(4096);
  });

  test('ошибка API: код, retryAfter, без токена в тексте', async () => {
    const fetchImpl = jest.fn(async () => errResponse(429, {
      ok: false, error_code: 429, description: `Too Many Requests for ${TOKEN}`, parameters: { retry_after: 7 },
    }));
    const bot = new TelegramBot({ token: TOKEN, fetchImpl });
    const err = await bot.getMe().catch((e) => e);
    expect(err.name).toBe('TelegramApiError');
    expect(err.code).toBe(429);
    expect(err.retryAfter).toBe(7);
    expect(err.message).not.toContain('SECRET-TOKEN-VALUE');
  });

  test('сетевая ошибка не раскрывает токен', async () => {
    const fetchImpl = jest.fn(async (url) => { throw new Error(`connect failed ${url}`); });
    const bot = new TelegramBot({ token: TOKEN, fetchImpl });
    const err = await bot.getMe().catch((e) => e);
    expect(err.code).toBe('NETWORK');
    expect(err.message).not.toContain('SECRET-TOKEN-VALUE');
  });

  test('таймаут запроса даёт NETWORK', async () => {
    const fetchImpl = jest.fn((url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const bot = new TelegramBot({ token: TOKEN, fetchImpl, requestTimeoutMs: 20 });
    const err = await bot.getMe().catch((e) => e);
    expect(err.code).toBe('NETWORK');
  });

  test('требует token', () => {
    expect(() => new TelegramBot({ fetchImpl: () => {} })).toThrow('token');
  });
});

describe('TelegramBot polling', () => {
  test('обрабатывает обновления, сдвигает offset и корректно останавливается', async () => {
    let calls = 0;
    const bodies = [];
    const fetchImpl = jest.fn((url, opts) => {
      calls++;
      bodies.push(JSON.parse(opts.body));
      if (calls === 1) return Promise.resolve(okResponse([{ update_id: 5, message: {} }, { update_id: 6, message: {} }]));
      return new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    });
    const bot = new TelegramBot({ token: TOKEN, fetchImpl });
    const seen = [];

    bot.start(async (u) => { seen.push(u.update_id); }, { pollTimeoutS: 1 });
    await waitFor(() => calls >= 2);
    expect(seen).toEqual([5, 6]);
    expect(bodies[1].offset).toBe(7);

    await bot.stop();
    expect(bot.polling).toBe(false);
  });

  test('ошибка обработчика не останавливает polling', async () => {
    let calls = 0;
    const fetchImpl = jest.fn((url, opts) => {
      calls++;
      if (calls === 1) return Promise.resolve(okResponse([{ update_id: 1 }, { update_id: 2 }]));
      return new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    });
    const bot = new TelegramBot({ token: TOKEN, fetchImpl });
    const seen = [];
    bot.start(async (u) => { seen.push(u.update_id); if (u.update_id === 1) throw new Error('bad'); }, { pollTimeoutS: 1 });
    await waitFor(() => seen.length === 2);
    await bot.stop();
    expect(seen).toEqual([1, 2]);
  });

  test('после ошибки getUpdates повторяет запрос', async () => {
    let calls = 0;
    const fetchImpl = jest.fn((url, opts) => {
      calls++;
      if (calls === 1) return Promise.resolve(errResponse(500, { ok: false, error_code: 500, description: 'oops' }));
      return new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    });
    const bot = new TelegramBot({ token: TOKEN, fetchImpl });
    bot.start(async () => {}, { pollTimeoutS: 1, retryMinMs: 5, retryMaxMs: 10 });
    await waitFor(() => calls >= 2);
    await bot.stop();
  });
});
