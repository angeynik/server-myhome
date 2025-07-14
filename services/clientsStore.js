// clientsStore.js
const WebSocket = require('ws');
const messageQueue = new Map();

// Формат Map: clientId → { input: WebSocket|null, output: WebSocket|null }
const nodeRedClients = new Map();

function registerClient(clientId, ws, connectionType) {
  console.log( '--9-- clientStore - registerClient - Начинаем регистрацию');
  if (!['input', 'output'].includes(connectionType)) {
    throw new TypeError(`registerClient: invalid connectionType "${connectionType}"`);
  }

  // Получаем или создаём контейнер
  const client = nodeRedClients.get(clientId) || { input: null, output: null, meta: {} };
  console.log( '-- 16 -- clientStore - registerClient - Получили client'); 

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

  console.log(`registerClient — ${connectionType} для ${clientId} зарегистрирован.`);
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
    console.log(`🗑 cleanup — client ${clientId} removed`);
  } else {
    nodeRedClients.set(clientId, client);
    console.log(`🔄 cleanup — ${connectionType} of ${clientId} set to null`);
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
            console.warn(`💀 heartbeat — ${clientId}/${type} dead, cleaning up`);
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
                console.error(`Ping error for ${clientId}/${type}:`, err);
                cleanupConnection(clientId, type);
              }
            });
          } catch (error) {
            console.error(`Ping failed for ${clientId}/${type}:`, error);
            cleanupConnection(clientId, type);
          }

      });
    });
  } catch (err) {
    console.error('🔥 Heartbeat error:', err);
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

/**
 * Добавляет сообщение в очередь для указанного клиента
 * @param {string} clientId - Идентификатор клиента
 * @param {object} message - Сообщение для добавления в очередь
 */
function addMessageToQueue(clientId, message) {
  if (!messageQueue.has(clientId)) {
    messageQueue.set(clientId, new Map());
  }
  
  const queue = messageQueue.get(clientId);
  const key = `${message.type}|${message.name}|${message.request}`;
  
  // Проверяем, есть ли уже такое сообщение в очереди
  if (!queue.has(key)) {
    queue.set(key, {
      message,
      timestamp: Date.now(),
      retryCount: 0
    });
    console.log(`📬 Сообщение добавлено в очередь для ${clientId}. Ключ: ${key}`);
  } else {
    console.log(`⚠️ Сообщение уже в очереди. Ключ: ${key}`);
  }
}

/**
 * Удаляет сообщение из очереди по ключу
 * @param {string} clientId - Идентификатор клиента
 * @param {string} key - Ключ сообщения
 */
function removeFromQueue(clientId, key) {
  if (messageQueue.has(clientId)) {
    const queue = messageQueue.get(clientId);
    if (queue.delete(key)) {
      console.log(`✅ Сообщение удалено из очереди. Клиент: ${clientId}, ключ: ${key}`);
      
      // Если очередь пуста - удаляем запись клиента
      if (queue.size === 0) {
        messageQueue.delete(clientId);
      }
    }
  }
}

/**
 * Отправляет все сообщения из очереди для указанного клиента
 * @param {string} clientId - Идентификатор клиента
 */
function processQueueForClient(clientId) {
  if (messageQueue.has(clientId)) {
    const queue = messageQueue.get(clientId);
    const outputSocket = getClient(clientId, 'output');
    
    if (!outputSocket || outputSocket.readyState !== WebSocket.OPEN) {
      console.log(`⌛ Выходное соединение для ${clientId} не готово`);
      return;
    }
    
    console.log(`🔁 Обработка очереди для ${clientId} (${queue.size} сообщений)`);
    
    for (const [key, item] of queue) {
      try {
        outputSocket.send(JSON.stringify(item.message));
        console.log(`✉️ Сообщение отправлено из очереди. Ключ: ${key}`);
        removeFromQueue(clientId, key);
      } catch (error) {
        console.error(`⚠️ Ошибка отправки сообщения из очереди: ${error.message}`);
        item.retryCount++;
        
        // Удаляем сообщение после 3 неудачных попыток
        if (item.retryCount >= 3) {
          console.error(`🗑️ Удаление сообщения после 3 неудачных попыток. Ключ: ${key}`);
          removeFromQueue(clientId, key);
        }
      }
    }
  }
}


module.exports = {
  nodeRedClients,
  registerClient,
  cleanupConnection,
  getClient,
  getAllClients,
  startHeartbeat,
  addMessageToQueue,
  removeFromQueue,
  processQueueForClient
};
