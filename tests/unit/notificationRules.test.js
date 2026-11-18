// tests/unit/notificationRules.test.js
// Правила уведомлений: значения, условия, окно контроля по московскому времени, тексты.
'use strict';

const r = require('../../services/notificationRules');

// Момент по Москве (UTC+3): msk('2026-06-15T10:30') → мс UTC
const msk = (s) => Date.parse(`${s}:00+03:00`);

describe('normalizeValue', () => {
  test.each([
    [21.5, 21.5], ['21.5', 21.5], [true, true], ['ON', true], ['OFF', false], [0, 0],
    [null, null], [undefined, null], ['', null], ['abc', null], [NaN, null],
  ])('%p → %p', (raw, expected) => expect(r.normalizeValue(raw)).toBe(expected));
});

describe('checkCondition', () => {
  test.each([
    ['gt', 25, 26, true], ['gt', 25, 25, false],
    ['lt', 10, 9.9, true], ['lt', 10, 10, false],
    ['gte', 25, 25, true], ['lte', 25, 25.0000000001, true],
    ['eq', 1, '1', true], ['ne', 1, 2, true], ['ne', 1, 1, false],
  ])('%s %p при значении %p → %p', (op, value, actual, expected) => {
    expect(r.checkCondition({ op, value }, actual)).toBe(expected);
  });

  test('логические значения: = ON, ≠ OFF', () => {
    expect(r.checkCondition({ op: 'eq', value: true }, 'ON')).toBe(true);
    expect(r.checkCondition({ op: 'eq', value: true }, 'OFF')).toBe(false);
    expect(r.checkCondition({ op: 'ne', value: false }, true)).toBe(true);
  });

  test('нет значения или неизвестное условие — не выполнено', () => {
    expect(r.checkCondition({ op: 'gt', value: 1 }, undefined)).toBe(false);
    expect(r.checkCondition({ op: 'xx', value: 1 }, 5)).toBe(false);
    expect(r.checkCondition(null, 5)).toBe(false);
  });
});

describe('окно контроля (московское время)', () => {
  test('mskParts: дата, число, день недели (1 — пн), минуты', () => {
    // 15.06.2026 — понедельник; 23:30 UTC 14.06 = 02:30 МСК 15.06
    expect(r.mskParts(Date.parse('2026-06-14T23:30:00Z'))).toEqual({ ymd: '2026-06-15', monthDay: 15, weekDay: 1, minutes: 150 });
  });

  test('интервалы: пусто — сутки; границы включительно; через полночь', () => {
    const day = [{ from: '08:00', to: '20:00' }];
    const night = [{ from: '22:00', to: '06:00' }];
    expect(r.inIntervals([], 0)).toBe(true);
    expect(r.inIntervals(day, 8 * 60)).toBe(true);
    expect(r.inIntervals(day, 20 * 60)).toBe(true);
    expect(r.inIntervals(day, 20 * 60 + 1)).toBe(false);
    expect(r.inIntervals(night, 23 * 60)).toBe(true);
    expect(r.inIntervals(night, 3 * 60)).toBe(true);
    expect(r.inIntervals(night, 12 * 60)).toBe(false);
    expect(r.inIntervals([...day, ...night], 23 * 60)).toBe(true); // несколько — любой
  });

  test('периоды: даты, числа месяца, дни недели; несколько форматов — любой', () => {
    const p = r.mskParts(msk('2026-06-15T10:00')); // пн, 15 число
    expect(r.inPeriods([], p)).toBe(true);
    expect(r.inPeriods([{ type: 'dates', from: '2026-06-01', to: '2026-06-15' }], p)).toBe(true);
    expect(r.inPeriods([{ type: 'dates', from: '2026-06-16', to: '2026-08-31' }], p)).toBe(false);
    expect(r.inPeriods([{ type: 'monthDays', days: [1, 15] }], p)).toBe(true);
    expect(r.inPeriods([{ type: 'weekDays', days: [6, 7] }], p)).toBe(false);
    expect(r.inPeriods([{ type: 'weekDays', days: [6, 7] }, { type: 'monthDays', days: [15] }], p)).toBe(true);
  });

  test('isMonitored: нужны и интервал, и период', () => {
    const item = { intervals: [{ from: '08:00', to: '20:00' }], periods: [{ type: 'weekDays', days: [1] }] };
    expect(r.isMonitored(item, msk('2026-06-15T10:00'))).toBe(true);   // пн, днём
    expect(r.isMonitored(item, msk('2026-06-15T21:00'))).toBe(false);  // пн, вечером
    expect(r.isMonitored(item, msk('2026-06-16T10:00'))).toBe(false);  // вт
    expect(r.isMonitored({}, msk('2026-06-16T03:00'))).toBe(true);     // без ограничений
  });
});

describe('тексты', () => {
  const item = { room: 'room01', roomTitle: 'Гостиная', title: 'Температура', unit: '°C', condition: { op: 'gt', value: 25 } };

  test('событие ON: где, значение, условие', () => {
    expect(r.describe(item, { status: 'ON', value: 26.456 })).toBe('Гостиная · Температура: 26.46 °C (условие > 25 °C)');
  });

  test('сброс: причина и текущее значение', () => {
    expect(r.describe(item, { status: 'OFF', value: 24, reason: 'condition' }))
      .toBe('Гостиная · Температура: условие больше не выполняется, сейчас 24 °C');
    expect(r.describe(item, { status: 'OFF', reason: 'window' })).toContain('вне интервала или периода контроля');
  });

  test('логическое значение — ON/OFF', () => {
    expect(r.formatValue(true)).toBe('ON');
    expect(r.conditionText({ op: 'eq', value: false })).toBe('= OFF');
  });
});
