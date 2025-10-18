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
    this.connections = new Map();
    this.heartbeatInterval = null;
  }
  generateConnectionId(dID = null) {
    const random = Math.random().toString(32);
    return dID ? `${dID}_${random}` : `${random}`;
  }
  registerConnection(ws, connectionType, dID = null, key = null) {
    console.log('[wsManager] - registerConnection - Начинаем регистрацию подключения');
    if (!['input', 'output'].includes(connectionType)) {
      throw new TypeError(`Invalid connectionType: "${connectionType}"`);
    }   
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
    const clientId = this.generateConnectionId(dID);

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
    this.connections.set(clientId, connection);
    this.setupConnectionHandlers(clientId, ws);
    console.log(`[WsManager] - ✅ ${connectionType} Соединение зарегистрировано: ${clientId} (${key || 'no-key'}) - ${fullAddress}`);
    
    return clientId;
  }
findExistingConnection(dID, connectionType, remoteAddress) {
  for (const [clientId, connection] of this.connections) {
    if (connection.dID === dID && 
        connection.connectionType === connectionType && 
        connection.meta.remoteAddress === remoteAddress &&
        this.isConnectionActive(clientId)) {
      return { clientId, connection };
    }
  }
  return null;
}
  closeDuplicateConnections(dID, connectionType, remoteAddress) {
    let closedCount = 0;
    
    for (const [existingClientId, connection] of this.connections) {
      if (connection.dID === dID && 
          connection.connectionType === connectionType && 
          connection.meta.remoteAddress === remoteAddress) {
        console.log(`[WsManager] - Closing duplicate connection: ${existingClientId} (${remoteAddress})`);
        this.removeConnection(existingClientId);
        closedCount++;
      }
    }
    
    return closedCount;
  }

  setupConnectionHandlers(clientId, ws) {
    ws.isAlive = true;
    ws.lastActivity = Date.now();
    
    ws.on('pong', () => {
      ws.isAlive = true;
      ws.lastActivity = Date.now();
      this.updateConnection(clientId, ws.lastActivity);
    });

    ws.on('close', () => this.removeConnection(clientId));
    ws.on('error', () => this.removeConnection(clientId));
  }

  updateConnection(clientId, timestamp, dID = null) {
    const connection = this.connections.get(clientId);
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

  isConnectionActive(clientId) {
    const connection = this.connections.get(clientId);
    if (!connection) return false;

    const { ws, meta } = connection;
    return ws && ws.readyState === WebSocket.OPEN && meta.isAlive;
  }

  removeConnection(clientId) {
    const connection = this.connections.get(clientId);
    if (!connection) return;

    const { ws, dID, connectionType } = connection;

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.terminate();
    }

    this.connections.delete(clientId);

    if (dID) {
      this.unlinkUserDevice(dID, clientId);
    }
    console.log(`[WsManager] - 🗑 Connection removed: ${clientId} (${connectionType}, ${key || 'no-key'})`);
  }

  hasConnection(clientId) {
    return this.connections.has(clientId) && this.isConnectionActive(clientId);
  }

  getConnection(clientId) {
    const connection = this.connections.get(clientId);
    return connection && this.isConnectionActive(clientId) ? connection.ws : null;
  }

getUserConnections(dID, key = null) {
  const result = [];
  
  for (const [clientId, connection] of this.connections) {
    if (!this.isConnectionActive(clientId)) continue;
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

  getAllActiveConnections() {
    const result = [];
    for (const [clientId, connection] of this.connections) {
      if (this.isConnectionActive(clientId)) {
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

  sendToConnection(clientId, message) {
    const ws = this.getConnection(clientId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        const messageString = typeof message === 'string' ? message : JSON.stringify(message);
        ws.send(messageString);
        console.log ('[WsManager] - sendToConnection - Отправлено сообщение', clientId);
        return true;
      } catch (error) {
        console.error(`[WsManager] - sendToConnection - Error sending to ${clientId}:`, error);
        this.removeConnection(clientId);
        return false;
      }
    }
    return false;
  }

sendToUser(dID, message, key = null) {
  const userConnections = this.getUserConnections(dID, key);
  let sentCount = 0;

  userConnections.forEach(({ clientId }) => {
    if (this.sendToConnection(clientId, message)) {
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


  startHeartbeat(interval = 30000, timeout = 60000) {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      
      for (const [clientId, connection] of this.connections) {
        const { ws, meta } = connection;
        
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          this.removeConnection(clientId);
          continue;
        }

        if (now - meta.lastActivity > timeout) {
          console.warn(`[WsManager] - 💀 Heartbeat timeout for ${clientId}`);
          this.removeConnection(clientId);
          continue;
        }

        if (!meta.isAlive) {
          ws.terminate();
          this.removeConnection(clientId);
          continue;
        }

        meta.isAlive = false;
        try {
          ws.ping(null, false, (err) => {
            if (err) {
              console.error(`[WsManager] - Ping error for ${clientId}:`, err);
              this.removeConnection(clientId);
            }
          });
        } catch (error) {
          console.error(`[WsManager] - Ping failed for ${clientId}:`, error);
          this.removeConnection(clientId);
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

  getStats() {
    const totalConnections = this.connections.size;
    const activeConnections = this.getAllActiveConnections().length;
    
    return {
      totalConnections,
      activeConnections,
      connectionsByType: {
        input: this.getConnectionsByType('input').length,
        output: this.getConnectionsByType('output').length
      }
    };
  }

  cleanup() {
    this.stopHeartbeat();
    
    for (const clientId of this.connections.keys()) {
      this.removeConnection(clientId);
    }
    
    this.connections.clear();
    
    console.log('[WsManager] - All connections cleaned up');
  }
}

const wsManager = new WsManager();
module.exports = wsManager;