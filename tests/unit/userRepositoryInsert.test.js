// tests/userRepositoryInsert.test.js
const { insertIntoTable } = require('../../userRepository');
const { query } = require('../../services/db');

// Мокаем модуль '../db'
jest.mock('../../services/db', () => ({
  query: jest.fn(),
}));

describe('insertIntoTable', () => {
  beforeEach(() => {
    jest.clearAllMocks(); // Сбрасываем моки перед каждым тестом
  });

  it('должен успешно вставить данные в таблицу и вернуть вставленную запись', async () => {
    // Мокируем запрос к базе данных
    const mockData = { id: 1, name: 'Test', description: 'Test description' };
    query.mockResolvedValueOnce({
      rows: [mockData],
    });

    const result = await insertIntoTable('TestTable', {
      name: 'Test',
      description: 'Test description',
    });

    // Проверяем, что функция возвращает ожидаемый результат
    expect(result).toEqual(mockData);

    // Проверяем, что query был вызван с правильными аргументами
    expect(query).toHaveBeenCalledWith(
      'INSERT INTO TestTable (name, description) VALUES ($1, $2) RETURNING *',
      ['Test', 'Test description']
    );
  });

  it('должен выбросить ошибку, если произошла ошибка при вставке', async () => {
    // Мокируем ошибку
    const error = new Error('Ошибка базы данных');
    query.mockRejectedValueOnce(error);

    await expect(
      insertIntoTable('TestTable', {
        name: 'Test',
        description: 'Test description',
      })
    ).rejects.toThrow('Ошибка базы данных');

    // Проверяем, что query был вызван с правильными аргументами
    expect(query).toHaveBeenCalledWith(
      'INSERT INTO TestTable (name, description) VALUES ($1, $2) RETURNING *',
      ['Test', 'Test description']
    );
  });

  it('должен корректно обрабатывать данные с разными типами значений', async () => {
    // Мокируем запрос к базе данных
    const mockData = { id: 1, name: 'Test', age: 25, isActive: true };
    query.mockResolvedValueOnce({
      rows: [mockData],
    });

    const result = await insertIntoTable('TestTable', {
      name: 'Test',
      age: 25,
      isActive: true,
    });

    // Проверяем, что функция возвращает ожидаемый результат
    expect(result).toEqual(mockData);

    // Проверяем, что query был вызван с правильными аргументами
    expect(query).toHaveBeenCalledWith(
      'INSERT INTO TestTable (name, age, isActive) VALUES ($1, $2, $3) RETURNING *',
      ['Test', 25, true]
    );
  });
});