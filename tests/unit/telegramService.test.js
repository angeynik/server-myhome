// tests/unit/telegramService.test.js
// Сервис Telegram: регистрация через бота (код → логин → пароль), блокировка после ошибок,
// привязка кодом из приложения, несколько учётных записей на один чат, команды, отправка.
const {
  createTelegramService, formatNotification, formatNotificationEvent, fileBlockStore,
} = require('../../services/telegramService');

const config = {
  TELEGRAM_LINK_TTL_MS: 1000,
  TELEGRAM_BAD_CODE_LIMIT: 3,
  TELEGRAM_BAD_CODE_LOCK_MS: 24 * 3600 * 1000,
  TELEGRAM_RATE_PER_MIN: 30,
  TELEGRAM_MAX_INPUT_LEN: 100,
  TELEGRAM_POLL_TIMEOUT_S: 1,
  TELEGRAM_REGISTRATION_CODE: 'SECRET-42',
  TELEGRAM_DIALOG_TTL_MS: 60000,
};

const account = (extra = {}) => ({
  username: 'ivan', uid: 'u-1', dID: 'd1', permissionLevel: 2, disabled: false,
  telegram: { chatId: '42' }, notify: { telegram: true, minSeverity: 'info' }, ...extra,
});

// linked — учётные записи, уже привязанные к чату 42
function setup({ linked = [], forwardResult = true, cfg = {}, blocks = {} } = {}) {
  const time = { t: 1000 };
  let msgId = 100;
  const bot = {
    sendMessage: jest.fn(async () => ({})),
    sendPhoto: jest.fn(async () => ({})),
    deleteMessage: jest.fn(async () => true),
    getMe: jest.fn(async () => ({ username: 'my_bot' })),
    setMyCommands: jest.fn(async () => true),
    start: jest.fn(),
    stop: jest.fn(async () => {}),
  };
  const accounts = linked.map((l) => account(l));
  const passwords = { ivan: 'longpassword', petr: 'petrpassword' };
  const records = { ivan: account(), petr: account({ username: 'petr', uid: 'u-2', dID: 'd2', permissionLevel: 1 }) };
  const userStore = {
    findAllByTelegramChatId: jest.fn(async (id) => (String(id) === '42' ? accounts : [])),
    verifyCredentials: jest.fn(async (u, p) => (passwords[String(u).toLowerCase()] === p ? records[String(u).toLowerCase()] : null)),
    setTelegram: jest.fn(async (username) => records[username] || { username, dID: 'd1', permissionLevel: 2 }),
    clearTelegram: jest.fn(async () => ({})),
    updateOwnProfile: jest.fn(async () => ({})),
  };
  const saved = { data: blocks };
  const blockStore = { load: jest.fn(() => saved.data), save: jest.fn((d) => { saved.data = JSON.parse(JSON.stringify(d)); }) };
  const forward = jest.fn(() => forwardResult);
  const sleep = jest.fn(async () => {});
  const service = createTelegramService({
    bot, userStore, forward, config: { ...config, ...cfg }, now: () => time.t, sleep, blockStore,
  });
  const say = (text, chatId = 42, type = 'private') => service.handleUpdate({
    message: { message_id: ++msgId, text, chat: { id: chatId, type }, from: { username: 'tg_ivan', first_name: 'Иван' } },
  });
  return { service, bot, userStore, forward, sleep, time, say, saved, blockStore };
}

const lastReply = (bot) => bot.sendMessage.mock.calls.at(-1)[1];
const replies = (bot) => bot.sendMessage.mock.calls.map((c) => c[1]);

describe('telegramService: регистрация через бота', () => {
  test('незнакомый чат: любое сообщение → код → логин → пароль → подключение', async () => {
    const { bot, userStore, say } = setup();
    await say('привет');
    expect(lastReply(bot)).toContain('введите код регистрации');
    await say('SECRET-42');
    expect(lastReply(bot)).toContain('Введите логин');
    await say('Ivan');
    expect(lastReply(bot)).toContain('Введите пароль');
    await say('longpassword');

    expect(userStore.verifyCredentials).toHaveBeenCalledWith('Ivan', 'longpassword');
    expect(userStore.setTelegram).toHaveBeenCalledWith('ivan', { chatId: '42', username: 'tg_ivan', firstName: 'Иван' });
    expect(lastReply(bot)).toContain('Подключена учётная запись <b>ivan</b> (конфигурация <i>d1</i>)');
  });

  test('сообщение с паролем удаляется из чата', async () => {
    const { bot, say } = setup();
    for (const t of ['x', 'SECRET-42', 'ivan']) await say(t);
    await say('longpassword');
    expect(bot.deleteMessage).toHaveBeenCalledWith('42', 104);
  });

  test('неверный код — «Ошибка подключения», остаток попыток; повторный ввод кода', async () => {
    const { bot, userStore, say } = setup();
    await say('привет');
    await say('WRONG');
    expect(lastReply(bot)).toBe('❌ Ошибка подключения: неверный код. Осталось попыток: 2.');
    await say('SECRET-42');
    expect(lastReply(bot)).toContain('Введите логин');
    expect(userStore.setTelegram).not.toHaveBeenCalled();
  });

  test('неверный логин или пароль — «Ошибка подключения», снова запрос логина', async () => {
    const { bot, userStore, say } = setup();
    for (const t of ['x', 'SECRET-42', 'nobody']) await say(t);
    await say('whatever');
    expect(replies(bot).at(-2)).toBe('❌ Ошибка подключения: неверный логин или пароль. Осталось попыток: 2.');
    expect(lastReply(bot)).toBe('Введите логин учётной записи.');
    await say('ivan');
    await say('longpassword');
    expect(userStore.setTelegram).toHaveBeenCalledWith('ivan', expect.anything());
  });

  test('отключённая учётная запись не подключается', async () => {
    const { bot, userStore, say } = setup();
    userStore.verifyCredentials.mockResolvedValueOnce(account({ disabled: true }));
    for (const t of ['x', 'SECRET-42', 'ivan', 'longpassword']) await say(t);
    expect(userStore.setTelegram).not.toHaveBeenCalled();
    expect(replies(bot).at(-2)).toContain('Ошибка подключения');
  });

  test('после N ошибок чат блокируется на сутки: сообщения не обрабатываются; блокировка сохраняется', async () => {
    const { bot, say, time, saved } = setup();
    await say('x');
    for (let i = 0; i < 3; i++) await say('WRONG');
    expect(lastReply(bot)).toContain('не принимаются 24 часа');
    expect(saved.data['42']).toMatchObject({ count: 3, until: 1000 + 24 * 3600 * 1000 });

    const before = bot.sendMessage.mock.calls.length;
    await say('SECRET-42');
    await say('/start');
    expect(bot.sendMessage.mock.calls.length).toBe(before); // молчит

    time.t += 24 * 3600 * 1000 + 1;
    await say('привет');
    expect(lastReply(bot)).toContain('введите код регистрации');
  });

  test('блокировка из файла действует после перезапуска', async () => {
    const { bot, say, service } = setup({ blocks: { 42: { count: 3, until: 999999999 } } });
    expect(service.isBlocked('42')).toBe(true);
    await say('привет');
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  test('/cancel прерывает регистрацию; в шаге пароля «/…» считается паролем', async () => {
    const { bot, userStore, say } = setup();
    for (const t of ['x', 'SECRET-42', 'ivan']) await say(t);
    await say('/weird-pass');
    expect(userStore.verifyCredentials).toHaveBeenCalledWith('ivan', '/weird-pass');
    await say('/cancel');
    expect(lastReply(bot)).toBe('Подключение отменено.');
  });

  test.each(['secret-42', ' SECRET-42 ', 'SECRET\u200B-42', 'Secret-42'])(
    'код принимается без учёта регистра, пробелов и невидимых символов: %p',
    async (input) => {
      const { bot, say } = setup();
      await say('привет');
      await say(input);
      expect(lastReply(bot)).toContain('Введите логин');
    },
  );

  test('кириллические буквы-двойники в коде (русская раскладка) принимаются', async () => {
    const { bot, say } = setup({ cfg: { TELEGRAM_REGISTRATION_CODE: '7q4SxLX2' } });
    await say('привет');
    await say('7q4SхLХ2'); // х и Х — кириллица
    expect(lastReply(bot)).toContain('Введите логин');
  });

  test('похожий, но другой код не принимается', async () => {
    const { bot, say } = setup();
    await say('привет');
    await say('SECRET-43');
    expect(lastReply(bot)).toContain('неверный код');
  });

  test('регистрация через бота выключена (нет кода) — инструкция про код из приложения', async () => {
    const { bot, say } = setup({ cfg: { TELEGRAM_REGISTRATION_CODE: '' } });
    await say('привет');
    expect(lastReply(bot)).toContain('/start КОД');
  });

  test('диалог истекает — начинается заново', async () => {
    const { bot, say, time } = setup();
    await say('x');
    await say('SECRET-42');
    time.t += 61000;
    await say('ivan');
    expect(lastReply(bot)).toContain('введите код регистрации');
  });
});

describe('telegramService: несколько учётных записей на один чат', () => {
  test('/add подключает ещё одну запись (другой dID)', async () => {
    const { bot, userStore, say } = setup({ linked: [{}] });
    await say('/add');
    expect(lastReply(bot)).toContain('введите код регистрации');
    for (const t of ['SECRET-42', 'petr', 'petrpassword']) await say(t);
    expect(userStore.setTelegram).toHaveBeenCalledWith('petr', expect.anything());
    expect(lastReply(bot)).toContain('конфигурация <i>d2</i>');
  });

  test('/status показывает все записи; /unlink ЛОГИН — одну, /unlink — все', async () => {
    const { bot, userStore, say } = setup({ linked: [{}, { username: 'petr', dID: 'd2' }] });
    await say('/status');
    expect(lastReply(bot)).toContain('<b>ivan</b> — конфигурация <i>d1</i>');
    expect(lastReply(bot)).toContain('<b>petr</b> — конфигурация <i>d2</i>');
    await say('/unlink PETR');
    expect(userStore.clearTelegram.mock.calls).toEqual([['petr']]);
    await say('/unlink');
    expect(userStore.clearTelegram.mock.calls.slice(1)).toEqual([['ivan'], ['petr']]);
    await say('/unlink kolya');
    expect(lastReply(bot)).toContain('не подключена');
  });

  test('/mute и /unmute — для всех записей чата', async () => {
    const { userStore, say } = setup({ linked: [{}, { username: 'petr', dID: 'd2' }] });
    await say('/mute');
    expect(userStore.updateOwnProfile.mock.calls).toEqual([
      ['ivan', { notify: { telegram: false } }], ['petr', { notify: { telegram: false } }],
    ]);
    await say('/unmute@my_bot');
    expect(userStore.updateOwnProfile).toHaveBeenLastCalledWith('petr', { notify: { telegram: true } });
  });

  test('текст привязанного чата уходит в систему по каждому dID', async () => {
    const { forward, bot, say } = setup({ linked: [{}, { username: 'petr', uid: 'u-2', dID: 'd2', permissionLevel: 1 }] });
    await say('включи свет');
    expect(forward.mock.calls.map(([m]) => [m.name, m.payload.from.username, m.payload.level])).toEqual([
      ['d1', 'ivan', 2], ['d2', 'petr', 1],
    ]);
    expect(forward.mock.calls[0][0]).toMatchObject({ type: 'message', request: 'telegramIn', payload: { message: 'включи свет' } });
    expect(lastReply(bot)).toBe('✓ Принято');
  });
});

describe('telegramService: привязка кодом из приложения', () => {
  test('/start КОД привязывает чат; код одноразовый', async () => {
    const { service, bot, userStore, say } = setup();
    await service.start();
    const link = service.createLinkCode('ivan');
    expect(link.deepLink).toBe(`https://t.me/my_bot?start=${link.code}`);
    await say(`/start ${link.code.slice(0, 4).toLowerCase()} ${link.code.slice(4)}`);
    expect(userStore.setTelegram).toHaveBeenCalledWith('ivan', { chatId: '42', username: 'tg_ivan', firstName: 'Иван' });
    expect(lastReply(bot)).toContain('Подключена');
    await say(`/start ${link.code}`);
    expect(userStore.setTelegram).toHaveBeenCalledTimes(1);
    expect(lastReply(bot)).toContain('код недействителен или истёк');
  });

  test('просроченный или заменённый код отклоняется и считается ошибкой', async () => {
    const { service, userStore, say, time, saved } = setup();
    const first = service.createLinkCode('ivan');
    service.createLinkCode('ivan');
    await say(`/start ${first.code}`);
    const { code } = service.createLinkCode('ivan');
    time.t += 2000;
    await say(`/start ${code}`);
    expect(userStore.setTelegram).not.toHaveBeenCalled();
    expect(saved.data['42'].count).toBe(2);
  });
});

describe('telegramService: входящие сообщения', () => {
  test('групповые чаты и не-текст игнорируются', async () => {
    const { service, bot, say } = setup({ linked: [{}] });
    await say('привет', 42, 'group');
    await service.handleUpdate({ message: { chat: { id: 42, type: 'private' }, photo: [] } });
    await service.handleUpdate({});
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  test('если приём отключён — сообщаем об этом', async () => {
    const { bot, say } = setup({ linked: [{}], forwardResult: false });
    await say('привет');
    expect(lastReply(bot)).toContain('отключён');
  });

  test('отключённая учётная запись не пересылает сообщения', async () => {
    const { forward, say } = setup({ linked: [{ disabled: true }] });
    await say('привет');
    expect(forward).not.toHaveBeenCalled();
  });

  test('слишком длинный текст обрезается', async () => {
    const { forward, say } = setup({ linked: [{}] });
    await say('x'.repeat(500));
    expect(forward.mock.calls[0][0].payload.message).toHaveLength(100);
  });

  test('ограничение частоты по чату', async () => {
    const { forward, say } = setup({ linked: [{}], cfg: { TELEGRAM_RATE_PER_MIN: 5 } });
    for (let i = 0; i < 8; i++) await say(`m${i}`);
    expect(forward).toHaveBeenCalledTimes(5);
  });

  test('неизвестная команда — справка', async () => {
    const { bot, say } = setup({ linked: [{}] });
    await say('/foo');
    expect(lastReply(bot)).toContain('Команды');
  });
});

describe('telegramService: уведомления по условиям', () => {
  const event = { dID: 'igumen', status: 'ON', place: 'Гостиная · Температура', detail: '26 °C (условие > 25 °C)', time: '2026-11-18T09:12:00.000Z' };

  test('формат: место, что произошло, время по МСК и dID; HTML экранируется', () => {
    expect(formatNotificationEvent(event)).toBe(
      '🚨 <b>Гостиная · Температура</b>\n26 °C (условие &gt; 25 °C)\n🕒 18.11.2026, 12:12:00 · <i>igumen</i>'
    );
    expect(formatNotificationEvent({ ...event, status: 'OFF', detail: 'условие больше не выполняется' }))
      .toContain('✅ <b>Снято: Гостиная · Температура</b>');
  });

  test('событие — со звуком, сброс — беззвучно; один чат получает один раз; затем кадры', async () => {
    const { service, bot } = setup();
    const users = [account(), account({ username: 'petr' }), account({ username: 'kolya', telegram: { chatId: '7' } })];
    const jpeg = Buffer.from('JPEG');
    const n = await service.sendNotificationEvent(users, event, [{ jpeg, caption: 'Ворота' }]);
    expect(n).toBe(2);
    expect(bot.sendMessage.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      ['42', { disable_notification: false }], ['7', { disable_notification: false }],
    ]);
    expect(bot.sendPhoto.mock.calls.map((c) => c[0])).toEqual(['42', '7']);

    await service.sendNotificationEvent([account()], { ...event, status: 'OFF' });
    expect(bot.sendMessage.mock.calls.at(-1)[2]).toEqual({ disable_notification: true });
  });
});

describe('fileBlockStore', () => {
  test('сохраняет и читает блокировки; нет файла — пусто', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const file = path.join(os.tmpdir(), `tg-blocks-${process.pid}.json`);
    fs.rmSync(file, { force: true });
    const store = fileBlockStore(file);
    expect(store.load()).toEqual({});
    store.save({ 42: { count: 5, until: 123 } });
    expect(store.load()).toEqual({ 42: { count: 5, until: 123 } });
    fs.rmSync(file, { force: true });
  });
});

describe('telegramService: отправка', () => {
  const notification = { name: 'd1', payload: { message: 'Тест', severity: 'alarm', title: 'Котёл' } };
  const recipient = { username: 'ivan', telegram: { chatId: '42' } };

  test('alarm отправляется со звуком, info — тихо', async () => {
    const { service, bot } = setup();
    await service.sendToUser(recipient, notification);
    expect(bot.sendMessage.mock.calls[0][2]).toEqual({ disable_notification: false });
    await service.sendToUser(recipient, { ...notification, payload: { message: 'x', severity: 'info' } });
    expect(bot.sendMessage.mock.calls[1][2]).toEqual({ disable_notification: true });
  });

  test('403 (бот заблокирован) отвязывает пользователя', async () => {
    const { service, bot, userStore } = setup();
    bot.sendMessage.mockRejectedValue(Object.assign(new Error('Forbidden: bot was blocked'), { code: 403 }));
    expect(await service.sendToUser(recipient, notification)).toBe(false);
    expect(userStore.clearTelegram).toHaveBeenCalledWith('ivan');
  });

  test('429 повторяется один раз после паузы', async () => {
    const { service, bot, sleep } = setup();
    bot.sendMessage
      .mockRejectedValueOnce(Object.assign(new Error('Too Many Requests'), { code: 429, retryAfter: 2 }))
      .mockResolvedValueOnce({});
    expect(await service.sendToUser(recipient, notification)).toBe(true);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(bot.sendMessage).toHaveBeenCalledTimes(2);
  });

  test('прочие ошибки не отвязывают пользователя', async () => {
    const { service, bot, userStore } = setup();
    bot.sendMessage.mockRejectedValue(Object.assign(new Error('network'), { code: 'NETWORK' }));
    expect(await service.sendToUser(recipient, notification)).toBe(false);
    expect(userStore.clearTelegram).not.toHaveBeenCalled();
  });

  test('sendToUsers считает успешные отправки', async () => {
    const { service, bot } = setup();
    bot.sendMessage.mockResolvedValueOnce({}).mockRejectedValueOnce(Object.assign(new Error('x'), { code: 500 }));
    const n = await service.sendToUsers([recipient, { ...recipient, username: 'petr', telegram: { chatId: '7' } }], notification);
    expect(n).toBe(1);
  });

  test('sendPhotosToUsers: каждое фото каждому, беззвучно, подпись экранируется; 403 отвязывает', async () => {
    const { service, bot, userStore } = setup();
    const jpeg = Buffer.from('JPEG');
    bot.sendPhoto
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { code: 403 }));
    const n = await service.sendPhotosToUsers(
      [recipient, { ...recipient, username: 'petr', telegram: { chatId: '7' } }],
      [{ jpeg, caption: 'Ворота <1>' }],
    );
    expect(n).toBe(1);
    expect(bot.sendPhoto).toHaveBeenCalledWith('42', jpeg, { caption: 'Ворота &lt;1&gt;', disable_notification: true });
    expect(userStore.clearTelegram).toHaveBeenCalledWith('petr');
  });

  test('пользователь без chatId пропускается', async () => {
    const { service, bot } = setup();
    expect(await service.sendToUser({ username: 'x', telegram: {} }, notification)).toBe(false);
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });
});

describe('telegramService: жизненный цикл и форматирование', () => {
  test('start регистрирует команды и запускает polling, stop останавливает', async () => {
    const { service, bot } = setup();
    await service.start();
    expect(bot.setMyCommands).toHaveBeenCalled();
    expect(bot.start).toHaveBeenCalledTimes(1);
    await service.stop();
    expect(bot.stop).toHaveBeenCalledTimes(1);
  });

  test('сбой getMe не мешает запуску', async () => {
    const { service, bot } = setup();
    bot.getMe.mockRejectedValue(new Error('network'));
    await service.start();
    expect(bot.start).toHaveBeenCalled();
    expect(service.createLinkCode('ivan').deepLink).toBeNull();
  });

  test('formatNotification экранирует HTML', () => {
    const text = formatNotification({
      name: 'd1',
      payload: { title: '<b>Hack</b>', message: 'a < b & c', severity: 'warning', room: 'room1', item_name: 'T1' },
    });
    expect(text).toContain('&lt;b&gt;Hack&lt;/b&gt;');
    expect(text).toContain('a &lt; b &amp; c');
    expect(text).toContain('d1 · room1 · T1');
    expect(text).toContain('⚠️');
  });
});
