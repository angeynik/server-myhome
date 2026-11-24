// services/objectView.js
// Представление конфигурации объекта (<dID>.json) для текстовых интерфейсов (Telegram-бот):
// комнаты с параметрами, названия и единицы параметров, поиск комнаты и параметра по названию,
// список изменяемых элементов (уставки и переключатели) с лимитами.
//
// Названия и единицы — те же, что в клиенте (vue-app/src/store/modules/sortParams.js:
// SENSOR_TITLES, UNIT_RULES). Меняете там — меняйте и здесь.
'use strict';

const TITLES = {
  dHum: 'Влажность',
  dTemp: 'Температура',
  dPress: 'Давление',
  dPower: 'Потребление',
  dMove: 'Движение',
  dFire: 'Возгорания',
  dLeak: 'Утечки',
  aLamp: 'Освещение',
  aFan: 'Вентиляция',
  aPump: 'Насос',
  aValve: 'Клапан',
  aRelay: 'Реле',
  dFrequency: 'Частота',
  dVoltage: 'Напряжение',
  dEnergy: 'Потребление',
  'dСurrent': 'Ток', // кириллическая «С» — как в ключах сервера
  aActuator: 'Актуатор',
  aSwitch: 'Переключатель',
  sSwitch: 'Переключатель',
  aController: 'Контроллер',
  dBat: 'Батарея',
  sTemp: 'Уставка температуры',
  sHum: 'Уставка влажности',
  sActuator: 'Уставка актуатор',
  dCurSetpoint: 'Уставка Термостата',
  dStatus: 'Статус',
  dMode: 'Режим',
  dFanSp: 'Скорость вентилятора',
  dConnect: 'Подключение',
  dErrStat: 'Ошибка',
  dErrCode: 'Код ошибки',
  dSeason: 'Сезон',
  sSeason: 'Сезон пользователя',
  dPidStatus: 'Статус ПИД',
};

// [подстрока ключа, единица]; порядок важен
const UNIT_RULES = [
  ['Temp', '°C'], ['CurSetpoint', '°C'], ['Hum', '%'], ['Press', 'hPa'], ['Power', 'W'],
  ['Сurrent', 'A'], ['Bat', '%'], ['Voltage', 'V'], ['Frequency', 'Hz'], ['Energy', 'kWh'],
];

const ICONS = [
  ['Temp', '🌡'], ['CurSetpoint', '🌡'], ['Hum', '💧'], ['Press', '🧭'], ['Move', '🚶'], ['Fire', '🔥'],
  ['Leak', '💦'], ['Lamp', '💡'], ['Fan', '🌀'], ['Pump', '⛲'], ['Valve', '🚰'], ['Power', '⚡'],
  ['Energy', '⚡'], ['Voltage', '⚡'], ['Сurrent', '⚡'], ['Bat', '🔋'], ['Mode', '⚙️'], ['Status', '⚙️'],
];

const ROOM_KEY_RE = /^room\d+$/;
const COMMON_KEY = 'common';
const COMMON_TITLE = 'Общие настройки';
const SECTIONS = ['sensors', 'system'];

const baseKey = (key) => String(key || '').replace(/\d+$/, '');        // dTemp01 → dTemp
const clearKey = (key) => String(key || '').slice(1).replace(/\d+$/, ''); // dTemp01 → Temp

function paramTitle(key, meta) {
  return meta?.title || TITLES[baseKey(key)] || key;
}
function paramUnit(key) {
  const rule = UNIT_RULES.find(([part]) => String(key).includes(part));
  return rule ? rule[1] : '';
}
function paramIcon(key) {
  const rule = ICONS.find(([part]) => String(key).includes(part));
  return rule ? rule[1] : '•';
}

// ON/OFF: boolean, 'ON'/'OFF' или тип bool/dBool
function isBoolEntry(entry) {
  const v = entry?.value;
  return typeof v === 'boolean' || v === 'ON' || v === 'OFF' || ['bool', 'dBool'].includes(entry?.type);
}

function boolOf(v) {
  if (v === true || v === 'ON' || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 'OFF' || v === 0 || v === '0' || v === 'false') return false;
  return null;
}

function formatValue(entry, unit) {
  const v = entry?.value;
  if (v === null || v === undefined || v === '') return '—';
  if (isBoolEntry(entry)) return boolOf(v) ? 'ON' : 'OFF';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return `${Math.round(n * 100) / 100}${unit ? ` ${unit}` : ''}`;
}

// Комната: { key, title, items: [{ section, key, title, unit, icon, entry, setpoint? }] }.
// Порядок: room01, room02, … затем «Общие настройки». Уставка показывается рядом с датчиком
// (dTemp01 ↔ sTemp01), как на плашке клиента.
function buildRooms(config) {
  const rooms = [];
  const keys = Object.keys(config || {})
    .filter((k) => ROOM_KEY_RE.test(k) || k === COMMON_KEY)
    .sort((a, b) => (a === COMMON_KEY) - (b === COMMON_KEY) || a.localeCompare(b, 'en', { numeric: true }));
  for (const key of keys) {
    const room = config[key];
    if (!room || typeof room !== 'object') continue;
    const items = [];
    for (const section of SECTIONS) {
      for (const [itemKey, entry] of Object.entries(room[section] || {})) {
        const spKey = section === 'sensors' ? `s${clearKey(itemKey)}${(itemKey.match(/\d+$/) || [''])[0]}` : null;
        const sp = spKey && room.setpoints?.[spKey];
        items.push({
          section,
          key: itemKey,
          title: paramTitle(itemKey, room._meta?.[`${section}|${itemKey}`]),
          unit: paramUnit(itemKey),
          icon: paramIcon(itemKey),
          entry,
          setpoint: sp && sp.value !== undefined && sp.value !== null ? { key: spKey, entry: sp } : null,
        });
      }
    }
    if (items.length) rooms.push({ key, title: key === COMMON_KEY ? COMMON_TITLE : room.group || room.title || key, items });
  }
  return rooms;
}

// Нормализация для поиска: регистр, ё, пробелы и дефисы не важны
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[\s_-]+/g, ' ').trim();

// Подходит ли запрос к названию: совпадение, начало названия или начало любого слова
function matches(query, title) {
  const q = norm(query);
  const t = norm(title);
  if (!q) return false;
  return t === q || t.startsWith(q) || t.split(' ').some((w) => w.startsWith(q));
}

function findRooms(rooms, query) {
  const exact = rooms.filter((r) => norm(r.title) === norm(query) || r.key === query);
  return exact.length ? exact : rooms.filter((r) => matches(query, r.title));
}

// Названия параметров, которые есть в комнатах (для кнопок /info)
function paramTitles(rooms) {
  return [...new Set(rooms.flatMap((r) => r.items.map((i) => i.title)))];
}

function findParamTitles(rooms, query) {
  const all = paramTitles(rooms);
  const exact = all.filter((t) => norm(t) === norm(query));
  return exact.length ? exact : all.filter((t) => matches(query, t));
}

// ── Изменяемые элементы (/set) ────────────────────────────────────────
// Уставки (setpoints) и переключатели «Состояния устройств» (system, ON/OFF).
function limitsFor(config, room, spKey, entry) {
  const own = entry?.limits;
  const all = config?.init?.limits || {};
  const l = own || all[clearKey(spKey)] || all.Default || {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return { low: num(l.low, -1e9), high: num(l.high, 1e9), step: num(l.step, 0.5) > 0 ? num(l.step, 0.5) : 0.5 };
}

function settableItems(config, roomKey) {
  const room = config?.[roomKey];
  if (!room) return [];
  const list = [];
  for (const [key, entry] of Object.entries(room.setpoints || {})) {
    const bool = isBoolEntry(entry);
    list.push({
      room: roomKey, section: 'setpoints', key, entry, kind: bool ? 'bool' : 'number',
      title: paramTitle(key, room._meta?.[`setpoints|${key}`]), unit: bool ? '' : paramUnit(key),
      limits: bool ? null : limitsFor(config, roomKey, key, entry),
    });
  }
  for (const [key, entry] of Object.entries(room.system || {})) {
    if (!isBoolEntry(entry)) continue;
    list.push({
      room: roomKey, section: 'system', key, entry, kind: 'bool',
      title: paramTitle(key, room._meta?.[`system|${key}`]), unit: '', limits: null,
    });
  }
  return list;
}

function findSettable(config, roomKey, query) {
  const items = settableItems(config, roomKey);
  const exact = items.filter((i) => norm(i.title) === norm(query) || i.key === query);
  if (exact.length) return exact;
  // «температура» находит «Уставка температуры»
  return items.filter((i) => matches(query, i.title) || matches(query, paramTitle(`d${clearKey(i.key)}`)));
}

// Значение для записи в той же форме, что хранится: 'ON'/'OFF', boolean или 1/0
function boolInStoredForm(entry, on) {
  const v = entry?.value;
  if (v === 'ON' || v === 'OFF') return on ? 'ON' : 'OFF';
  if (typeof v === 'number') return on ? 1 : 0;
  return on;
}

module.exports = {
  TITLES, COMMON_KEY, COMMON_TITLE,
  baseKey, clearKey, paramTitle, paramUnit, paramIcon,
  isBoolEntry, boolOf, formatValue, norm, matches,
  buildRooms, findRooms, paramTitles, findParamTitles,
  limitsFor, settableItems, findSettable, boolInStoredForm,
};
