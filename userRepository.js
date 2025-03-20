const bcrypt = require('bcryptjs');
const { query, pool, setDatabase } = require('../serverApp/services/db.js');

// Функция для получения списка пользователей
const fetchUsers = async () => {
  try {
    // Выбираем id и username из таблицы users
    const result = await query('SELECT id, username FROM users');
    
    // Преобразуем результат в массив объектов с id и username
    const users = result.rows.map(row => ({
      id: row.id,
      username: row.username,
    }));
    
    return users; // Возвращаем список объектов с id и username
  } catch (error) {
    console.error('Ошибка при получении списка пользователей:', error);
    throw error;
  }
};

// Функция для получения списка источников данных
const fetchDataSources = async () => {
  try {
    // Выбираем id и did из таблицы DataSources
    const result = await query('SELECT id, did FROM DataSources');
    
    // Преобразуем результат в массив объектов с id и did
    const dataSources = result.rows.map(row => ({
      id: row.id,
      did: row.did,
    }));
    
    return dataSources; // Возвращаем список объектов с id и did
  } catch (error) {
    console.error('Ошибка при получении списка источников данных:', error);
    throw error;
  }
};


// Регистрация нового пользователя
const createDatabase = async (databaseName) => {
  try {
    // Используем существующий пул соединений для создания новой базы данных
    await query(`CREATE DATABASE "${databaseName}"`);
    console.log(`База данных "${databaseName}" создана успешно.`);
  } catch (error) {
    console.error(`Ошибка при создании базы данных "${databaseName}":`, error);
    throw error;
  }
};

// Функция для создания таблиц в новой базе данных
const createTables = async (databaseName) => {
  try {
    setDatabase(databaseName);

    await query(`
      CREATE TABLE config (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        file JSON NOT NULL,
        update_date TIMESTAMP NOT NULL
      );
    `);

    await query(`
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
    `);

    console.log(`Таблицы в базе данных "${databaseName}" созданы успешно.`);
  } catch (error) {
    console.error(`Ошибка при создании таблиц в базе данных "${databaseName}":`, error);
    throw error;
  }
};

const databaseExists = async (databaseName) => {
  try {
    // Проверяем существование базы данных, запрашивая список баз данных
    const result = await query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    return result.rows.length > 0;
  } catch (error) {
    console.error('Ошибка при проверке существования базы данных:', error);
    throw error;
  }
};
// Регистрация нового пользователя
const registerUser = async (username, password, level, dID, sourceName = null, sourceDescription = null, email = null) => {
  console.log('Начинаем регистрацию: username - ', username, 'password - ', password, 'email - ', email);
  if (!username || !password || !level || !dID) {
    throw new Error('Username, password, dID and level are required');
  }

  const hashedPassword = await bcrypt.hash(password, 10); // Хешируем пароль
  const client = await pool.connect(); // Получаем клиента для транзакции

  try {
    await client.query('BEGIN'); // Начинаем транзакцию
    console.log('Начинаем транзакцию в таблицу: username - ', username, 'password - ', password, 'email - ', email);

    // Регистрация пользователя
    const newUser = await client.query(
      'INSERT INTO users (username, password, email) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username, hashedPassword, email]
    );

    const userId = newUser.rows[0].id;

    // Проверяем, существует ли источник данных с таким did
    const existingDataSource = await client.query(
      'SELECT id FROM DataSources WHERE did = $1',
      [dID]
    );

    let dataSourceId;
    if (existingDataSource.rows.length > 0) {
      // Если источник данных уже существует, используем его
      dataSourceId = existingDataSource.rows[0].id;
      console.log('Источник данных уже существует:', dataSourceId);
    } else {
      // Если источник данных не существует, создаем новый
      const dataSource = await client.query(
        'INSERT INTO DataSources (did, name, description) VALUES ($1, $2, $3) RETURNING id',
        [dID, sourceName, sourceDescription]
      );
      dataSourceId = dataSource.rows[0].id;
      console.log('Создан новый источник данных:', dataSourceId);
    }

    // Связывание пользователя с источником данных
    await client.query(
      'INSERT INTO UserDataSources (user_id, data_source_id) VALUES ($1, $2)',
      [userId, dataSourceId]
    );
    console.log('Пользователь связан с источником данных:', { userId, dataSourceId });

    // Назначение прав доступа
    await client.query(
      'INSERT INTO Permissions (user_id, data_source_id, permission_level) VALUES ($1, $2, $3)',
      [userId, dataSourceId, level]
    );
    console.log('Назначены права доступа:', { userId, dataSourceId, level });

    await client.query('COMMIT'); // Завершаем транзакцию

          // Проверяем, существует ли база данных
          const dbExists = await databaseExists(dID);
          if (!dbExists) {
            // Создаем новую базу данных с именем, соответствующим did
            await createDatabase(dID);
    
            // Создаем таблицы в новой базе данных
            await createTables(dID);
          } else {
            console.log('База данных с именем', dID, 'уже существует');
          }

    return {
      message: 'User registered successfully!',
      user: newUser.rows[0],
      dataSourceId,
      permissionLevel: level,
    };
  } catch (error) {
    await client.query('ROLLBACK'); // Откатываем транзакцию в случае ошибки
    console.error('Ошибка при регистрации пользователя:', error);
    throw error;
  } finally {
    client.release(); // Освобождаем клиента
  }
}


// const registerUser = async (username, password, level, dID, sourceName = null, sourceDescription = null, email = null) => {
//   console.log('Начинаем регистрацию: username - ', username, 'password - ', password, 'email - ', email);
//   if (!username || !password || !level || !dID) {
//     throw new Error('Username, password, dID and level are required');
//   }

//   const hashedPassword = await bcrypt.hash(password, 10); // Хешируем пароль
//   const client = await pool.connect(); // Получаем клиента для транзакции

//   try {
//     await client.query('BEGIN'); // Начинаем транзакцию
//     console.log('Начинаем транзакцию в таблицу: username - ', username, 'password - ', password, 'email - ', email);

//     // Регистрация пользователя
//     const newUser = await client.query(
//       'INSERT INTO users (username, password, email) VALUES ($1, $2, $3) RETURNING id, username, email',
//       [username, hashedPassword, email]
//     );

//     const userId = newUser.rows[0].id;

//     // Проверяем, существует ли источник данных с таким did
//     const existingDataSource = await client.query(
//       'SELECT id FROM DataSources WHERE did = $1',
//       [dID]
//     );

//     let dataSourceId;
//     if (existingDataSource.rows.length > 0) {
//       // Если источник данных уже существует, используем его
//       dataSourceId = existingDataSource.rows[0].id;
//       console.log('Источник данных уже существует:', dataSourceId);
//     } else {
//       // Если источник данных не существует, создаем новый
//       const dataSource = await client.query(
//         'INSERT INTO DataSources (did, name, description) VALUES ($1, $2, $3) RETURNING id',
//         [dID, sourceName, sourceDescription]
//       );
//       dataSourceId = dataSource.rows[0].id;
//       console.log('Создан новый источник данных:', dataSourceId);
//     }

//     // Связывание пользователя с источником данных
//     await client.query(
//       'INSERT INTO UserDataSources (user_id, data_source_id) VALUES ($1, $2)',
//       [userId, dataSourceId]
//     );
//     console.log('Пользователь связан с источником данных:', { userId, dataSourceId });

//     // Назначение прав доступа
//     await client.query(
//       'INSERT INTO Permissions (user_id, data_source_id, permission_level) VALUES ($1, $2, $3)',
//       [userId, dataSourceId, level]
//     );
//     console.log('Назначены права доступа:', { userId, dataSourceId, level });

//     await client.query('COMMIT'); // Завершаем транзакцию

//     return {
//       message: 'User registered successfully!',
//       user: newUser.rows[0],
//       dataSourceId,
//       permissionLevel: level,
//     };
//   } catch (error) {
//     await client.query('ROLLBACK'); // Откатываем транзакцию в случае ошибки
//     console.error('Ошибка при регистрации пользователя:', error);
//     throw error;
//   } finally {
//     client.release(); // Освобождаем клиента
//   }
// };

const register = async (username, password, email = null) => {
  console.log('Начинаем регистрацию: username - ', username, 'password - ', password, 'email - ', email);
  
  if (!username || !password) {
    throw new Error('Username and password are required');
  }

  const hashedPassword = await bcrypt.hash(password, 10); // Асинхронное хеширование

  try {
    // SQL-запрос с учетом необязательного email
    const result = await query(
      'INSERT INTO users (username, password, email) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username, hashedPassword, email]
    );

    const user = result.rows[0]; // Возвращаем id, username и email
    return { message: 'User registered successfully!', user };
  } catch (error) {
    if (error.code === '23505') { // Ошибка уникальности (дублирование username или email)
      throw new Error('Username or email already exists');
    }
    throw error; // Пробрасываем другие ошибки
  }
};
const insertIntoTable = async (tableName, data) => {
  console.log('Начинаем insertIntoTable', tableName, data)
  try {
    // Формируем строку с именами столбцов
    const columns = Object.keys(data).join(', ');
    // Формируем строку с плейсхолдерами ($1, $2, ...)
    const placeholders = Object.keys(data).map((_, index) => `$${index + 1}`).join(', ');
    // Формируем массив значений
    const values = Object.values(data);

    const result = await query(
      `INSERT INTO ${tableName} (${columns}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    return result.rows[0]; // Возвращаем вставленную запись
  } catch (error) {
    console.error(`Error inserting into ${tableName}:`, error);
    throw error;
  }
};
const addDataSource = async (dID, name, description) => {
  const data = {
    did: dID,
    name: name,
    description: description,
  };
  return insertIntoTable('DataSources', data);
};

// Связывание источника данных с пользователем
const linkDataSourceToUser = async (user_id, data_source_id) => {
  console.log('Начинаем выполнение linkDataSourceToUser');
  const data = {
    user_id: user_id,
    data_source_id: data_source_id,
  };
  return insertIntoTable('UserDataSources', data);
};

// Добавление прав доступа
const addPermission = async (user_id, data_source_id, permission_level) => {
  const data = {
    user_id: user_id,
    data_source_id: data_source_id,
    permission_level: permission_level,
  };
  return insertIntoTable('Permissions', data);
};
// Поиск пользователя по имени
const findUser = async (username) => {
  const result = await query('SELECT * FROM users WHERE username = $1', [username]);
  return result.rows[0];
};
const findLevel = async (userId) => {
  const result = await query('SELECT permission_level FROM permissions WHERE user_id = $1', [userId]);
  return result.rows[0] ? result.rows[0].permission_level : null; // Возвращаем уровень доступа или null
};

// Вход пользователя
const login = async (username, password) => {
  const user = await findUser(username);
  console.log('Функция login - найденый user', user);
  if (!user) {
    console.log('Пользователь с логином', username, 'не найден');
    return null; // Возвращаем null, если пользователь не найден
  }
  const passwordIsValid = bcrypt.compareSync(password, user.password);
  if (!passwordIsValid) {
    console.log('Неверный пароль для пользователя', username);
    return null; // Возвращаем null, если пароль неверный
  }
  const level = await findLevel(user.id);
  user.level = level || 0;
  console.log('Уровень доступа пользователя:', level);
  return user;
};
/**
 * Функция для изменения пароля пользователя
 * @param {number} requesterId - ID пользователя, который пытается изменить пароль
 * @param {string} targetUsername - Имя пользователя, для которого меняется пароль
 * @param {string} newPassword - Новый пароль
 * @returns {Object} - Результат операции
 */
const changePassword = async (requesterId, targetUsername, newPassword) => {
  // Проверяем, что новый пароль предоставлен
  if (!newPassword) {
    throw new Error('New password is required');
  }

  const client = await pool.connect(); // Получаем клиента для транзакции

  try {
    await client.query('BEGIN'); // Начинаем транзакцию

    // Проверяем уровень доступа пользователя, который пытается изменить пароль
    const requesterLevel = await client.query(
      'SELECT permission_level FROM Permissions WHERE user_id = $1',
      [requesterId]
    );

    if (!requesterLevel.rows.length || requesterLevel.rows[0].permission_level !== 3) {
      throw new Error('Only users with permission level 3 can change passwords');
    }

    // Находим пользователя, для которого меняется пароль
    const targetUser = await client.query(
      'SELECT id FROM users WHERE username = $1',
      [targetUsername]
    );

    if (!targetUser.rows.length) {
      throw new Error('User not found');
    }

    const targetUserId = targetUser.rows[0].id;

    // Хешируем новый пароль
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Обновляем пароль в базе данных
    await client.query(
      'UPDATE users SET password = $1 WHERE id = $2',
      [hashedPassword, targetUserId]
    );

    await client.query('COMMIT'); // Завершаем транзакцию

    return { message: 'Password changed successfully!' };
  } catch (error) {
    await client.query('ROLLBACK'); // Откатываем транзакцию в случае ошибки
    console.error('Ошибка при изменении пароля:', error);
    throw error;
  } finally {
    client.release(); // Освобождаем клиента
  }
};

// const checkConnection = async () => {
//   console.log('Начинаем проверку подключения (checkConnection) к базе данных...');
//   try {
//     const res = await pool.query('SELECT NOW()');
//     console.log('Database connection established:', res.rows[0].now);
//     return true;
//   } catch (error) {
//     console.error('Error connecting to the database:', error.message);
//     return false;
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

module.exports = {
  fetchUsers,
  fetchDataSources,
  registerUser,
  register,
  addPermission,
  findUser,
  login,
  addDataSource,
  linkDataSourceToUser,
  insertIntoTable,
  changePassword,
  databaseExists
};





// class TableDB {
//     // Поиск пользователя по имени
//     static async findUser(username, dbName, dbUser, dbPass) {
//         try {
//             const result = await DBManager.query('SELECT * FROM users WHERE username = $1', [username], dbName, dbUser, dbPass);
//             return result.rows[0];
//         } catch (error) {
//             console.error('Ошибка при поиске пользователя:', error);
//             throw error;
//         }
//     }

//     // Получение уровня доступа пользователя по его ID
//     static async findLevel(userId, dbName, dbUser, dbPass) {
//         try {
//             const result = await DBManager.query(
//                 'SELECT permission_level FROM permissions WHERE user_id = $1',
//                 [userId],
//                 dbName, dbUser, dbPass
//             );
//             return result.rows[0] ? result.rows[0].permission_level : null;
//         } catch (error) {
//             console.error('Ошибка при получении уровня доступа:', error);
//             throw error;
//         }
//     }

//     // Получение списка всех пользователей
//     static async getUsers(dbName, dbUser, dbPass) {
//         try {
//             const result = await DBManager.query('SELECT id, username FROM users', [], dbName, dbUser, dbPass);
//             return result.rows.map(row => ({
//                 id: row.id,
//                 username: row.username,
//             }));
//         } catch (error) {
//             console.error('Ошибка при получении списка пользователей:', error);
//             throw error;
//         }
//     }

//     // Получение списка всех источников данных
//     static async getDataSources(dbName, dbUser, dbPass) {
//         try {
//             const result = await DBManager.query('SELECT id, did FROM DataSources', [], dbName, dbUser, dbPass);
//             return result.rows.map(row => ({
//                 id: row.id,
//                 did: row.did,
//             }));
//         } catch (error) {
//             console.error('Ошибка при получении списка источников данных:', error);
//             throw error;
//         }
//     }
//         // Регистрация нового пользователя
//         static async registerUser(username, password, level, did, source, dbName, dbUser, dbPass) {
//             try {
//                 const hashedPassword = await bcrypt.hash(password, 10); // Хешируем пароль
//                 const result = await DBManager.query(
//                     `INSERT INTO users (username, password, permission_level, did, source) 
//                      VALUES ($1, $2, $3, $4, $5) RETURNING id`,
//                     [username, hashedPassword, level, did, source],
//                     dbName, dbUser, dbPass
//                 );
//                 return result.rows[0].id; // Возвращаем ID нового пользователя
//             } catch (error) {
//                 console.error('Ошибка при регистрации пользователя:', error);
//                 throw error;
//             }
//         }

// }