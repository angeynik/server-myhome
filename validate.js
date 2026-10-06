// validate.js
// Валидация входящих WebSocket-сообщений.
//
// Две независимые проверки:
//   1. validType  — обязательный «грубый» фильтр по полю type.
//                   Пропускает все типы сообщений (post, get, auth, init,
//                   response, set, req, config, log).
//                   Вызывается в serverapp.js → checkMessage() для КАЖДОГО
//                   входящего сообщения — и от VUE, и от NodeRED.
//
//   2. validPost  — «тонкая» проверка структуры post-сообщений.
//                   Вызывается ТОЛЬКО если type === 'post' (см. пример
//                   использования в checkMessage).
//                   Проверяет, что есть name, request и payload с
//                   обязательными room + item_name.
//
// Раньше validPost не вызывался вообще, а его схема не соответствовала
// реальному формату сообщений (ожидала вложенные ключи room_00…room_09).
// Теперь схема приведена к фактической структуре:
//
//   {
//     "type": "post",
//     "request": "setpoints",
//     "name": "poddy_base",
//     "payload": {
//       "room": "room02",
//       "item_name": "Спальня",
//       "item_value": 20.5,
//       "item_type": "sTemp"
//     }
//   }
//
// Важно: item_name и request НЕ ограничены латиницей и не привязаны
// к фиксированному списку — в проекте используются русские имена
// («Спальня», «Гостиная») и разные request (setpoints, sensors, system,
// addschedules, createUser и т.п.). Жёсткие списки ломали бы валидацию
// при каждом добавлении нового типа.

'use strict';

const Joi = require('joi');

// ─────────────────────────────────────────────────────────────────────────
// 1. validType — грубая проверка поля type
// ─────────────────────────────────────────────────────────────────────────

// Допустимые значения поля type. Список охватывает все сообщения,
// которые реально ходят по WebSocket-каналам:
//   response — ответы серверу (в т.ч. от NodeRED)
//   config   — сообщения с конфигурацией
//   post     — запись/обновление значения
//   get      — запрос данных (конфиг, расписания, статистика и т.п.)
//   req      — запрос к серверу
//   set      — установка значения (резерв)
//   init     — инициализация (init_ws, init_dID)
//   auth     — авторизация
//   log      — логирование
const schemaType = Joi.object({
  type: Joi.string()
    .valid('response', 'config', 'post', 'get', 'req', 'set', 'init', 'auth', 'log')
    .required()
}).unknown(true); // остальные поля разрешены — их проверяет validPost (для post)

/**
 * Грубая валидация сообщения: проверяет только наличие корректного type.
 * Возвращает { value } при успехе или { error } при ошибке.
 *
 * @param {object} message — распарсенный JSON сообщения
 */
function validType(message) {
  const { error, value } = schemaType.validate(message);
  if (error) {
    console.log(`Ошибка валидации Type: ${value?.type} - ${error.message}`);
    return { error };
  }
  return { value };
}

// ─────────────────────────────────────────────────────────────────────────
// 2. validPost — детальная проверка структуры post-сообщений
// ─────────────────────────────────────────────────────────────────────────

// Схема payload для post-сообщения.
//
// Ключевые решения:
//   • item_name — просто строка 1..128 символов, БЕЗ pattern на латиницу.
//     Кириллица («Спальня», «Гостиная», «Детская 1») должна проходить.
//   • item_type — строка 1..32 символов без жёсткого pattern.
//     Типы расширяются со временем (dBool, dTemp, dActuator, xStatus,
//     sTemp…), привязываться к списку или регулярке неудобно.
//   • item_value — допускаем number, boolean или string.
//     Большинство значений числовые, но для универсальности оставляем
//     строку (например, при отладке или для текстовых полей).
//   • title, group, item_title — необязательные строки,
//     разрешаем пустые значения через .allow('').
const postPayloadSchema = Joi.object({
  room: Joi.string().min(1).max(64).required(),

  item_name: Joi.string().min(1).max(128).required(),

  item_value: Joi.alternatives()
    .try(Joi.number(), Joi.boolean(), Joi.string())
    .optional(),

  item_type: Joi.string().min(1).max(32).optional(),

  item_title: Joi.string().allow('').max(256).optional(),
  title:      Joi.string().allow('').max(256).optional(),
  group:      Joi.string().allow('').max(128).optional()
}).unknown(true); // на будущее: если появятся новые поля в payload — не отваливаться

// Схема самого post-сообщения.
//
// request — любая непустая строка. Список request'ов в проекте обширный
// и расширяется: setpoints, sensors, system, addschedules, delschedules,
// updateschedules, addnotifications, delnotifications, updatenotifications,
// addstatistics, delstatistics, updatestatistics, createUser,
// linkUserToDataSource, init_dID, wsConnect и т.д.
// Строгий список пришлось бы обновлять при каждом новом case в handlePost —
// это источник ошибок. Неизвестный request всё равно отсекается в
// handlePost через default: break (никаких side effects не будет).
const postSchema = Joi.object({
  type:    Joi.string().valid('post').required(),
  request: Joi.string().min(1).max(64).required(),
  name:    Joi.string().min(1).max(64).required(),
  payload: postPayloadSchema.required()
}).unknown(true); // name, time и прочие поля верхнего уровня разрешены

/**
 * Детальная валидация post-сообщения.
 * Возвращает:
 *   { status: 'ok', value }  — при успехе
 *   { error }                — при ошибке (структура совместима с validType)
 *
 * ВАЖНО: раньше функция возвращала undefined в случае успеха, из-за чего
 * вызывающий код не мог отличить «успех» от «ничего не вернулось».
 * Теперь возвращаем явный объект со status.
 *
 * @param {object} message — распарсенный JSON сообщения (type === 'post')
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
// 3. validConfig — пока заглушка
// ─────────────────────────────────────────────────────────────────────────

/**
 * Зарезервировано для валидации сообщений с типом 'config'.
 * Сейчас не используется — оставляем для совместимости с serverapp.js
 * (если где-то импортируется).
 */
function validConfig(message) {
  console.log('Сообщение для валидации:', message);
  return 'ok';
}

module.exports = { validType, validConfig, validPost };