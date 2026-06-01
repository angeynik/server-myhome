// Действия при инициализации Пользователя по умолчанию, проверка ДБ и таблиц
const DBManager = require('./db'); // Импортируем DBManager
const dotenv = require('dotenv');
dotenv.config({ path: './conf.env' });
//const bcrypt = require('bcryptjs');
const tableDB = require('./tableDB.js');

const authDB = process.env.DB_DATABASE || 'spring'; // База данных по умолчанию
const dbUser = process.env.DB_USER;
const dbPass = process.env.DB_PASSWORD;

const logger = require('./logger.js');
logger.initLogging();

// Обработка событий пула соединений
DBManager.getPool(authDB, dbUser, dbPass).on('error', (err) => {
  logger.logErrorMessage(`[initServer] - Ошибка в пуле соединений: ${err.message}`);
  console.error('[initServer] - Ошибка в пуле соединений:', err);
});

const initServer = async () => {
  try {
    logger.logDevMessage(`[initServer] - Проверка подключения к базе данных...`);
    console.log('[initServer] - Проверка подключения к базе данных...');
    await DBManager.query('SELECT NOW()', [], authDB, dbUser, dbPass);
    logger.logDevMessage(`[initServer] - Подключение к базе данных успешно установлено.`);
    console.log('[initServer] - Подключение к базе данных успешно установлено.');
  } catch (error) {
    logger.logErrorMessage(`[initServer] - Критическая ошибка подключения к базе данных: ${error.message}`);
    console.error('[initServer] - Критическая ошибка подключения к базе данных:', error.message);
    throw error; // Не пытаемся создавать БД, просто прокидываем ошибку
  }
};

const initUsers = async () => {
  try {
    const usersTableExists = await DBManager.checkTableExists('users', authDB, dbUser, dbPass);
    if (!usersTableExists) {
      throw new Error(`Таблица Users отсутствует в базе "${authDB}"`);
    }
    logger.logDevMessage(`[initServer] - Таблица Users существует - ${usersTableExists}.`);
    console.log(`[initServer] - Таблица Users существует - ${usersTableExists}.`);
  } catch (error) {
    logger.logErrorMessage(`[initServer] - Ошибка проверки таблицы Users: ${error.message}`);
    console.error('[initServer] - Ошибка проверки таблицы Users:', error.message);
    throw error;
  }
};

const initDefaulUser = async () => {
  logger.logDevMessage(`[initServer] - initDefaulUser - Проверка наличия пользователя по умолчанию...`);
  console.log('[initServer] - initDefaulUser - Проверка наличия пользователя по умолчанию...');

  const defaultUsername = process.env.DEFAULT_USER_NAME || 'poddy';
  const defaultPassword = process.env.DEFAULT_USER_PASSWORD || 'poddyPASS';
  const defaultLevel = parseInt(process.env.DEFAULT_USER_LEVEL) || 3;
  const defaultDID = process.env.DEFAULT_USER_DID || 'poddy_base';
  const defaultSourceName = process.env.DEFAULT_USER_SOURCE || 'PoddyBase';
  const defaultSourceDescription = 'Auto-created default data source';

  // Проверяем обязательные параметры
  if (!defaultUsername || !defaultPassword || !defaultDID) {
    const errorMsg = '[initServer] - initDefaulUser - Отсутствуют обязательные переменные окружения для создания пользователя по умолчанию (DEFAULT_USER_NAME, DEFAULT_USER_PASSWORD, DEFAULT_USER_DID)';
    logger.logErrorMessage(errorMsg);
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  try {
    const existingUser = await DBManager.findUser(process.env.DEFAULT_USER_NAME);
    if (!existingUser) {
      throw new Error(`[initServer] - initDefaulUser - Пользователь по умолчанию "${process.env.DEFAULT_USER_NAME}" отсутствует`);
    }
    // Пользователя нет – создаём через tableDB.registerUser
    logger.logDevMessage(`[initServer] - initDefaulUser - Пользователь "${defaultUsername}" не найден. Создаём...`);
    console.log(`[initServer] - initDefaulUser - Пользователь "${defaultUsername}" не найден. Создаём...`);

    const result = await tableDB.registerUser(
      defaultUsername,
      defaultPassword,
      defaultLevel,
      defaultDID,
      defaultSourceName,
      defaultSourceDescription,
      null // email не обязателен
    );

    logger.logInfoMessage(`[initServer] - initDefaulUser - Пользователь по умолчанию "${defaultUsername}" успешно создан. ID пользователя: ${result.user.id}, ID источника: ${result.dataSourceId}`);
    console.log(`[initServer] - initDefaulUser - Пользователь "${defaultUsername}" успешно создан.`);
  } catch (error) {
    logger.logErrorMessage(`[initServer] - initDefaulUser - Ошибка проверки пользователя по умолчанию: ${error.message}`);
    console.error('[initServer] - initDefaulUser -  Ошибка проверки пользователя по умолчанию:', error.message);
    throw error;
  }
};

// const initDefaulUser = async () => {
//   logger.logDevMessage(`[initServer] - initDefaulUser - Проверка наличия пользователя по умолчанию...`);

//   const defaultUsername = process.env.DEFAULT_USER_NAME || 'poddy';
//   const defaultPassword = process.env.DEFAULT_USER_PASSWORD || 'poddyPASS';
//   const defaultLevel = parseInt(process.env.DEFAULT_USER_LEVEL) || 3;
//   const defaultDID = process.env.DEFAULT_USER_DID || 'poddy_base';
//   const defaultSourceName = process.env.DEFAULT_USER_SOURCE || 'PoddyBase';

//   if (!defaultUsername || !defaultPassword || !defaultDID) {
//     logger.logErrorMessage(`[initServer] - Не хватает переменных окружения для создания пользователя по умолчанию`);
//     return;
//   }

//   try {
//     // 1. Проверяем, существует ли пользователь
//     let user = await DBManager.findUser(defaultUsername);
//     if (user) {
//       logger.logDevMessage(`[initServer] - Пользователь ${defaultUsername} уже существует.`);
//       console.log(`[initServer] - Пользователь ${defaultUsername} уже существует.`);
//       // При желании можно обновить userlevel/dID, если они изменились в .env
//       return;
//     }

//     // 2. Создаём пользователя
//     const hashedPassword = bcrypt.hashSync(defaultPassword, 8);
//     const insertUserResult = await DBManager.query(
//       `INSERT INTO users (username, password, userlevel, "dID") 
//        VALUES ($1, $2, $3, $4) 
//        RETURNING id`,
//       [defaultUsername, hashedPassword, defaultLevel, defaultDID],
//       authDB, dbUser, dbPass
//     );
//     const userId = insertUserResult.rows[0].id;
//     logger.logInfoMessage(`[initServer] - Создан пользователь ${defaultUsername} (id: ${userId})`);
//     console.log(`[initServer] - Создан пользователь ${defaultUsername} (id: ${userId})`);

//     // 3. Проверяем / создаём запись в datasources
//     let dsResult = await DBManager.query(
//       `SELECT id FROM datasources WHERE "dID" = $1`,
//       [defaultDID],
//       authDB, dbUser, dbPass
//     );
//     let dataSourceId;
//     if (dsResult.rows.length === 0) {
//       const insertDs = await DBManager.query(
//         `INSERT INTO datasources ("dID", name, description) 
//          VALUES ($1, $2, $3) 
//          RETURNING id`,
//         [defaultDID, defaultSourceName, `Auto-created for ${defaultUsername}`],
//         authDB, dbUser, dbPass
//       );
//       dataSourceId = insertDs.rows[0].id;
//       logger.logInfoMessage(`[initServer] - Создан источник данных ${defaultDID}`);
//       console.log(`[initServer] - Создан источник данных ${defaultDID}`);
//     } else {
//       dataSourceId = dsResult.rows[0].id;
//     }

//     // 4. Связь пользователь-источник
//     await DBManager.query(
//       `INSERT INTO userdatasources (user_id, data_source_id) 
//        VALUES ($1, $2) 
//        ON CONFLICT DO NOTHING`,
//       [userId, dataSourceId],
//       authDB, dbUser, dbPass
//     );

//     // 5. Права доступа
//     await DBManager.query(
//       `INSERT INTO permissions (user_id, data_source_id, permission_level) 
//        VALUES ($1, $2, $3) 
//        ON CONFLICT DO NOTHING`,
//       [userId, dataSourceId, defaultLevel],
//       authDB, dbUser, dbPass
//     );

//     logger.logInfoMessage(`[initServer] - Пользователь по умолчанию "${defaultUsername}" успешно создан со всеми связями.`);
//     console.log(`[initServer] - Пользователь по умолчанию "${defaultUsername}" успешно создан со всеми связями.`);

//   } catch (error) {
//     logger.logErrorMessage(`[initServer] - Ошибка при создании пользователя по умолчанию: ${error.message}`);
//     console.log(`[initServer] - Ошибка при создании пользователя по умолчанию: ${error.message}`);
//     // Не бросаем ошибку дальше, чтобы сервер мог запуститься, даже если что-то пошло не так
//   }
// };

const initDB_dID = async () => {
  logger.logDevMessage(`[initServer] - initDB_dID - Проверка наличия базы данных пользователя...`);
  
  try {
    const envName = process.env.DEFAULT_USER_DID;
    console.log('[initServer] - Проверка наличия базы данных пользователя...', envName);
    if (!envName) {
      throw new Error('DEFAULT_USER_DID не задан в переменных окружения');
    }
    
    await DBManager.query('SELECT NOW()', [], envName, dbUser, dbPass);
    logger.logDevMessage(`[initServer] - База данных "${envName}" доступна`);
    console.log(`[initServer] - База данных "${envName}" доступна`);
    
  } catch (error) {
    logger.logErrorMessage(`[initServer] - Ошибка доступа к базе данных пользователя: ${error.message}`);
    console.error('[initServer] - Ошибка доступа к базе данных пользователя:', error.message);
    throw error;
  }
};


module.exports = {
  initServer,
  initUsers,
  initDefaulUser,
  initDB_dID
};