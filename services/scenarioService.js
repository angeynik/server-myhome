// services/scenarioService.js
// Сценарии автоматизации: правка из приложения и доставка в Node-RED (docs/scenarios.md).
//
//   Vue post/scenarios ─▶ applyChange ─▶ scenarioStore (<dID>_scenarios.json)
//                                   ├─▶ response/scenarios — всем Vue этого dID с уровнем ≥ 2
//                                   └─▶ post/scenarios     — соединениям Node-RED этого dID
//   Node-RED init/init_ws ─▶ sendToNodeRED: файл есть — Node-RED получает сценарии целиком
//
// Выполняет сценарии Node-RED (вкладка «4. Сценарии», репозиторий nRed): он хранит копию в
// своём файле и работает без сервера. Нет файла на сервере — Node-RED работает по своему файлу.
'use strict';

const WebSocket = require('ws');
const logger = require('./logger.js');

const VIEW_LEVEL = 2; // как get/scenarios в REQUIRED_LEVEL

function createScenarioService({ store, wsManager, auth }) {
  function send(ws, raw) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(raw);
    return true;
  }

  // Конфигурация сценариев — всем сессиям dID с правом её видеть (в том числе автору)
  function broadcastToVue(dID, data) {
    const raw = JSON.stringify({ type: 'response', request: 'scenarios', name: dID, payload: data });
    let sent = 0;
    for (const { clientId, connection } of wsManager.getUserConnections('VUE_connections', dID)) {
      const s = auth.getSession(clientId);
      if (!s || s.dID !== dID || s.level < VIEW_LEVEL) continue;
      try {
        if (send(connection.ws, raw)) sent++;
      } catch (e) {
        logger.logErrorMessage(`[scenarioService] - scenarios → ${clientId}: ${e.message}`);
      }
    }
    return sent;
  }

  // При NODERED_ENABLED=false соединений Node-RED нет — отправлять некому
  function pushToNodeRED(dID, data) {
    const raw = JSON.stringify({ type: 'post', request: 'scenarios', name: dID, payload: data, time: new Date().toString() });
    let sent = 0;
    for (const { clientId, connection } of wsManager.getUserConnections('nRED_connections', dID)) {
      try {
        if (send(connection.ws, raw)) sent++;
      } catch (e) {
        logger.logErrorMessage(`[scenarioService] - scenarios → NodeRED ${clientId}: ${e.message}`);
      }
    }
    if (!sent) logger.logInfoMessage(`[scenarioService] - ${dID}: Node-RED не подключён, сценарии уйдут при подключении`);
    return sent;
  }

  // Node-RED подключился (init/init_ws): сценарии сервера, если они есть
  async function sendToNodeRED(dID) {
    const data = await store.read(dID);
    if (!data) return 0;
    return pushToNodeRED(dID, data);
  }

  // action: create | edit | delete | enable | settings
  async function applyChange(dID, action, configData = {}, actor = null) {
    let result;
    switch (action) {
      case 'create': result = await store.save(dID, configData, actor, { mustBeNew: true }); break;
      case 'edit': result = await store.save(dID, configData, actor, { mustExist: true }); break;
      case 'delete': result = await store.remove(dID, configData.id); break;
      case 'enable': result = await store.setEnabled(dID, configData.id, configData.enabled, actor); break;
      case 'settings': result = await store.saveSettings(dID, configData); break;
      default: {
        const e = new Error(`Неизвестное действие: ${action} (create | edit | delete | enable | settings)`);
        e.code = 'BAD_ACTION';
        throw e;
      }
    }
    broadcastToVue(dID, result.data);
    const delivered = pushToNodeRED(dID, result.data);
    logger.logInfoMessage(`[scenarioService] - ${dID}: ${action} ${result.id || ''} (${actor?.username || '—'}), Node-RED: ${delivered}`);
    return { ...result, delivered };
  }

  return { applyChange, sendToNodeRED, broadcastToVue, pushToNodeRED };
}

let instance = null;

function get() {
  if (!instance) {
    instance = createScenarioService({
      store: require('./scenarioStore.js').createScenarioStore(),
      wsManager: require('../classes/wsManager.js'),
      auth: require('./auth.js'),
    });
  }
  return instance;
}

module.exports = { createScenarioService, get, VIEW_LEVEL };
