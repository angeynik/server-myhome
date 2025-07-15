// Метод обработки получаемых Сервером по Web Socket сообщений

const DBManager = require('./db');
const tableDB = require('./tableDB');
const dotenv = require('dotenv');
dotenv.config({ path: './conf.env' });
const authDB = process.env.DB_DATABASE || 'spring'; // База данных по умолчанию
const dbUser = process.env.DB_USER;
const dbPass = process.env.DB_PASSWORD;

const { loginUser, verifyToken } = require('../auth'); // Импортируем функции авторизации

const { nodeRedClients  } = require('./clientsStore');
const { sendSuccess, sendError, sendRequest} = require('./wsHelpers');
// Получаем список имен конфигов из переменной окружения
const configNames = JSON.parse(process.env.DB_CONFIG_NAMES || '[]');



const handleAuth = async (ws, data) => {
    console.log('handleAuth - Переходим к проверке сообщения типа auth');
  switch (data.request) {
    case 'login':
        console.log('handleAuth - Request - login');
      try {
        const { username, password } = data.payload;
        const requestId = data.payload.requestId;
        const result = await loginUser(username, password);
        console.log('auth-login Результат проверки:', result);
        if (result.error) {
          sendError(ws, 'loginError', data.name, {
            requestId,
            code: result.code,
            message: result.error
          });
        } else {
          console.log('auth-login Успешная проверка отправляем ответ Vue');
          sendSuccess(ws, 'loginSuccess', result.dID, {
            requestId,
            token: result.token,
            username: result.username,
            userlevel: result.userlevel
          });
        }
      } catch (error) {
        console.error('Необработанная ошибка:', error);
        sendError(ws, 'loginError', data.name, {
          username: data.payload.username,
          requestId: data.payload?.requestId,
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
    console.log('handleGet - Переходим к проверке сообщения типа get');
    const dID = data.name;
  switch (data.request) {
    case 'fetchUsers':
      try {
        const users = await DBManager.fetchUsers();
        sendSuccess(ws, 'fetchUsersSuccess', data.name, {
          requestId: data.payload.requestId,
          users: users
        });
      } catch (error) {
        sendError(ws, 'fetchUsersError', data.name, {
          requestId: data.payload.requestId,
          message: error.message
        });
      }
      break;
    case 'fetchDataSources':
      try {
        const dataSources = await DBManager.fetchDataSources();
        sendSuccess(ws, 'fetchDataSourcesSuccess', data.name, {
          requestId: data.payload.requestId,
          sources: dataSources
        });
      } catch (error) {
        sendError(ws, 'fetchDataSourcesError', data.name, {
          requestId: data.payload.requestId,
          message: error.message
        });
      }
      break;
    // case 'config':
    //   try {
    //     const dbDID = await DBManager.query('SELECT NOW()', [], dID, dbUser, dbPass);
    //     if (!dbDID) {
    //       throw new Error('Подключение к базе данных не установлено.');
    //     } 
    //     console.log('Подключение к базе данных успешно установлено.', dbDID.rows[0].now);

    //   } catch (error) {
        
    //   }
    //   break;
    case 'config':
      try {
        const { configName, requestId } = data.payload;
        console.log('handleGet - Request - config configName - ', configName, 'requestId - ', requestId);
        if (!configName) {
          throw new Error('Не указано имя конфига в запросе');
        }
    
        // Проверяем существование записи
        const checkResult = await DBManager.checkRecordExists(
          'config',
          { name: configName },
          dID,
          dbUser,
          dbPass
        );
    console.log('handleGet - Проверка существования конфига name - ', configName, 'результат - ', checkResult);
        if (!checkResult.exists) {
          sendError(ws, 'configError', dID, {
            requestId,
            message: `Конфиг '${configName}' не найден в базе`,
            code: 'CONFIG_NOT_FOUND'
          });
          return;
        }
    
        // Получаем данные конфига
        const result = await DBManager.query(
          'SELECT file FROM config WHERE name = $1',
          [configName],
          dID,
          dbUser,
          dbPass
        );
    
        if (result.rows.length === 0) {
          sendError(ws, 'configError', dID, {
            requestId,
            message: `Ошибка при получении конфига '${configName}'`,
            code: 'CONFIG_FETCH_FAILED'
          });
          return;
        }
    
        // Отправляем ответ с данными конфига
        sendSuccess(ws, 'response', dID, {
          requestId,
          [configName]: result.rows[0].file
        });
    
        console.log(`Конфиг ${configName} успешно отправлен`);
    
      } catch (error) {
        console.error('Ошибка получения конфига:', error);
        sendError(ws, 'configError', dID, {
          requestId: data.payload?.requestId,
          message: error.message,
          code: error.code || 'DB_ERROR'
        });
      }
      break;
    default:
      break;
  }
};

const handlePost = async (ws, data) => {
    console.log('handlePost - Переходим к проверке сообщения типа post, request - ', data.request);
  switch (data.request) {
    case 'createUser':
        console.log('handlePost - Request - createUser');
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
          console.log(`База данных "${dataSource}" успешно создана.`);
          await DBManager.createTableDID(dataSource);
          console.log(`Таблицы успешно созданы в базе "${dataSource}".`);
        }
        sendSuccess(ws, 'createUserSuccess', data.name, {
          requestId: data.payload.requestId,
          user: newUser.user
        });
        return 'ok';
      } catch (error) {
        sendError(ws, 'createUserError', data.name, {
          requestId: data.payload.requestId,
          message: error.message
        });
      }
      break;
    case 'linkUserToDataSource':
        console.log('handlePost - Request - linkUserToDataSource');
      try {
        const { userId, dataSourceId, requestId } = data.payload;
        const linkUser = await tableDB.linkDataSourceToUser(
          userId, dataSourceId, process.env.DB_DATABASE
        );
        
        if (linkUser.error) {
          sendError(ws, 'linkUserToDataSourceError', data.name, {
            requestId,
            message: linkUser.error
          });
        } else {
          sendSuccess(ws, 'linkUserToDataSourceSuccess', data.name, {
            requestId,
            message: 'Связь успешно создана',
            linkId: linkUser.id
          });
        }
      } catch (error) {
        sendError(ws, 'linkUserToDataSourceError', data.name, {
          requestId: data.payload.requestId,
          message: error.message
        });
      }
      break;
    case 'init_dID':
        console.log('handlePost - init_dID :', data.name);
        const dID = data.name;
        try {
          //console.log('Получены данные:', data);
          console.log ('Начинаем проверку наличия БД с именем - ', dID);
          DBManager.getPool(authDB, dbUser, dbPass).on('error', (err) => {
            console.error('Ошибка в пуле соединений:', err);
          });
          const dbDID = await DBManager.query('SELECT NOW()', [], dID, dbUser, dbPass);
          //console.log('Подключение к базе данных успешно установлено.', dbDID.rows[0].now);
          if (!dbDID) {
            console.log(`База данных "${dID}" не существует.`);
          } else {
            console.log(`База данных "${dID}" существует.`);

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
            console.log(`Таблицы в базе "${dID}" отсутствуют.`);
          } else {
            console.log(`Таблицы в базе "${dID}" существуют.`);
            for (const config of configNames) {
              const checkResult = await DBManager.checkRecordExists(
                'config', 
                { name: config },  // Условия поиска
                dID,                       // База данных
                dbUser,                    // Пользователь
                dbPass                     // Пароль
              );

              if (checkResult.exists) {
                console.log(`Запись ${config} существует. Проверяем файл...`);
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
                      console.log('JSON файл существует, но пустой или содержит null');
                    sendRequest(clientId, 'config', dID, {config});
                    }
                }
              } else {
                console.log(`Запись ${config} НЕ существует. Формируем запрос к nodeRED на получение конфигурации ${config}`);
                sendRequest(ws, 'config', dID, {config});
              }
            }
          }
          }


        } catch (error) {
          console.error('Ошибка обращения к базе данных', dID, ' вероятно ее не существует');
          // Обработка ошибки
        }
    break;
    case 'wsConnect':
        console.log('handlePost - Request - wsConnect');
        try {
          //console.log('Получены данные:', data);
        } catch (error) {
          
        }
    break;


    case 'config':
        console.log('handlePost - Request - config');
        try {
          
        } catch (error) {
          
        }
    break;
    case 'sensors':
        console.log('handlePost - Request - sensor');
        try {
          //console.log('Получены данные:', data);
        } catch (error) {
          
        }
    break;
    default:
      break;
  }
};

const handleResponse = async (clientId, data) => {
    console.log('Переходим к проверке сообщения типа response.');
    const client = nodeRedClients.get(clientId)
    switch (data.request) {
        case 'config':
          try {
            //console.log('handleResponse - Request - config', data);
            if (data.payload) {
              const dID = data.name;
              const configName = Object.keys(data.payload)[0];
              const configData = data.payload[configName];

              console.log('Config ID:', dID);
              console.log('Config Name:', configName);
              //console.log('Config Data:', configData);

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
                  // 4. Отправка подтверждения
                  sendSuccess(client.output, 'configSaved', dID, {
                    config: configName,
                    record: {
                        id: result.rows[0].id,
                        name: result.rows[0].name,
                        update_date: result.rows[0].update_date
                    }
                });

                console.log(`Конфиг ${configName} сохранен в БД ${dID}`);

          } else {
              console.error('Invalid data structure');
          }

          } catch (error) {
            console.error('Ошибка обработки конфига:', error);
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
    console.log('Переходим к проверке сообщения типа set.');
};
const handleError = async (clientId, data) => {
    console.log('Переходим к проверке сообщения типа Error');
};

module.exports = {
  handleAuth,
  handleGet,
  handlePost,
  handleResponse,
  handleSet,
  handleError
};