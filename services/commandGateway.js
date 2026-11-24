// services/commandGateway.js
// Единый механизм выполнения команды изменения (post от приложения или от Telegram-бота):
//
//   execute({ dID, message, clientId?, actor? })
//     ├─ команда тега Modbus TCP / RTU → мост пишет в устройство, после подтверждения сохраняет
//     │   значение в config-файл и рассылает его Vue (handleCommand + onResult)
//     └─ иначе → handlePost (запись в config-файл) и пересылка post остальным клиентам dID
//        (Vue и, если включён, NodeRED — получателей выбирает broadcast)
//   → Promise<{ ok, via: 'modbus' | 'modbus-rtu' | 'config', value?, error?, code? }>
//
// clientId — соединение Vue, от которого пришла команда (ему ответы и ошибки, broadcast его
// пропускает); у бота соединения нет — null: изменение получают все клиенты dID.
// Запросы из NO_BROADCAST_POST (пароли, служебные) мостам и другим клиентам не передаются.
'use strict';

const cfg = require('./authConfig');
const logger = require('./logger.js');

const BRIDGE_TIMEOUT_MS = 10000;

function createCommandGateway({ handlePost, broadcast, bridges = [], timeoutMs = BRIDGE_TIMEOUT_MS }) {
  // Мост, взявший команду: ждём подтверждения устройства (не дольше timeoutMs)
  function tryBridges(clientId, message) {
    for (const bridge of bridges) {
      if (!bridge.enabled()) continue;
      let resolve;
      const result = new Promise((r) => { resolve = r; });
      let handled = false;
      try {
        handled = bridge.handleCommand(clientId, message, { onResult: resolve });
      } catch (e) {
        logger.logErrorMessage(`[commandGateway] - ${bridge.name}: ${e.message}`);
      }
      if (!handled) continue;
      let timer;
      const timeout = new Promise((r) => {
        timer = setTimeout(() => r({ ok: false, error: 'Устройство не ответило', code: 'TIMEOUT' }), timeoutMs);
        timer.unref?.();
      });
      return Promise.race([result, timeout])
        .finally(() => clearTimeout(timer))
        .then((r) => ({ ...r, via: bridge.name }));
    }
    return null;
  }

  async function execute({ dID, message, clientId = null }) {
    const forwardable = !cfg.NO_BROADCAST_POST.has(message.request);
    const viaBridge = forwardable ? tryBridges(clientId, message) : null;
    if (viaBridge) return viaBridge;

    const result = (await handlePost(clientId, message)) || { ok: true };
    if (forwardable && result.ok) {
      try {
        broadcast(clientId, dID, message);
      } catch (e) {
        logger.logErrorMessage(`[commandGateway] - рассылка post: ${e.message}`);
      }
    }
    return { ...result, via: 'config' };
  }

  return { execute };
}

module.exports = { createCommandGateway, BRIDGE_TIMEOUT_MS };
