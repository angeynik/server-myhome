// services/telegramService.js
// Обмен сообщениями с пользователями через Telegram-бота (docs/telegram.md).
//
//  Регистрация (основной способ), чат ещё не привязан или команда /add:
//    любое сообщение → «введите код» (TELEGRAM_REGISTRATION_CODE из conf.env) → «введите логин» →
//    «введите пароль» (сообщение с паролем бот удаляет) → проверка userStore.verifyCredentials →
//    chatId сохраняется в учётной записи. Неверный код или логин/пароль — «Ошибка подключения»;
//    после TELEGRAM_BAD_CODE_LIMIT ошибок чат блокируется на TELEGRAM_BAD_CODE_LOCK_MS (сутки):
//    сообщения из него не обрабатываются. Блокировки хранятся в TELEGRAM_BLOCKS_FILE.
//  Привязка кодом из приложения (второй способ): VUE → auth/telegramLinkCode → «/start КОД».
//  Один чат может быть привязан к нескольким учётным записям (у каждой свой dID) —
//  уведомления всех этих dID приходят в один чат, в сообщении указан dID.
//  Исходящие: notificationService → sendNotificationEvent (уведомления по условиям),
//             notifyService → sendToUsers (оповещения NodeRED). Один чат получает сообщение один раз.
//  Входящие от привязанного чата: команды (/status, /add, /unlink, /mute, /unmute, /help);
//             прочий текст → forward({type:'message', request:'telegramIn', ...}) для каждого dID чата.
//  Работают только личные чаты.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');
logger.initLogging();
const nc = require('./notifyConfig.js');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const SEVERITY_ICON = { info: 'ℹ️', ok: '✅', warning: '⚠️', alarm: '🚨' };
const SILENT_SEVERITIES = ['info', 'ok'];
const COMMANDS = [
  { command: 'info', description: 'Состояние объекта: все, комната или параметр' },
  { command: 'set', description: 'Изменить уставку или переключатель' },
  { command: 'alarm', description: 'Уведомления: активные или все' },
  { command: 'photo', description: 'Кадры камер' },
  { command: 'object', description: 'Выбрать объект (конфигурацию)' },
  { command: 'start', description: 'Подключение к системе' },
  { command: 'status', description: 'Подключённые учётные записи' },
  { command: 'add', description: 'Подключить ещё одну учётную запись' },
  { command: 'mute', description: 'Отключить оповещения' },
  { command: 'unmute', description: 'Включить оповещения' },
  { command: 'unlink', description: 'Отключить учётную запись: /unlink ЛОГИН или все' },
  { command: 'cancel', description: 'Отменить подключение' },
  { command: 'help', description: 'Справка' },
];

const HELP_TEXT = [
  '<b>Что умеет бот</b>',
  '',
  '/info — состояние объекта; без слов — кнопки выбора:',
  '   /info все · /info спальня · /info температура · /info камеры',
  '/set — изменить уставку или переключатель «Состояния устройств»:',
  '   кнопками или /set спальня температура 22.5 · /set гостиная насос on',
  '   изменение всегда подтверждается кнопкой',
  '/alarm — уведомления: /alarm активные · /alarm все',
  '/photo — кадры камер: /photo все · /photo ворота',
  '/object — выбрать объект, если чат подключён к нескольким',
  '',
  '/status — подключённые учётные записи',
  '/add — подключить ещё одну учётную запись (другой объект)',
  '/mute, /unmute — выключить и включить оповещения',
  '/unlink ЛОГИН — отключить учётную запись; /unlink — все',
  '/cancel — отменить подключение или изменение',
  '',
  'Слова можно писать с маленькой буквы и сокращать: /info спал',
].join('\n');

const NOT_LINKED_TEXT = 'Чат не подключён. Получите код в приложении и отправьте /start КОД';
const ASK_CODE = 'Для подключения к системе введите код регистрации.\n/cancel — отмена';
const ASK_LOGIN = 'Код принят. Введите логин учётной записи.';
const ASK_PASSWORD = 'Введите пароль. Сообщение с паролем будет удалено из чата.';
const CONNECT_ERROR = 'Ошибка подключения';

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Оповещение NodeRED (notifyService): { name: dID, payload: { title, message, severity, room, item_name } }
function formatNotification(msg) {
  const { title, message, severity = 'info', room, item_name: itemName } = msg.payload;
  const lines = [];
  const head = `${SEVERITY_ICON[severity] || ''} ${title ? `<b>${escapeHtml(title)}</b>` : ''}`.trim();
  if (head) lines.push(head);
  lines.push(escapeHtml(message));
  const where = [msg.name, room, itemName].filter(Boolean).map(escapeHtml).join(' · ');
  if (where) lines.push(`<i>${where}</i>`);
  return lines.join('\n');
}

// Уведомление по условию (notificationService):
//   🚨 Гостиная · Температура            ✅ Снято: Гостиная · Температура
//   26.4 °C (условие > 25 °C)             условие больше не выполняется, сейчас 24 °C
//   🕒 18.11.2026, 12:12:00 · igumen      🕒 18.11.2026, 12:40:05 · igumen
function formatNotificationEvent({ dID, status, place, detail, time }) {
  const on = status === 'ON';
  const when = time ? new Date(time).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '';
  return [
    `${on ? '🚨' : '✅'} <b>${on ? '' : 'Снято: '}${escapeHtml(place)}</b>`,
    escapeHtml(detail),
    `🕒 ${escapeHtml(when)} · <i>${escapeHtml(dID)}</i>`,
  ].join('\n');
}

function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

const normalizeCode = (raw) => String(raw || '').replace(/[\s-]/g, '').toUpperCase();

// Код регистрации без пробелов и невидимых символов (копирование, клавиатура телефона),
// регистр не важен: телефонная клавиатура сама меняет заглавные буквы
const INVISIBLE_RE = /[\s\u200B-\u200D\u2060\uFEFF]/g;
// Кириллические буквы, неотличимые от латинских (русская раскладка при наборе кода)
const LOOKALIKE = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
};
const canonCode = (v) => String(v ?? '')
  .replace(INVISIBLE_RE, '')
  .toLowerCase()
  .replace(/[авеёкмнорстух]/g, (ch) => LOOKALIKE[ch]);

// Узор строки по типам символов — для лога без раскрытия кода:
// L/l — латиница (заглавная/строчная), К/к — кириллица, D — цифра, _ — пробел, ? — прочее
function charPattern(v) {
  return [...String(v ?? '')].map((ch) => {
    if (/[0-9]/.test(ch)) return 'D';
    if (/[A-Z]/.test(ch)) return 'L';
    if (/[a-z]/.test(ch)) return 'l';
    if (/[А-ЯЁ]/.test(ch)) return 'К';
    if (/[а-яё]/.test(ch)) return 'к';
    if (/\s/.test(ch)) return '_';
    return '?';
  }).join('');
}

// Сравнение кода регистрации за постоянное время (не выдаёт совпадающий префикс)
function sameCode(input, expected) {
  if (!canonCode(expected)) return false;
  const a = crypto.createHash('sha256').update(canonCode(input)).digest();
  const b = crypto.createHash('sha256').update(canonCode(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Почему код не совпал — для лога, без самого кода
function codeMismatchHint(input, expected) {
  const a = canonCode(input);
  const b = canonCode(expected);
  const parts = [`введено ${a.length} симв., ожидается ${b.length}; узор ввода ${charPattern(input)}, кода ${charPattern(expected)}`];
  if (String(input).length !== a.length) parts.push('во вводе были пробелы или невидимые символы');
  if (/^["'].*["']$/.test(String(expected).trim())) parts.push('код в conf.env в кавычках внутри значения');
  return parts.join('; ');
}

// Блокировки чатов на диске: { chatId: { count, until } }
function fileBlockStore(file) {
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return {};
      }
    },
    save(data) {
      try {
        fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, file);
      } catch (e) {
        logger.logErrorMessage(`[telegramService] - блокировки ${file}: ${e.message}`);
      }
    },
  };
}

function createTelegramService({
  bot,
  userStore,
  forward = () => false,
  config = nc,
  now = Date.now,
  sleep = defaultSleep,
  blockStore = null,
  commands = null,            // telegramCommands: /info, /set, /alarm, /photo, /object и кнопки
}) {
  const linkCodes = new Map();
  const failures = new Map(); // chatId -> { count, until }
  const dialogs = new Map();  // chatId -> { step: 'code'|'login'|'password', username, expires }
  const rates = new Map();
  let botUsername = null;
  let started = false;

  // ── Блокировки ───────────────────────────────────────────────────────
  if (blockStore) {
    const t = now();
    for (const [chatId, f] of Object.entries(blockStore.load() || {})) {
      if (f && f.until > t) failures.set(chatId, { count: f.count, until: f.until });
    }
  }
  const persistBlocks = () => blockStore && blockStore.save(Object.fromEntries(failures));

  function isBlocked(chatId) {
    const f = failures.get(chatId);
    return Boolean(f && f.count >= config.TELEGRAM_BAD_CODE_LIMIT && f.until > now());
  }

  // Ошибка подключения; true — чат только что заблокирован
  function registerFailure(chatId) {
    const t = now();
    const f = failures.get(chatId) || { count: 0, until: 0 };
    if (f.until && f.until < t) {
      f.count = 0;
      f.until = 0;
    }
    f.count++;
    const blocked = f.count >= config.TELEGRAM_BAD_CODE_LIMIT;
    if (blocked) f.until = t + config.TELEGRAM_BAD_CODE_LOCK_MS;
    failures.set(chatId, f);
    persistBlocks();
    return blocked;
  }

  function clearFailures(chatId) {
    if (failures.delete(chatId)) persistBlocks();
  }

  const attemptsLeft = (chatId) => config.TELEGRAM_BAD_CODE_LIMIT - (failures.get(chatId)?.count || 0);

  // Лимит частоты: сообщения — TELEGRAM_RATE_PER_MIN в минуту; нажатия кнопок считаются отдельно
  // и с лимитом втрое больше (одно изменение через /set — 5–8 нажатий)
  function allowRate(chatId, kind = 'message') {
    const t = now();
    const key = `${kind}:${chatId}`;
    const limit = config.TELEGRAM_RATE_PER_MIN * (kind === 'button' ? 3 : 1);
    const list = (rates.get(key) || []).filter((ts) => t - ts < 60000);
    if (list.length >= limit) {
      rates.set(key, list);
      return false;
    }
    list.push(t);
    rates.set(key, list);
    return true;
  }

  async function reply(chatId, text) {
    try {
      await bot.sendMessage(chatId, text);
      return true;
    } catch (e) {
      logger.logErrorMessage(`[telegramService] - reply(${chatId}): ${e.message}`);
      return false;
    }
  }

  // Ошибка подключения: счётчик, блокировка, ответ
  async function fail(chatId, why) {
    if (registerFailure(chatId)) {
      dialogs.delete(chatId);
      logger.logInfoMessage(`[telegramService] - чат ${chatId} заблокирован: ${config.TELEGRAM_BAD_CODE_LIMIT} ошибок подключения`);
      return reply(chatId, `⛔ ${CONNECT_ERROR}. Слишком много ошибок — сообщения из этого чата не принимаются 24 часа.`);
    }
    return reply(chatId, `❌ ${CONNECT_ERROR}: ${why}. Осталось попыток: ${attemptsLeft(chatId)}.`);
  }

  // ── Привязка кодом из приложения (/start КОД) ─────────────────────
  function purgeCodes() {
    const t = now();
    for (const [code, entry] of linkCodes) {
      if (entry.expires <= t) linkCodes.delete(code);
    }
  }

  function createLinkCode(username) {
    purgeCodes();
    for (const [code, entry] of linkCodes) {
      if (entry.username === username) linkCodes.delete(code);
    }
    let code = generateCode();
    while (linkCodes.has(code)) code = generateCode();
    linkCodes.set(code, { username, expires: now() + config.TELEGRAM_LINK_TTL_MS });
    return {
      code,
      expiresInSec: Math.round(config.TELEGRAM_LINK_TTL_MS / 1000),
      bot: botUsername ? `@${botUsername}` : null,
      deepLink: botUsername ? `https://t.me/${botUsername}?start=${code}` : null,
    };
  }

  function consumeCode(code) {
    purgeCodes();
    const entry = linkCodes.get(code);
    if (entry) linkCodes.delete(code);
    return entry || null;
  }

  async function attach(chatId, from, username) {
    const user = await userStore.setTelegram(username, {
      chatId,
      username: from?.username || null,
      firstName: from?.first_name || null,
    });
    clearFailures(chatId);
    dialogs.delete(chatId);
    logger.logInfoMessage(`[telegramService] - подключение: ${user.username} (${user.dID}) ↔ чат ${chatId}`);
    return reply(
      chatId,
      `✅ Подключена учётная запись <b>${escapeHtml(user.username)}</b> (конфигурация <i>${escapeHtml(user.dID)}</i>).\n` +
      'Уведомления этой конфигурации будут приходить в этот чат.\n/add — подключить ещё одну учётную запись.'
    );
  }

  async function linkByAppCode(chat, from, rawCode) {
    const chatId = String(chat.id);
    const entry = consumeCode(normalizeCode(rawCode));
    if (!entry) return fail(chatId, 'код недействителен или истёк');
    try {
      return await attach(chatId, from, entry.username);
    } catch (e) {
      logger.logErrorMessage(`[telegramService] - linkByAppCode: ${e.message}`);
      return reply(chatId, 'Не удалось подключить учётную запись.');
    }
  }

  // ── Регистрация: код → логин → пароль ─────────────────────────────
  function activeDialog(chatId) {
    const d = dialogs.get(chatId);
    if (d && d.expires > now()) return d;
    dialogs.delete(chatId);
    return null;
  }

  function startRegistration(chatId) {
    if (!config.TELEGRAM_REGISTRATION_CODE) return reply(chatId, NOT_LINKED_TEXT);
    dialogs.set(chatId, { step: 'code', username: null, expires: now() + config.TELEGRAM_DIALOG_TTL_MS });
    return reply(chatId, ASK_CODE);
  }

  async function continueRegistration(m, text, d) {
    const chatId = String(m.chat.id);
    d.expires = now() + config.TELEGRAM_DIALOG_TTL_MS;

    if (d.step === 'code') {
      if (!sameCode(text, config.TELEGRAM_REGISTRATION_CODE)) {
        logger.logInfoMessage(`[telegramService] - чат ${chatId}: неверный код регистрации (${codeMismatchHint(text, config.TELEGRAM_REGISTRATION_CODE)})`);
        return fail(chatId, 'неверный код');
      }
      d.step = 'login';
      return reply(chatId, ASK_LOGIN);
    }

    if (d.step === 'login') {
      d.username = text;
      d.step = 'password';
      return reply(chatId, ASK_PASSWORD);
    }

    // step === 'password': сообщение с паролем убираем из чата сразу
    if (m.message_id && bot.deleteMessage) {
      await bot.deleteMessage(chatId, m.message_id)
        .catch((e) => logger.logDevMessage(`[telegramService] - удаление сообщения с паролем: ${e.message}`));
    }
    const username = d.username;
    d.step = 'login';
    d.username = null;
    let user = null;
    try {
      user = await userStore.verifyCredentials(username, text);
    } catch (e) {
      logger.logErrorMessage(`[telegramService] - verifyCredentials: ${e.message}`);
    }
    if (!user || user.disabled) {
      logger.logInfoMessage(`[telegramService] - чат ${chatId}: неверный логин или пароль (${String(username).slice(0, 32)})`);
      const r = await fail(chatId, 'неверный логин или пароль');
      if (dialogs.has(chatId)) await reply(chatId, 'Введите логин учётной записи.');
      return r;
    }
    try {
      return await attach(chatId, m.from, user.username);
    } catch (e) {
      logger.logErrorMessage(`[telegramService] - подключение ${user.username}: ${e.message}`);
      dialogs.delete(chatId);
      return reply(chatId, 'Не удалось подключить учётную запись.');
    }
  }

  // ── Команды ──────────────────────────────────────────────────────────
  const accountLine = (u) => `• <b>${escapeHtml(u.username)}</b> — конфигурация <i>${escapeHtml(u.dID)}</i>, уровень ${u.permissionLevel}` +
    `${u.disabled ? ' (отключена)' : ''}`;

  async function handleCommand(m, cmd, arg, users) {
    const chatId = String(m.chat.id);
    // Команды объекта (/info, /set, /alarm, /photo, /object) — telegramCommands
    if (commands && ['info', 'set', 'alarm', 'photo', 'object'].includes(cmd)) {
      if (!users.length) return reply(chatId, 'Чат не подключён. Отправьте любое сообщение, чтобы подключиться.');
      return commands.command(chatId, cmd, arg, users);
    }
    switch (cmd) {
      case 'start':
      case 'link':
        if (arg) return linkByAppCode(m.chat, m.from, arg);
        if (users.length) return reply(chatId, `Чат подключён.\n${users.map(accountLine).join('\n')}\n\n${HELP_TEXT}`);
        return startRegistration(chatId);

      case 'add':
      case 'register':
        return startRegistration(chatId);

      case 'cancel':
        if (dialogs.delete(chatId)) return reply(chatId, 'Подключение отменено.');
        if (commands?.cancel(chatId)) return reply(chatId, 'Изменение отменено.');
        return reply(chatId, 'Отменено.');

      case 'help':
        return reply(chatId, users.length ? HELP_TEXT : 'Отправьте любое сообщение, чтобы подключиться к системе.');

      case 'status':
        if (!users.length) return reply(chatId, NOT_LINKED_TEXT);
        return reply(
          chatId,
          `Подключённые учётные записи:\n${users.map(accountLine).join('\n')}\n` +
          `Оповещения: ${users.some((u) => u.notify?.telegram !== false) ? 'включены' : 'выключены'}`
        );

      case 'unlink': {
        if (!users.length) return reply(chatId, NOT_LINKED_TEXT);
        const targets = arg ? users.filter((u) => u.username.toLowerCase() === arg.toLowerCase()) : users;
        if (!targets.length) return reply(chatId, `Учётная запись «${escapeHtml(arg)}» к этому чату не подключена.`);
        for (const u of targets) await userStore.clearTelegram(u.username);
        return reply(chatId, `Отключено: ${targets.map((u) => `<b>${escapeHtml(u.username)}</b>`).join(', ')}.`);
      }

      case 'mute':
      case 'unmute':
        if (!users.length) return reply(chatId, NOT_LINKED_TEXT);
        for (const u of users) await userStore.updateOwnProfile(u.username, { notify: { telegram: cmd === 'unmute' } });
        return reply(chatId, cmd === 'mute' ? '🔕 Оповещения выключены.' : '🔔 Оповещения включены.');

      default:
        return reply(chatId, users.length ? HELP_TEXT : NOT_LINKED_TEXT);
    }
  }

  // ВРЕМЕННО: подробный лог подключения (TELEGRAM_DEBUG=true). Код и пароль в лог не попадают:
  // для кода — длина и узор по типам символов, для пароля — только длина.
  function debug(chatId, what) {
    if (config.TELEGRAM_DEBUG) logger.logInfoMessage(`[telegramService] - DEBUG чат ${chatId}: ${what}`);
  }

  async function handleUpdate(update) {
    if (update?.callback_query) return handleCallback(update.callback_query);
    const m = update?.message;
    if (!m || !m.chat || m.chat.type !== 'private' || typeof m.text !== 'string') {
      if (m?.chat) debug(m.chat.id, `пропущено (тип чата ${m.chat.type}, текст: ${typeof m.text === 'string'})`);
      return;
    }

    const chatId = String(m.chat.id);
    if (isBlocked(chatId)) { debug(chatId, `заблокирован до ${new Date(failures.get(chatId).until).toISOString()}`); return; }
    if (!allowRate(chatId)) { debug(chatId, 'превышен лимит сообщений в минуту'); return; }
    if (config.TELEGRAM_DEBUG) {
      const d = activeDialog(chatId);
      const shown = d?.step === 'code'
        ? `длина ${m.text.trim().length}, узор ${charPattern(m.text.trim())}`
        : d?.step === 'password' ? `пароль, длина ${m.text.length}` : `«${m.text.slice(0, 40)}»`;
      debug(chatId, `сообщение (шаг ${d?.step || 'нет'}, ошибок ${failures.get(chatId)?.count || 0}): ${shown}`);
    }

    const text = m.text.trim().slice(0, config.TELEGRAM_MAX_INPUT_LEN);
    if (!text) return;

    const users = await userStore.findAllByTelegramChatId(chatId);
    debug(chatId, `подключённые записи: ${users.map((u) => `${u.username}(${u.dID})`).join(', ') || 'нет'}`);
    // Форма с косой чертой: /info/all → /info all, /set/Спальня-Температура → /set Спальня-Температура
    const slashForm = text.replace(/^(\/[a-z_]+)\/(\S.*)$/i, (_, c, rest) => `${c} ${rest.replace(/\//g, ' ')}`);
    const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+(.*))?$/i.exec(slashForm);
    const dialog = activeDialog(chatId);

    // Пароль может начинаться с «/» — в шаге пароля команды не разбираются (кроме /cancel)
    if (cmd && !(dialog?.step === 'password' && cmd[1].toLowerCase() !== 'cancel')) {
      if (dialog && cmd[1].toLowerCase() !== 'cancel') dialogs.delete(chatId);
      return handleCommand(m, cmd[1].toLowerCase(), (cmd[2] || '').trim(), users);
    }
    if (dialog) return continueRegistration(m, text, dialog);

    // Чат не подключён — любое сообщение начинает регистрацию
    if (!users.length) return startRegistration(chatId);

    const active = users.filter((u) => !u.disabled);
    if (!active.length) return reply(chatId, 'Учётная запись отключена.');

    // Число или ON/OFF для открытого изменения (/set)
    if (commands && await commands.text(chatId, text, active)) return true;

    // Пересылка текста в систему (NodeRED, message/telegramIn) пока отключена: управление —
    // командами бота. Вернуть — раскомментировать блок и убрать ответ ниже.
    // let accepted = false;
    // for (const u of active) {
    //   accepted = forward({
    //     type: 'message',
    //     request: 'telegramIn',
    //     name: u.dID,
    //     payload: {
    //       level: u.permissionLevel,
    //       message: text,
    //       from: { source: 'telegram', username: u.username, uid: u.uid },
    //     },
    //   }) || accepted;
    // }
    // return reply(chatId, accepted ? '✓ Принято' : 'Приём сообщений сейчас отключён.');
    return reply(chatId, 'Не понял. Команды бота — /help');
  }

  // Нажатие inline-кнопки (команды объекта)
  async function handleCallback(cq) {
    const chatId = String(cq?.message?.chat?.id ?? '');
    if (!chatId || cq.message.chat.type !== 'private') return;
    if (isBlocked(chatId) || !allowRate(chatId, 'button')) return;
    debug(chatId, `кнопка «${String(cq.data).slice(0, 40)}»`);
    const users = (await userStore.findAllByTelegramChatId(chatId)).filter((u) => !u.disabled);
    if (!users.length || !commands) {
      await bot.answerCallbackQuery?.(cq.id, 'Чат не подключён').catch(() => {});
      return;
    }
    try {
      await commands.callback(cq, users);
    } catch (e) {
      logger.logErrorMessage(`[telegramService] - кнопка ${cq.data}: ${e.message}`);
      await reply(chatId, 'Не удалось выполнить. Попробуйте ещё раз.');
    }
  }

  // ── Отправка ─────────────────────────────────────────────────────────
  // Одна попытка повтора при 429; недоступный чат (403 / chat not found) отвязывается
  async function deliver(user, send) {
    const chatId = user?.telegram?.chatId;
    if (!chatId) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await send(chatId);
        return true;
      } catch (e) {
        if (e.code === 429 && e.retryAfter && e.retryAfter <= 30 && attempt === 0) {
          await sleep(e.retryAfter * 1000);
          continue;
        }
        const gone = e.code === 403 || (e.code === 400 && /chat not found/i.test(e.message));
        if (gone) {
          logger.logInfoMessage(`[telegramService] - sendToUser: чат ${user.username} недоступен, отвязываем`);
          await userStore.clearTelegram(user.username).catch(() => {});
        } else {
          logger.logErrorMessage(`[telegramService] - sendToUser(${user.username}): ${e.message}`);
        }
        return false;
      }
    }
    return false;
  }

  // Один чат может быть привязан к нескольким записям одного dID — сообщение ему один раз
  function uniqueChats(users) {
    const seen = new Set();
    return users.filter((u) => {
      const id = u?.telegram?.chatId;
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  function sendToUser(user, msg) {
    const text = formatNotification(msg);
    const extra = { disable_notification: SILENT_SEVERITIES.includes(msg.payload.severity) };
    return deliver(user, (chatId) => bot.sendMessage(chatId, text, extra));
  }

  async function sendToUsers(users, msg) {
    let sent = 0;
    for (const user of uniqueChats(users)) {
      if (await sendToUser(user, msg)) sent++;
      await sleep(40);
    }
    return sent;
  }

  // Кадры камер: photos = [{ jpeg, caption }]; беззвучно — звук уже был у текста
  async function sendPhotosToUsers(users, photos) {
    let sent = 0;
    for (const user of uniqueChats(users)) {
      for (const { jpeg, caption } of photos) {
        if (await deliver(user, (chatId) => bot.sendPhoto(chatId, jpeg, { caption: escapeHtml(caption), disable_notification: true }))) sent++;
        await sleep(40);
      }
    }
    return sent;
  }

  // Уведомление по условию: текст (событие — со звуком, сброс — беззвучно), затем кадры камер
  async function sendNotificationEvent(users, event, photos = []) {
    const text = formatNotificationEvent(event);
    const extra = { disable_notification: event.status !== 'ON' };
    let sent = 0;
    const recipients = uniqueChats(users);
    for (const user of recipients) {
      if (await deliver(user, (chatId) => bot.sendMessage(chatId, text, extra))) sent++;
      await sleep(40);
    }
    if (photos.length) await sendPhotosToUsers(recipients, photos);
    return sent;
  }

  async function start() {
    if (started) return;
    started = true;
    try {
      const me = await bot.getMe();
      botUsername = me?.username || null;
      await bot.setMyCommands(COMMANDS);
    } catch (e) {
      logger.logErrorMessage(`[telegramService] - start: ${e.message}`);
    }
    bot.start(handleUpdate, { pollTimeoutS: config.TELEGRAM_POLL_TIMEOUT_S });
    if (config.TELEGRAM_DEBUG) logger.logInfoMessage('[telegramService] - подробный лог подключения включён (TELEGRAM_DEBUG)');
    logger.logInfoMessage(
      `[telegramService] - запущен${botUsername ? `, бот @${botUsername}` : ''}; ` +
      `регистрация через бота ${config.TELEGRAM_REGISTRATION_CODE
        ? `включена (код регистрации: ${canonCode(config.TELEGRAM_REGISTRATION_CODE).length} симв., узор ${charPattern(config.TELEGRAM_REGISTRATION_CODE)})`
        : 'выключена (нет TELEGRAM_REGISTRATION_CODE)'}`
    );
  }

  async function stop() {
    if (!started) return;
    started = false;
    await bot.stop();
  }

  return {
    start,
    stop,
    handleUpdate,
    createLinkCode,
    sendToUser,
    sendToUsers,
    sendPhotosToUsers,
    sendNotificationEvent,
    isBlocked,
    isStarted: () => started,
  };
}

let instance = null;

// Сообщения бота для команд: отправка с кнопками, правка, фото, ответ на нажатие
function botUi(bot) {
  const markup = (keyboard) => (keyboard ? { reply_markup: keyboard } : {});
  return {
    send: (chatId, html, keyboard) => bot.sendMessage(chatId, html, markup(keyboard))
      .catch((e) => { logger.logErrorMessage(`[telegramService] - send(${chatId}): ${e.message}`); return null; }),
    edit: (chatId, messageId, html, keyboard) => bot.editMessageText(chatId, messageId, html, markup(keyboard))
      .catch((e) => {
        // «message is not modified» — значение не изменилось, это не ошибка
        if (!/not modified/i.test(e.message)) logger.logErrorMessage(`[telegramService] - edit(${chatId}): ${e.message}`);
        return null;
      }),
    photo: (chatId, jpeg, caption) => bot.sendPhoto(chatId, jpeg, { caption: escapeHtml(caption) })
      .catch((e) => { logger.logErrorMessage(`[telegramService] - photo(${chatId}): ${e.message}`); return null; }),
    answer: (id, text) => bot.answerCallbackQuery(id, text).catch(() => null),
  };
}

// executeCommand — единый механизм команд (commandGateway из serverapp.js)
function init({ forward, executeCommand } = {}) {
  if (instance) return instance;
  const TelegramBot = require('../classes/telegramBot.js');
  const { createTelegramCommands } = require('./telegramCommands.js');
  const { readFileIfExists } = require('./configStore');
  const videoHub = require('./videoHub.js');
  const cfg = require('./authConfig');
  const bot = new TelegramBot({ token: nc.TELEGRAM_BOT_TOKEN, apiBase: nc.TELEGRAM_API_BASE });
  const commands = createTelegramCommands({
    ui: botUi(bot),
    readConfig: async (dID) => (await readFileIfExists(dID, 'config'))?.data || {},
    notificationStore: require('./notificationStore.js').createNotificationStore(),
    cameras: {
      list: (dID, level) => videoHub.listCameras({ dID, level }),
      frame: (dID, cameraId) => videoHub.getFrameFor(dID, cameraId),
    },
    executeCommand: executeCommand || (async () => ({ ok: false, error: 'Изменение недоступно' })),
    requiredLevel: (request) => cfg.REQUIRED_LEVEL.post[request] ?? cfg.REQUIRED_LEVEL.post._default,
    contextStore: fileBlockStore(nc.TELEGRAM_CHATS_FILE),
  });
  instance = createTelegramService({
    bot,
    userStore: require('./userStore.js'),
    forward,
    blockStore: fileBlockStore(nc.TELEGRAM_BLOCKS_FILE),
    commands,
  });
  return instance;
}

const get = () => instance;

async function stop() {
  if (!instance) return;
  const current = instance;
  instance = null;
  await current.stop();
}

module.exports = {
  createTelegramService, formatNotification, formatNotificationEvent, fileBlockStore, escapeHtml, init, get, stop,
};
