const express = require('express');
const http = require('http');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');
const {initServer, initUsers, initDefaulUser, initDB_dID} = require('./services/initServer.js');
//const tableDB = require('./services/tableDB.js');
const { nodeRedClients, registerClient, getAllClients, getClient, startHeartbeat, addMessageToQueue, processQueueForClient} = require('./services/clientsStore');
const { handleAuth, handleGet, handlePost, handleResponse, handleSet, handleError} = require('./services/messageHandlers.js'); // Подключаем обработку входящих по WS сообщений

// require('dotenv').config({ path: './conf.env' }); 
const dotenv = require('dotenv'); // Подключаем .ENV файл с переменными окружения
dotenv.config({path: './conf.env'}); // Указываем путь к  файлу .env
//const { loginUser, verifyToken } = require('./auth'); // Импортируем функции авторизации

const DBManager = require('./services/db.js'); // Импортируем DBManager

// Подключаем функции модуля joi для валидации данных
const {validType, validConfig, validPost} = require('./validate');




//const servPORT = process.env.SERVER_PORT || 3010;
const servPORT = process.env.SERVER_PORT || 3010;
const wsRedPORT = process.env.WSR_PORT || 9200;
const wsDashPORT = process.env.WSD_PORT || 9202;
const pingInterval = process.env.WS_PING_INTERVAL || 150000;
const timeOut = process.env.WS_TIME_OUT || 300000;

const app = express();
app.set(servPORT);
const server = http.createServer(app);
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());





// Инициализация сервера
const initialize = async () => {
  const envInit = process.env.INIT_DB;
  console.log('envInit - ', envInit);
  if (envInit === 'TRUE') {
    console.log('Переходим к инициализация сервера разрешена', envInit);
    try {
      await initServer(); // Выполняем инициализацию
      await initUsers(); // Проверяем существование таблицы Users
      await initDefaulUser();  // Проверяем наличие пользователя по умолчанию
      await initDB_dID(); // Проверяем есть ли база для пользователя по умолчанию Имя для базы - DEFAULT_USER_DID 
      console.log('Инициализация сервера завершена успешно.');
    } catch (error) {
      console.error('Ошибка при инициализации сервера:', error);
    }
  } else {
    console.log('Инициализация сервера запрещена INIT_DB - ', envInit);
  }


};
initialize(); // Выполняем инициализацию сервера

  // Запуск сервера
  server.listen(servPORT, () => {
    console.log(`MyHome Server is running on port ${servPORT}`);
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
    // 1. Закрываем соединения с БД
    await DBManager.closeAllPools();
    safeWrite('✅ Все соединения с базами данных закрыты.');

    // 2. Закрываем WebSocket-серверы и их соединения
    const wsServers = [
      { name: 'WSSNodeRED', instance: WSSNodeRED },
      // { name: 'WSSNodeRED_OUT', instance: WSSNodeRED_OUT },
      { name: 'WSSDash', instance: WSSDash }
    ];
    
    await Promise.all(wsServers.map(server => 
      new Promise(resolve => {
        if (server.instance && typeof server.instance.close === 'function') {
          server.instance.clients.forEach(client => client.terminate()); // Принудительное закрытие клиентских соединений
          server.instance.close(err => {
            if (err) {
              safeWrite(`🛑 ${server.name}: ошибка закрытия - ${err.message}`);
            } else {
              safeWrite(`✅ ${server.name}: успешно закрыт`);
            }
            resolve();
          });
        } else {
          safeWrite(`ℹ️ ${server.name}: невалидный сервер или уже закрыт`);
          resolve();
        }
      })
    ));

    safeWrite('✅ Все WebSocket-соединения закрыты.');

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
const WSSDash = new WebSocket.Server ({port:wsDashPORT});



// Блок с переменными
let sendToDash = true;
let sendToRed = false;
const reconnectInterval = 100;

//let activeSocket = null; // Переменная для хранения активного подключения


// Управление подключениями Node-RED клиентов
//const nodeRedClients = new Map(); // Хранит клиентов в формате: { clientId: { input: WebSocket, output: WebSocket } }
// Работаем с NodeRED
WSSNodeRED.on('connection', (ws, req) => {
console.log(`Client connected to NodeRED on port ${wsRedPORT}`);

ws.on('message', async (message) => {
      // console.log(`Starting heartbeat: interval=${pingInterval}ms, timeout=${timeOut}ms`);
      // startHeartbeat(pingInterval, timeOut);
     
      try {
        const checkInputMessage = checkMessage(message);
        console.log('-- 126 -- checkInputMessage - ', checkInputMessage.data);
        if(checkInputMessage.status === 'ok') {

          sendToDash = true;
          const clientId = checkInputMessage.data.name;
          switch (checkInputMessage.data.type) {
            case 'init':
                    const connectionType = checkInputMessage.data.payload.typeConnect;
                  if (checkInputMessage.data.request === 'init_ws') {
                    console.log('Пришло сообщение init_ws'); 

                      if (!clientId || !connectionType) {
                          console.error('Invalid wsConnect message');
                          return;
                      }
                      // Регистрация соединения
                      console.log('--205 -- serverapp.js - Регистрация соединения', connectionType);
                      registerClient(clientId, ws, connectionType);
                      console.log('Список всех зарегистрированных клинтов:', getAllClients());
                  }
                  const wsClient = getClient(clientId, connectionType);
                  if (!wsClient) {
                    console.error(`Client ${clientId} (${connectionType}) not registered`);
                    return;      // или ws.close() того соединения, на котором вы вешали этот хандлер
                  }

              break;
              case 'post':
                  console.log('-- Post -- Добавляем сообщение в очередь');
                  const key = `${checkInputMessage.data.type}|
                  ${checkInputMessage.data.name}|
                  ${checkInputMessage.data.request}|
                  ${checkInputMessage.data.payload.room}|
                  ${checkInputMessage.data.payload.item_name}`;
                  console.log('Ключ:', key);
                  addMessageToQueue(clientId, checkInputMessage.data);
              break
            default:
              // console.log('Добавляем сообщение в очередь');
              // const key = `${checkInputMessage.data.type}|${checkInputMessage.data.name}|${checkInputMessage.data.request}`;
              // console.log('Ключ:', key);
          // Проверяем готовность выходного соединения
          const outputSocket = getClient(clientId, 'output');
          
          if (outputSocket && outputSocket.readyState === WebSocket.OPEN) {
            try {
              // Пытаемся отправить сразу
              outputSocket.send(JSON.stringify(checkInputMessage.data));
              console.log(`✉️ Сообщение отправлено сразу. Ключ: ${key}`);
            } catch (error) {
              console.error(`⚠️ Ошибка прямой отправки: ${error.message}`);
              // При ошибке добавляем в очередь
              addMessageToQueue(clientId, checkInputMessage.data);
            }
          } else {
            // Если соединение не готово - добавляем в очередь
            addMessageToQueue(clientId, checkInputMessage.data);
          }
              break;
          }

        }
      } catch (error) {
        console.error('Error  -- checkInputMessage -', error);
      }
});

ws.on('close', () => {
  if (clientId) {
    // ... существующий код
    
    // Очищаем очередь для клиента
    if (messageQueue.has(clientId)) {
      console.log(`🧹 Очистка очереди для ${clientId}`);
      messageQueue.delete(clientId);
    }
  }
});

ws.on('error', (error) => {
  console.error(`WebSocket error: ${error.message}`);
});
});

// WSSNodeRED.on('connection', (ws, req) => {
//   console.log(`Client connected to NodeRED on port ${wsRedPORT}`);
//   //console.log(`Client connected to NodeRED on port ${wsRedPORT}, request: ${JSON.stringify(req)}`);
//   let clientId = null;
//   let connectionType = null;

//     ws.on('message', async (message) => {
//       console.log(`Starting heartbeat: interval=${pingInterval}ms, timeout=${timeOut}ms`);
//       startHeartbeat(pingInterval, timeOut);

//         //console.log('-- 121 -- от NodRED получено сообщение', message);
//         //console.log('Приступаем к валидации полученных  от NodRED данных');
//         try {
//         //console.log('Приступаем к валидации полученных  от NodRED данных');
//         const checkInputMessage = checkMessage(message);
//         //console.log('-- 126 -- checkInputMessage - ', checkInputMessage.data);
//         if (checkInputMessage.status === 'ok') {

//           console.log('-- 128 --- Проверка сообщения от nodeRED выполнена успешно Type -', checkInputMessage.data.type, 'Request -', checkInputMessage.data.request, 'ConnectionType -', checkInputMessage.data.payload.typeConnect);
//           sendToDash = true;
//           clientId = checkInputMessage.data.name;
//           connectionType = checkInputMessage.data.payload.typeConnect;
//                   // Обработка аутентификации соединения
//                   if (checkInputMessage.data.type === 'init' && checkInputMessage.data.request === 'init_ws') {
//                      console.log('Пришло сообщение init_ws'); 


//                       if (!clientId || !connectionType) {
//                           console.error('Invalid wsConnect message');
//                           ws.close();
//                           return;
//                       }

//                       // Регистрация соединения
//                       registerClient(clientId, ws, connectionType);
//                       console.log('Registered connection for client:', getAllClients());
//                   }

//                   // Проверка зарегистрированного соединения
//                   if (!clientId) {
//                       console.error('Message received before authentication');
//                       ws.close();
//                       return;
//                   }

//                   const wsClient = getClient(clientId, connectionType);
//                   if (!wsClient) {
//                     console.error(`Client ${clientId} (${connectionType}) not registered`);
//                     return;      // или ws.close() того соединения, на котором вы вешали этот хандлер
//                   }

//                   // проверяем live-флаг или readyState
//                   if (!wsClient.isAlive || wsClient.readyState !== WebSocket.OPEN) {
//                     console.warn(`Closing stale connection ${clientId}/${connectionType}`);
//                     wsClient.terminate();    // или .close(), но .terminate() сразу убивает
//                     // при желании:
//                     // const client = nodeRedClients.get(clientId);
//                     // client[connectionType] = null;
//                     // nodeRedClients.set(clientId, client);
//                     return;
//                   }

//                   // … дальше работаем с wsClient


//                   // Проверка типа соединения для сообщений
//                   if (connectionType !== 'input') {
//                       console.error(`Non-input connection (${connectionType}) sent message`);
//                       return;
//                   }



//           switch (checkInputMessage.data.type) {
//             case 'connect':
//             case 'auth':
//               console.log('WSSNodeRED - Type - Auth');
//               //await handleAuth(ws, checkInputMessage.data);
//               break;
//             case 'post':
//             // console.log('WSSNodeRED - Type - Post');
//               await handlePost(clientId, checkInputMessage.data);
//               break;
//             case 'get':
//               // console.log('WSSNodeRED - Type - Get');
//                 await handleGet(ws, checkInputMessage.data);
//                 break;
//             case 'response':
//                   console.log('WSSNodeRED - Type - Response');
//                   await handleResponse(ws, checkInputMessage.data);
//                   break;
//             case 'set':
//                 console.log('WSSNodeRED - Type - Set');
//                 await handleSet(ws, checkInputMessage.data);
//                 break;
//             case 'error':
//                 console.log('WSSNodeRED - Type - Error');
//                 await handleError(ws, checkInputMessage.data);
//                 break;

//             default:
//               break;
//           }


//           //console.info('Проверка сообщения выполнена без ошибок, sendToDash =', sendToDash);
//         } else {
//           console.log('Ошибка проверки сообщения от nodeRED checkInputMessage');
//           //Slogger.error(`Ошибка "${checkInputMessage}" при проверке сообщения ${message} `);
//           sendToDash = false;
//         }
//         } catch (error) {
//           console.error('Error WS.on processing message:', error);
//         }
//     });

//       ws.on('error', (error) => {
//         console.error(`WebSocket error (${connectionType}):`, error);
//         if (clientId) {
//             nodeRedClients.delete(clientId);
//             console.log(`Removed client ${clientId} due to error`);
//         }
//     });
  
//     ws.on('close', () => {
//         console.log(`Connection closed for ${clientId} (${connectionType})`);
//         if (clientId) {
//             const client = nodeRedClients.get(clientId);
//             if (client) {
//                 if (connectionType === 'input') client.input = null;
//                 else if (connectionType === 'output') client.output = null;
                
//                 if (!client.input && !client.output) {
//                     nodeRedClients.delete(clientId);
//                     console.log(`Client ${clientId} fully removed`);
//                 }
//             }
//         }
//     });

// });

// Работаем с Dashboard


WSSDash.on('connection', (ws) => {
  console.log('-- 402 -- Client connected to Dashboard on port ' + wsDashPORT);
  //Slogger.info('-- 402 -- Client connected to Dashboard on port ' + wsDashPORT);

ws.on('message', async (message) => {
  try {
    //console.log('WSSDash - Получены данные:', message);
    const data = JSON.parse(message);
    console.log('WSSDash - Данные преобразованы в json:', data);

    switch (data.type) {
      case 'auth':
        console.log('WSSDash от WebApp получено сообщение типа auth');
        await handleAuth(ws, data);
        break;
      case 'login':
        console.log('WSSDash от WebApp получено сообщение типа login');
        await handleAuth(ws, data);
        break;
      case 'get': // Используем строку 'get' для сравнения
        console.log('WSSDash - Переходим к проверке сообщения типа get.');
        await handleGet(ws, data);
        break;
      case 'post': // Используем строку 'post' для сравнения
        console.log('Переходим к проверке сообщения типа post.');
        await handlePost(ws, data);
        break;
      case 'response': // Используем строку 'request' для сравнения
        await handleResponse(ws, data);
        break;
      // case 'config': // Используем строку 'request' для сравнения
      //   await handleConfig(ws, data);
      //   break;
      case 'set': // Используем строку 'request' для сравнения
        await handleSet(ws, data);
        break;
        case 'error': // Используем строку 'request' для сравнения
        await handleError(ws, data);
        break;
      default:
        console.log('Неизвестный тип сообщения:', data.type);
        break;
    }

  } catch (error) {
    console.error('Ошибка при обработке сообщения:', error);
    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'Произошла ошибка при обработке запроса',
      })
    );
  }
});


  ws.on('error', (error) => {
    console.log('WebSocket error on Dashboard:', error);
    //Slogger.error('WebSocket error on Dashboard:', error);
  });

  ws.on('close', () => {
    console.log('Dash WebSocket connection closed');
    //Slogger.info('Dash WebSocket connection closed');
  });
});



console.log(`WebSocket servers are running on nodeRed ws port:${wsRedPORT} and DashBoard (client) ws port:${wsDashPORT}`);
//Slogger.info(`WebSocket servers are running on nodeRed ws port:${wsRedPORT} and DashBoard (client) ws port:${wsDashPORT}`);
//logger.debug(`WebSocket servers are running on ws://localhost:${wsRedPORT} and ws://localhost:${wsDashPORT}`);
setTimeout(() => {
    sendToDash = false;
}, reconnectInterval);


function stringToJSON(message) {
  const data = message.toString('utf8');
    return JSON.parse(data);
};

// Проверка сообщения и дальнейшая валидация корректности структуры сообщения
function checkMessage(message) {
  const data = stringToJSON(message); // Преобразуем строку в объект JSON

  //console.log(`-- 360 -- checkMessage получило сообщение: ${message}`);
  const { error } = validType(data);
  if (error) {
    console.log(`Некорректный формат полученного сообщения. ${message} Ошибка: Error validType: ${error.message}`);
    //Slogger.error(`Некорректный формат полученного сообщения. ${message} Ошибка: Error validType: ${error.message}`);
    return error;
  }
  return {status:'ok', data: data};
};

// Работа с GPIO
const deviceName = process.env.DEVICE_NAME;
const manageDoor = process.env.MANAGE_DOOR === 'true'; // Преобразуем значение в boolean
// console.log('deviceName:', deviceName);
// console.log('MANAGE_DOOR:', manageDoor);

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
