// services/telegramService.js
// Обмен сообщениями с пользователями через Telegram.
//
//  Привязка:  VUE → auth/telegramLinkCode → одноразовый код (TTL) →
//             пользователь отправляет боту «/start КОД» → chatId сохраняется в userStore.
//  Исходящие: notifyService → sendToUsers() → Bot API.
//  Входящие:  текст привязанного пользователя → forward({type:'message', request:'telegramIn', ...}).
//  Работают только личные чаты. Незнакомым чатам отвечаем только инструкцией по привязке.
'use strict';

const crypto = require('crypto');
const logger = require('./logger.js');
logger.initLogging();
const nc = require('./notifyConfig.js');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const SEVERITY_ICON = { info: 'ℹ️', ok: '✅', warning: '⚠️', alarm: '🚨' };
const SILENT_SEVERITIES = ['info', 'ok'];
const COMMANDS = [
  { command: 'start', description: 'Привязать аккаунт: /start КОД' },
  { command: 'status', description: 'Статус привязки' },
  { command: 'mute', description: 'Отключить оповещения' },
  { command: 'unmute', description: 'Включить оповещения' },
  { command: 'unlink', description: 'Отвязать аккаунт' },
  { command: 'help', description: 'Справка' },
];

const HELP_TEXT = [
  'Команды:',
  '/start КОД — привязать аккаунт (код выдаёт приложение)',
  '/status — статус привязки',
  '/mute, /unmute — выключить и включить оповещения',
  '/unlink — отвязать аккаунт',
  'Любой другой текст передаётся в систему от вашего имени.',
].join('\n');

const NOT_LINKED_TEXT = 'Аккаунт не привязан. Получите код в приложении и отправьте /start КОД';

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

const normalizeCode = (raw) => String(raw || '').replace(/[\s-]/g, '').toUpperCase();

function createTelegramService({
  bot,
  userStore,
  forward = () => false,
  config = nc,
  now = Date.now,
  sleep = defaultSleep,
}) {
  const linkCodes = new Map();
  const failures = new Map();
  const rates = new Map();
  let botUsername = null;
  let started = false;

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

  function isBlocked(chatId) {
    const f = failures.get(chatId);
    return Boolean(f && f.count >= config.TELEGRAM_BAD_CODE_LIMIT && f.until > now());
  }

  function registerFailure(chatId) {
    const t = now();
    const f = failures.get(chatId) || { count: 0, until: 0 };
    if (f.until && f.until < t) {
      f.count = 0;
      f.until = 0;
    }
    f.count++;
    if (f.count >= config.TELEGRAM_BAD_CODE_LIMIT) f.until = t + config.TELEGRAM_BAD_CODE_LOCK_MS;
    failures.set(chatId, f);
  }

  function allowRate(chatId) {
    const t = now();
    const list = (rates.get(chatId) || []).filter((ts) => t - ts < 60000);
    if (list.length >= config.TELEGRAM_RATE_PER_MIN) {
      rates.set(chatId, list);
      return false;
    }
    list.push(t);
    rates.set(chatId, list);
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

  async function link(chat, from, rawCode) {
    const chatId = String(chat.id);
    if (isBlocked(chatId)) return reply(chatId, 'Слишком много неверных кодов. Попробуйте позже.');

    const entry = consumeCode(normalizeCode(rawCode));
    if (!entry) {
      registerFailure(chatId);
      return reply(chatId, 'Код недействителен или истёк. Получите новый в приложении.');
    }

    try {
      const user = await userStore.setTelegram(entry.username, {
        chatId,
        username: from?.username || null,
        firstName: from?.first_name || null,
      });
      failures.delete(chatId);
      logger.logInfoMessage(`[telegramService] - link: ${user.username} ↔ chat ${chatId}`);
      return reply(
        chatId,
        `✅ Аккаунт <b>${escapeHtml(user.username)}</b> привязан (источник ${escapeHtml(user.dID)}, уровень ${user.permissionLevel}).`
      );
    } catch (e) {
      logger.logErrorMessage(`[telegramService] - link: ${e.message}`);
      if (e.code === 'TELEGRAM_BUSY') {
        return reply(chatId, 'Этот чат уже привязан к другой учётной записи. Отправьте /unlink и повторите.');
      }
      return reply(chatId, 'Не удалось привязать аккаунт.');
    }
  }

  async function handleCommand(chat, from, cmd, arg, user) {
    const chatId = String(chat.id);
    switch (cmd) {
      case 'start':
      case 'link':
        if (arg) return link(chat, from, arg);
        if (user) return reply(chatId, `Привязан аккаунт <b>${escapeHtml(user.username)}</b>.\n${HELP_TEXT}`);
        return reply(chatId, NOT_LINKED_TEXT);

      case 'help':
        return reply(chatId, HELP_TEXT);

      case 'unlink':
        if (!user) return reply(chatId, NOT_LINKED_TEXT);
        await userStore.clearTelegram(user.username);
        return reply(chatId, 'Аккаунт отвязан.');

      case 'status':
        if (!user) return reply(chatId, NOT_LINKED_TEXT);
        return reply(
          chatId,
          `Аккаунт: <b>${escapeHtml(user.username)}</b>\nИсточник: ${escapeHtml(user.dID)}\n` +
          `Уровень: ${user.permissionLevel}\n` +
          `Оповещения: ${user.notify?.telegram === false ? 'выключены' : 'включены'} ` +
          `(от «${user.notify?.minSeverity || 'info'}»)`
        );

      case 'mute':
      case 'unmute':
        if (!user) return reply(chatId, NOT_LINKED_TEXT);
        await userStore.updateOwnProfile(user.username, { notify: { telegram: cmd === 'unmute' } });
        return reply(chatId, cmd === 'mute' ? '🔕 Оповещения выключены.' : '🔔 Оповещения включены.');

      default:
        return reply(chatId, HELP_TEXT);
    }
  }

  async function handleUpdate(update) {
    const m = update?.message;
    if (!m || !m.chat || m.chat.type !== 'private' || typeof m.text !== 'string') return;

    const chatId = String(m.chat.id);
    if (!allowRate(chatId)) return;

    const text = m.text.trim().slice(0, config.TELEGRAM_MAX_INPUT_LEN);
    if (!text) return;

    const user = await userStore.findByTelegramChatId(chatId);
    const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+(.*))?$/i.exec(text);
    if (cmd) return handleCommand(m.chat, m.from, cmd[1].toLowerCase(), (cmd[2] || '').trim(), user);

    if (!user) return reply(chatId, NOT_LINKED_TEXT);
    if (user.disabled) return reply(chatId, 'Учётная запись отключена.');

    const accepted = forward({
      type: 'message',
      request: 'telegramIn',
      name: user.dID,
      payload: {
        level: user.permissionLevel,
        message: text,
        from: { source: 'telegram', username: user.username, uid: user.uid },
      },
    });
    return reply(chatId, accepted ? '✓ Принято' : 'Приём сообщений сейчас отключён.');
  }

  async function sendToUser(user, msg) {
    const chatId = user?.telegram?.chatId;
    if (!chatId) return false;
    const text = formatNotification(msg);
    const extra = { disable_notification: SILENT_SEVERITIES.includes(msg.payload.severity) };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await bot.sendMessage(chatId, text, extra);
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

  async function sendToUsers(users, msg) {
    let sent = 0;
    for (const user of users) {
      if (await sendToUser(user, msg)) sent++;
      await sleep(40);
    }
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
    logger.logInfoMessage(`[telegramService] - запущен${botUsername ? `, бот @${botUsername}` : ''}`);
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
    isStarted: () => started,
  };
}

let instance = null;

function init({ forward } = {}) {
  if (instance) return instance;
  const TelegramBot = require('../classes/telegramBot.js');
  const bot = new TelegramBot({ token: nc.TELEGRAM_BOT_TOKEN, apiBase: nc.TELEGRAM_API_BASE });
  instance = createTelegramService({ bot, userStore: require('./userStore.js'), forward });
  return instance;
}

const get = () => instance;

async function stop() {
  if (!instance) return;
  const current = instance;
  instance = null;
  await current.stop();
}

module.exports = { createTelegramService, formatNotification, escapeHtml, init, get, stop };
