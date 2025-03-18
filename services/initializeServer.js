const { query, pool, setDatabase  } = require('../db');
const dotenv = require('dotenv');
dotenv.config({ path: './conf.env' });

const queryRetries = async (text, params = [], retries = parseInt(process.env.DB_RECONECT_ATTEMPT || '3', 10)) => {
    if (isNaN(retries) || retries <= 0) {
      throw new Error('Некорректное значение DB_RECONECT_ATTEMPT в переменной окружения.');
    }
  
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const result = await pool.query(text, params); // Выполняем запрос
        return result; // Если запрос успешен, возвращаем результат
      } catch (error) {
        console.error(`Попытка ${attempt} завершилась неудачей:`, error.message);
  
        // Если достигли последней попытки, выбрасываем ошибку
        if (attempt === retries) {
          console.error('Все попытки выполнения запроса исчерпаны.');
          throw error;
        }
  
        // Задержка между попытками (увеличивается с каждой попыткой)
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
  };
  

class InitDB {
  constructor(dbName, dbUser, dbPass, defaultUser, defaultPass) {
    this.dbName = dbName || process.env.DB_DATABASE;
    this.dbUser = dbUser || process.env.DB_USER;
    this.dbPass = dbPass || process.env.DB_PASSWORD;
    this.defaultUser = defaultUser || process.env.DEFAULT_USER_NAME;
    this.defaultPass = defaultPass || process.env.DEFAULT_USER_PASSWORD;
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

  static async checkDB(dbName, dbUser, dbPass) {
    console.log ('InitServer - checkDB, dbName -', dbName, 'dbUser-', dbUser, 'dbPass-', dbPass);
    try {
      setDatabase('spring', dbUser, dbPass);
      const dbExists = await query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [dbName]
      );
      if (dbExists.rows.length === 0) {
        console.log(`База данных ${dbName} не существует. Создание новой базы данных...`);
        await this.createDB(dbName, dbUser, dbPass);
      } else {
        console.log(`База данных ${dbName} уже существует.`);
        return true;
      }
    } catch (error) {
      console.error('Ошибка при проверке базы данных:', error);
      throw error;
    }
  }

  static async createDB(dbName, dbUser, dbPass) {
    console.log ('InitServer - createDB');
    try {
      await queryRetries(`CREATE DATABASE "${dbName}"`);
      console.log(`База данных "${dbName}" создана успешно.`);
      await queryRetries(`CREATE USER ${dbUser} WITH PASSWORD '${dbPass}'`);
      await queryRetries(`ALTER DATABASE "${dbName}" OWNER TO ${dbUser}`);
      return `База данных "${dbName}" создана успешно.`;
    } catch (error) {
      console.error(`Ошибка при создании базы данных "${dbName}":`, error);
      return error;
    }
  }
  static async createTables(tables) {
    console.log ('InitServer - createTables');
    try {
      for (const table of tables) {
        await queryRetries(table);
      }
      console.log('Все таблицы успешно созданы.');
    } catch (error) {
      console.error('Ошибка при создании таблиц:', error);
      throw error;
    }
  }

  static async createTableAuth(dbName, dbUser, dbPass) {
    try {
      setDatabase(dbName, dbUser, dbPass);
      const tables = [
        this.tableUsers,
        this.tableDatasource,
        this.tablePermission,
        this.tableUserdatasource,
      ];
      await this.createTables(tables);
      console.log('Все таблицы для хранения учётных записей успешно созданы.');
    } catch (error) {
      console.error('Ошибка при создании таблиц учётных записей:', error);
      throw error;
    }
  }

  static async createTableDID(dbName, dbUser, dbPass) {
    try {
      setDatabase(dbName, dbUser, dbPass);
      const tables = [this.tableConfig, this.tableData];
      await this.createTables(tables);
      console.log('Все таблицы для хранения данных успешно созданы.');
    } catch (error) {
      console.error('Ошибка при создании таблиц хранения данных:', error);
      throw error;
    }
  }
}

module.exports = InitServer;
