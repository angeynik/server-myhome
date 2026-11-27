// services/scenarioStore.js
// Сценарии автоматизации на диске: <DATA_DIR>/<dID>_scenarios.json
//   { settings: { tzOffsetMin, manualOverrideSec, maxCommandsPerMin },
//     scenarios: { "<id>": сценарий } }
//
// Сервер сценарии хранит и проверяет, выполняет их Node-RED (движок сценариев, репозиторий nRed):
// он получает файл целиком (post/scenarios) и работает по своей копии и без сервера.
// Формат сценария и логика вычисления — docs/scenarios.md. Проверка здесь совпадает с проверкой
// движка, кроме наличия точек: их знает только devices.json в Node-RED.
'use strict';

const Joi = require('joi');
const { readFileIfExists, writeFileSafely, resolveConfigPath } = require('./configStore');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_RE = /^[^\s|]{1,64}$/;                    // room, item — как в devices.json
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^(\d{4}-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/; // ГГГГ-ММ-ДД или ММ-ДД (каждый год)
const REQUESTS = ['sensors', 'system', 'setpoints'];
const OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'between', 'outside', 'stale'];
const KINDS = ['all', 'any', 'not', 'time', 'days', 'dates', 'point'];
const SEVERITIES = ['info', 'ok', 'warning', 'alarm'];
const LIMITS = { scenarios: 100, depth: 6, nodes: 50, actions: 20, items: 20, sec: 7 * 86400 };
const RESERVED = Object.getOwnPropertyNames(Object.prototype); // id не должен совпадать со свойством объекта

function storeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ── Схема ───────────────────────────────────────────────────────────────
const sec = Joi.number().min(0).max(LIMITS.sec);
const literal = Joi.alternatives(Joi.number(), Joi.boolean(), Joi.string().max(64));
const refSchema = Joi.object({
  room: Joi.string().pattern(NAME_RE).required(),
  item: Joi.string().pattern(NAME_RE).required(),
  request: Joi.string().valid(...REQUESTS),
});
const refOffset = refSchema.keys({ offset: Joi.number() });

// Узел условия — ровно один вид: группа (all, any, not) или лист (time, days, dates, point)
const condSchema = Joi.object({
  all: Joi.array().items(Joi.link('#cond')).min(1).max(LIMITS.items),
  any: Joi.array().items(Joi.link('#cond')).min(1).max(LIMITS.items),
  not: Joi.link('#cond'),
  time: Joi.object({ from: Joi.string().pattern(TIME_RE).required(), to: Joi.string().pattern(TIME_RE).required() }),
  days: Joi.array().items(Joi.number().integer().min(1).max(7)).min(1).max(7).unique(),
  dates: Joi.object({ from: Joi.string().pattern(DATE_RE).required(), to: Joi.string().pattern(DATE_RE).required() }),
  point: refSchema,
  op: Joi.string().valid(...OPS),
  value: literal,
  valueFrom: refOffset,
  value2: Joi.number(),
  hysteresis: Joi.number().min(0),
  sec: Joi.number().greater(0).max(LIMITS.sec),
  forSec: sec,
}).xor(...KINDS).id('cond');

const actionSchema = Joi.object({
  set: refSchema,
  value: literal,
  valueFrom: refOffset,
  notify: Joi.string().trim().min(1).max(1000),
  severity: Joi.string().valid(...SEVERITIES),
  level: Joi.number().integer().min(1).max(3),
  delaySec: sec,
}).xor('set', 'notify');

const scenarioSchema = Joi.object({
  id: Joi.string().pattern(ID_RE).invalid(...RESERVED).required(),
  title: Joi.string().trim().min(1).max(100).required(),
  description: Joi.string().trim().max(500).allow('').default(''),
  enabled: Joi.boolean().default(true),
  mode: Joi.string().valid('active', 'test').default('active'),
  priority: Joi.number().integer().min(0).max(100).default(50),
  when: condSchema.required(),
  then: Joi.array().items(actionSchema).max(LIMITS.actions).default([]),
  else: Joi.array().items(actionSchema).max(LIMITS.actions).default([]),
  options: Joi.object({
    onUnknown: Joi.string().valid('keep', 'else').default('keep'),
    onStart: Joi.string().valid('apply', 'skip').default('apply'),
    minOnSec: sec.default(0),
    minOffSec: sec.default(0),
    repeatSec: Joi.alternatives(Joi.number().valid(0), Joi.number().min(30).max(LIMITS.sec)).default(0),
    manualOverrideSec: sec,
  }).default(), // без аргумента Joi собирает объект из значений по умолчанию полей
}).prefs({ stripUnknown: true });

const settingsSchema = Joi.object({
  tzOffsetMin: Joi.number().integer().min(-840).max(840).default(180),
  manualOverrideSec: sec.default(3600),
  maxCommandsPerMin: Joi.number().integer().min(1).max(60).default(6),
}).prefs({ stripUnknown: true });

// ── Смысловые проверки, которых нет в схеме ───────────────────────────
function checkCondition(c, path, depth, counter, errs) {
  counter.n++;
  if (depth > LIMITS.depth) return errs.push(`условие ${path}: вложенность больше ${LIMITS.depth}`);
  const where = `условие ${path}`;
  if (c.all || c.any) return (c.all || c.any).forEach((x, i) => checkCondition(x, `${path}.${i + 1}`, depth + 1, counter, errs));
  if (c.not) return checkCondition(c.not, `${path}.1`, depth + 1, counter, errs);
  const extra = ['op', 'value', 'valueFrom', 'value2', 'hysteresis', 'sec'].filter((k) => c[k] !== undefined);
  if (!c.point) {
    if (extra.length) errs.push(`${where}: ${extra.join(', ')} — только для point`);
    if (c.time && c.time.from === c.time.to) errs.push(`${where}: time — from и to совпадают`);
    if (c.dates) {
      const full = (s) => /^\d{4}-/.test(s);
      if (full(c.dates.from) !== full(c.dates.to)) errs.push(`${where}: dates — from и to в одном формате`);
      else if (full(c.dates.from) && c.dates.from > c.dates.to) errs.push(`${where}: dates — начало позже окончания`);
    }
    return null;
  }
  if (!c.op) return errs.push(`${where}: нужен op`);
  if (c.op === 'stale') {
    if (c.sec === undefined) errs.push(`${where}: stale — нужен sec`);
    if (['value', 'valueFrom', 'value2', 'hysteresis'].some((k) => c[k] !== undefined)) errs.push(`${where}: stale — только sec`);
    return null;
  }
  if (c.sec !== undefined) errs.push(`${where}: sec — только для stale`);
  if ((c.value === undefined) === (c.valueFrom === undefined)) errs.push(`${where}: нужен value или valueFrom (одно из двух)`);
  if (c.op === 'between' || c.op === 'outside') {
    if (typeof c.value !== 'number' || typeof c.value2 !== 'number' || c.value > c.value2) errs.push(`${where}: ${c.op} — числа value ≤ value2`);
  } else if (c.value2 !== undefined) {
    errs.push(`${where}: value2 — только для between, outside`);
  }
  if (c.hysteresis !== undefined && !['gt', 'gte', 'lt', 'lte'].includes(c.op)) errs.push(`${where}: hysteresis — только для gt, gte, lt, lte`);
  return null;
}

function checkActions(list, name, errs) {
  list.forEach((a, i) => {
    const where = `${name}[${i + 1}]`;
    if (a.set) {
      if ((a.value === undefined) === (a.valueFrom === undefined)) errs.push(`${where}: нужен value или valueFrom (одно из двух)`);
      if (a.severity || a.level) errs.push(`${where}: severity, level — только для notify`);
    } else if (a.value !== undefined || a.valueFrom !== undefined) {
      errs.push(`${where}: value — только для set`);
    }
  });
}

function validateScenario(raw) {
  const { error, value } = scenarioSchema.validate(raw, { abortEarly: true });
  if (error) throw storeError('BAD_SCENARIO', `Неверный сценарий: ${error.message}`);
  const errs = [];
  const counter = { n: 0 };
  checkCondition(value.when, '1', 1, counter, errs);
  if (counter.n > LIMITS.nodes) errs.push(`условий больше ${LIMITS.nodes}`);
  checkActions(value.then, 'then', errs);
  checkActions(value.else, 'else', errs);
  if (!value.then.length && !value.else.length) errs.push('нет действий (then / else)');
  if (errs.length) throw storeError('BAD_SCENARIO', `Неверный сценарий: ${errs.join('; ')}`);
  return value;
}

function validateSettings(raw) {
  const { error, value } = settingsSchema.validate(raw || {}, { abortEarly: true });
  if (error) throw storeError('BAD_SCENARIO', `Неверные настройки сценариев: ${error.message}`);
  return value;
}

// ── Хранилище ───────────────────────────────────────────────────────────
function createScenarioStore({ now = Date.now } = {}) {
  const chains = new Map(); // dID -> Promise: правки одного dID строго по очереди (чтение → запись)

  function queue(dID, fn) {
    const prev = chains.get(dID) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    chains.set(dID, run);
    run.finally(() => { if (chains.get(dID) === run) chains.delete(dID); }).catch(() => {});
    return run;
  }

  // null — файла нет (сценариев ещё не создавали): Node-RED тогда работает по своему файлу
  async function read(dID) {
    const file = await readFileIfExists(dID, 'scenarios');
    return file ? file.data : null;
  }

  async function modify(dID, change) {
    return queue(dID, async () => {
      const cur = (await read(dID)) || {};
      const data = {
        settings: validateSettings(cur.settings),
        scenarios: { ...(cur.scenarios || {}) },
      };
      const result = change(data);
      await writeFileSafely(resolveConfigPath(dID, 'scenarios'), JSON.stringify(data, null, 2));
      return { ...result, data };
    });
  }

  const stamp = () => new Date(now()).toISOString();

  // create / edit: запись по id
  async function save(dID, raw, actor, { mustExist = false, mustBeNew = false } = {}) {
    const sc = validateScenario(raw);
    return modify(dID, (data) => {
      const prev = Object.prototype.hasOwnProperty.call(data.scenarios, sc.id) ? data.scenarios[sc.id] : null;
      if (mustExist && !prev) throw storeError('NOT_FOUND', 'Сценарий не найден');
      if (mustBeNew && prev) throw storeError('EXISTS', `Сценарий ${sc.id} уже есть`);
      if (!prev && Object.keys(data.scenarios).length >= LIMITS.scenarios) {
        throw storeError('LIMIT', `Не больше ${LIMITS.scenarios} сценариев`);
      }
      data.scenarios[sc.id] = {
        ...sc,
        createdAt: prev?.createdAt || stamp(),
        updatedAt: stamp(),
        updatedBy: actor?.username || null,
      };
      return { id: sc.id, created: !prev };
    });
  }

  function remove(dID, id) {
    return modify(dID, (data) => {
      if (!Object.prototype.hasOwnProperty.call(data.scenarios, id)) throw storeError('NOT_FOUND', 'Сценарий не найден');
      delete data.scenarios[id];
      return { id };
    });
  }

  function setEnabled(dID, id, enabled, actor) {
    if (typeof enabled !== 'boolean') return Promise.reject(storeError('BAD_SCENARIO', 'enabled — true или false'));
    return modify(dID, (data) => {
      const sc = Object.prototype.hasOwnProperty.call(data.scenarios, id) ? data.scenarios[id] : null;
      if (!sc) throw storeError('NOT_FOUND', 'Сценарий не найден');
      data.scenarios[id] = { ...sc, enabled, updatedAt: stamp(), updatedBy: actor?.username || null };
      return { id };
    });
  }

  async function saveSettings(dID, raw) {
    const settings = validateSettings(raw);
    return modify(dID, (data) => {
      data.settings = settings;
      return { id: null };
    });
  }

  return { read, save, remove, setEnabled, saveSettings };
}

module.exports = { createScenarioStore, validateScenario, validateSettings, LIMITS };
