// services/messageStore.js
// Очередь входящих данных датчиков (post от NodeRED и моста Modbus) перед записью в config-файл dID.
//
// Ключ записи: type|name|request|room|item_name — повтор с тем же ключом заменяет значение,
// поэтому в файл попадает только последнее значение каждого датчика.
// processAllQueues() вызывается по таймеру из serverapp.js; запись не чаще раза в 5 с,
// после 3 неудачных повторов (ошибка или результат не 'ok') сообщение удаляется.
'use strict';

const { handlePostNodeRED } = require('./messageHandlers.js');
const logger = require('./logger.js');

const RETRY_DELAY_MS = 5000;
const MAX_RETRIES = 3;

const messageQueue = new Map(); // dID -> Map(key -> { message, timestamp, retryCount, lastAttempt })
const clientLocks = new Set();  // dID, очередь которого сейчас обрабатывается

const queueKey = (m) => `${m.type}|${m.name}|${m.request}|${m.payload?.room}|${m.payload?.item_name}`;

function addMessageToQueue(clientId, message) {
  if (!messageQueue.has(clientId)) messageQueue.set(clientId, new Map());
  const queue = messageQueue.get(clientId);
  const key = queueKey(message);

  const existing = queue.get(key);
  if (existing) {
    existing.message = message; // оставляем самое свежее значение
    existing.retryCount = 0;
    logger.logDevMessage(`[messageStore] - addMessageToQueue - обновлено: ${key}`);
  } else {
    queue.set(key, { message, timestamp: Date.now(), retryCount: 0, lastAttempt: 0 });
    logger.logDevMessage(`[messageStore] - addMessageToQueue - добавлено: ${key}`);
  }
}

async function processEntry(clientId, entry) {
  if (entry.message?.type !== 'post') {
    logger.logErrorMessage(`[messageStore] - processClientQueue - неизвестный тип сообщения: ${entry.message?.type}`);
    return false;
  }
  try {
    return (await handlePostNodeRED(clientId, entry.message)) === 'ok';
  } catch (error) {
    logger.logErrorMessage(`[messageStore] - processClientQueue - ошибка обработки: ${error.message}`);
    return false;
  }
}

async function processClientQueue(clientId) {
  if (!messageQueue.has(clientId) || clientLocks.has(clientId)) return;
  clientLocks.add(clientId);
  const queue = messageQueue.get(clientId);
  const now = Date.now();

  try {
    for (const [key, entry] of queue.entries()) {
      if (now - entry.lastAttempt < RETRY_DELAY_MS) continue;
      entry.lastAttempt = now;
      const processing = entry.message;

      if (await processEntry(clientId, entry)) {
        // Пока шла запись, могло прийти более свежее значение — его оставляем в очереди
        if (entry.message === processing) queue.delete(key);
        else entry.lastAttempt = 0;
        logger.logDevMessage(`[messageStore] - processClientQueue - обработано: ${key}`);
        continue;
      }
      entry.retryCount++;
      if (entry.retryCount > MAX_RETRIES) {
        queue.delete(key);
        logger.logErrorMessage(`[messageStore] - processClientQueue - ${key} удалено после ${MAX_RETRIES} неудачных повторов`);
      }
    }
  } finally {
    if (queue.size === 0) messageQueue.delete(clientId);
    clientLocks.delete(clientId);
  }
}

async function processAllQueues() {
  if (messageQueue.size === 0) return;
  await Promise.all([...messageQueue.keys()].map(processClientQueue));
}

module.exports = {
  messageQueue,
  addMessageToQueue,
  processAllQueues,
};
