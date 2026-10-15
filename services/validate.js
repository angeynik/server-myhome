// validate.js
// Валидация входящих WebSocket-сообщений.
//
// Две независимые проверки:
//   1. validType  — «грубый» фильтр по полю type.
//                   Вызывается в serverapp.js → checkMessage() для КАЖДОГО
//                   входящего сообщения.
//   2. validPost  — «каркасная» проверка post-сообщений.
//                   Гарантирует только общий контракт:
//                       type === 'post', request, name, payload (object).
//                   ВСЁ, что внутри payload, зависит от request'а
//                   (setpoints / system / createUser / addschedules / …)
//                   и валидируется уже в handlePost через switch-case.
//
// ВАЖНО: раньше схема жёстко требовала payload.room + payload.item_name —
// это ломало createUser, linkUserToDataSource, setpoints, addschedules,
// delnotifications, updatestatistics и т.д., где таких полей просто нет.
// Теперь поля уровня payload НЕ проверяются здесь.
'use strict';

const Joi = require('joi');

// ─────────────────────────────────────────────────────────────────────────
// 1. validType — грубая проверка поля type
// ─────────────────────────────────────────────────────────────────────────
const schemaType = Joi.object({
  type: Joi.string()
    .valid('response', 'config', 'post', 'get', 'req', 'set', 'init', 'auth', 'log')
    .required()
}).unknown(true);

function validType(message) {
  const { error, value } = schemaType.validate(message);
  if (error) {
    console.log(`Ошибка валидации Type: ${value?.type} - ${error.message}`);
    return { error };
  }
  return { value };
}

// ─────────────────────────────────────────────────────────────────────────
// 2. validPost — проверка общего каркаса post-сообщения
// ─────────────────────────────────────────────────────────────────────────
//
// Проверяем только то, что одинаково для ВСЕХ post-сообщений,
// независимо от request'а:
//
//   • type    === 'post'
//   • request — непустая строка (setpoints | system | createUser | …)
//   • name    — непустая строка (dID, напр. "angey_bmax")
//   • payload — присутствует и является объектом
//
// Конкретные поля внутри payload (room, item_name, key, value, Ids,
// configData, username, password, userId, dataSourceId, param, …)
// зависят от request'а и проверяются в messageHandlers.handlePost.
// Если попытаться описать их одной схемой — любая новая ветка switch
// будет ломать валидацию.
const postSchema = Joi.object({
  type:    Joi.string().valid('post').required(),
  request: Joi.string().min(1).max(64).required(),
  name:    Joi.string().min(1).max(64).required(),

  // payload должен быть именно объектом. Пустой объект тоже допустим:
  // некоторые request'ы (wsConnect, sensors) приходят без полезной нагрузки.
  payload: Joi.object().required()
}).unknown(true); // time и прочие служебные поля верхнего уровня разрешены

/**
 * Детальная валидация post-сообщения.
 * Возвращает:
 *   { status: 'ok', value }  — при успехе
 *   { error }                — при ошибке
 */
function validPost(message) {
  const { error, value } = postSchema.validate(message);

  if (error) {
    console.log('Ошибка валидации данных POST:', error.details);
    return { error };
  }

  return { status: 'ok', value };
}

// ─────────────────────────────────────────────────────────────────────────
// 3. validConfig — заглушка для совместимости
// ─────────────────────────────────────────────────────────────────────────
function validConfig(message) {
  console.log('Сообщение для валидации:', message);
  return 'ok';
}

module.exports = { validType, validConfig, validPost };