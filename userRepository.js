const bcrypt = require('bcryptjs');
const { query, pool } = require('./db');

// Регистрация нового пользователя
const register = async (username, password) => {
  console.log('Начинаем регистрацию: username - ', username, 'password - ', password);
  if (!username || !password) {
    throw new Error('Username and password are required');
  }
  const hashedPassword = await bcrypt.hash(password, 10); // Асинхронное хеширование
  try {
    const result = await query(
      'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id',
      [username, hashedPassword]
    );
    return result.rows[0]; // Возвращаем только id
  } catch (error) {
    if (error.code === '23505') { // Ошибка уникальности (дублирование username)
      throw new Error('Username already exists');
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
const addDataSource = async ( name, description) => {
  const data = {
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
  register,
  addPermission,
  findUser,
  login,
  addDataSource,
  linkDataSourceToUser,
  checkConnection,
  closeConnection
};