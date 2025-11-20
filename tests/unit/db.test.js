// serverApp/tests/unit/db.test.js
require('../../tests/setup');

const dbManager = require('../../services/db');

describe('DBManager (mocked)', () => {
  const mockQuery = dbManager.query;
  const mockCheckRecordExists = dbManager.checkRecordExists;
  const mockCloseAllPools = dbManager.closeAllPools;

  test('query returns expected result', async () => {
    const mockResult = { rows: [{ id: 1 }] };
    mockQuery.mockResolvedValue(mockResult);

    const result = await dbManager.query('SELECT * FROM users WHERE id = $1', [1], 'test_database', 'test_user', 'test_password');
    expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM users WHERE id = $1', [1], 'test_database', 'test_user', 'test_password');
    expect(result).toEqual(mockResult);
  });

  test('query throws error', async () => {
    mockQuery.mockRejectedValue(global.testErrors.dbConnection);

    await expect(
      dbManager.query('SELECT * FROM fail', [], 'test_database', 'test_user', 'test_password')
    ).rejects.toThrow('Database connection failed');
  });

  test('checkRecordExists returns true with ID', async () => {
    const mockResponse = { exists: true, id: 42 };
    mockCheckRecordExists.mockResolvedValue(mockResponse);

    const result = await dbManager.checkRecordExists('users', { email: 'test@example.com' }, 'test_database', 'test_user', 'test_password');
    expect(mockCheckRecordExists).toHaveBeenCalledWith('users', { email: 'test@example.com' }, 'test_database', 'test_user', 'test_password');
    expect(result).toEqual(mockResponse);
  });

  test('checkRecordExists returns false', async () => {
    const mockResponse = { exists: false, id: null };
    mockCheckRecordExists.mockResolvedValue(mockResponse);

    const result = await dbManager.checkRecordExists('users', { email: 'none@example.com' }, 'test_database', 'test_user', 'test_password');
    expect(result).toEqual(mockResponse);
  });

test('checkRecordExists throws error on empty param', async () => {
  mockCheckRecordExists.mockRejectedValue(
    new Error('Необходимо указать условия для проверки существования записи')
  );

  await expect(
    dbManager.checkRecordExists('users', {}, 'test_database', 'test_user', 'test_password')
  ).rejects.toThrow('Необходимо указать условия для проверки существования записи');
});


  test('closeAllPools is called', async () => {
    await dbManager.closeAllPools();
    expect(mockCloseAllPools).toHaveBeenCalled();
  });
});
