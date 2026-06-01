const DBManager = require('./db'); // Импортируем DBManager
const dotenv = require('dotenv'); // Подключаем .ENV файл с переменными окружения
dotenv.config({path: './conf.env'}); // Указываем путь к  файлу .env

const bcrypt = require('bcryptjs');

//fetchUsers -- получение 

// Функция для получения списка пользователей списка пользователей 
const fetchUsers = async () => {
  try {
    // Выбираем id и username из таблицы users
    const result = await DBManager.query('SELECT id, username FROM users');

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
    const result = await DBManager.query('SELECT id, did FROM DataSources');

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


// Проверка существования базы данных
const databaseExists = async (databaseName) => {
  try {
    // Проверяем существование базы данных, запрашивая список баз данных
    const result = await DBManager.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    return result.rows.length > 0;
  } catch (error) {
    console.error('Ошибка при проверке существования базы данных:', error);
    throw error;
  }
};

// Поиск пользователя по имени
const findUser = async (username) => {
    console.log(`Ищем пользователя ${username}`);
    const result = await DBManager.query('SELECT * FROM users WHERE username = $1', [username], process.env.DB_DATABASE);
    return result.rows[0];
  };

  // Регистрация нового пользователя
const registerUser = async (username, password, level, dID, sourceName = null, sourceDescription = null, email = null) => {
    console.log('[tableDB] - registerUser - Начинаем регистрацию: username - ', username, 'password - ', password, 'level', level, 'dID', dID, 'sourceName', sourceName, 'email - ', email);
    if (!username || !password || !level || !dID) {
      throw new Error('[tableDB] - registerUser -Username, password, dID and level are required');
    }
  
    const hashedPassword = await bcrypt.hash(password, 10); // Хешируем пароль
    console.log ('[tableDB] - registerUser -Хеширование пароля выполнено');
    try {
        console.log ('[tableDB] - registerUser -Начинаем подготовку транзации - BEGIN');
      await DBManager.query('BEGIN'); // Начинаем транзакцию
        
      // Регистрация пользователя
      const newUser = await DBManager.query(
        'INSERT INTO users (username, password, email) VALUES ($1, $2, $3) RETURNING id, username, email',
        [username, hashedPassword, email]
      );
  
      const userId = newUser.rows[0].id;
  
      // Проверяем, существует ли источник данных с таким did
      const existingDataSource = await DBManager.query(
        'SELECT id FROM DataSources WHERE did = $1',
        [dID]
      );
  
      let dataSourceId;
      if (existingDataSource.rows.length > 0) {
        // Если источник данных уже существует, используем его
        dataSourceId = existingDataSource.rows[0].id;
        console.log('[tableDB] - registerUser - Источник данных уже существует:', dataSourceId);
      } else {
        // Если источник данных не существует, создаем новый
        const dataSource = await DBManager.query(
          'INSERT INTO datasources (did, name, description) VALUES ($1, $2, $3) RETURNING id',
          [dID, sourceName, sourceDescription]
        );
        dataSourceId = dataSource.rows[0].id;
        console.log('[tableDB] - registerUser - Создан новый источник данных:', dataSourceId);
      }
  
      // Связывание пользователя с источником данных
      await DBManager.query(
        'INSERT INTO userdatasources (user_id, data_source_id) VALUES ($1, $2)',
        [userId, dataSourceId]
      );
  
      // Назначение прав доступа
      await DBManager.query(
        'INSERT INTO permissions (user_id, data_source_id, permission_level) VALUES ($1, $2, $3)',
        [userId, dataSourceId, level]
      );
  
      await DBManager.query('COMMIT'); // Завершаем транзакцию
  
      return {
        message: 'User registered successfully!',
        user: newUser.rows[0],
        dataSourceId,
        permissionLevel: level,
      };
    } catch (error) {
      await DBManager.query('ROLLBACK'); // Откатываем транзакцию в случае ошибки
      console.error('[tableDB] - registerUser - Откат транзации ROLLBACK -Ошибка при регистрации пользователя:', error);
      throw error;
    }
  };

// Регистрация пользователя (упрощенная версия)
const register = async (username, password, email = null) => {
  console.log('[tableDB] - register - Начинаем регистрацию: username - ', username, 'password - ', password, 'email - ', email);

  if (!username || !password) {
    throw new Error('[tableDB] - register - Username and password are required');
  }

  const hashedPassword = await bcrypt.hash(password, 10); // Асинхронное хеширование

  try {
    const result = await DBManager.query(
      'INSERT INTO users (username, password, email) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username, hashedPassword, email]
    );

    const user = result.rows[0]; // Возвращаем id, username и email
    return { message: 'User registered successfully!', user };
  } catch (error) {
    if (error.code === '23505') { // Ошибка уникальности (дублирование username или email)
      throw new Error('[tableDB] - register - Username or email already exists');
    }
    throw error; // Пробрасываем другие ошибки
  }
};

// Вставка данных в таблицу
const insertIntoTable = async (tableName, data, dbName) => { // Возвращает сообщение вида { exists: true, id: id записи } или ошибку
  console.log('Начинаем insertIntoTable', tableName, data);
  try {
    const columns = Object.keys(data).join(', ');
    const placeholders = Object.keys(data).map((_, index) => `$${index + 1}`).join(', ');
    const values = Object.values(data);

    const result = await DBManager.query(
      `INSERT INTO ${tableName} (${columns}) VALUES (${placeholders}) RETURNING *`,
      values,
      dbName
    );
    //console.log('insertIntoTable - ', result.rows[0]);
    return {
      exists: true, 
      id: result.rows[0].id, // Возвращаем ID вставленной записи
  };
  } catch (error) {
    console.error(`Ошибка при вставке в таблицу ${tableName}:`, error);
    throw error;
  }
};

// Добавление источника данных
const addDataSource = async (dID, name, description) => {
  const data = {
    did: dID,
    name: name,
    description: description,
  };
  return insertIntoTable('DataSources', data, process.env.DB_DATABASE);
};

// Связывание источника данных с пользователем
const linkDataSourceToUser = async (user_id, data_source_id, dbName) => { // Возвращает сообщение вида { exists: true, id: id записи } или ошибку
  console.log('Входим в linkDataSourceToUser');
  try {
    const data = {
      user_id: user_id,
      data_source_id: data_source_id,
    };

    // Проверяем существование связи
    const exists = await DBManager.checkRecordExists(
      'userdatasources',
      { user_id, data_source_id },
      dbName
    );
    console.log ('Результат проверки ', exists.id);
    if (exists.id != null) {
      return exists;
    } 
    //   // Если запись существует, получаем её ID
    //   const existingRecord = await DBManager.query(
    //     'SELECT id FROM userdatasources WHERE user_id = $1 AND data_source_id = $2',
    //     [user_id, data_source_id],
    //     dbName
    //   );
    //   return { 
    //     error: 'Связь уже существует',
    //     id: existingRecord.rows[0].id 
    //   };
    // }

    // Если связи нет, создаем новую
    const result = await insertIntoTable('userdatasources', data, dbName);
    return result;

  } catch (error) {
    console.error('Ошибка связывания:', error);
    
    // Обрабатываем случай конкурентного добавления
    if (error.code === '23505') {
      const existingRecord = await query(
        'SELECT id FROM userdatasources WHERE user_id = $1 AND data_source_id = $2',
        [user_id, data_source_id],
        dbName
      );
      return { 
        error: 'Связь уже существует',
        id: existingRecord.rows[0].id 
      };
    }
    
    return { error: error.message };
  }
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

// Поиск уровня доступа пользователя
const findLevel = async (userId) => {
  const result = await DBManager.query('SELECT permission_level FROM permissions WHERE user_id = $1', [userId]);
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

// Изменение пароля пользователя
const changePassword = async (requesterId, targetUsername, newPassword) => {
  if (!newPassword) {
    throw new Error('New password is required');
  }

  try {
    await DBManager.query('BEGIN'); // Начинаем транзакцию

    // Проверяем уровень доступа пользователя, который пытается изменить пароль
    const requesterLevel = await DBManager.query(
      'SELECT permission_level FROM Permissions WHERE user_id = $1',
      [requesterId]
    );

    if (!requesterLevel.rows.length || requesterLevel.rows[0].permission_level !== 3) {
      throw new Error('Only users with permission level 3 can change passwords');
    }

    // Находим пользователя, для которого меняется пароль
    const targetUser = await DBManager.query(
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
    await DBManager.query(
      'UPDATE users SET password = $1 WHERE id = $2',
      [hashedPassword, targetUserId]
    );

    await DBManager.query('COMMIT'); // Завершаем транзакцию

    return { message: 'Password changed successfully!' };
  } catch (error) {
    await DBManager.query('ROLLBACK'); // Откатываем транзакцию в случае ошибки
    console.error('Ошибка при изменении пароля:', error);
    throw error;
  }
};

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
  databaseExists,
};