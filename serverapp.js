const express = require('express');
const http = require('http');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');
const {initServer, initUsers, initDefaulUser, initDB_dID} = require('./services/initServer.js');
//const tableDB = require('./services/tableDB.js');

const wsManager = require('./classes/wsManager.js');
const { nodeRedClients, registerClient, getAllClients, getClient, startHeartbeat} = require('./services/clientsStore');
const { addMessageToQueue, getAllQueueMessages, processAllQueues, removeFromQueue, triggerQueueProcessing} = require('./services/messageStore.js');
const { handleAuth, handleGet, handlePost, handleResponse, handleSet, handleError} = require('./services/messageHandlers.js'); // Подключаем обработку входящих по WS сообщений

// require('dotenv').config({ path: './conf.env' }); 
const dotenv = require('dotenv'); // Подключаем .ENV файл с переменными окружения
dotenv.config({path: './conf.env'}); // Указываем путь к  файлу .env
//const { loginUser, verifyToken } = require('./auth'); // Импортируем функции авторизации

const DBManager = require('./services/db.js'); // Импортируем DBManager

// Подключаем функции модуля joi для валидации данных
const {validType} = require('./validate');

const logger = require('./services/logger.js');
logger.initLogging();

const servPORT = process.env.SERVER_PORT || 3010;
const wsRedPORT = process.env.WSR_PORT || 9200;
const wsDashPORT = process.env.WSD_PORT || 9202;
// const EXT_URL = process.env.EXT_URL || 'http://192.168.1.94:3020';
// const LOCAL_URL = process.env.LOCAL_URL || 'http://localhost:3020';
// const pingInterval = process.env.WS_PING_INTERVAL || 150000;
// const timeOut = process.env.WS_TIME_OUT || 300000;

const app = express();
app.set(servPORT);
const server = http.createServer(app);
app.use(cors());
// app.use(cors({
//   origin: [EXT_URL, LOCAL_URL],
//   credentials: true
// }));
app.use(express.json());
app.use(bodyParser.json());





// Инициализация сервера
const initialize = async () => {
  const envInit = process.env.INIT_DB;
  logger.logDevMessage(`[Serverapp] - envInit - инициализация сервера - ${envInit}`);
  if (envInit === 'TRUE') {
    try {
      await initServer(); // Выполняем инициализацию
      await initUsers(); // Проверяем существование таблицы Users
      await initDefaulUser();  // Проверяем наличие пользователя по умолчанию
      await initDB_dID(); // Проверяем есть ли база для пользователя по умолчанию Имя для базы - DEFAULT_USER_DID 
      logger.logDevMessage(`[Serverapp] - Инициализация сервера завершена успешно.`);
    } catch (error) {
      logger.logErrorMessage(`[Serverapp] - Ошибка при инициализации сервера: ${error}`);
      //console.error('[Serverapp] - Ошибка при инициализации сервера:', error);
    }
  } else {
    logger.logInfoMessage(`[Serverapp] - Инициализация сервера запрещена INIT_DB - ${envInit}`);
    //console.log('[Serverapp] - Инициализация сервера запрещена INIT_DB - ', envInit);
  }


};
initialize(); // Выполняем инициализацию сервера

  // Запуск сервера
  server.listen(servPORT, () => {
    logger.logInfoMessage(`[Serverapp] - MyHome Server is running on port ${servPORT}`);
    //console.log(`[Serverapp] - MyHome Server is running on port ${servPORT}`);
  });

  // Корректное завершение работы сервера и закрытие соединения с базой данных //////////////////////////////////////////////////////
let isShuttingDown = false;
let forceShutdownTimer;

const handleShutdown = async () => {
  if (isShuttingDown) {
    safeWrite('ℹ️ Завершение уже начато, ожидайте...');
    return;
  }
  
  isShuttingDown = true;
  safeWrite('\n🛑 Получен сигнал завершения. Начинаю остановку сервера...');

  try {
    // 0. Останавливаем heartbeat мониторинг
    wsManager.stopHeartbeat();
    safeWrite('✅ Heartbeat monitoring stopped');

    // 1. Закрываем соединения с БД
    await DBManager.closeAllPools();
    safeWrite('✅ Все соединения с базами данных закрыты.');

    // 2. Закрываем WebSocket-серверы и их соединения
    // const wsServers = [
    //   { name: 'WSSNodeRED', instance: WSSNodeRED },
    //   // { name: 'WSSNodeRED_OUT', instance: WSSNodeRED_OUT },
    //   { name: 'WSSDash', instance: WSSDash }
    // ];
    // await Promise.all(wsServers.map(server => 
    //   new Promise(resolve => {
    //     if (server.instance && typeof server.instance.close === 'function') {
    //       server.instance.clients.forEach(client => client.terminate()); // Принудительное закрытие клиентских соединений
    //       server.instance.close(err => {
    //         if (err) {
    //           safeWrite(`🛑 ${server.name}: ошибка закрытия - ${err.message}`);
    //         } else {
    //           safeWrite(`✅ ${server.name}: успешно закрыт`);
    //         }
    //         resolve();
    //       });
    //     } else {
    //       safeWrite(`ℹ️ ${server.name}: невалидный сервер или уже закрыт`);
    //       resolve();
    //     }
    //   })
    // ));
    // safeWrite('✅ Все WebSocket-соединения закрыты.');

    // 2. Закрываем WebSocket-серверы и их соединения через wsManager
    safeWrite('🔄 Закрываем WebSocket соединения...');

    try {

      // Очищаем все соединения через wsManager
      const cleanupResults = [
        { name: 'Dashboard connections', result: wsManager.cleanup('VUE_connections') },
        { name: 'NodeRED connections', result: wsManager.cleanup('nRED_connections') }
      ];

      cleanupResults.forEach(({ name, result }) => {
        if (result) {
          safeWrite(`✅ ${name} успешно очищены`);
        } else {
          safeWrite(`⚠️ ${name} не были очищены (возможно, уже закрыты)`);
        }
      });

      safeWrite('✅ Все WebSocket соединения закрыты через wsManager');

      // Закрываем сами WebSocket серверы
      const wsServers = [
        { name: 'WSSNodeRED', instance: WSSNodeRED },
        { name: 'WSSDash', instance: WSSDash }
      ];
      
      await Promise.all(wsServers.map(server => 
        new Promise(resolve => {
          if (server.instance && typeof server.instance.close === 'function' && server.instance._server) {
            server.instance.close(err => {
              if (err) {
                safeWrite(`🛑 ${server.name}: ошибка закрытия - ${err.message}`);
              } else {
                safeWrite(`✅ ${server.name}: WebSocket сервер успешно закрыт`);
              }
              resolve();
            });
          } else {
            safeWrite(`ℹ️ ${server.name}: сервер уже закрыт или невалиден`);
            resolve();
          }
        })
      ));

    } catch (error) {
      safeWrite(`⚠️ Ошибка при закрытии WebSocket соединений: ${error.message}`);
    };

    // 3. Закрываем Express сервер
    if (server && server.listening) {
      await new Promise(resolve => {
        server.close(err => {
          if (err) {
            safeWrite(`⛔ Ошибка закрытия сервера: ${err.message}`);
          } else {
            safeWrite('✅ Сервер Express успешно остановлен');
          }
          resolve();
        });
      });
    } else {
      safeWrite('ℹ️ Сервер Express не запущен или уже остановлен');
    }

    // 4. Принудительно завершаем процесс после успешного закрытия всех сервисов
    safeWrite('🎯 Завершение выполнено успешно.');
    process.exit(0);

  } catch (error) {
    safeWrite(`⚠️ Критическая ошибка: ${error.message}`);
  } finally {
    // Таймер принудительного завершения (если процесс зависает)
    forceShutdownTimer = setTimeout(() => {
      safeWrite('⏱️ Принудительное завершение по таймауту');
      process.exit(1);
    }, 5000);
  }
};

// Функция безопасного вывода
const safeWrite = (message) => {
  try {
    process.stderr.write(message + '\n');
  } catch (e) {}
};

// Обработчики сигналов
process.on('SIGINT', () => handleShutdown());
process.on('SIGTERM', () => handleShutdown());


const WebSocket = require('ws');
const { mkdir } = require('fs');
const { error } = require('console');

//устанавливаем соединение через Web Socket
const WSSNodeRED = new WebSocket.Server ({port:wsRedPORT});
const WSSDash = new WebSocket.Server ({port:wsDashPORT, host: '0.0.0.0' });

logger
//console.log(`WebSocket servers are running on nodeRed ws port:${wsRedPORT} and DashBoard (client) ws port:${wsDashPORT}`);

// ✅ ЗАПУСКАЕМ HEARTBEAT ДЛЯ ВСЕХ WebSocket СОЕДИНЕНИЙ
wsManager.startHeartbeat('VUE_connections', 180000, 370000); // Для Dashboard соединений
wsManager.startHeartbeat('nRED_connections', 240000, 500000); // Для NodeRED соединений
logger.logDevMessage('[Serverapp] - Heartbeat monitoring started for all WebSocket  connections');
// console.log('[Serverapp] - Heartbeat monitoring started for all WebSocket connections');

// Запускаем обработчик очередей WebSocket сообщений каждые 5 секунд (можно чаще, например, каждую секунду)
const QUEUE_PROCESS_INTERVAL = 15000;
setInterval(async () => {
  try {
    // Логируем статистику соединений (опционально)
    const vueStats = wsManager.getStats('VUE_connections');
    const nredStats = wsManager.getStats('nRED_connections');
    logger.logDevMessage(`[Serverapp] - Connection stats - Dashboard: ${vueStats.activeConnections}/${vueStats.totalConnections} active, NodeRED: ${nredStats.activeConnections}/${nredStats.totalConnections} active`);

    // Обработка очередей
    logger.logDevMessage('[Serverapp] - Проверяем сообщения в очередях:');
    const allQueueMessages = getAllQueueMessages();
    logger.logDevMessage(`[Serverapp] - Сообщений в очередях: ${JSON.stringify(allQueueMessages, null, 2)}`);

    await processAllQueues();
  } catch (error) {
    logger.logErrorMessage(`[Serverapp] - Ошибка обработки очереди: ${error}`);
    //console.error('[Serverapp] - Ошибка обработки очереди:', error);
  }
}, QUEUE_PROCESS_INTERVAL).unref();

// Блок с переменными
let sendToRed = false;
const reconnectInterval = 100;

// Работаем с NodeRED
WSSNodeRED.on('connection', (ws, req) => {
  logger.logDevMessage(`[Serverapp] - WSSNodeRED.on - Новое подключение nodeRED (VUE)`);
  const connectionId = wsManager.registerConnection(ws, 'nodeRED', null);
  logger.logDevMessage(`[Serverapp] - WSSNodeRED.on - nodeRED соединение зарегистрировано: ${connectionId}`);


  const params = new URLSearchParams(req.url.replace(/^.*\?/, ""));
  const id = params.get("id");
  logger.logInfoMessage(`[Serverapp] - WSSNodeRED.on - id: ${id}`);
  //console.log(`Подключился клиент: id = ${id}`);


logger.logDevMessage(`Client connected to NodeRED on port ${wsRedPORT}`);

ws.on('message', async (message) => {
     
      try {
        const checkInputMessage = checkMessage(message);
        logger.logDevMessage(`[Serverapp] - WSSNodeRED - checkInputMessage - ${JSON.stringify(checkInputMessage, null, 2)}`);
        //console.log(`[Serverapp] - WSSNodeRED - checkInputMessage - ${JSON.stringify(checkInputMessage, null, 2)}`);
        if(checkInputMessage.status === 'ok') {

          const dID = checkInputMessage.data.name;
          
          switch (checkInputMessage?.data?.type) {
            case 'init':     
                  if (checkInputMessage.data.request === 'init_ws') {
                    logger.logDevMessage(`[Serverapp] - WSSNodeRED - Пришло сообщение init_ws: ${JSON.stringify(checkInputMessage.data, null, 2)}`);
                    wsManager.updateConnection('nRED_connections', connectionId, Date.now(), checkInputMessage.data.name);
                  }
              break;
            case 'post':
                  logger.logDevMessage(`[Serverapp] - WSSNodeRED - Post -- Добавляем сообщение в очередь`);
                  const key = 
                  `${checkInputMessage.data.type}|
                  ${checkInputMessage.data.name}|
                  ${checkInputMessage.data.request}|
                  ${checkInputMessage.data.payload.room}|
                  ${checkInputMessage.data.payload.item_name}|
                  ${checkInputMessage.data.payload.item_value}`;
                  addMessageToQueue(dID , checkInputMessage.data);
                  
                  try {
                  broadcast(connectionId, dID, checkInputMessage.data);
                  } catch (error) {
                    logErrorMessage(`[Serverapp] - Ошибка отправки полученного сообщения от NodeRED  клиенту WSSDash: ${error}`);
                  }
              break;
s
            default:
              break;
          }

        }
      } catch (error) {
        console.error('[Serverapp] - Error  -- checkInputMessage -', error);
      }
});

ws.on('close', () => {
  logger.logInfoMessage(`[Serverapp] - WSSNodeRED - WebSocket connection closed`);
  //console.log('[Serverapp] - WebSocket connection closed');
});

ws.on('error', (error) => {
  logger.logErrorMessage(`[Serverapp] - WSSNodeRED - WebSocket error: ${error.message}`);
  //console.error(`[Serverapp] - WebSocket error: ${error.message}`);
});
});

// Работаем с Dashboard

WSSDash.on('connection', (ws) => {
  logger.logInfoMessage(`[Serverapp] - WSSDash.on - Новое подключение Dashboard (VUE)`);
  const connectionId = wsManager.registerConnection(ws, 'dashboard', null);

  logger.logDevMessage(`[Serverapp] - WSSDash.on - VUE соединение зарегистрировано: ${connectionId}`);

  const allClients = wsManager.getAllActiveConnections();
  logger.logDevMessage(`[Serverapp] - WSSDash.on - Все соединения:`, allClients);

  WSSDash.clients.forEach((client) => {
    client.send(
                        JSON.stringify({
                          type: 'Проверка связи',
                          request:'serverConnected',
                          message: 'Проверка связи',
                        }))
  });

  
  ws.on('message', (message) => {
    logger.logDevMessage(`[Serverapp] - WSSDash.on - Пришло сообщение: ${message}`);
      try {
        const dashData = checkMessage(message);
        if(dashData.status === 'ok') {
          logger.logDevMessage(`[Serverapp] - WSSDash - checkInputMessage - OK  - ${JSON.stringify(dashData, null, 2)}`);
          switch (dashData?.data?.type) {
            case 'auth':
                const auth = dashData.data.payload;
                logger.logDevMessage(`[Serverapp] - WSSDash - Пришло сообщение auth: ${JSON.stringify(auth, null, 2)}`);
                handleAuth(connectionId, dashData.data);
                break;
            case 'get': 
                logger.logDevMessage(`[Serverapp] - WSSDash - Пришло сообщение get: ${JSON.stringify(dashData.data, null, 2)}`);
                handleGet(connectionId, dashData.data);
                break;
            case 'post':
              console.log(`[Serverapp] - WSSDash - Пришло сообщение post: ${JSON.stringify(dashData, null, 2)}`);
            //logger.logDevMessage(`[Serverapp] - WSSDash - Пришло сообщение post: ${JSON.stringify(dashData.data, null, 2)}`);
                handlePost(connectionId, dashData.data);
                const dID = dashData.data.name;
                try {
                    //sendToNodeRED(dID, dashData.data);
                    broadcast(connectionId, dID, dashData.data);
                    // Рассылка только NodeRED клиентам  
                  //broadcast(dID, messageData, ['nRED_connections']);
                } catch (error) {
                    console.log('[Serverapp] -  Ошибка отправки полученного сообщения от VUE клиента к NodeRED:', error);
                }
            break;
            default:
              break;
          }
        }
      } catch (error) {
        logger.logErrorMessage(`[Serverapp] - WSSDash - Error  -- checkInputMessage - ${error.message}`);
        //console.error('-[Serverapp] -  Error  -- checkInputMessage -', error);
      }
  });

  ws.on('error', (error) => {
    logger
      //console.error('[Serverapp] - WebSocket error on Dashboard:', error);
  });

  ws.on('close', () => {
    logger.logInfoMessage(`[Serverapp] - WSSDash - WebSocket connection closed`);
      //console.info('[Serverapp] - Dash WebSocket connection closed');
  });
});



//console.log(`WebSocket servers are running on nodeRed ws port:${wsRedPORT} and DashBoard (client) ws port:${wsDashPORT}`);



function broadcast(excludeClientId, dID, data, targets = ['VUE_connections', 'nRED_connections']) {
  logger.logDevMessage('[Serverapp] - broadcast - excludeClientId =', excludeClientId, 'dID =', dID, 'targets =', targets, 'data =', data);
  //console.log('[Serverapp] - broadcast: excludeClientId =', excludeClientId, 'dID =', dID, 'targets =', targets, 'data =', data);
  
  // Добавляем временную метку
  data.time = new Date().toString();
  
  try {
    let totalSent = 0;
    
    targets.forEach(targetType => {
      // Получаем все активные соединения указанного типа с нужным dID
      const userConnections = wsManager.getUserConnections(targetType, dID);
      
      if (userConnections.length === 0) {
        logger.logDevMessage(`[Serverapp] - broadcast - Нет активных соединений типа ${targetType} с dID: ${dID}`);
        //console.log(`[Serverapp] - broadcast - Нет активных соединений типа ${targetType} с dID: ${dID}`);
        return;
      }
      
      let typeSent = 0;
     
      // Отправляем сообщение каждому соединению с нужным dID, исключая отправителя
      userConnections.forEach(({ clientId, connection }) => {
        if (clientId === excludeClientId) {
          logger.logDevMessage(`[Serverapp] - broadcast - Пропускаем отправителя: ${clientId}`);
          //console.log(`[Serverapp] - broadcast - Пропускаем отправителя: ${clientId}`);
          return;
        }
        
        // Проверяем, что соединение активно
        if (connection.ws && connection.ws.readyState === WebSocket.OPEN) {
          try {
            // Отправляем исходное сообщение в неизменном виде
            const messageString = JSON.stringify(data);
            connection.ws.send(messageString);
            typeSent++;
            totalSent++;
            console.log(`[Serverapp] - broadcast - Сообщение отправлено клиенту: ${clientId} (${targetType})`);
          } catch (error) {
            console.error(`[Serverapp] - broadcast - Ошибка отправки клиенту ${clientId}:`, error);
          }
        }
      });
     logger.logDevMessage(`[Serverapp] - broadcast - Отправлено ${typeSent}/${userConnections.length} сообщений для ${targetType} с dID: ${dID}`);
      //console.log(`[Serverapp] - broadcast - Отправлено ${typeSent}/${userConnections.length} сообщений для ${targetType} с dID: ${dID}`);
    });
    
    if (totalSent === 0) {
      logger
      //console.log(`[Serverapp] - broadcast - Нет активных клиентов для рассылки (dID: ${dID}, исключен: ${excludeClientId})`);
    } else {
      logger.logDevMessage(`[Serverapp] - broadcast - Всего отправлено ${totalSent} сообщений для dID: ${dID}`);
      //console.log(`[Serverapp] - broadcast - Всего отправлено ${totalSent} сообщений для dID: ${dID}`);
    }
    
  } catch (error) {
    logger.logErrorMessage(`[Serverapp] - broadcast - Ошибка рассылки: ${error.message}`);
    //console.error('[Serverapp] - broadcast - Ошибка рассылки:', error);
  }
};


function stringToJSON(message) {
  const data = message.toString('utf8');
    return JSON.parse(data);
};

// Проверка сообщения и дальнейшая валидация корректности структуры сообщения
function checkMessage(message) {
  const data = stringToJSON(message); // Преобразуем строку в объект JSON
  logger.logDevMessage(`[Serverapp] - checkMessage получило сообщение: ${message}`);
  const { error } = validType(data);
  if (error) {
    logger.logErrorMessage(`[Serverapp] - checkMessage - Некорректный формат полученного сообщения. ${message} Ошибка: Error validType: ${error.message}`);
    //console.log(`Некорректный формат полученного сообщения. ${message} Ошибка: Error validType: ${error.message}`);
    return error;
  }
  return {status:'ok', data: data};
};

// Работа с GPIO
const deviceName = process.env.DEVICE_NAME;
const manageDoor = process.env.MANAGE_DOOR === 'true'; // Преобразуем значение в boolean
logger.logDevMessage(`[Serverapp] - deviceName: ${deviceName} MANAGE_DOOR: ${manageDoor}`);

const GpioManager = require('./gpio.js');

// Создаем экземпляр GpioManager только если MANAGE_DOOR === true
let gpioManager;
if (manageDoor) {
  gpioManager = new GpioManager(deviceName, './gpioConf.json');

  if (gpioManager.deviceConfig) {
    // Освобождаем GPIO перед началом работы
    gpioManager.cleanupGpio();

    // Настраиваем выходные и входные пины
    gpioManager.setupOutputPins();
    gpioManager.setupInputPins();

    // Пример: Включение openPinGpio через 30 секунд
    const openPinGpio = gpioManager.deviceConfig.outputPins[0];
    setTimeout(() => {
      gpioManager.writePin(openPinGpio, 1);
    }, 30000);

    // Отслеживание состояния входных пинов
    const sensorDoorPinGpio = gpioManager.deviceConfig.inputPins[0];
    gpioManager.watchPin(sensorDoorPinGpio);

    const sensorLockPinGpio = gpioManager.deviceConfig.inputPins[1];
    gpioManager.watchPin(sensorLockPinGpio);
  }
}

// Завершение работы с GPIO
