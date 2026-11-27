// tests/unit/scenarioStore.test.js
// Сценарии: схема и хранилище на настоящих файлах во временном DATA_DIR (tests/setup.js).
'use strict';

const fs = require('fs');
const path = require('path');
const { createScenarioStore, validateScenario, validateSettings } = require('../../services/scenarioStore');
const { fileCache } = require('../../services/configStore');

const DATA = process.env.DATA_DIR;
const P = (room, item) => ({ room, item });
const base = (extra = {}) => ({
  id: 'lamp_evening',
  title: 'Свет вечером',
  when: { all: [{ time: { from: '18:00', to: '23:00' } }, { not: { point: P('room01', 'aLamp01'), op: 'eq', value: true } }] },
  then: [{ set: P('room01', 'sLamp01'), value: true }],
  ...extra,
});

let t = Date.parse('2026-11-27T09:00:00Z');
const store = createScenarioStore({ now: () => t });

beforeEach(() => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fileCache.clear();
});

describe('validateScenario', () => {
  test('значения по умолчанию, лишние поля отброшены', () => {
    expect(validateScenario({ ...base(), evil: 1 })).toEqual({
      ...base(), description: '', enabled: true, mode: 'active', priority: 50, else: [],
      options: { onUnknown: 'keep', onStart: 'apply', minOnSec: 0, minOffSec: 0, repeatSec: 0 },
    });
  });

  test('сложное условие: И, ИЛИ, НЕ, гистерезис, valueFrom, stale, даты, задержка', () => {
    const sc = validateScenario(base({
      when: { any: [
        { all: [
          { point: P('room02', 'dTemp02'), op: 'lt', valueFrom: { ...P('room02', 'sTemp02'), offset: -0.5 }, hysteresis: 1, forSec: 60 },
          { not: { dates: { from: '05-15', to: '09-15' } } },
          { days: [1, 2, 3, 4, 5] },
        ] },
        { point: P('room02', 'dPower01'), op: 'between', value: 10, value2: 20 },
        { point: P('room01', 'dTemp01'), op: 'stale', sec: 600 },
        { dates: { from: '2026-12-30', to: '2027-01-08' } },
      ] },
      else: [{ set: P('room02', 'sTemp02'), valueFrom: P('room02', 'dTemp02'), delaySec: 30 }, { notify: 'Готово', severity: 'ok', level: 2 }],
      options: { repeatSec: 60, manualOverrideSec: 0 },
    }));
    expect(sc.options).toMatchObject({ repeatSec: 60, manualOverrideSec: 0 });
  });

  test.each([
    ['id с пробелом', { id: 'a b' }],
    ['id — свойство объекта', { id: 'constructor' }],
    ['без title', { title: '' }],
    ['два вида в одном узле', { when: { time: { from: '01:00', to: '02:00' }, days: [1] } }],
    ['пустой узел', { when: { foo: 1 } }],
    ['пустое all', { when: { all: [] } }],
    ['неизвестный op', { when: { point: P('r', 'i'), op: 'like', value: 1 } }],
    ['point без op', { when: { point: P('r', 'i'), value: 1 } }],
    ['value и valueFrom вместе', { when: { point: P('r', 'i'), op: 'gt', value: 1, valueFrom: P('r', 'j') } }],
    ['нет value', { when: { point: P('r', 'i'), op: 'gt' } }],
    ['between без value2', { when: { point: P('r', 'i'), op: 'between', value: 1 } }],
    ['between value > value2', { when: { point: P('r', 'i'), op: 'between', value: 5, value2: 1 } }],
    ['гистерезис для eq', { when: { point: P('r', 'i'), op: 'eq', value: 1, hysteresis: 1 } }],
    ['stale без sec', { when: { point: P('r', 'i'), op: 'stale' } }],
    ['sec не для stale', { when: { point: P('r', 'i'), op: 'gt', value: 1, sec: 5 } }],
    ['op у time', { when: { time: { from: '01:00', to: '02:00' }, op: 'gt' } }],
    ['time from = to', { when: { time: { from: '01:00', to: '01:00' } } }],
    ['время 24:00', { when: { time: { from: '24:00', to: '01:00' } } }],
    ['день 0', { when: { days: [0] } }],
    ['даты в разном формате', { when: { dates: { from: '2026-12-01', to: '01-10' } } }],
    ['даты наоборот', { when: { dates: { from: '2027-01-01', to: '2026-12-01' } } }],
    ['точка с | в имени', { when: { point: P('r|x', 'i'), op: 'gt', value: 1 } }],
    ['set и notify вместе', { then: [{ set: P('r', 'i'), value: 1, notify: 'x' }] }],
    ['set без value', { then: [{ set: P('r', 'i') }] }],
    ['value у notify', { then: [{ notify: 'x', value: 1 }] }],
    ['severity у set', { then: [{ set: P('r', 'i'), value: 1, severity: 'ok' }] }],
    ['нет действий', { then: [] }],
    ['repeatSec 10', { options: { repeatSec: 10 } }],
    ['priority 101', { priority: 101 }],
  ])('ошибка: %s', (_, extra) => {
    expect(() => validateScenario(base(extra))).toThrow(expect.objectContaining({ code: 'BAD_SCENARIO' }));
  });

  test('ограничения: вложенность и число условий', () => {
    let deep = { days: [1] };
    for (let i = 0; i < 6; i++) deep = { not: deep };
    expect(() => validateScenario(base({ when: deep }))).toThrow(/вложенность/);
    const many = Array.from({ length: 17 }, () => ({ any: [{ days: [1] }, { days: [2] }] }));
    expect(() => validateScenario(base({ when: { all: many } }))).toThrow(/условий больше 50/);
  });

  test('настройки: по умолчанию и пределы', () => {
    expect(validateSettings()).toEqual({ tzOffsetMin: 180, manualOverrideSec: 3600, maxCommandsPerMin: 6 });
    expect(() => validateSettings({ maxCommandsPerMin: 0 })).toThrow(expect.objectContaining({ code: 'BAD_SCENARIO' }));
  });
});

describe('createScenarioStore', () => {
  const actor = { username: 'admin' };

  test('нет файла — null; create пишет <dID>_scenarios.json с настройками и отметками', async () => {
    expect(await store.read('d1')).toBeNull();
    const r = await store.save('d1', base(), actor, { mustBeNew: true });
    expect(r).toMatchObject({ id: 'lamp_evening', created: true });
    const file = JSON.parse(fs.readFileSync(path.join(DATA, 'd1_scenarios.json'), 'utf8'));
    expect(file.settings).toEqual({ tzOffsetMin: 180, manualOverrideSec: 3600, maxCommandsPerMin: 6 });
    expect(file.scenarios.lamp_evening).toMatchObject({ title: 'Свет вечером', updatedBy: 'admin', createdAt: '2026-11-27T09:00:00.000Z' });
  });

  test('create существующего — EXISTS, edit несуществующего — NOT_FOUND; правка сохраняет createdAt', async () => {
    await store.save('d1', base(), actor, { mustBeNew: true });
    await expect(store.save('d1', base(), actor, { mustBeNew: true })).rejects.toMatchObject({ code: 'EXISTS' });
    await expect(store.save('d1', base({ id: 'x' }), actor, { mustExist: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    t += 60000;
    const r = await store.save('d1', base({ title: 'Новое' }), { username: 'u2' }, { mustExist: true });
    expect(r.data.scenarios.lamp_evening).toMatchObject({ title: 'Новое', createdAt: '2026-11-27T09:00:00.000Z', updatedBy: 'u2' });
  });

  test('enable, delete, settings', async () => {
    await store.save('d1', base(), actor);
    expect((await store.setEnabled('d1', 'lamp_evening', false, actor)).data.scenarios.lamp_evening.enabled).toBe(false);
    await expect(store.setEnabled('d1', 'lamp_evening', 'no', actor)).rejects.toMatchObject({ code: 'BAD_SCENARIO' });
    await expect(store.setEnabled('d1', 'nope', true, actor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await store.saveSettings('d1', { tzOffsetMin: 120 })).data.settings.tzOffsetMin).toBe(120);
    expect((await store.remove('d1', 'lamp_evening')).data.scenarios).toEqual({});
    await expect(store.remove('d1', 'lamp_evening')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.remove('d1', 'toString')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('параллельные правки одного dID не теряют друг друга', async () => {
    await Promise.all(Array.from({ length: 5 }, (_, i) => store.save('d1', base({ id: `s${i}` }), actor)));
    expect(Object.keys((await store.read('d1')).scenarios).sort()).toEqual(['s0', 's1', 's2', 's3', 's4']);
  });

  test('недопустимый dID — ошибка пути', async () => {
    await expect(store.save('../x', base(), actor)).rejects.toMatchObject({ code: 'BAD_DID' });
  });
});
