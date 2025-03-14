const { register } = require('../userRepository');
const { query } = require('../db'); // Исправленный путь
const bcrypt = require('bcryptjs');

// Мокаем модуль 'bcryptjs'
jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashedPassword'),
}));

// Мокаем модуль '../db'
jest.mock('../db', () => ({
  query: jest.fn(),
}));

describe('register', () => {
  beforeEach(() => {
    jest.clearAllMocks(); // Сбрасываем моки перед каждым тестом
  });

  it('должен успешно зарегистрировать пользователя', async () => {
    // Мокируем запрос к базе данных
    query.mockResolvedValueOnce({
      rows: [{ id: 1, username: 'testUser', email: 'test@example.com' }],
    });

    const result = await register('testUser', 'testPass', 'test@example.com');

    // Проверяем, что функция возвращает ожидаемый результат
    expect(result).toEqual({
      message: 'User registered successfully!',
      user: { id: 1, username: 'testUser', email: 'test@example.com' },
    });

    // Проверяем, что bcrypt.hash был вызван с правильными аргументами
    expect(bcrypt.hash).toHaveBeenCalledWith('testPass', 10);

    // Проверяем, что query был вызван с правильными аргументами
    expect(query).toHaveBeenCalledWith(
      'INSERT INTO users (username, password, email) VALUES ($1, $2, $3) RETURNING id, username, email',
      ['testUser', 'hashedPassword', 'test@example.com']
    );
  });

  it('должен вернуть ошибку, если username или password отсутствуют', async () => {
    await expect(register(null, 'testPass', 'test@example.com')).rejects.toThrow(
      'Username and password are required'
    );
    await expect(register('testUser', null, 'test@example.com')).rejects.toThrow(
      'Username and password are required'
    );
  });

  it('должен вернуть ошибку, если username или email уже существуют', async () => {
    // Мокируем ошибку уникальности
    const error = new Error('Ошибка уникальности');
    error.code = '23505';
    query.mockRejectedValueOnce(error);

    await expect(
      register('testUser', 'testPass', 'test@example.com')
    ).rejects.toThrow('Username or email already exists');
  });

  it('должен вернуть ошибку, если произошла другая ошибка', async () => {
    // Мокируем общую ошибку
    query.mockRejectedValueOnce(new Error('Ошибка базы данных'));

    await expect(
      register('testUser', 'testPass', 'test@example.com')
    ).rejects.toThrow('Ошибка базы данных');
  });
});