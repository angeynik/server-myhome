// tests/unit/telegramCommands.test.js
// Команды бота: /object, /info, /photo, /alarm, /set (кнопки, текст, права, лимиты, подтверждение).
'use strict';

const { createTelegramCommands } = require('../../services/telegramCommands');

const CONFIG = {
  init: { limits: { Temp: { low: 8, high: 36, step: 0.5 } } },
  room01: {
    group: 'Гостиная',
    sensors: { dTemp01: { value: 22.5, type: 'num' } },
    setpoints: { sTemp01: { value: 21, type: 'num' } },
    system: { aPump01: { value: 'ON', type: 'bool' } },
  },
  room02: { group: 'Спальня', sensors: { dTemp02: { value: 19, type: 'num' } }, setpoints: { sTemp02: { value: 20 } } },
};
const ITEMS = {
  'room01:sensors:dTemp01': {
    id: 'room01:sensors:dTemp01', room: 'room01', roomTitle: 'Гостиная', title: 'Температура', unit: '°C',
    condition: { op: 'gt', value: 25 }, intervals: [{ from: '08:00', to: '20:00' }], periods: [{ type: 'weekDays', days: [6, 7] }],
    cameras: ['cam01'], channel: 'both',
  },
};
const STATUS = {
  'room01:sensors:dTemp01': { status: 'ON', since: '2026-11-18T09:12:00.000Z', text: 'Гостиная · Температура: 26 °C (условие > 25 °C)' },
};

const user = (extra = {}) => ({ username: 'ivan', dID: 'igumen', permissionLevel: 1, disabled: false, ...extra });

function setup({ users = [user()], config = CONFIG, exec = { ok: true, via: 'config' }, cams = [{ id: 'cam01', title: 'Ворота', status: 'online' }], required = 1 } = {}) {
  let msgId = 0;
  const sent = [];
  const ui = {
    send: jest.fn(async (chatId, html, kb) => { sent.push({ html, kb }); return { message_id: ++msgId }; }),
    edit: jest.fn(async (chatId, id, html, kb) => { sent.push({ edit: id, html, kb }); return {}; }),
    photo: jest.fn(async () => ({})),
    answer: jest.fn(async () => true),
  };
  const executeCommand = jest.fn(async () => exec);
  const saved = {};
  const cmds = createTelegramCommands({
    ui,
    readConfig: async () => JSON.parse(JSON.stringify(config)),
    notificationStore: { list: async () => ITEMS, readStatus: async () => STATUS },
    cameras: { list: jest.fn(() => cams), frame: jest.fn((dID, id) => (id === 'cam01' ? { jpeg: Buffer.from('J'), timestamp: 0, title: 'Ворота' } : null)) },
    executeCommand,
    requiredLevel: () => required,
    contextStore: { load: () => ({}), save: (d) => Object.assign(saved, d) },
  });
  const last = () => sent.at(-1);
  const buttons = (m = last()) => (m.kb?.inline_keyboard || []).flat();
  const press = (data, messageId = msgId) => cmds.callback({ id: 'cb', data, message: { chat: { id: 42, type: 'private' }, message_id: messageId } }, users);
  const cmd = (name, arg = '') => cmds.command(42, name, arg, users);
  return { cmds, ui, sent, last, buttons, press, cmd, executeCommand, saved };
}

describe('/object', () => {
  const two = [user(), user({ username: 'ivan_d', dID: 'dacha', permissionLevel: 2 })];

  test('несколько объектов: команда без выбора спрашивает объект и продолжает после выбора', async () => {
    const { cmd, last, buttons, press, saved, sent } = setup({ users: two });
    await cmd('info', 'гостиная');
    expect(last().html).toContain('Выберите объект');
    expect(buttons().map((b) => b.callback_data)).toEqual(['o:igumen', 'o:dacha']);
    await press('o:igumen');
    expect(saved).toEqual({ 42: 'igumen' });
    expect(sent.some((m) => m.html.includes('🏠 <b>Гостиная</b>'))).toBe(true);
  });

  test('один объект — выбирать не нужно; /object dacha — неподключённый объект', async () => {
    const { cmd, last } = setup();
    await cmd('info', 'гостиная');
    expect(last().html).toContain('Гостиная');
    await cmd('object', 'dacha');
    expect(last().html).toContain('не подключён');
  });
});

describe('/info', () => {
  test('без аргумента — кнопки: всё, комнаты, параметры, камеры', async () => {
    const { cmd, buttons } = setup();
    await cmd('info');
    expect(buttons().map((b) => b.text)).toEqual(['📋 Всё', '🏠 Гостиная', '🏠 Спальня', 'Температура', 'Насос', '📷 Камеры']);
  });

  test('комната: значения, уставка рядом, активное уведомление 🚨', async () => {
    const { cmd, last } = setup();
    await cmd('info', 'гост');
    expect(last().html).toBe('🏠 <b>Гостиная</b>\n🌡 Температура: <b>22.5 °C</b> · уставка 21 °C 🚨\n⛲ Насос: <b>ON</b>');
  });

  test('все — по сообщению на комнату и камеры', async () => {
    const { cmd, sent } = setup();
    await cmd('info', 'все');
    expect(sent.map((m) => m.html.split('\n')[0])).toEqual([
      expect.stringContaining('Объект <b>igumen</b>'), '🏠 <b>Гостиная</b>', '🏠 <b>Спальня</b>', '📷 <b>Камеры</b>',
    ]);
  });

  test('параметр по комнатам; кнопка параметра (по номеру)', async () => {
    const { cmd, last, press, buttons } = setup();
    await cmd('info', 'температура');
    expect(last().html).toBe('🌡 <b>Температура</b>\nГостиная: <b>22.5 °C</b> · уставка 21 °C 🚨\nСпальня: <b>19 °C</b> · уставка 20 °C');
    await cmd('info');
    const tempBtn = buttons().find((b) => b.text === 'Температура');
    expect(tempBtn.callback_data).toBe('i:n:0');
    await press('i:n:0');
    expect(last().html).toContain('🌡 <b>Температура</b>');
  });

  test('не найдено — подсказка', async () => {
    const { cmd, last } = setup();
    await cmd('info', 'чердак');
    expect(last().html).toContain('Не найдено');
  });
});

describe('/photo и /alarm', () => {
  test('/photo: одна камера — сразу кадр; камеры без кадра — сообщение', async () => {
    const { cmd, ui, last } = setup();
    await cmd('photo');
    expect(ui.photo).toHaveBeenCalledWith('42', Buffer.from('J'), expect.stringContaining('Ворота'));
    const s2 = setup({ cams: [{ id: 'cam01', title: 'Ворота' }, { id: 'cam02', title: 'Двор' }] });
    await s2.cmd('photo', 'двор');
    expect(s2.last().html).toContain('кадра пока нет');
    await s2.cmd('photo');
    expect(s2.buttons().map((b) => b.callback_data)).toEqual(['p:a', 'p:cam01', 'p:cam02']);
    expect(last).toBeDefined();
  });

  test('/alarm активные и все', async () => {
    const { cmd, last } = setup();
    await cmd('alarm', 'активные');
    expect(last().html).toContain('Гостиная · Температура: 26 °C (условие &gt; 25 °C)');
    await cmd('alarm', 'все');
    expect(last().html).toContain('🚨 <b>Гостиная · Температура</b> &gt; 25 °C');
    expect(last().html).toContain('контроль: 08:00–20:00; сб, вс');
    expect(last().html).toContain('канал: веб + Telegram, камер: 1');
  });
});

describe('/set', () => {
  test('текстом: комната, параметр, значение → редактор с подтверждением → запись единым механизмом', async () => {
    const { cmd, last, buttons, press, executeCommand, sent } = setup();
    await cmd('set', 'гостиная температура 22,5');
    expect(last().html).toContain('Гостиная · Уставка температуры');
    expect(last().html).toContain('Новое: <b>22.5 °C</b>');
    expect(buttons().map((b) => b.callback_data)).toEqual(['s:d:-1', 's:d:-0.5', 's:d:0.5', 's:d:1', 's:ok', 's:x']);
    await press('s:ok');
    expect(executeCommand).toHaveBeenCalledWith({
      dID: 'igumen',
      message: {
        type: 'post', request: 'setpoints', name: 'igumen',
        payload: { room: 'room01', param: 'dTemp01', key: 'Temp', setKey: 'sTemp01', value: 22.5, time: expect.any(String) },
      },
    });
    expect(sent.at(-1).html).toBe('✅ Гостиная · Уставка температуры: <b>22.5 °C</b>');
  });

  test('кнопками: комната → параметр → ± шаг → подтвердить', async () => {
    const { cmd, buttons, press, last, executeCommand } = setup();
    await cmd('set');
    expect(buttons().map((b) => b.callback_data)).toEqual(['s:r:room01', 's:r:room02']);
    await press('s:r:room01');
    expect(buttons().map((b) => b.text)).toEqual(['Уставка температуры: 21 °C', 'Насос: ON']);
    await press('s:i:room01:sp:sTemp01');
    const editor = last();
    await press('s:d:1', 3);
    await press('s:d:0.5', 3);
    expect(last().edit).toBe(3);
    expect(last().html).toContain('Новое: <b>22.5 °C</b>');
    await press('s:ok', 3);
    expect(executeCommand.mock.calls[0][0].message.payload.value).toBe(22.5);
    expect(editor).toBeDefined();
  });

  test('переключатель «Состояния устройств»: ON/OFF в форме хранения, request system', async () => {
    const { cmd, press, executeCommand } = setup();
    await cmd('set', 'гостиная насос off');
    await press('s:ok');
    expect(executeCommand.mock.calls[0][0].message).toEqual({
      type: 'post', request: 'system', name: 'igumen',
      payload: { room: 'room01', item_name: 'aPump01', value: 'OFF', value_type: 'bool' },
    });
  });

  test('число сообщением при открытом редакторе; вне диапазона — ошибка', async () => {
    const { cmd, cmds, last, sent } = setup();
    await cmd('set', 'спальня температура');
    expect(await cmds.text(42, '50', [user()])).toBe(true);
    expect(last().html).toContain('вне диапазона 8–36 °C');
    await cmds.text(42, '23', [user()]);
    // новый редактор внизу чата, старый помечен «продолжено ниже»
    expect(sent.at(-2).html).toContain('Новое: <b>23 °C</b>');
    expect(last().html).toContain('продолжено ниже');
  });

  test('без изменения значения кнопки «Подтвердить» нет; отмена', async () => {
    const { cmd, buttons, press, last } = setup();
    await cmd('set', 'гостиная температура 21');
    expect(buttons().map((b) => b.callback_data)).not.toContain('s:ok');
    await press('s:x');
    expect(last().html).toContain('отменено');
  });

  test('нет прав — информационное сообщение, редактор не открывается', async () => {
    const { cmd, last, executeCommand } = setup({ required: 2 });
    await cmd('set', 'гостиная температура 22');
    expect(last().html).toContain('⛔ Недостаточно прав');
    expect(last().html).toContain('с уровня 2, у учётной записи <b>ivan</b> — уровень 1');
    expect(executeCommand).not.toHaveBeenCalled();
  });

  test('ошибка записи (устройство) — сообщение с причиной', async () => {
    const { cmd, press, last } = setup({ exec: { ok: false, error: 'Устройство не ответило', via: 'modbus' } });
    await cmd('set', 'гостиная температура 23');
    await press('s:ok');
    expect(last().html).toContain('❌ Гостиная · Уставка температуры: не удалось записать — Устройство не ответило');
  });

  test('подтверждение Modbus — «устройство подтвердило»; устаревшая кнопка', async () => {
    const { cmd, press, last } = setup({ exec: { ok: true, via: 'modbus', value: 23 } });
    await cmd('set', 'гостиная температура 23');
    await press('s:ok');
    expect(last().html).toContain('(устройство подтвердило)');
    await press('s:ok');
    expect(last().html).toContain('устарело');
  });
});
