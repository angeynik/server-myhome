// tests/setup.js
const jwt = require('jsonwebtoken');

// Установка тестовых переменных окружения
process.env.JWT_SECRET = 'test-secret-key-for-jwt';
process.env.NODE_ENV = 'test';
process.env.DB_DATABASE = 'test_database';
process.env.DB_USER = 'test_user';
process.env.DB_PASSWORD = 'test_password';

// Глобальные моки
jest.mock('../services/db', () => ({
  findUser: jest.fn(),
  query: jest.fn(),
  checkRecordExists: jest.fn(),
  closeAllPools: jest.fn()
}));

// Глобальные тестовые утилиты
global.generateTestToken = (payload = { id: 1, username: 'testuser' }) => {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
};

global.mockUserData = {
  validUser: {
    id: 1,
    username: 'testuser',
    password: '$2a$10$hashedpassword123', // bcrypt хэш
    userlevel: 1,
    dID: 'test-did-123'
  },
  adminUser: {
    id: 2,
    username: 'admin',
    password: '$2a$10$hashedadmin456',
    userlevel: 9,
    dID: 'admin-did-456'
  }
};

// Глобальные тестовые запросы
global.testRequests = {
  validLogin: {
    username: 'testuser',
    password: 'testpassword123'
  },
  invalidLogin: {
    username: 'nonexistent',
    password: 'wrongpassword'
  },
  missingCredentials: {
    username: '',
    password: ''
  }
};

// Глобальные хуки для очистки
beforeEach(() => {
  // Очистка всех моков перед каждым тестом
  jest.clearAllMocks();
  
  // Сброс localStorage для тестов, если нужно
  if (typeof localStorage !== 'undefined') {
    localStorage.clear();
  }
});

afterAll(() => {
  // Глобальная очистка после всех тестов
  jest.restoreAllMocks();
});

// Глобальные assertion-хелперы
expect.extend({
  toBeValidJwt(received) {
    try {
      jwt.verify(received, process.env.JWT_SECRET);
      return {
        message: () => `expected ${received} not to be a valid JWT`,
        pass: true
      };
    } catch (error) {
      return {
        message: () => `expected ${received} to be a valid JWT: ${error.message}`,
        pass: false
      };
    }
  }
});

// Глобальные ошибки для тестирования
global.testErrors = {
  dbConnection: new Error('Database connection failed'),
  validationError: new Error('Validation failed'),
  authError: new Error('Authentication failed')
};

// Мок для bcrypt
jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('$2a$10$hashedpassword123'),
  compare: jest.fn().mockResolvedValue(true),
  hashSync: jest.fn().mockReturnValue('$2a$10$hashedpassword123'),
  compareSync: jest.fn().mockReturnValue(true)
}));

// Мок для jsonwebtoken
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('mock-jwt-token'),
  verify: jest.fn().mockImplementation((token, secret) => {
    if (token === 'valid-token') {
      return { id: 1, username: 'testuser' };
    }
    throw new Error('Invalid token');
  })
}));

// Глобальные таймауты
jest.setTimeout(20000); // 20 секунд для тестов