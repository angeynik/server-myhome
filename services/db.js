const { Pool } = require('pg');

class DBManager {
  constructor() {
    this.pools = {}; // Хранилище пулов для разных баз данных
    this.dbUser = process.env.DB_USER;
    this.dbPass = process.env.DB_PASSWORD;
    this.dbName = process.env.DB_DATABASE;
  }

  // Создание или получение пула для конкретной базы данных
  getPool(dbName, dbUser, dbPass) {
    const key = `${dbName}-${dbUser}`; // Уникальный ключ для базы данных и пользователя

    if (!this.pools[key]) {
      // Если пул для этой базы данных еще не создан, создаем его
      this.pools[key] = new Pool({
        user: dbUser || this.dbUser,
        host: 'localhost',
        database: dbName || this.dbName,
        password: dbPass || this.dbPass,
        port: 5432,
      });

      console.log(`Создан новый пул для базы данных: ${dbName}`);
    }

    return this.pools[key];
  }

  // Завершение всех пулов
  async closeAllPools() {
    for (const key of Object.keys(this.pools)) {
      await this.pools[key].end();
      console.log(`Пул для ключа ${key} завершен.`);
    }
    this.pools = {};
  }

  // Завершение конкретного пула
  async closePool(dbName, dbUser) {
    const key = `${dbName}-${dbUser}`;
    if (this.pools[key]) {
      await this.pools[key].end();
      delete this.pools[key];
      console.log(`Пул для базы данных ${dbName} завершен.`);
    }
  }
  async query(text, params, dbName, dbUser, dbPass) {
    const pool = this.getPool(dbName, dbUser || this.dbUser, dbPass || this.dbPass);

    if (!pool) {
      throw new Error(`Пул для базы данных ${dbName} не был создан.`);
    }

    const start = Date.now();
    try {
      const res = await pool.query(text, params);
      const duration = Date.now() - start;
      console.log(`Подключение к базе данных ${dbName} пользователь ${dbUser} выполнено за ${duration} мс`);
      // console.log('Запрос выполнен:', { text, duration, rows: res.rowCount });
      return res;
    } catch (error) {
      console.error('Ошибка при выполнении запроса:', error.message);
      throw error;
    }
  }
}

module.exports = new DBManager(); // Экспортируем singleton












// // Начальные настройки подключения к базе данных
// const config = {
//   user: process.env.DB_USER,
//   host: process.env.DB_HOST || 'localhost',
//   database: process.env.DB_DATABASE || 'spring', // По умолчанию 'spring'
//   password: process.env.DB_PASSWORD,
//   port: process.env.DB_PORT || 5432,
// };

// // Создаем пул соединений с начальными настройками
// const basePool = new Pool(config);
// let pool = new Pool(config);
// const setDatabase = (databaseName, user, pass ) => {
//   if (pool) {
//     // Завершаем старый пул, если он существует
//     //console.log(`setDatabase - 1 - Pool ended, Завершаем старый пул, если он существует`);
//     pool.end();
//   }

//   // Пересоздаём новый пул соединений с указанием новой базы данных
//   console.log(`setDatabase - 2 - Создаем новый Pool соединений с указанием новой базы данных ${databaseName} пользователя ${user} и пароля ${pass}`);
//   pool = new Pool({
//     user: user, // Замените на ваше имя пользователя
//     host: 'localhost',
//     database: databaseName,
//     password: pass, // Замените на ваш пароль
//     port: 5432,
//   });
//    //console.log(`setDatabase - 3 - Pool создан`);
//   return pool;
// };

// // Функция для выполнения запросов

// const query = async (text, params, databaseName) => {
//   if (databaseName) {
//     setDatabase(databaseName);
//   }

//   const start = Date.now();
//   try {
//     const res = await pool.query(text, params);
//     const duration = Date.now() - start;
//     // console.log('Executed query:', { text, duration, rows: res.rowCount });
//     return res;
//   } catch (error) {
//     // Логируем ошибки только в продакшене
//     if (process.env.NODE_ENV === 'production') {
//       console.error('Error executing query:', error);
//     }
//     throw error;
//   }
// };

// const closeConnection = async () => {
//   try {
//     await pool.end();
//     console.log('Database connection closed.');
//   } catch (error) {
//     console.error('Error closing database connection:', error);
//   }
// };
// module.exports = { query, setDatabase, closeConnection, pool, basePool };