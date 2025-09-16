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

// Мокируем console.log и console.error для чистоты вывода тестов
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

describe('clientsStore', () => {
  let mockWsInput;
  let mockWsOutput;
  const clientId = 'test-client-123';
  const anotherClientId = 'another-client-456';

  beforeEach(() => {
    // Создаем моки WebSocket перед каждым тестом
    mockWsInput = {
      _socket: { remoteAddress: '192.168.1.1' },
      readyState: WebSocket.OPEN,
      on: jest.fn(),
      removeAllListeners: jest.fn(),
      terminate: jest.fn(),
      ping: jest.fn() // Добавляем mock ping
    };

    mockWsOutput = {
      _socket: { remoteAddress: '192.168.1.2' },
      readyState: WebSocket.OPEN,
      on: jest.fn(),
      removeAllListeners: jest.fn(),
      terminate: jest.fn(),
      ping: jest.fn() // Добавляем mock ping
    };

    // Очищаем хранилище перед каждым тестом
    nodeRedClients.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('registerClient', () => {
    test('должен успешно зарегистрировать input соединение', () => {
      registerClient(clientId, mockWsInput, 'input');

      expect(nodeRedClients.has(clientId)).toBe(true);
      expect(nodeRedClients.get(clientId).input).toBe(mockWsInput);
      expect(nodeRedClients.get(clientId).output).toBeNull();
      expect(mockWsInput.on).toHaveBeenCalledWith('close', expect.any(Function));
      expect(mockWsInput.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    test('должен успешно зарегистрировать output соединение', () => {
      registerClient(clientId, mockWsOutput, 'output');

      expect(nodeRedClients.has(clientId)).toBe(true);
      expect(nodeRedClients.get(clientId).output).toBe(mockWsOutput);
      expect(nodeRedClients.get(clientId).input).toBeNull();
    });

    test('должен выбросить ошибку при неверном connectionType', () => {
      expect(() => {
        registerClient(clientId, mockWsInput, 'invalid-type');
      }).toThrow('registerClient: invalid connectionType "invalid-type"');
    });

    test('должен обновить существующего клиента при регистрации второго соединения', () => {
      // Регистрируем input
      registerClient(clientId, mockWsInput, 'input');
      
      // Регистрируем output для того же клиента
      registerClient(clientId, mockWsOutput, 'output');

      const client = nodeRedClients.get(clientId);
      expect(client.input).toBe(mockWsInput);
      expect(client.output).toBe(mockWsOutput);
    });

    test('должен установить метаданные при регистрации', () => {
      registerClient(clientId, mockWsInput, 'input');

      const client = nodeRedClients.get(clientId);
      expect(client.meta.registeredAt).toBeDefined();
      expect(client.meta.remoteAddress).toBe('192.168.1.1');
    });

    test('должен установить heartbeat свойства', () => {
      registerClient(clientId, mockWsInput, 'input');

      expect(mockWsInput.isAlive).toBe(true);
      expect(mockWsInput.lastActivity).toBeDefined();
      expect(mockWsInput.on).toHaveBeenCalledWith('pong', expect.any(Function));
    });
  });

  describe('cleanupConnection', () => {
    test('должен удалить input соединение и оставить клиента если есть output', () => {
      // Регистрируем оба соединения
      registerClient(clientId, mockWsInput, 'input');
      registerClient(clientId, mockWsOutput, 'output');

      // Очищаем только input
      cleanupConnection(clientId, 'input');

      const client = nodeRedClients.get(clientId);
      expect(client.input).toBeNull();
      expect(client.output).toBe(mockWsOutput);
      expect(nodeRedClients.has(clientId)).toBe(true);
      expect(mockWsInput.removeAllListeners).toHaveBeenCalled();
      expect(mockWsInput.terminate).toHaveBeenCalled();
    });

    test('должен полностью удалить клиента при очистке последнего соединения', () => {
      // Регистрируем только input
      registerClient(clientId, mockWsInput, 'input');

      // Очищаем input
      cleanupConnection(clientId, 'input');

      expect(nodeRedClients.has(clientId)).toBe(false);
    });

    test('не должен делать ничего при несуществующем клиенте', () => {
      expect(() => {
        cleanupConnection('non-existent-client', 'input');
      }).not.toThrow();
    });

    test('не должен делать ничего при несуществующем соединении', () => {
      registerClient(clientId, mockWsInput, 'input');
      
      // Пытаемся очистить несуществующее output соединение
      expect(() => {
        cleanupConnection(clientId, 'output');
      }).not.toThrow();

      // Клиент должен остаться с input соединением
      expect(nodeRedClients.has(clientId)).toBe(true);
    });
  });

  describe('getClient', () => {
    test('должен вернуть правильное соединение', () => {
      registerClient(clientId, mockWsInput, 'input');
      registerClient(clientId, mockWsOutput, 'output');

      expect(getClient(clientId, 'input')).toBe(mockWsInput);
      expect(getClient(clientId, 'output')).toBe(mockWsOutput);
    });

    test('должен вернуть undefined для несуществующего клиента', () => {
      expect(getClient('non-existent-client', 'input')).toBeUndefined();
    });

    test('должен вернуть null для несуществующего соединения', () => {
      registerClient(clientId, mockWsInput, 'input');
      
      // Функция возвращает null для несуществующего соединения
      const result = getClient(clientId, 'output');
      expect(result).toBeNull(); // Изменено с toBeUndefined() на toBeNull()
    });
  });

  describe('getAllClients', () => {
    test('должен вернуть пустой массив при отсутствии клиентов', () => {
      expect(getAllClients()).toEqual([]);
    });

    test('должен вернуть информацию о всех клиентах', () => {
      registerClient(clientId, mockWsInput, 'input');
      registerClient(anotherClientId, mockWsOutput, 'output');

      const clients = getAllClients();
      
      expect(clients).toHaveLength(2);
      expect(clients[0].clientId).toBe(clientId);
      expect(clients[0].inputReadyState).toBe(WebSocket.OPEN);
      expect(clients[1].clientId).toBe(anotherClientId);
      expect(clients[1].outputReadyState).toBe(WebSocket.OPEN);
    });

    test('должен корректно обрабатывать null соединения', () => {
      registerClient(clientId, mockWsInput, 'input');
      
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
      registerClient(clientId, mockWsInput, 'input');
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
      registerClient(clientId, mockWsInput, 'input');
      mockWsInput.ping.mockImplementation((data, mask, callback) => callback(null));
      mockWsInput.lastActivity = Date.now() - 10000; // 10 секунд назад
      mockWsInput.isAlive = true;

      startHeartbeat(30000, 60000);
      jest.advanceTimersByTime(30000);

      expect(mockWsInput.ping).toHaveBeenCalled();
      expect(mockWsInput.isAlive).toBe(false); // Должен быть сброшен перед ping
    });

    test('должен обрабатывать ошибки при ping', () => {
      registerClient(clientId, mockWsInput, 'input');
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
      registerClient(clientId, mockWsInput, 'input');
      mockWsInput.readyState = WebSocket.CLOSED; // Закрытое соединение
      mockWsInput.ping = jest.fn(); // Убедимся, что ping - это mock функция

      startHeartbeat(30000, 60000);
      jest.advanceTimersByTime(30000);

      // Закрытые соединения не должны получать ping
      expect(mockWsInput.ping).not.toHaveBeenCalled();
    });

    test('должен пропускать несуществующие соединения', () => {
      // Регистрируем клиента только с input
      registerClient(clientId, mockWsInput, 'input');
      mockWsInput.ping = jest.fn();

      startHeartbeat(30000, 60000);
      jest.advanceTimersByTime(30000);

      // Output соединение не существует, поэтому ping не должен вызываться для него
      expect(mockWsInput.ping).toHaveBeenCalled(); // Но input должен получить ping
    });
  });

  describe('Интеграционные тесты', () => {
    test('должен корректно обрабатывать закрытие соединения через обработчик', () => {
      registerClient(clientId, mockWsInput, 'input');
      
      // Симулируем вызов обработчика close
      const closeHandler = mockWsInput.on.mock.calls.find(call => call[0] === 'close')[1];
      closeHandler();

      expect(nodeRedClients.has(clientId)).toBe(false);
    });

    test('должен корректно обрабатывать ошибку соединения через обработчик', () => {
      registerClient(clientId, mockWsInput, 'input');
      
      // Симулируем вызов обработчика error
      const errorHandler = mockWsInput.on.mock.calls.find(call => call[0] === 'error')[1];
      errorHandler();

      expect(nodeRedClients.has(clientId)).toBe(false);
    });

    test('должен обновлять lastActivity при pong', () => {
      registerClient(clientId, mockWsInput, 'input');
      
      const originalLastActivity = mockWsInput.lastActivity;
      
      // Даем немного времени, чтобы гарантировать разницу во времени
      jest.advanceTimersByTime(10);
      
      // Симулируем pong
      const pongHandler = mockWsInput.on.mock.calls.find(call => call[0] === 'pong')[1];
      pongHandler();

      expect(mockWsInput.isAlive).toBe(true);
      expect(mockWsInput.lastActivity).toBeGreaterThan(originalLastActivity);
    });

    test('должен корректно обрабатывать несколько клиентов', () => {
      // Регистрируем несколько клиентов
      registerClient(clientId, mockWsInput, 'input');
      registerClient(anotherClientId, mockWsOutput, 'output');

      expect(nodeRedClients.size).toBe(2);
      expect(getAllClients()).toHaveLength(2);

      // Очищаем один клиент
      cleanupConnection(clientId, 'input');
      expect(nodeRedClients.size).toBe(1);
      expect(getAllClients()).toHaveLength(1);
    });
  });
});