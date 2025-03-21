const DBManager = require('./db'); // Импортируем DBManager
const dotenv = require('dotenv');
dotenv.config({ path: './conf.env' });
const bcrypt = require('bcryptjs');

const authDB = process.env.DB_DATABASE || 'spring'; // База данных по умолчанию
const dbUser = process.env.DB_USER;
const dbPass = process.env.DB_PASSWORD;

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
      } 
    } else {
      throw error;
    }
  }

  console.log('Инициализация базы данных сервера завершена успешно.');
};

module.exports = initServer;