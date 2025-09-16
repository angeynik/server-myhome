// tests/setup.js
const jwt = require('jsonwebtoken');

// Установка тестовых переменных окружения
process.env.JWT_SECRET = 'test-secret-key-for-jwt';
process.env.NODE_ENV = 'test';
process.env.DB_DATABASE = 'test_database';
process.env.DB_USER = 'test_user';
process.env.DB_PASSWORD = 'test_password';
process.env.DB_PORT = 5432;

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

// Глобальные тестовые данные для WebSocket
global.mockWebSocketData = {
  clientId: 'test-client-123',
  anotherClientId: 'another-client-456', 
  adminClientId: 'admin-client-789',
  invalidClientId: 'invalid-client-000',
  testIpAddress: '192.168.1.1',
  anotherIpAddress: '192.168.1.2'
};

// Глобальные тестовые WebSocket сообщения
global.mockWebSocketMessages = {
  inputMessage: { type: 'input', data: 'test input data' },
  outputMessage: { type: 'output', data: 'test output data' },
  errorMessage: { type: 'error', message: 'test error' }
};

// Глобальные тестовые данные для WebSocket helpers
global.mockWsHelpersData = {
  successResponse: {
    type: 'response',
    request: 'get',
    name: 'test-device',
    payload: { status: 'success', value: 42 }
  },
  errorResponse: {
    type: 'error', 
    request: 'validation',
    name: 'test-device',
    payload: { message: 'Invalid input', code: 400 }
  },
  requestMessage: {
    type: 'get',
    request: 'set',
    name: 'test-device', 
    payload: { command: 'turn_on' }
  }
};

// Глобальные тестовые устройства
global.mockDevices = {
  thermostat: {
    id: 'thermostat-1',
    name: 'Living Room Thermostat',
    type: 'climate',
    status: { temperature: 22, mode: 'cooling' }
  },
  light: {
    id: 'light-1',
    name: 'Kitchen Light',
    type: 'light',
    status: { on: false, brightness: 0 }
  },
  sensor: {
    id: 'sensor-1',
    name: 'Motion Sensor',
    type: 'sensor',
    status: { motion: false, battery: 85 }
  }
};

// Глобальные таймауты
jest.setTimeout(20000); // 20 секунд для тестов