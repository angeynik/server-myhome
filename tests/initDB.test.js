const InitDB = require('../services/initDB'); // Импортируем класс InitDB
const { query, setDatabase } = require('../db'); // Импортируем необходимые функции из db.js

// Мокируем модуль db.js
jest.mock('../db', () => ({
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
  it('должен вернуть { result: true }, если база данных существует', async () => {
    // Мокируем успешный ответ от базы данных
    query.mockResolvedValue({ rows: [{ exists: true }] });

    const result = await initDB.checkDB('existing_db', 'valid_user', 'valid_password');

    expect(result).toEqual({ result: false, message: 'База данных уже существует.' });
    expect(query).toHaveBeenCalledWith('SELECT 1 FROM pg_database WHERE datname = $1', ['existing_db']);
  });

  // Тест 2: Проверка отсутствия базы данных
  it('должен вернуть { result: false }, если база данных не существует', async () => {
    // Мокируем пустой ответ от базы данных (база не существует)
    query.mockResolvedValue({ rows: [] });

    const result = await initDB.checkDB('non_existing_db', 'valid_user', 'valid_password');

    expect(result).toEqual({ result: true, message: 'База данных НЕ существует'});
    expect(query).toHaveBeenCalledWith('SELECT 1 FROM pg_database WHERE datname = $1', ['non_existing_db']);
  });

  // Тест 3: Проверка отсутствия пользователя
  it('должен вернуть { result: false }, если пользователь не существует', async () => {
    // Мокируем ошибку "роль не существует"
    query.mockRejectedValue({ code: '28000', message: 'role "invalid_user" does not exist' });

    const result = await initDB.checkDB('existing_db', 'invalid_user', 'valid_password');

    expect(result).toEqual({
      result: false,
      message: 'Пользователь invalid_user отсутствует в базе Postgres. Создайте пользователя!',
    });
  });

  // Тест 4: Проверка ошибки подключения (неправильный пароль)
  it('должен вернуть { result: false }, если пароль неправильный', async () => {
    // Мокируем ошибку "неправильный пароль"
    query.mockRejectedValue({ code: '28P01', message: 'password authentication failed for user "valid_user"' });

    const result = await initDB.checkDB('existing_db', 'valid_user', 'wrong_password');

    expect(result).toEqual({
      result: false,
      message: 'Ошибка при проверке базы данных: password authentication failed for user "valid_user"',
    });
  });

  // Тест 5: Проверка общей ошибки
  it('должен вернуть { result: false }, если произошла неизвестная ошибка', async () => {
    // Мокируем общую ошибку
    query.mockRejectedValue(new Error('Неизвестная ошибка'));

    const result = await initDB.checkDB('existing_db', 'valid_user', 'valid_password');

    expect(result).toEqual({
      result: false,
      message: 'Ошибка при проверке базы данных: Неизвестная ошибка',
    });
  });
});