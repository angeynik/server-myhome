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

      console.log(`[db] - getPool - Создан новый пул для базы данных: ${dbName}`);
    }

    return this.pools[key];
  }
  // Завершение всех пулов
  async closeAllPools() {
    for (const key of Object.keys(this.pools)) {
      await this.pools[key].end();
      console.log(`[db] - closeAllPools - Пул для ключа ${key} завершен.`);
    }
    this.pools = {};
  }
  // Завершение конкретного пула
  async closePool(dbName, dbUser) {
    const key = `${dbName}-${dbUser}`;
    if (this.pools[key]) {
      await this.pools[key].end();
      delete this.pools[key];
      console.log(`[db] - closePool - Пул для базы данных ${dbName} завершен.`);
    }
  }
  async query(text, params, dbName, dbUser, dbPass) {
    const Name = dbName || this.dbName;
    const User = dbUser || this.dbUser;
    const Pass = dbPass || this.dbPass;
      console.log(`[db]- query - [QUERY START] ${text}`);
      //console.log(`[db]- query - Параметры: ${JSON.stringify(params)}`);

    console.log(`[db]- query - Выполнение запроса для ${Name}, ${User}, ${Pass}`);
    const pool = this.getPool(Name, User, Pass);
    const start = Date.now();
    try {
      const res = await pool.query(text, params);
      const duration = Date.now() - start;
      console.log(`[db]- query - Подключение к базе данных ${Name} пользователь ${User} выполнено за ${duration} мс`);
      //console.log('[db]- query - Результат выполнения запроса:', JSON.stringify(res, null, 2));
  
      return res;
    } catch (error) {
      console.error('[db]- query - Ошибка при выполнении запроса:', error.message);
      throw error;
    }
  }

    // Проверка существования записи в таблице по условиям
    async checkRecordExists(tableName, param, dbName, dbUser, dbPass) {
      //console.log('[db]- checkRecordExists - Входим в checkRecordExists');
      if (Object.keys(param).length === 0) {
        throw new Error('db]- checkRecordExists - Необходимо указать условия для проверки существования записи');
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
      
      //console.log('db]- checkRecordExists - - Готовим запрос queryText', queryText);
      
      try {
        const result = await this.query(
          queryText, 
          params, 
          dbName, 
          dbUser, 
          dbPass
        );
    
        if (result.rows.length > 0) {
          console.log('db]- checkRecordExists -  - Запись найдена, ID:', result.rows[0].id);
          return { 
            exists: true, 
            id: result.rows[0].id 
          };
        }
        
        //console.log('db]- checkRecordExists -  - Запись не найдена');
        return { 
          exists: false, 
          id: null 
        };
    
      } catch (error) {
        console.error(`db]- checkRecordExists - Ошибка проверки записи в таблице ${tableName}:`, error.message);
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