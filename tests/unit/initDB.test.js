const InitDB = require('../../services/initDB');
const { query, setDatabase } = require('../../services/db');

// Мокируем модуль db.js
jest.mock('../../services/db', () => ({
  query: jest.fn(),
  setDatabase: jest.fn(),
}));

describe('InitDB.checkDB', () => {
  let initDB;

  beforeEach(() => {
    // Создаём экземпляр класса InitDB перед каждым тестом
    initDB = new InitDB();
    jest.clearAllMocks(); // Очищаем моки перед каждым тестом
  });

  // Тест 1: Успешная проверка существующей базы данных
  it('должен вернуть { result: false }, если база данных существует', async () => {
    // Мокируем успешный ответ от базы данных (база существует)
    query.mockResolvedValue({ rows: [{ exists: true }] });

    const result = await initDB.checkDB('existing_db', 'valid_db', 'valid_user', 'valid_password');

    expect(result).toEqual({ result: false, message: 'База данных уже существует.' });
    // Исправленное ожидание с 5 параметрами
    expect(query).toHaveBeenCalledWith(
      'SELECT 1 FROM pg_database WHERE datname = $1', 
      ['existing_db'],
      'postgres',      // database name для подключения
      'valid_user',    // пользователь
      'valid_password' // пароль
    );
  });

  // Тест 2: Проверка отсутствия базы данных
  it('должен вернуть { result: true }, если база данных не существует', async () => {
    // Мокируем пустой ответ от базы данных (база не существует)
    query.mockResolvedValue({ rows: [] });

    const result = await initDB.checkDB('non_existing_db', 'valid_db', 'valid_user', 'valid_password');

    expect(result).toEqual({ result: true, message: 'База данных НЕ существует'});
    // Исправленное ожидание с 5 параметрами
    expect(query).toHaveBeenCalledWith(
      'SELECT 1 FROM pg_database WHERE datname = $1', 
      ['non_existing_db'],
      'postgres',      // database name для подключения
      'valid_user',    // пользователь
      'valid_password' // пароль
    );
  });

  // Тест 3: Проверка отсутствия пользователя
  it('должен вернуть { result: false }, если пользователь не существует', async () => {
    // Мокируем ошибку "роль не существует"
    query.mockRejectedValue({ code: '28000', message: 'role "invalid_user" does not exist' });

    const result = await initDB.checkDB('existing_db', 'valid_db', 'invalid_user', 'valid_password');

    expect(result).toEqual({
      result: false,
      message: 'Пользователь invalid_user отсутствует в базе Postgres. Создайте пользователя!',
    });
    
    expect(query).toHaveBeenCalledWith(
      'SELECT 1 FROM pg_database WHERE datname = $1', 
      ['existing_db'],
      'postgres',
      'invalid_user',
      'valid_password'
    );
  });

  // Тест 4: Проверка ошибки подключения (неправильный пароль)
  it('должен вернуть { result: false }, если пароль неправильный', async () => {
    // Мокируем ошибку "неправильный пароль"
    query.mockRejectedValue({ code: '28P01', message: 'password authentication failed for user "valid_user"' });

    const result = await initDB.checkDB('existing_db', 'valid_db', 'valid_user', 'wrong_password');

    expect(result).toEqual({
      result: false,
      message: 'Ошибка при проверке базы данных: password authentication failed for user "valid_user"',
    });
    
    expect(query).toHaveBeenCalledWith(
      'SELECT 1 FROM pg_database WHERE datname = $1', 
      ['existing_db'],
      'postgres',
      'valid_user',
      'wrong_password'
    );
  });

  // Тест 5: Проверка общей ошибки
  it('должен вернуть { result: false }, если произошла неизвестная ошибка', async () => {
    // Мокируем общую ошибку
    query.mockRejectedValue(new Error('Неизвестная ошибка'));

    const result = await initDB.checkDB('existing_db', 'valid_db', 'valid_user', 'valid_password');

    expect(result).toEqual({
      result: false,
      message: 'Ошибка при проверке базы данных: Неизвестная ошибка',
    });
    
    expect(query).toHaveBeenCalledWith(
      'SELECT 1 FROM pg_database WHERE datname = $1', 
      ['existing_db'],
      'postgres',
      'valid_user',
      'valid_password'
    );
  });
});