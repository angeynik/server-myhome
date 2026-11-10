// classes/telegramBot.js
// Тонкий клиент Telegram Bot API без внешних зависимостей (нужен Node.js 18+).
// Отправка сообщений и приём обновлений через long polling (getUpdates).
// Токен никогда не попадает в логи и тексты ошибок.
'use strict';

const logger = require('../services/logger.js');
logger.initLogging();

class TelegramApiError extends Error {
  constructor(message, { code = null, status = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'TelegramApiError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

class TelegramBot {
  constructor({
    token,
    apiBase = 'https://api.telegram.org',
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = 15000,
  } = {}) {
    if (!token) throw new Error('TelegramBot: не задан token');
    if (typeof fetchImpl !== 'function') throw new Error('TelegramBot: fetch недоступен (нужен Node.js 18+)');
    this.token = token;
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.polling = false;
    this.abort = null;
    this.offset = 0;
    this.loopPromise = null;
  }

  sanitize(text) {
    return String(text).split(this.token).join('***');
  }

  async call(method, params = {}, { timeoutMs = this.requestTimeoutMs, signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await this.fetchImpl(`${this.apiBase}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });

      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      if (!res.ok || !body || body.ok !== true) {
        throw new TelegramApiError(this.sanitize(body?.description || `HTTP ${res.status}`), {
          code: body?.error_code ?? res.status,
          status: res.status,
          retryAfter: body?.parameters?.retry_after ?? null,
        });
      }
      return body.result;
    } catch (e) {
      if (e instanceof TelegramApiError) throw e;
      const text = e.name === 'AbortError' ? 'timeout или отмена запроса' : e.message;
      throw new TelegramApiError(this.sanitize(text), { code: 'NETWORK' });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  getMe() {
    return this.call('getMe');
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text: String(text).slice(0, 4096),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }

  setMyCommands(commands) {
    return this.call('setMyCommands', { commands });
  }

  getUpdates({ offset, timeout = 25, signal } = {}) {
    return this.call(
      'getUpdates',
      { offset, timeout, allowed_updates: ['message'] },
      { timeoutMs: (timeout + 10) * 1000, signal }
    );
  }

  sleep(ms, signal) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', done);
        resolve();
      }
      if (signal) signal.addEventListener('abort', done, { once: true });
    });
  }

  start(onUpdate, { pollTimeoutS = 25, retryMinMs = 1000, retryMaxMs = 30000 } = {}) {
    if (this.polling) return;
    this.polling = true;
    this.abort = new AbortController();
    this.loopPromise = this.loop(onUpdate, { pollTimeoutS, retryMinMs, retryMaxMs });
  }

  async loop(onUpdate, { pollTimeoutS, retryMinMs, retryMaxMs }) {
    let delay = retryMinMs;
    while (this.polling) {
      try {
        const updates = await this.getUpdates({
          offset: this.offset || undefined,
          timeout: pollTimeoutS,
          signal: this.abort.signal,
        });
        delay = retryMinMs;
        for (const update of updates) {
          this.offset = update.update_id + 1;
          try {
            await onUpdate(update);
          } catch (e) {
            logger.logErrorMessage(`[TelegramBot] - onUpdate: ${this.sanitize(e.message)}`);
          }
        }
      } catch (e) {
        if (!this.polling) break;
        logger.logErrorMessage(`[TelegramBot] - getUpdates: ${e.message}`);
        const wait = e.retryAfter ? e.retryAfter * 1000 : (e.code === 409 ? retryMaxMs : delay);
        await this.sleep(wait, this.abort.signal);
        delay = Math.min(delay * 2, retryMaxMs);
      }
    }
  }

  async stop() {
    if (!this.polling) return;
    this.polling = false;
    if (this.abort) this.abort.abort();
    if (this.loopPromise) await this.loopPromise;
    this.loopPromise = null;
  }
}

module.exports = TelegramBot;
module.exports.TelegramApiError = TelegramApiError;
