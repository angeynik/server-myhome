// tests/unit/clientStore.test.js
const WebSocket = require('ws');
const {
  nodeRedClients,
  registerClient,
  cleanupConnection,
  getClient,
  getAllClients,
  startHeartbeat
} = require('../../services/clientsStore');

// Используем моки из setup.js
jest.mock('bcryptjs');
jest.mock('jsonwebtoken');

// Мокируем console для чистоты вывода тестов
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

// Дополняем глобальные тестовые данные для WebSocket
global.mockWebSocketData = {
  clientId: 'test-client-123',
  anotherClientId: 'another-client-456',
  adminClientId: 'admin-client-789',
  invalidClientId: 'invalid-client-000'
};

describe('clientsStore', () => {
  let mockWsInput;
  let mockWsOutput;

  beforeEach(() => {
    // Создаем моки WebSocket перед каждым тестом
    mockWsInput = {
      _socket: { remoteAddress: '192.168.1.1' },
      readyState: WebSocket.OPEN,
      on: jest.fn(),
      removeAllListeners: jest.fn(),
      terminate: jest.fn(),
      ping: jest.fn()
    };

    mockWsOutput = {
      _socket: { remoteAddress: '192.168.1.2' },
      readyState: WebSocket.OPEN,
      on: jest.fn(),
      removeAllListeners: jest.fn(),
      terminate: jest.fn(),
      ping: jest.fn()
    };

    // Очищаем хранилище перед каждым тестом
    nodeRedClients.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('registerClient', () => {
    test('должен успешно зарегистрировать input соединение', () => {
      registerClient(global.mockWebSocketData.clientId, mockWsInput, 'input');

      expect(nodeRedClients.has(global.mockWebSocketData.clientId)).toBe(true);
      expect(nodeRedClients.get(global.mockWebSocketData.clientId).input).toBe(mockWsInput);
      expect(nodeRedClients.get(global.mockWebSocketData.clientId).output).toBeNull();
      expect(mockWsInput.on).toHaveBeenCalledWith('close', expect.any(Function));
      expect(mockWsInput.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    test('должен успешно зарегистрировать output соединение', () => {
      registerClient(global.mockWebSocketData.clientId, mockWsOutput, 'output');

      expect(nodeRedClients.has(global.mockWebSocketData.clientId)).toBe(true);
      expect(nodeRedClients.get(global.mockWebSocketData.clientId).output).toBe(mockWsOutput);
      expect(nodeRedClients.get(global.mockWebSocketData.clientId).input).toBeNull();
    });

    test('должен выбросить ошибку при неверном connectionType', () => {
      expect(() => {
        registerClient(global.mockWebSocketData.clientId, mockWsInput, 'invalid-type');
      }).toThrow('registerClient: invalid connectionType "invalid-type"');
    });

    test('должен обновить существующего клиента при регистрации второго соединения', () => {
      // Регистрируем input
      registerClient(global.mockWebSocketData.clientId, mockWsInput, 'input');
      
      // Регистрируем output для того же клиента
      registerClient(global.mockWebSocketData.clientId, mockWsOutput, 'output');

      const client = nodeRedClients.get(global.mockWebSocketData.clientId);
      expect(client.input).toBe(mockWsInput);
      expect(client.output).toBe(mockWsOutput);
    });

    test('должен установить метаданные при регистрации', () => {
      registerClient(global.mockWebSocketData.clientId, mockWsInput, 'input');

      const client = nodeRedClients.get(global.mockWebSocketData.clientId);
      expect(client.meta.registeredAt).toBeDefined();
      expect(client.meta.remoteAddress).toBe('192.168.1.1');
    });

    test('должен установить heartbeat свойства', () => {
      registerClient(global.mockWebSocketData.clientId, mockWsInput, 'input');

      expect(mockWsInput.isAlive).toBe(true);
      expect(mockWsInput.lastActivity).toBeDefined();
      expect(mockWsInput.on).toHaveBeenCalledWith('pong', expect.any(Function));
    });
  });

  describe('cleanupConnection', () => {
    test('должен удалить input соединение и оставить клиента если есть output', () => {
      // Регистрируем оба соединения
      registerClient(global.mockWebSocketData.clientId, mockWsInput, 'input');
      registerClient(global.mockWebSocketData.clientId, mockWsOutput, 'output');

      // Очищаем только input
      cleanupConnection(global.mockWebSocketData.clientId, 'input');

      const client = nodeRedClients.get(global.mockWebSocketData.clientId);
      expect(client.input).toBeNull();
      expect(client.output).toBe(mockWsOutput);
      expect(nodeRedClients.has(global.mockWebSocketData.clientId)).toBe(true);
      expect(mockWsInput.removeAllListeners).toHaveBeenCalled();
      expect(mockWsInput.terminate).toHaveBeenCalled();
    });

    test('должен полностью удалить клиента при очистке последнего соединения', () => {
      // Регистрируем только input
      registerClient(global.mockWebSocketData.clientId, mockWsInput, 'input');

      // Очищаем input
      cleanupConnection(global.mockWebSocketData.clientId, 'input');

      expect(nodeRedClients.has(global.mockWebSocketData.clientId)).toBe(false);
    });

    test('не должен делать ничего при несуществующем клиенте', () => {
      expect(() => {
        cleanupConnection(global.mockWebSocketData.invalidClientId, 'input');
      }).not.toThrow();
    });

    test('не должен делать ничего при несуществующем соединении', () => {
      registerClient(global.mockWebSocketData.clientId, mockWsInput, 'input');
      
      // Пытаемся очистить несуществующее output соединение
      expect(() => {
        cleanupConnection(global.mockWebSocketData.clientId, 'output');
      }).not.toThrow();

      // Клиент должен остаться с input соединением
      expect(nodeRedClients.has(global.mockWebSocketData.clientId)).toBe(true);
    });
  });

  describe('getClient', () => {
    test('должен вернуть правильное соединение', () => {
      registerClient(global.mockWebSocketData.clientId, mockWsInput, 'input');
      registerClient(global.mockWebSocketData.clientId, mockWsOutput, 'output');

      expect(getClient(global.mockWebSocketData.clientId, 'input')).toBe(mockWsInput);
      expect(getClient(global.mockWebSocketData.clientId, 'output')).toBe(mockWsOutput);
    });

    test('должен вернуть undefined для несуществующего клиента', () => {
      expect(getClient(global.mockWebSocketData.invalidClientId, 'input')).toBeUndefined();
    });

    test('должен вернуть null для несуществующего соединения', () => {
      registerClient(global.mockWebSocketData.clientId, mockWsInput, 'input');
      
      const result = getClient(global.mockWebSocketData.clientId, 'output');
      expect(result).not.toBeUndefined();
      expect(result).toBeNull();
    });
  });

  describe('getAllClients', () => {
    test('должен вернуть пустой массив при отсутствии клиентов', () => {
      expect(getAllClients()).toEqual([]);
    });

    test('должен вернуть информацию о всех клиентах', () => {
      registerClient(global.mockWebSocketData.clientId, mockWsInput, 'input');
      registerClient(global.mockWebSocketData.anotherClientId, mockWsOutput, 'output');

      const clients = getAllClients();
      
      expect(clients).toHaveLength(2);
      expect(clients[0].clientId).toBe(global.mockWebSocketData.clientId);
      expect(clients[0].inputReadyState).toBe(WebSocket.OPEN);
      expect(clients[1].clientId).toBe(global.mockWebSocketData.anotherClientId);
      expect(clients[1].outputReadyState).toBe(WebSocket.OPEN);
    });

    test('должен корректно обрабатывать null соединения', () => {
      registerClient(global.mockWebSocketData.clientId, mockWsInput, 'input');
      
      const clients = getAllClients();
      expect(clients[0].outputReadyState).toBeNull();
      expect(clients[0].outputIsAlive).toBeNull();
    });
  });

  describe('startHeartbeat', () => {
    let setIntervalSpy;

    beforeEach(() => {
      jest.useFakeTimers();
      setIntervalSpy = jest.spyOn(global, 'setInterval');
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('должен запустить интервал heartbeat', () => {
      startHeartbeat(30000, 60000);
      
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30000);
    });

    test('должен очищать мертвые соединения по таймауту', () => {
      // Регистрируем клиента с устаревшей активностью
      registerClient(global.mockWebSocketData.clientId, mockWsInput, 'input');
      mockWsInput.lastActivity = Date.now() - 70000; // 70 секунд назад
      mockWsInput.isAlive = false;

      startHeartbeat(30000, 60000);
      
      // Запускаем таймер
      jest.advanceTimersByTime(30000);

      expect(mockWsInput.terminate).toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('heartbeat — test-client-123/input dead, cleaning up')
      );
    });

    test('должен отправлять ping активным соединениям', () => {
      registerClient(global.mockWebSocketData.clientId, mockWsInput, 'input');
      mockWsInput.ping.mockImplementation((data, mask, callback) => callback(null));
      mockWsInput.lastActivity = Date.now() - 10000; // 10 секунд назад
      mockWsInput.isAlive = true;

      startHeartbeat(30000, 60000);
      jest.advanceTimersByTime(30000);

      expect(mockWsInput.ping).toHaveBeenCalled();
      expect(mockWsInput.isAlive).toBe(false);
    });

    test('должен обрабатывать ошибки при ping', () => {
      registerClient(global.mockWebSocketData.clientId, mockWsInput, 'input');
      const pingError = new Error('Ping failed');
      mockWsInput.ping.mockImplementation((data, mask, callback) => callback(pingError));
      mockWsInput.isAlive = true;

      startHeartbeat(30000, 60000);
      jest.advanceTimersByTime(30000);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Ping error for test-client-123/input:'),
        pingError
      );
      expect(mockWsInput.terminate).toHaveBeenCalled();
    });

    test('должен пропускать закрытые соединения', () => {
      registerClient(global.mockWebSocketData.clientId, mockWsInput, 'input');
      mockWsInput.readyState = WebSocket.CLOSED;
      mockWsInput.ping = jest.fn();

      startHeartbeat(30000, 60000);
      jest.advanceTimersByTime(30000);

      expect(mockWsInput.ping).not.toHaveBeenCalled();
    });
  });

  describe('Интеграционные тесты', () => {
    test('должен корректно обрабатывать закрытие соединения через обработчик', () => {
      registerClient(global.mockWebSocketData.clientId, mockWsInput, 'input');
      
      const closeHandler = mockWsInput.on.mock.calls.find(call => call[0] === 'close')[1];
      closeHandler();

      expect(nodeRedClients.has(global.mockWebSocketData.clientId)).toBe(false);
    });

    test('должен корректно обрабатывать ошибку соединения через обработчик', () => {
      registerClient(global.mockWebSocketData.clientId, mockWsInput, 'input');
      
      const errorHandler = mockWsInput.on.mock.calls.find(call => call[0] === 'error')[1];
      errorHandler();

      expect(nodeRedClients.has(global.mockWebSocketData.clientId)).toBe(false);
    });

    test('должен обновлять lastActivity при pong', () => {
      registerClient(global.mockWebSocketData.clientId, mockWsInput, 'input');
      
      const originalLastActivity = mockWsInput.lastActivity;
      
      jest.advanceTimersByTime(10);
      
      const pongHandler = mockWsInput.on.mock.calls.find(call => call[0] === 'pong')[1];
      pongHandler();

      expect(mockWsInput.isAlive).toBe(true);
      expect(mockWsInput.lastActivity).toBeGreaterThan(originalLastActivity);
    });

    test('должен корректно обрабатывать несколько клиентов', () => {
      registerClient(global.mockWebSocketData.clientId, mockWsInput, 'input');
      registerClient(global.mockWebSocketData.anotherClientId, mockWsOutput, 'output');

      expect(nodeRedClients.size).toBe(2);
      expect(getAllClients()).toHaveLength(2);

      cleanupConnection(global.mockWebSocketData.clientId, 'input');
      expect(nodeRedClients.size).toBe(1);
      expect(getAllClients()).toHaveLength(1);
    });

    test('должен использовать глобальные тестовые данные корректно', () => {
      // Проверяем, что глобальные данные доступны
      expect(global.mockUserData.validUser).toBeDefined();
      expect(global.mockUserData.adminUser).toBeDefined();
      expect(global.testRequests.validLogin).toBeDefined();
      expect(global.mockWebSocketData.clientId).toBeDefined();
      expect(global.mockWsHelpersData.successResponse).toBeDefined();
      expect(global.mockDevices.thermostat).toBeDefined();
    });
  });
});