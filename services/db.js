const { Pool } = require('pg');
const dotenv = require('dotenv');
dotenv.config({ path: './conf.env' });

class DBManager {
  constructor() {
    this.pools = {}; // Хранилище пулов для разных баз данных
    this.dbUser = process.env.DB_USER || 'root';
    this.dbPass = process.env.DB_PASSWORD || 'poddyPASS';
    this.dbName = process.env.DB_DATABASE || 'spring';
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
    const finalDbName = dbName || this.dbName;
    const finalDbUser = dbUser || this.dbUser;
    const finalDbPass = dbPass || this.dbPass;

    console.log(`Выполнение запроса для ${finalDbName}, ${finalDbUser}, ${finalDbPass}`);
    const pool = this.getPool(finalDbName, finalDbUser, finalDbPass);
    //const start = Date.now();
    try {
      const res = await pool.query(text, params);
      //const duration = Date.now() - start;
      //console.log(`Подключение к базе данных ${finalDbName} пользователь ${finalDbUser} выполнено за ${duration} мс`);
      //console.log(`Результат выполнения запроса - ${res}`);
      return res;
    } catch (error) {
      console.error('Ошибка при выполнении запроса:', error.message);
      throw error;
    }
  }

  // async query(text, params, dbName, dbUser, dbPass) {
  //   console.log (`Выполнение запроса для ${dbName}, ${dbUser}, ${dbPass}`);
  //   const pool = this.getPool(dbName || this.dbName, dbUser || this.dbUser, dbPass || this.dbPass);
  //   //console.log('Создан pool - ', pool);
  //   const start = Date.now();
  //   try {
  //     const res = await pool.query(text, params);
  //     const duration = Date.now() - start;
  //     console.log(`Подключение к базе данных ${dbName} пользователь ${dbUser} выполнено за ${duration} мс`);
  //     return res;
  //   } catch (error) {
  //     console.error('Ошибка при выполнении запроса:', error.message);
  //     throw error;
  //   }
  // }
}

module.exports = new DBManager(); // Экспортируем singleton