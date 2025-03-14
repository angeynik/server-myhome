const bcrypt = require('bcryptjs');
const { query, pool } = require('./db');

// Регистрация нового пользователя
// const registerUser = async (username, password, level, dID, sourceName = null, sourceDescription = null, email = null) => {
//   console.log('Начинаем регистрацию: username - ', username, 'password - ', password, 'email - ', email);
//   if (!username || !password || !level || !dID ) {
//     throw new Error('Username, password, dID and level are required');
//   }

//   const client = await pool.connect(); // Получаем клиента для транзакции

//   try {
//     await client.query('BEGIN'); // Начинаем транзакцию
//     console.log('Начинаем транзакцию в таблицу: username - ', username, 'password - ', password, 'email - ', email);
//     // Регистрация пользователя
//     const newUser = await client.query(
//       'INSERT INTO users (username, password, email) VALUES ($1, $2, $3) RETURNING id, username, email',
//       [username, password, email]
//     );

//     const userId = newUser.rows[0].id;

//     // Создание источника данных
//     const dataSource = await client.query(
//       'INSERT INTO DataSources (did, name, description) VALUES ($1, $2, $3) RETURNING id',
//       [dID, sourceName, sourceDescription]
//     );
    
//     const dataSourceId = dataSource.rows[0].id;
//     console.log('Начинаем транзакцию в таблицу: dataSource - userId', userId, 'dataSourceId - ',dataSourceId);
//     // Связывание пользователя с источником данных
//     await client.query(
//       'INSERT INTO UserDataSources (user_id, data_source_id) VALUES ($1, $2)',
//       [userId, dataSourceId]
//     );
//     console.log('Начинаем транзакцию в таблицу: Permissions - userId', userId, 'dataSourceId - ',dataSourceId, 'Permissions - ', level);
//     // Назначение прав доступа
//     await client.query(
//       'INSERT INTO Permissions (user_id, data_source_id, permission_level) VALUES ($1, $2, $3)',
//       [userId, dataSourceId, level]
//     );

//     await client.query('COMMIT'); // Завершаем транзакцию

//     return {
//       message: 'User registered successfully!',
//       user: newUser.rows[0],
//       dataSource: dataSource.rows[0],
//       permissionLevel: level,
//     };
//   } catch (error) {
//     await client.query('ROLLBACK'); // Откатываем транзакцию в случае ошибки
//     throw error;
//   } finally {
//     client.release(); // Освобождаем клиента
//   }
// };
const registerUser = async (username, password, level, dID, sourceName = null, sourceDescription = null, email = null) => {
  console.log('Начинаем регистрацию: username - ', username, 'password - ', password, 'email - ', email);
  if (!username || !password || !level || !dID) {
    throw new Error('Username, password, dID and level are required');
  }

  const client = await pool.connect(); // Получаем клиента для транзакции

  try {
    await client.query('BEGIN'); // Начинаем транзакцию
    console.log('Начинаем транзакцию в таблицу: username - ', username, 'password - ', password, 'email - ', email);

    // Регистрация пользователя
    const newUser = await client.query(
      'INSERT INTO users (username, password, email) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username, password, email]
    );

    const userId = newUser.rows[0].id;

    // Проверяем, существует ли источник данных с таким did
    const existingDataSource = await client.query(
      'SELECT id FROM DataSources WHERE did = $1',
      [dID]
    );

    let dataSourceId;
    if (existingDataSource.rows.length > 0) {
      // Если источник данных уже существует, выбрасываем ошибку
      throw new Error(`Источник данных с did=${dID} уже существует`);
    } else {
      // Создаем новый источник данных
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
};
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

const checkConnection = async () => {
  console.log('Начинаем проверку подключения (checkConnection) к базе данных...');
  try {
    const res = await pool.query('SELECT NOW()');
    console.log('Database connection established:', res.rows[0].now);
    return true;
  } catch (error) {
    console.error('Error connecting to the database:', error.message);
    return false;
  }
};
const closeConnection = async () => {
  try {
    await pool.end();
    console.log('Database connection closed.');
  } catch (error) {
    console.error('Error closing database connection:', error);
  }
};

module.exports = {
  registerUser,
  register,
  addPermission,
  findUser,
  login,
  addDataSource,
  linkDataSourceToUser,
  checkConnection,
  closeConnection
};