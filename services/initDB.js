// checkDB(dbCheck, dbName, dbUser, dbPass)  - Проверка на существование запрашиваемой БД
      //dbCheck - проверяемая БД (обязательный параметр) Если отсутствует то проверяет dbName
      //Параметры подключения к БД: dbName - имя базы dbUser - имя пользователя dbPass - пароль

// createDB(dbName) - Создание БД с именем dbName и назначение владельцем - пользователя подключения

// 
const DBManager = require('./db'); // Импортируем DBManager
const dotenv = require('dotenv');
dotenv.config({ path: './conf.env' });

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

  async createDBUser(dbUser, dbPass) {
    try {
      await DBManager.query(`CREATE USER ${dbUser} WITH PASSWORD '${dbPass}'`, [], 'postgres', 'root', 'poddyPASS');
      return { result: true, message: `Пользователь ${dbUser} успешно создан` };
    } catch (error) {
      return { result: false, message: `Ошибка при создании пользователя ${dbUser}: ${error.message}` };
    }
  }

  async changeDBUserPass(dbUser, dbPass) {
    try {
      await DBManager.query(`ALTER USER ${dbUser} WITH PASSWORD '${dbPass}'`, [], 'postgres', 'root', 'poddyPASS');
      return { result: true, message: `Пароль для пользователя ${dbUser} успешно изменен` };
    } catch (error) {
      return { result: false, message: `Ошибка при смене пароля пользователя ${dbUser}: ${error.message}` };
    }
  }

  async checkDB(dbCheck, dbName, dbUser, dbPass) {
    const databaseName = dbName || this.dbName;
    const databaseUser = dbUser || this.dbUser;
    const databasePass = dbPass || this.dbPass;
    const db = dbCheck !== undefined ? dbCheck : databaseName;

    console.log('Проверяем существование базы', db, 'под пользователем', databaseUser);

    try {
      const dbExists = await DBManager.query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [db],
        'postgres', // Используем системную базу данных для проверки
        databaseUser,
        databasePass
      );

      if (dbExists.rows.length === 0) {
        console.log(`База данных ${db} не существует.`);
        return { result: true, message: 'База данных НЕ существует' };
      } else {
        console.log(`База данных ${db} уже существует.`);
        return { result: false, message: 'База данных уже существует.' };
      }
    } catch (error) {
      console.error('Ошибка при проверке базы данных:', error);
      if (error.code === '28000' && error.message.includes('role')) {
        return { result: false, message: `Пользователь ${databaseUser} отсутствует в базе Postgres. Создайте пользователя!` };
      }
      return { result: false, message: `Ошибка при проверке базы данных: ${error.message}` };
    }
  }

  async checkTableExists(table) {
    try {
      const result = await DBManager.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public'
          AND table_name = $1
        );`,
        [table],
        this.dbName,
        this.dbUser,
        this.dbPass
      );
      return result.rows[0].exists; // true, если таблица существует
    } catch (error) {
      console.error('Ошибка при проверке существования таблицы:', error.message);
      throw error;
    }
  }

  async createDB(dbCreate, dbName, dbUser, dbPass) {
    const databaseName = dbName || this.dbName;
    const databaseUser = dbUser || this.dbUser;
    const databasePass = dbPass || this.dbPass;

    const check = await this.checkDB(dbCreate, databaseName, databaseUser, databasePass);
    if (check.result) {
      try {
        await DBManager.query(`CREATE DATABASE "${dbCreate}"`, [], 'postgres', 'root', 'poddyPASS');
        console.log(`База данных "${dbCreate}" создана успешно.`);

        await DBManager.query(`ALTER DATABASE "${dbCreate}" OWNER TO "${databaseUser}"`, [], 'postgres', 'root', 'poddyPASS');
        console.log(`Владелец базы данных "${dbCreate}" изменен на "${databaseUser}".`);

        return { result: true, message: `База данных "${dbCreate}" создана успешно.` };
      } catch (error) {
        console.error(`Ошибка при создании базы данных "${dbCreate}":`, error);
        return { result: false, message: `Ошибка при создании базы данных "${dbCreate}": ${error.message}` };
      }
    } else {
      return { result: false, message: check.message };
    }
  }

  async createTables(tables) {
    try {
      for (const table of tables) {
        await DBManager.query(table, [], this.dbName, this.dbUser, this.dbPass);
      }
      console.log('Все таблицы успешно созданы.');
    } catch (error) {
      console.error('Ошибка при создании таблиц:', error);
      throw error;
    }
  }

  // async createTableAuth() {
  //   try {
  //     const tables = [
  //       this.tableUsers,
  //       this.tableDatasource,
  //       this.tablePermission,
  //       this.tableUserdatasource,
  //     ];
  //     await this.createTables(tables);
  //     console.log('Все таблицы для хранения учётных записей успешно созданы.');
  //   } catch (error) {
  //     console.error('Ошибка при создании таблиц учётных записей:', error);
  //     throw error;
  //   }
  // }

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
      await this.createTables(tables);
      console.log('Все таблицы для хранения данных успешно созданы.');
    } catch (error) {
      console.error('Ошибка при создании таблиц хранения данных:', error);
      throw error;
    }
  }
}

module.exports = InitDB;