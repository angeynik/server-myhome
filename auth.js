// Процесс авторизации 

const jwt = require('jsonwebtoken');
const { login } = require('./userRepository');

// Моковые данные пользователей
//const users = [{ id: 1, username: 'testuser', password: bcrypt.hashSync('testpassword', 8) }];

// Секретный ключ для JWT
const dotenv = require('dotenv'); // Подключаем .ENV файл с переменными окружения
dotenv.config({path: './conf.env'}); // Указываем путь к  файлу .env
const secret = process.env.JWT_SECRET || 'default-secret-key';

/**
 * Вход пользователя
 * @param {string} username - Имя пользователя
 * @param {string} password - Пароль
 * @returns {Object} - Данные пользователя и токен
 */
const loginUser = async (username, password) => {
  console.log('username - ', username, 'password - ', password);
  const user = await login(username, password);

  if (!user) {
    return { error: 'Неверный логин или пароль' }; // Возвращаем объект с ошибкой
  }

  const token = jwt.sign({ id: user.id }, secret, { expiresIn: 60 });
  console.log('id - ', user.id, 'user - ', user.username,  'level', user.level, 'token - ', token);
  return { id: user.id, username: user.username, userlevel: user.level, token }; // Возвращаем данные пользователя
};

/**
 * Проверка токена
 * @param {string} token - JWT токен
 * @returns {Object} - Расшифрованные данные токена
 */
const verifyToken = (token) => {
  if (!token) {
    throw new Error('No token provided!');
  }
  console.log('Token verify successfull ');
  return jwt.verify(token, secret);
};

module.exports = {
  loginUser,
  verifyToken,
};