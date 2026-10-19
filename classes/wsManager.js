// classes/wsManager.js
// Управление WebSocket-подключениями:
//  - регистрация и хранение соединений в двух коллекциях (VUE / nRED)
//  - проверка активности, удаление мёртвых соединений
//  - поиск соединений по dID / key
//  - heartbeat (ping/pong) для каждой коллекции отдельно
//  - отправка сообщений конкретному соединению / всем соединениям пользователя
'use strict';

const WebSocket = require('ws');

class WsManager {
  constructor() {
    this.VUE_connections = new Map();
    this.nRED_connections = new Map();
    // Отдельный Map для интервалов heartbeat: имя коллекции -> setInterval id.
    // Раньше было ОДНО поле на все коллекции — второй startHeartbeat()
    // глушил первый, и VUE_connections оставался без heartbeat.
    this.heartbeatIntervals = new Map();
  }

  // ── Регистрация ────────────────────────────────────────────────────
  registerConnection(ws, connectionType, dID = null, key = null) {
    console.log('[wsManager] - registerConnection - Начинаем регистрацию подключения');

    const remoteAddress = ws._socket?.remoteAddress || 'unknown';
    const remotePort = ws._socket?.remotePort || 'unknown';
    const fullAddress = `${(remoteAddress || '').replace(/^::ffff:/, '')}:${remotePort}`;

    // Проверяем, нет ли уже активного соединения с тем же адресом и dID
    const existingConnection = this.findExistingConnection(dID, connectionType, fullAddress);
    if (existingConnection) {
      console.log(
        `[WsManager] - 🔄 registerConnection - Соединение: ` +
        `${existingConnection.clientId} - ${existingConnection.connection.connectionType} ` +
        `- (${fullAddress}) уже зарегистрировано`
      );
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
        isAlive: true,
      },
    };

    if (connectionType === 'dashboard') {
      this.VUE_connections.set(clientId, connection);
      this.setupConnectionHandlers('VUE_connections', clientId, ws);
      const allClients = this.getAllActiveConnections('VUE_connections');
      console.log(` !!!!!!!!!!!!!!!! - [wsManager] - registerConnection - Все соединения:`, allClients);
    } else if (connectionType === 'nodeRED') {
      this.nRED_connections.set(clientId, connection);
      this.setupConnectionHandlers('nRED_connections', clientId, ws);
      const allClients = this.getAllActiveConnections('nRED_connections');
      console.log(` !!!!!!!!!!!!!!!! - [wsManager] - registerConnection - Все соединения:`, allClients);
    } else {
      return 'Invalid connectionType';
    }

    console.log(
      `[WsManager] - ✅ ${connectionType} Соединение зарегистрировано: ` +
      `${clientId} (${key || 'no-key'}) - ${fullAddress}`
    );

    return clientId;
  }

  findExistingConnection(dID, connectionType, remoteAddress) {
    const mapName =
      connectionType === 'dashboard' ? 'VUE_connections' :
      connectionType === 'nodeRED'   ? 'nRED_connections' :
      null;
    if (!mapName) return null;

    for (const [clientId, connection] of this[mapName]) {
      if (
        connection.dID === dID &&
        connection.connectionType === connectionType &&
        connection.meta.remoteAddress === remoteAddress &&
        this.isConnectionActive(mapName, clientId)
      ) {
        return { clientId, connection };
      }
    }
    return null;
  }

  // collectionsName — ИМЯ коллекции: 'VUE_connections' | 'nRED_connections'
  closeDuplicateConnections(collectionsName, dID, connectionType, remoteAddress) {
    const map = this[collectionsName];
    if (!(map instanceof Map)) {
      console.log(`[WsManager] - ❌ closeDuplicateConnections: unknown collection ${collectionsName}`);
      return 0;
    }

    let closedCount = 0;
    for (const [existingClientId, connection] of map) {
      if (
        connection.dID === dID &&
        connection.connectionType === connectionType &&
        connection.meta.remoteAddress === remoteAddress
      ) {
        console.log(`[WsManager] - Closing duplicate connection: ${existingClientId} (${remoteAddress})`);
        this.removeConnection(collectionsName, existingClientId);
        closedCount++;
      }
    }
    return closedCount;
  }

  // ── Обновление ─────────────────────────────────────────────────────
  // dID обновляем ТОЛЬКО если он передан явно. Иначе pong-heartbeat,
  // который не знает dID, затирал бы его в null и broadcast перестал
  // находить соединение пользователя.
  updateConnection(connections, clientId, timestamp, dID = null) {
    const connection = this[connections].get(clientId);
    if (!connection) {
      console.log(`[WsManager] - ⚠️ Connection not found for update: ${clientId}`);
      return;
    }
    if (dID) {
      connection.dID = dID;
      connection.meta.dID = dID;
    }
    connection.meta.lastActivity = timestamp;
    connection.meta.isAlive = true;
    console.log(`[WsManager] - 📡 Connection updated: ${clientId} (${connection.dID})`);
  }

  // ── Проверка живости ──────────────────────────────────────────────
  // ВАЖНО: здесь проверяем только readyState сокета.
  // meta.isAlive — это флаг heartbeat-логики: перед ping он ставится false
  // и становится true только по pong. Если бы мы ориентировались на него,
  // то все send/broadcast в окне между ping и pong теряли бы сообщения.
  isConnectionActive(connections, clientId) {
    const connection = this[connections].get(clientId);
    if (!connection) return false;
    const { ws } = connection;
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  // ── Удаление соединения ───────────────────────────────────────────
  /**
   * @param {string} connections  Имя коллекции: 'VUE_connections' | 'nRED_connections'
   * @param {string} clientId
   * @param {object} [opts]
   * @param {number} [opts.code=1000]         Код закрытия (1000 = normal)
   * @param {string} [opts.reason='removed']  Причина закрытия
   * @param {boolean} [opts.force=false]      true → terminate() вместо close()
   */
  removeConnection(connections, clientId, opts = {}) {
    const { code = 1000, reason = 'removed', force = false } = opts;

    const map = this[connections];
    if (!(map instanceof Map)) {
      console.log(`[WsManager] - ❌ removeConnection: unknown collection ${connections}`);
      return;
    }

    const connection = map.get(clientId);
    if (!connection) return;   // повторный вызов из ws.on('close') — молча выходим

    const { ws, connectionType, key } = connection;

    // 1. Удаляем из Map ДО закрытия сокета — иначе close-событие вызовет
    //    removeConnection рекурсивно и мы дважды отработаем.
    map.delete(clientId);

    // 2. Закрываем сокет
    if (ws) {
      try {
        if (force) {
          ws.terminate();
        } else if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close(code, reason);
        }
        // CLOSING / CLOSED — событие close уже в пути, повторно не трогаем
      } catch (err) {
        console.error(`[WsManager] - removeConnection - close failed for ${clientId}:`, err.message);
        try { ws.terminate(); } catch {}
      }
    }

    console.log(
      `[WsManager] - 🗑 Connection removed: ${clientId} ` +
      `(${connectionType}, ${key || 'no-key'})${force ? ' [force]' : ''}`
    );
  }

  hasConnection(connections, clientId) {
    return this[connections].has(clientId) && this.isConnectionActive(connections, clientId);
  }

  // ── Получение соединения ──────────────────────────────────────────
  getConnection(connections, clientId) {
    const connection = this[connections].get(clientId);

    if (!connection) {
      console.log(`[WsManager] - getConnection - ❌ Соединение ${clientId} не найдено`);
      return null;
    }

    if (!this.isConnectionActive(connections, clientId)) {
      console.log(`[WsManager] - getConnection - ⚠️ Соединение ${clientId} неактивно`);
      return null;
    }

    const { ws, meta, connectionType, dID } = connection;

    console.log(`[WsManager] - getConnection - 📋 Информация о клиенте:`);
    console.log(`  ID клиента: ${meta.clientId}`);
    console.log(`  Тип подключения: ${connectionType}`);
    console.log(`  dID: ${dID || 'не задан'}`);
    console.log(`  Адрес: ${meta.remoteAddress}`);
    console.log(`  Статус WebSocket: ${ws.readyState === WebSocket.OPEN ? 'OPEN' : 'NOT_OPEN'}`);
    console.log(`  Время последней активности: ${new Date(meta.lastActivity).toISOString()}`);

    return ws;
  }

  getUserConnections(connections, dID, key = null) {
    const result = [];

    for (const [clientId, connection] of this[connections]) {
      if (!this.isConnectionActive(connections, clientId)) continue;
      if (connection.dID !== dID) continue;

      // key === null → все соединения с этим dID; иначе — только с этим ключом
      if (key === null || connection.key === key) {
        result.push({ clientId, connection });
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
          meta: connection.meta,
        });
      }
    }
    return result;
  }

  // ── Отправка ──────────────────────────────────────────────────────
  sendToConnection(connections, clientId, type, request, name, message) {
    console.log('[WsManager] - sendToConnection - 📨 Отправляем сообщение - request:', request);

    const ws = this.getConnection(connections, clientId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;

    try {
      const response = {
        type: type || 'unknown',
        request: request || 'unknown',
        name: name || 'unknown',
        payload: message,
      };

      const messageString = typeof response === 'string' ? response : JSON.stringify(response);
      ws.send(messageString);

      console.log(
        '[WsManager] - sendToConnection - Отправлено сообщение',
        response.type, response.request, response.name
      );
      return true;
    } catch (error) {
      console.error(`[WsManager] - sendToConnection - Error sending to ${clientId}:`, error);
      // Сокет, скорее всего, уже невалиден — прибиваем принудительно
      this.removeConnection(connections, clientId, { force: true });
      return false;
    }
  }

  sendToUser(connections, dID, message, key = null) {
    const userConnections = this.getUserConnections(connections, dID, key);
    let sentCount = 0;

    userConnections.forEach(({ clientId }) => {
      // message здесь — уже готовая структура {type, request, name, payload}
      if (this.sendToConnection(connections, clientId, message.type, message.request, message.name, message.payload)) {
        sentCount++;
      }
    });

    return sentCount;
  }

  // ── Обработчики соединения ────────────────────────────────────────
  setupConnectionHandlers(connections, clientId, ws) {
    ws.isAlive = true;
    ws.lastActivity = Date.now();

    ws.on('pong', () => {
      ws.isAlive = true;
      ws.lastActivity = Date.now();
      // dID сюда не передаём — updateConnection сам разберётся
      this.updateConnection(connections, clientId, ws.lastActivity);
    });

    ws.on('close', () => this.removeConnection(connections, clientId));

    // На error сокет часто невалиден — закрываем жёстко
    ws.on('error', () => this.removeConnection(connections, clientId, { force: true }));
  }

  // ── Heartbeat ─────────────────────────────────────────────────────
  startHeartbeat(connections, interval = 30000, timeout = 60000) {
    // Страховка: если конструктор не отработал (или вызывают раньше)
    if (!this.heartbeatIntervals) this.heartbeatIntervals = new Map();

    const existing = this.heartbeatIntervals.get(connections);
    if (existing) clearInterval(existing);

    if (!this[connections] || !(this[connections] instanceof Map)) {
      console.log(`[WsManager] - ❌ Invalid collection for heartbeat: ${connections}`);
      return;
    }

    const id = setInterval(() => {
      const now = Date.now();

      for (const [clientId, connection] of this[connections]) {
        const { ws, meta } = connection;

        if (!ws || ws.readyState !== WebSocket.OPEN) {
          this.removeConnection(connections, clientId, { force: true });
          continue;
        }

        if (now - meta.lastActivity > timeout) {
          console.warn(`[WsManager] - 💀 Heartbeat timeout for ${clientId}`);
          this.removeConnection(connections, clientId, { force: true });
          continue;
        }

        if (!meta.isAlive) {
          this.removeConnection(connections, clientId, { force: true });
          continue;
        }

        meta.isAlive = false;
        try {
          ws.ping(null, false, (err) => {
            if (err) {
              console.error(`[WsManager] - Ping error for ${clientId}:`, err.message);
              this.removeConnection(connections, clientId, { force: true });
            }
          });
        } catch (error) {
          console.error(`[WsManager] - Ping failed for ${clientId}:`, error.message);
          this.removeConnection(connections, clientId, { force: true });
        }
      }
    }, interval).unref();

    this.heartbeatIntervals.set(connections, id);
  }

  stopHeartbeat(connections) {
    if (!this.heartbeatIntervals) return;

    if (connections) {
      const id = this.heartbeatIntervals.get(connections);
      if (id) clearInterval(id);
      this.heartbeatIntervals.delete(connections);
    } else {
      for (const id of this.heartbeatIntervals.values()) clearInterval(id);
      this.heartbeatIntervals.clear();
    }
  }

  // ── Статистика / очистка ──────────────────────────────────────────
  getStats(connections) {
    const totalConnections = this[connections].size;
    const activeConnections = this.getAllActiveConnections(connections).length;
    return { totalConnections, activeConnections };
  }

  cleanup(connections) {
    this.stopHeartbeat(connections);

    if (!this[connections] || !(this[connections] instanceof Map)) {
      console.log(`[WsManager] - ❌ Invalid collection for cleanup: ${connections}`);
      return;
    }

    for (const clientId of [...this[connections].keys()]) {
      this.removeConnection(connections, clientId, {
        code: 1001,
        reason: 'server shutdown',
        force: true,
      });
    }

    this[connections].clear();
    console.log('[WsManager] - All connections cleaned up');
  }
}

const wsManager = new WsManager();
module.exports = wsManager;