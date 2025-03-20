const DBManager = require('./db'); // Импортируем DBManager
const dotenv = require('dotenv');
dotenv.config({ path: './conf.env' });
const bcrypt = require('bcryptjs');

const authDB = process.env.DB_DATABASE || 'spring'; // База данных по умолчанию
const dbUser = process.env.DB_USER;
const dbPass = process.env.DB_PASSWORD;

const DEFAULT_USER_NAME = process.env.DEFAULT_USER_NAME ;
const DEFAULT_USER_PASSWORD = process.env.DEFAULT_USER_PASSWORD;
const DEFAULT_USER_LEVEL = parseInt(process.env.DEFAULT_USER_LEVEL) || 3;
const DEFAULT_USER_DID = process.env.DEFAULT_USER_DID;
const DEFAULT_USER_SOURCE = process.env.DEFAULT_USER_SOURCE;

// Обработка событий пула соединений
DBManager.getPool(authDB, dbUser, dbPass).on('error', (err) => {
  console.error('Ошибка в пуле соединений:', err);
});

const initServer = async () => {
  try {
    // Попытка подключения к базе данных по умолчанию
    console.log('Попытка подключения к базе данных по умолчанию...');
    await DBManager.query('SELECT NOW()', [], authDB, dbUser, dbPass);
    console.log('Подключение к базе данных успешно установлено.');
  } catch (error) {
    console.error('Ошибка подключения к базе данных:', error.message);

    if (error.message.includes('database "' + authDB + '" does not exist')) {
      // Если база данных не существует, создаем ее
      console.log(`База данных "${authDB}" не существует, создаем новую...`);
      console.log(`Подключаемся к системной Базе данных root ... Для создания базы ${authDB}...`);



      //Подключаемся к системной базе данных (root)
      await DBManager.query('SELECT NOW()', [], 'root', dbUser, dbPass);
      await DBManager.createDB(authDB, 'root', 'root', 'poddyPASS');


      // try {
      //   // Подключаемся к системной базе данных (root)
      //   await DBManager.query('SELECT NOW()', [], 'root', 'root', 'poddyPASS');

      //   console.log(`Попытка создания базы данных ${authDB} ...`);
      //   await DBManager.query(`CREATE DATABASE "${authDB}"`, [], 'root', 'root', 'poddyPASS');
      //   console.log(`База данных "${authDB}" создана успешно.`);

      //   await DBManager.query(`ALTER DATABASE "${authDB}" OWNER TO "${dbUser}"`, [], 'root', 'root', 'poddyPASS');
      //   console.log(`Владелец базы данных "${authDB}" изменен на "${dbUser}".`);

      //   await DBManager.query(`GRANT ALL PRIVILEGES ON DATABASE "${authDB}" TO "${dbUser}"`, [], 'root', 'root', 'poddyPASS');
      //   console.log(`Права на базу данных "${authDB}" переданы пользователю "${dbUser}".`);
      //     // Подключаемся к новой базе данных "spring" для установки расширения "uuid-ossp"
      //   await DBManager.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`, [], authDB, dbUser, dbPass);
      //   console.log('Расширение "uuid-ossp" установлено в базе данных "spring".');

      // } catch (createError) {
      //   console.error('Ошибка при создании базы данных:', createError.message);
      //   throw createError;
      // } finally {
      //   // Возвращаем подключение к новой базе данных
      //   console.log(`Успешное подключение к базе данных ${authDB} ...`);
      // }
    } else if (error.message.includes('password authentication failed')) {
      // Если ошибка в пароле, используем root для создания пользователя или смены пароля
      console.log('Ошибка аутентификации, создаем пользователя или меняем пароль...');
      console.log(`Подключаемся к системной Базе данных root ... Для смены пароля...`);

      try {
        await DBManager.query(`CREATE USER "${dbUser}" WITH PASSWORD '${dbPass}'`, [], 'root', 'root', 'poddyPASS');
        console.log(`Пользователь "${dbUser}" создан успешно.`);

      } catch (userError) {
        if (userError.message.includes('already exists')) {
          console.log('Пользователь уже существует, меняем пароль...');
          await DBManager.query(`ALTER USER "${dbUser}" WITH PASSWORD '${dbPass}'`, [], 'root', 'root', 'poddyPASS');
          console.log(`Пароль для пользователя "${dbUser}" изменен успешно.`);
        } else {
          console.error('Ошибка при создании пользователя:', userError.message);
          throw userError;
        }
      } finally {

      }
    } else {
      throw error;
    }
  }

  console.log('Инициализация базы данных сервера завершена успешно.');
};

module.exports = initServer;