// Модуль подготовки и отравки ответа о успехе/ошибке выполнении запросаwsHelpers.js

const { nodeRedClients } = require('./clientsStore');
  function sendRequest(client, requestType, name, payload) {
        const response = {
        type: 'get',
        request: requestType,
        name: name,
        payload: payload
      };
      client.output.send(JSON.stringify(response));
      console.log('[wsHelpers] - sendRequest - Запрос отправлен:', JSON.stringify(response));
  }
  function sendSuccess(client, requestType, name, payload) {
      const response = {
      type: 'response',
      request: requestType,
      name: name,
      payload: payload
    };
    client.send(JSON.stringify(response));
    console.log('[wsHelpers] - sendSuccess - Отправлен успешный ответ:', JSON.stringify({type:response.type, request:response.request, dID:response.name}));
    //console.log('[wsHelpers] - sendSuccess - Payload:', JSON.stringify({ payload:response.payload}));
  }
  function sendError(client, errorType, name, payload) {
      const errorResponse = {
      type: 'error',
      request: errorType,
      name: name,
      payload: payload
    };
    client.send(JSON.stringify(errorResponse));
    console.log('[wsHelpers] - sendError - Отправлена ошибка:', JSON.stringify(errorResponse));
  }
  module.exports = {
    sendSuccess,
    sendRequest,
    sendError
  };