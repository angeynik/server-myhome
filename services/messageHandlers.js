// messageHandlers.js
// Метод обработки получаемых Сервером WebSocket сообщений

const path = require('path');
const DBManager = require('./db');
const tableDB = require('./tableDB');
const dotenv = require('dotenv');
dotenv.config({ path: './conf.env' });
const logger = require('./logger.js');

const authDB = process.env.DB_DATABASE || 'spring'; // База данных по умолчанию
const dbUser = process.env.DB_USER;
const dbPass = process.env.DB_PASSWORD;

const wsManager = require('../classes/wsManager');
const { loginUser, verifyToken } = require('../auth'); // Импортируем функции авторизации
const { writeFileSafely, readFileSafely  } = require('./configStore');
const { nodeRedClients  } = require('./clientsStore');
//const { sendSuccess, sendError, sendRequest} = require('./wsHelpers');
const { type } = require('os');
// Получаем список имен конфигов из переменной окружения
const configNames = JSON.parse(process.env.DB_CONFIG_NAMES || '[]');

function getValue(value) {
    return Array.isArray(value) ? value[0] : value;
};


async function handlePostNodeRED(clientId, message) {
  const info = JSON.stringify(message);
  logger.logDevMessage(`[messageHandlers] - handlePostNodeRED - Обработка сообщения: ${info}`);
    const { name, request, payload = {} } = message;

    // Извлекаем значения из payload
    const room = getValue(payload?.room);
    const item_name = getValue(payload?.item_name);
    const item_value = getValue(payload?.item_value);
    const item_type = getValue(payload?.item_type);
    const item_title = getValue(payload?.item_title);
    const title = getValue(payload?.title);
    const group = getValue(payload?.group);

    logger.logDevMessage(`[messageHandlers] - handlePostNodeRED - type:', ${item_type}, 'room:', ${room}, 'name: ', ${item_name}, 'value: ', ${item_value} `);

    // Проверка обязательных полей (раскомментировать)
    if (!room || !item_name || item_value === undefined) {
        throw new Error(`Missing required fields: room=${room}, item_name=${item_name}, item_value=${item_value}`);
    }

    // Читаем данные из конфигурационного файла на диске
    const {data, dataDir, filePath} = await readFileSafely(name, 'config');
    console.log(`[messageHandlers] - handlePostNodeRED - Читаем данные из ${filePath}`);

    try {
        // Проверяем, существует ли комната
        if (!data[room]) {
            // Создаем новую комнату
            data[room] = {
                id: Object.keys(data).filter(k => k.startsWith('room')).length,
                title: title || `Комната-${room}`,
                group: group || '',
                // sensors: {},
                // actuators: {},
                // setpoints: {}
            };
        }
        //const objectName = request + 's';
        // Создаем объект, если он не существует
        if (!data[room][request]) {
            data[room][request] = {};
            logger.logInfoMessage(`[messageHandlers] - handlePostNodeRED - Создан новый объект ${request} в комнате ${room}`);
        }
        // Добавляем/обновляем элемент
        data[room][request][item_name] = {
            value: item_value,
            type: item_type,
            lastUpdate: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })
        };

        logger.logDevMessage(`[messageHandlers] - handlePostNodeRED - Добавлен ${request}: ${item_name} в объект ${request}`);

        // Сохранение данных
        const dataString = JSON.stringify(data, null, 2);
        await writeFileSafely(filePath, dataString);
        logger.logDevMessage(`[messageHandlers] -handlePostNodeRED - ✅ Данные успешно обновлены в ${filePath}`);
        logger.logDevMessage('[messageHandlers] -handlePostNodeRED - Содержимое файла:', dataString);
        return 'ok';
    } catch (err) {
        logger.logErrorMessage(`[messageHandlers] -handlePostNodeRED - Ошибка при работе с файлом ${filePath}:`, err);
        return 'error';
    }
};


const handleAuth = async (clientId, data) => {
    logger.logDevMessage(`[messageHandlers] - handleAuth Переходим к проверке сообщения типа auth`);
    logger.logDevMessage(`[messageHandlers] - handleAuth - Request - ', ${data} `);
  switch (data?.request) {
    case 'login':
        logger.logDevMessage(`[messageHandlers] - handleAuth  - Request - login`);
      try {
        const { username, password } = data?.payload;
        const result = await loginUser(username, password);
        logger.logInfoMessage(`[messageHandlers] - handleAuth  Результат проверки: ${result}`);
        if (result.error) {
          wsManager.sendToConnection('VUE_connections', clientId, 'error', 'loginError', result.dID, {
            code: result.code,
            message: result.error
          });
        } else {
          logger.logDevMessage(`[messageHandlers] - handleAuth  Успешная проверка отправляем ответ Vue`);
          wsManager.updateConnection('VUE_connections', clientId, Date.now(), result.dID);
          wsManager.sendToConnection('VUE_connections', clientId, 'response', 'loginSuccess', result.dID, {
            token: result.token,
            username: result.username,
            userlevel: result.userlevel
          });
          // sendSuccess(ws, 'loginSuccess', result.dID, {
          //   token: result.token,
          //   username: result.username,
          //   userlevel: result.userlevel
          // });
        }
      } catch (error) {
        logger.logErrorMessage(`Необработанная ошибка:', ${error}`);
        wsManager.sendToConnection('VUE_connections', clientId, 'error', 'loginError', data.name, {
            username: data.payload.username,
            code: 'UNHANDLED_ERROR',
            message: 'Произошла непредвиденная ошибка'
          });
        // sendError(ws, 'loginError', data.name, {
        //   username: data.payload.username,
        //   code: 'UNHANDLED_ERROR',
        //   message: 'Произошла непредвиденная ошибка'
        // });
      }
      break;
    default:
      break;
  }
};

const handleGet = async (clientId, data) => {
  console.log('[messageHandlers] - handleGet - Request - ', data?.request);

    logger.logDevMessage('[messageHandlers] - handleGet - Переходим к проверке сообщения типа get', data?.request);
    const dID = data.name;
  switch (data?.request) {
      case 'fetchUsers':
      try {
        const users = await DBManager.fetchUsers();
        wsManager.sendToConnection('VUE_connections', clientId, 'response', 'fetchUsersSuccess', data.name, {
            users: users
          });
        // sendSuccess(ws, 'fetchUsersSuccess', data.name, {
        //   users: users
        // });
      } catch (error) {
          wsManager.sendToConnection('VUE_connections', clientId, 'error', 'fetchUsersError', data.name, {
            message: error.message
          });
        // sendError(ws, 'fetchUsersError', data.name, {
        //   message: error.message
        // });
      }
      break;
      case 'fetchDataSources':
      try {
        const dataSources = await DBManager.fetchDataSources();
          wsManager.sendToConnection('VUE_connections', clientId, 'error', 'fetchDataSourcesSuccess', data.name, {
            sources: dataSources
          });
        // sendSuccess(ws, 'fetchDataSourcesSuccess', data.name, {
        //   sources: dataSources
        // });
      } catch (error) {
          wsManager.sendToConnection('VUE_connections', clientId, 'error', 'fetchDataSourcesError', data.name, {
            message: error.message
          });
        // sendError(ws, 'fetchDataSourcesError', data.name, {
        //   message: error.message
        // });
      }
      break;

      case 'config':
      try {
        const name  = data.name;
        if (!name) {
          throw new Error('[messageHandlers] - Не указано имя конфига в запросе');
        }
    
        // Читаем конфиг
        const configData = await readFileSafely(name, 'config');
        logger.logDevMessage(`[messageHandlers] - handleGet - configData - ', ${configData}`);
        console.log('[messageHandlers] - handleGet - configData - ', configData);
        
        if (!configData) {
          throw new Error('[messageHandlers] - Failed to read configuration file');
        }
       
        logger.logDevMessage(`[messageHandlers] -  Sending config to ${name}`);
        wsManager.sendToConnection('VUE_connections', clientId, 'response', 'config', data.name, configData.data);
        // sendSuccess(ws, 'config', name, configData.data);

        logger.logDevMessage(`[messageHandlers] - Конфиг ${name} успешно отправлен`);
    
      } catch (error) {
        logger.logErrorMessage('[messageHandlers] - Ошибка получения конфига:', error);
          wsManager.sendToConnection('VUE_connections', clientId, 'error', 'configError', dID, {
            message: error.message,
          code: error.code || 'config_read_error'
          });
        // sendError(ws, 'configError', dID, {
        //   message: error.message,
        //   code: error.code || 'config_read_error'
        // });
      }
      break;
      case 'schedules':
        console.log('[messageHandlers] - handleGet - Request - schedules');
        try {
          const { name } = data;
          //logger.logDevMessage(`[messageHandlers] - handleGet - Request - schedules -- dID - ', ${name}`);
          const schedulesData = await readFileSafely(name, 'schedules');
          logger.logDevMessage(`[messageHandlers] - handleGet - configData - ', ${schedulesData}`);
         
          if (!schedulesData) {
            throw new Error('[messageHandlers] - handleGet - Failed to read schedules configuration file');
          }
          logger.logDevMessage(`[messageHandlers] -  handleGet - Sending config to ${name}`);
          console.log(`[messageHandlers] -  handleGet - Конфигурация Расписания успешно получена ${schedulesData}`);
          wsManager.sendToConnection('VUE_connections', clientId, 'response', 'schedules', data.name, schedulesData.data);

        } catch (error) {
          logger.logErrorMessage('[messageHandlers] - Ошибка получения конфига:', error);
          wsManager.sendToConnection('VUE_connections', clientId, 'error', 'schedulesConfigExistsError', dID, {
          message: error.message,
          code: error.code || 'schedulesConfig_read_error'
          });
        }
        break;
      case 'notifications':
        //console.log(`[messageHandlers] - handleGet -  Notifications -- `);
        try {
          const { name } = data;
          logger.logDevMessage(`[messageHandlers] - handleGet - Request - notifications -- dID - ', ${name}`);

          const notificationsData = await readFileSafely(name, 'notifications');
          logger.logDevMessage(`[messageHandlers] - handleGet - configData - ', ${notificationsData}`);
          wsManager.sendToConnection('VUE_connections', clientId, 'response', 'notifications', name, notificationsData.data);
         
          if (!notificationsData) {
            throw new Error('[messageHandlers] - Failed to read notifications configuration file');
          }
        } catch (error) {
          logger.logErrorMessage('[messageHandlers] - Ошибка получения конфига:', error);
          wsManager.sendToConnection('VUE_connections', clientId, 'error', 'notificationsConfigExistsError', dID, {
          message: error.message,
          code: error.code || 'notificationsConfig_read_error'
          });
        }
        break;
      case 'statistics':
          try {
            const { name } = data;
          logger.logDevMessage(`[messageHandlers] - handleGet - Request - statistics -- dID - ', ${name}`);

          const statisticsData = await readFileSafely(name, 'statistics');
          logger.logDevMessage(`[messageHandlers] - handleGet - configData - ', ${statisticsData}`);
          wsManager.sendToConnection('VUE_connections', clientId, 'response', 'statistics', name, statisticsData.data);
         
          if (!statisticsData) {
            throw new Error('[messageHandlers] - Failed to read notifications configuration file');
          }
          } catch (error) {
            logger.logErrorMessage('[messageHandlers] - Ошибка получения конфига:', error);
            wsManager.sendToConnection('VUE_connections', clientId, 'error', 'statisticsConfigExistsError', dID, {
            message: error.message,
            code: error.code || 'statisticsConfig_read_error'
            });
          }
        break;




    default:
      break;
  }
};

const handlePost = async (clientId, data) => {
    logger.logDevMessage(`[messageHandlers] - handlePost - Переходим к проверке сообщения типа post, request - ', ${data.request}`);
    console.log('[messageHandlers] - handlePost - Request - ', data?.request);
    let dID = data.name;
    let { room, param, value, value_name, id, value_type, setKey } = data.payload;
    console.log('[messageHandlers] - handlePost - setpointKey', setKey);
    
    let fileUpdateNeeded = false;
    let filePath = '';
    let dataToWrite = null;           // строка JSON для записи в файл
    let responseType = '';            // тип ответа ('response' или 'error')
    let responseRequest = '';         // request ('config', 'schedules', ...)
    let responsePayload = null;       // данные для отправки клиенту

  switch (data?.request) {
    case 'createUser':
        logger.logDevMessage(`[messageHandlers] - handlePost - Request - createUser`);
      try {
        const { username, password, dataSource, permissionLevel } = data.payload;
        const newUser = await tableDB.registerUser(
          username, password, permissionLevel, 
          dataSource, dataSource, '', '', process.env.DB_DATABASE
        );
        logger.logDevMessage(`handlePost - Результат createUser:', ${newUser}`);
        if (newUser) {
          // Создаем базу данных
          await DBManager.createDB(dataSource, authDB, dbUser, dbPass);
          logger.logInfoMessage(`[messageHandlers] - handlePost - База данных "${dataSource}" успешно создана.`);
          await DBManager.createTableDID(dataSource);
          logger.logInfoMessage(`[messageHandlers] - handlePost - Таблицы успешно созданы в базе "${dataSource}".`);
        }
        wsManager.sendToConnection('VUE_connections', clientId, 'response', 'createUserSuccess', data.name, {
            user: newUser.user
          });
        // sendSuccess(ws, 'createUserSuccess', data.name, {
        //   user: newUser.user
        // });
        return 'ok';
      } catch (error) {
          wsManager.sendToConnection('VUE_connections', clientId, 'error', 'createUserError', data.name, {
            message: error.message
          });
        // sendError(ws, 'createUserError', data.name, {
        //   message: error.message
        // });
      }
      break;
    case 'linkUserToDataSource':
        logger.logDevMessage(`[messageHandlers] - handlePost -  Request - linkUserToDataSource`);
      try {
        const { userId, dataSourceId } = data.payload;
        const linkUser = await tableDB.linkDataSourceToUser(
          userId, dataSourceId, process.env.DB_DATABASE
        );
        
        if (linkUser.error) {
          wsManager.sendToConnection('VUE_connections', clientId, 'error', 'linkUserToDataSourceError', data.name, {
            message: linkUser.error
          });
          // sendError(ws, 'linkUserToDataSourceError', data.name, {
          //   message: linkUser.error
          // });
        } else {
          wsManager.sendToConnection('VUE_connections', clientId, 'response', 'linkUserToDataSourceSuccess', data.name, {
            message: 'Связь успешно создана',
            linkId: linkUser.id
          });
          // sendSuccess(ws, 'linkUserToDataSourceSuccess', data.name, {
          //   message: 'Связь успешно создана',
          //   linkId: linkUser.id
          // });
        }
      } catch (error) {
          wsManager.sendToConnection('VUE_connections', clientId, 'error', 'linkUserToDataSourceError', data.name, {
            message: error.message
          });
        // sendError(ws, 'linkUserToDataSourceError', data.name, {
        //   message: error.message
        // });
      }
      break;
    case 'init_dID':
        logger.logInfoMessage(`[messageHandlers] - handlePost - request - init_dID :', ${data.name}`);
        try {
          logger.logDevMessage(`Получены данные:', ${data}`);
          logger.logDevMessage(`[messageHandlers] - handlePost - Начинаем проверку наличия БД с именем - ', ${dID}`);
          DBManager.getPool(authDB, dbUser, dbPass).on('error', (err) => {
            logger.logErrorMessage(`[messageHandlers] - handlePost - Ошибка в пуле соединений: ${err}`);
          });
          const dbDID = await DBManager.query('SELECT NOW()', [], dID, dbUser, dbPass);
          logger.logDevMessage(`[messageHandlers] - handlePost - Подключение к базе данных успешно установлено.', ${dbDID.rows[0].now}`);
          if (!dbDID) {
            logger.logDevMessage(`[messageHandlers] - handlePost - База данных "${dID}" не существует.`);
          } else {
            logger.logDevMessage(`[messageHandlers] - handlePost - База данных "${dID}" существует.`);

        // Проверяем существование таблиц config и data в базе dID
          const tablesToCheck = ['config', 'data'];
          let allTablesExist = true;

          for (const table of tablesToCheck) {
            const exists = await DBManager.checkTableExists(table, dID, dbUser, dbPass);
            if (!exists) {
              allTablesExist = false;
              break;
            }
          }
          
          if (!allTablesExist) {
            logger.logInfoMessage(`[messageHandlers] - handlePost - Таблицы в базе "${dID}" отсутствуют.`);
          } else {
            logger.logInfoMessage(`[messageHandlers] - handlePost - Таблицы в базе "${dID}" существуют.`);
            for (const config of configNames) {
              const checkResult = await DBManager.checkRecordExists(
                'config', 
                { name: config },  // Условия поиска
                dID,                       // База данных
                dbUser,                    // Пользователь
                dbPass                     // Пароль
              );

              if (checkResult.exists) {
                logger.logInfoMessage(`[messageHandlers] - handlePost - Запись ${config} существует. Проверяем файл...`);
                // Получаем содержимое поля file
                const fileResult = await DBManager.query(
                  'SELECT file FROM config WHERE name = $1',
                  [config],
                  dID,
                  dbUser,
                  dbPass
                );
                // Проверяем наличие данных в JSON
                if (fileResult.rows.length > 0) {
                  const fileData = fileResult.rows[0].file;
                    if (fileData && Object.keys(fileData).length > 0) {
                      logger.logDevMessage(`JSON файл валиден:', ${fileData}`);
                    } else {
                      logger.logDevMessage(`[messageHandlers] - handlePost - JSON файл существует, но пустой или содержит null`);
                    const client = nodeRedClients.get(clientId);
                    wsManager.sendToConnection('nRED_connections', clientId, 'get', 'config', dID, {config});
                    // sendRequest(client, 'config', dID, {config});
                    }
                }
              } else {
                logger.logDevMessage(`[messageHandlers] - handlePost - Запись ${config} НЕ существует. Формируем запрос к nodeRED на получение конфигурации ${config}`);
                wsManager.sendToConnection('nRED_connections', clientId, 'get', 'config', dID, {config});
                // sendRequest(ws, 'config', dID, {config});
              }
            }
          }
          }


        } catch (error) {
          logger.logErrorMessage(`[messageHandlers] - handlePost - Ошибка обращения к базе данных', ${dID}, ' вероятно ее не существует`);
          // Обработка ошибки
        }
    break;
    case 'wsConnect':
        logger.logDevMessage(`[messageHandlers] - handlePost - Request - wsConnect`);
        try {
          logger.logDevMessage(`[messageHandlers] - handlePost - Получены данные:', ${data}`);
        } catch (error) {
          
        }
    break;
    // case 'setpoints':
    //   logger.logDevMessage(`[messageHandlers] - handlePost - Request - setpoint`); 
    //   try {
    //     //const { room, param, value } = data.payload;
    //     logger.logDevMessage(`[messageHandlers] - handlePost - Получены данные:', ${data}, 'dID -', ${dID}`);
        
    //     // Читаем данные из конфигурационного файла на диске
    //     const { data: configData, filePath } = await readFileSafely(dID, 'config');
    //     // const printData = JSON.parse(configData);
    //     // console.log(`[messageHandlers] - handlePost - Читаем данные ${printData}`);
    //     console.log(`[messageHandlers] - handlePost - Читаем данные из ${filePath}`);

    //     // Обновляем значение setpoint
    //     console.log(`[messageHandlers] - handlePost - param ${param} setpointKey ${setpointKey}`);
    //     if (configData[room] && configData[room].setpoints) {
    //       configData[room].setpoints[setpointKey] = {
    //         value: value,
    //         type: configData[room].setpoints[setpointKey]?.type || 'number',
    //         lastUpdate: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })
    //       };
    //       // const updatedData = configData[room].setpoints[setpointKey];
    //       // console.log(`[messageHandlers] - handlePost - Обновляем значение setpoint:`, updatedData);
    //       console.log(`[messageHandlers] - handlePost - Обновляем значение setpoint:`, configData[room].setpoints[setpointKey]);
    //     }
    //     // Подготавливаем отложенную запись и отправку
    //             fileUpdateNeeded = true;
    //             filePath = cfgPath;
    //             dataToWrite = JSON.stringify(configData, null, 2);
    //             responseType = 'response';
    //             responseRequest = 'config';
    //             responsePayload = configData;

    //       // Сохраняем обновленный конфиг
    //       // const dataString = JSON.stringify(configData, null, 2);
    //       // await writeFileSafely(filePath, dataString);
        
    //     // ✅ ОТПРАВЛЯЕМ ОБНОВЛЕННУЮ КОНФИГУРАЦИЮ КЛИЕНТУ
    //     // wsManager.sendToConnection(
    //     //   'VUE_connections',
    //     //   clientId,
    //     //   'response',
    //     //   'config',  // отправляем как обновление конфига
    //     //   dID,
    //     //   configData  // отправляем весь обновленный конфиг
    //     // );


    //     } catch (error) {
    //         logger.logErrorMessage(`[messageHandlers] - handlePost - Ошибка обработки setpoint:', ${error}`);
    //       wsManager.sendToConnection('VUE_connections', clientId, 'error', 'setpointError', data.name, {
    //         message: error.message
    //       });

    //     }
    // break;
    case 'setpoints':
            logger.logDevMessage(`[messageHandlers] - handlePost - Request - setpoint`);
            try {
                const { data: configData, filePath: cfgPath } = await readFileSafely(dID, 'config');
                console.log(`[messageHandlers] - handlePost - Читаем данные из ${cfgPath}`);

                if (configData[room] && configData[room].setpoints) {
                    configData[room].setpoints[setKey] = {
                        value: value,
                        type: configData[room].setpoints[setKey]?.type || 'number',
                        lastUpdate: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })
                    };
                    console.log(`[messageHandlers] - handlePost - Обновляем значение setpoint:`, configData[room].setpoints[setKey]);
                }

                // Подготавливаем отложенную запись и отправку
                fileUpdateNeeded = true;
                filePath = cfgPath;
                dataToWrite = JSON.stringify(configData, null, 2);
                responseType = 'response';
                responseRequest = 'config';
                responsePayload = configData;

            } catch (error) {
                logger.logErrorMessage(`[messageHandlers] - handlePost - Ошибка обработки setpoint: ${error}`);
                wsManager.sendToConnection('VUE_connections', clientId, 'error', 'setpointError', data.name, {
                    message: error.message
                });
            }
            break;
    // case 'addSchedule':
    //   console.log(`[messageHandlers] - handlePost - Получены данные:', ${JSON.stringify(data.payload.schedules, null, 2)}, 'name -', ${dID}`);
    //   //const { roomKey, paramKey } = data.payload;
    //   // Читаем данные из конфигурационного файла на диске
    //   const schedulesData = await readFileSafely(dID, 'schedules');
    //   console.log(`[messageHandlers] - handlePost - Читаем конфигурацию из хранилища  schedulesData:`, JSON.stringify(schedulesData.data, null, 2));

    //   const scheduleItem = {
    //       ...data.payload.schedules // берем структуру данных из полученного запроса на создание элемента расписания
    //   };
    //       console.log(`[messageHandlers] - handlePost - scheduleItem:`, scheduleItem);
    //     // Создаем или обновляем структуру в store
    //     if (!schedulesData.data[room]) {
    //         schedulesData.data[room] = {};
    //     }
    //     if (!schedulesData.data[room][param]) {
    //         schedulesData.data[room][param] = [];
    //     }
        
    //     // Добавляем новое расписание
    //     schedulesData.data[room][param].push(scheduleItem);
    //     console.log(`[messageHandlers] - handlePost - Обновленное расписание schedulesData:`, schedulesData.data);
        
    //     // Сохраняем обновленный конфиг
    //     const dataString = JSON.stringify(schedulesData.data, null, 2);
    //     await writeFileSafely(schedulesData.filePath, dataString);

    //     // Отправляем обновленные данные клиенту
    //     wsManager.sendToConnection('VUE_connections', clientId, 'response', 'schedules', data.name, schedulesData.data);
    // break;
    // case 'delSchedule':
    //     console.log(`530 - [messageHandlers] - handlePost - Request - delSchedule - ${data.payload}`);

    //     try {
    //         // const { name } = data;
    //         const { scheduleIds } = data.payload;
            
    //         console.log(`[messageHandlers] - handlePost - Получены данные для удаления расписания:`, {
    //             dID,
    //             room,
    //             param,
    //             scheduleIds
    //         });
            
    //         // Проверяем обязательные поля
    //         if (!room || !param || !scheduleIds || !Array.isArray(scheduleIds)) {
    //             throw new Error('Отсутствуют обязательные поля: roomKey, paramKey или scheduleIds (должен быть массив)');
    //         }
            
    //         // Читаем данные из конфигурационного файла на диске
    //         const schedulesData = await readFileSafely(dID, 'schedules');
    //         console.log(`[messageHandlers] - handlePost - Читаем конфигурацию из хранилища schedulesData:`, JSON.stringify(schedulesData.data, null, 2));
            
    //         // Проверяем существование комнаты и параметра
    //         if (!schedulesData.data[room]) {
    //             throw new Error(`Комната ${room} не найдена в расписаниях`);
    //         }
            
    //         if (!schedulesData.data[room][param]) {
    //             throw new Error(`Параметр ${param} не найден в комнате ${room}`);
    //         }
            
    //         const currentSchedules = schedulesData.data[room][param];
            
    //         // Фильтруем расписания, оставляем только те, у которых id НЕ входит в массив scheduleIds
    //         const filteredSchedules = currentSchedules.filter(schedule => {
    //             return !(schedule.id !== undefined && scheduleIds.includes(schedule.id));
    //         });
            
    //         // Проверяем, что были найдены и удалены элементы
    //         if (filteredSchedules.length === currentSchedules.length) {
    //             console.log(`[messageHandlers] - handlePost - Не найдено расписаний с указанными id для удаления:`, scheduleIds);
                
    //             // Все равно отправляем текущие данные клиенту (без изменений)
    //             wsManager.sendToConnection('VUE_connections', clientId, 'response', 'schedules', data.name, schedulesData.data);
                
    //             // Отдельное сообщение о том, что элементы не найдены
    //             wsManager.sendToConnection('VUE_connections', clientId, 'response', 'delScheduleNoMatch', data.name, {
    //                 message: `Не найдено расписаний с указанными id: ${scheduleIds.join(', ')}`,
    //                 room,
    //                 param,
    //                 scheduleIds,
    //                 removedCount: 0
    //             });
                
    //             break;
    //         }
            
    //         // Обновляем данные
    //         schedulesData.data[room][param] = filteredSchedules;
            
    //         // Подсчитываем количество удаленных элементов
    //         const removedCount = currentSchedules.length - filteredSchedules.length;
            
    //         // Если после удаления массив стал пустым, можно удалить сам параметр или комнату
    //         if (filteredSchedules.length === 0) {
    //             delete schedulesData.data[room][param];
                
    //             // Если в комнате больше нет параметров, удаляем комнату
    //             if (Object.keys(schedulesData.data[room]).length === 0) {
    //                 delete schedulesData.data[room];
    //             }
    //         }
            
    //         console.log(`[messageHandlers] - handlePost - Обновленное расписание schedulesData после удаления:`, schedulesData.data);
            
    //         // Сохраняем обновленный конфиг
    //         const dataString = JSON.stringify(schedulesData.data, null, 2);
    //         await writeFileSafely(schedulesData.filePath, dataString);
            
    //         // Отправляем обновленные данные клиенту
    //         wsManager.sendToConnection('VUE_connections', clientId, 'response', 'schedules', data.name, schedulesData.data);
            
    //         // Дополнительно отправляем подтверждение об удалении
    //         wsManager.sendToConnection('VUE_connections', clientId, 'response', 'delScheduleSuccess', data.name, {
    //             message: `Успешно удалено ${removedCount} элементов расписания`,
    //             room,
    //             param,
    //             scheduleIds,
    //             removedCount
    //         });
            
    //         console.log(`[messageHandlers] - handlePost - Удалено ${removedCount} элементов расписания из комнаты "${room}", параметр "${param}"`);
    //         logger.logInfoMessage(`[messageHandlers] - handlePost - Удалено ${removedCount} элементов расписания для пользователя ${dID}, комната ${room}, параметр ${param}`);
            
    //     } catch (error) {
    //         console.error(`[messageHandlers] - handlePost - Ошибка при удалении расписания:`, error);
    //         logger.logErrorMessage(`[messageHandlers] - handlePost - Ошибка при удалении расписания: ${error.message}`);
            
    //         wsManager.sendToConnection('VUE_connections', clientId, 'error', 'delScheduleError', data.name, {
    //             message: error.message,
    //             code: 'DEL_SCHEDULE_ERROR'
    //         });
    //     }
    //     break;
    case 'addSchedule':
            console.log(`[messageHandlers] - handlePost - Получены данные:`, JSON.stringify(data.payload.schedules, null, 2));
            try {
                const schedulesData = await readFileSafely(dID, 'schedules');
                console.log(`[messageHandlers] - handlePost - Читаем конфигурацию из хранилища:`, JSON.stringify(schedulesData.data, null, 2));

                const scheduleItem = { ...data.payload.schedules };
                if (!schedulesData.data[room]) schedulesData.data[room] = {};
                if (!schedulesData.data[room][param]) schedulesData.data[room][param] = [];
                schedulesData.data[room][param].push(scheduleItem);

                // Подготовка к отложенной записи
                fileUpdateNeeded = true;
                filePath = schedulesData.filePath;
                dataToWrite = JSON.stringify(schedulesData.data, null, 2);
                responseType = 'response';
                responseRequest = 'schedules';
                responsePayload = schedulesData.data;

            } catch (error) {
                console.error(`[messageHandlers] - handlePost - Ошибка добавления расписания:`, error);
                wsManager.sendToConnection('VUE_connections', clientId, 'error', 'addScheduleError', data.name, {
                    message: error.message
                });
            }
            break;

        // ---------- УДАЛЕНИЕ РАСПИСАНИЯ ----------
        case 'delSchedule':
            console.log(`530 - [messageHandlers] - handlePost - Request - delSchedule - ${data.payload}`);
            try {
                const { scheduleIds } = data.payload;
                if (!room || !param || !scheduleIds || !Array.isArray(scheduleIds)) {
                    throw new Error('Отсутствуют обязательные поля: roomKey, paramKey или scheduleIds (должен быть массив)');
                }

                const schedulesData = await readFileSafely(dID, 'schedules');
                if (!schedulesData.data[room]) throw new Error(`Комната ${room} не найдена`);
                if (!schedulesData.data[room][param]) throw new Error(`Параметр ${param} не найден`);

                const currentSchedules = schedulesData.data[room][param];
                const filteredSchedules = currentSchedules.filter(schedule =>
                    !(schedule.id !== undefined && scheduleIds.includes(schedule.id))
                );

                const removedCount = currentSchedules.length - filteredSchedules.length;
                if (removedCount === 0) {
                    // Нет совпадений – отправляем уведомление, но файл не трогаем
                    wsManager.sendToConnection('VUE_connections', clientId, 'response', 'delScheduleNoMatch', data.name, {
                        message: `Не найдено расписаний с указанными id: ${scheduleIds.join(', ')}`,
                        room, param, scheduleIds, removedCount: 0
                    });
                    break; // выходим из case, файл не обновляется
                }

                // Обновляем структуру
                schedulesData.data[room][param] = filteredSchedules;
                if (filteredSchedules.length === 0) {
                    delete schedulesData.data[room][param];
                    if (Object.keys(schedulesData.data[room]).length === 0) {
                        delete schedulesData.data[room];
                    }
                }

                // Подготовка к отложенной записи и отправке основного обновления
                fileUpdateNeeded = true;
                filePath = schedulesData.filePath;
                dataToWrite = JSON.stringify(schedulesData.data, null, 2);
                responseType = 'response';
                responseRequest = 'schedules';
                responsePayload = schedulesData.data;

                // Дополнительно отправляем подтверждение об удалении (сразу, не откладывая)
                wsManager.sendToConnection('VUE_connections', clientId, 'response', 'delScheduleSuccess', data.name, {
                    message: `Успешно удалено ${removedCount} элементов расписания`,
                    room, param, scheduleIds, removedCount
                });

            } catch (error) {
                console.error(`[messageHandlers] - handlePost - Ошибка при удалении расписания:`, error);
                wsManager.sendToConnection('VUE_connections', clientId, 'error', 'delScheduleError', data.name, {
                    message: error.message, code: 'DEL_SCHEDULE_ERROR'
                });
            }
            break;
    case 'updateSchedules':
            console.log(`[messageHandlers] - handlePost - updateSchedules:`, JSON.stringify(data.payload, null, 2));
            try {
                const schedulesData = await readFileSafely(dID, 'schedules');
                if (!schedulesData.data[room]?.[param]) {
                    throw new Error(`Параметр ${param} отсутствует в комнате ${room}`);
                }

                const scheduleIndex = schedulesData.data[room][param].findIndex(s => s.id === id);
                if (scheduleIndex === -1) {
                    throw new Error(`Расписание с ID ${id} не найдено`);
                }

                // Обновляем нужное поле
                schedulesData.data[room][param][scheduleIndex][value_name] = value;
                schedulesData.data[room][param][scheduleIndex].value_type = value_type;

                // Подготовка к отложенной записи
                fileUpdateNeeded = true;
                filePath = schedulesData.filePath;            // исправлено: используем filePath из schedulesData
                dataToWrite = JSON.stringify(schedulesData.data, null, 2);
                responseType = 'response';
                responseRequest = 'schedules';
                responsePayload = schedulesData.data;

            } catch (error) {
                console.error(`[messageHandlers] - handlePost - Ошибка обновления расписания:`, error);
                wsManager.sendToConnection('VUE_connections', clientId, 'error', 'updateScheduleError', dID, {
                    message: error.message
                });
            }
            break;

    // ---------- NOTIFICATIONS (аналогично addSchedule) ----------
case 'addNotifications':
    console.log(`[messageHandlers] - handlePost - addNotifications`);
    try {
        const { notification } = data.payload; // ожидаем объект уведомления с полями room, param, id и др.
        if (!notification) throw new Error('Missing notification object');
        const { room, param } = notification;
        if (!room || !param) throw new Error('Missing room or param in notification');

        const notifData = await readFileSafely(dID, 'notifications');
        // Гарантируем структуру
        if (!notifData.data[room]) notifData.data[room] = {};
        if (!notifData.data[room][param]) notifData.data[room][param] = [];

        // Добавляем уведомление (клиент должен предоставить id)
        notifData.data[room][param].push(notification);

        fileUpdateNeeded = true;
        filePath = notifData.filePath;
        dataToWrite = JSON.stringify(notifData.data, null, 2);
        responseType = 'response';
        responseRequest = 'notifications';
        responsePayload = notifData.data;

        console.log(`[messageHandlers] - handlePost - Уведомление добавлено в ${room}/${param}`);
    } catch (error) {
        console.error(`[messageHandlers] - handlePost - Ошибка addNotifications:`, error);
        wsManager.sendToConnection('VUE_connections', clientId, 'error', 'addNotificationsError', data.name, {
            message: error.message
        });
    }
    break;

case 'delNotifications':
    console.log(`[messageHandlers] - handlePost - delNotifications`);
    try {
        const { room, param, ids } = data.payload; // ids - массив id уведомлений для удаления
        if (!room || !param || !ids || !Array.isArray(ids)) {
            throw new Error('Missing room, param or ids array');
        }

        const notifData = await readFileSafely(dID, 'notifications');
        if (!notifData.data[room]?.[param]) {
            throw new Error(`Notifications for room ${room}, param ${param} not found`);
        }

        const currentArray = notifData.data[room][param];
        const originalLength = currentArray.length;
        const filtered = currentArray.filter(item => !ids.includes(item.id));
        const removedCount = originalLength - filtered.length;

        if (removedCount === 0) {
            wsManager.sendToConnection('VUE_connections', clientId, 'response', 'delNotificationsNoMatch', data.name, {
                message: `Не найдено уведомлений с указанными id: ${ids.join(', ')}`,
                room, param, ids, removedCount: 0
            });
            break;
        }

        // Обновляем массив
        notifData.data[room][param] = filtered;
        if (filtered.length === 0) {
            delete notifData.data[room][param];
            if (Object.keys(notifData.data[room]).length === 0) {
                delete notifData.data[room];
            }
        }

        fileUpdateNeeded = true;
        filePath = notifData.filePath;
        dataToWrite = JSON.stringify(notifData.data, null, 2);
        responseType = 'response';
        responseRequest = 'notifications';
        responsePayload = notifData.data;

        wsManager.sendToConnection('VUE_connections', clientId, 'response', 'delNotificationsSuccess', data.name, {
            message: `Успешно удалено ${removedCount} уведомлений`,
            room, param, ids, removedCount
        });

    } catch (error) {
        console.error(`[messageHandlers] - handlePost - Ошибка delNotifications:`, error);
        wsManager.sendToConnection('VUE_connections', clientId, 'error', 'delNotificationsError', data.name, {
            message: error.message
        });
    }
    break;

case 'updateNotifications':
    console.log(`[messageHandlers] - handlePost - updateNotifications`);
    try {
        const { room, param, id, updates } = data.payload; // id уведомления, updates - объект с изменениями
        if (!room || !param || !id || !updates) {
            throw new Error('Missing room, param, id or updates');
        }

        const notifData = await readFileSafely(dID, 'notifications');
        if (!notifData.data[room]?.[param]) {
            throw new Error(`Notifications for room ${room}, param ${param} not found`);
        }

        const index = notifData.data[room][param].findIndex(item => item.id === id);
        if (index === -1) throw new Error(`Notification with id ${id} not found`);

        // Обновляем, сохраняя остальные поля
        notifData.data[room][param][index] = {
            ...notifData.data[room][param][index],
            ...updates,
            updatedAt: new Date().toISOString()
        };

        fileUpdateNeeded = true;
        filePath = notifData.filePath;
        dataToWrite = JSON.stringify(notifData.data, null, 2);
        responseType = 'response';
        responseRequest = 'notifications';
        responsePayload = notifData.data;

    } catch (error) {
        console.error(`[messageHandlers] - handlePost - Ошибка updateNotifications:`, error);
        wsManager.sendToConnection('VUE_connections', clientId, 'error', 'updateNotificationsError', data.name, {
            message: error.message
        });
    }
    break;

// ---------- STATISTICS (аналогично addSchedule) ----------
case 'addStatistics':
    console.log(`[messageHandlers] - handlePost - addStatistics`);
    try {
        const { statistics } = data.payload; // ожидаем объект статистики с полями room, param, id и др.
        if (!statistics) throw new Error('Missing statistics object');
        const { room, param } = statistics;
        if (!room || !param) throw new Error('Missing room or param in statistics');

        const statData = await readFileSafely(dID, 'statistics');
        if (!statData.data[room]) statData.data[room] = {};
        if (!statData.data[room][param]) statData.data[room][param] = [];

        statData.data[room][param].push(statistics);

        fileUpdateNeeded = true;
        filePath = statData.filePath;
        dataToWrite = JSON.stringify(statData.data, null, 2);
        responseType = 'response';
        responseRequest = 'statistics';
        responsePayload = statData.data;

        console.log(`[messageHandlers] - handlePost - Статистика добавлена в ${room}/${param}`);
    } catch (error) {
        console.error(`[messageHandlers] - handlePost - Ошибка addStatistics:`, error);
        wsManager.sendToConnection('VUE_connections', clientId, 'error', 'addStatisticsError', data.name, {
            message: error.message
        });
    }
    break;

case 'delStatistics':
    console.log(`[messageHandlers] - handlePost - delStatistics`);
    try {
        const { room, param, ids } = data.payload;
        if (!room || !param || !ids || !Array.isArray(ids)) {
            throw new Error('Missing room, param or ids array');
        }

        const statData = await readFileSafely(dID, 'statistics');
        if (!statData.data[room]?.[param]) {
            throw new Error(`Statistics for room ${room}, param ${param} not found`);
        }

        const currentArray = statData.data[room][param];
        const originalLength = currentArray.length;
        const filtered = currentArray.filter(item => !ids.includes(item.id));
        const removedCount = originalLength - filtered.length;

        if (removedCount === 0) {
            wsManager.sendToConnection('VUE_connections', clientId, 'response', 'delStatisticsNoMatch', data.name, {
                message: `Не найдено элементов статистики с указанными id: ${ids.join(', ')}`,
                room, param, ids, removedCount: 0
            });
            break;
        }

        statData.data[room][param] = filtered;
        if (filtered.length === 0) {
            delete statData.data[room][param];
            if (Object.keys(statData.data[room]).length === 0) {
                delete statData.data[room];
            }
        }

        fileUpdateNeeded = true;
        filePath = statData.filePath;
        dataToWrite = JSON.stringify(statData.data, null, 2);
        responseType = 'response';
        responseRequest = 'statistics';
        responsePayload = statData.data;

        wsManager.sendToConnection('VUE_connections', clientId, 'response', 'delStatisticsSuccess', data.name, {
            message: `Успешно удалено ${removedCount} элементов статистики`,
            room, param, ids, removedCount
        });

    } catch (error) {
        console.error(`[messageHandlers] - handlePost - Ошибка delStatistics:`, error);
        wsManager.sendToConnection('VUE_connections', clientId, 'error', 'delStatisticsError', data.name, {
            message: error.message
        });
    }
    break;

case 'updateStatistics':
    console.log(`[messageHandlers] - handlePost - updateStatistics`);
    try {
        const { room, param, id, updates } = data.payload;
        if (!room || !param || !id || !updates) {
            throw new Error('Missing room, param, id or updates');
        }

        const statData = await readFileSafely(dID, 'statistics');
        if (!statData.data[room]?.[param]) {
            throw new Error(`Statistics for room ${room}, param ${param} not found`);
        }

        const index = statData.data[room][param].findIndex(item => item.id === id);
        if (index === -1) throw new Error(`Statistics item with id ${id} not found`);

        statData.data[room][param][index] = {
            ...statData.data[room][param][index],
            ...updates,
            updatedAt: new Date().toISOString()
        };

        fileUpdateNeeded = true;
        filePath = statData.filePath;
        dataToWrite = JSON.stringify(statData.data, null, 2);
        responseType = 'response';
        responseRequest = 'statistics';
        responsePayload = statData.data;

    } catch (error) {
        console.error(`[messageHandlers] - handlePost - Ошибка updateStatistics:`, error);
        wsManager.sendToConnection('VUE_connections', clientId, 'error', 'updateStatisticsError', data.name, {
            message: error.message
        });
    }
    break;


        
    case 'sensors':
        logger.logDevMessage(`[messageHandlers] - handlePost - Request - sensor`);
        try {
          logger.logDevMessage(`[messageHandlers] - handlePost - Получены данные:', ${data}`);
        } catch (error) {
          logger.logErrorMessage(`[messageHandlers] - handlePost - Ошибка обработки sensors:', ${error}`);
        }
    break;
    default:
      break;
  }

  // ----- ЦЕНТРАЛИЗОВАННАЯ ЗАПИСЬ И ОТПРАВКА (ЕСЛИ НУЖНО) -----
    if (fileUpdateNeeded && filePath && dataToWrite) {
        try {
            await writeFileSafely(filePath, dataToWrite);
            logger.logDevMessage(`[messageHandlers] - handlePost - Файл ${filePath} успешно обновлён.`);

            // Отправляем обновлённые данные клиенту
            if (responseType && responseRequest && responsePayload) {
                wsManager.sendToConnection('VUE_connections', clientId, responseType, responseRequest, data.name, responsePayload);
                logger.logDevMessage(`[messageHandlers] - handlePost - Отправлен ответ ${responseRequest} клиенту ${clientId}`);
            }
        } catch (err) {
            logger.logErrorMessage(`[messageHandlers] - handlePost - Ошибка при записи файла ${filePath}: ${err.message}`);
            wsManager.sendToConnection('VUE_connections', clientId, 'error', 'fileWriteError', data.name, {
                message: `Не удалось сохранить конфигурацию: ${err.message}`
            });
        }
    }

};

const handleResponse = async (clientId, data) => {
    logger.logDevMessage(`messageHandlers] - handleResponse - Переходим к проверке сообщения типа response.`);
    const client = nodeRedClients.get(clientId);
    switch (data?.request) {
        case 'config':
          try {
            logger.logDevMessage(`[messageHandlers] - handleResponse - Request - config ${data}`);
            if (data.payload) {
              const dID = data.name;
              const configName = Object.keys(data.payload)[0];
              const configData = data.payload[configName];

              logger.logDevMessage(`[messageHandlers] - handleResponse -Config ID: ${dID}`);
              logger.logDevMessage(`[messageHandlers] - handleResponse - Config Name: ${configName}`);
              logger.logDevMessage(`[messageHandlers] - handleResponse - Config Data: ${configData}`);

                  // 1. Проверка существования конфига
                  const checkResult = await DBManager.checkRecordExists(
                    'config',
                    { name: configName },
                    dID,
                    dbUser,
                    dbPass
                );
                  // 2. Если конфиг уже существует
                  if (checkResult.exists) {
                    const client = nodeRedClients.get(clientId);
                    wsManager.sendToConnection('nRED_connections', clientId, 'response', 'configExists', data.name, {
                      config: configName,
                        message: `Конфиг '${configName}' уже существует в базе`,
                        exists: true,
                        id: checkResult.id
                    });
                    // sendSuccess(client.output, 'configExists', dID, {
                    //     config: configName,
                    //     message: `Конфиг '${configName}' уже существует в базе`,
                    //     exists: true,
                    //     id: checkResult.id
                    // });
                    //continue;
                };
                  // 3. Создание новой записи
                  const currentDate = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
                  const result = await DBManager.query(
                      `INSERT INTO config (name, file, update_date)
                       VALUES ($1, $2, $3)
                       RETURNING id, name, update_date`,
                      [configName, configData, currentDate],
                      dID,
                      dbUser,
                      dbPass
                  );
                  if (!result || !result.rows || result.rows.length === 0) {
                    throw new Error('Failed to insert config record');
                  }
                  // 4. Отправка подтверждения
                  wsManager.sendToConnection('nRED_connections',clientId, 'response', 'configSaved', dID, {
                    config: configName,
                            record: {
                                id: result.rows[0].id,
                                name: result.rows[0].name,
                                update_date: result.rows[0].update_date
                            }
                  });
                //   sendSuccess(client.output, 'configSaved', dID, {
                //     config: configName,
                //     record: {
                //         id: result.rows[0].id,
                //         name: result.rows[0].name,
                //         update_date: result.rows[0].update_date
                //     }
                // });

                logger.logDevMessage(`[messageHandlers] - handleResponse - Конфиг ${configName} сохранен в БД ${dID}`);

          } else {
              logger.logErrorMessage(`[messageHandlers] - handleResponse - Invalid data structure`);
          }

          } catch (error) {
            logger.logErrorMessage(`[messageHandlers] - handleResponse - Ошибка обработки конфига: ${error}`);
            wsManager.sendToConnection('nRED_connections', clientId, 'error', 'configError', data.name, {
                message: error.message,
                code: error.code || 'DB_ERROR'
            });
            // sendError(client.output, 'configError', data.name, {
            //     message: error.message,
            //     code: error.code || 'DB_ERROR'
            // });
          }
        break;
        default:
        break;
    }
};
const handleSet = async (clientId, data) => {
    logger.logDevMessage(`[messageHandlers] - handleSet - Переходим к проверке сообщения типа set.`);
};
const handleError = async (clientId, data) => {
    logger.logDevMessage(`[messageHandlers] - handleError - Переходим к проверке сообщения типа Error`);
};

module.exports = {
  handlePostNodeRED,
  handleAuth,
  handleGet,
  handlePost,
  handleResponse,
  handleSet,
  handleError
};