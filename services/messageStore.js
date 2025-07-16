const { handlePost} = require('./messageHandlersNRED.js');
const messageQueue = new Map();
let isProcessing = false;

/**
 * Добавляет сообщение в очередь для указанного клиента
 * @param {string} clientId - Идентификатор клиента
 * @param {object} message - Сообщение для добавления в очередь
 */
function addMessageToQueue(clientId, message) {
  //console.log(`📬 Добавление сообщения в очередь для ${clientId}. Тип: ${message.type}, Имя: ${message.name}, Запрос: ${message.request}, Комната: ${message.payload.room}, Датчик: ${message.payload.item_name}`);
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
      retryCount: 0
    });
    console.log(`📬 Сообщение добавлено в очередь для ${clientId}. Ключ: ${key}`);
  } else {
    console.log(`⚠️ Сообщение уже в очереди. ${clientId} Ключ: ${key}`);
  }
}

function getAllQueueMessages() {
    messageQueue.forEach((queue, clientId) => {
    console.log('Выводим список всех сообщений в очереди:');
      console.groupCollapsed(`📂 Client: ${clientId}`);               // Группируем вывод по clientId
      queue.forEach((entry, key) => {
        console.log(`🔑 ${key}`, {
          message: entry.message,
          timestamp: entry.timestamp,
          retryCount: entry.retryCount
        });
      });
      console.groupEnd();
    });
}


function processAllQueues() {
  if (messageQueue.size === 0) return;
  console.log(`🔁 Приступаем к обработке очереди из (${messageQueue.size} клиентов)`);

  messageQueue.forEach((clientQueue, clientId) => {
    console.log(`🔁 Обработка очереди для клиента ${clientId} (сообщений: ${clientQueue.size})`);
    
    const processedKeys = [];
    
    clientQueue.forEach((entry, key) => {
      const message = entry.message;
      console.log(`🔁 Обработка сообщения: ${key}`);
      
      try {
        switch (message.type) {
          case 'post':
            console.log('processAllQueue - Type - Post');
            // Вызываем обработчик и проверяем результат
            const resultHandler = handlePost(clientId, message);
            console.log('processAllQueue - resultHandler - ', resultHandler);
            if (resultHandler === 'ok') {
              processedKeys.push(key);
              console.log(`✅ Сообщение обработано: ${key}`);
            } else {
              console.log('❌ Ошибка обработки сообщения');
              entry.retryCount++;
              if (entry.retryCount > 3) {
                processedKeys.push(key);
                console.log(`♻️ Сообщение ${key} удалено после 3 неудачных попыток`);
              }
            }
            break;
          default:
            console.log(`⚠️ Неизвестный тип сообщения: ${message.type}`);
            processedKeys.push(key); // Удаляем неизвестные типы
            break;
        }
      } catch (error) {
        console.error(`❌ Ошибка обработки: ${error.message}`);
        entry.retryCount++;
      }
    });
    
    // Удаляем обработанные сообщения
    processedKeys.forEach(key => {
      clientQueue.delete(key);
      console.log(`🧹 Удалено сообщение: ${key}`);
    });
    
    // Если очередь клиента пуста, удаляем клиента
    if (clientQueue.size === 0) {
      messageQueue.delete(clientId);
      console.log(`🧹 Очередь клиента ${clientId} пуста, удаляем.`);
    }
  });
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
      console.log(`✅ Сообщение удалено из очереди: ${key}`);
      
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

