// Действия при инициализации Пользователя по умолчанию, проверка ДБ и таблиц
const DBManager = require('./db'); // Импортируем DBManager
const dotenv = require('dotenv');
dotenv.config({ path: './conf.env' });
//const bcrypt = require('bcryptjs');
const tableDB = require('./tableDB.js');

const authDB = process.env.DB_DATABASE || 'spring'; // База данных по умолчанию
const dbUser = process.env.DB_USER;
const dbPass = process.env.DB_PASSWORD;

// Обработка событий пула соединений
DBManager.getPool(authDB, dbUser, dbPass).on('error', (err) => {
  console.error('[initServer] - Ошибка в пуле соединений:', err);
});

const initServer = async () => {
  try {
    // Попытка подключения к базе данных по умолчанию
    console.log('[initServer] - Попытка подключения к базе данных по умолчанию...');
    await DBManager.query('SELECT NOW()', [], authDB, dbUser, dbPass);
    console.log('[initServer] - Подключение к базе данных успешно установлено.');
  } catch (error) {
    console.error('[initServer] - Ошибка подключения к базе данных:', error.message);

    if (error.message.includes('database "' + authDB + '" does not exist')) {
      // Если база данных не существует, создаем ее
      console.log(`[initServer] - База данных "${authDB}" не существует, создаем новую...`);
      console.log(`[initServer] - Подключаемся к системной Базе данных root ... Для создания базы ${authDB}...`);
      
      //Подключаемся к системной базе данных (root)
      await DBManager.query('SELECT NOW()', [], 'root', dbUser, dbPass);
      await DBManager.createDB(authDB, 'root', 'root', 'poddyPASS');
    } else if (error.message.includes('password authentication failed')) {
      // Если ошибка в пароле, используем root для создания пользователя или смены пароля
      console.log('[initServer] - Ошибка аутентификации, создаем пользователя или меняем пароль...');
      console.log(`[initServer] - Подключаемся к системной Базе данных root ... Для смены пароля...`);

      try {
        await DBManager.query(`CREATE USER "${dbUser}" WITH PASSWORD '${dbPass}'`, [], 'root', 'root', 'poddyPASS');
        console.log(`[initServer] - Пользователь "${dbUser}" создан успешно.`);

      } catch (userError) {
        if (userError.message.includes('already exists')) {
          console.log('[initServer] - Пользователь уже существует, меняем пароль...');
          await DBManager.query(`ALTER USER "${dbUser}" WITH PASSWORD '${dbPass}'`, [], 'root', 'root', 'poddyPASS');
          console.log(`[initServer] - Пароль для пользователя "${dbUser}" изменен успешно.`);
        } else {
          console.error('[initServer] - Ошибка при создании пользователя:', userError.message);
          throw userError;
        }
      } 
    } else {
      throw error;
    }
  }

  console.log('[initServer] - Инициализация базы данных сервера завершена успешно.');
};
const initUsers = async () => {
  try {
    const usersTableExists = await DBManager.checkTableExists('users');
    if (!usersTableExists) {
      console.log('[initServer] - Таблица Users отсутствует, создаем ее...');
      await DBManager.createTableAuth();
      console.log(`[initServer] - Таблицы для хранения учётных записей базы созданы успешно.`);
    } else {
      console.log(`[initServer] - Таблица Users существует - ${usersTableExists}.`);
    }
  } catch (error) {
    console.error('[initServer] - Ошибка подключения к базе данных:', error.message);
    throw error;
  }
};
const initDefaulUser = async () => {
  console.log('[initServer] - initDefaulUser - Проверка наличия пользователя по умолчанию...');
  try {
    // Проверяем наличие пользователя по умолчанию
      const defaultUser = await tableDB.findUser(process.env.DEFAULT_USER_NAME);
      console.log (`[initServer] - Результат поиска пользователя ${process.env.DEFAULT_USER_NAME} -  ${defaultUser}`);
      if (!defaultUser) {
        console.log(`[initServer] - Пользователь по умолчанию - ${process.env.DEFAULT_USER_NAME} - отсутствует, создаем его...`);
        await tableDB.registerUser(
          process.env.DEFAULT_USER_NAME,
          process.env.DEFAULT_USER_PASSWORD,
          process.env.DEFAULT_USER_LEVEL,
          process.env.DEFAULT_USER_DID,
          process.env.DEFAULT_USER_SOURCE,
          process.env.DEFAULT_USER_SOURCE_DESCRIPTION,
          process.env.DEFAULT_USER_EMAIL,
          process.env.DB_DATABASE
        );
        console.log(`[initServer] - Пользователь ${process.env.DEFAULT_USER_NAME}  создан успешно.`);
        await DBManager.query('SELECT NOW()', [], process.env.DB_DATABASE, process.env.DB_USER, process.env.DB_PASSWORD);
        // await DBManager.createDB(process.env.DEFAULT_USER_DID, 'root', 'root', 'poddyPASS');

      }
  } catch (error) {
    console.error('[initServer] - Ошибка проверки пользователя по умолчанию ', error.message);
    throw error;  
  }
}
const initDB_dID = async () => {
  try {
        const envName = process.env.DEFAULT_USER_DID;
    if (envName) {
      try {
        const DBdID = await DBManager.query('SELECT NOW()', [], envName, 'root', 'root', 'poddyPASS');
        console.log(`[initServer] - База данных "${envName}" существует. Результат запроса:`, DBdID.rows[0]);
              // Проверяем существование таблиц
      const tablesExist = await DBManager.checkTableExists(envName);
      if (!tablesExist) {
        console.log(`[initServer] - Таблицы в базе "${envName}" отсутствуют. Создаем...`);
        await DBManager.createTableDID(envName);
        console.log(`[initServer] - Таблицы успешно созданы в базе "${envName}".`);
      } else {
        console.log(`[initServer] - База данных "${envName}" содержит таблицы.`);
      }
      } catch (error) {
        if (error.message.includes('database "' + envName + '" does not exist')) {
          console.log(`[initServer] - База данных "${envName}" не существует. Создаем новую базу данных...`);
          
          // Создаем базу данных
          await DBManager.createDB(envName, 'root', 'root', 'poddyPASS');
          console.log(`[initServer] - База данных "${envName}" успешно создана.`);

          // Создаем таблицы в новой базе данных
          console.log(`[initServer] - Создаем таблицы в базе данных (dID) "${envName}"...`);
          await DBManager.createTableDID(envName);
          console.log(`[initServer] - Таблицы в базе данных "${envName}" успешно созданы.`);
        } else {
          console.error('[initServer] - Ошибка при выполнении запроса:', error.message);
          throw error;
        }
      }
    } else {
      console.log(`[initServer] - Не удалось получить имя пользователя по умолчанию - ${envName}`);
    }
  } catch (error) {
    console.error('[initServer] - Ошибка базы данных пользователя:', envName, error.message);
    throw error;  
  }
}

module.exports = {
  initServer,
  initUsers,
  initDefaulUser,
  initDB_dID
};