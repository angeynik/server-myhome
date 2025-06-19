const express = require('express');
const http = require('http');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');

const { getAllClients, removeClient } = require('./services/clientsStore.js');
const {initServer, initUsers, initDefaulUser, initDB_dID} = require('./services/initServer.js');
const { sendSuccess, sendError, sendRequest} = require('./services/wsHelpers');
//const tableDB = require('./services/tableDB.js');
const { nodeRedInit, nodeRedPost, handleAuth, handleGet, handlePost, handleResponse, handleSet, handleError} = require('./services/messageHandlers.js'); // Подключаем обработку входящих по WS сообщений

// require('dotenv').config({ path: './conf.env' }); 
const dotenv = require('dotenv'); // Подключаем .ENV файл с переменными окружения
dotenv.config({path: './conf.env'}); // Указываем путь к  файлу .env
//const { loginUser, verifyToken } = require('./auth'); // Импортируем функции авторизации

const DBManager = require('./services/db.js'); // Импортируем DBManager

// Подключаем функции модуля joi для валидации данных
const {validType, validConfig, validPost} = require('./validate');




//const servPORT = process.env.SERVER_PORT || 3010;
const servPORT = process.env.SERVER_PORT || 3010;
const wsRedPORT_IN = process.env.WSR_PORT_IN || 9200;
const wsRedPORT_OUT = process.env.WSR_PORT_OUT || 9201;
const wsDashPORT_IN = process.env.WSD_PORT_IN || 9202;



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
      { name: 'WSSNodeRED_OUT', instance: WSSNodeRED_OUT },
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
const WSSNodeRED= new WebSocket.Server ({port:wsRedPORT_IN});
const WSSNodeRED_OUT= new WebSocket.Server ({port:wsRedPORT_OUT});

const WSSDash = new WebSocket.Server ({port:wsDashPORT_IN});

// Блок с переменными
let sendToDash = true;
//let sendToRed = false;
const reconnectInterval = 100;

//let activeSocket = null; // Переменная для хранения активного подключения



// Работаем с NodeRED //////////////////////////////////////////////////////
WSSNodeRED.on('connection', (ws) => {
  //console.log(`Input - Client connected to NodeRED on port ${wsRedPORT_IN.address().port}`);
  console.log(`Input - Client connected to NodeRED on port ${wsRedPORT_IN}`);

  ws.on('message', async (message) => {
  //console.log('-- 210 -- от NodRED получено сообщение', message);
  //console.log('Приступаем к валидации полученных  от NodRED данных');
      try {
      // Проверка типа сообщения
      // Временно отключаем валидацию для проверки механизма пересылки от Server к 
      console.log('Приступаем к валидации полученных  от NodRED данных');
      const checkInputMessage = checkMessage(message);
      //console.log('checkInputMessage - ', checkInputMessage);
      if (checkInputMessage.status === 'ok') {
        console.log('-- 161 --- Проверка сообщения от nodeRED выполнена успешно', checkInputMessage.data);
        //Slogger.info(`Проверка сообщения ${message} выполнена без ошибок, checkInputMessage = ${checkInputMessage}`);
        sendToDash = true;
        // Добавляем ID отправителя в сообщение
        //checkInputMessage.data.senderId = clientId;
        //console.log('Добавляем ID отправителя в сообщение senderId - ', checkInputMessage.data);
        switch (checkInputMessage.data.type) {
          case 'auth':
            console.log('WSSNodeRED - Type - Auth');
             //await handleAuth(ws, checkInputMessage.data);
            break;
            case 'init':
            console.log('WSSNodeRED - Type - Init');
             await nodeRedInit(ws, checkInputMessage.data);
            // const activeConnections = getAllClients();
            // console.log('Текущие активные соединения:', activeConnections);
            break;
          case 'post':
           // console.log('WSSNodeRED - Type - Post');
             await nodeRedPost(ws, checkInputMessage.data);
            // const activeConnections = getAllClients();
            // console.log('Текущие активные соединения:', activeConnections);
            break;

            case 'get':
             // console.log('WSSNodeRED - Type - Get');
               await handleGet(ws, checkInputMessage.data);
              break;

              case 'response':
                console.log('WSSNodeRED - Type - Response');
                 await handleResponse(ws, checkInputMessage.data);
                break;

              case 'set':
              console.log('WSSNodeRED - Type - Set');
               await handleSet(ws, checkInputMessage.data);
              break;

              case 'error':
              console.log('WSSNodeRED - Type - Error');
               await handleError(ws, checkInputMessage.data);
              break;

          default:
            break;
        }


        //console.info('Проверка сообщения выполнена без ошибок, sendToDash =', sendToDash);
      } else {
        console.log('Ошибка проверки сообщения от nodeRED checkInputMessage');
        //Slogger.error(`Ошибка "${checkInputMessage}" при проверке сообщения ${message} `);
        sendToDash = false;
      }
      } catch (error) {
        
      }
  });


  ws.on('error', (error) => {
    console.log('WebSocket error on NodeRED:', error);
  });

  ws.on('close', () => {
     if (ws.dID && ws.typeConnect) {
      removeClient(ws.dID, ws.typeConnect);
      console.log(`Соединение закрыто для клиента ${ws.dID} (${ws.typeConnect}).`);
    } else {
      console.log('Соединение закрыто, но клиент не был зарегистрирован через init_dID.');
    }
  });
//}

});
WSSNodeRED_OUT.on('connection', (ws) => {
  console.log(`Output - Client connected to NodeRED on port ${wsRedPORT_OUT}`);
  //ws.send("WSSNodeRED_OUT - проверка связи");
    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);

sendSuccess(ws, 'inputConnectSuccess', 'dID', 'Проверка связи');

  ws.on ('message', async (message) => {
    try {
      const checkInputMessage = checkMessage(message);
      console.log(`WSSNodeRED_OUT - получено сообщение:`, checkInputMessage.data);
      
    } catch (error) {
      
    }
  });
    ws.on ('error', () => {
    try {
      console.error(`WSSNodeRED_OUT - WebSocket error:`, error);
    } catch (error) {
      
    }
  });
    ws.on ('close', () => {
    try {
      if (ws.dID && ws.typeConnect) {
      removeClient(ws.dID, ws.typeConnect);
      console.log(`Соединение закрыто для клиента ${ws.dID} (${ws.typeConnect}).`);
    } else {
      console.log('Соединение закрыто, но клиент не был зарегистрирован через init_dID.');
    }
    } catch (error) {
      
    }
  });
});

// Работаем с Dashboard //////////////////////////////////////////////////////
WSSDash.on('connection', (ws) => {
  console.log(`Output - Client connected to NodeRED on port ${WSSNodeRED_OUT.address().port}`);
  console.log('-- 402 -- Client connected to Dashboard on port ' + wsDashPORT_IN);
  //Slogger.info('-- 402 -- Client connected to Dashboard on port ' + wsDashPORT_IN);

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
     if (ws.dID && ws.typeConnect) {
      removeClient(ws.dID, ws.typeConnect);
      console.log(`Соединение закрыто для клиента ${ws.dID} (${ws.typeConnect}).`);
    } else {
      console.log('Соединение закрыто, но клиент не был зарегистрирован через init_dID.');
    }

    //console.log('Dash WebSocket connection closed');
    //Slogger.info('Dash WebSocket connection closed');
  });
});

console.log(`WebSocket servers are running on nodeRed ws port:${wsRedPORT_IN} and DashBoard (client) ws port:${wsDashPORT_IN}`);
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

  //console.log(`1 checkMessage получило сообщение: ${message}`);
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
