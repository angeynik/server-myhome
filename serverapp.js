const express = require('express');
const http = require('http');
const axios = require('axios');
// const { v4: uuidv4 } = require('uuid');
// const morgan = require('morgan');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');
const InitDB = require('./services/initDB.js');
const initDB = new InitDB();
const initServer = require('../serverApp/services/initServer.js');

// require('dotenv').config({ path: './conf.env' }); 
const dotenv = require('dotenv'); // Подключаем .ENV файл с переменными окружения
dotenv.config({path: './conf.env'}); // Указываем путь к  файлу .env
const { loginUser, verifyToken } = require('./auth'); // Импортируем функции авторизации
//const { closeConnection} = require('./services/db.js');
const DBManager = require('./services/db.js'); // Импортируем DBManager
const { registerUser, findUser, fetchUsers, fetchDataSources, linkDataSourceToUser } = require('./userRepository'); 

// Подключаем функции модуля joi для валидации данных
const {validType, validConfig, validPost} = require('./validate');

const pino = require('pino'); // Подключаем pino для логирования
const logDirectory = process.env.LOG_DIRECTORY || './logs';
const log_level = process.env.PINO_LOG_LEVEL || 'info';

// Логирование Сервера
const ServerTransport = pino.transport({
  targets: [
    {
      target: 'pino-pretty',
      options: {
        destination: path.join(logDirectory, 'fatal.log'), // Логи уровня fatal
        level: 'fatal',
        mkdir: true,
      },
    },
    {
      target: 'pino-pretty',
      options: {
        destination: path.join(logDirectory, 'error.log'), // Логи уровня error
        level: 'error',
        mkdir: true,
      },
    },
    {
      target: 'pino-pretty',
      options: {
        destination: path.join(logDirectory, 'warn.log'), // Логи уровня warn
        level: 'warn',
        mkdir: true,
      },
    },
    {
      target: 'pino-pretty',
      options: {
        destination: path.join(logDirectory, 'info.log'), // Логи уровня info
        level: 'info',
        mkdir: true,
        colorize: false,
      },
    },
    {
      target: 'pino-pretty',
      options: {
        destination: path.join(logDirectory, 'debug.log'), // Логи уровня debug
        level: 'debug',
        mkdir: true,
      },
    },
    {
      target: 'pino-pretty', // Консольный вывод
      options: {
        level: 'debug',
        colorize: true,
        destination: process.stdout.fd,
      },
    },
    
  ],
});

const Slogger = pino({ level: log_level }, ServerTransport);
module.exports = Slogger;

// Логирование Клиента
const ClientTransport = pino.transport({
  targets: [
    {
      target: 'pino-pretty',
      options: {
        destination: path.join(logDirectory, 'client_fatal.log'), // Логи уровня fatal
        level: 'fatal',
        mkdir: true,
      },
    },
    {
      target: 'pino-pretty',
      options: {
        destination: path.join(logDirectory, 'client_error.log'), // Логи уровня error
        level: 'error',
        mkdir: true,
      },
    },
    {
      target: 'pino-pretty',
      options: {
        destination: path.join(logDirectory, 'client_warn.log'), // Логи уровня warn
        level: 'warn',
        mkdir: true,
      },
    },
    {
      target: 'pino-pretty',
      options: {
        destination: path.join(logDirectory, 'client_info.log'), // Логи уровня info
        level: 'info',
        mkdir: true,
        colorize: false,
      },
    },
   
  ],
});

const Clogger = pino({ level: log_level }, ClientTransport); 
module.exports = Clogger;

//const servPORT = process.env.SERVER_PORT || 3010;
const servPORT = process.env.SERVER_PORT || 3010;
const wsRedPORT = process.env.WSR_PORT || 9200;
const wsDashPORT = process.env.WSD_PORT || 9202;

// Создаем директорию, если она не существует
const clientLogDir = './logs';
if (!fs.existsSync(clientLogDir)) {
    fs.mkdirSync(clientLogDir);
}

const app = express();
app.set(servPORT);
const server = http.createServer(app);
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

// Инициализация сервера
const initialize = async () => {
  const envInit = process.env.INIT_DB;
  // console.log('envInit - ', envInit);
  if (envInit === 'TRUE') {
    console.log('Переходим к инициализация сервера разрешена', envInit);
    try {
      await initServer(); // Выполняем инициализацию
      console.log('Инициализация сервера завершена успешно.');
    } catch (error) {
      console.error('Ошибка при инициализации сервера:', error);
    }
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


//Работа с логами с Клиента
app.post('/log', (req, res) => {
    if (req.body.type === 'error') {
        Clogger.error(req.body.message);
    } else if (req.body.type === 'warn') {
        Clogger.warn(req.body.message);
    } else if (req.body.type === 'info') {
        Clogger.info(req.body.message);
    } else if (req.body.type === 'fatal') {
        Clogger.fatal(req.body.message);
    } else {
        Clogger.info('Получено сообщение неопределенного ТИПА с Логами от Клиента (VUE js):', req.body.message);
    }
});


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

let activeSocket = null; // Переменная для хранения активного подключения



// Работаем с NodeRED

WSSNodeRED.on('connection', (ws) => {

  console.log(`Client connected to NodeRED on port ${wsRedPORT}`);
  Slogger.info(`Client connected to NodeRED on port ${wsRedPORT}`);
  const connectedClients = WSSNodeRED.clients.size;
  Slogger.info(`Количество подключенных клиентов NodeRED: ${connectedClients}`);

  ws.on('message', (message) => {
    console.log('-- 191 -- от NodRED получено сообщение', message);
    Slogger.info(`На порт ${wsRedPORT} от NodRED получено сообщение: ${message},`);
    sendToDash = true;

      // Проверка типа сообщения
// Временно отключаем валидацию для проверки механизма пересылки от Server к 
      console.log('Приступаем к валидации полученных  от NodRED данных');
      const checkInputMessage = checkMessage(message);
      if (checkInputMessage === 'ok') {
        Slogger.info(`Проверка сообщения ${message} выполнена без ошибок, checkInputMessage = ${checkInputMessage}`);
        sendToDash = true;
        console.info('Проверка сообщения выполнена без ошибок, sendToDash =', sendToDash);
      } else {
        Slogger.error(`Ошибка "${checkInputMessage}" при проверке сообщения ${message} `);
        sendToDash = false;
      }

      //Проверка готовности Client
      WSSDash.clients.forEach((client) => {
        console.log(`Проверка состояния клиента: ${client.readyState}`);
        if (client.readyState === WebSocket.OPEN) {
          console.log('Клиент готов принять сообщение');
        } else {
          console.log('Клиент не готов принять сообщение');
        }
      });

      
      // Передача сообщения на WSSDash
      WSSDash.clients.forEach((client) => {
        console.log('WebSocket.Open - ', WebSocket.OPEN, ' и sendToDash=', sendToDash, 'отправка сообщения разрешена');
        if (client.readyState === WebSocket.OPEN && sendToDash === true) {
            client.send(message, (error) => {
                if (error) {
                    Slogger.error('Ошибка пересылки сообщения c NodeRED на Dashboard:', error);
                } else {
                    Slogger.info(`На порт ${wsDashPORT} от Server к Dashboard отправлено сообщение: ${message}`);                   
                }
                sendToDash = false;
            });
        }
    });
  });

  ws.on('error', (error) => {
      Slogger.error('WebSocket error on NodeRED:', error);
  });

  ws.on('close', () => {
      Slogger.info('NodeRED WebSocket connection closed');
      redConnection = false;
  });
//}

});

// Работаем с Dashboard
// WSSDash.on('connection', (ws) => {
//   Slogger.info('-- 235 -- Client connected to Dashboard on port ' + wsDashPORT);

//   ws.on('message', (message) => {
//       Slogger.info(`На порт ${wsDashPORT} от Dashboard получено сообщение: ${message} `);
//       sendToRed = true;
//       // Передача сообщения на WSSDash
//       WSSNodeRED.clients.forEach((client) => {
//         if (client.readyState === WebSocket.OPEN && sendToRed === true) {
//             client.send(message, (error) => {
//                 if (error) {
//                     Slogger.error('Ошибка пересылки сообщения c Dashboard на NodeRED :', error);
//                 } else {
//                     Slogger.info(`На порт ${wsRedPORT} от Server  к NodeRED  отправлено сообщение: ${message}`);
//                 }
//                 sendToDash = false;
//             });
//         }
//     });
//   });

//   ws.on('error', (error) => {
//       Slogger.error('WebSocket error on Dashboard:', error);
//   });

//   ws.on('close', () => {
//       Slogger.info('Dash WebSocket connection closed');
//   });
// });


WSSDash.on('connection', (ws) => {
  Slogger.info('-- 235 -- Client connected to Dashboard on port ' + wsDashPORT);

ws.on('message', async (message) => {
  try {
    const data = JSON.parse(message);
    console.log('Получены данные:', data);

    switch (data.type) {
      case 'get': // Используем строку 'get' для сравнения
        console.log('Переходим к проверке сообщения типа get.');
            switch (data.request) {
              case 'login':
                const { username, password } = data;
                const user = await loginUser(username, password);
                if (user.error) {
                // Если есть ошибка, отправляем её клиенту
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    request:'loginError',
                    message: user.error,
                  })
                );
                // console.log('Логин и пароль ОТКЛОНЕНЫ:', user.error);
              } else {
                // Если ошибки нет, отправляем успешный ответ
                ws.send(
                  JSON.stringify({
                    type: 'responce',
                    request:'loginSuccess',
                    token: user.token,
                    username: user.username,
                    userlevel: user.userlevel,
                  })
                );
                // console.log('Логин и пароль приняты');
              }
                break;
                case 'fetchUsers':
                  try {
                    const users = await fetchUsers();
                    console.log('Users', users);
                    // Отправляем список пользователей клиенту
                    ws.send(
                      JSON.stringify({
                        type: 'responce',
                        request: 'fetchUsersSuccess',
                        requestId: data.requestId, // Возвращаем requestId
                        users: users,
                      })
                    );
                  } catch (error) {
                    console.error('Ошибка при получении списка пользователей:', error);
                    ws.send(
                      JSON.stringify({
                        type: 'error',
                        request:'fetchUsersError',
                        requestId: data.requestId, // Возвращаем requestId
                        message: error.message || 'Ошибка при получении списка пользователей',
                      })
                    );
                  }
                  break;
                break;
                case 'fetchDataSources':
                  try {
                    const dataSources = await fetchDataSources();
                    console.log('dataSources', dataSources);
                    // Отправляем список источников данных клиенту
                    ws.send(
                      JSON.stringify({
                        type: 'responce',
                        request:'fetchDataSourcesSuccess',
                        requestId: data.requestId, // Возвращаем requestId
                        sources: dataSources,
                      })
                    );
                  } catch (error) {
                    console.error('Ошибка при получении списка источников данных:', error);
                    ws.send(
                      JSON.stringify({
                        type: 'error',
                        request:'fetchDataSourcesError',
                        requestId: data.requestId, // Возвращаем requestId
                        message: error.message || 'Ошибка при получении списка источников данных',
                      })
                    );
                  }
                  break; 
              default:
                break;
            }
        break;
      case 'post': // Используем строку 'post' для сравнения
        console.log('Переходим к проверке сообщения типа post.');
            switch (data.request) {
              case 'createUser':
                      const { username, password, dataSource, permissionLevel } = data;
                try {
                  // Регистрируем пользователя и создаем источник данных внутри registerUser
                  const newUser = await registerUser(username, password, permissionLevel, dataSource, dataSource);

                  // Отправляем успешный ответ клиенту
                  if (!newUser) {
                    ws.send(
                      JSON.stringify({
                        type: 'error',
                        request:'createUserError',
                        message: 'Ошибка создания пользователя',
                      })
                    )
                  } else {
                    console.log('Пользователь успешно создан:', newUser.user);
                    ws.send(
                      JSON.stringify({
                        type: 'responce',
                        request:'createUserSuccess',
                        user: newUser.user,
                      })
                    );
                  }

                } catch (error) {
                  console.error('Ошибка при создании пользователя:', error);
                  ws.send(
                    JSON.stringify({
                      type: 'error',
                      request:'createUserError',
                      message: error.message || 'Ошибка при создании пользователя',
                    })
                  );
                }
              break;
              case 'linkUserToDataSource':
                const { userId, dataSourceId } = data;
                try {
                  const linkUser = await linkDataSourceToUser(userId, dataSourceId);
                  if (linkUser.error) {
                    // Если есть ошибка, отправляем её клиенту
                    ws.send(
                      JSON.stringify({
                        type: 'error',
                        request: 'linkUserToDataSourceError',
                        message: linkUser.error,
                      })
                    );
                  } else {
                    // Если ошибки нет, отправляем успешный ответ
                    ws.send(
                      JSON.stringify({
                        type: 'responce',
                        request: 'linkUserToDataSourceSuccess',
                        message: 'Связь успешно создана',
                      })
                    );
                  }
                } catch (error) {
                  console.error('Ошибка при добавлении источника к пользователю:', error);
                  ws.send(
                    JSON.stringify({
                      type: 'error',
                      request: 'linkUserToDataSourceError',
                      message: error.message || 'Ошибка при добавлении источника к пользователю',
                    })
                  );
                }
                break;
              default:
                break;
            }
        break;
      case 'responce': // Используем строку 'request' для сравнения
        console.log('Переходим к проверке сообщения типа responce.');
        break;
      case 'config': // Используем строку 'request' для сравнения
        console.log('Переходим к проверке сообщения типа config.');
        break;
      case 'set': // Используем строку 'request' для сравнения
        console.log('Переходим к проверке сообщения типа set.');
        break;
      default:
        console.log('Неизвестный тип сообщения:', data.type);
        break;
    }

    // if (data.type === 'login') {
    //   const { username, password } = data;

    //   const user = await loginUser(username, password);

    //   if (user.error) {
    //     // Если есть ошибка, отправляем её клиенту
    //     ws.send(
    //       JSON.stringify({
    //         type: 'loginError',
    //         message: user.error,
    //       })
    //     );
    //     console.log('Логин и пароль ОТКЛОНЕНЫ:', user.error);
    //   } else {
    //     // Если ошибки нет, отправляем успешный ответ
    //     ws.send(
    //       JSON.stringify({
    //         type: 'loginSuccess',
    //         token: user.token,
    //         username: user.username,
    //         userlevel: user.userlevel,
    //       })
    //     );
    //     console.log('Логин и пароль приняты');
    //   }
    // }



    
//     if (data.type === 'get') {
//       const { username, password } = data;
//       const user = await loginUser(username, password);
//       ws.send(JSON.stringify(user));
//     }
    
//     else if (data.type === 'createUser') {
//       const { username, password, dataSource, permissionLevel } = data;

//       try {
//         // Регистрируем пользователя и создаем источник данных внутри registerUser
//         const newUser = await registerUser(username, password, permissionLevel, dataSource, dataSource);

//         // Отправляем успешный ответ клиенту
//         ws.send(
//           JSON.stringify({
//             type: 'createUserSuccess',
//             user: newUser.user,
//           })
//         );
//       } catch (error) {
//         console.error('Ошибка при создании пользователя:', error);
//         ws.send(
//           JSON.stringify({
//             type: 'createUserError',
//             message: error.message || 'Ошибка при создании пользователя',
//           })
//         );
//       }
//     } else if (data.type === 'fetchUsers') {   
// console.log('fetchUsers');
//     } else if (data.type === 'fetchDataSources') {

//     }
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
    Slogger.error('WebSocket error on Dashboard:', error);
  });

  ws.on('close', () => {
    Slogger.info('Dash WebSocket connection closed');
  });
});




Slogger.info(`WebSocket servers are running on nodeRed ws port:${wsRedPORT} and DashBoard (client) ws port:${wsDashPORT}`);
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

  console.log(`1 checkMessage получило сообщение: ${message}`);
  const { error } = validType(data);
  if (error) {
    Slogger.error(`Некорректный формат полученного сообщения. ${message} Ошибка: Error validType: ${error.message}`);
    return error;
  }
  switch (data.type) {
    case 'config':
        console.log('Переходим к проверке сообщения типа config:');
      break;
    case 'post':
        console.log('Переходим к проверке сообщения типа post.');
        console.log('Debug - Временно отключаем проверку на валидацию возвращаем  - ok');
        return 'ok'; // Debug - Временно отключаем проверку на валидацию возвращаем 'ok'

        const resultValidPost = validPost(data);
        console.log('Результат валидации:', resultValidPost);
        if (resultValidPost) {
          console.log('Результат валидации:', resultValidPost);
          return "Error validPost: " + resultValidPost.error.message;
        } else {
          return 'ok';
        }
      // break;
    case 'get':
        console.log('Переходим к проверке сообщения типа get.');
        break;
    case 'req':
        console.log('Переходим к проверке сообщения типа req.');
    break;
    case 'set':
      console.log('Переходим к проверке сообщения типа set.');
    break;
    case 'createuser':
      console.log('Переходим к созданию нового пользовотеля для VUE приложения ');

      // const newUser = { id: 1, username: data.username, dataSource: data.dataSource, permissionLevel: data.permissionLevel };
      // ws.send(JSON.stringify({ type: 'userCreated', user: newUser }));
    break;
    case 'getusers':
      console.log('Переходим к созданию получению списка пользовотелей VUE приложения ');
      // Логика получения списка пользователей
      // const users = [{ id: 1, username: 'user1', dataSource: 'source1', permissionLevel: 1 }];
      // ws.send(JSON.stringify({ type: 'usersList', users }));
    break;
    default:
      Slogger.error(`Неизвестный тип сообщения: ${data.type}`);
  }
  return 'ok';
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