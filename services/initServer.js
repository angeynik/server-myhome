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
  //console.error('[initServer] - Ошибка в пуле соединений:', err);
});

const initServer = async () => {
  try {
    logger.logDevMessage(`[initServer] - Проверка подключения к базе данных...`);
    //console.log('[initServer] - Проверка подключения к базе данных...');
    await DBManager.query('SELECT NOW()', [], authDB, dbUser, dbPass);
    logger.logDevMessage(`[initServer] - Подключение к базе данных успешно установлено.`);
    //console.log('[initServer] - Подключение к базе данных успешно установлено.');
  } catch (error) {
    logger.logErrorMessage(`[initServer] - Критическая ошибка подключения к базе данных: ${error.message}`);
    //console.error('[initServer] - Критическая ошибка подключения к базе данных:', error.message);
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
    //console.log(`[initServer] - Таблица Users существует - ${usersTableExists}.`);
  } catch (error) {
    logger.logErrorMessage(`[initServer] - Ошибка проверки таблицы Users: ${error.message}`);
    //console.error('[initServer] - Ошибка проверки таблицы Users:', error.message);
    throw error;
  }
};

const initDefaulUser = async () => {
  logger.logDevMessage(`[initServer] - initDefaulUser - Проверка наличия пользователя по умолчанию...`);
  //console.log('[initServer] - Проверка наличия пользователя по умолчанию...');
  try {
    const defaultUser = await DBManager.findUser(process.env.DEFAULT_USER_NAME);
    if (!defaultUser) {
      throw new Error(`Пользователь по умолчанию "${process.env.DEFAULT_USER_NAME}" отсутствует`);
    }
    logger.logDevMessage(`[initServer] - Пользователь по умолчанию - ${process.env.DEFAULT_USER_NAME} - отсутствует`);
    //console.log(`[initServer] - Пользователь ${process.env.DEFAULT_USER_NAME} найден`);
  } catch (error) {
    logger.logErrorMessage(`[initServer] - Ошибка проверки пользователя по умолчанию: ${error.message}`);
    //console.error('[initServer] - Ошибка проверки пользователя по умолчанию:', error.message);
    throw error;
  }
};

const initDB_dID = async () => {
  logger.logDevMessage(`[initServer] - initDB_dID - Проверка наличия базы данных пользователя...`);
  //console.log('[initServer] - Проверка наличия базы данных пользователя...');
  try {
    const envName = process.env.DEFAULT_USER_DID;
    if (!envName) {
      throw new Error('DEFAULT_USER_DID не задан в переменных окружения');
    }
    
    await DBManager.query('SELECT NOW()', [], envName, dbUser, dbPass);
    logger.logDevMessage(`[initServer] - База данных "${envName}" доступна`);
    //console.log(`[initServer] - База данных "${envName}" доступна`);
    
  } catch (error) {
    logger.logErrorMessage(`[initServer] - Ошибка доступа к базе данных пользователя: ${error.message}`);
    //console.error('[initServer] - Ошибка доступа к базе данных пользователя:', error.message);
    throw error;
  }
};


module.exports = {
  initServer,
  initUsers,
  initDefaulUser,
  initDB_dID
};