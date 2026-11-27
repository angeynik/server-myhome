// serverapp.js — точка входа: HTTP-сервер (Express + CORS), WS-серверы Dashboard и NodeRED,
// маршрутизация сообщений и запуск сервисов (Modbus TCP, видео, Telegram, GPIO).
// Бизнес-логики не содержит: она в services/ и classes/. Протокол — rules.md.
'use strict';

const express = require('express');
const http = require('http');
const cors = require('cors');
const userStore = require('./services/userStore.js');
const auth = require('./services/auth');
const cfg = require('./services/authConfig');

const wsManager = require('./classes/wsManager.js');
const modbusManager = require('./classes/modBusTCPManager');
const modbusBridge  = require('./services/modbusTCPBridge.js');
const modbusRtuBridge = require('./services/modbusRTUBridge.js'); // modbus-serial грузится только при init()
const nc = require('./services/notifyConfig.js');
const notifyService = require('./services/notifyService.js');
const telegramService = require('./services/telegramService.js');
const videoHub = require('./services/videoHub.js');
const notificationService = require('./services/notificationService.js');
const scenarioService = require('./services/scenarioService.js');
const { createCommandGateway } = require('./services/commandGateway.js');

const { addMessageToQueue, processAllQueues} = require('./services/messageStore.js');
const { handleAuth, handleGet, handlePost } = require('./services/messageHandlers.js');

// conf.env загружается в services/authConfig.js (подключён выше)


const { validType, validPost, validMessage } = require('./services/validate');

const servPORT = process.env.SERVER_PORT || 3010;
const wsRedPORT = process.env.WSR_PORT_IN|| 9200;
const wsRedHOST = process.env.WSR_HOST || '127.0.0.1';
const wsDashPORT = process.env.WSD_PORT_IN|| 9202;
// ── Флаги управления потоками ─────────────────────────────────────────
const NODERED_ENABLED = String(process.env.NODERED_ENABLED ?? 'true').toLowerCase() === 'true';
const MODBUS_ENABLED  = String(process.env.MODBUS_ENABLED  ?? 'true').toLowerCase() === 'true';
const VIDEO_ENABLED   = String(process.env.VIDEO_ENABLED   ?? 'true').toLowerCase() === 'true';
// Modbus RTU (RS-485, modBus/): по умолчанию выключен, конфигурация — MODBUS_RTU_CONF
const MODBUS_RTU_ENABLED = String(process.env.MODBUS_RTU_ENABLED ?? 'false').toLowerCase() === 'true';


const logger = require('./services/logger.js');
logger.initLogging();
logger.logInfoMessage(`[Serverapp] - версия ${require('./services/version.js').LABEL}`);
logger.logInfoMessage(
  `[Serverapp] - потоки: VUE=ON, NodeRED=${NODERED_ENABLED ? 'ON' : 'OFF'}, ` +
  `Modbus TCP=${MODBUS_ENABLED ? 'ON' : 'OFF'}, Modbus RTU=${MODBUS_RTU_ENABLED ? 'ON' : 'OFF'}, ` +
  `Video=${VIDEO_ENABLED ? 'ON' : 'OFF'}`
);
{
  const { ENV_OVERRIDES } = require('./services/authConfig.js');
  if (ENV_OVERRIDES.length) {
    logger.logErrorMessage(
      `[Serverapp] - переменные окружения терминала перекрывают conf.env (значения из conf.env не действуют): ${ENV_OVERRIDES.join(', ')}. ` +
      `Где задано: grep -n ${ENV_OVERRIDES[0]} ~/.zshrc ~/.zprofile ~/.bash_profile — удалите строку export и откройте новый терминал (docs/cameras.md, 1.2)`
    );
  }
}

const app = express();
const server = http.createServer(app);
app.use(cors());
app.use(express.json());


// ── Инициализация ─────────────────────────────────────────────────────────


(async () => {
  try {
    // loadUsers() сам:
    //   1) загрузит или сгенерирует AUTH_KEY_FILE (0600),
    //   2) если USERS_FILE нет — создаст с DEFAULT_USER_* и запишет,
    //   3) положит расшифрованный объект в in-memory кэш.
    const data = await userStore.loadUsers();

    logger.logInfoMessage(
      `[Serverapp] - userStore готов: ` +
      `пользователей ${data.users.length}, ` +
      `источников данных ${data.datasources.length}`
    );

    logger.logDevMessage(
      `[Serverapp] - userStore: users=[${data.users.map(u => u.username).join(', ')}], ` +
      `datasources=[${data.datasources.map(d => d.did).join(', ')}]`
    );
  } catch (e) {
    logger.logErrorMessage(`[Serverapp] - ошибка userStore: ${e.message}`);
    // Не роняем процесс — сервер поднимется, но авторизация работать не будет.
    // Админ увидит ошибку в логах и восстановит файлы.
  }
})();

  // Запуск сервера
  server.listen(servPORT, () => {
    logger.logInfoMessage(`[Serverapp] - MyHome Server is running on port ${servPORT}`);
  });

// ── Корректное завершение работы ──────────────────────────────────────────
let isShuttingDown = false;
let forceShutdownTimer;

const handleShutdown = async () => {
  if (isShuttingDown) {
    safeWrite('ℹ️ Завершение уже начато, ожидайте...');
    return;
  }
  
  isShuttingDown = true;
  safeWrite('\n🛑 Получен сигнал завершения. Начинаю остановку сервера...');

  try {
    // 0. Останавливаем heartbeat мониторинг
    wsManager.stopHeartbeat();
    safeWrite('✅ Heartbeat monitoring stopped');
    await telegramService.stop();
    safeWrite('✅ Telegram остановлен');
    notificationService.get().stop();
    safeWrite('✅ Служба уведомлений остановлена');
    await videoHub.stop();
    safeWrite('✅ Видео остановлено');
    if (MODBUS_ENABLED) {
      modbusBridge.stop();
      modbusManager.cleanup();
      safeWrite('✅ Modbus остановлен');
    }
    if (MODBUS_RTU_ENABLED) {
      modbusRtuBridge.stop();
      safeWrite('✅ Modbus RTU остановлен');
    }

    // 2. Закрываем WebSocket-серверы и их соединения через wsManager
    safeWrite('🔄 Закрываем WebSocket соединения...');

    try {

      // Очищаем все соединения через wsManager
      const cleanupResults = [
        { name: 'Dashboard connections', result: wsManager.cleanup('VUE_connections') },
      ];
      if (NODERED_ENABLED) {
        cleanupResults.push({ name: 'NodeRED connections', result: wsManager.cleanup('nRED_connections') });
      }

      cleanupResults.forEach(({ name, result }) => {
        if (result) {
          safeWrite(`✅ ${name} успешно очищены`);
        } else {
          safeWrite(`⚠️ ${name} не были очищены (возможно, уже закрыты)`);
        }
      });

      safeWrite('✅ Все WebSocket соединения закрыты через wsManager');

      // Закрываем сами WebSocket серверы
      const wsServers = [
        { name: 'WSSNodeRED', instance: WSSNodeRED },
        { name: 'WSSDash', instance: WSSDash }
      ];
      
      await Promise.all(wsServers.map(server => 
        new Promise(resolve => {
          if (server.instance && typeof server.instance.close === 'function' && server.instance._server) {
            server.instance.close(err => {
              if (err) {
                safeWrite(`🛑 ${server.name}: ошибка закрытия - ${err.message}`);
              } else {
                safeWrite(`✅ ${server.name}: WebSocket сервер успешно закрыт`);
              }
              resolve();
            });
          } else {
            safeWrite(`ℹ️ ${server.name}: сервер уже закрыт или невалиден`);
            resolve();
          }
        })
      ));

    } catch (error) {
      safeWrite(`⚠️ Ошибка при закрытии WebSocket соединений: ${error.message}`);
    };

    // 3. Закрываем Express сервер
    if (server && server.listening) {
      await new Promise(resolve => {
        server.close(err => {
          if (err) {
            safeWrite(`⛔ Ошибка закрытия сервера: ${err.message}`);
          } else {
            safeWrite('✅ Сервер Express успешно остановлен');
          }
          resolve();
        });
      });
    } else {
      safeWrite('ℹ️ Сервер Express не запущен или уже остановлен');
    }

    // 4. Принудительно завершаем процесс после успешного закрытия всех сервисов
    safeWrite('🎯 Завершение выполнено успешно.');
    process.exit(0);

  } catch (error) {
    safeWrite(`⚠️ Критическая ошибка: ${error.message}`);
  } finally {
    // Таймер принудительного завершения (если процесс зависает)
    forceShutdownTimer = setTimeout(() => {
      safeWrite('⏱️ Принудительное завершение по таймауту');
      process.exit(1);
    }, 5000);
  }
};

// Функция безопасного вывода
const safeWrite = (message) => {
  try {
    process.stderr.write(message + '\n');
  } catch (e) {}
};

// Обработчики сигналов
process.on('SIGINT', () => handleShutdown());
process.on('SIGTERM', () => handleShutdown());


const WebSocket = require('ws');

//устанавливаем соединение через Web Socket
let WSSNodeRED = null;
if (NODERED_ENABLED) {
  // Канал NodeRED без аутентификации: по умолчанию слушаем только локальный интерфейс.
  // Если NodeRED на другой машине — WSR_HOST=<адрес интерфейса> и ограничение файрволом.
  WSSNodeRED = new WebSocket.Server({ port: wsRedPORT, host: wsRedHOST });
  logger.logInfoMessage(`[Serverapp] - NodeRED WS слушает ${wsRedHOST}:${wsRedPORT}`);
} else {
  logger.logInfoMessage('[Serverapp] - NodeRED отключён (NODERED_ENABLED=false)');
}
const WSSDash = new WebSocket.Server ({port:wsDashPORT, host: '0.0.0.0' });

// Выполнение команд изменения — общее для приложения (WSSDash) и Telegram-бота
const commandGateway = createCommandGateway({
  handlePost,
  broadcast: (excludeClientId, dID, data) => broadcast(excludeClientId, dID, data),
  bridges: [
    { name: 'modbus', enabled: () => MODBUS_ENABLED, handleCommand: (...a) => modbusBridge.handleCommand(...a) },
    { name: 'modbus-rtu', enabled: () => MODBUS_RTU_ENABLED, handleCommand: (...a) => modbusRtuBridge.handleCommand(...a) },
  ],
});

console.log(`WebSocket servers are running nodeRed ws port:${wsRedPORT}`);
console.log(`WebSocket servers are running  DashBoard (client) ws port:${wsDashPORT}`);

// ✅ ЗАПУСКАЕМ HEARTBEAT ДЛЯ ВСЕХ WebSocket СОЕДИНЕНИЙ
wsManager.startHeartbeat('VUE_connections', 180000, 370000); // Для Dashboard соединений
if (NODERED_ENABLED) {
  wsManager.startHeartbeat('nRED_connections', 240000, 500000);
}
logger.logDevMessage('[Serverapp] - Heartbeat monitoring started for all WebSocket  connections');

if (MODBUS_ENABLED) {
  modbusManager.loadFromEnv();
  modbusBridge.init({ broadcast });
  logger.logInfoMessage('[Serverapp] - Запускаем modbusBridge TCP');
} else {
  logger.logInfoMessage('[Serverapp] - Modbus отключён (MODBUS_ENABLED=false)');
}

if (MODBUS_RTU_ENABLED) {
  // Ошибка RTU (нет порта, неверный конфиг) не мешает работе остального сервера
  modbusRtuBridge.init({ broadcast })
    .then(({ master, slave }) => logger.logInfoMessage(`[Serverapp] - Modbus RTU запущен: тегов Master ${master}, Slave ${slave}`))
    .catch((e) => logger.logErrorMessage(`[Serverapp] - Modbus RTU не запущен: ${e.message}`));
} else {
  logger.logInfoMessage('[Serverapp] - Modbus RTU отключён (MODBUS_RTU_ENABLED=false)');
}

if (VIDEO_ENABLED) {
  // Без камер хаб всё равно следит за cameras.json: камеры можно добавить без перезапуска
  videoHub.init();
  videoHub.start();
  videoHub.watch();
} else {
  logger.logInfoMessage('[Serverapp] - Видео отключено (VIDEO_ENABLED=false)');
}

// Уведомления по условиям: проверка раз в NOTIFICATION_CHECK_INTERVAL_MS (docs/notifications.md)
if (nc.NOTIFICATION_ENABLED) {
  notificationService.get().start();
} else {
  logger.logInfoMessage('[Serverapp] - Уведомления отключены (NOTIFICATION_ENABLED=false)');
}

function forwardFromTelegram(data) {
  if (!NODERED_ENABLED) return false;
  if (wsManager.getUserConnections('nRED_connections', data.name).length === 0) return false;
  broadcast('telegram', data.name, data, ['nRED_connections']);
  return true;
}

if (nc.TELEGRAM_REQUESTED) {
  if (!nc.TELEGRAM_ENABLED) {
    logger.logErrorMessage('[Serverapp] - TELEGRAM_ENABLED=true, но TELEGRAM_BOT_TOKEN не задан');
  } else {
    telegramService.init({ forward: forwardFromTelegram, executeCommand: (args) => commandGateway.execute(args) }).start()
      .catch((e) => logger.logErrorMessage(`[Serverapp] - Telegram: ${e.message}`));
  }
} else {
  logger.logInfoMessage('[Serverapp] - Telegram отключён (TELEGRAM_ENABLED=false)');
}

// Запускаем обработчик очередей WebSocket сообщений каждые 5 секунд (можно чаще, например, каждую секунду)
const QUEUE_PROCESS_INTERVAL = 15000;
setInterval(async () => {
  try {
    const vueStats  = wsManager.getStats('VUE_connections');
    const nredStats = wsManager.getStats('nRED_connections');
    logger.logDevMessage(
      `[Serverapp] - stats - VUE ${vueStats.activeConnections}/${vueStats.totalConnections}, ` +
      `nRED ${nredStats.activeConnections}/${nredStats.totalConnections}`
    );
    await processAllQueues();
  } catch (error) {
    logger.logErrorMessage(`[Serverapp] - processAllQueues: ${error.message}`);
  }
}, QUEUE_PROCESS_INTERVAL).unref();

// 2) Очистка rate-limit и закрытие соединений Dashboard, которые дольше
//    AUTH_TIMEOUT_MS остаются без входа (один таймер на процесс).
//    Сессии вошедших пользователей по бездействию не истекают.
const SESSION_CLEANUP_INTERVAL = Math.min(60_000, Math.max(5_000, Math.floor((cfg.AUTH_TIMEOUT_MS || 60_000) / 4)));
const AUTH_TIMEOUT_CLOSE_CODE = 4401;

setInterval(() => {
  try {
    for (const clientId of auth.cleanupSessions()) {
      wsManager.sendToConnection(
        'VUE_connections', clientId,
        'error', 'accessError', 'unknown',
        { code: 'TIMEOUT', message: 'Время на вход истекло' }
      );
      wsManager.removeConnection('VUE_connections', clientId, {
        code: AUTH_TIMEOUT_CLOSE_CODE,
        reason: 'auth timeout',
      });
    }
  } catch (e) {
    logger.logErrorMessage(`[Serverapp] - cleanupSessions: ${e.message}`);
  }
}, SESSION_CLEANUP_INTERVAL).unref();


// Работаем с NodeRED
if (NODERED_ENABLED) {
  WSSNodeRED.on('connection', (ws, req) => {
    logger.logDevMessage(`[Serverapp] - WSSNodeRED.on - Новое подключение nodeRED (VUE)`);
    const connectionId = wsManager.registerConnection(ws, 'nodeRED', null);
    logger.logDevMessage(`[Serverapp] - WSSNodeRED.on - nodeRED соединение зарегистрировано: ${connectionId}`);


    const params = new URLSearchParams(req.url.replace(/^.*\?/, ""));
    const id = params.get("id");
    logger.logInfoMessage(`[Serverapp] - WSSNodeRED.on - id: ${id}`);


  logger.logDevMessage(`Client connected to NodeRED on port ${wsRedPORT}`);

  ws.on('message', async (message) => {
        logger.logDevMessage(`[Serverapp] - WSSNodeRED RAW: ${message.toString()}`);
        try {
          const checkInputMessage = checkMessage(message);
          logger.logDevMessage(`[Serverapp] - WSSNodeRED - checkInputMessage - ${JSON.stringify(checkInputMessage, null, 2)}`);
          if(checkInputMessage.status === 'ok') {

            const dID = checkInputMessage.data.name;
            // dID попадает в имена файлов и выбор получателей: недопустимый — отбрасываем сообщение
            if (dID !== undefined && !cfg.isValidDID(dID)) {
              logger.logErrorMessage(`[Serverapp] - WSSNodeRED - недопустимый dID, сообщение отброшено (${checkInputMessage.data.type}/${checkInputMessage.data.request})`);
              return;
            }
            if (dID) {
              const conn = wsManager.nRED_connections.get(connectionId);
              if (conn && !conn.dID) {
                wsManager.updateConnection('nRED_connections', connectionId, Date.now(), dID);
                logger.logInfoMessage(
                  `[Serverapp] - WSSNodeRED: dID привязан из первого сообщения (${checkInputMessage.data.type}/${checkInputMessage.data.request}) → ${dID}`
                );
              }
            }
            switch (checkInputMessage?.data?.type) {
              case 'init':     
                    if (checkInputMessage.data.request === 'init_ws') {
                      logger.logDevMessage(`[Serverapp] - WSSNodeRED - Пришло сообщение init_ws: ${JSON.stringify(checkInputMessage.data, null, 2)}`);
                      wsManager.updateConnection('nRED_connections', connectionId, Date.now(), checkInputMessage.data.name);
                      // Сценарии сервера — в Node-RED (без файла на сервере он работает по своему)
                      scenarioService.get().sendToNodeRED(dID)
                        .catch((e) => logger.logErrorMessage(`[Serverapp] - WSSNodeRED - сценарии → ${dID}: ${e.message}`));
                    }
                break;
              case 'message':
                    notifyService.dispatch(checkInputMessage.data, { source: 'nodered' })
                      .then((result) => {
                        if (!result.ok) logger.logErrorMessage(`[Serverapp] - WSSNodeRED - message: ${result.error}`);
                      })
                      .catch((e) => logger.logErrorMessage(`[Serverapp] - WSSNodeRED - message: ${e.message}`));
                break;
              case 'post':
                    logger.logDevMessage(`[Serverapp] - WSSNodeRED - Post -- Добавляем сообщение в очередь`);
                    addMessageToQueue(dID , checkInputMessage.data);
                    
                    try {
                    broadcast(connectionId, dID, checkInputMessage.data);
                    } catch (error) {
                      logger.logErrorMessage(`[Serverapp] - Ошибка отправки полученного сообщения от NodeRED  клиенту WSSDash: ${error}`);
                    }
                break;

              default:
                break;
            }

          }
        } catch (error) {
          console.error('[Serverapp] - Error  -- checkInputMessage -', error);
        }
  });

  ws.on('close', () => {
    logger.logInfoMessage(`[Serverapp] - WSSNodeRED - WebSocket connection closed`);
  });

  ws.on('error', (error) => {
    logger.logErrorMessage(`[Serverapp] - WSSNodeRED - WebSocket error: ${error.message}`);
  });
  });
}
// Работаем с Dashboard

WSSDash.on('connection', (ws) => {
  logger.logInfoMessage(`[Serverapp] - WSSDash.on - Новое подключение Dashboard (VUE)`);
  const connectionId = wsManager.registerConnection(ws, 'dashboard', null);
  auth.trackConnection(connectionId); // отсчёт AUTH_TIMEOUT_MS до входа

  logger.logDevMessage(`[Serverapp] - WSSDash.on - VUE соединение зарегистрировано: ${connectionId}`);

  const allClients = wsManager.getAllActiveConnections('VUE_connections');
  logger.logDevMessage(`[Serverapp] - WSSDash.on - Все соединения:`, allClients);

  // Приветствие получает только новое соединение и ровно один раз.
  // Рассылка по dID (всем соединениям пользователя) — это broadcast(), а не этот ответ.
  wsManager.sendToConnection('VUE_connections', connectionId, 'info', 'serverConnected', 'server', {
    message: 'Проверка связи',
  });

  
  ws.on('message', (message) => {
  logger.logDevMessage(`[Serverapp] - WSSDash.on - Пришло сообщение: ${logger.redactSecrets(message)}`);
  try {
    const dashData = checkMessage(message);
    if (dashData.status !== 'ok') return;

    const type    = dashData.data?.type;
    const request = dashData.data?.request;

    // 1) Разрешён ли вообще такой type для Dashboard
    if (!cfg.DASH_ALLOWED_TYPES.includes(type)) {
      logger.logDevMessage(`[Serverapp] - WSSDash - type ${type} запрещён`);
      return;
    }

    // 2) Auth-middleware: сессия + уровень доступа
    const access = auth.checkMessageAccess(connectionId, type, request, dashData.data?.name);
    if (!access.ok) {
      logger.logDevMessage(
        `[Serverapp] - WSSDash - доступ запрещён: ${access.code} (${type}/${request})`
      );
      wsManager.sendToConnection(
        'VUE_connections', connectionId,
        'error', 'accessError', dashData.data.name || 'unknown',
        { code: access.code, message: access.message, type, request }
      );
      return;
    }

    // 3) Роутинг по типу
    switch (type) {
      case 'auth':
        handleAuth(connectionId, dashData.data);
        break;

      case 'get':
        handleGet(connectionId, dashData.data);
        break;

      case 'post': {
        // Единый механизм с Telegram-ботом (services/commandGateway.js): команду тега Modbus
        // выполняет мост (запись в файл и рассылка — после подтверждения устройства), остальное —
        // handlePost и пересылка другим клиентам того же dID.
        commandGateway.execute({ dID: dashData.data.name, message: dashData.data, clientId: connectionId })
          .catch((error) => logger.logErrorMessage(`[Serverapp] - WSSDash - post ${request}: ${error.message}`));
        break;
      }

      default:
        break;
    }
  } catch (error) {
    logger.logErrorMessage(`[Serverapp] - WSSDash - ${error.message}`);
  }
});
  ws.on('error', (error) => {
    logger.logErrorMessage(`[Serverapp] - WSSDash - WebSocket error: ${error.message}`);
  });

  ws.on('close', () => {
    auth.forgetConnection(connectionId);
    videoHub.unsubscribe(connectionId);
    logger.logInfoMessage(`[Serverapp] - WSSDash - WebSocket connection closed`);
  });
});


function broadcast(excludeClientId, dID, data, targets = null) {
  if (!targets) {
    targets = NODERED_ENABLED
      ? ['VUE_connections', 'nRED_connections']
      : ['VUE_connections'];
  }
  logger.logDevMessage('[Serverapp] - broadcast - excludeClientId =', excludeClientId, 'dID =', dID, 'targets =', targets, 'data =', data);
  
  // Добавляем временную метку
  data.time = new Date().toString();
  
  try {
    let totalSent = 0;
    
    targets.forEach(targetType => {
      // Получаем все активные соединения указанного типа с нужным dID
      const userConnections = wsManager.getUserConnections(targetType, dID);
      
      if (userConnections.length === 0) {
        logger.logDevMessage(`[Serverapp] - broadcast - Нет активных соединений типа ${targetType} с dID: ${dID}`);
        return;
      }
      
      let typeSent = 0;
     
      // Отправляем сообщение каждому соединению с нужным dID, исключая отправителя
      userConnections.forEach(({ clientId, connection }) => {
        logger.logDevMessage(`[Serverapp] - broadcast - Начинаем рассылку`);
        if (clientId === excludeClientId) {
          logger.logDevMessage(`[Serverapp] - broadcast - Пропускаем отправителя: ${clientId}`);
          return;
        }
        
        // Проверяем, что соединение активно
        if (connection.ws && connection.ws.readyState === WebSocket.OPEN) {
          try {
            // Отправляем исходное сообщение в неизменном виде
            const messageString = JSON.stringify(data);
            connection.ws.send(messageString);
            typeSent++;
            totalSent++;
            logger.logDevMessage(`[Serverapp] - broadcast - Сообщение отправлено клиенту: ${clientId} (${targetType})`);
          } catch (error) {
            logger.logErrorMessage(`[Serverapp] - broadcast - Ошибка отправки клиенту ${clientId}:`, error);
          }
        }
      });
     logger.logDevMessage(`[Serverapp] - broadcast - Отправлено ${typeSent}/${userConnections.length} сообщений для ${targetType} с dID: ${dID}`);
    });
    
    if (totalSent === 0) {
      logger.logDevMessage(`[Serverapp] - broadcast - Нет активных клиентов для рассылки (dID: ${dID}, исключен: ${excludeClientId})`);
    } else {
      logger.logDevMessage(`[Serverapp] - broadcast - Всего отправлено ${totalSent} сообщений для dID: ${dID}`);
    }
    
  } catch (error) {
    logger.logErrorMessage(`[Serverapp] - broadcast - Ошибка рассылки: ${error.message}`);
  }
};


function stringToJSON(message) {
  const data = message.toString('utf8');
    return JSON.parse(data);
};


function checkMessage(message) {
  const data = stringToJSON(message);
  logger.logDevMessage(`[Serverapp] - checkMessage получило сообщение: ${logger.redactSecrets(message)}`);

  // 1. Грубая проверка типа
  const { error } = validType(data);
  if (error) {
    logger.logErrorMessage(`[Serverapp] - checkMessage - Некорректный type ${logger.redactSecrets(message)} Ошибка: ${error.message}`);
    return error;
  }

  // 2. Для post-сообщений — дополнительная проверка структуры payload
  if (data.type === 'post') {
    const postCheck = validPost(data);
    if (postCheck.error) {
      logger.logErrorMessage(`[Serverapp] - checkMessage - Некорректный post. ${logger.redactSecrets(message)} Ошибка: ${postCheck.error.message}`);
      return postCheck.error;
    }
  }

  // 3. Для оповещений — проверка и приведение к каноническому виду
  if (data.type === 'message') {
    const msgCheck = validMessage(data);
    if (msgCheck.error) {
      logger.logErrorMessage(`[Serverapp] - checkMessage - Некорректный message. Ошибка: ${msgCheck.error.message}`);
      return msgCheck.error;
    }
    return { status: 'ok', data: msgCheck.value };
  }

  return { status: 'ok', data: data };
}

// Работа с GPIO
const deviceName = process.env.DEVICE_NAME;
const manageDoor = String(process.env.MANAGE_DOOR ?? 'false').toLowerCase() === 'true';
logger.logDevMessage(`[Serverapp] - deviceName: ${deviceName} MANAGE_DOOR: ${manageDoor}`);

const GpioManager = require('./gpio.js');

// Создаем экземпляр GpioManager только если MANAGE_DOOR === true
let gpioManager;
if (manageDoor) {
  gpioManager = new GpioManager(deviceName, './gpioConf.json');

  if (gpioManager.deviceConfig) {
    // Освобождаем GPIO перед началом работы
    gpioManager.cleanupGpio();

    // Настраиваем выходные и входные пины
    gpioManager.setupOutputPins();
    gpioManager.setupInputPins();

    // Безопасное состояние при старте: все выходы (открыть/закрыть замок) неактивны.
    // Команды на замок при запуске не подаются — только по явному запросу.
    gpioManager.deviceConfig.outputPins.forEach((pin) => gpioManager.writePin(pin, 0));

    // Отслеживание состояния входных пинов
    const sensorDoorPinGpio = gpioManager.deviceConfig.inputPins[0];
    gpioManager.watchPin(sensorDoorPinGpio);

    const sensorLockPinGpio = gpioManager.deviceConfig.inputPins[1];
    gpioManager.watchPin(sensorLockPinGpio);
  }
}

// Завершение работы с GPIO
