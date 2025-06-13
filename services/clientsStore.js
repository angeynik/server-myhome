const nodeRedClients = new Map(); // Хранилище всех подключений

/**
 * Регистрирует клиента в хранилище.
 * @param {string} idClient - Уникальный идентификатор клиента (name из сообщения).
 * @param {WebSocket} ws - WebSocket соединение.
 * @param {string} typeConnect - Тип соединения ('input' или 'output').
 */
function registerClient(idClient, ws, typeConnect) {
    if (!nodeRedClients.has(idClient)) {
        nodeRedClients.set(idClient, {});
    }
    nodeRedClients.get(idClient)[typeConnect] = ws;
    console.log(`Клиент ${idClient} (${typeConnect}) зарегистрирован.`);
}

/**
 * Получает WebSocket соединение клиента по его идентификатору и типу подключения.
 * @param {string} idClient - Уникальный идентификатор клиента.
 * @param {string} typeConnect - Тип соединения ('input' или 'output').
 * @returns {WebSocket | undefined} - Возвращает WebSocket соединение клиента или undefined.
 */
function getClient(idClient, typeConnect) {
    return nodeRedClients.has(idClient) ? nodeRedClients.get(idClient)[typeConnect] : undefined;
}

// Функция для получения списка всех активных подключений
function getAllClients() {
  // Преобразуем Map в обычный объект для удобного логирования.
  const allClients = {};
  nodeRedClients.forEach((connections, idClient) => {
    allClients[idClient] = {};
    for (const typeConnect in connections) {
      const ws = connections[typeConnect];
      allClients[idClient][typeConnect] = {
        dID: ws.dID, // сохраненный dID
        typeConnect: ws.typeConnect, // сохраненный тип подключения
        lastActivity: ws.lastActivity,
        clientId: ws.socket || 'нет идентификатора',
        connected: ws.readyState === WebSocket.OPEN,
        sender: ws.sender || 'нет идентификатора'    
    };
    }
  });
  return allClients;
}

/**
 * Удаляет клиента из хранилища.
 * @param {string} idClient - Уникальный идентификатор клиента.
 */
function removeClient(idClient) {
    nodeRedClients.delete(idClient);
    console.log(`Клиент ${idClient} удален из хранилища.`);
}

module.exports = {
    registerClient,
    getClient,
    getAllClients,
    removeClient
};
