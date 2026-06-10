const { handlePostNodeRED} = require('./messageHandlers.js');
const messageQueue = new Map();
const clientLocks = new Map(); // Блокировки для каждого клиента
let isProcessing = false;

const logger = require('./logger.js');
logger.initLogging();

/**
 * Добавляет сообщение в очередь для указанного клиента
 * @param {string} clientId - Идентификатор клиента
 * @param {object} message - Сообщение для добавления в очередь
 */
function addMessageToQueue(clientId, message) {
  logger.logDevMessage(`[messageStore]- processClientQueue - 📬 Добавление сообщения в очередь для ${clientId}
    Тип: ${message.type},
      //   Имя: ${message.name}, 
    Запрос: ${message.request}, 
    Комната: ${message.payload.room}, 
    Датчик: ${message.payload.item_name},
    Значение: ${message.payload.item_value},
    Тип: ${message.payload.item_type},
    Заголовок: ${message.payload.title},
    Группа: ${message.payload.group}
    `);
  // console.log(`[messageStore]- processClientQueue - 📬 Добавление сообщения в очередь для ${clientId}. 
  //   Тип: ${message.type}, 
  //   Имя: ${message.name}, 
  //   Запрос: ${message.request}, 
  //   Комната: ${message.payload.room}, 
  //   Датчик: ${message.payload.item_name},
  //   Значение: ${message.payload.item_value},
  //   Тип: ${message.payload.item_type},
  //   Заголовок: ${message.payload.title},
  //   Группа: ${message.payload.group}
  //   `);
  if (!messageQueue.has(clientId)) {
    messageQueue.set(clientId, new Map());
  }
  
  const queue = messageQueue.get(clientId);
  const key = `${message.type}|${message.name}|${message.request}|${message.payload.room}|${message.payload.item_name}`;
  
  // Проверяем, есть ли уже такое сообщение в очереди
  if (!queue.has(key)) {
    queue.set(key, {
      message,
      timestamp: Date.now(),
      retryCount: 0,
      lastAttempt: 0
    });
    logger.logDevMessage(`[messageStore]- processClientQueue - 📬 Сообщение добавлено в очередь для ${clientId}. Ключ: ${key}`);
    //console.log(`[messageStore]- processClientQueue - 📬 Сообщение добавлено в очередь для ${clientId}. Ключ: ${key}`);
  } else {
    logger.logDevMessage(`[messageStore]- processClientQueue - ⚠️  Сообщение уже в очереди. ${clientId} Ключ: ${key}`);
    //console.log(`[messageStore]- processClientQueue - ⚠️  Сообщение уже в очереди. ${clientId} Ключ: ${key}`);
  }
}

function getAllQueueMessages() {
    messageQueue.forEach((queue, clientId) => {
      logger.logDevMessage(`[messageStore]- processClientQueue - Выводим список всех сообщений в очереди:`);
    //console.log('[messageStore]- processClientQueue - Выводим список всех сообщений в очереди:');
    logger.logDevMessage(`📂 Client: ${clientId}`);

      //console.groupCollapsed(`📂 Client: ${clientId}`);               // Группируем вывод по clientId
      queue.forEach((entry, key) => {
        console.log(`🔑 ${key}`, {
          message: entry.message,
          timestamp: Date.now(),
          retryCount: entry.retryCount
        });
      });
      console.groupEnd();
      logger.logDevMessage(`📂 Client: ${clientId} - Сообщений в очереди: ${queue.size}`);
      
    });
}

async function processClientQueue(clientId) {
    if (!messageQueue.has(clientId) || clientLocks.has(clientId)) return;
    
    clientLocks.set(clientId, true); // Блокируем клиента
    const clientQueue = messageQueue.get(clientId);
    const processedKeys = [];
    const now = Date().toString();
    
    try {
        for (const [key, entry] of clientQueue.entries()) {
            // Пропускаем если не прошло 5 секунд с последней попытки
            if (now - entry.lastAttempt < 5000) continue;
            logger.logDevMessage(`[messageStore]- processClientQueue - 🔁 Обработка сообщения: ${key}`);
            //console.log(`[messageStore] - processClientQueue - 🔁 Обработка сообщения: ${key}`);
            entry.lastAttempt = now;
            
            try {
                let result = 'error';
                switch (entry?.message?.type) {
                    case 'post':
                        result = await handlePostNodeRED(clientId, entry.message);
                        break;
                    default:
                      logger.logErrorMessage(`[messageStore]- processClientQueue - ⚠️ Неизвестный тип сообщения: ${entry.message.type}`);
                      //console.warn(`[messageStore] - processClientQueue- ⚠️ Неизвестный тип сообщения: ${entry.message.type}`);
                }
                
                if (result === 'ok') {
                    processedKeys.push(key);
                    logger.logDevMessage(`[messageStore]- processClientQueue - ✅ Сообщение обработано: ${key}`)
                    //console.log(`[messageStore]- processClientQueue - ✅ Сообщение обработано: ${key}`);
                } else {
                    entry.retryCount++;
                    if (entry.retryCount > 3) {
                        processedKeys.push(key);
                        logger.logErrorMessage(`[messageStore]- processClientQueue - ♻️ Сообщение ${key} удалено после 3 неудачных попыток`);
                        //console.warn(`[messageStore]- processClientQueue - ♻️ Сообщение ${key} удалено после 3 неудачных попыток`);
                    }
                }
            } catch (error) {
              logger.logErrorMessage(`[messageStore]- processClientQueue - ❌ Ошибка обработки: ${error.message}`);
                //console.error(`[messageStore]- processClientQueue - ❌ Ошибка обработки: ${error.message}`);
                entry.retryCount++;
            }
        }
    } finally {
        // Удаляем обработанные сообщения
        processedKeys.forEach(key => clientQueue.delete(key));
        
        if (clientQueue.size === 0) {
            messageQueue.delete(clientId);
        }
        
        clientLocks.delete(clientId); // Снимаем блокировку
    }
}

async function processAllQueues() {
    if (messageQueue.size === 0) return;
    
    const processingPromises = [];
    for (const clientId of messageQueue.keys()) {
        processingPromises.push(processClientQueue(clientId));
    }
    
    await Promise.all(processingPromises);
}


async function triggerQueueProcessing() {
  if (isProcessing) return;
  isProcessing = true;
  try {
    await processAllQueues();
  } finally {
    isProcessing = false;
  }
}


/**
 * Удаляет сообщение из очереди по ключу
 * @param {string} clientId - Идентификатор клиента
 * @param {string} key - Ключ сообщения
 */
function removeFromQueue(clientId, key) {
  if (messageQueue.has(clientId)) {
    const clientQueue = messageQueue.get(clientId);
    if (clientQueue.has(key)) {
      clientQueue.delete(key);
      logger.logDevMessage(`[messageStore]- processClientQueue - ✅ Сообщение удалено из очереди: ${key}`);
      
      // Удаляем пустую очередь клиента
      if (clientQueue.size === 0) {
        messageQueue.delete(clientId);
      }
    }
  }
}

module.exports = {
    messageQueue,
  addMessageToQueue,
  getAllQueueMessages,
  processAllQueues,
  removeFromQueue,
  triggerQueueProcessing
};

