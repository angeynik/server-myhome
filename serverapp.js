const express = require('express');
const http = require('http');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');
const {initServer, initUsers, initDefaulUser, initDB_dID} = require('./services/initServer.js');
//const tableDB = require('./services/tableDB.js');
const { nodeRedClients, registerClient, getAllClients, getClient, startHeartbeat} = require('./services/clientsStore');
const { addMessageToQueue, getAllQueueMessages, processAllQueues, removeFromQueue, triggerQueueProcessing} = require('./services/messageStore.js');
const { handleAuth, handleGet, handlePost, handleResponse, handleSet, handleError} = require('./services/messageHandlers.js'); // Подключаем обработку входящих по WS сообщений

// require('dotenv').config({ path: './conf.env' }); 
const dotenv = require('dotenv'); // Подключаем .ENV файл с переменными окружения
dotenv.config({path: './conf.env'}); // Указываем путь к  файлу .env
//const { loginUser, verifyToken } = require('./auth'); // Импортируем функции авторизации

const DBManager = require('./services/db.js'); // Импортируем DBManager

// Подключаем функции модуля joi для валидации данных
const {validType, validConfig, validPost} = require('./validate');


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

// Запускаем обработчик очередей WebSocket сообщений каждые 5 секунд (можно чаще, например, каждую секунду)
const QUEUE_PROCESS_INTERVAL = 15000;
setInterval(async () => {
  try {
    //console.log('Выводим список всех сообщений в очереди:');
    //getAllQueueMessages();
    await processAllQueues();
  } catch (error) {
    console.error('Ошибка обработки очереди:', error);
  }
}, QUEUE_PROCESS_INTERVAL).unref();

// Блок с переменными
let sendToRed = false;
const reconnectInterval = 100;

// Работаем с NodeRED
WSSNodeRED.on('connection', (ws, req) => {
console.log(`Client connected to NodeRED on port ${wsRedPORT}`);

ws.on('message', async (message) => {
      // console.log(`Starting heartbeat: interval=${pingInterval}ms, timeout=${timeOut}ms`);
      // startHeartbeat(pingInterval, timeOut);
     
      try {
        const checkInputMessage = checkMessage(message);
        console.log('-- 193 -- WSSNodeRED - checkInputMessage - ', checkInputMessage.data);
        if(checkInputMessage.status === 'ok') {

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
                      //console.log('--205 -- serverapp.js - Регистрация соединения', connectionType);
                      registerClient(clientId, ws, connectionType);
                      //console.log('Список всех зарегистрированных клинтов:', getAllClients());
                  }
                  const wsClient = getClient(clientId, connectionType);
                  if (!wsClient) {
                    console.error(`Client ${clientId} (${connectionType}) not registered`);
                    return;      // или ws.close() того соединения, на котором вы вешали этот хандлер
                  }

              break;
            case 'post':
                  //console.log('-- Post -- Добавляем сообщение в очередь');
                  const key = `${checkInputMessage.data.type}|
                  ${checkInputMessage.data.name}|
                  ${checkInputMessage.data.request}|
                  ${checkInputMessage.data.payload.room}|
                  ${checkInputMessage.data.payload.item_name}`;
                  //console.log('Ключ:', key);
                  addMessageToQueue(clientId, checkInputMessage.data);
                  try {
                    sendToClient(clientId, checkInputMessage.data);
                  } catch (error) {
                    console.log('--233-- Ошибка отправки полученного сообщения от NodeRED  клиенту WSSDash:', error);
                  }
                  
                  //await triggerQueueProcessing(); // Немедленный запуск обработки
              break;
s
            default:
              break;
          }

        }
      } catch (error) {
        console.error('-- 239 -- Error  -- checkInputMessage -', error);
      }
});

ws.on('close', () => {
  console.log('WebSocket connection closed');
});

ws.on('error', (error) => {
  console.error(`WebSocket error: ${error.message}`);
});
});

// Работаем с Dashboard

WSSDash.on('connection', (ws) => {
  WSSDash.clients.forEach((client) => {
    client.send(
                        JSON.stringify({
                          type: 'Проверка связи',
                          request:'serverConnected',
                          message: 'Проверка связи',
                        }))
  });

  ws.on('message', (message) => {
      //console.log (`WSSDash получено сообщение ${message}`);
      try {
        const dashData = checkMessage(message);
        console.log('-- 272 -- WSSDash - checkInputMessage - ', dashData.data);
        if(dashData.status === 'ok') {
          //console.log('-- 282 -- WSSDash - checkInputMessage - OK ');
          switch (dashData.data.type) {
            case 'auth':
                const auth = dashData.data.payload;
                //console.log('-- auth --', auth);
                handleAuth(ws, dashData.data);
                break;
                case 'get': // Используем строку 'get' для сравнения
                //console.log('WSSDash - Переходим к проверке сообщения типа get.');
                handleGet(ws, dashData.data);
                break;
            default:
              break;
          }
        }
      } catch (error) {
        console.error('-- 298 -- Error  -- checkInputMessage -', error);
      }


    //   sendToRed = true;
    //   // Передача сообщения на WSSNodeRED
    //   WSSNodeRED.clients.forEach((client) => {
    //     if (client.readyState === WebSocket.OPEN && sendToRed === true) {
    //         client.send(message, (error) => {
    //             if (error) {
    //                 console.error('Ошибка пересылки сообщения c Dashboard на NodeRED :', error);
    //             } else {
    //                 console.info(`На порт ${wsRedPORT} от Server  к NodeRED  отправлено сообщение: ${message}`);
    //             }

    //         });
    //     }
    // });
  });

  ws.on('error', (error) => {
      console.error('WebSocket error on Dashboard:', error);
  });

  ws.on('close', () => {
      console.info('Dash WebSocket connection closed');
  });
});



console.log(`WebSocket servers are running on nodeRed ws port:${wsRedPORT} and DashBoard (client) ws port:${wsDashPORT}`);


function sendToClient(dID, data) {
  console.log('sendToClient: dID =', dID, 'data =', data);
  
  data.time = new Date().toString();
  //console.log(data.time);
  
  const messageString = JSON.stringify(data);

  // Проверка готовности клиентов
  let hasOpenClients = false;
  WSSDash.clients.forEach((client) => {
    console.log(`Состояние клиента Dashboard: ${client.readyState} (${client.readyState === WebSocket.OPEN ? 'открыт' : 'не открыт'})`);
    if (client.readyState === WebSocket.OPEN) {
      hasOpenClients = true;
    }
  });

  if (!hasOpenClients) {
    console.log('Нет подключенных клиентов Dashboard в состоянии OPEN.');
    return;
  }

  // Отправка сообщения всем открытым клиентам
  WSSDash.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageString, (error) => {
        if (error) {
          console.error('Ошибка отправки сообщения на Dashboard:', error);
        } else {
          //console.log(`Сообщение отправлено на Dashboard: ${messageString}`);
        }
      });
    }
  });
};

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
