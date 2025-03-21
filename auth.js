// Процесс авторизации 
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const DBManager = require('./services/db.js'); // Импортируем DBManager
//const { login } = require('./userRepository');

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
  console.log('auth - username - ', username, 'password - ', password);
  //const user = await login(username, password);

  const user = await DBManager.findUser(username);
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
  const level = await DBManager.findLevel(user.id);
  user.level = level || 0;
  console.log('Уровень доступа пользователя:', level);
  // return user;



  // if (!user) {
  //   return { error: 'Неверный логин или пароль' }; // Возвращаем объект с ошибкой
  // }

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