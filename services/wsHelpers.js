// Модуль подготовки и отравки ответа о успехе/ошибке выполнении запросаwsHelpers.js
function sendRequest(ws, requestType, name, payload) {
  console.log('sendSuccess - Переходим к отправке запроса');
    const response = {
      type: 'get',
      request: requestType,
      name: name,
      payload: payload
    };
    ws.send(JSON.stringify(response));
    console.log('sendRequest - Запрос отправлен:', JSON.stringify(response));
  }
 
  function sendSuccess(ws, requestType, name, payload) {
    //console.log('sendSuccess - Переходим к отправке ответа');
    const response = {
      type: 'response',
      request: requestType,
      name: name,
      payload: payload
    };
    ws.send(JSON.stringify(response));
    console.log('Отправлен успешный ответ:', JSON.stringify(response.type));
    //console.log('Отправлен успешный ответ:', JSON.stringify(response));
  }

  function sendError(ws, errorType, name, payload) {
    const errorResponse = {
      type: 'error',
      request: errorType,
      name: name,
      payload: payload
    };
    ws.send(JSON.stringify(errorResponse));
    console.log('Отправлена ошибка:', JSON.stringify(errorResponse));
  }
  
  module.exports = {
    sendSuccess,
    sendRequest,
    sendError
  };