
const { createTelegramService, formatNotification } = require('../services/telegramService');

const config = {
  TELEGRAM_LINK_TTL_MS: 1000,
  TELEGRAM_BAD_CODE_LIMIT: 3,
  TELEGRAM_BAD_CODE_LOCK_MS: 5000,
  TELEGRAM_RATE_PER_MIN: 5,
  TELEGRAM_MAX_INPUT_LEN: 100,
  TELEGRAM_POLL_TIMEOUT_S: 1,
};

function setup({ linked = null, forwardResult = true } = {}) {
  const time = { t: 1000 };
  const bot = {
    sendMessage: jest.fn(async () => ({})),
    getMe: jest.fn(async () => ({ username: 'my_bot' })),
    setMyCommands: jest.fn(async () => true),
    start: jest.fn(),
    stop: jest.fn(async () => {}),
  };
  const user = linked && {
    username: 'ivan', uid: 'u-1', dID: 'd1', permissionLevel: 2, disabled: false,
    telegram: { chatId: '42' }, notify: { telegram: true, minSeverity: 'info' }, ...linked,
  };
  const userStore = {
    findByTelegramChatId: jest.fn(async (id) => (user && String(id) === '42' ? user : null)),
    setTelegram: jest.fn(async (username) => ({ username, dID: 'd1', permissionLevel: 2 })),
    clearTelegram: jest.fn(async () => ({})),
    updateOwnProfile: jest.fn(async () => ({})),
  };
  const forward = jest.fn(() => forwardResult);
  const sleep = jest.fn(async () => {});
  const service = createTelegramService({ bot, userStore, forward, config, now: () => time.t, sleep });
  return { service, bot, userStore, forward, sleep, time };
}

const update = (text, chatId = 42, type = 'private') => ({
  message: { text, chat: { id: chatId, type }, from: { username: 'tg_ivan', first_name: 'Иван' } },
});
const lastReply = (bot) => bot.sendMessage.mock.calls.at(-1)[1];

describe('telegramService: привязка', () => {
  test('код из приложения привязывает чат', async () => {
    const { service, bot, userStore } = setup();
    await service.start();
    const link = service.createLinkCode('ivan');
    expect(link.code).toHaveLength(8);
    expect(link.deepLink).toBe(`https://t.me/my_bot?start=${link.code}`);

    await service.handleUpdate(update(`/start ${link.code}`));
    expect(userStore.setTelegram).toHaveBeenCalledWith('ivan', { chatId: '42', username: 'tg_ivan', firstName: 'Иван' });
    expect(lastReply(bot)).toContain('привязан');
  });

  test('код одноразовый, повторное использование отклоняется', async () => {
    const { service, bot, userStore } = setup();
    const { code } = service.createLinkCode('ivan');
    await service.handleUpdate(update(`/start ${code}`));
    await service.handleUpdate(update(`/start ${code}`));
    expect(userStore.setTelegram).toHaveBeenCalledTimes(1);
    expect(lastReply(bot)).toContain('недействителен');
  });

  test('код принимается в нижнем регистре и с пробелами', async () => {
    const { service, userStore } = setup();
    const { code } = service.createLinkCode('ivan');
    await service.handleUpdate(update(`/start ${code.slice(0, 4).toLowerCase()} ${code.slice(4)}`));
    expect(userStore.setTelegram).toHaveBeenCalledTimes(1);
  });

  test('просроченный код отклоняется', async () => {
    const { service, bot, userStore, time } = setup();
    const { code } = service.createLinkCode('ivan');
    time.t += 2000;
    await service.handleUpdate(update(`/start ${code}`));
    expect(userStore.setTelegram).not.toHaveBeenCalled();
    expect(lastReply(bot)).toContain('недействителен');
  });

  test('новый код аннулирует предыдущий', async () => {
    const { service, userStore } = setup();
    const first = service.createLinkCode('ivan');
    service.createLinkCode('ivan');
    await service.handleUpdate(update(`/start ${first.code}`));
    expect(userStore.setTelegram).not.toHaveBeenCalled();
  });

  test('после серии неверных кодов чат блокируется', async () => {
    const { service, bot, userStore } = setup();
    const { code } = service.createLinkCode('ivan');
    for (let i = 0; i < 3; i++) await service.handleUpdate(update('/start WRONGCODE'));
    await service.handleUpdate(update(`/start ${code}`));
    expect(userStore.setTelegram).not.toHaveBeenCalled();
    expect(lastReply(bot)).toContain('Слишком много');
  });

  test('чат, занятый другой учёткой, получает понятный ответ', async () => {
    const { service, bot, userStore } = setup();
    userStore.setTelegram.mockRejectedValue(Object.assign(new Error('busy'), { code: 'TELEGRAM_BUSY' }));
    const { code } = service.createLinkCode('ivan');
    await service.handleUpdate(update(`/start ${code}`));
    expect(lastReply(bot)).toContain('уже привязан');
  });
});

describe('telegramService: входящие сообщения', () => {
  test('групповые чаты и не-текст игнорируются', async () => {
    const { service, bot } = setup({ linked: {} });
    await service.handleUpdate(update('привет', 42, 'group'));
    await service.handleUpdate({ message: { chat: { id: 42, type: 'private' }, photo: [] } });
    await service.handleUpdate({});
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  test('непривязанному чату — только инструкция', async () => {
    const { service, bot, forward } = setup();
    await service.handleUpdate(update('открой дверь'));
    expect(forward).not.toHaveBeenCalled();
    expect(lastReply(bot)).toContain('/start КОД');
  });

  test('текст привязанного пользователя уходит в forward', async () => {
    const { service, bot, forward } = setup({ linked: {} });
    await service.handleUpdate(update('включи свет'));
    expect(forward).toHaveBeenCalledWith({
      type: 'message',
      request: 'telegramIn',
      name: 'd1',
      payload: { level: 2, message: 'включи свет', from: { source: 'telegram', username: 'ivan', uid: 'u-1' } },
    });
    expect(lastReply(bot)).toBe('✓ Принято');
  });

  test('если приём отключён — сообщаем об этом', async () => {
    const { service, bot } = setup({ linked: {}, forwardResult: false });
    await service.handleUpdate(update('привет'));
    expect(lastReply(bot)).toContain('отключён');
  });

  test('отключённая учётная запись не пересылает сообщения', async () => {
    const { service, forward } = setup({ linked: { disabled: true } });
    await service.handleUpdate(update('привет'));
    expect(forward).not.toHaveBeenCalled();
  });

  test('слишком длинный текст обрезается', async () => {
    const { service, forward } = setup({ linked: {} });
    await service.handleUpdate(update('x'.repeat(500)));
    expect(forward.mock.calls[0][0].payload.message).toHaveLength(100);
  });

  test('ограничение частоты по чату', async () => {
    const { service, forward } = setup({ linked: {} });
    for (let i = 0; i < 8; i++) await service.handleUpdate(update(`m${i}`));
    expect(forward).toHaveBeenCalledTimes(5);
  });
});

describe('telegramService: команды', () => {
  test('/mute и /unmute меняют настройки', async () => {
    const { service, userStore } = setup({ linked: {} });
    await service.handleUpdate(update('/mute'));
    expect(userStore.updateOwnProfile).toHaveBeenLastCalledWith('ivan', { notify: { telegram: false } });
    await service.handleUpdate(update('/unmute@my_bot'));
    expect(userStore.updateOwnProfile).toHaveBeenLastCalledWith('ivan', { notify: { telegram: true } });
  });

  test('/unlink отвязывает аккаунт', async () => {
    const { service, userStore, bot } = setup({ linked: {} });
    await service.handleUpdate(update('/unlink'));
    expect(userStore.clearTelegram).toHaveBeenCalledWith('ivan');
    expect(lastReply(bot)).toContain('отвязан');
  });

  test('/status показывает данные привязанного пользователя', async () => {
    const { service, bot } = setup({ linked: {} });
    await service.handleUpdate(update('/status'));
    expect(lastReply(bot)).toContain('ivan');
    expect(lastReply(bot)).toContain('включены');
  });

  test('неизвестная команда — справка', async () => {
    const { service, bot } = setup({ linked: {} });
    await service.handleUpdate(update('/foo'));
    expect(lastReply(bot)).toContain('Команды');
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
    const n = await service.sendToUsers([recipient, { ...recipient, username: 'petr' }], notification);
    expect(n).toBe(1);
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
