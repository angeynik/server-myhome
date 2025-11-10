// services/wsManager.js
// Класс wsManager который будет управлять пользователями:
// - регистрировать подключение и сохранять его в массив подключений
// - проверять актуальность подключения
// - удалять из массива не актуальные подключения
// - проверять в массиве наличие подключения
// - возвращать ws подключение по ключу
// - возвращать все активные подключения
// services/wsManager.js
const WebSocket = require('ws');

class WsManager {
  constructor() {
    this.VUE_connections = new Map();
    this.nRED_connections = new Map();
    this.heartbeatInterval = null;
  }
  // generateConnectionId() {
  //   const random = Math.random().toString(32);
  //   return random;
  // }
  registerConnection(ws, connectionType, dID = null, key = null) {
    console.log('[wsManager] - registerConnection - Начинаем регистрацию подключения');
    // if (!['input', 'output'].includes(connectionType)) {
    //   throw new TypeError(`Invalid connectionType: "${connectionType}"`);
    // }   
    const remoteAddress = ws._socket?.remoteAddress || 'unknown';
    const remotePort = ws._socket?.remotePort || 'unknown';
    const fullAddress = `${(remoteAddress || "").replace(/^::ffff:/, "")}:${remotePort}`;


    // ✅ ПРОВЕРЯЕМ СУЩЕСТВУЮЩЕЕ АКТИВНОЕ СОЕДИНЕНИЕ
    const existingConnection = this.findExistingConnection(dID, connectionType, fullAddress);
    
    if (existingConnection) {
        console.log(`[WsManager] - 🔄 registerConnection - Соединение: ${existingConnection.clientId} - ${existingConnection.connection.connectionType} - (${fullAddress}) уже зарегистрировано`);
        // console.log(
        //     `[WsManager] - 🔄 registerConnection - Соединение: ${existingConnection.clientId} - с типом ${existingConnection.connection.connectionType}`,
        //     existingConnection,
        //     `- (${fullAddress}) уже зарегистрировано`
        //     );
        return existingConnection.clientId;
    }
    const clientId = Math.random().toString(16);

    const connection = {
      ws,
      connectionType,
      dID,
      key,
      meta: {
        clientId,
        registeredAt: Date.now(),
        remoteAddress: fullAddress,
        lastActivity: Date.now(),
        isAlive: true
      }
    };
    if (connectionType === 'dashboard') {
      this.VUE_connections.set(clientId, connection);
      this.setupConnectionHandlers('VUE_connections', clientId, ws);
      const allClients = wsManager.getAllActiveConnections('VUE_connections');
      console.log(` !!!!!!!!!!!!!!!! - - - - - [wsManager] - registerConnection - Все соединения:`, allClients);
    } else if (connectionType === 'nodeRED') {
      this.nRED_connections.set(clientId, connection);
      this.setupConnectionHandlers('nRED_connections', clientId, ws);
      const allClients = wsManager.getAllActiveConnections('nRED_connection');
      console.log(` !!!!!!!!!!!!!!!! - - - - - [wsManager] - registerConnection- Все соединения:`, allClients);
    } else {
      return error = 'Invalid connectionType';
    }
    // this.connections.set(clientId, connection);
    //this.setupConnectionHandlers(clientId, ws);
    console.log(`[WsManager] - ✅ ${connectionType} Соединение зарегистрировано: ${clientId} (${key || 'no-key'}) - ${fullAddress}`);

    return clientId;
  }
  findExistingConnection(dID, connectionType, remoteAddress) {
    if (connectionType === 'dashboard') {
      for (const [clientId, connection] of this.VUE_connections) {
      if (connection.dID === dID && 
          connection.connectionType === connectionType && 
          connection.meta.remoteAddress === remoteAddress &&
          this.isConnectionActive('VUE_connections', clientId)) {
        return { clientId, connection };
      }
      }
    }
    if (connectionType === 'nodeRED') {
    for (const [clientId, connection] of this.nRED_connections) {
      if (connection.dID === dID && 
          connection.connectionType === connectionType && 
          connection.meta.remoteAddress === remoteAddress &&
          this.isConnectionActive('nRED_connections', clientId)) {
        return { clientId, connection };
      }
      }
    }

    return null;
  }
  closeDuplicateConnections(connections, dID, connectionType, remoteAddress) {
    let closedCount = 0;
    
    for (const [existingClientId, connection] of this[connections]) {
      if (connection.dID === dID && 
          connection.connectionType === connectionType && 
          connection.meta.remoteAddress === remoteAddress) {
        console.log(`[WsManager] - Closing duplicate connection: ${existingClientId} (${remoteAddress})`);
        this.removeConnection(connections, existingClientId);
        closedCount++;
      }
    }
    
    return closedCount;
  }

  setupConnectionHandlers(connections, clientId, ws) {
    ws.isAlive = true;
    ws.lastActivity = Date.now();
    
    ws.on('pong', () => {
      ws.isAlive = true;
      ws.lastActivity = Date.now();
      this.updateConnection(connections, clientId, ws.lastActivity);
    });

    ws.on('close', () => this.removeConnection(connections, clientId));
    ws.on('error', () => this.removeConnection(connections, clientId));
  }

  updateConnection(connections, clientId, timestamp, dID = null) {
    const connection = this[connections].get(clientId);
    let newdID = connection.meta.dID;
    if (dID) {
        newdID = dID;
    } 
    if (connection) {
      connection.meta.lastActivity = timestamp;
      connection.meta.isAlive = true;
      connection.meta.dID = newdID;
    }
    console.log(`[WsManager] - 📡 Connection updated: ${clientId} (${newdID})`);
  }

  isConnectionActive(connections, clientId) {
    const connection = this[connections].get(clientId);
    if (!connection) return false;

    const { ws, meta } = connection;
    return ws && ws.readyState === WebSocket.OPEN && meta.isAlive;
  }

  removeConnection(connections, clientId) {
    const connection = this[connections].get(clientId);
    if (!connection) return;

    const { ws, dID, connectionType } = connection;

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.terminate();
    }

    this[connections].delete(clientId);

    if (dID) {
      this.unlinkUserDevice(dID, clientId);
    }
    console.log(`[WsManager] - 🗑 Connection removed: ${clientId} (${connectionType}, ${connection.key || 'no-key'})`);
  }

  hasConnection(connections, clientId) {
    return this[connections].has(clientId) && this.isConnectionActive(connections, clientId);
  }

  // getConnection(clientId) {
  //   const connection = this.connections.get(clientId);
  //   return connection && this.isConnectionActive(clientId) ? connection.ws : null;
  // }


  getConnection(connections,clientId) {
    const connection = this[connections].get(clientId);
    
    if (!connection) {
      console.log(`[WsManager] - getConnection - ❌ Соединение ${clientId} не найдено`);
      return null;
    }

    const { ws, meta, connectionType, dID } = connection;
    
    if (!this.isConnectionActive(connections, clientId)) {
      console.log(`[WsManager] - getConnection - ⚠️ Соединение ${clientId} неактивно`);
      return null;
    }

    // Детальное логирование информации о клиенте
    console.log(`[WsManager] - getConnection - 📋 Информация о клиенте:`);
    console.log(`  ID клиента: ${meta.clientId}`);
    console.log(`  Тип подключения: ${connectionType}`);
    console.log(`  dID: ${dID || 'не задан'}`);
    console.log(`  Адрес: ${meta.remoteAddress}`);
    console.log(`  Статус WebSocket: ${ws.readyState === WebSocket.OPEN ? 'OPEN' : 'NOT_OPEN'}`);
    console.log(`  Время последней активности: ${new Date(meta.lastActivity).toISOString()}`);
    
    return ws;
  
  }
  getUserConnections(connections,dID, key = null) {
    const result = [];
    
    for (const [clientId, connection] of this[connections]) {
      if (!this.isConnectionActive(connections, clientId)) continue;
      if (connection.dID !== dID) continue;
      
      // Если key не указан - возвращаем все соединения с этим dID
      // Если key указан - возвращаем только соединения с этим ключом
      if (key === null || connection.key === key) {
        result.push({
          clientId,
          connection: connection // исправлено с connect на connection
        });
      }
    }
    
    return result;
  }

  getAllActiveConnections(connections) {
    const map = this[connections];
  if (!(map instanceof Map)) {
    console.error(`[WsManager] - ❌ ${connections} is not a Map`);
    return [];
  }
    const result = [];
    for (const [clientId, connection] of map) {
      if (this.isConnectionActive(connections, clientId)) {
        result.push({
          clientId,
          ws: connection.ws.isAlive,
          connectionType: connection.connectionType,
          dID: connection.dID,
          meta: connection.meta
        });
      }
    }
    return result;
  }

  sendToConnection(connections, clientId, type, request, name, message) {
    const ws = this.getConnection(connections, clientId);
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        const response = {
          type: type || 'unknown',
          request: request || 'unknown',
          name: name || 'unknown',
          payload: message
        };
        console.log('[WsManager] - sendToConnection - 📨 Отправляем сообщение:');
        console.log(`  Тип: ${type}`);
        console.log(`  Запрос: ${request}`);
        console.log(`  Имя: ${name}`);
        console.log(`  Данные:`, message);

        const messageString = typeof response === 'string' ? response : JSON.stringify(response);
        ws.send(messageString);
        console.log ('[WsManager] - sendToConnection - Отправлено сообщение', clientId);
        return true;
      } catch (error) {
        console.error(`[WsManager] - sendToConnection - Error sending to ${clientId}:`, error);
        this.removeConnection(connections, clientId);
        return false;
      }
    }
    return false;
  }

sendToUser(connections, dID, message, key = null) {
  const userConnections = this.getUserConnections(dID, key);
  let sentCount = 0;

  userConnections.forEach(({ clientId }) => {
    if (this.sendToConnection(connections, clientId, message)) {
      sentCount++;
    }
  });

  console.log(`[WsManager] - Message sent to ${sentCount}/${userConnections.length} devices of user ${dID}${key ? ` with key ${key}` : ''}`);
  return sentCount;
}

//   broadcastToType(connectionType, message) {
//     console.log(`[wsManager] - broadcastToType Выполняем отправку сообщения всем ${connectionType} connections`);
//     const connections = this.getConnectionsByType(connectionType);
//     let sentCount = 0;

//     connections.forEach(({ clientId }) => {
//       if (this.sendToConnection(clientId, message)) {
//         sentCount++;
//       }
//     });

//     return sentCount;
//   }


  startHeartbeat(connections, interval = 30000, timeout = 60000) {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      
      for (const [clientId, connection] of this[connections]) {
        const { ws, meta } = connection;
        
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          this.removeConnection(connections, clientId);
          continue;
        }

        if (now - meta.lastActivity > timeout) {
          console.warn(`[WsManager] - 💀 Heartbeat timeout for ${clientId}`);
          this.removeConnection(connections,clientId);
          continue;
        }

        if (!meta.isAlive) {
          ws.terminate();
          this.removeConnection(connections, clientId);
          continue;
        }

        meta.isAlive = false;
        try {
          ws.ping(null, false, (err) => {
            if (err) {
              console.error(`[WsManager] - Ping error for ${clientId}:`, err);
              this.removeConnection(connections, clientId);
            }
          });
        } catch (error) {
          console.error(`[WsManager] - Ping failed for ${clientId}:`, error);
          this.removeConnection(connections, clientId);
        }
      }
    }, interval).unref();

    console.log(`[WsManager] - Heartbeat started: interval=${interval}ms, timeout=${timeout}ms`);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log('[WsManager] - Heartbeat stopped');
    }
  }

  getStats(connections) {
    const totalConnections = this[connections].size;
    const activeConnections = this.getAllActiveConnections(connections).length;
    
    return {
      totalConnections,
      activeConnections,
    };
  }

  cleanup(connections) {
    this.stopHeartbeat();
    
    for (const clientId of this[connections].keys()) {
      this.removeConnection(connections, clientId);
    }
    
    this[connections].clear();
    
    console.log('[WsManager] - All connections cleaned up');
  }
}

const wsManager = new WsManager();
module.exports = wsManager;