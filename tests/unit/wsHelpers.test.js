// tests/unit/wsHelpers.test.js
const { sendSuccess, sendRequest, sendError } = require('../../services/wsHelpers');

// Мокируем console для чистоты вывода тестов
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

describe('wsHelpers', () => {
  let mockClient;

  beforeEach(() => {
    // Создаем mock клиента перед каждым тестом
    mockClient = {
      send: jest.fn(),
      output: {
        send: jest.fn()
      }
    };

    jest.clearAllMocks();
  });

  describe('sendSuccess', () => {
    test('должен отправлять успешный ответ с правильной структурой', () => {
      const requestType = 'get';
      const name = global.mockWebSocketData.clientId;
      const payload = global.mockWsHelpersData.successResponse.payload;

      sendSuccess(mockClient, requestType, name, payload);

      expect(mockClient.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'response',
          request: requestType,
          name: name,
          payload: payload
        })
      );

      expect(console.log).toHaveBeenCalledWith(
        '[wsHelpers] - sendSuccess - Отправлен успешный ответ:',
        JSON.stringify({
          type: 'response',
          request: requestType,
          dID: name
        })
      );
    });

    test('должен использовать глобальные тестовые данные', () => {
      const payload = global.mockWebSocketMessages.inputMessage;
      const name = global.mockDevices.thermostat.id;
      const requestType = 'device_status';
      
      sendSuccess(mockClient, requestType, name, payload);

      expect(mockClient.send).toHaveBeenCalledWith(
        expect.stringContaining(JSON.stringify(payload))
      );
    });

    test('должен обрабатывать различные типы payload', () => {
      const testCases = [
        { payload: global.mockUserData.validUser },
        { payload: global.mockDevices.thermostat },
        { payload: global.mockWebSocketMessages.inputMessage },
        { payload: null },
        { payload: undefined }
      ];

      testCases.forEach((testCase, index) => {
        sendSuccess(mockClient, 'test', `device-${index}`, testCase.payload);
        expect(mockClient.send).toHaveBeenCalledTimes(index + 1);
      });
    });
  });

  describe('sendRequest', () => {
    test('должен отправлять запрос через output канал', () => {
      const requestType = 'set';
      const name = global.mockWebSocketData.clientId;
      const payload = global.mockWsHelpersData.requestMessage.payload;

      sendRequest(mockClient, requestType, name, payload);

      expect(mockClient.output.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'get',
          request: requestType,
          name: name,
          payload: payload
        })
      );

      expect(console.log).toHaveBeenCalledWith(
        '[wsHelpers] - sendRequest - Запрос отправлен:',
        JSON.stringify({
          type: 'get',
          request: requestType,
          name: name,
          payload: payload
        })
      );
    });

    test('должен использовать глобальные WebSocket сообщения', () => {
      const message = global.mockWebSocketMessages.outputMessage;
      const name = global.mockDevices.light.id;
      
      sendRequest(mockClient, message.type, name, message.data);

      expect(mockClient.output.send).toHaveBeenCalledWith(
        expect.stringContaining(message.type)
      );
    });

test('должен корректно обрабатывать клиента без output', () => {
  const clientWithoutOutput = { send: jest.fn() };
  
  // Мокируем console.error для этого теста
  const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  
  // Это не должно падать с ошибкой
  expect(() => {
    sendRequest(clientWithoutOutput, 'test', 'device', {});
  }).not.toThrow();

  // Должен быть вызов console.error
  expect(consoleErrorSpy).toHaveBeenCalled();
  expect(consoleErrorSpy).toHaveBeenCalledWith(
    expect.stringContaining('sendRequest error:'),
    expect.any(Error)
  );
});
  });

  describe('sendError', () => {
    test('должен отправлять ошибку с правильной структурой', () => {
      const errorType = 'validation';
      const name = global.mockWebSocketData.clientId;
      const payload = global.mockWsHelpersData.errorResponse.payload;

      sendError(mockClient, errorType, name, payload);

      expect(mockClient.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'error',
          request: errorType,
          name: name,
          payload: payload
        })
      );

      expect(console.log).toHaveBeenCalledWith(
        '[wsHelpers] - sendError - Отправлена ошибка:',
        JSON.stringify({
          type: 'error',
          request: errorType,
          name: name,
          payload: payload
        })
      );
    });

    test('должен использовать глобальные ошибки', () => {
      const errorPayload = { 
        message: global.testErrors.validationError.message,
        code: 400
      };

      sendError(mockClient, 'validation', global.mockDevices.sensor.id, errorPayload);

      expect(mockClient.send).toHaveBeenCalledWith(
        expect.stringContaining('Validation failed')
      );
    });

    test('должен обрабатывать различные типы ошибок', () => {
      const errorTypes = ['auth', 'db', 'validation', 'timeout'];
      
      errorTypes.forEach((errorType, index) => {
        const errorPayload = {
          message: `Test error ${index}`,
          code: 400 + index
        };
        sendError(mockClient, errorType, `device-${index}`, errorPayload);
        expect(mockClient.send).toHaveBeenCalledTimes(index + 1);
      });
    });
  });

  describe('Интеграционные тесты', () => {
    test('должен корректно работать с реальными JSON данными', () => {
      const testData = global.mockUserData.validUser;
      const name = global.mockWebSocketData.adminClientId;
      
      sendSuccess(mockClient, 'user', name, testData);

      const sentData = JSON.parse(mockClient.send.mock.calls[0][0]);
      expect(sentData.payload.username).toBe('testuser');
      expect(sentData.payload.userlevel).toBe(1);
    });

    test('должен использовать глобальные clientId', () => {
      const clientId = global.mockWebSocketData.clientId;
      
      sendSuccess(mockClient, 'test', clientId, { data: 'test' });

      const sentData = JSON.parse(mockClient.send.mock.calls[0][0]);
      expect(sentData.name).toBe(clientId);
    });

    test('должен логировать корректную информацию', () => {
      const deviceId = global.mockDevices.thermostat.id;
      
      sendSuccess(mockClient, 'device_status', deviceId, { value: 42 });

      expect(console.log).toHaveBeenCalledWith(
        '[wsHelpers] - sendSuccess - Отправлен успешный ответ:',
        JSON.stringify({
          type: 'response',
          request: 'device_status',
          dID: deviceId
        })
      );
    });
  });

  describe('Обработка ошибок', () => {
test('должен обрабатывать ошибки при отправке', () => {
  const errorClient = {
    send: jest.fn().mockImplementation(() => {
      throw new Error('Send failed');
    })
  };

  // Мокируем console.error для этого теста
  const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  // Не должно падать с ошибкой
  expect(() => {
    sendSuccess(errorClient, 'test', 'device', {});
  }).not.toThrow();

  expect(consoleErrorSpy).toHaveBeenCalled();
  expect(consoleErrorSpy).toHaveBeenCalledWith(
    expect.stringContaining('sendSuccess error:'),
    expect.any(Error)
  );
});

test('должен обрабатывать невалидный JSON', () => {
  const circularObject = {};
  circularObject.self = circularObject;

  // Мокируем console.error для этого теста
  const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  // Это не должно падать с ошибкой
  expect(() => {
    sendSuccess(mockClient, 'test', 'device', circularObject);
  }).not.toThrow();

  expect(consoleErrorSpy).toHaveBeenCalled();
  expect(consoleErrorSpy).toHaveBeenCalledWith(
    expect.stringContaining('sendSuccess error:'),
    expect.any(Error)
  );
});
  });
});