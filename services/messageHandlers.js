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
            lastUpdate: new Date().toString()
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
    let { room, param, value, value_name, id, value_type } = data.payload;
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
    case 'setpoints':
      logger.logDevMessage(`[messageHandlers] - handlePost - Request - setpoint`); 
      try {
        //const { room, param, value } = data.payload;
        logger.logDevMessage(`[messageHandlers] - handlePost - Получены данные:', ${data}, 'dID -', ${dID}`);
        
        // Читаем данные из конфигурационного файла на диске
        const { data: configData, filePath } = await readFileSafely(dID, 'config');
        // const printData = JSON.parse(configData);
        // console.log(`[messageHandlers] - handlePost - Читаем данные ${printData}`);
        console.log(`[messageHandlers] - handlePost - Читаем данные из ${filePath}`);

        // Обновляем значение setpoint
        if (configData[room] && configData[room].setpoints) {
          configData[room].setpoints[param] = {
            value: value,
            type: configData[room].setpoints[param]?.type || 'number',
            lastUpdate: new Date().toString()
          };
          const updatedData = configData[room].setpoints[param];
          console.log(`[messageHandlers] - handlePost - Обновляем значение setpoint:`, updatedData);
        }
          // Сохраняем обновленный конфиг
          const dataString = JSON.stringify(configData, null, 2);
          await writeFileSafely(filePath, dataString);
        
        // ✅ ОТПРАВЛЯЕМ ОБНОВЛЕННУЮ КОНФИГУРАЦИЮ КЛИЕНТУ
        wsManager.sendToConnection(
          'VUE_connections',
          clientId,
          'response',
          'config',  // отправляем как обновление конфига
          dID,
          configData  // отправляем весь обновленный конфиг
        );


        } catch (error) {
            logger.logErrorMessage(`[messageHandlers] - handlePost - Ошибка обработки setpoint:', ${error}`);
          wsManager.sendToConnection('VUE_connections', clientId, 'error', 'setpointError', data.name, {
            message: error.message
          });
            // sendError(ws, 'setpointError', data.name, {
            //     message: error.message
            // });
        }
    break;
    case 'addSchedule':
      console.log(`[messageHandlers] - handlePost - Получены данные:', ${JSON.stringify(data.payload.schedules, null, 2)}, 'name -', ${dID}`);
      //const { roomKey, paramKey } = data.payload;
      // Читаем данные из конфигурационного файла на диске
      const schedulesData = await readFileSafely(dID, 'schedules');
      console.log(`[messageHandlers] - handlePost - Читаем конфигурацию из хранилища  schedulesData:`, JSON.stringify(schedulesData.data, null, 2));

      const scheduleItem = {
          ...data.payload.schedules // берем структуру данных из полученного запроса на создание элемента расписания
      };
          console.log(`[messageHandlers] - handlePost - scheduleItem:`, scheduleItem);
        // Создаем или обновляем структуру в store
        if (!schedulesData.data[room]) {
            schedulesData.data[room] = {};
        }
        if (!schedulesData.data[room][param]) {
            schedulesData.data[room][param] = [];
        }
        
        // Добавляем новое расписание
        schedulesData.data[room][param].push(scheduleItem);
        console.log(`[messageHandlers] - handlePost - Обновленное расписание schedulesData:`, schedulesData.data);
        
        // Сохраняем обновленный конфиг
        const dataString = JSON.stringify(schedulesData.data, null, 2);
        await writeFileSafely(schedulesData.filePath, dataString);

        // Отправляем обновленные данные клиенту
        wsManager.sendToConnection('VUE_connections', clientId, 'response', 'schedules', data.name, schedulesData.data);
    break;

    case 'delSchedule':
        console.log(`[messageHandlers] - handlePost - Request - delSchedule`);
        
        try {
            // const { name } = data;
            const { scheduleIds } = data.payload;
            
            console.log(`[messageHandlers] - handlePost - Получены данные для удаления расписания:`, {
                dID,
                room,
                param,
                scheduleIds
            });
            
            // Проверяем обязательные поля
            if (!room || !param || !scheduleIds || !Array.isArray(scheduleIds)) {
                throw new Error('Отсутствуют обязательные поля: roomKey, paramKey или scheduleIds (должен быть массив)');
            }
            
            // Читаем данные из конфигурационного файла на диске
            const schedulesData = await readFileSafely(dID, 'schedules');
            console.log(`[messageHandlers] - handlePost - Читаем конфигурацию из хранилища schedulesData:`, JSON.stringify(schedulesData.data, null, 2));
            
            // Проверяем существование комнаты и параметра
            if (!schedulesData.data[room]) {
                throw new Error(`Комната ${room} не найдена в расписаниях`);
            }
            
            if (!schedulesData.data[room][param]) {
                throw new Error(`Параметр ${param} не найден в комнате ${room}`);
            }
            
            const currentSchedules = schedulesData.data[room][param];
            
            // Фильтруем расписания, оставляем только те, у которых id НЕ входит в массив scheduleIds
            const filteredSchedules = currentSchedules.filter(schedule => {
                return !(schedule.id !== undefined && scheduleIds.includes(schedule.id));
            });
            
            // Проверяем, что были найдены и удалены элементы
            if (filteredSchedules.length === currentSchedules.length) {
                console.log(`[messageHandlers] - handlePost - Не найдено расписаний с указанными id для удаления:`, scheduleIds);
                
                // Все равно отправляем текущие данные клиенту (без изменений)
                wsManager.sendToConnection('VUE_connections', clientId, 'response', 'schedules', data.name, schedulesData.data);
                
                // Отдельное сообщение о том, что элементы не найдены
                wsManager.sendToConnection('VUE_connections', clientId, 'response', 'delScheduleNoMatch', data.name, {
                    message: `Не найдено расписаний с указанными id: ${scheduleIds.join(', ')}`,
                    room,
                    param,
                    scheduleIds,
                    removedCount: 0
                });
                
                break;
            }
            
            // Обновляем данные
            schedulesData.data[room][param] = filteredSchedules;
            
            // Подсчитываем количество удаленных элементов
            const removedCount = currentSchedules.length - filteredSchedules.length;
            
            // Если после удаления массив стал пустым, можно удалить сам параметр или комнату
            if (filteredSchedules.length === 0) {
                delete schedulesData.data[room][param];
                
                // Если в комнате больше нет параметров, удаляем комнату
                if (Object.keys(schedulesData.data[room]).length === 0) {
                    delete schedulesData.data[room];
                }
            }
            
            console.log(`[messageHandlers] - handlePost - Обновленное расписание schedulesData после удаления:`, schedulesData.data);
            
            // Сохраняем обновленный конфиг
            const dataString = JSON.stringify(schedulesData.data, null, 2);
            await writeFileSafely(schedulesData.filePath, dataString);
            
            // Отправляем обновленные данные клиенту
            wsManager.sendToConnection('VUE_connections', clientId, 'response', 'schedules', data.name, schedulesData.data);
            
            // Дополнительно отправляем подтверждение об удалении
            wsManager.sendToConnection('VUE_connections', clientId, 'response', 'delScheduleSuccess', data.name, {
                message: `Успешно удалено ${removedCount} элементов расписания`,
                room,
                param,
                scheduleIds,
                removedCount
            });
            
            console.log(`[messageHandlers] - handlePost - Удалено ${removedCount} элементов расписания из комнаты "${room}", параметр "${param}"`);
            logger.logInfoMessage(`[messageHandlers] - handlePost - Удалено ${removedCount} элементов расписания для пользователя ${dID}, комната ${room}, параметр ${param}`);
            
        } catch (error) {
            console.error(`[messageHandlers] - handlePost - Ошибка при удалении расписания:`, error);
            logger.logErrorMessage(`[messageHandlers] - handlePost - Ошибка при удалении расписания: ${error.message}`);
            
            wsManager.sendToConnection('VUE_connections', clientId, 'error', 'delScheduleError', data.name, {
                message: error.message,
                code: 'DEL_SCHEDULE_ERROR'
            });
        }
        break;
    case 'updateSchedules':
        //Запрос на обновление расписания
        console.log(`[messageHandlers] - handlePost - Получены данные:', ${JSON.stringify(data.payload.schedules, null, 2)}, 'name -', ${dID}`);
        // Читаем данные из конфигурационного файла на диске
        const schedulesData2 = await readFileSafely(dID, 'schedules');
       //console.log(`[messageHandlers] - handlePost - Читаем конфигурацию из хранилища  schedulesData:`, JSON.stringify(schedulesData2.data, null, 2));

        if(!schedulesData2.data[room][param]) {
            console.log(`[messageHandlers] - handlePost - Ошибка параметр ${param} отсутствует в конфигурации комнаты ${room}`);
        } 
        // Находим расписание по ID в массиве
        const scheduleIndex = schedulesData2.data[room][param].findIndex(s => s.id === id);
        if (scheduleIndex === -1) {
            console.error(`[messageHandlers] - handlePost - Расписание с ID ${id} не найдено`);
            wsManager.sendToConnection('VUE_connections', clientId, 'error', 'updateScheduleError', dID, {
                message: `Расписание с ID ${id} не найдено`
            });
            break;
        }
        console.log(`[messageHandlers] - handlePost - Находим расписание по ID в массиве:`, JSON.stringify(schedulesData2.data[room][param][scheduleIndex], null, 2));

        schedulesData2.data[room][param][scheduleIndex][value_name] = value;
        schedulesData2.data[room][param][scheduleIndex].value_type = value_type;
        console.log(`[messageHandlers] - handlePost - Обновили значение переменной ${value_name} с типом ${value_type} в расписании комнаты ${room} параметра ${param}:`, JSON.stringify(schedulesData2.data[room][param], null, 2));
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
                  const currentDate = new Date().toISOString();
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