const DBManager = require('./db'); // Импортируем DBManager
const InitDB = require('./initDB');
const initDB = new InitDB();
const uManage = require('./usersManage');

const bcrypt = require('bcryptjs');

const authDB = process.env.DB_DATABASE || 'spring'; // База данных по умолчанию
const dbUser = process.env.DB_USER;
const dbPass = process.env.DB_PASSWORD;

const DEFAULT_USER_NAME = process.env.DEFAULT_USER_NAME || 'admin';
const DEFAULT_USER_PASSWORD = process.env.DEFAULT_USER_PASSWORD || 'admin';
const DEFAULT_USER_LEVEL = parseInt(process.env.DEFAULT_USER_LEVEL) || 3;
const DEFAULT_USER_DID = process.env.DEFAULT_USER_DID || 'default_did';
const DEFAULT_USER_SOURCE = process.env.DEFAULT_USER_SOURCE || 'default_source';

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

      try {
        // Подключаемся к системной базе данных (root)
        await DBManager.query('SELECT NOW()', [], 'root', 'root', 'poddyPASS');

        console.log(`Попытка создания базы данных ${authDB} ...`);
        await DBManager.query(`CREATE DATABASE "${authDB}"`, [], 'root', 'root', 'poddyPASS');
        console.log(`База данных "${authDB}" создана успешно.`);

        await DBManager.query(`ALTER DATABASE "${authDB}" OWNER TO "${dbUser}"`, [], 'root', 'root', 'poddyPASS');
        console.log(`Владелец базы данных "${authDB}" изменен на "${dbUser}".`);

        await DBManager.query(`GRANT ALL PRIVILEGES ON DATABASE "${authDB}" TO "${dbUser}"`, [], 'root', 'root', 'poddyPASS');
        console.log(`Права на базу данных "${authDB}" переданы пользователю "${dbUser}".`);
          // Подключаемся к новой базе данных "spring" для установки расширения "uuid-ossp"
        await DBManager.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`, [], authDB, dbUser, dbPass);
        console.log('Расширение "uuid-ossp" установлено в базе данных "spring".');

      } catch (createError) {
        console.error('Ошибка при создании базы данных:', createError.message);
        throw createError;
      } finally {
        // Возвращаем подключение к новой базе данных
        console.log(`Успешное подключение к базе данных ${authDB} ...`);
      }
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

  // Проверка наличия таблиц и пользователя по умолчанию
  try {
    // Проверяем существование таблицы Users
    const usersTableExists = await initDB.checkTableExists('users');
    if (!usersTableExists) {
      console.log('Таблица Users отсутствует, создаем ее...');
      await initDB.createTableAuth(); // Создаем таблицы
      console.log(`Таблицы для хранения учётных записей базы ${authDB} созданы успешно.`);
    } else {
      console.log(`Таблица Users существует - ${usersTableExists}.`);
    }

      // Проверяем наличие пользователя по умолчанию
      const defaultUser = await uManage.findUser(DEFAULT_USER_NAME, authDB, dbUser, dbPass);
      if (!defaultUser) {
        console.log('Пользователь по умолчанию отсутствует, создаем его...');
        await uManage.registerUser(
          DEFAULT_USER_NAME,
          DEFAULT_USER_PASSWORD,
          DEFAULT_USER_LEVEL,
          DEFAULT_USER_DID,
          DEFAULT_USER_SOURCE,
          authDB, dbUser, dbPass
        );
        console.log('Пользователь по умолчанию создан успешно.');
    }
  } catch (error) {
    console.error('Ошибка при проверке таблиц и пользователя:', error.message);
    throw error;
  }

  console.log('Инициализация сервера завершена успешно.');
};

module.exports = initServer;










// const InitDB = require('./initDB');
// const initDB = new InitDB();
// const { query, setDatabase, closeConnection, pool, basePool} = require('./db');
// const uManage = require('./usersManage');

// const bcrypt = require('bcryptjs');

// const authDB = process.env.DB_DATABASE || 'spring'; // База данных по умолчанию
// const dbUser = process.env.DB_USER;
// const dbPass = process.env.DB_PASSWORD;

// const DEFAULT_USER_NAME = process.env.DEFAULT_USER_NAME || 'admin';
// const DEFAULT_USER_PASSWORD = process.env.DEFAULT_USER_PASSWORD || 'admin';
// const DEFAULT_USER_LEVEL = parseInt(process.env.DEFAULT_USER_LEVEL) || 3;
// const DEFAULT_USER_DID = process.env.DEFAULT_USER_DID || 'default_did';
// const DEFAULT_USER_SOURCE = process.env.DEFAULT_USER_SOURCE || 'default_source';

// // Обработка событий пула соединений
// // Подключаемся и отслеживаем события клиента
// // basePool.connect((err, client, release) => {
// //   if (err) {
// //     console.error('Ошибка подключения:', err.message);
// //     return;
// //   }

// //   console.log('basePool.connect( - Установлено новое подключение к базе данных.');

// //   // Ловим ошибки клиента
// //   client.on('error', (clientErr) => {
// //     console.error('Ошибка клиента:', clientErr.message);
// //   });

// //   release(); // Освобождаем соединение обратно в пул
// // });

// basePool.on('error', (err) => {
//   console.error('Ошибка в пуле соединений:', err);
// });

// const initServer = async () => {
//   try {
//     // Попытка подключения к базе данных по умолчанию
//     console.log('Попытка подключения к базе данных по умолчанию...');
//     await query('SELECT NOW()');
//     console.log('Подключение к базе данных успешно установлено.');
//   } catch (error) {
//     console.error('Ошибка подключения к базе данных:', error.message);

//     if (error.message.includes('database "' + authDB + '" does not exist')) {
//       // Если база данных не существует, создаем ее
//       console.log(`База данных "${authDB}" не существует, создаем новую...`);
//       console.log(`Подключаемся к системной Базе данных root ... Для создание базы ${authDB}...`);
//       await setDatabase('root', 'root', 'poddyPASS'); // Подключаемся к системной базе данных
//       try {
//         console.log(`Попытка создания базы данных ${authDB} ...`);
//         await query(`CREATE DATABASE "${authDB}"`);
//         console.log(`База данных "${authDB}" создана успешно.`);
//         await query(`ALTER DATABASE "${authDB}" OWNER TO "${dbUser}"`);
//         console.log(`Владелец базы данных "${authDB}" изменен на "${dbUser}".`);
//         await query(`GRANT ALL PRIVILEGES ON DATABASE "${authDB}" TO "${dbUser}"`);
//         console.log(`Права на базу данных "${authDB}" переданы пользователю "${dbUser}".`);

//         // try {
//         //     await initDB.UUID();
//         //     console.log('Расширение "uuid-ossp" установлено.');
//         //   } catch (uuidError) {
//         //     console.error('Ошибка при установке расширения "uuid-ossp":', uuidError.message);
//         //   }
          

//       } catch (createError) {
//         console.error('Ошибка при создании базы данных:', createError.message);
//         throw createError;
//       } finally {
//         await setDatabase(authDB, dbUser, dbPass); // Возвращаем подключение к новой базе данных
//         console.log(`Успешное подключение к базе данных ${authDB} ...`);
//       }
//     } else if (error.message.includes('password authentication failed')) {
//       // Если ошибка в пароле, используем root для создания пользователя или смены пароля
//       console.log('Ошибка аутентификации, создаем пользователя или меняем пароль...');
//       console.log(`Подключаемся к системной Базе данных root ... Для смены пароля...`);
//       await setDatabase('root', 'root', 'poddyPASS'); // Подключаемся к системной базе данных
//       try {
//         await query(`CREATE USER "${dbUser}" WITH PASSWORD '${dbPass}'`);
//         console.log(`Пользователь "${dbUser}" создан успешно.`);
//       } catch (userError) {
//         if (userError.message.includes('already exists')) {
//           console.log('Пользователь уже существует, меняем пароль...');
//           await query(`ALTER USER "${dbUser}" WITH PASSWORD '${dbPass}'`);
//           console.log(`Пароль для пользователя "${dbUser}" изменен успешно.`);
//         } else {
//           console.error('Ошибка при создании пользователя:', userError.message);
//           throw userError;
//         }
//       } finally {
//         // await setDatabase(authDB, dbUser, dbPass); 
//         // Возвращаем подключение к основной базе данных
//         basePool.on('error', (err) => {
//           console.error('Ошибка в пуле соединений:', err);
//         });
//         await initDB.UUID();
//       }
//     } else {
//       throw error;
//     }

//     // Повторная попытка подключения после создания базы данных или пользователя
//     // await query('SELECT NOW()');
//     console.log('Подключение к базе данных c ENV успешно установлено после инициализации.');
//   }
//   // Проверка наличия таблиц и пользователя по умолчанию
//   try {
//     // Проверяем существование таблицы Users
//     const usersTableExists = await initDB.checkTableExists('Users');
//     if (!usersTableExists) {
//       console.log('Таблица Users отсутствует, создаем ее...');
//       await initDB.createTableAuth(); // Создаем таблицы
//       console.log( `Таблицы для хранения учётных записей базы ${authDB} созданы успешно.`);
//     }

//     // Проверяем наличие пользователя по умолчанию
//     const defaultUser = await uManage.findUser(DEFAULT_USER_NAME);
//     if (!defaultUser) {
//       console.log('Пользователь по умолчанию отсутствует, создаем его...');
//       const hashedPassword = await bcrypt.hash(DEFAULT_USER_PASSWORD, 10); // Хешируем пароль
//       await uManage.registerUser(
//         DEFAULT_USER_NAME,
//         hashedPassword,
//         DEFAULT_USER_LEVEL,
//         DEFAULT_USER_DID,
//         DEFAULT_USER_SOURCE
//       );
//       console.log('Пользователь по умолчанию создан успешно.');
//     }
//   } catch (error) {
//     console.error('Ошибка при проверке таблиц и пользователя:', error.message);
//     throw error;
//   }

//   console.log('Инициализация сервера завершена успешно.');
// };


// module.exports = initServer;






///




