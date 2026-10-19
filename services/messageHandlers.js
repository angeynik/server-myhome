// services/messageHandlers.js
'use strict';

const dotenv = require('dotenv');
dotenv.config({ path: './conf.env' });

const logger    = require('./logger.js');
const userStore = require('./userStore.js');
const auth      = require('./auth');
const cfg       = require('./authConfig');
const wsManager = require('../classes/wsManager');

const {
  writeFileSafely,
  readFileSafely,
  saveNamedConfig,
  namedConfigExists,
} = require('./configStore');

const { nodeRedClients } = require('./clientsStore');

// ── Утилиты ─────────────────────────────────────────────────────────────
function getClientIP(clientId) {
  try {
    const conn = wsManager.VUE_connections?.get?.(clientId);
    return conn?.meta?.remoteAddress?.split(':')[0] || 'unknown';
  } catch {
    return 'unknown';
  }
}

function getValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

// ── Вспомогательные функции конфигов ────────────────────────────────────
async function addConfigItem(dID, configName, room, param, item) {
  const { data, filePath } = await readFileSafely(dID, configName);
  if (!data[room])        data[room] = {};
  if (!data[room][param]) data[room][param] = [];
  data[room][param].push({ ...item });
  return { data, filePath };
}

async function deleteConfigItems(dID, configName, room, param, Ids) {
  const { data, filePath } = await readFileSafely(dID, configName);
  if (!data[room])        throw new Error(`Комната ${room} не найдена`);
  if (!data[room][param]) throw new Error(`Параметр ${param} не найден в комнате ${room}`);

  const current      = data[room][param];
  const filtered     = current.filter(item => !(item.id !== undefined && Ids.includes(item.id)));
  const removedCount = current.length - filtered.length;

  if (removedCount > 0) {
    data[room][param] = filtered;
    if (filtered.length === 0) {
      delete data[room][param];
      if (Object.keys(data[room]).length === 0) delete data[room];
    }
  }
  return { data, filePath, removedCount };
}

async function updateConfigItem(dID, configName, room, param, { id, value_name, value, updated, value_type }) {
  const { data, filePath } = await readFileSafely(dID, configName);
  if (!data[room]?.[param]) throw new Error(`Параметр ${param} отсутствует в комнате ${room}`);

  const index = data[room][param].findIndex(s => s.id === id);
  if (index === -1) throw new Error(`Элемент с ID ${id} не найден`);

  data[room][param][index][value_name] = value;
  data[room][param][index].updatedAt   = updated;
  if (value_type !== undefined) data[room][param][index].value_type = value_type;
  return { data, filePath };
}

function buildFileResponse(data, filePath, responseType, responseRequest) {
  return {
    fileUpdateNeeded: true,
    filePath,
    dataToWrite: JSON.stringify(data, null, 2),
    responseType,
    responseRequest,
    responsePayload: data,
  };
}

// ── NodeRED → сервер (без auth, доверенный канал) ───────────────────────
async function handlePostNodeRED(clientId, message) {
  const { name, request, payload = {} } = message;

  const room       = getValue(payload?.room);
  const item_name  = getValue(payload?.item_name);
  const item_value = getValue(payload?.item_value);
  const item_type  = getValue(payload?.item_type);
  const title      = getValue(payload?.title);
  const group      = getValue(payload?.group);

  if (!room || !item_name || item_value === undefined) {
    throw new Error(`Missing required fields: room=${room}, item_name=${item_name}, item_value=${item_value}`);
  }

  const { data, filePath } = await readFileSafely(name, 'config');

  if (!data[room]) {
    data[room] = {
      id: Object.keys(data).filter(k => k.startsWith('room')).length,
      title: title || `Комната-${room}`,
      group: group || '',
    };
  }
  if (!data[room][request]) {
    data[room][request] = {};
    logger.logInfoMessage(`[messageHandlers] - handlePostNodeRED - новый объект ${request} в ${room}`);
  }
  data[room][request][item_name] = {
    value: item_value,
    type: item_type,
    lastUpdate: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
  };

  await writeFileSafely(filePath, JSON.stringify(data, null, 2));
  logger.logDevMessage(`[messageHandlers] - handlePostNodeRED - сохранено ${filePath}`);
  return 'ok';
}

// ── Auth (login/resume/logout/refresh/changePassword) ───────────────────
const handleAuth = async (clientId, data) => {
  const request = data?.request;
  const payload = data?.payload || {};
  const name    = data?.name || payload.username || 'unknown';

  const sendErr = (req, code, message) =>
    wsManager.sendToConnection('VUE_connections', clientId, 'error', req, name, { code, message });

  const sendOk = (req, extra) =>
    wsManager.sendToConnection('VUE_connections', clientId, 'response', req, name, extra);

  try {
    switch (request) {
      case 'login': {
        const { username, password } = payload;
        const ip = getClientIP(clientId);
        const result = await auth.loginUser(clientId, username, password, ip);
        if (result.error) return sendErr('loginError', result.code || 'AUTH_ERROR', result.error);

        wsManager.updateConnection('VUE_connections', clientId, Date.now(), result.dID);
        sendOk('loginSuccess', {
          token: result.token,
          username: result.username,
          userlevel: result.userlevel,
          dID: result.dID,
          mustChangePassword: result.mustChangePassword,
        });
        break;
      }

      case 'resume': {
        const { token } = payload;
        const result = await auth.resumeSession(clientId, token);
        if (result.error) return sendErr('resumeError', result.code || 'RESUME_ERROR', result.error);

        wsManager.updateConnection('VUE_connections', clientId, Date.now(), result.dID);
        sendOk('loginSuccess', {
          token: result.token,
          username: result.username,
          userlevel: result.userlevel,
          dID: result.dID,
          mustChangePassword: result.mustChangePassword,
        });
        break;
      }

      case 'logout':
        auth.logout(clientId);
        sendOk('logoutSuccess', {});
        break;

      case 'refresh': {
        const result = await auth.refresh(clientId);
        if (result.error) return sendErr('refreshError', result.code || 'REFRESH_ERROR', result.error);
        sendOk('refreshSuccess', { token: result.token });
        break;
      }

      case 'changePassword': {
        const { oldPassword, newPassword } = payload;
        const result = await auth.changeOwnPassword(clientId, oldPassword, newPassword);
        if (result.error) return sendErr('changePasswordError', result.code || 'CHANGE_ERROR', result.error);
        sendOk('changePasswordSuccess', { token: result.token, message: result.message });
        break;
      }

      default:
        logger.logDevMessage(`[messageHandlers] - handleAuth - неизвестный request: ${request}`);
    }
  } catch (error) {
    logger.logErrorMessage(`[messageHandlers] - handleAuth - unhandled: ${error.message}`);
    sendErr('authError', 'UNHANDLED_ERROR', 'Внутренняя ошибка авторизации');
  }
};

// ── GET ─────────────────────────────────────────────────────────────────
const handleGet = async (clientId, data) => {
  const dID = data.name;

  const sendError = (request, message, extra = {}) =>
    wsManager.sendToConnection('VUE_connections', clientId, 'error', request, dID, { message, ...extra });

  const sendResponse = (request, payload) =>
    wsManager.sendToConnection('VUE_connections', clientId, 'response', request, dID, payload);

  try {
    switch (data?.request) {
      case 'config': {
        const configData = await readFileSafely(dID, 'config');
        sendResponse('config', configData.data);
        break;
      }
      case 'schedules': {
        const schedulesData = await readFileSafely(dID, 'schedules');
        sendResponse('schedules', schedulesData.data);
        break;
      }
      case 'notifications': {
        const notificationsData = await readFileSafely(dID, 'notifications');
        sendResponse('notifications', notificationsData.data);
        break;
      }
      case 'statistics': {
        const statisticsData = await readFileSafely(dID, 'statistics');
        sendResponse('statistics', statisticsData.data);
        break;
      }
      default:
        break;
    }
  } catch (error) {
    logger.logErrorMessage(`[messageHandlers] - handleGet(${data?.request}): ${error.message}`);
    sendError(`${data?.request}Error`, error.message, { code: error.code || 'config_read_error' });
  }
};

// ── POST ────────────────────────────────────────────────────────────────
const handlePost = async (clientId, data) => {
  logger.logDevMessage(`[messageHandlers] - handlePost - request: ${data.request}`);

  const dID    = data.name;
  const pay    = data.payload || {};
  const room   = pay.room;
  const key    = pay.key;
  const param  = pay.param;
  const value  = pay.value;
  const value_name = pay.value_name;
  const id     = pay.id;
  const value_type = pay.value_type;
  const updated = pay.updated;

  let fileUpdateNeeded = false;
  let filePath         = '';
  let dataToWrite      = null;
  let responseType     = '';
  let responseRequest  = '';
  let responsePayload  = null;

  const sendError = (request, message, extra = {}) =>
    wsManager.sendToConnection('VUE_connections', clientId, 'error', request, dID, { message, ...extra });

  const sendResponse = (request, payload) =>
    wsManager.sendToConnection('VUE_connections', clientId, 'response', request, dID, payload);

  switch (data?.request) {
    // ── Пользователи ────────────────────────────────────────────────────
    case 'createUser': {
      try {
        const { username, password, dataSource, permissionLevel } = pay;
        if (!username || !password || !dataSource || !permissionLevel) {
          throw new Error('Отсутствуют обязательные поля');
        }
        const res = await userStore.registerUser(username, password, permissionLevel, dataSource, dataSource);
        sendResponse('createUserSuccess', { user: res.user, userCreated: res.userCreated });
      } catch (e) {
        logger.logErrorMessage(`[messageHandlers] - createUser: ${e.message}`);
        sendError('createUserError', e.message, { code: e.code || 'CREATE_USER_ERROR' });
      }
      break;
    }

    case 'linkUserToDataSource': {
      try {
        const { userId, dataSourceId } = pay;
        const users = await userStore.fetchUsers();
        if (!users.find(u => u.id === userId)) {
          throw new Error(`Пользователь с id=${userId} не найден`);
        }
        sendResponse('linkUserToDataSourceSuccess', {
          message: 'Связь уже установлена',
          userId,
          dataSourceId,
        });
      } catch (e) {
        sendError('linkUserToDataSourceError', e.message, { code: 'LINK_ERROR' });
      }
      break;
    }

    case 'wsConnect':
      break;

    // ── Setpoints / System ──────────────────────────────────────────────
    case 'setpoints': {
      try {
        const setpointKey = 's' + key;
        const { data: cfgData, filePath: cfgPath } = await readFileSafely(dID, 'config');
        if (cfgData[room]?.setpoints) {
          cfgData[room].setpoints[setpointKey] = {
            value,
            type: (typeof value === 'boolean') ? 'bool' : 'num',
            lastUpdate: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
          };
        }
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'config'));
      } catch (error) {
        sendError('setpointError', error.message);
      }
      break;
    }

    case 'system': {
      try {
        const { data: cfgData, filePath: cfgPath } = await readFileSafely(dID, 'config');
        if (cfgData[room]?.system) {
          cfgData[room].system[item_name] = {
            value,
            type: value_type ?? cfgData[room].system[item_name]?.type ?? 'xStatus',
            lastUpdate: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
          };
        }
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'config'));
      } catch (error) {
        sendError('systemWriteError', error.message);
      }
      break;
    }

    // ── Schedules ───────────────────────────────────────────────────────
    case 'addschedules': {
      try {
        const { data: cfgData, filePath: cfgPath } =
          await addConfigItem(dID, 'schedules', room, param, pay.configData);
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'schedules'));
      } catch (e) { sendError('addScheduleError', e.message); }
      break;
    }

    case 'delschedules': {
      try {
        const { Ids } = pay;
        if (!room || !param || !Array.isArray(Ids)) throw new Error('Отсутствуют room/param/Ids');
        const { data: cfgData, filePath: cfgPath, removedCount } =
          await deleteConfigItems(dID, 'schedules', room, param, Ids);
        if (removedCount === 0) {
          sendResponse('delScheduleNoMatch', { message: 'Не найдено', room, param, Ids, removedCount: 0 });
          break;
        }
        sendResponse('delScheduleSuccess', { message: `Удалено ${removedCount}`, room, param, Ids, removedCount });
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'schedules'));
      } catch (e) { sendError('delScheduleError', e.message, { code: 'DEL_SCHEDULE_ERROR' }); }
      break;
    }

    case 'updateschedules': {
      try {
        const { data: cfgData, filePath: cfgPath } =
          await updateConfigItem(dID, 'schedules', room, param, { id, value_name, value, updated, value_type });
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'schedules'));
      } catch (e) { sendError('updateScheduleError', e.message); }
      break;
    }

    // ── Notifications ───────────────────────────────────────────────────
    case 'addnotifications': {
      try {
        const { data: cfgData, filePath: cfgPath } =
          await addConfigItem(dID, 'notifications', room, param, pay.configData);
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'notifications'));
      } catch (e) { sendError('addNotificationsError', e.message); }
      break;
    }

    case 'delnotifications': {
      try {
        const { Ids } = pay;
        if (!room || !param || !Array.isArray(Ids)) throw new Error('Отсутствуют room/param/Ids');
        const { data: cfgData, filePath: cfgPath, removedCount } =
          await deleteConfigItems(dID, 'notifications', room, param, Ids);
        if (removedCount === 0) {
          sendResponse('delNotificationsNoMatch', { message: 'Не найдено', room, param, Ids, removedCount: 0 });
          break;
        }
        sendResponse('delNotificationsSuccess', { message: `Удалено ${removedCount}`, room, param, Ids, removedCount });
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'notifications'));
      } catch (e) { sendError('delNotificationsError', e.message, { code: 'DEL_NOTIFICATIONS_ERROR' }); }
      break;
    }

    case 'updatenotifications': {
      try {
        const { data: cfgData, filePath: cfgPath } =
          await updateConfigItem(dID, 'notifications', room, param, { id, value_name, value, updated });
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'notifications'));
      } catch (e) { sendError('updateNotificationsError', e.message); }
      break;
    }

    // ── Statistics ──────────────────────────────────────────────────────
    case 'addstatistics': {
      try {
        const { room: r, param: p, configData } = pay;
        if (!r || !p || !configData) throw new Error('Отсутствуют room/param/configData');
        const { data: cfgData, filePath: cfgPath } = await addConfigItem(dID, 'statistics', r, p, configData);
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'statistics'));
      } catch (e) { sendError('addStatisticsError', e.message); }
      break;
    }

    case 'delstatistics': {
      try {
        const { Ids } = pay;
        if (!room || !param || !Array.isArray(Ids)) throw new Error('Отсутствуют room/param/Ids');
        const { data: cfgData, filePath: cfgPath, removedCount } =
          await deleteConfigItems(dID, 'statistics', room, param, Ids);
        if (removedCount === 0) {
          sendResponse('delStatisticsNoMatch', { message: 'Не найдено', room, param, Ids, removedCount: 0 });
          break;
        }
        sendResponse('delStatisticsSuccess', { message: `Удалено ${removedCount}`, room, param, Ids, removedCount });
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'statistics'));
      } catch (e) { sendError('delStatisticsError', e.message, { code: 'DEL_STATISTIC_ERROR' }); }
      break;
    }

    case 'updatestatistics': {
      try {
        const { data: cfgData, filePath: cfgPath } =
          await updateConfigItem(dID, 'statistics', room, param, { id, value_name, value, updated });
        ({ fileUpdateNeeded, filePath, dataToWrite, responseType, responseRequest, responsePayload }
          = buildFileResponse(cfgData, cfgPath, 'response', 'statistics'));
      } catch (e) { sendError('updateStatisticsError', e.message); }
      break;
    }

    case 'sensors':
      break;

    default:
      break;
  }

  // ── Централизованная запись и ответ ────────────────────────────────────
  if (fileUpdateNeeded && filePath && dataToWrite) {
    try {
      await writeFileSafely(filePath, dataToWrite);
      logger.logDevMessage(`[messageHandlers] - файл ${filePath} обновлён`);
      if (responseType && responseRequest && responsePayload) {
        sendResponse(responseRequest, responsePayload);
      }
    } catch (err) {
      logger.logErrorMessage(`[messageHandlers] - запись ${filePath}: ${err.message}`);
      sendError('fileWriteError', `Не удалось сохранить: ${err.message}`);
    }
  }
};

// ── Response (от NodeRED) ───────────────────────────────────────────────
const handleResponse = async (clientId, data) => {
  switch (data?.request) {
    case 'config': {
      try {
        if (!data.payload) break;
        const dID        = data.name;
        const configName = Object.keys(data.payload)[0];
        const configData = data.payload[configName];
        if (!dID || !configName) throw new Error('handleResponse: нет dID или имени конфига');

        const { exists, filePath } = await namedConfigExists(dID, configName);
        if (exists) {
          wsManager.sendToConnection('nRED_connections', clientId, 'response', 'configExists', dID, {
            config: configName, exists: true, filePath,
          });
          break;
        }
        await saveNamedConfig(dID, configName, configData);
        wsManager.sendToConnection('nRED_connections', clientId, 'response', 'configSaved', dID, {
          config: configName, filePath,
        });
      } catch (error) {
        logger.logErrorMessage(`[messageHandlers] - handleResponse: ${error.message}`);
        wsManager.sendToConnection('nRED_connections', clientId, 'error', 'configError', data.name, {
          message: error.message, code: error.code || 'FILE_ERROR',
        });
      }
      break;
    }
    default: break;
  }
};

// ── Заглушки ────────────────────────────────────────────────────────────
const handleSet   = async (clientId, data) => {
  logger.logDevMessage('[messageHandlers] - handleSet (не реализовано)');
};
const handleError = async (clientId, data) => {
  logger.logDevMessage('[messageHandlers] - handleError');
};

module.exports = {
  handlePostNodeRED,
  handleAuth,
  handleGet,
  handlePost,
  handleResponse,
  handleSet,
  handleError,
};