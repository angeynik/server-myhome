// Импортируем тестируемый модуль
const { query } = require('../db');
const { Pool } = require('pg');

// Мокаем модуль 'pg'
jest.mock('pg', () => {
  const mPool = {
    query: jest.fn(), // Мокаем метод query
    connect: jest.fn(),
    end: jest.fn(),
  };
  return { Pool: jest.fn(() => mPool) };
});

describe('Database Query Function', () => {
  let pool;

  beforeEach(() => {
    pool = new Pool(); // Инициализируем мок
  });

  afterEach(() => {
    jest.clearAllMocks(); // Сбрасываем моки после каждого теста
  });

  it('должен успешно выполнить SQL-запрос', async () => {
    // Мокаем возвращаемое значение для pool.query
    const mockResult = { rows: [{ id: 1, name: 'Test' }], rowCount: 1 };
    pool.query.mockResolvedValueOnce(mockResult); // Успешный запрос

    const sql = 'SELECT * FROM test_table WHERE id = $1';
    const params = [1];

    const result = await query(sql, params);

    // Проверяем, что query() была вызвана с правильными аргументами
    expect(pool.query).toHaveBeenCalledWith(sql, params);
    // Проверяем результат
    expect(result).toEqual(mockResult);
  });

  it('должен обработать ошибку выполнения SQL-запроса', async () => {
    const mockError = new Error('Ошибка базы данных');
    pool.query.mockRejectedValueOnce(mockError);
  
    // Мокаем console.error, чтобы подавить вывод
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  
    const sql = 'SELECT * FROM test_table WHERE id = $1';
    const params = [1];
  
    await expect(query(sql, params)).rejects.toThrow('Ошибка базы данных');
  
    expect(pool.query).toHaveBeenCalledWith(sql, params);
  
    // Восстанавливаем оригинальное поведение console.error
    consoleErrorSpy.mockRestore();
  });  
});
