// services/notificationRules.js
// Правила уведомлений — чистые функции без ввода-вывода (проверяются тестами напрямую):
//   normalizeValue — значение параметра из config-файла → число | boolean | null
//   checkCondition — выполняется ли условие { op, value } для текущего значения
//   isMonitored    — попадает ли момент в интервалы (время суток) и периоды (календарь) контроля
//   describe       — текст события для окна уведомления и Telegram
//
// Время — московское (UTC+3, без перехода на летнее время), как во всей системе.
'use strict';

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

const OPS = {
  gt:  { sign: '>',  test: (a, b) => a > b },
  lt:  { sign: '<',  test: (a, b) => a < b },
  eq:  { sign: '=',  test: (a, b) => Math.abs(a - b) < 1e-9 },
  gte: { sign: '≥',  test: (a, b) => a > b || Math.abs(a - b) < 1e-9 },
  lte: { sign: '≤',  test: (a, b) => a < b || Math.abs(a - b) < 1e-9 },
  ne:  { sign: '≠',  test: (a, b) => Math.abs(a - b) >= 1e-9 },
};

const WEEKDAY_NAMES = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

// Значение в config-файле бывает числом, boolean, 'ON'/'OFF' или числовой строкой
function normalizeValue(raw) {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (raw === 'ON' || raw === 'on' || raw === 'true') return true;
  if (raw === 'OFF' || raw === 'off' || raw === 'false') return false;
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  return null;
}

// Нет значения (датчик ещё не присылал данных) — условие не выполнено
function checkCondition(condition, rawActual) {
  const op = OPS[condition?.op];
  const actual = normalizeValue(rawActual);
  const target = normalizeValue(condition?.value);
  if (!op || actual === null || target === null) return false;
  // Логические значения сравниваются как 1/0: «= ON», «≠ OFF», «> OFF» работают одинаково
  return op.test(Number(actual), Number(target));
}

// Части московского времени момента t (мс)
function mskParts(t) {
  const d = new Date(t + MSK_OFFSET_MS);
  const ymd = d.toISOString().slice(0, 10);
  return {
    ymd,                                        // 'YYYY-MM-DD'
    monthDay: d.getUTCDate(),                   // 1..31
    weekDay: ((d.getUTCDay() + 6) % 7) + 1,     // 1 — понедельник … 7 — воскресенье
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

// Интервалы времени суток: [{ from: 'HH:MM', to: 'HH:MM' }], границы включительно.
// from > to — через полночь (22:00–06:00). Пусто — круглые сутки.
function inIntervals(intervals, minutes) {
  if (!Array.isArray(intervals) || intervals.length === 0) return true;
  return intervals.some(({ from, to }) => {
    const f = toMinutes(from);
    const t = toMinutes(to);
    if (f === t) return true;
    return f < t ? minutes >= f && minutes <= t : minutes >= f || minutes <= t;
  });
}

// Периоды календаря, любой подходящий (разные форматы проверяются все):
//   { type: 'dates', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } — с … по, включительно
//   { type: 'monthDays', days: [1, 15] }                   — числа месяца
//   { type: 'weekDays', days: [1, 2, 3, 4, 5] }            — дни недели (1 — пн … 7 — вс)
// Пусто — круглый год.
function inPeriods(periods, parts) {
  if (!Array.isArray(periods) || periods.length === 0) return true;
  return periods.some((p) => {
    if (p.type === 'dates') return parts.ymd >= p.from && parts.ymd <= p.to;
    if (p.type === 'monthDays') return p.days.includes(parts.monthDay);
    if (p.type === 'weekDays') return p.days.includes(parts.weekDay);
    return false;
  });
}

function isMonitored(item, t) {
  const parts = mskParts(t);
  return inIntervals(item.intervals, parts.minutes) && inPeriods(item.periods, parts);
}

function formatValue(raw, unit = '') {
  const v = normalizeValue(raw);
  if (v === null) return '—';
  if (typeof v === 'boolean') return v ? 'ON' : 'OFF';
  return `${Math.round(v * 100) / 100}${unit ? ` ${unit}` : ''}`;
}

function conditionText(condition, unit = '') {
  const op = OPS[condition?.op];
  return op ? `${op.sign} ${formatValue(condition.value, unit)}` : '';
}

// Где и что: «Гостиная · Температура»
const placeOf = (item) => [item.roomTitle || item.group || item.room, item.title || item.item].filter(Boolean).join(' · ');

// Части текста события: place — где и что, detail — что произошло (ON) или почему снято (OFF)
function describeParts(item, { status, value, reason } = {}) {
  const place = placeOf(item);
  if (status === 'ON') {
    return { place, detail: `${formatValue(value, item.unit)} (условие ${conditionText(item.condition, item.unit)})` };
  }
  const why = {
    condition: 'условие больше не выполняется',
    window: 'вне интервала или периода контроля',
    removed: 'уведомление удалено',
  }[reason] || 'сброшено';
  return { place, detail: `${why}${value !== undefined ? `, сейчас ${formatValue(value, item.unit)}` : ''}` };
}

// Текст события одной строкой: «Гостиная · Температура: 26 °C (условие > 25 °C)»
function describe(item, opts = {}) {
  const { place, detail } = describeParts(item, opts);
  return `${place}: ${detail}`;
}

module.exports = {
  OPS,
  WEEKDAY_NAMES,
  normalizeValue,
  checkCondition,
  mskParts,
  inIntervals,
  inPeriods,
  isMonitored,
  formatValue,
  conditionText,
  describeParts,
  describe,
};
