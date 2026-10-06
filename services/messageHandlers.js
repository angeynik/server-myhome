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
const { error } = require('console');
// Получаем список имен конфигов из переменной окружения
const configNames = JSON.parse(process.env.DB_CONFIG_NAMES || '[]');

function getValue(value) {
    return Array.isArray(value) ? value[0] : value;
};

// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
/**
 * Читает конфигурацию, добавляет элемент в data[room][param] и возвращает готовые данные.
 * Используется в: addschedules, addnotifications
 */
async function addConfigItem(dID, configName, room, param, item) {
  console.log('[messageHandlers] - addConfigItem - Готовим конфигурацию ', configName, ' для обновления');
  const { data, filePath } = await readFileSafely(dID, configName);
  if (!data[room])        data[room]        = {};
  if (!data[room][param]) data[room][param] = [];
  data[room][param].push({ ...item });
  return { data, filePath };
}
 
/**
 * Читает конфигурацию, удаляет из data[room][param] элементы с id из массива Ids.
 * Очищает пустые ветки room/param.
 * Используется в: delschedules, delnotifications, delStatistics
 *
 * @returns {{ data, filePath, removedCount }}
 * @throws если room или param не найдены
 */
async function deleteConfigItems(dID, configName, room, param, Ids) {
  const { data, filePath } = await readFileSafely(dID, configName);
  if (!data[room])        throw new Error(`Комната ${room} не найдена`);
  if (!data[room][param]) throw new Error(`Параметр ${param} не найден в комнате ${room}`);
 
  const current      = data[room][param];
  const filtered     = current.filter(item => !(item.id !== undefined && Ids.includes(item.id)));
  const removedCount = current.length - filtered.length;
 
  if (removedCount > 0) {
    data[room][param] = filtered;
    // Чистим пустые узлы
    if (filtered.length === 0) {
      delete data[room][param];
      if (Object.keys(data[room]).length === 0) delete data[room];
    }
  }
 
  return { data, filePath, removedCount };
}
 
/**
 * Читает конфигурацию, находит элемент по id в data[room][param],
 * обновляет поле value_name и метку updatedAt.
 * Используется в: updateschedules, updatenotifications
 *
 * @param {object} fields - { id, value_name, value, updated, value_type? }
 * @returns {{ data, filePath }}
 * @throws если элемент не найден
 */
async function updateConfigItem(dID, configName, room, param, { id, value_name, value, updated, value_type }) {
  const { data, filePath } = await readFileSafely(dID, configName);
  if (!data[room]?.[param]) throw new Error(`Параметр ${param} отсутствует в комнате ${room}`);
 
  const index = data[room][param].findIndex(s => s.id === id);
  if (index === -1) throw new Error(`Элемент с ID ${id} не найден`);
 
  data[room][param][index][value_name] = value;
  data[room][param][index].updatedAt   = updated;
  // value_type обновляем только если явно передан (schedules — да, notifications — нет)
  if (value_type !== undefined) {
    data[room][param][index].value_type = value_type;
  }
 
  return { data, filePath };
}
 
/**
 * Собирает объект «отложенного ответа» — запись файла + отправка данных клиенту.
 * Результат присваивается деструктурированием в переменные функции handlePost.
 */
function buildFileResponse(data, filePath, responseType, responseRequest) {
  return {
    fileUpdateNeeded: true,
    filePath,
    dataToWrite:      JSON.stringify(data, null, 2),
    responseType,
    responseRequest,
    responsePayload:  data,
  };
}




// ОСНОВНЫЕ ФУНКЦИИ

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
        //console.log('[messageHandlers] - handleGet - configData - ', configData);
        
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
  logger.logDevMessage(`[messageHandlers] - handlePost - request: ${data.request}`);
  console.log('[messageHandlers] - handlePost - Request:', data?.request,
    '\nPayload:', JSON.stringify(data.payload, null, 2));
 
  const dID = data.name;
  const { room, key, param, value, value_name, id, value_type, setKey, updated } = data.payload;
 
  // Состояние отложенной записи — заполняется в каждом case через buildFileResponse
  let fileUpdateNeeded = false;
  let filePath         = '';
  let dataToWrite      = null;
  let responseType     = '';
  let responseRequest  = '';
  let responsePayload  = null;
 
  // ── Локальные хелперы отправки ──────────────────────────────────────────
  const sendError = (request, message, extra = {}) =>
    wsManager.sendToConnection('VUE_connections', clientId, 'error', request, dID, { message, ...extra });
 
  const sendResponse = (request, payload) =>
    wsManager.sendToConnection('VUE_connections', clientId, 'response', request, dID, payload);
 
 
  switch (data?.request) {
 
    // ── ПОЛЬЗОВАТЕЛИ ──────────────────────────────────────────────────────
 
    case 'createUser': {
      try {
        const { username, password, dataSource, permissionLevel } = data.payload;
        const newUser = await tableDB.registerUser(
          username, password, permissionLevel,
          dataSource, dataSource, '', '', process.env.DB_DATABASE
        );
        sendResponse('createUserSuccess', { user: newUser.user });
      } catch (error) {
        sendError('createUserError', error.message);
      }
      break;
    }
 
    case 'linkUserToDataSource': {
      try {
        const { userId, dataSourceId } = data.payload;
        const result = await tableDB.linkDataSourceToUser(userId, dataSourceId, process.env.DB_DATABASE);
        if (result.error) {
          sendError('linkUserToDataSourceError', result.error);
        } else {
          sendResponse('linkUserToDataSourceSuccess', { message: 'Связь успешно создана', linkId: result.id });
        }
      } catch (error) {
        sendError('linkUserToDataSourceError', error.message);
      }
      break;
    }
 
    // ── ИНИЦИАЛИЗАЦИЯ ─────────────────────────────────────────────────────
 
    case 'init_dID': {
      logger.logInfoMessage(`[messageHandlers] - handlePost - init_dID: ${data.name}`);
      try {
        DBManager.getPool(authDB, dbUser, dbPass).on('error', (err) => {
          logger.logErrorMessage(`[messageHandlers] - Ошибка пула соединений: ${err}`);
        });
        const dbDID = await DBManager.query('SELECT NOW()', [], dID, dbUser, dbPass);
        logger.logDevMessage(`[messageHandlers] - Подключение к БД: ${dbDID.rows[0].now}`);
 
        const tablesToCheck = ['config', 'data'];
        let allTablesExist  = true;
        for (const table of tablesToCheck) {
          const exists = await DBManager.checkTableExists(table, dID, dbUser, dbPass);
          if (!exists) { allTablesExist = false; break; }
        }
 
        if (!allTablesExist) {
          logger.logInfoMessage(`[messageHandlers] - Таблицы в "${dID}" отсутствуют.`);
          break;
        }
 
        logger.logInfoMessage(`[messageHandlers] - Таблицы в "${dID}" существуют.`);
        for (const config of configNames) {
          const checkResult = await DBManager.checkRecordExists(
            'config', { name: config }, dID, dbUser, dbPass
          );
 
          if (checkResult.exists) {
            const fileResult = await DBManager.query(
              'SELECT file FROM config WHERE name = $1', [config], dID, dbUser, dbPass
            );
            const fileData = fileResult.rows[0]?.file;
            if (!fileData || Object.keys(fileData).length === 0) {
              logger.logDevMessage(`[messageHandlers] - JSON пустой, запрашиваем у nodeRED: ${config}`);
              wsManager.sendToConnection('nRED_connections', clientId, 'get', 'config', dID, { config });
            }
          } else {
            logger.logDevMessage(`[messageHandlers] - Запись ${config} отсутствует, запрашиваем у nodeRED`);
            wsManager.sendToConnection('nRED_connections', clientId, 'get', 'config', dID, { config });
          }
        }
      } catch (error) {
        logger.logErrorMessage(`[messageHandlers] - Ошибка обращения к БД "${dID}": ${error}`);
      }
      break;
    }
 
    case 'wsConnect':
      // Placeholder — обработка подключения не требуется
      break;
 
    // ── SETPOINTS ──────────────────────────────────────────────────────────
 
    case 'setpoints': {
      const setpointKey = 's'+key;
      console.log('[messageHandlers] - handlePost - setpoints - setpointKey:', setpointKey, 'value-', value);
      try {
        if (!setpointKey) throw new Error(`setpointKey не определён`);
 
        const { data: cfgData, filePath: cfgPath } = await readFileSafely(dID, 'config');
        if (cfgData[room]?.setpoints) {
          const type = (typeof value === 'boolean') ? 'bool' : 'num';

          cfgData[room].setpoints[setpointKey] = {
            value: value,
            type: type,
            lastUpdate: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
          };
        }
        console.log('[messageHandlers] - handlePost - setpoints - cfgData', cfgData[room].setpoints);
        
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'config'));
 
      } catch (error) {
        logger.logErrorMessage(`[messageHandlers] - handlePost - Ошибка setpoints: ${error}`);
        sendError('setpointError', error.message);
      }
      break;
    }
 
    case 'system': {
      try {
        const { data: cfgData, filePath: cfgPath } = await readFileSafely(dID, 'config');
        if (cfgData[room]?.system) {
          cfgData[room].system[item_name] = {
            value: value,
            type: value_type ?? cfgData[room].system[item_name]?.type ?? 'xStatus',
            lastUpdate: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
          };
        }
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'config'));
      } catch (error) {
        logger.logErrorMessage(`[messageHandlers] - handlePost - Ошибка system: ${error}`);
        sendError('systemWriteError', error.message);
      }
      break;
    }
    // ── SCHEDULES ──────────────────────────────────────────────────────────
 
    case 'addschedules': {
      try {
        const { data: cfgData, filePath: cfgPath } =
          await addConfigItem(dID, 'schedules', room, param, data.payload.configData);
 
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'schedules'));
 
      } catch (error) {
        console.error('[messageHandlers] - handlePost - Ошибка addschedules:', error);
        sendError('addScheduleError', error.message);
      }
      break;
    }
 
    case 'delschedules': {
      try {
        const { Ids } = data.payload;
        if (!room || !param || !Array.isArray(Ids)) {
          throw new Error('Отсутствуют обязательные поля: room, param или Ids (массив)');
        }
        const { data: cfgData, filePath: cfgPath, removedCount } =
          await deleteConfigItems(dID, 'schedules', room, param, Ids);
 
        if (removedCount === 0) {
          sendResponse('delScheduleNoMatch', {
            message: `Не найдено расписаний с id: ${Ids.join(', ')}`,
            room, param, Ids, removedCount: 0,
          });
          break;
        }
 
        // Немедленное подтверждение удаления — до записи файла
        sendResponse('delScheduleSuccess', {
          message: `Успешно удалено ${removedCount} элементов расписания`,
          room, param, Ids, removedCount,
        });
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'schedules'));
 
      } catch (error) {
        console.error('[messageHandlers] - handlePost - Ошибка delschedules:', error);
        sendError('delScheduleError', error.message, { code: 'DEL_SCHEDULE_ERROR' });
      }
      break;
    }
 
    case 'updateschedules': {
      try {
        const { data: cfgData, filePath: cfgPath } =
          await updateConfigItem(dID, 'schedules', room, param, { id, value_name, value, updated, value_type });
 
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'schedules'));
 
      } catch (error) {
        console.error('[messageHandlers] - handlePost - Ошибка updateschedules:', error);
        sendError('updateScheduleError', error.message);
      }
      break;
    }
 
    // ── NOTIFICATIONS ─────────────────────────────────────────────────────
 
    case 'addnotifications': {
      try {
        const { data: cfgData, filePath: cfgPath } =
          await addConfigItem(dID, 'notifications', room, param, data.payload.configData);
 
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'notifications'));
 
      } catch (error) {
        console.error('[messageHandlers] - handlePost - Ошибка addnotifications:', error);
        sendError('addNotificationsError', error.message);
      }
      break;
    }
 
    case 'delnotifications': {
      try {
        const { Ids } = data.payload;
        if (!room || !param || !Array.isArray(Ids)) {
          throw new Error('Отсутствуют обязательные поля: room, param или Ids (массив)');
        }
        const { data: cfgData, filePath: cfgPath, removedCount } =
          await deleteConfigItems(dID, 'notifications', room, param, Ids);
 
        if (removedCount === 0) {
          sendResponse('delNotificationsNoMatch', {
            message: `Не найдено уведомлений с id: ${Ids.join(', ')}`,
            room, param, Ids, removedCount: 0,
          });
          break;
        }
 
        sendResponse('delNotificationsSuccess', {
          message: `Успешно удалено ${removedCount} уведомлений`,
          room, param, Ids, removedCount,
        });
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'notifications'));
 
      } catch (error) {
        console.error('[messageHandlers] - handlePost - Ошибка delnotifications:', error);
        sendError('delNotificationsError', error.message, { code: 'DEL_NOTIFICATIONS_ERROR' });
      }
      break;
    }
 
    case 'updatenotifications': {
      try {
        // value_type не передаём — для notifications поле не обновляется
        const { data: cfgData, filePath: cfgPath } =
          await updateConfigItem(dID, 'notifications', room, param, { id, value_name, value, updated });
 
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'notifications'));
 
      } catch (error) {
        console.error('[messageHandlers] - handlePost - Ошибка updatenotifications:', error);
        sendError('updateNotificationsError', error.message);
      }
      break;
    }
 
    // ── STATISTICS ────────────────────────────────────────────────────────
 
    case 'addstatistics': {
      try {
        const { room, param, configData } = data.payload;
        if (!room || !param || !configData) {
          throw new Error('Отсутствуют обязательные поля: room, param или configData');
        }
        const { data: cfgData, filePath: cfgPath } =
          await addConfigItem(dID, 'statistics', room, param, configData);
 
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'statistics'));
        console.log('[messageHandlers] - handlePost - сase addStatistics Определили cfgPath ', cfgPath);
 
      } catch (error) {
        console.error('[messageHandlers] - handlePost - Ошибка addStatistics:', error);
        sendError('addStatisticsError', error.message);
      }
      break;
    }
 
    case 'delstatistics': {
      try {
        const { Ids } = data.payload;
        if (!room || !param || !Array.isArray(Ids)) {
          throw new Error('Отсутствуют обязательные поля: room, param или Ids (массив)');
        }
        const { data: cfgData, filePath: cfgPath, removedCount } =
          await deleteConfigItems(dID, 'statistics', room, param, Ids);
 
        if (removedCount === 0) {
          sendResponse('delNotificationsNoMatch', {
            message: `Не найдено уведомлений с id: ${Ids.join(', ')}`,
            room, param, Ids, removedCount: 0,
          });
          break;
        }
 
        sendResponse('delNotificationsSuccess', {
          message: `Успешно удалено ${removedCount} уведомлений`,
          room, param, Ids, removedCount,
        });
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'statistics'));
 
      } catch (error) {
        console.error('[messageHandlers] - handlePost - Ошибка delstatistics:', error);
        sendError('delStatisticsError', error.message, { code: 'DEL_STATISTIC_ERROR' });
      }
      break;
    }
 
    case 'updatestatistics': {
        try {
        // value_type не передаём — для statistics поле не обновляется
        const { data: cfgData, filePath: cfgPath } =
          await updateConfigItem(dID, 'statistics', room, param, { id, value_name, value, updated });
 
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'statistics'));
 
      } catch (error) {
        console.error('[messageHandlers] - handlePost - Ошибка updateStatistics:', error);
        sendError('updateStatisticsError', error.message);
      }
      break;
    }
 
    case 'sensors':
      // Placeholder
      break;
 
    default:
      break;
  }
 
 
  // ── ЦЕНТРАЛИЗОВАННАЯ ЗАПИСЬ И ОТПРАВКА ──────────────────────────────────
  // Выполняется один раз после switch — только если case подготовил данные.
 
  if (fileUpdateNeeded && filePath && dataToWrite) {
    try {
      await writeFileSafely(filePath, dataToWrite);
      logger.logDevMessage(`[messageHandlers] - Файл ${filePath} успешно обновлён.`);
 
      if (responseType && responseRequest && responsePayload) {
        wsManager.sendToConnection(
          'VUE_connections', clientId,
          responseType, responseRequest, data.name, responsePayload
        );
        console.log('[messageHandlers] - Ответ отправлен:',
          responseType, responseRequest, data.name);
      }
    } catch (err) {
      logger.logErrorMessage(`[messageHandlers] - Ошибка записи ${filePath}: ${err.message}`);
      sendError('fileWriteError', `Не удалось сохранить конфигурацию: ${err.message}`);
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