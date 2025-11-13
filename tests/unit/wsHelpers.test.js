// tests/unit/wsManager.test.js
const wsManager = require('../../classes/wsManager');

// Выносим тестовые данные в отдельные константы
const TEST_DATA = {
  DASHBOARD: {
    type: 'dashboard',
    dID: 'test-dashboard-123',
    key: 'dashboard-key'
  },
  NODERED: {
    type: 'nodeRED',
    dID: 'test-nodered-456', 
    key: 'nodered-key'
  },
  ADDRESSES: {
    LOCALHOST: '127.0.0.1:12345',
    LOCALHOST_IPV6: '::ffff:127.0.0.1:12345',
    REMOTE: '192.168.1.100:54321'
  }
};

// Улучшенная фабрика для создания mock WebSocket
function createTestWebSocket(overrides = {}) {
  const defaults = {
    _socket: {
      remoteAddress: '127.0.0.1',
      remotePort: '12345'
    },
    readyState: 1, // WebSocket.OPEN
    isAlive: true,
    lastActivity: null,
    on: jest.fn(),
    ping: jest.fn(),
    terminate: jest.fn(),
    send: jest.fn()
  };

  // Глубокое слияние объектов
  return {
    ...defaults,
    ...overrides,
    _socket: {
      ...defaults._socket,
      ...(overrides._socket || {})
    }
  };
}

// Вспомогательные функции для тестов
const TestHelpers = {
  createDashboardConnection: (wsManager, overrides = {}) => {
    const ws = createTestWebSocket(overrides.ws);
    const options = {
      ...TEST_DATA.DASHBOARD,
      ...overrides.options
    };
    const clientId = wsManager.registerConnection(
      ws, 
      options.type, 
      options.dID, 
      options.key
    );
    return { ws, clientId, options };
  },

  createNodeREDConnection: (wsManager, overrides = {}) => {
    const ws = createTestWebSocket(overrides.ws);
    const options = {
      ...TEST_DATA.NODERED,
      ...overrides.options
    };
    const clientId = wsManager.registerConnection(
      ws, 
      options.type, 
      options.dID, 
      options.key
    );
    return { ws, clientId, options };
  },

  // Проверка что соединение активно и правильно зарегистрировано
  validateConnection: (wsManager, clientId, expectedType, expectedDID, expectedKey = null) => {
    const collection = expectedType === 'dashboard' ? 'VUE_connections' : 'nRED_connections';
    const connection = wsManager[collection].get(clientId);
    
    expect(connection).toBeDefined();
    expect(connection.connectionType).toBe(expectedType);
    expect(connection.dID).toBe(expectedDID);
    if (expectedKey) {
      expect(connection.key).toBe(expectedKey);
    }
    expect(connection.meta.clientId).toBe(clientId);
    expect(wsManager.isConnectionActive(collection, clientId)).toBe(true);
    
    return connection;
  }
};

describe('WsManager', () => {
  let wsManager;

  beforeEach(() => {
    wsManager = new wsManager();
    // Мокаем console.log чтобы не засорять вывод тестов
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    wsManager.cleanup('VUE_connections');
    wsManager.cleanup('nRED_connections');
  });

  describe('registerConnection', () => {
    describe('Успешная регистрация', () => {
      test('should register a new dashboard connection with helper', () => {
        // Act
        const { ws, clientId, options } = TestHelpers.createDashboardConnection(wsManager);

        // Assert
        expect(clientId).toBeDefined();
        TestHelpers.validateConnection(wsManager, clientId, options.type, options.dID, options.key);
        
        // Проверяем что установлены обработчики
        expect(ws.on).toHaveBeenCalledWith('pong', expect.any(Function));
        expect(ws.on).toHaveBeenCalledWith('close', expect.any(Function));
        expect(ws.on).toHaveBeenCalledWith('error', expect.any(Function));
      });

      test('should register a new nodeRED connection with helper', () => {
        // Act
        const { clientId, options } = TestHelpers.createNodeREDConnection(wsManager);

        // Assert
        expect(clientId).toBeDefined();
        TestHelpers.validateConnection(wsManager, clientId, options.type, options.dID, options.key);
      });

      test('should handle different remote addresses correctly', () => {
        // Arrange
        const remoteAddresses = [
          '192.168.1.100:54321',
          '10.0.0.5:8080',
          '::ffff:127.0.0.1:3000'
        ];

        remoteAddresses.forEach((address, index) => {
          const [ip, port] = address.split(':');
          const ws = createTestWebSocket({
            _socket: { remoteAddress: ip, remotePort: port }
          });

          // Act
          const clientId = wsManager.registerConnection(
            ws, 
            'dashboard', 
            `device-${index}`
          );

          // Assert
          const connection = wsManager.VUE_connections.get(clientId);
          expect(connection.meta.remoteAddress).toBe(address);
        });
      });
    });

    describe('Валидация и ошибки', () => {
      test('should return error for invalid connectionType', () => {
        // Arrange
        const ws = createTestWebSocket();
        const invalidType = 'invalid-type';

        // Act
        const result = wsManager.registerConnection(ws, invalidType);

        // Assert
        expect(result).toBe('Invalid connectionType');
        expect(wsManager.VUE_connections.size).toBe(0);
        expect(wsManager.nRED_connections.size).toBe(0);
      });

      test('should handle WebSocket without remote address', () => {
        // Arrange
        const ws = createTestWebSocket({
          _socket: null
        });

        // Act
        const clientId = wsManager.registerConnection(ws, 'dashboard', 'test-device');

        // Assert
        expect(clientId).toBeDefined();
        const connection = wsManager.VUE_connections.get(clientId);
        expect(connection.meta.remoteAddress).toBe('unknown:unknown');
      });
    });

    describe('Предотвращение дубликатов', () => {
      test('should return existing clientId for duplicate connection', () => {
        // Arrange
        const { clientId: firstClientId, options } = TestHelpers.createDashboardConnection(wsManager);
        
        // Act - пытаемся зарегистрировать дубликат
        const ws2 = createTestWebSocket(); // тот же адрес и порт
        const secondClientId = wsManager.registerConnection(
          ws2, 
          options.type, 
          options.dID, 
          options.key
        );

        // Assert
        expect(secondClientId).toBe(firstClientId);
        expect(wsManager.VUE_connections.size).toBe(1);
      });

      test('should allow different connections with different dID', () => {
        // Act
        const { clientId: client1 } = TestHelpers.createDashboardConnection(wsManager, {
          options: { dID: 'device-1' }
        });
        
        const { clientId: client2 } = TestHelpers.createDashboardConnection(wsManager, {
          options: { dID: 'device-2' }
        });

        // Assert
        expect(client1).not.toBe(client2);
        expect(wsManager.VUE_connections.size).toBe(2);
      });

      test('should allow same dID but different remote addresses', () => {
        // Arrange
        const { clientId: client1 } = TestHelpers.createDashboardConnection(wsManager, {
          ws: { _socket: { remoteAddress: '192.168.1.100', remotePort: '12345' } }
        });

        // Act
        const { clientId: client2 } = TestHelpers.createDashboardConnection(wsManager, {
          ws: { _socket: { remoteAddress: '192.168.1.101', remotePort: '12346' } },
          options: { dID: 'device-1' } // тот же dID, но другой адрес
        });

        // Assert
        expect(client1).not.toBe(client2);
        expect(wsManager.VUE_connections.size).toBe(2);
      });
    });

    describe('Метаданные соединения', () => {
      test('should set correct metadata for new connection', () => {
        // Act
        const { ws, clientId } = TestHelpers.createDashboardConnection(wsManager);

        // Assert
        const connection = wsManager.VUE_connections.get(clientId);
        expect(connection.meta.clientId).toBe(clientId);
        expect(connection.meta.registeredAt).toBeDefined();
        expect(typeof connection.meta.registeredAt).toBe('number');
        expect(connection.meta.lastActivity).toBeDefined();
        expect(connection.meta.isAlive).toBe(true);
        expect(connection.meta.remoteAddress).toBe(TEST_DATA.ADDRESSES.LOCALHOST);
      });

      test('should initialize WebSocket handlers and flags', () => {
        // Arrange
        const ws = createTestWebSocket();

        // Act
        wsManager.registerConnection(ws, 'dashboard', 'test-device');

        // Assert
        expect(ws.isAlive).toBe(true);
        expect(ws.lastActivity).toBeDefined();
        expect(ws.on).toHaveBeenCalledTimes(3); // pong, close, error
      });
    });
  });
});