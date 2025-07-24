// checkRecordExists - проверка существования запис
// Возвращает сообщение вида { exists: true, id: id записи } при успешной проверке 
// { exists: true, id: id записи } при НЕ успешной проверке 
// или ошибку

const { Pool } = require('pg');
const dotenv = require('dotenv');
dotenv.config({ path: './conf.env' });

class DBManager {
  constructor() {
    this.pools = {}; // Хранилище пулов для разных баз данных
    this.dbUser = process.env.DB_USER || 'root';
    this.dbPass = process.env.DB_PASSWORD || 'poddyPASS';
    this.dbName = process.env.DB_DATABASE || 'spring';
    this.dbPort = process.env.DB_PORT || 5432;
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
    name VARCHAR(32) NOT NULL,
    file JSON NOT NULL,
    update_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;
  tableFileType = `
    CREATE TABLE file_type (
        id VARCHAR(32) PRIMARY KEY,
        description VARCHAR(128) NOT NULL,
        extensions VARCHAR(128)
    );
    INSERT INTO file_type (id, description, extensions) VALUES
      ('txt', 'Текстовый файл', ''),
      ('doc', 'Doc файл', ''),
      ('pdf', 'PDF файл', ''),
      ('jpg', 'jpg файл', ''),
      ('png', 'png файл', ''),
      ('gif', 'gif файл', ''),
      ('mp4', 'mp4 файл', ''),
      ('avi', 'avi файл', ''),
      ('mov', 'mov файл', ''),
      ('raw', 'raw файл', '');
  `;
  tableSensorType = `
    CREATE TABLE sensor_type (
        id VARCHAR(16) PRIMARY KEY,
        title VARCHAR(128) NOT NULL,
        icon VARCHAR(32) NOT NULL,
        data_type VARCHAR(32) NOT NULL CHECK (data_type IN ('Number', 'boolean', 'String')),
        sign VARCHAR(16),
        value_true VARCHAR(32),
        value_false VARCHAR(32)
    );
    INSERT INTO sensor_type (id, title, icon, data_type, sign, value_true, value_false) VALUES
      ('Temp', 'Температура', 'thermostat', 'Number', '°C', NULL, NULL),
      ('Hum', 'Влажность', 'water', 'Number', '%', NULL, NULL),
      ('Mov', 'Движение', 'walk', 'boolean', 'on/off', 'ON', 'OFF'),
      ('Fire', 'Пожар', 'fire', 'boolean', 'on/off', 'Alarm', 'Norm'),
      ('Leak', 'Протечка', 'leakage', 'boolean', 'on/off', 'Alarm', 'Norm'),
      ('Switch', 'Розетка', 'switch', 'boolean', 'on/off', 'ON', 'OFF'),
      ('Dimm', 'Контроллер', 'dimmer', 'boolean', 'on/off', 'ON', 'OFF'),
      ('Pres', 'Давление', 'pressure', 'Number', 'hPa', NULL, NULL),
      ('Noise', 'Уровень шума', 'noise', 'Number', 'dB', NULL, NULL),
      ('Co2', 'CO2', 'co2', 'Number', 'ppm', NULL, NULL),
      ('Voc', 'VOC', 'voc', 'Number', 'ppb', NULL, NULL),
      ('Lum', 'Освещенность', 'brightness', 'Number', 'lux', NULL, NULL),
      ('Button', 'Кнопка', 'button', 'boolean', 'on/off', 'ON', 'OFF'),
      ('Relay', 'Реле', 'relay', 'boolean', 'on/off', 'ON', 'OFF'),
      ('Batery', 'Напряжение батареи', 'battery', 'Number', 'V', NULL, NULL),
      ('Power', 'Энергия', 'power', 'Number', 'kWh', NULL, NULL),
      ('Smoke', 'Дым', 'smoke', 'boolean', 'on/off', 'Alarm', 'Norm'),
      ('Unknown', 'Неизвестное', 'unknown', 'String', '?', NULL, NULL),
      ('Current', 'Ток', 'current', 'Number', 'A', NULL, NULL),
      ('Power_W', 'Мощность', 'power', 'Number', 'W', NULL, NULL),
      ('FlowRate', 'Скорость протока', 'flow', 'Number', 'л/мин', NULL, NULL),
      ('Volume', 'Объем жидкости', 'water', 'Number', 'л', NULL, NULL);
  `;
  tableActionStateType = `
    CREATE TABLE action_state_type (
        id VARCHAR(64) PRIMARY KEY,
        description VARCHAR(255) NOT NULL,
        category VARCHAR(64) NOT NULL
    );
    INSERT INTO action_state_type (id, description, category) VALUES
      ('temp_high', 'Температура выше нормы', 'temperature'),
      ('temp_low', 'Температура ниже нормы', 'temperature'),
      ('temp_normal', 'Температура в норме', 'temperature'),
      ('motion_detected', 'Обнаружено движение', 'motion'),
      ('motion_absent', 'Движение отсутствует', 'motion'),
      ('alarm_fire', 'Пожарная тревога', 'alarm'),
      ('alarm_flood', 'Протечка воды', 'alarm'),
      ('alarm_off', 'Тревога отключена', 'alarm'),
      ('set', 'Изменено', 'common'),
      ('high', 'Значение превышено', 'common'),
      ('low', 'Значение ниже допустимого', 'common'),
      ('enabled', 'Включено', 'common'),
      ('disabled', 'Выключено', 'common'),
      ('error', 'Ошибка', 'common');
  `;
  tableDataSensors = `
    CREATE TABLE data_sensors (
        id SERIAL PRIMARY KEY,
        type VARCHAR(20) NOT NULL REFERENCES sensor_type(id),
        name VARCHAR(64) UNIQUE NOT NULL,
        value_num DOUBLE PRECISION,
        value_bool BOOLEAN,
        value_str TEXT,
        room VARCHAR(64) NOT NULL,
        location VARCHAR(64) NOT NULL,
        create_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_value_type CHECK (
            (value_num IS NOT NULL AND value_bool IS NULL AND value_str IS NULL) OR
            (value_bool IS NOT NULL AND value_num IS NULL AND value_str IS NULL) OR
            (value_str IS NOT NULL AND value_num IS NULL AND value_bool IS NULL)
        )
    );
    CREATE INDEX idx_data_sensors_type ON data_sensors(type);
    CREATE INDEX idx_data_sensors_room_loc ON data_sensors(room, location);
  `;
  tableDataEvents = `
    CREATE TABLE data_events (
        id SERIAL PRIMARY KEY,
        type VARCHAR(32) NOT NULL REFERENCES sensor_type(id),
        name VARCHAR(255) UNIQUE NOT NULL,
        action_status VARCHAR(8) NOT NULL CHECK (action_status IN ('on', 'off')),
        action_state VARCHAR(64) REFERENCES action_state_type(id),
        data_status VARCHAR(8) NOT NULL CHECK (data_status IN ('on', 'off')),
        data_state DOUBLE PRECISION,
        file_type VARCHAR(32) REFERENCES file_type(id),
        file_name VARCHAR(255),
        file_link TEXT,
        create_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_data_consistency CHECK (
            (data_status = 'on' AND data_state IS NOT NULL) OR
            (data_status = 'off' AND data_state IS NULL)
        )
    );
    CREATE INDEX idx_data_events_type_date ON data_events(type, create_date);
    CREATE INDEX idx_data_events_action_state ON data_events(action_state);
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
        port: this.dbPort || 5432,
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
      //console.log(`[QUERY START] ${text}`);
      //console.log(`Параметры: ${JSON.stringify(params)}`);

    //console.log(`Выполнение запроса для ${Name}, ${User}, ${Pass}`);
    const pool = this.getPool(Name, User, Pass);
    //const start = Date.now();
    try {
      const res = await pool.query(text, params);
      //const duration = Date.now() - start;
      //console.log(`Подключение к базе данных ${finalDbName} пользователь ${finalDbUser} выполнено за ${duration} мс`);
      //console.log('Результат выполнения запроса:', JSON.stringify(res, null, 2));
  
      return res;
    } catch (error) {
      console.error('Ошибка при выполнении запроса:', error.message);
      throw error;
    }
  }

    // Проверка существования записи в таблице по условиям
    async checkRecordExists(tableName, param, dbName, dbUser, dbPass) {
      //console.log('Входим в checkRecordExists');
      if (Object.keys(param).length === 0) {
        throw new Error('Необходимо указать условия для проверки существования записи');
      }
    
      const whereClauses = [];
      const params = [];
      let paramIndex = 1;
    
      // Формируем условия WHERE
      for (const [column, value] of Object.entries(param)) {
        whereClauses.push(`${column} = $${paramIndex}`);
        params.push(value);
        paramIndex++;
      }
    
      const queryText = `
        SELECT id FROM ${tableName}
        WHERE ${whereClauses.join(' AND ')}
        LIMIT 1
      `;
      
      //console.log('checkRecordExists - Готовим запрос queryText', queryText);
      
      try {
        const result = await this.query(
          queryText, 
          params, 
          dbName, 
          dbUser, 
          dbPass
        );
    
        if (result.rows.length > 0) {
          console.log('checkRecordExists - Запись найдена, ID:', result.rows[0].id);
          return { 
            exists: true, 
            id: result.rows[0].id 
          };
        }
        
        //console.log('checkRecordExists - Запись не найдена');
        return { 
          exists: false, 
          id: null 
        };
    
      } catch (error) {
        console.error(`Ошибка проверки записи в таблице ${tableName}:`, error.message);
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
            const tableExists = await this.checkTableExists(table.name, this.dbName, this.dbUser, this.dbPass);
            if (!tableExists) {
              tablesToCreate.push(table.sql); // Добавляем SQL для создания таблицы
            } else {
              console.log(`Таблица ${table.name} уже существует в базе "${this.dbName}", пропускаем создание.`);
            }
          }
      
          // Создаем только те таблицы, которые отсутствуют
          if (tablesToCreate.length > 0) {
            await this.createTables(tablesToCreate, this.dbName, this.dbUser, this.dbPass);
            console.log('Все таблицы для хранения учётных записей успешно созданы.');
          } else {
            console.log('Все таблицы уже существуют, создание не требуется.');
          }
        } catch (error) {
          console.error('Ошибка при создании таблиц учётных записей:', error);
          throw error;
        }
      }

    async createTableDID(db) {
      const dbName = db || this.dbName;
        try {
          const tablesToCreate = [];
          const tables = [
            { name: 'file_type', sql: this.tableFileType },
            { name: 'sensor_type', sql: this.tableSensorType },
            { name: 'action_state_type', sql: this.tableActionStateType },
            { name: 'sensor_type', sql: this.tableConfig },
            { name: 'data_sensors', sql: this.tableDataSensors },
            { name: 'data_events', sql: this.tableDataEvents },
          ];
      
          // Проверяем существование каждой таблицы
          for (const table of tables) {
            const tableExists = await this.checkTableExists(table.name, dbName, this.dbUser, this.dbPass);
            if (!tableExists) {
              tablesToCreate.push(table.sql); // Добавляем SQL для создания таблицы
              console.log(`Создаем таблицу ${table.name} в базе "${dbName}"...`);
            } else {
              console.log(`Таблица ${table.name} уже существует в базе "${dbName}", пропускаем создание.`);
            }
          }
          // Создаем только те таблицы, которые отсутствуют
          if (tablesToCreate.length > 0) {
            await this.createTables(tablesToCreate, dbName, this.dbUser, this.dbPass);
            console.log(`Все таблицы для хранения данных успешно созданы в базе "${this.dbName}".`);
          } else {
            console.log(`Все таблицы уже существуют в базе "${dbName}", создание не требуется.`);
          }
        } catch (error) {
          console.error('Ошибка при создании таблиц хранения данных:', error);
          throw error;
        }
      }
      async createTables(tables, db) {
        const dbName = db || this.dbName;
        try {
          for (const table of tables) {
            await this.query(table, [], dbName, this.dbUser, this.dbPass);
          }
          console.log('Все таблицы успешно созданы.');
        } catch (error) {
          console.error('Ошибка при создании таблиц:', error);
          throw error;
        }
      }
    // Метод проверки существования таблицы Используется в  createTableAuth и createTableDID
      async checkTableExists(tableName, dbName, dbUser, dbPass) {
        try {
          const queryText = `
            SELECT EXISTS (
              SELECT FROM information_schema.tables 
              WHERE table_schema = 'public' 
              AND table_name = $1
            );
          `;
          const result = await this.query(queryText, [tableName], dbName, dbUser, dbPass);
          return result.rows[0].exists; // Возвращает true, если таблица существует, иначе false
        } catch (error) {
          console.error(`Ошибка при проверке существования таблицы ${tableName}:`, error.message);
          throw error;
        }
      }

      async findUser(username) {
        console.log(`Поиск пользователя ${username}...`);
        try {
          const queryText = `
            SELECT 
              u.*, 
              p.permission_level as userlevel,
              ds.dID
            FROM users u
            LEFT JOIN permissions p ON u.id = p.user_id
            LEFT JOIN userdatasources uds ON u.id = uds.user_id
            LEFT JOIN datasources ds ON uds.data_source_id = ds.id
            WHERE u.username = $1
            LIMIT 1
          `;
      
          const result = await this.query(queryText, [username]);
          
          if (result.rows.length === 0) {
            console.log(`Пользователь "${username}" не найден`);
            return null;
          }
      
          const userData = result.rows[0];
          
          return {
            id: userData.id,
            username: userData.username,
            password: userData.password,
            userlevel: userData.userlevel || 0,
            dID: userData.did || '' // Используем COALESCE для защиты от NULL
          };
          
        } catch (error) {
          console.error(`Ошибка поиска пользователя ${username}:`, error.message);
          throw error;
        }
      }


      // Функция для получения списка пользователей
      async fetchUsers () {
        //console.log('db - fetchUsers Начинаем проверку');
        try {
          // Выбираем id и username из таблицы users
          const result = await this.query('SELECT id, username FROM users');
          //console.log('db - fetchUsers Результат запроса', result);
          // Преобразуем результат в массив объектов с id и username
          const users = result.rows.map(row => ({
            id: row.id,
            username: row.username,
          }));
          //console.log('db - fetchUsers Отсортированный список пользователей', users);
          return users; // Возвращаем список объектов с id и username
        } catch (error) {
          console.error('Ошибка при получении списка пользователей:', error);
          throw error;
        }
      };

      // Функция для получения списка источников данных
      async fetchDataSources () {
        console.log('db - fetch-DataSources Начинаем проверку');
        try {
          // Выбираем id и did из таблицы DataSources
          const result = await this.query('SELECT id, did FROM datasources');
          console.log('db - fetch-DataSources Результат запроса', result);
          // Преобразуем результат в массив объектов с id и did
          const dataSources = result.rows.map(row => ({
            id: row.id,
            did: row.did,
          }));
          console.log('db - fetch-DataSources Отсортированный список пользователей', dataSources);
          return dataSources; // Возвращаем список объектов с id и did
        } catch (error) {
          console.error('Ошибка при получении списка источников данных:', error);
          throw error;
        }
      };
      
}

module.exports = new DBManager(); // Экспортируем singleton