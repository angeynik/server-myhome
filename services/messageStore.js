const { handleGet, handlePost} = require('./messageHandlers.js');
const messageQueue = new Map();

/**
 * Добавляет сообщение в очередь для указанного клиента
 * @param {string} clientId - Идентификатор клиента
 * @param {object} message - Сообщение для добавления в очередь
 */
function addMessageToQueue(clientId, message) {
  console.log(`📬 Добавление сообщения в очередь для ${clientId}. Тип: ${message.type}, Имя: ${message.name}, Запрос: ${message.request}, Комната: ${message.payload.room}, Датчик: ${message.payload.item_name}`);
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
    console.log(`⚠️ Сообщение уже в очереди. Ключ: ${key}`);
  }
}

function getAllQueueMessages() {
      messageQueue.forEach((queue, clientId) => {
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

function processAllQueues (){
  if (messageQueue.size === 0) return;
  console.log(`🔁 Приступаем к обработке очереди из (${messageQueue.size} сообщений)`);
  messageQueue.forEach((clientId) => {
    switch (messageQueue.data.type) {
      case 'post':
        console.log('processAllQueue - Type - Post');
        if (handlePost(clientId, checkInputMessage.data)=== 'ok'){
          const key = `${message.type}|${message.name}|${message.request}|${message.payload.room}|${message.payload.item_name}`;
          removeFromQueue(clientId, key);
          console.log(`сообщение с ключом ${key} удалено из очере`);
        } else {
          console.log('processAllQueue - Type - Post - Error');
        };
        break;
      default:
        console.log(`⚠️ Неизвестный тип сообщения: ${messageQueue.data.type}`);
    }
  });
}


module.exports = {
    messageQueue,
  addMessageToQueue,
  getAllQueueMessages,
  processAllQueues
};

