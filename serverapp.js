const express = require('express');
const http = require('http');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');
const {initServer, initUsers, initDefaulUser, initDB_dID} = require('./services/initServer.js');
//const tableDB = require('./services/tableDB.js');
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

  // Запуск сервера
  server.listen(servPORT, () => {
    console.log(`MyHome Server is running on port ${servPORT}`);
  });

  // Корректное завершение работы сервера и закрытие соединения с базой данных
  const handleShutdown = async () => {
    console.log('Shutting down server...');
    try {
      // Закрываем все пулы соединений с базами данных
      await DBManager.closeAllPools();
      console.log('Все соединения с базами данных закрыты.');
      server.close(() => {
        console.log('Server has been shut down.');
        process.exit(0); // Завершаем процесс после закрытия сервера
      });
    } catch (error) {
      console.error('Ошибка при завершении работы сервера:', error);
      process.exit(1); // Завершаем процесс с кодом ошибки
    }
  };

  // Обрабатываем оба сигнала одним обработчиком
  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);
};
// Выполняем инициализацию сервера
initialize();


const WebSocket = require('ws');
const { mkdir } = require('fs');
const { error } = require('console');

//устанавливаем соединение через Web Socket
const WSSNodeRED = new WebSocket.Server ({port:wsRedPORT});
const WSSDash = new WebSocket.Server ({port:wsDashPORT});

// Управление подключениями Node-RED клиентов
const nodeRedClients = new Map(); // Хранилище подключений: id -> ws

// Блок с переменными
let sendToDash = true;
//let sendToRed = false;
const reconnectInterval = 100;

//let activeSocket = null; // Переменная для хранения активного подключения



// Работаем с NodeRED

WSSNodeRED.on('connection', (ws) => {
  console.log(`Client connected to NodeRED on port ${wsRedPORT}`);
    // Генерируем уникальный ID для клиента
  const clientId = `red-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  nodeRedClients.set(clientId, ws);
  
  console.log(`Node-RED client connected (ID: ${clientId}). Total clients: ${nodeRedClients.size}`);

  //console.log(`Client connected to NodeRED on port ${wsRedPORT}`);
  //Slogger.info(`Client connected to NodeRED on port ${wsRedPORT}`);
  //const connectedClients = WSSNodeRED.clients.size;
  //Slogger.info(`Количество подключенных клиентов NodeRED: ${connectedClients}`);

// Отправляем клиенту его ID
    // ws.send(JSON.stringify({
    //   type: 'post',
    //   request: 'WSconnectID',
    //   name: '',
    //   payload: {
    //   WSconnectID: clientId
    //   }
    // }));

  ws.on('message', async (message) => {
  //console.log('-- 210 -- от NodRED получено сообщение', message);
  //console.log('Приступаем к валидации полученных  от NodRED данных');
      try {
  // Отправка сообщения всем Dashboard-клиентам
        // clients.dash.forEach(client => {
        //     if (client.readyState === WebSocket.OPEN) {
        //         client.send(message);
        //     }
        // });
// Проверка типа сообщения
// Временно отключаем валидацию для проверки механизма пересылки от Server к 
console.log('Приступаем к валидации полученных  от NodRED данных');
      const checkInputMessage = checkMessage(message);
      //console.log('checkInputMessage - ', checkInputMessage);
      if (checkInputMessage.status === 'ok') {
        console.log('-- 225 --- Проверка сообщения от nodeRED выполнена успешно', checkInputMessage.data.type);
        //Slogger.info(`Проверка сообщения ${message} выполнена без ошибок, checkInputMessage = ${checkInputMessage}`);
        sendToDash = true;
        // Добавляем ID отправителя в сообщение
        checkInputMessage.data.senderId = clientId;
        console.log('Добавляем ID отправителя в сообщение senderId - ', checkInputMessage.data);
        switch (checkInputMessage.data.type) {
          case 'auth':
            console.log('WSSNodeRED - Type - Auth');
             //await handleAuth(ws, checkInputMessage.data);
            break;
          case 'post':
           // console.log('WSSNodeRED - Type - Post');
             await handlePost(ws, checkInputMessage.data);
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
    console.error(`WebSocket error on NodeRED(${clientId}):`, error);
    //console.log('WebSocket error on NodeRED:', error);
      //Slogger.error('WebSocket error on NodeRED:', error);
  });

  ws.on('close', () => {
    nodeRedClients.delete(clientId);
    console.log(`Node-RED connection closed (ID: ${clientId}). Remaining clients: ${nodeRedClients.size}`);
    //console.log('NodeRED WebSocket connection closed');
      //Slogger.info('NodeRED WebSocket connection closed');
      redConnection = false;
  });
//}

});

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

  //console.log(`1 checkMessage получило сообщение: ${message}`);
  const { error } = validType(data);
  if (error) {
    console.log(`Некорректный формат полученного сообщения. ${message} Ошибка: Error validType: ${error.message}`);
    //Slogger.error(`Некорректный формат полученного сообщения. ${message} Ошибка: Error validType: ${error.message}`);
    return error;
  }
  // switch (data.type) {
  //   case 'config':
  //       console.log('Переходим к проверке сообщения типа config:');
  //     break;
  //   case 'post':
  //       console.log('Переходим к проверке сообщения типа post.');
  //       console.log('Debug - Временно отключаем проверку на валидацию возвращаем  - ok');
  //       return 'ok'; // Debug - Временно отключаем проверку на валидацию возвращаем 'ok'

  //       const resultValidPost = validPost(data);
  //       console.log('Результат валидации:', resultValidPost);
  //       if (resultValidPost) {
  //         console.log('Результат валидации:', resultValidPost);
  //         return "Error validPost: " + resultValidPost.error.message;
  //       } else {
  //         return 'ok';
  //       }
  //     // break;
  //   case 'get':
  //       console.log('Переходим к проверке сообщения типа get.');
  //       break;
  //   case 'req':
  //       console.log('Переходим к проверке сообщения типа req.');
  //   break;
  //   case 'set':
  //     console.log('Переходим к проверке сообщения типа set.');
  //   break;
  //   case 'createuser':
  //     console.log('Переходим к созданию нового пользовотеля для VUE приложения ');

  //     // const newUser = { id: 1, username: data.username, dataSource: data.dataSource, permissionLevel: data.permissionLevel };
  //     // ws.send(JSON.stringify({ type: 'userCreated', user: newUser }));
  //   break;
  //   case 'getusers':
  //     console.log('Переходим к созданию получению списка пользовотелей VUE приложения ');
  //     // Логика получения списка пользователей
  //     // const users = [{ id: 1, username: 'user1', dataSource: 'source1', permissionLevel: 1 }];
  //     // ws.send(JSON.stringify({ type: 'usersList', users }));
  //   break;
  //   default:
  //     Slogger.error(`Неизвестный тип сообщения: ${data.type}`);
  // }
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
