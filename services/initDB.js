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

  async checkDB(dbName, dbUser, dbPass) {
    // Проверяем корректность подключения и отсутствие запрашиваемой базы
    // TRUE - базы нет Учетная запись Postgres корректна
    // FALSE - база есть
    // FALSE - базы нет Учетная записть Postgres НЕ КОРРЕКТНА
  // Используем переданные параметры или значения из класса, если параметры не переданы
  const databaseName = dbName || this.dbName;
  const databaseUser = dbUser || this.dbUser;
  const databasePass = dbPass || this.dbPass;

  console.log('class InitDB Функция checkDB, dbName -', databaseName, 'dbUser -', databaseUser, 'dbPass -', databasePass);
    try {
      setDatabase(databaseName, databaseUser, databasePass);
      const dbExists = await query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [databaseName]
      );
      if (dbExists.rows.length === 0) {
        console.log(`База данных ${databaseName} не существует. Создание новой базы данных...`);
        return {result :true, message: 'База данных НЕ существует'};
      } else {
        console.log(`База данных - ${databaseName} - уже существует.`);
        return {result :false, message: 'База данных уже существует.'};
      }
    } catch (error) {
      console.error('Ошибка при проверке базы данных:', error);
      // Проверяем, связана ли ошибка с отсутствием пользователя
    if (error.code === '28000' && error.message.includes('role')) {
      return { result: false, message: `Пользователь ${databaseUser} отсутствует в базе Postgres. Создайте пользователя!` };
    }

    // Возвращаем общую ошибку, если это не связано с отсутствием пользователя
    return { result: false, message: `Ошибка при проверке базы данных: ${error.message}` };
  
    }
  }

  static async createDB(dbName) {
    // Проверяем существует ли база если нет то создаем новую с именем - dbName
    // вход в базу для создания выполняем под  this.dbPass this.dbUser 
    console.log ('InitServer - createDB');
    const check = await this.checkDB(dbName);
    if (check.result == true) {
        try {
          await queryRetries(`CREATE DATABASE "${dbName}"`);
          console.log(`База данных "${dbName}" создана успешно.`);
          // await queryRetries(`CREATE USER ${dbUser} WITH PASSWORD '${dbPass}'`);
          // await queryRetries(`ALTER DATABASE "${dbName}" OWNER TO ${dbUser}`);
          return {result :true, message: `База данных "${dbName}" создана успешно.`};
        } catch (error) {
          console.error(`Ошибка при создании базы данных "${dbName}":`, error);
          return { result: false, message: `Ошибка при создании базы данных "${dbName}" : ${error.message}` };
        }
      } else {
        return { result: false, message: check.message}
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

module.exports = InitDB;
