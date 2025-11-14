// tests/unit/messageHandlers.test.js
const WebSocket = require('ws');
const {
  handlePostNodeRED,
  handleAuth,
  handleGet,
  handlePost,
  handleResponse,
  handleSet,
  handleError
} = require('../../services/messageHandlers');
const DBManager = require('../../services/db');
const { loginUser, verifyToken } = require('../../auth');
const { writeFileSafely, readFileSafely } = require('../../services/configStore');
const { nodeRedClients } = require('../../services/clientsStore');
const wsManager = require('../../classes/wsManager');

// Мокируем все зависимости
jest.mock('../../services/db');
jest.mock('../../auth');
jest.mock('../../services/configStore');
jest.mock('../../services/clientsStore');
jest.mock('../../classes/wsManager');
jest.mock('jsonwebtoken');
jest.mock('bcryptjs');

// Мокируем logger
jest.mock('../../services/logger.js', () => ({
  logDevMessage: jest.fn(),
  logInfoMessage: jest.fn(),
  logErrorMessage: jest.fn()
}));
const logger = require('../../services/logger.js');

// Мокируем tableDB
jest.mock('../../services/tableDB', () => ({
  registerUser: jest.fn(),
  linkDataSourceToUser: jest.fn()
}));
const tableDB = require('../../services/tableDB');

describe('messageHandlers', () => {
  let mockWs;
  let mockClientId;

  beforeEach(() => {
    // Создаем mock WebSocket и clientId
    mockWs = {
      send: jest.fn(),
      readyState: WebSocket.OPEN
    };

    mockClientId = global.mockWebSocketData.clientId;

    // Настраиваем моки
    jest.clearAllMocks();
    
    // Моки для клиентов store
    nodeRedClients.get = jest.fn().mockReturnValue({ output: mockWs });
    
    // Моки для auth
    loginUser.mockResolvedValue({
      success: true,
      token: 'mock-jwt-token',
      username: 'testuser',
      userlevel: 1,
      dID: 'test-did-123'
    });

    // Моки для configStore
    readFileSafely.mockResolvedValue({
      data: global.mockConfigData.validConfig,
      dataDir: process.env.DATA_DIR,
      filePath: `${process.env.DATA_DIR}/test-device-123.json`
    });

    writeFileSafely.mockResolvedValue();

    // Моки для DBManager методов
    DBManager.fetchUsers = jest.fn();
    DBManager.fetchDataSources = jest.fn();
    DBManager.createDB = jest.fn();
    DBManager.createTableDID = jest.fn();
    DBManager.query = jest.fn();
    DBManager.checkTableExists = jest.fn();
    DBManager.checkRecordExists = jest.fn();

    // Моки для wsManager
    wsManager.sendToConnection = jest.fn();
    wsManager.updateConnection = jest.fn();
  });

  describe('handlePostNodeRED', () => {
    test('должен успешно обрабатывать запрос sensor от NodeRED', async () => {
      const message = {
        name: 'test-device-123',
        request: 'sensor',
        payload: {
          room: 'living_room',
          item_name: 'temperature',
          item_value: 22.5,
          item_type: 'number',
          title: 'Living Room',
          group: 'climate'
        }
      };

      const result = await handlePostNodeRED(mockClientId, message);

      expect(result).toBe('ok');
      expect(readFileSafely).toHaveBeenCalledWith('test-device-123');
      expect(writeFileSafely).toHaveBeenCalled();
    });

    test('должен создавать новую комнату если она не существует', async () => {
      const message = {
        name: 'test-device-123',
        request: 'sensor',
        payload: {
          room: 'new_room',
          item_name: 'humidity',
          item_value: 45,
          item_type: 'number'
        }
      };

      const result = await handlePostNodeRED(mockClientId, message);

      expect(result).toBe('ok');
      expect(writeFileSafely).toHaveBeenCalled();
    });

    test('должен возвращать ошибку при отсутствии обязательных полей', async () => {
      const message = {
        name: 'test-device-123',
        request: 'sensor',
        payload: {
          room: '',
          item_name: '',
          item_value: undefined
        }
      };

      await expect(handlePostNodeRED(mockClientId, message))
        .rejects
        .toThrow('Missing required fields');
    });
  });

  describe('handleAuth', () => {
    test('должен успешно обрабатывать login запрос', async () => {
      const data = {
        request: 'login',
        name: 'test-device',
        payload: {
          username: 'testuser',
          password: 'testpassword123'
        }
      };

      await handleAuth(mockClientId, data);

      expect(loginUser).toHaveBeenCalledWith('testuser', 'testpassword123');
      expect(wsManager.updateConnection).toHaveBeenCalledWith(
        'VUE_connections',
        mockClientId,
        expect.any(Number),
        'test-did-123'
      );
      expect(wsManager.sendToConnection).toHaveBeenCalledWith(
        'VUE_connections',
        mockClientId,
        'response',
        'loginSuccess',
        'test-did-123',
        expect.objectContaining({
          token: 'mock-jwt-token',
          username: 'testuser',
          userlevel: 1
        })
      );
    });

    test('должен отправлять ошибку при неудачном login', async () => {
      loginUser.mockResolvedValueOnce({
        error: 'Invalid credentials',
        code: 'AUTH_ERROR',
        dID: 'test-device'
      });

      const data = {
        request: 'login',
        name: 'test-device',
        payload: {
          username: 'testuser',
          password: 'wrongpassword'
        }
      };

      await handleAuth(mockClientId, data);

      expect(wsManager.sendToConnection).toHaveBeenCalledWith(
        'VUE_connections',
        mockClientId,
        'error',
        'loginError',
        'test-device',
        expect.objectContaining({
          code: 'AUTH_ERROR',
          message: 'Invalid credentials'
        })
      );
    });
  });

  describe('handleGet', () => {
    test('должен успешно обрабатывать fetchUsers запрос', async () => {
      const mockUsers = [{ id: 1, username: 'user1' }, { id: 2, username: 'user2' }];
      DBManager.fetchUsers.mockResolvedValue(mockUsers);

      const data = {
        request: 'fetchUsers',
        name: 'test-device'
      };

      await handleGet(mockClientId, data);

      expect(DBManager.fetchUsers).toHaveBeenCalled();
      expect(wsManager.sendToConnection).toHaveBeenCalledWith(
        'VUE_connections',
        mockClientId,
        'response',
        'fetchUsersSuccess',
        'test-device',
        { users: mockUsers }
      );
    });

    test('должен успешно обрабатывать config запрос', async () => {
      const data = {
        request: 'config',
        name: 'test-device-123'
      };

      await handleGet(mockClientId, data);

      expect(readFileSafely).toHaveBeenCalledWith('test-device-123');
      expect(wsManager.sendToConnection).toHaveBeenCalledWith(
        'VUE_connections',
        mockClientId,
        'response',
        'config',
        'test-device-123',
        global.mockConfigData.validConfig
      );
    });

    test('должен отправлять ошибку при отсутствии имени конфига', async () => {
      const data = {
        request: 'config',
        name: null
      };

      await handleGet(mockClientId, data);

      expect(wsManager.sendToConnection).toHaveBeenCalledWith(
        'VUE_connections',
        mockClientId,
        'error',
        'configError',
        null,
        expect.objectContaining({
          message: '[messageHandlers] - Не указано имя конфига в запросе',
          code: 'config_read_error'
        })
      );
    });
  });

  describe('handlePost', () => {
    test('должен успешно обрабатывать createUser запрос', async () => {
      const mockNewUser = { id: 3, username: 'newuser' };
      tableDB.registerUser.mockResolvedValue({ user: mockNewUser });

      DBManager.createDB.mockResolvedValue();
      DBManager.createTableDID.mockResolvedValue();

      const data = {
        request: 'createUser',
        name: 'test-device',
        payload: {
          username: 'newuser',
          password: 'password123',
          dataSource: 'new_db',
          permissionLevel: 1
        }
      };

      await handlePost(mockClientId, data);

      expect(tableDB.registerUser).toHaveBeenCalled();
      expect(DBManager.createDB).toHaveBeenCalled();
      expect(DBManager.createTableDID).toHaveBeenCalled();
      expect(wsManager.sendToConnection).toHaveBeenCalledWith(
        'VUE_connections',
        mockClientId,
        'response',
        'createUserSuccess',
        'test-device',
        { user: mockNewUser }
      );
    });

    test('должен обрабатывать setpoint запрос', async () => {
      const data = {
        request: 'setpoints',
        name: 'test-device-123',
        payload: {
          room: 'living_room',
          param: 'target_temperature',
          value: 24
        }
      };

      await handlePost(mockClientId, data);

      expect(readFileSafely).toHaveBeenCalledWith('test-device-123');
      expect(writeFileSafely).toHaveBeenCalled();
    });
  });

  describe('handleResponse', () => {
    test('должен успешно обрабатывать config response', async () => {
      const configData = global.mockConfigData.validConfig;
      const data = {
        request: 'config',
        name: 'test-device-123',
        payload: { thermostat: configData }
      };

      DBManager.checkRecordExists.mockResolvedValue({ exists: false });
      DBManager.query.mockResolvedValue({
        rows: [{ id: 1, name: 'thermostat', update_date: new Date() }]
      });

      await handleResponse(mockClientId, data);

      expect(DBManager.checkRecordExists).toHaveBeenCalled();
      expect(DBManager.query).toHaveBeenCalled();
      expect(wsManager.sendToConnection).toHaveBeenCalledWith(
        'nRED_connections',
        mockClientId,
        'response',
        'configSaved',
        'test-device-123',
        expect.any(Object)
      );
    });

    test('должен отправлять configExists если конфиг уже существует', async () => {
      const data = {
        request: 'config',
        name: 'test-device-123',
        payload: { thermostat: global.mockConfigData.validConfig }
      };

      DBManager.checkRecordExists.mockResolvedValue({ exists: true, id: 42 });

      await handleResponse(mockClientId, data);

      expect(wsManager.sendToConnection).toHaveBeenCalledWith(
        'nRED_connections',
        mockClientId,
        'response',
        'configExists',
        'test-device-123',
        expect.objectContaining({
          exists: true,
          id: 42
        })
      );
    });
  });

  describe('handleSet и handleError', () => {
    test('handleSet должен логировать вызов', async () => {
      const data = { request: 'test' };

      await handleSet(mockClientId, data);

      expect(logger.logDevMessage).toHaveBeenCalledWith(
        '[messageHandlers] - handleSet - Переходим к проверке сообщения типа set.'
      );
    });

    test('handleError должен логировать вызов', async () => {
      const data = { request: 'test' };

      await handleError(mockClientId, data);

      expect(logger.logDevMessage).toHaveBeenCalledWith(
        '[messageHandlers] - handleError - Переходим к проверке сообщения типа Error'
      );
    });
  });

  describe('Интеграционные тесты с глобальными данными', () => {
    test('должен использовать глобальные mock данные для config', async () => {
      const data = {
        request: 'config',
        name: global.mockDeviceIDs[0] // thermostat-living-room
      };

      await handleGet(mockClientId, data);

      expect(readFileSafely).toHaveBeenCalledWith(global.mockDeviceIDs[0]);
    });

    test('должен использовать глобальные mock данные для auth', async () => {
      const data = {
        request: 'login',
        name: 'test-device',
        payload: global.testRequests.validLogin
      };

      await handleAuth(mockClientId, data);

      expect(loginUser).toHaveBeenCalledWith(
        global.testRequests.validLogin.username,
        global.testRequests.validLogin.password
      );
    });

    test('должен обрабатывать различные device IDs', async () => {
      for (const deviceId of global.mockDeviceIDs.slice(0, 3)) {
        const data = {
          request: 'config',
          name: deviceId
        };

        await handleGet(mockClientId, data);
        expect(readFileSafely).toHaveBeenCalledWith(deviceId);
      }
    });
  });

  describe('Обработка ошибок', () => {
    test('должен обрабатывать ошибки БД в handleGet', async () => {
      DBManager.fetchUsers.mockRejectedValue(new Error('Database error'));

      const data = {
        request: 'fetchUsers',
        name: 'test-device'
      };

      await handleGet(mockClientId, data);

      expect(wsManager.sendToConnection).toHaveBeenCalledWith(
        'VUE_connections',
        mockClientId,
        'error',
        'fetchUsersError',
        'test-device',
        expect.objectContaining({
          message: 'Database error'
        })
      );
    });

    test('должен обрабатывать ошибки чтения конфига', async () => {
      readFileSafely.mockRejectedValue(new Error('File read error'));

      const data = {
        request: 'config',
        name: 'test-device-123'
      };

      await handleGet(mockClientId, data);

      expect(wsManager.sendToConnection).toHaveBeenCalledWith(
        'VUE_connections',
        mockClientId,
        'error',
        'configError',
        'test-device-123',
        expect.objectContaining({
          message: 'File read error'
        })
      );
    });
  });
});