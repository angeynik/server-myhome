// clientsStore.js
const WebSocket = require('ws');

const logger = require('./logger.js');
logger.initLogging();

// Формат Map: clientId → { input: WebSocket|null, output: WebSocket|null }
const nodeRedClients = new Map();

function registerClient(clientId, ws, connectionType) {
  logger.logDevMessage(`[clientStore] - registerClient - Начинаем регистрацию clientId: ${clientId}, connectionType: ${connectionType}`);
  if (!['input', 'output'].includes(connectionType)) {
    throw new TypeError(`registerClient: invalid connectionType "${connectionType}"`);
  }

  // Получаем или создаём контейнер
  const client = nodeRedClients.get(clientId) || { input: null, output: null, meta: {} };
  logger.logDevMessage(`[clientStore] - registerClient - Получили client: ${JSON.stringify(client, null, 2)}`);
  //console.log( '[clientStore] - - registerClient - Получили client'); 

  // Метаданные для отладки
  client.meta = {
    registeredAt: Date.now(),
    remoteAddress: ws._socket?.remoteAddress || 'unknown'
  };

  // базовая инициализация heartbeat
  ws.isAlive = true;
  ws.lastActivity = Date.now();
  ws.on('pong', () => {
    ws.isAlive = true;
    ws.lastActivity = Date.now();
  });

  // вешаем слушатели на ошибку/закрытие,
  // чтобы сразу обнулять при ручном закрытии
  ws.on('close', () => cleanupConnection(clientId, connectionType));
  ws.on('error', () => cleanupConnection(clientId, connectionType));

  // сохраняем в нужное поле
  client[connectionType] = ws;
  nodeRedClients.set(clientId, client);
  logger.logDevMessage(`[clientStore] - registerClient - Сохраняем client: ${JSON.stringify(client, null, 2)}`);
  //console.log(`[clientStore] - registerClient — ${connectionType} для ${clientId} зарегистрирован.`);
}

/**
 * Закрывает и убирает конкретное соединение (input/output)
 */
function cleanupConnection(clientId, connectionType) {
  const client = nodeRedClients.get(clientId);
  if (!client || !client[connectionType]) return;

  const ws = client[connectionType];

    // Удаляем обработчики чтобы избежать утечек памяти
  ws.removeAllListeners('pong');
  ws.removeAllListeners('close');
  ws.removeAllListeners('error');
  
  if (ws.readyState === WebSocket.OPEN) {
    // сразу убиваем
    ws.terminate();
  }
  client[connectionType] = null;

  // Если оба канала закрыты — полностью удаляем клиента
  if (!client.input && !client.output) {
    nodeRedClients.delete(clientId);
    logger.logDevMessage(`[clientStore] - 🗑 cleanup — client ${clientId} removed`);
    //console.log(`[clientStore] - 🗑 cleanup — client ${clientId} removed`);
  } else {
    nodeRedClients.set(clientId, client);
    logger.logDevMessage(`[clientStore] - 🔄 cleanup — ${connectionType} of ${clientId} set to null`);
    //console.log(`[clientStore] - 🔄 cleanup — ${connectionType} of ${clientId} set to null`);
  }
}

/**
 * Глобальный heartbeat для всех зарегистрированных сокетов.
 * Запускаем один раз при старте сервера.
 */
function startHeartbeat(interval, timeOut) {
    setInterval(() => {
  try {
        nodeRedClients.forEach((client, clientId) => {
      ['input', 'output'].forEach((type) => {
        const ws = client[type];
        if (!ws) return;
        const calcTimeOut = Date.now() - ws.lastActivity;

        // Проверка существования и состояния сокета
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            return;
          }

          // Проверяем, не провалился ли предыдущий PONG
          if (!ws.isAlive || calcTimeOut > timeOut) {
            logger.logInfoMessage(`[clientStore] - 💀 heartbeat — ${clientId}/${type} dead, cleaning up`);
            //console.warn(`[clientStore] - 💀 heartbeat — ${clientId}/${type} dead, cleaning up`);
            cleanupConnection(clientId, type);
            return;
          }


        // иначе знак жизни сбрасываем и шлём новый ping
        ws.isAlive = false;
        // ws.ping(() => {}); // привязка колбэка нужна в некоторых реализациях
          // Отправка ping с обработкой ошибок
          ws.isAlive = false;
          try {
            ws.ping(null, false, (err) => {
              if (err) {
                logger.logErrorMessage(`[clientStore] - Ping error for ${clientId}/${type}:`, err);
                //console.error(`[clientStore] - Ping error for ${clientId}/${type}:`, err);
                cleanupConnection(clientId, type);
              }
            });
          } catch (error) {
            logger.logErrorMessage(`[clientStore] - Ping failed for ${clientId}/${type}:`, error);
            //console.error(`[clientStore] - Ping failed for ${clientId}/${type}:`, error);
            cleanupConnection(clientId, type);
          }

      });
    });
  } catch (err) {
    logger.logErrorMessage(`[clientStore] - 🔥 Heartbeat error:`, err);
    //console.error('[clientStore] - 🔥 Heartbeat error:', err);
  }
  }, interval).unref(); // .unref(), чтобы таймер не держал процесс
}

/**
 * Утилита для получения конкретного сокета по clientId и type
 */
function getClient(clientId, connectionType) {
  const client = nodeRedClients.get(clientId);
  return client ? client[connectionType] : undefined;
}

function getAllClients() {
  return Array.from(nodeRedClients.entries()).map(
    ([clientId, { input, output }]) => ({
      clientId,

      inputReadyState:  input?.readyState  ?? null,
      inputLastActivity: input?.lastActivity ?? null,
      inputIsAlive:      input?.isAlive     ?? null,

      outputReadyState:  output?.readyState  ?? null,
      outputLastActivity: output?.lastActivity ?? null,
      outputIsAlive:      output?.isAlive     ?? null
    })
  );
}

module.exports = {
  nodeRedClients,
  registerClient,
  cleanupConnection,
  getClient,
  getAllClients,
  startHeartbeat
};
