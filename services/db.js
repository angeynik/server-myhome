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
  tableUsers = `
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      uID UUID UNIQUE DEFAULT uuid_generate_v4(),
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      email TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  tableDatasource = `
    CREATE TABLE datasources (
      id SERIAL PRIMARY KEY,
      dID TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  tablePermission = `
    CREATE TABLE permissions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      data_source_id INTEGER REFERENCES datasources(id) ON DELETE CASCADE,
      permission_level INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  tableUserdatasource = `
    CREATE TABLE userdatasources (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      data_source_id INTEGER REFERENCES datasources(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  tableConfig = `
    CREATE TABLE config (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      file JSON NOT NULL,
      update_date TIMESTAMP NOT NULL
    );
  `;

  tableData = `
    CREATE TABLE data (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      room TEXT,
      location TEXT,
      actionStatus BOOLEAN NOT NULL,
      actionState BOOLEAN,
      actionSet BOOLEAN,
      dataStatus BOOLEAN NOT NULL,
      dataState NUMERIC,
      dataSet NUMERIC,
      create_date TIMESTAMP
    );
  `;
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
    const Name = dbName || this.dbName;
    const User = dbUser || this.dbUser;
    const Pass = dbPass || this.dbPass;

    console.log(`Выполнение запроса для ${Name}, ${User}, ${Pass}`);
    const pool = this.getPool(Name, User, Pass);
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
  async createDB (createDB, dbName, dbUser, dbPass) {
    console.log(`createDB - Создаем базу - ${createDB} Параметры подключения ${dbName} - ${dbUser}`);
    try {
      console.log(`Попытка создания базы данных ${createDB} ...`);
      await this.query(`CREATE DATABASE "${createDB}"`, [], dbName, dbUser, dbPass);
      console.log(`База данных "${createDB}" создана успешно.`);

      await this.query(`ALTER DATABASE "${createDB}" OWNER TO "${dbUser}"`, [], 'root', 'root', 'poddyPASS');
      console.log(`Владелец базы данных "${createDB}" изменен на "${dbUser}".`);

      await this.query(`GRANT ALL PRIVILEGES ON DATABASE "${createDB}" TO "${dbUser}"`, [], 'root', 'root', 'poddyPASS');
      console.log(`Права на базу данных "${createDB}" переданы пользователю "${dbUser}".`);
        // Подключаемся к новой базе данных "spring" для установки расширения "uuid-ossp"
      await this.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`, [], createDB, dbUser, dbPass);
      console.log(`Расширение "uuid-ossp" установлено в базе данных ${createDB}.`);

    } catch (createError) {
      console.error('Ошибка при создании базы данных:', createError.message);
      throw createError;
  }
  }
  async createTableAuth() {
    try {
      const tablesToCreate = [];
      const tables = [
        { name: 'users', sql: this.tableUsers },
        { name: 'datasources', sql: this.tableDatasource },
        { name: 'permissions', sql: this.tablePermission },
        { name: 'userdatasources', sql: this.tableUserdatasource },
      ];
  
      // Проверяем существование каждой таблицы
      for (const table of tables) {
        const tableExists = await this.checkTableExists(table.name);
        if (!tableExists) {
          tablesToCreate.push(table.sql); // Добавляем SQL для создания таблицы
        } else {
          console.log(`Таблица ${table.name} уже существует, пропускаем создание.`);
        }
      }
  
      // Создаем только те таблицы, которые отсутствуют
      if (tablesToCreate.length > 0) {
        await this.createTables(tablesToCreate);
        console.log('Все таблицы для хранения учётных записей успешно созданы.');
      } else {
        console.log('Все таблицы уже существуют, создание не требуется.');
      }
    } catch (error) {
      console.error('Ошибка при создании таблиц учётных записей:', error);
      throw error;
    }
  }

  async createTableDID(dbName, dbUser, dbPass) {
    try {
      const tables = [this.tableConfig, this.tableData];
      for (const table of tables) {
        await this.query(table, [], dbName, dbUser, dbPass);
      }
      console.log(`Все таблицы для хранения данных успешно созданы в базе "${dbName}".`);
    } catch (error) {
      console.error('Ошибка при создании таблиц хранения данных:', error);
      throw error;
    }
  }
  async createTables(tables) {
    try {
      for (const table of tables) {
        await this.query(table, [], this.dbName, this.dbUser, this.dbPass);
      }
      console.log('Все таблицы успешно созданы.');
    } catch (error) {
      console.error('Ошибка при создании таблиц:', error);
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