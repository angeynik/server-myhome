const { handlePost} = require('./messageHandlersNRED.js');
const messageQueue = new Map();
const clientLocks = new Map(); // Блокировки для каждого клиента
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
      retryCount: 0,
      lastAttempt: 0
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

async function processClientQueue(clientId) {
    if (!messageQueue.has(clientId) || clientLocks.has(clientId)) return;
    
    clientLocks.set(clientId, true); // Блокируем клиента
    const clientQueue = messageQueue.get(clientId);
    const processedKeys = [];
    const now = Date.now();
    
    try {
        for (const [key, entry] of clientQueue.entries()) {
            // Пропускаем если не прошло 5 секунд с последней попытки
            if (now - entry.lastAttempt < 5000) continue;
            
            console.log(`🔁 Обработка сообщения: ${key}`);
            entry.lastAttempt = now;
            
            try {
                let result = 'error';
                switch (entry.message.type) {
                    case 'post':
                        result = await handlePost(clientId, entry.message);
                        break;
                    default:
                        console.warn(`⚠️ Неизвестный тип сообщения: ${entry.message.type}`);
                }
                
                if (result === 'ok') {
                    processedKeys.push(key);
                    console.log(`✅ Сообщение обработано: ${key}`);
                } else {
                    entry.retryCount++;
                    if (entry.retryCount > 3) {
                        processedKeys.push(key);
                        console.warn(`♻️ Сообщение ${key} удалено после 3 неудачных попыток`);
                    }
                }
            } catch (error) {
                console.error(`❌ Ошибка обработки: ${error.message}`);
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


// async function processAllQueues() {
//   if (messageQueue.size === 0 || isProcessing) return;
//   isProcessing = true;

//   try {
//     console.log(`🔁 Приступаем к обработке очереди из (${messageQueue.size} клиентов)`);

//     for (const [clientId, clientQueue] of messageQueue.entries()) {
//       console.log(`🔁 Обработка очереди для клиента ${clientId} (сообщений: ${clientQueue.size})`);
      
//       const processedKeys = [];
      
//       for (const [key, entry] of clientQueue.entries()) {
//         const message = entry.message;
//         console.log(`🔁 Обработка сообщения: ${key}`);
        
//         try {
//           let resultHandler;
//           switch (message.type) {
//             case 'post':
//               console.log('processAllQueue - Type - Post');
//               resultHandler = await handlePost(clientId, message);
//               console.log('processAllQueue - resultHandler - ', resultHandler);
              
//               if (resultHandler === 'ok') {
//                 processedKeys.push(key);
//                 console.log(`✅ Сообщение обработано: ${key}`);
//               } else {
//                 console.log('❌ Ошибка обработки сообщения');
//                 entry.retryCount++;
//                 if (entry.retryCount > 3) {
//                   processedKeys.push(key);
//                   console.log(`♻️ Сообщение ${key} удалено после 3 неудачных попыток`);
//                 }
//               }
//               break;
//             default:
//               console.log(`⚠️ Неизвестный тип сообщения: ${message.type}`);
//               processedKeys.push(key);
//               break;
//           }
//         } catch (error) {
//           console.error(`❌ Ошибка обработки: ${error.message}`);
//           entry.retryCount++;
//         }
//       }
      
//       processedKeys.forEach(key => {
//         clientQueue.delete(key);
//         console.log(`🧹 Удалено сообщение: ${key}`);
//       });
      
//       if (clientQueue.size === 0) {
//         messageQueue.delete(clientId);
//         console.log(`🧹 Очередь клиента ${clientId} пуста, удаляем.`);
//       }
//     }
//   } catch (error) {
//     console.error('Ошибка при обработке очереди:', error);
//   } finally {
//     isProcessing = false;
//   }
// }

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

