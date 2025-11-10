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
const logger = require('../serverApp/services/logger.js');

const secret = process.env.JWT_SECRET || 'default-secret-key';

/**
 * Вход пользователя
 * @param {string} username - Имя пользователя
 * @param {string} password - Пароль
 * @returns {Object} - Данные пользователя и токен
 */
const loginUser = async (username, password) => {
  console.log('-- auth -- loginUser - проверяем пользователя --', username, 'с паролем --', password);
  try {
    const user = await DBManager.findUser(username);
    
    if (!user) {
      return { error: `User ${username} not found`, code: 'USER_NOT_FOUND' };
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return { error: 'Invalid password', code: 'INVALID_PASSWORD' };
    }

    const token = jwt.sign({ id: user.id }, secret, { expiresIn: '1h' });
    //console.log(`User ${user.username} Login successfull`);
    logger.logInfoMessage(`User ${user.username} Login successfull`);
    logger.logDevMessage(`[auth] - loginUser - User dID: ${user.dID}`);
    return {
      success: true,
      token,
      username: user.username,
      userlevel: user.userlevel,
      dID: user.dID
    };
    
  } catch (error) {
    console.error('Login error:', error);
    return { error: 'Server error', code: 'SERVER_ERROR' };
  }
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