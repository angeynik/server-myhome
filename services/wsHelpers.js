// Модуль подготовки и отравки ответа о успехе/ошибке выполнении запросаwsHelpers.js

const { nodeRedClients } = require('./clientsStore');
  function sendRequest(clientId, requestType, name, payload) {
    const client = nodeRedClients.get(clientId);
    //console.log('sendSuccess - Переходим к отправке запроса');
    if (client && client.output) {
    console.log('sendSuccess - clientID:', clientId, 'output:', client.output);
        const response = {
        type: 'get',
        request: requestType,
        name: name,
        payload: payload
      };
      client.output.send(JSON.stringify(response));
      console.log('sendRequest - Запрос отправлен:', JSON.stringify(response));
  } else {
    console.error(`[sendRequest] No output connection for client ${clientId}`);
  }
  }
  function sendSuccess(clientId, requestType, name, payload) {
    const client = nodeRedClients.get(clientId);
    //console.log('sendSuccess - Переходим к отправке ответа');
    if (client && client.output) {
      console.log('sendSuccess - clientID:', clientId, 'output:', client.output);
      const response = {
      type: 'response',
      request: requestType,
      name: name,
      payload: payload
    };
    ws.send(JSON.stringify(response));
    console.log('Отправлен успешный ответ:', JSON.stringify(response.type));
    //console.log('Отправлен успешный ответ:', JSON.stringify(response));
    } else {
     console.error(`[sendSuccess] No output connection for client ${clientId}`);
    }

  }
  function sendError(clientId, errorType, name, payload) {
    const client = nodeRedClients.get(clientId);
    if (client && client.output) {
      console.log('sendError - clientID:', clientId, 'output:', client.output);
      const errorResponse = {
      type: 'error',
      request: errorType,
      name: name,
      payload: payload
    };
    ws.send(JSON.stringify(errorResponse));
    console.log('Отправлена ошибка:', JSON.stringify(errorResponse));
    } else {
      console.error(`[sendError] No output connection for client ${clientId}`);
    }

  }
  module.exports = {
    sendSuccess,
    sendRequest,
    sendError
  };