// Модуль подготовки и отравки ответа о успехе/ошибке выполнении запроса wsHelpers.js

const { nodeRedClients } = require('./clientsStore');
function sendRequest(client, requestType, name, payload) {
  try {
    const response = {
      type: 'get',
      request: requestType,
      name: name,
      payload: payload
    };
    client.output.send(JSON.stringify(response));
    console.log('[wsHelpers] - sendRequest - Запрос отправлен:', JSON.stringify(response));
  } catch (error) {
    console.error('[wsHelpers] - sendRequest error:', error);
  }
}

function sendSuccess(client, requestType, name, payload) {
  try {
    const response = {
      type: 'response',
      request: requestType,
      name: name,
      payload: payload
    };
    client.send(JSON.stringify(response));
    console.log('[wsHelpers] - sendSuccess - Отправлен успешный ответ:', JSON.stringify({type:response.type, request:response.request, dID:response.name}));
  } catch (error) {
    console.error('[wsHelpers] - sendSuccess error:', error);
  }
}

function sendError(client, errorType, name, payload) {
  try {
    const errorResponse = {
      type: 'error',
      request: errorType,
      name: name,
      payload: payload
    };
    client.send(JSON.stringify(errorResponse));
    console.log('[wsHelpers] - sendError - Отправлена ошибка:', JSON.stringify(errorResponse));
  } catch (error) {
    console.error('[wsHelpers] - sendError error:', error);
  }
}
  module.exports = {
    sendSuccess,
    sendRequest,
    sendError
  };