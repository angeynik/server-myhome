// tests/unit/objectView.test.js
// Представление объекта: комнаты, названия и единицы, поиск, изменяемые элементы и лимиты.
'use strict';

const ov = require('../../services/objectView');

const CONFIG = {
  init: { limits: { Default: { low: 8, high: 36, step: 1 }, Temp: { low: 8, high: 36, step: 0.5 } } },
  room02: { group: 'Спальня', sensors: { dTemp02: { value: 19, type: 'num' } }, setpoints: { sTemp02: { value: 20 } } },
  room01: {
    title: 'Комната-room01', group: 'Гостиная',
    sensors: { dTemp01: { value: 22.456, type: 'num' }, dHum01: { value: 45 } },
    setpoints: { sTemp01: { value: 21, type: 'num' }, sHum01: { value: 40, limits: { low: 30, high: 60, step: 5 } } },
    system: { aPump01: { value: 'ON', type: 'bool' }, dMode01: { value: 2, type: 'num' } },
    _meta: { 'sensors|dHum01': { title: 'Влажность воздуха' } },
  },
  common: { system: { dSeason01: { value: 1 } } },
  newConfigID: 'x',
};

describe('objectView', () => {
  test('комнаты по порядку, «Общие настройки» последней; уставка рядом с датчиком', () => {
    const rooms = ov.buildRooms(CONFIG);
    expect(rooms.map((r) => r.title)).toEqual(['Гостиная', 'Спальня', 'Общие настройки']);
    const temp = rooms[0].items.find((i) => i.key === 'dTemp01');
    expect(temp).toMatchObject({ title: 'Температура', unit: '°C', icon: '🌡', setpoint: { key: 'sTemp01' } });
    expect(rooms[0].items.find((i) => i.key === 'dHum01').title).toBe('Влажность воздуха'); // _meta
  });

  test('значения: число с единицей и округлением, ON/OFF, нет данных', () => {
    expect(ov.formatValue({ value: 22.456 }, '°C')).toBe('22.46 °C');
    expect(ov.formatValue({ value: 'ON' })).toBe('ON');
    expect(ov.formatValue({ value: false })).toBe('OFF');
    expect(ov.formatValue({ value: null }, '°C')).toBe('—');
  });

  test('поиск комнаты и параметра: регистр, начало слова', () => {
    const rooms = ov.buildRooms(CONFIG);
    expect(ov.findRooms(rooms, 'спальня').map((r) => r.key)).toEqual(['room02']);
    expect(ov.findRooms(rooms, 'гост').map((r) => r.key)).toEqual(['room01']);
    expect(ov.findParamTitles(rooms, 'темп')).toEqual(['Температура']);
    expect(ov.findParamTitles(rooms, 'воздуха')).toEqual(['Влажность воздуха']);
  });

  test('изменяемые: уставки (лимиты свои или из init) и переключатели system; числовой system — нет', () => {
    const items = ov.settableItems(CONFIG, 'room01');
    expect(items.map((i) => [i.section, i.key, i.kind])).toEqual([
      ['setpoints', 'sTemp01', 'number'], ['setpoints', 'sHum01', 'number'], ['system', 'aPump01', 'bool'],
    ]);
    expect(items[0].limits).toEqual({ low: 8, high: 36, step: 0.5 });
    expect(items[1].limits).toEqual({ low: 30, high: 60, step: 5 });
  });

  test('findSettable: «температура» находит «Уставка температуры», «насос» — переключатель', () => {
    expect(ov.findSettable(CONFIG, 'room01', 'температура').map((i) => i.key)).toEqual(['sTemp01']);
    expect(ov.findSettable(CONFIG, 'room01', 'насос').map((i) => i.key)).toEqual(['aPump01']);
  });

  test('значение переключателя — в форме хранения', () => {
    expect(ov.boolInStoredForm({ value: 'OFF' }, true)).toBe('ON');
    expect(ov.boolInStoredForm({ value: 0 }, true)).toBe(1);
    expect(ov.boolInStoredForm({ value: false }, true)).toBe(true);
  });
});
