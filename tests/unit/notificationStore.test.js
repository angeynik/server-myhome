// tests/unit/notificationStore.test.js
// Хранилище уведомлений на настоящих файлах во временном DATA_DIR (tests/setup.js).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createNotificationStore, validateItem } = require('../../services/notificationStore');
const { fileCache } = require('../../services/configStore');

const DATA = process.env.DATA_DIR;
const MEDIA = path.join(os.tmpdir(), `myhome-test-media-${process.pid}`);
const config = { NOTIFICATION_MAX_ITEMS: 3, NOTIFICATION_MEDIA_DIR: MEDIA };

const base = (extra = {}) => ({
  room: 'room01', section: 'sensors', item: 'dTemp01', group: 'Гостиная', roomTitle: 'Гостиная', title: 'Температура',
  condition: { op: 'gt', value: 25 }, ...extra,
});

let t = Date.parse('2026-06-15T07:00:00Z');
const store = createNotificationStore({ config, now: () => t });

beforeEach(() => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(MEDIA, { recursive: true, force: true });
  fileCache.clear();
});

describe('validateItem', () => {
  test('значения по умолчанию: без интервалов и периодов, канал web, лишние поля отброшены', () => {
    expect(validateItem({ ...base(), evil: 1 })).toEqual({
      ...base(), unit: '', intervals: [], periods: [], cameras: [], channel: 'web',
    });
  });

  test('кириллица в имени параметра допустима (dСurrent)', () => {
    expect(validateItem(base({ item: 'dСurrent01' })).item).toBe('dСurrent01');
  });

  test.each([
    ['раздел', { section: 'evil' }],
    ['условие', { condition: { op: 'xx', value: 1 } }],
    ['время', { intervals: [{ from: '25:00', to: '10:00' }] }],
    ['тип периода', { periods: [{ type: 'year' }] }],
    ['числа месяца', { periods: [{ type: 'monthDays', days: [32] }] }],
    ['канал', { channel: 'sms' }],
    ['комната с путём', { room: '../x' }],
  ])('ошибка: %s', (_, extra) => {
    expect(() => validateItem(base(extra))).toThrow(/Неверные данные/);
  });

  test('период дат: начало позже окончания — ошибка', () => {
    expect(() => validateItem(base({ periods: [{ type: 'dates', from: '2026-07-01', to: '2026-06-01' }] })))
      .toThrow(/позже окончания/);
  });
});

describe('конфигурация уведомлений', () => {
  test('нет файла — null; create создаёт <dID>_notification.json', async () => {
    expect(await store.list('igumen')).toBeNull();
    const res = await store.save('igumen', base(), { username: 'anna' });
    expect(res).toMatchObject({ id: 'room01:sensors:dTemp01', created: true });
    const file = JSON.parse(fs.readFileSync(path.join(DATA, 'igumen_notification.json'), 'utf8'));
    expect(file['room01:sensors:dTemp01']).toMatchObject({
      id: 'room01:sensors:dTemp01', room: 'room01', section: 'sensors', item: 'dTemp01', group: 'Гостиная',
      createdAt: '2026-06-15T07:00:00.000Z', updatedBy: 'anna',
    });
  });

  test('edit того же параметра обновляет запись, createdAt сохраняется', async () => {
    await store.save('igumen', base(), { username: 'anna' });
    t += 60000;
    const res = await store.save('igumen', base({ condition: { op: 'lt', value: 10 } }), { username: 'boris' });
    expect(res.created).toBe(false);
    expect(res.items['room01:sensors:dTemp01']).toMatchObject({
      condition: { op: 'lt', value: 10 }, createdAt: '2026-06-15T07:00:00.000Z', updatedBy: 'boris',
    });
  });

  test('лимит числа уведомлений', async () => {
    for (const n of [1, 2, 3]) await store.save('igumen', base({ item: `dTemp0${n}` }));
    await expect(store.save('igumen', base({ item: 'dTemp09' }))).rejects.toMatchObject({ code: 'LIMIT' });
  });

  test('delete по id и по room/section/item; нет записи — NOT_FOUND', async () => {
    await store.save('igumen', base());
    await store.save('igumen', base({ item: 'dHum01' }));
    expect(Object.keys((await store.remove('igumen', { id: 'room01:sensors:dTemp01' })).items)).toEqual(['room01:sensors:dHum01']);
    expect((await store.remove('igumen', { room: 'room01', section: 'sensors', item: 'dHum01' })).items).toEqual({});
    await expect(store.remove('igumen', { id: 'room01:sensors:dHum01' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('статусы, кадры, обход dID', () => {
  test('статусы: нет файла — null; запись в <dID>_notification_status.json', async () => {
    expect(await store.readStatus('igumen')).toBeNull();
    await store.writeStatus('igumen', { a: { status: 'ON', read: 'OFF' } });
    expect(JSON.parse(fs.readFileSync(path.join(DATA, 'igumen_notification_status.json'), 'utf8')))
      .toEqual({ a: { status: 'ON', read: 'OFF' } });
  });

  test('кадры: сохранить, прочитать, удалить; недопустимое имя — ошибка', async () => {
    await store.saveMedia('igumen', 'ev-1', 'cam01', Buffer.from('JPEG'));
    expect((await store.readMedia('igumen', 'ev-1', 'cam01')).toString()).toBe('JPEG');
    await store.removeMedia('igumen', 'ev-1', ['cam01']);
    expect(await store.readMedia('igumen', 'ev-1', 'cam01')).toBeNull();
    await expect(store.saveMedia('igumen', '../x', 'cam01', Buffer.from(''))).rejects.toMatchObject({ code: 'BAD_MEDIA' });
  });

  test('listDIDs: dID с файлом уведомлений или статусов', async () => {
    await store.save('igumen', base());
    await store.writeStatus('poddy_base', {});
    fs.writeFileSync(path.join(DATA, 'igumen.json'), '{}');
    expect((await store.listDIDs()).sort()).toEqual(['igumen', 'poddy_base']);
  });
});
