// tests/integration/websocket-auth.integration.test.js
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');

// ВАЖНО: Не мокируем jwt в интеграционных тестах - используем реальную библиотеку
const jwt = require('jsonwebtoken');

// Отменяем глобальные моки для интеграционных тестов
jest.unmock('jsonwebtoken');
jest.unmock('bcryptjs');

const { loginUser, verifyToken } = require('../../auth');
const DBManager = require('../../services/db');

// Мокируем только DBManager для изоляции от реальной БД
jest.mock('../../services/db', () => ({
  findUser: jest.fn(),
  query: jest.fn(),
  checkRecordExists: jest.fn(),
  closeAllPools: jest.fn()
}));

describe('WebSocket Authentication Integration Tests', () => {
  let wss;
  let wsClient;
  const TEST_PORT = 9999;
  const testSecret = 'test-secret-key-for-jwt'; // Используем тот же ключ что в setup.js
  
  beforeAll(() => {
    // Перезаписываем переменную окружения для интеграционных тестов
    process.env.JWT_SECRET = testSecret;
    
    // Создаем тестовый WebSocket сервер
    wss = new WebSocket.Server({ port: TEST_PORT });
    
    // Обработчик подключений (имитируем логику из serverapp.js)
    wss.on('connection', (ws) => {
      console.log('Test WebSocket client connected');
      
      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message.toString('utf8'));
          
          switch (data.type) {
            case 'auth':
              // Обрабатываем авторизацию
              const authResult = await loginUser(data.payload.username, data.payload.password);
              
              if (authResult.error) {
                ws.send(JSON.stringify({
                  type: 'auth',
                  status: 'error',
                  error: authResult.error,
                  code: authResult.code
                }));
              } else {
                ws.send(JSON.stringify({
                  type: 'auth',
                  status: 'success',
                  token: authResult.token,
                  user: {
                    username: authResult.username,
                    userlevel: authResult.userlevel,
                    dID: authResult.dID
                  }
                }));
              }
              break;
              
            case 'get':
              // Проверяем токен для защищенных операций
              try {
                const decoded = verifyToken(data.token);
                ws.send(JSON.stringify({
                  type: 'get',
                  status: 'success',
                  data: 'Protected data accessed successfully',
                  user: decoded
                }));
              } catch (error) {
                ws.send(JSON.stringify({
                  type: 'get',
                  status: 'error',
                  error: 'Invalid or expired token'
                }));
              }
              break;
              
            default:
              ws.send(JSON.stringify({
                type: 'error',
                error: 'Unknown message type'
              }));
          }
        } catch (error) {
          ws.send(JSON.stringify({
            type: 'error',
            error: 'Invalid JSON message'
          }));
        }
      });
      
      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
      });
    });
  });

  afterEach(async () => {
    // Очищаем моки перед каждым тестом
    jest.clearAllMocks();
    
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.close();
      // Ждем полного закрытия соединения
      await new Promise(resolve => {
        wsClient.on('close', resolve);
        setTimeout(resolve, 500); // fallback timeout
      });
    }
    wsClient = null;
  });

  afterAll(async () => {
    // Закрываем WebSocket сервер
    if (wss) {
      // Закрываем все клиентские соединения
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.terminate();
        }
      });
      
      // Закрываем сервер
      await new Promise((resolve) => {
        wss.close(() => {
          console.log('Test WebSocket server closed');
          resolve();
        });
      });
    }
    
    // Даем время на очистку
    await new Promise(resolve => setTimeout(resolve, 1000));
  });

  const connectToWebSocket = () => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
      
      ws.on('open', () => {
        resolve(ws);
      });
      
      ws.on('error', (error) => {
        reject(error);
      });
      
      // Таймаут для подключения
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new Error('Connection timeout'));
        }
      }, 5000);
    });
  };

  const sendMessageAndWaitResponse = (ws, message, timeout = 5000) => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Response timeout'));
      }, timeout);

      const messageHandler = (data) => {
        clearTimeout(timer); // Добавьте эту строку
        ws.removeListener('message', messageHandler);
        try {
          resolve(JSON.parse(data.toString()));
        } catch (error) {
          reject(new Error('Invalid JSON response'));
        }
      };

        ws.on('message', messageHandler);
        ws.send(JSON.stringify(message));
      });
    };

  describe('Успешная авторизация', () => {
    it('должен успешно авторизовать пользователя через WebSocket', async () => {
      // Создаем реальный хэш пароля для теста
      const hashedPassword = await bcrypt.hash('testpassword', 10);
      
      const validUserData = {
        id: 1,
        username: 'testuser',
        password: hashedPassword,
        userlevel: 1,
        dID: 'test-did-123'
      };

      // Мокируем успешный поиск пользователя
      DBManager.findUser.mockResolvedValue(validUserData);

      wsClient = await connectToWebSocket();

      const authMessage = {
        type: 'auth',
        payload: {
          username: 'testuser',
          password: 'testpassword'
        }
      };

      const response = await sendMessageAndWaitResponse(wsClient, authMessage);

      expect(response.type).toBe('auth');
      expect(response.status).toBe('success');
      expect(response.token).toBeDefined();
      expect(response.user).toEqual({
        username: 'testuser',
        userlevel: 1,
        dID: 'test-did-123'
      });

      // Проверяем валидность токена с правильным секретом
      const decoded = jwt.verify(response.token, testSecret);
      expect(decoded.id).toBe(1);
    });

    it('должен предоставить доступ к защищенным ресурсам с валидным токеном', async () => {
      // Создаем реальный хэш пароля
      const hashedPassword = await bcrypt.hash('testpassword', 10);
      
      const validUserData = {
        id: 1,
        username: 'testuser',
        password: hashedPassword,
        userlevel: 1,
        dID: 'test-did-123'
      };

      // Мокируем успешный поиск пользователя
      DBManager.findUser.mockResolvedValue(validUserData);

      wsClient = await connectToWebSocket();

      // Сначала авторизуемся
      const authMessage = {
        type: 'auth',
        payload: {
          username: 'testuser',
          password: 'testpassword'
        }
      };

      const authResponse = await sendMessageAndWaitResponse(wsClient, authMessage);
      expect(authResponse.status).toBe('success');

      // Теперь пытаемся получить защищенные данные
      const getMessage = {
        type: 'get',
        token: authResponse.token,
        request: 'protected_data'
      };

      const getResponse = await sendMessageAndWaitResponse(wsClient, getMessage);

      expect(getResponse.type).toBe('get');
      expect(getResponse.status).toBe('success');
      expect(getResponse.data).toBe('Protected data accessed successfully');
      expect(getResponse.user).toBeDefined();
    });
  });

  describe('Неудачная авторизация', () => {
  
    it('должен отклонить авторизацию для несуществующего пользователя', async () => {
      // Мокируем отсутствие пользователя
      DBManager.findUser.mockResolvedValue(null);

      wsClient = await connectToWebSocket();

      const authMessage = {
        type: 'auth',
        payload: {
          username: 'nonexistent',
          password: 'anypassword'
        }
      };

      const response = await sendMessageAndWaitResponse(wsClient, authMessage);

      expect(response.type).toBe('auth');
      expect(response.status).toBe('error');
      expect(response.error).toBe('User nonexistent not found'); // Изменено здесь
      expect(response.code).toBe('USER_NOT_FOUND');
    });

    it('должен отклонить авторизацию с неправильным паролем', async () => {
      // Создаем хэш для правильного пароля
      const hashedPassword = await bcrypt.hash('correctpassword', 10);
      
      const validUserData = {
        id: 1,
        username: 'testuser',
        password: hashedPassword,
        userlevel: 1,
        dID: 'test-did-123'
      };

      DBManager.findUser.mockResolvedValue(validUserData);

      wsClient = await connectToWebSocket();

      const authMessage = {
        type: 'auth',
        payload: {
          username: 'testuser',
          password: 'wrongpassword' // Неправильный пароль
        }
      };

      const response = await sendMessageAndWaitResponse(wsClient, authMessage);

      expect(response.type).toBe('auth');
      expect(response.status).toBe('error');
      expect(response.error).toBe('Invalid password');
      expect(response.code).toBe('INVALID_PASSWORD');
    });

    it('должен отклонить доступ к защищенным ресурсам с невалидным токеном', async () => {
      wsClient = await connectToWebSocket();

      const getMessage = {
        type: 'get',
        token: 'invalid-token',
        request: 'protected_data'
      };

      const response = await sendMessageAndWaitResponse(wsClient, getMessage);

      expect(response.type).toBe('get');
      expect(response.status).toBe('error');
      expect(response.error).toBe('Invalid or expired token');
    });

    it('должен обработать ошибку базы данных при авторизации', async () => {
      // Мокируем ошибку базы данных
      DBManager.findUser.mockRejectedValue(new Error('Database connection failed'));

      wsClient = await connectToWebSocket();

      const authMessage = {
        type: 'auth',
        payload: {
          username: 'testuser',
          password: 'testpassword'
        }
      };

      const response = await sendMessageAndWaitResponse(wsClient, authMessage);

      expect(response.type).toBe('auth');
      expect(response.status).toBe('error');
      expect(response.error).toBe('Server error');
      expect(response.code).toBe('SERVER_ERROR');
    });
  });

  describe('Обработка некорректных сообщений', () => {
    it('должен обработать некорректный JSON', async () => {
      wsClient = await connectToWebSocket();

      const responsePromise = new Promise((resolve) => {
        wsClient.on('message', (data) => {
          resolve(JSON.parse(data.toString()));
        });
      });

      wsClient.send('invalid json {');

      const response = await responsePromise;

      expect(response.type).toBe('error');
      expect(response.error).toBe('Invalid JSON message');
    });

    it('должен обработать неизвестный тип сообщения', async () => {
      wsClient = await connectToWebSocket();

      const unknownMessage = {
        type: 'unknown_type',
        data: 'some data'
      };

      const response = await sendMessageAndWaitResponse(wsClient, unknownMessage);

      expect(response.type).toBe('error');
      expect(response.error).toBe('Unknown message type');
    });
  });

  describe('Тестирование с реальными данными', () => {
    it('должен работать с полным циклом авторизации как в продакшене', async () => {
      // Создаем реалистичные тестовые данные
      const realUserData = {
        id: 42,
        username: 'admin',
        password: await bcrypt.hash('securePassword123', 10),
        userlevel: 9,
        dID: 'admin-dashboard-001'
      };

      DBManager.findUser.mockResolvedValue(realUserData);

      wsClient = await connectToWebSocket();

      // Полный цикл: подключение -> авторизация -> запрос данных
      const authMessage = {
        type: 'auth',
        payload: {
          username: 'admin',
          password: 'securePassword123'
        }
      };

      const authResponse = await sendMessageAndWaitResponse(wsClient, authMessage);

      // Проверяем успешную авторизацию
      expect(authResponse.status).toBe('success');
      expect(authResponse.user.username).toBe('admin');
      expect(authResponse.user.userlevel).toBe(9);

      // Используем полученный токен для доступа к данным
      const dataRequest = {
        type: 'get',
        token: authResponse.token,
        request: 'dashboard_data'
      };

      const dataResponse = await sendMessageAndWaitResponse(wsClient, dataRequest);
      
      expect(dataResponse.status).toBe('success');
      expect(dataResponse.user.id).toBe(42);
    });
  });
});