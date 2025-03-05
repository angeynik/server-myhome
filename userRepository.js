const bcrypt = require('bcryptjs');
const { query } = require('./db');

// Регистрация нового пользователя
const register = async (username, password) => {
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

// Поиск пользователя по имени
const findUserByUsername = async (username) => {
  const result = await query('SELECT * FROM users WHERE username = $1', [username]);
  return result.rows[0];
};

// Вход пользователя
const login = async (username, password) => {
  const user = await findUserByUsername(username);
  if (!user) {
    throw new Error('User not found.');
  }
  const passwordIsValid = bcrypt.compareSync(password, user.password);
  if (!passwordIsValid) {
    throw new Error('Invalid Password!');
  }
  return user;
};

// Добавление источника данных
const addDataSource = async (dID, name, description) => {
  const result = await query(
    'INSERT INTO DataSources (dID, name, description) VALUES ($1, $2, $3) RETURNING *',
    [dID, name, description]
  );
  return result.rows[0];
};

// Связывание источника данных с пользователем
const linkDataSourceToUser = async (user_id, data_source_id) => {
  const result = await query(
    'INSERT INTO UserDataSources (user_id, data_source_id) VALUES ($1, $2) RETURNING *',
    [user_id, data_source_id]
  );
  return result.rows[0];
};

module.exports = {
  register,
  findUserByUsername,
  login,
  addDataSource,
  linkDataSourceToUser,
};