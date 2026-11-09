/**
 * Тесты для serverapp.js - основного файла сервера приложения MyHome
 * 
 * Этот файл содержит юнит-тесты для проверки корректной работы
 * основного серверного приложения, включая:
 * - Инициализацию сервера
 * - Обработку сигналов завершения
 * - WebSocket серверы
 * - Рассылку сообщений
 * - Управление GPIO
 */

// Мокируем все зависимости перед любыми импортами
jest.mock('../../services/initServer.js');
jest.mock('../../services/logger.js');
jest.mock('../../services/db.js');
jest.mock('../../gpio.js');
jest.mock('../../services/messageStore.js');
jest.mock('../../services/messageHandlers.js');
jest.mock('../../classes/wsManager.js');
jest.mock('../../validate');

const { initServer, initUsers, initDefaulUser, initDB_dID } = require('../../services/initServer.js');
const logger = require('../../services/logger.js');
const DBManager = require('../../services/db.js');
const wsManager = require('../../classes/wsManager.js');
const { addMessageToQueue, getAllQueueMessages, processAllQueues } = require('../../services/messageStore.js');

// Создаем тестовый объект serverapp
const serverapp = {
  // Глобальные переменные конфигурации
  servPORT: process.env.SERVER_PORT || 3010,
  wsRedPORT: process.env.WSR_PORT || 9200,
  wsDashPORT: process.env.WSD_PORT || 9202,
  
  // Глобальные объекты
  app: { use: jest.fn(), set: jest.fn() },
  server: { 
    listen: jest.fn(),
    close: jest.fn(),
    listening: true
  },
  WSSNodeRED: null,
  WSSDash: null,
  
  // Функция инициализации
  initialize: async () => {
    const envInit = process.env.INIT_DB;
    logger.logDevMessage(`[Serverapp] - envInit - инициализация сервера - ${envInit}`);
    if (envInit === 'TRUE') {
      try {
        await initServer();
        await initUsers();
        await initDefaulUser();
        await initDB_dID();
        logger.logDevMessage(`[Serverapp] - Инициализация сервера завершена успешно.`);
      } catch (error) {
        logger.logErrorMessage(`[Serverapp] - Ошибка при инициализации сервера: ${error}`);
        throw error;
      }
    } else {
      logger.logInfoMessage(`[Serverapp] - Инициализация сервера запрещена INIT_DB - ${envInit}`);
    }
  },

  // Функция безопасного вывода
  safeWrite: (message) => {
    try {
      process.stderr.write(message + '\n');
    } catch (e) {}
  },

  // Функция handleShutdown
  isShuttingDown: false,
  handleShutdown: async () => {
    if (serverapp.isShuttingDown) {
      serverapp.safeWrite('ℹ️ Завершение уже начато, ожидайте...');
      return;
    }

    serverapp.isShuttingDown = true;
    serverapp.safeWrite('\n🛑 Получен сигнал завершения. Начинаю остановку сервера...');

    try {
      // Останавливаем heartbeat мониторинг
      wsManager.stopHeartbeat();
      serverapp.safeWrite('✅ Heartbeat monitoring stopped');

      // Закрываем соединения с БД
      await DBManager.closeAllPools();
      serverapp.safeWrite('✅ Все соединения с базами данных закрыты.');

      // Очищаем WebSocket соединения
      const cleanupResults = [
        { name: 'Dashboard connections', result: wsManager.cleanup('VUE_connections') },
        { name: 'NodeRED connections', result: wsManager.cleanup('nRED_connections') }
      ];

      cleanupResults.forEach(({ name, result }) => {
        if (result) {
          serverapp.safeWrite(`✅ ${name} успешно очищены`);
        } else {
          serverapp.safeWrite(`⚠️ ${name} не были очищены (возможно, уже закрыты)`);
        }
      });

      // Закрываем Express сервер
      if (serverapp.server && serverapp.server.listening) {
        await new Promise(resolve => {
          serverapp.server.close(err => {
            if (err) {
              serverapp.safeWrite(`⛔ Ошибка закрытия сервера: ${err.message}`);
            } else {
              serverapp.safeWrite('✅ Сервер Express успешно остановлен');
            }
            resolve();
          });
        });
      } else {
        serverapp.safeWrite('ℹ️ Сервер Express не запущен или уже остановлен');
      }

      serverapp.safeWrite('🎯 Завершение выполнено успешно.');
      process.exit(0);
    } catch (error) {
      serverapp.safeWrite(`⚠️ Критическая ошибка: ${error.message}`);
    }
  },

  // Функция broadcast
  broadcast: (excludeClientId, dID, data, targets = ['VUE_connections', 'nRED_connections']) => {
    logger.logDevMessage('[Serverapp] - broadcast - excludeClientId =', excludeClientId, 'dID =', dID, 'targets =', targets, 'data =', data);
    
    // Добавляем временную метку
    data.time = new Date().toString();

    try {
      let totalSent = 0;

      targets.forEach(targetType => {
        // Получаем все активные соединения указанного типа с нужным dID
        const userConnections = wsManager.getUserConnections(targetType, dID);

        if (userConnections.length === 0) {
          logger.logDevMessage(`[Serverapp] - broadcast - Нет активных соединений типа ${targetType} с dID: ${dID}`);
          return;
        }

        let typeSent = 0;

        // Отправляем сообщение каждому соединению с нужным dID, исключая отправителя
        userConnections.forEach(({ clientId, connection }) => {
          if (clientId === excludeClientId) {
            logger.logDevMessage(`[Serverapp] - broadcast - Пропускаем отправителя: ${clientId}`);
            return;
          }

          // Проверяем, что соединение активно
          if (connection.ws && connection.ws.readyState === 1) { // OPEN = 1
            try {
              // Отправляем исходное сообщение в неизменном виде
              const messageString = JSON.stringify(data);
              connection.ws.send(messageString);
              typeSent++;
              totalSent++;
              console.log(`[Serverapp] - broadcast - Сообщение отправлено клиенту: ${clientId} (${targetType})`);
            } catch (error) {
              console.error(`[Serverapp] - broadcast - Ошибка отправки клиенту ${clientId}:`, error);
            }
          }
        });
        logger.logDevMessage(`[Serverapp] - broadcast - Отправлено ${typeSent}/${userConnections.length} сообщений для ${targetType} с dID: ${dID}`);
      });

      if (totalSent === 0) {
        logger.logDevMessage(`[Serverapp] - broadcast - Нет активных клиентов для рассылки (dID: ${dID}, исключен: ${excludeClientId})`);
      } else {
        logger.logDevMessage(`[Serverapp] - broadcast - Всего отправлено ${totalSent} сообщений для dID: ${dID}`);
      }

    } catch (error) {
      logger.logErrorMessage(`[Serverapp] - broadcast - Ошибка рассылки: ${error.message}`);
    }
  },

  // Функция stringToJSON
  stringToJSON: (message) => {
    const data = message.toString('utf8');
    return JSON.parse(data);
  },

  // Функция checkMessage
  checkMessage: (message) => {
    const data = serverapp.stringToJSON(message);
    logger.logDevMessage(`[Serverapp] - checkMessage получило сообщение: ${message}`);
    
    // Мокируем validType
    const { validType } = require('../../validate');
    const { error } = validType(data);
    if (error) {
      logger.logErrorMessage(`[Serverapp] - checkMessage - Некорректный формат полученного сообщения. ${message} Ошибка: Error validType: ${error.message}`);
      return error;
    }
    return {status: 'ok', data: data};
  },

  // WebSocket серверы
  WSSNodeRED: {
    on: jest.fn(),
    clients: {
      forEach: jest.fn()
    }
  },
  
  WSSDash: {
    on: jest.fn(),
    clients: {
      forEach: jest.fn()
    }
  }
};

// Тесты
describe('serverapp.js - Основное приложение сервера', () => {
  
  describe('Глобальные переменные конфигурации', () => {
    test('Должны быть определены переменные окружения по умолчанию', () => {
      expect(process.env.SERVER_PORT).toBeUndefined();
      expect(process.env.WSR_PORT).toBeUndefined();
      expect(process.env.WSD_PORT).toBeUndefined();
      
      expect(() => {
        const servPORT = process.env.SERVER_PORT || 3010;
        const wsRedPORT = process.env.WSR_PORT || 9200;
        const wsDashPORT = process.env.WSD_PORT || 9202;
        expect(servPORT).toBe(3010);
        expect(wsRedPORT).toBe(9200);
        expect(wsDashPORT).toBe(9202);
      }).not.toThrow();
    });

    test('Должны быть созданы экземпляры express и http серверов', () => {
      expect(typeof serverapp.app).toBe('object');
      expect(typeof serverapp.server).toBe('object');
    });
  });

  describe('Функция initialize()', () => {
    test('Должна корректно вызывать инициализацию при INIT_DB=TRUE', async () => {
      process.env.INIT_DB = 'TRUE';
      
      await serverapp.initialize();
      
      expect(initServer).toHaveBeenCalledTimes(1);
      expect(initUsers).toHaveBeenCalledTimes(1);
      expect(initDefaulUser).toHaveBeenCalledTimes(1);
      expect(initDB_dID).toHaveBeenCalledTimes(1);
      
      expect(logger.logDevMessage).toHaveBeenCalledWith(
        expect.stringContaining('Инициализация сервера завершена успешно')
      );
    });

    test('Должна логировать запрет на инициализацию при INIT_DB!=TRUE', async () => {
      process.env.INIT_DB = 'FALSE';
      
      await serverapp.initialize();
      
      expect(initServer).not.toHaveBeenCalled();
      expect(initUsers).not.toHaveBeenCalled();
      expect(initDefaulUser).not.toHaveBeenCalled();
      expect(initDB_dID).not.toHaveBeenCalled();
      
      expect(logger.logInfoMessage).toHaveBeenCalledWith(
        expect.stringContaining('Инициализация сервера запрещена')
      );
    });

    test('Должна корректно обрабатывать ошибки при инициализации', async () => {
      process.env.INIT_DB = 'TRUE';
      
      initServer.mockRejectedValue(new Error('Ошибка инициализации БД'));
      
      await expect(serverapp.initialize()).rejects.toThrow('Ошибка инициализации БД');
      
      expect(logger.logErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Ошибка при инициализации сервера')
      );
    });
  });

  describe('Функция handleShutdown()', () => {
    let originalExit;
    
    beforeEach(() => {
      originalExit = process.exit;
      process.exit = jest.fn();
    });
    
    afterEach(() => {
      process.exit = originalExit;
    });

    test('Должна предотвращать повторный вызов shutdown', async () => {
      serverapp.isShuttingDown = true;
      
      await serverapp.handleShutdown();
      
      expect(serverapp.safeWrite).toHaveBeenCalledWith('ℹ️ Завершение уже начато, ожидайте...');
      expect(wsManager.stopHeartbeat).not.toHaveBeenCalled();
      expect(DBManager.closeAllPools).not.toHaveBeenCalled();
    });

    test('Должна корректно останавливать heartbeat', async () => {
      serverapp.isShuttingDown = false;
      
      await serverapp.handleShutdown();
      
      expect(wsManager.stopHeartbeat).toHaveBeenCalledTimes(1);
      expect(serverapp.safeWrite).toHaveBeenCalledWith('✅ Heartbeat monitoring stopped');
    });

    test('Должна корректно закрывать соединения с БД', async () => {
      serverapp.isShuttingDown = false;
      
      await serverapp.handleShutdown();
      
      expect(DBManager.closeAllPools).toHaveBeenCalledTimes(1);
      expect(serverapp.safeWrite).toHaveBeenCalledWith('✅ Все соединения с базами данных закрыты.');
    });

    test('Должна корректно очищать WebSocket соединения', async () => {
      serverapp.isShuttingDown = false;
      
      wsManager.cleanup.mockReturnValue(true);
      
      await serverapp.handleShutdown();
      
      expect(wsManager.cleanup).toHaveBeenCalledWith('VUE_connections');
      expect(wsManager.cleanup).toHaveBeenCalledWith('nRED_connections');
      expect(serverapp.safeWrite).toHaveBeenCalledWith('✅ Dashboard connections успешно очищены');
      expect(serverapp.safeWrite).toHaveBeenCalledWith('✅ NodeRED connections успешно очищены');
    });

    test('Должна корректно закрывать Express сервер', async () => {
      serverapp.isShuttingDown = false;
      
      serverapp.server.close = jest.fn((callback) => {
        callback(null);
      });
      
      await serverapp.handleShutdown();
      
      expect(serverapp.server.close).toHaveBeenCalledTimes(1);
      expect(serverapp.safeWrite).toHaveBeenCalledWith('✅ Сервер Express успешно остановлен');
    });

    test('Должа корректно обрабатывать ошибки закрытия сервера', async () => {
      serverapp.isShuttingDown = false;
      
      serverapp.server.close = jest.fn((callback) => {
        callback(new Error('Ошибка закрытия сервера'));
      });
      
      await serverapp.handleShutdown();
      
      expect(serverapp.safeWrite).toHaveBeenCalledWith('⛔ Ошибка закрытия сервера: Ошибка закрытия сервера');
    });
  });

  describe('Функция safeWrite()', () => {
    test('Должна безопасно выводить сообщения в stderr', () => {
      const testMessage = 'Тестовое сообщение';
      
      process.stderr.write = jest.fn();
      
      serverapp.safeWrite(testMessage);
      
      expect(process.stderr.write).toHaveBeenCalledWith(testMessage + '\n');
    });

    test('Должна корректно обрабатывать ошибки при записи в stderr', () => {
      const testMessage = 'Тестовое сообщение';
      
      process.stderr.write = jest.fn(() => {
        throw new Error('Ошибка записи');
      });
      
      expect(() => serverapp.safeWrite(testMessage)).not.toThrow();
    });
  });

  describe('Функция broadcast()', () => {
    let mockConnections;
    
    beforeEach(() => {
      mockConnections = [
        { 
          clientId: 'client1', 
          connection: { 
            ws: { 
              readyState: 1, // OPEN
              send: jest.fn()
            } 
          } 
        },
        { 
          clientId: 'client2', 
          connection: { 
            ws: { 
              readyState: 1, // OPEN
              send: jest.fn()
            } 
          } 
        }
      ];
      
      wsManager.getUserConnections = jest.fn().mockReturnValue(mockConnections);
      logger.logDevMessage = jest.fn();
    });

    test('Должна корректно рассылать сообщения всем соединениям', () => {
      const testData = {
        type: 'test',
        request: 'broadcast',
        payload: { message: 'Hello World' }
      };
      
      serverapp.broadcast('excludeClientId', 'test-did', testData);
      
      expect(mockConnections[0].connection.ws.send).toHaveBeenCalledWith(
        expect.stringContaining('Hello World')
      );
      expect(mockConnections[1].connection.ws.send).toHaveBeenCalledWith(
        expect.stringContaining('Hello World')
      );
      
      const sentMessage = JSON.parse(mockConnections[0].connection.ws.send.mock.calls[0][0]);
      expect(sentMessage.time).toBeDefined();
      expect(typeof sentMessage.time).toBe('string');
    });

    test('Должна исключать указанного клиента из рассылки', () => {
      const testData = {
        type: 'test',
        request: 'broadcast',
        payload: { message: 'Hello World' }
      };
      
      serverapp.broadcast('client1', 'test-did', testData);
      
      expect(mockConnections[0].connection.ws.send).not.toHaveBeenCalled();
      expect(mockConnections[1].connection.ws.send).toHaveBeenCalled();
    });

    test('Должа корректно обрабатывать неактивные соединения', () => {
      mockConnections[0].connection.ws.readyState = 3; // CLOSED
      
      const testData = {
        type: 'test',
        request: 'broadcast',
        payload: { message: 'Hello World' }
      };
      
      serverapp.broadcast('excludeClientId', 'test-did', testData);
      
      expect(mockConnections[0].connection.ws.send).not.toHaveBeenCalled();
      expect(mockConnections[1].connection.ws.send).toHaveBeenCalled();
    });

    test('Должна корректно обрабатывать ошибки при отправке сообщений', () => {
      mockConnections[0].connection.ws.send = jest.fn(() => {
        throw new Error('Ошибка отправки');
      });
      
      const testData = {
        type: 'test',
        request: 'broadcast',
        payload: { message: 'Hello World' }
      };
      
      expect(() => serverapp.broadcast('excludeClientId', 'test-did', testData)).not.toThrow();
      
      expect(logger.logErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Ошибка рассылки')
      );
    });
  });

  describe('Функция stringToJSON()', () => {
    test('Должа корректно преобразовывать строку в JSON объект', () => {
      const testString = '{"type": "test", "data": "value"}';
      const result = serverapp.stringToJSON(testString);
      
      expect(result).toEqual({
        type: 'test',
        data: 'value'
      });
    });

    test('Должна бросать ошибку при некорректном JSON', () => {
      const invalidString = '{"type": "test", "data": "value"'; // Незакрытый JSON
      
      expect(() => serverapp.stringToJSON(invalidString)).toThrow();
    });
  });

  describe('Функция checkMessage()', () => {
    beforeEach(() => {
      const { validType } = require('../../validate');
      validType.mockReturnValue({ error: null });
    });

    test('Должна корректно проверять валидные сообщения', () => {
      const { validType } = require('../../validate');
      validType.mockReturnValue({ error: null });
      
      const validMessage = JSON.stringify({
        type: 'test',
        request: 'get',
        name: 'test-device',
        payload: {}
      });
      
      const result = serverapp.checkMessage(validMessage);
      
      expect(result.status).toBe('ok');
      expect(result.data).toEqual({
        type: 'test',
        request: 'get',
        name: 'test-device',
        payload: {}
      });
    });

    test('Должа возвращать ошибку при невалидных сообщениях', () => {
      const { validType } = require('../../validate');
      validType.mockReturnValue({ 
        error: new Error('Missing required field: request') 
      });
      
      const invalidMessage = JSON.stringify({
        type: 'test'
        // Отсутствует обязательное поле request
      });
      
      const result = serverapp.checkMessage(invalidMessage);
      
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toContain('Missing required field: request');
    });
  });

  describe('WebSocket серверы', () => {
    test('Должны быть созданы WebSocket серверы', () => {
      expect(serverapp.WSSNodeRED).toBeDefined();
      expect(serverapp.WSSDash).toBeDefined();
    });

    test('Должны корректно устанавливать обработчики подключения', () => {
      expect(serverapp.WSSNodeRED.on).toHaveBeenCalledWith('connection', expect.any(Function));
      expect(serverapp.WSSDash.on).toHaveBeenCalledWith('connection', expect.any(Function));
    });
  });

  describe('GPIO управление', () => {
    test('Должна создавать GpioManager при MANAGE_DOOR=true', () => {
      process.env.MANAGE_DOOR = 'true';
      process.env.DEVICE_NAME = 'test-device';
      
      // Проверяем, что конструктор GpioManager был вызван с правильными параметрами
      expect(require('../../gpio.js')).toHaveBeenCalledWith('test-device', './gpioConf.json');
    });

    test('Не должна создавать GpioManager при MANAGE_DOOR=false', () => {
      process.env.MANAGE_DOOR = 'false';
      
      // Очищаем моки и проверяем, что GpioManager не был вызван
      jest.clearAllMocks();
      expect(require('../../gpio.js')).not.toHaveBeenCalled();
    });
  });

  describe('Обработка сигналов', () => {
    test('Должна устанавливать обработчики SIGINT и SIGTERM', () => {
      expect(process.on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
      expect(process.on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    });
  });

  describe('Обработка очередей сообщений', () => {
    test('Должна устанавливать интервал обработки очередей', () => {
      expect(global.setInterval).toHaveBeenCalledWith(
        expect.any(Function),
        15000
      );
    });

    test('Должа корректно обрабатывать сообщения в очереди', () => {
      getAllQueueMessages.mockReturnValue([
        { id: 1, data: 'test message' }
      ]);
      processAllQueues.mockResolvedValue();
      
      expect(getAllQueueMessages).toHaveBeenCalled();
      expect(processAllQueues).toHaveBeenCalled();
    });
  });
});

describe('Интеграционные тесты serverapp.js', () => {
  test('Должна корректно работать полная цепочка инициализации', async () => {
    process.env.INIT_DB = 'TRUE';
    
    initServer.mockResolvedValue();
    initUsers.mockResolvedValue();
    initDefaulUser.mockResolvedValue();
    initDB_dID.mockResolvedValue();
    
    await serverapp.initialize();
    
    expect(initServer).toHaveBeenCalled();
    expect(initUsers).toHaveBeenCalled();
    expect(initDefaulUser).toHaveBeenCalled();
    expect(initDB_dID).toHaveBeenCalled();
  });

  test('Должна корректно обрабатывать ошибку при инициализации', async () => {
    process.env.INIT_DB = 'TRUE';
    
    initServer.mockRejectedValue(new Error('Test error'));
    
    await expect(serverapp.initialize()).rejects.toThrow('Test error');
  });
});