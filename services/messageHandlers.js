// Метод обработки получаемых Сервером WebSocket сообщений

const path = require('path');
const DBManager = require('./db');
const tableDB = require('./tableDB');
const dotenv = require('dotenv');
dotenv.config({ path: './conf.env' });
const authDB = process.env.DB_DATABASE || 'spring'; // База данных по умолчанию
const dbUser = process.env.DB_USER;
const dbPass = process.env.DB_PASSWORD;

const { loginUser, verifyToken } = require('../auth'); // Импортируем функции авторизации
const { writeFileSafely, readFileSafely  } = require('./configStore');
const { nodeRedClients  } = require('./clientsStore');
const { sendSuccess, sendError, sendRequest} = require('./wsHelpers');
const { type } = require('os');
// Получаем список имен конфигов из переменной окружения
const configNames = JSON.parse(process.env.DB_CONFIG_NAMES || '[]');

function getValue(value) {
    return Array.isArray(value) ? value[0] : value;
};

async function handlePostNodeRED(clientId, message) {
  const info = JSON.stringify(message);
  //console.log(`[messageHandlers] - handlePostNodeRED - Обработка сообщения: ${info}`);
    const { name, request, payload = {} } = message;

    // Извлекаем значения из payload
    const room = getValue(payload?.room);
    const item_name = getValue(payload?.item_name);
    const item_value = getValue(payload?.item_value);
    const item_type = getValue(payload?.item_type);
    const item_title = getValue(payload?.item_title);
    const title = getValue(payload?.title);
    const group = getValue(payload?.group);

    //console.log('[messageHandlers] - handlePostNodeRED - type:', item_type, 'room:', room, 'name: ', item_name, 'value: ', item_value );

    // Проверка обязательных полей (раскомментировать)
    if (!room || !item_name || item_value === undefined) {
        throw new Error(`Missing required fields: room=${room}, item_name=${item_name}, item_value=${item_value}`);
    }

    // Читаем данные из конфигурационного файла на диске
    const {data, dataDir, filePath} = await readFileSafely(name);

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
            console.log(`[messageHandlers] - handlePostNodeRED - Создан новый объект ${request} в комнате ${room}`);
        }
        // Добавляем/обновляем элемент
        data[room][request][item_name] = {
            value: item_value,
            type: item_type,
            lastUpdate: new Date().toString()
        };

        //console.log(`[messageHandlers] - handlePostNodeRED - Добавлен ${request}: ${item_name} в объект ${request}`);

        // Сохранение данных
        const dataString = JSON.stringify(data, null, 2);
        await writeFileSafely(filePath, dataString);
        //console.log(`[messageHandlers] -handlePostNodeRED - ✅ Данные успешно обновлены в ${filePath}`);
        //console.log('[messageHandlers] -handlePostNodeRED - Содержимое файла:', dataString);
        return 'ok';
    } catch (err) {
        console.error(`[messageHandlers] -handlePostNodeRED - Ошибка при работе с файлом ${filePath}:`, err);
        return 'error';
    }
};


const handleAuth = async (ws, data) => {
    console.log('[messageHandlers] - handleAuth Переходим к проверке сообщения типа auth');
    //console.log('[messageHandlers] - handleAuth - Request - ', data);
  switch (data?.request) {
    case 'login':
        console.log('[messageHandlers] - handleAuth  - Request - login');
      try {
        const { username, password } = data?.payload;
        const result = await loginUser(username, password);
        //console.log('[messageHandlers] - handleAuth  Результат проверки:', result);
        if (result.error) {
          sendError(ws, 'loginError', data.name, {
            code: result.code,
            message: result.error
          });
        } else {
          console.log('[messageHandlers] - handleAuth  Успешная проверка отправляем ответ Vue');
          sendSuccess(ws, 'loginSuccess', result.dID, {
            token: result.token,
            username: result.username,
            userlevel: result.userlevel
          });
        }
      } catch (error) {
        console.error('Необработанная ошибка:', error);
        sendError(ws, 'loginError', data.name, {
          username: data.payload.username,
          code: 'UNHANDLED_ERROR',
          message: 'Произошла непредвиденная ошибка'
        });
      }
      break;
    default:
      break;
  }
};

const handleGet = async (ws, data) => {
    console.log('[messageHandlers] - handleGet - Переходим к проверке сообщения типа get');
    const dID = data.name;
  switch (data?.request) {
    case 'fetchUsers':
      try {
        const users = await DBManager.fetchUsers();
        sendSuccess(ws, 'fetchUsersSuccess', data.name, {
          users: users
        });
      } catch (error) {
        sendError(ws, 'fetchUsersError', data.name, {
          message: error.message
        });
      }
      break;
    case 'fetchDataSources':
      try {
        const dataSources = await DBManager.fetchDataSources();
        sendSuccess(ws, 'fetchDataSourcesSuccess', data.name, {
          sources: dataSources
        });
      } catch (error) {
        sendError(ws, 'fetchDataSourcesError', data.name, {
          message: error.message
        });
      }
      break;

    case 'config':
      try {
        const { name } = data;
        console.log('[messageHandlers] - handleGet - Request - config -- dID - ', name);
        if (!name) {
          throw new Error('[messageHandlers] - Не указано имя конфига в запросе');
        }
    
        // Читаем конфиг
        const configData = await readFileSafely(name);
        //console.log('[messageHandlers] - handleGet - configData - ', configData);
        
        if (!configData) {
          throw new Error('[messageHandlers] - Failed to read configuration file');
        }
       
        console.log(`[messageHandlers] -  Sending config to ${name}`);
        sendSuccess(ws, 'config', name, configData.data);

        console.log(`[messageHandlers] - Конфиг ${name} успешно отправлен`);
    
      } catch (error) {
        console.error('[messageHandlers] - Ошибка получения конфига:', error);
        sendError(ws, 'configError', dID, {
          message: error.message,
          code: error.code || 'config_read_error'
        });
      }
      break;
    default:
      break;
  }
};

const handlePost = async (ws, data) => {
    console.log('[messageHandlers] - handlePost - Переходим к проверке сообщения типа post, request - ', data.request);
  switch (data?.request) {
    case 'createUser':
        console.log('[messageHandlers] - handlePost - Request - createUser');
      try {
        const { username, password, dataSource, permissionLevel } = data.payload;
        const newUser = await tableDB.registerUser(
          username, password, permissionLevel, 
          dataSource, dataSource, '', '', process.env.DB_DATABASE
        );
        console.log('handlePost - Результат createUser:', newUser);
        if (newUser) {
          // Создаем базу данных
          await DBManager.createDB(dataSource, authDB, dbUser, dbPass);
          console.log(`[messageHandlers] - handlePost - База данных "${dataSource}" успешно создана.`);
          await DBManager.createTableDID(dataSource);
          console.log(`[messageHandlers] - handlePost - Таблицы успешно созданы в базе "${dataSource}".`);
        }
        sendSuccess(ws, 'createUserSuccess', data.name, {
          user: newUser.user
        });
        return 'ok';
      } catch (error) {
        sendError(ws, 'createUserError', data.name, {
          message: error.message
        });
      }
      break;
    case 'linkUserToDataSource':
        console.log('[messageHandlers] - handlePost -  Request - linkUserToDataSource');
      try {
        const { userId, dataSourceId } = data.payload;
        const linkUser = await tableDB.linkDataSourceToUser(
          userId, dataSourceId, process.env.DB_DATABASE
        );
        
        if (linkUser.error) {
          sendError(ws, 'linkUserToDataSourceError', data.name, {
            message: linkUser.error
          });
        } else {
          sendSuccess(ws, 'linkUserToDataSourceSuccess', data.name, {
            message: 'Связь успешно создана',
            linkId: linkUser.id
          });
        }
      } catch (error) {
        sendError(ws, 'linkUserToDataSourceError', data.name, {
          message: error.message
        });
      }
      break;
    case 'init_dID':
        console.log('[messageHandlers] - handlePost - request - init_dID :', data.name);
        const dID = data.name;
        try {
          //console.log('Получены данные:', data);
          console.log ('[messageHandlers] - handlePost - Начинаем проверку наличия БД с именем - ', dID);
          DBManager.getPool(authDB, dbUser, dbPass).on('error', (err) => {
            console.error('[messageHandlers] - handlePost - Ошибка в пуле соединений:', err);
          });
          const dbDID = await DBManager.query('SELECT NOW()', [], dID, dbUser, dbPass);
          //console.log('Подключение к базе данных успешно установлено.', dbDID.rows[0].now);
          if (!dbDID) {
            console.log(`[messageHandlers] - handlePost - База данных "${dID}" не существует.`);
          } else {
            console.log(`[messageHandlers] - handlePost - База данных "${dID}" существует.`);

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
            console.log(`[messageHandlers] - handlePost - Таблицы в базе "${dID}" отсутствуют.`);
          } else {
            console.log(`[messageHandlers] - handlePost - Таблицы в базе "${dID}" существуют.`);
            for (const config of configNames) {
              const checkResult = await DBManager.checkRecordExists(
                'config', 
                { name: config },  // Условия поиска
                dID,                       // База данных
                dbUser,                    // Пользователь
                dbPass                     // Пароль
              );

              if (checkResult.exists) {
                console.log(`[messageHandlers] - handlePost - Запись ${config} существует. Проверяем файл...`);
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
                      //console.log('JSON файл валиден:', fileData);
                    } else {
                      console.log('[messageHandlers] - handlePost - JSON файл существует, но пустой или содержит null');
                    const client = nodeRedClients.get(clientId);
                    sendRequest(client, 'config', dID, {config});
                    }
                }
              } else {
                console.log(`[messageHandlers] - handlePost - Запись ${config} НЕ существует. Формируем запрос к nodeRED на получение конфигурации ${config}`);
                sendRequest(ws, 'config', dID, {config});
              }
            }
          }
          }


        } catch (error) {
          console.error('[messageHandlers] - handlePost - Ошибка обращения к базе данных', dID, ' вероятно ее не существует');
          // Обработка ошибки
        }
    break;
    case 'wsConnect':
        console.log('[messageHandlers] - handlePost - Request - wsConnect');
        try {
          //console.log('[messageHandlers] - handlePost - Получены данные:', data);
        } catch (error) {
          
        }
    break;
    case 'setpoints':
      //console.log('[messageHandlers] - handlePost - Request - setpoint');
      try {
        const dID = data.name;
        const { room, param, value } = data.payload;
        console.log('[messageHandlers] - handlePost - Получены данные:', data, 'dID -', dID);
        
        // Читаем данные из конфигурационного файла на диске
        const { data: configData, filePath } = await readFileSafely(dID);

        // Обновляем значение setpoint
        if (configData[room] && configData[room].setpoints) {
          configData[room].setpoints[param] = {
            value: value,
            type: configData[room].setpoints[param]?.type || 'number',
            lastUpdate: new Date().toString()
          };
        }
          // Сохраняем обновленный конфиг
          const dataString = JSON.stringify(configData, null, 2);
          await writeFileSafely(filePath, dataString);


        } catch (error) {
            console.error('[messageHandlers] - handlePost - Ошибка обработки setpoint:', error);
            sendError(ws, 'setpointError', data.name, {
                message: error.message
            });
        }
    break;


    case 'sensors':
        console.log('[messageHandlers] - handlePost - Request - sensor');
        try {
          //console.log('[messageHandlers] - handlePost - Получены данные:', data);
        } catch (error) {
          console
        }
    break;
    default:
      break;
  }
};

const handleResponse = async (clientId, data) => {
    console.log('[messageHandlers] - handleResponse - Переходим к проверке сообщения типа response.');
    const client = nodeRedClients.get(clientId);
    switch (data?.request) {
        case 'config':
          try {
            //console.log('[messageHandlers] - handleResponse - Request - config', data);
            if (data.payload) {
              const dID = data.name;
              const configName = Object.keys(data.payload)[0];
              const configData = data.payload[configName];

              console.log('[messageHandlers] - handleResponse -Config ID:', dID);
              console.log('[messageHandlers] - handleResponse - Config Name:', configName);
              //console.log('[messageHandlers] - handleResponse - Config Data:', configData);

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
                    sendSuccess(client.output, 'configExists', dID, {
                        config: configName,
                        message: `Конфиг '${configName}' уже существует в базе`,
                        exists: true,
                        id: checkResult.id
                    });
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
                  sendSuccess(client.output, 'configSaved', dID, {
                    config: configName,
                    record: {
                        id: result.rows[0].id,
                        name: result.rows[0].name,
                        update_date: result.rows[0].update_date
                    }
                });

                console.log(`[messageHandlers] - handleResponse - Конфиг ${configName} сохранен в БД ${dID}`);

          } else {
              console.error('[messageHandlers] - handleResponse - Invalid data structure');
          }

          } catch (error) {
            console.error('[messageHandlers] - handleResponse - Ошибка обработки конфига:', error);
            sendError(client.output, 'configError', data.name, {
                message: error.message,
                code: error.code || 'DB_ERROR'
            });
          }
        break;
        default:
        break;
    }
};
const handleSet = async (clientId, data) => {
    console.log('[messageHandlers] - handleSet - Переходим к проверке сообщения типа set.');
};
const handleError = async (clientId, data) => {
    console.log('[messageHandlers] - handleError -  Переходим к проверке сообщения типа Error');
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