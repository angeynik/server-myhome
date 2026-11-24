// services/telegramCommands.js
// Команды Telegram-бота для подключённого чата (docs/telegram.md, раздел «Команды»):
//
//   /object [dID]                — выбор объекта (конфигурации), если чат подключён к нескольким
//   /info [все | комната | параметр | камеры]  — текущее состояние объекта
//   /photo [все | камера]        — кадры камер
//   /alarm [активные | все]      — уведомления
//   /set [комната параметр значение]  — изменить уставку или переключатель «Состояния устройств»
//
// Аргументы — через пробел, без них — кнопки (inline keyboard). /set всегда заканчивается
// подтверждением кнопкой; запись идёт тем же путём, что из приложения (executeCommand →
// commandGateway: мост Modbus или handlePost + рассылка всем клиентам dID). Права — как в
// приложении (REQUIRED_LEVEL.post[setpoints|system]); без прав — сообщение об ограничении.
//
// callback_data кнопок (до 64 байт): o:<dID> · i:a | i:c | i:r:<room> | i:n:<номер параметра> ·
// p:a | p:<cameraId> · a:on | a:all · s:r:<room> | s:i:<room>:<sp|sy>:<item> | s:d:<±шаг> |
// s:b:<1|0> | s:ok | s:x
'use strict';

const logger = require('./logger.js');
const ov = require('./objectView.js');
const rules = require('./notificationRules.js');

const SET_TTL_MS = 5 * 60 * 1000;
const SEC = { sp: 'setpoints', sy: 'system' };
const SEC_CODE = { setpoints: 'sp', system: 'sy' };
const CHANNEL_LABEL = { web: 'веб', telegram: 'Telegram', both: 'веб + Telegram' };
const WORDS_ALL = ['все', 'всё', 'all'];
const WORDS_ACTIVE = ['активные', 'active', 'акт'];
const WORDS_CAMERAS = ['камеры', 'камера', 'cameras', 'camera'];

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mskTime = (t) => (t ? new Date(t).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '');
const isWord = (arg, words) => words.includes(ov.norm(arg));

// Кнопки по n в ряд: [[{ text, callback_data }]]
function keyboard(buttons, perRow = 2) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
  return { inline_keyboard: rows };
}
const btn = (text, data) => ({ text: String(text).slice(0, 60), callback_data: String(data).slice(0, 64) });

function createTelegramCommands({
  ui,                       // { send(chatId, html, keyboard?) → { message_id }, edit(chatId, msgId, html, keyboard?), photo(chatId, jpeg, caption), answer(cbId, text?) }
  readConfig,               // async (dID) → объект <dID>.json
  notificationStore,        // { list(dID), readStatus(dID) }
  cameras,                  // { list(dID, level) → [{ id, title, status }], frame(dID, cameraId) → { jpeg, timestamp, title } | null }
  executeCommand,           // async ({ dID, message }) → { ok, via, value?, error? }
  requiredLevel = () => 1,  // (request) → минимальный уровень (REQUIRED_LEVEL.post)
  contextStore = null,      // { load(), save(data) } — выбранный объект чата
  now = Date.now,
}) {
  const selected = new Map(Object.entries(contextStore?.load?.() || {})); // chatId → dID
  const pendingSet = new Map();   // chatId → { dID, room, section, key, value, messageId, expires }
  const after = new Map();        // chatId → { cmd, arg } — продолжить после выбора объекта

  const saveSelected = () => contextStore?.save?.(Object.fromEntries(selected));

  // ── Объект (dID) ───────────────────────────────────────────────────
  function objects(users) {
    const map = new Map();
    for (const u of users.filter((x) => !x.disabled)) {
      const prev = map.get(u.dID);
      if (!prev || u.permissionLevel > prev.level) map.set(u.dID, { dID: u.dID, level: u.permissionLevel, username: u.username });
    }
    return [...map.values()];
  }

  function currentObject(chatId, users) {
    const list = objects(users);
    const sel = list.find((o) => o.dID === selected.get(chatId));
    if (sel) return sel;
    return list.length === 1 ? list[0] : null;
  }

  async function askObject(chatId, users, continueWith = null) {
    const list = objects(users);
    if (!list.length) return ui.send(chatId, 'Подключённые учётные записи отключены.');
    if (continueWith) after.set(chatId, continueWith);
    const cur = selected.get(chatId);
    return ui.send(
      chatId,
      'Выберите объект (конфигурацию):',
      keyboard(list.map((o) => btn(`${o.dID === cur ? '✓ ' : ''}${o.dID}`, `o:${o.dID}`)), 2),
    );
  }

  async function selectObject(chatId, users, dID) {
    const obj = objects(users).find((o) => o.dID === dID);
    if (!obj) return ui.send(chatId, `Объект «${escapeHtml(dID)}» к этому чату не подключён. /object — список.`);
    selected.set(chatId, dID);
    saveSelected();
    pendingSet.delete(chatId);
    await ui.send(chatId, `Объект: <b>${escapeHtml(dID)}</b>`);
    const next = after.get(chatId);
    after.delete(chatId);
    if (next) return runCommand(chatId, next.cmd, next.arg, users);
    return true;
  }

  // Команда, которой нужен объект: нет выбора при нескольких — спросить и продолжить
  async function withObject(chatId, users, cmd, arg, fn) {
    const obj = currentObject(chatId, users);
    if (!obj) return askObject(chatId, users, { cmd, arg });
    return fn(obj);
  }

  async function activeIds(dID) {
    const st = (await notificationStore.readStatus(dID)) || {};
    return new Set(Object.entries(st).filter(([, e]) => e?.status === 'ON').map(([id]) => id));
  }

  // ── /info ────────────────────────────────────────────────────────────
  function itemLine(room, item, active) {
    const sp = item.setpoint ? ` · уставка ${ov.formatValue(item.setpoint.entry, item.unit)}` : '';
    const alarm = active.has(`${room.key}:${item.section}:${item.key}`) ? ' 🚨' : '';
    return `${item.icon} ${escapeHtml(item.title)}: <b>${escapeHtml(ov.formatValue(item.entry, item.unit))}</b>${escapeHtml(sp)}${alarm}`;
  }

  function roomText(room, active) {
    return [`🏠 <b>${escapeHtml(room.title)}</b>`, ...room.items.map((i) => itemLine(room, i, active))].join('\n');
  }

  async function info(chatId, obj, arg) {
    const rooms = ov.buildRooms(await readConfig(obj.dID));
    const cams = cameras.list(obj.dID, obj.level);
    if (!rooms.length && !cams.length) return ui.send(chatId, `Объект <b>${escapeHtml(obj.dID)}</b>: данных пока нет.`);

    if (!arg) {
      const buttons = [btn('📋 Всё', 'i:a'), ...rooms.map((r) => btn(`🏠 ${r.title}`, `i:r:${r.key}`)),
        // номер в списке названий, а не само название: кириллица — 2 байта, лимит данных кнопки 64 байта
        ...ov.paramTitles(rooms).map((t, idx) => btn(t, `i:n:${idx}`))];
      if (cams.length) buttons.push(btn('📷 Камеры', 'i:c'));
      return ui.send(chatId, `Объект <b>${escapeHtml(obj.dID)}</b>. Что показать?`, keyboard(buttons, 2));
    }

    const active = await activeIds(obj.dID);
    if (isWord(arg, WORDS_ALL)) {
      await ui.send(chatId, `📋 Объект <b>${escapeHtml(obj.dID)}</b> · ${escapeHtml(mskTime(now()))}`);
      // по сообщению на комнату — лимит Telegram 4096 символов
      for (const r of rooms) await ui.send(chatId, roomText(r, active));
      if (cams.length) await ui.send(chatId, camerasText(cams));
      return true;
    }
    if (isWord(arg, WORDS_CAMERAS)) return ui.send(chatId, cams.length ? camerasText(cams) : 'Камеры не настроены.');

    const byRoom = rooms.filter((r) => r.key === arg);
    const foundRooms = byRoom.length ? byRoom : ov.findRooms(rooms, arg);
    if (foundRooms.length) {
      for (const r of foundRooms) await ui.send(chatId, roomText(r, active));
      return true;
    }

    const titles = ov.findParamTitles(rooms, arg);
    if (titles.length) {
      for (const title of titles) {
        const lines = [];
        for (const r of rooms) {
          for (const i of r.items.filter((x) => x.title === title)) {
            const sp = i.setpoint ? ` · уставка ${ov.formatValue(i.setpoint.entry, i.unit)}` : '';
            const alarm = active.has(`${r.key}:${i.section}:${i.key}`) ? ' 🚨' : '';
            lines.push(`${escapeHtml(r.title)}: <b>${escapeHtml(ov.formatValue(i.entry, i.unit))}</b>${escapeHtml(sp)}${alarm}`);
          }
        }
        const icon = rooms.flatMap((r) => r.items).find((i) => i.title === title)?.icon || '•';
        await ui.send(chatId, [`${icon} <b>${escapeHtml(title)}</b>`, ...lines].join('\n'));
      }
      return true;
    }
    return ui.send(chatId, `Не найдено: «${escapeHtml(arg)}». Отправьте /info, чтобы выбрать кнопками.`);
  }

  function camerasText(cams) {
    const st = { online: '🟢', starting: '🟡', offline: '🔴' };
    return ['📷 <b>Камеры</b>', ...cams.map((c) => `${st[c.status] || '•'} ${escapeHtml(c.title)}`), 'Кадры: /photo'].join('\n');
  }

  // ── /photo ───────────────────────────────────────────────────────────
  async function sendFrame(chatId, obj, cam) {
    const frame = cameras.frame(obj.dID, cam.id);
    if (!frame) return ui.send(chatId, `📷 ${escapeHtml(cam.title)}: кадра пока нет.`);
    return ui.photo(chatId, frame.jpeg, `${frame.title} · ${mskTime(frame.timestamp)} · ${obj.dID}`);
  }

  async function photo(chatId, obj, arg) {
    const cams = cameras.list(obj.dID, obj.level);
    if (!cams.length) return ui.send(chatId, 'Камеры не настроены.');
    if (!arg) {
      if (cams.length === 1) return sendFrame(chatId, obj, cams[0]);
      return ui.send(chatId, 'Кадр какой камеры?', keyboard([btn('📷 Все', 'p:a'), ...cams.map((c) => btn(c.title, `p:${c.id}`))], 2));
    }
    const list = isWord(arg, WORDS_ALL)
      ? cams
      : cams.filter((c) => c.id === arg || ov.matches(arg, c.title));
    if (!list.length) return ui.send(chatId, `Камера «${escapeHtml(arg)}» не найдена. /photo — список.`);
    for (const c of list) await sendFrame(chatId, obj, c);
    return true;
  }

  // ── /alarm ───────────────────────────────────────────────────────────
  function windowText(item) {
    const iv = (item.intervals || []).map((x) => `${x.from}–${x.to}`).join(', ') || 'круглые сутки';
    const pr = (item.periods || []).map((p) => {
      if (p.type === 'dates') return `${p.from} — ${p.to}`;
      if (p.type === 'monthDays') return `числа ${p.days.join(', ')}`;
      return p.days.map((d) => rules.WEEKDAY_NAMES[d]).join(', ');
    }).join('; ') || 'круглый год';
    return `${iv}; ${pr}`;
  }

  async function alarm(chatId, obj, arg) {
    if (!arg) return ui.send(chatId, 'Какие уведомления показать?', keyboard([btn('🚨 Активные', 'a:on'), btn('📋 Все', 'a:all')], 2));
    const items = (await notificationStore.list(obj.dID)) || {};
    const status = (await notificationStore.readStatus(obj.dID)) || {};

    if (isWord(arg, WORDS_ACTIVE)) {
      const act = Object.entries(status).filter(([, e]) => e?.status === 'ON')
        .sort(([, a], [, b]) => String(b.since).localeCompare(String(a.since)));
      if (!act.length) return ui.send(chatId, `✅ Активных уведомлений нет (объект <b>${escapeHtml(obj.dID)}</b>).`);
      return ui.send(chatId, [`🚨 <b>Активные уведомления</b> · ${escapeHtml(obj.dID)}`,
        ...act.map(([, e]) => `\n${escapeHtml(e.text || '')}\n🕒 с ${escapeHtml(mskTime(e.since))}`)].join('\n'));
    }
    if (isWord(arg, WORDS_ALL)) {
      const list = Object.values(items);
      if (!list.length) return ui.send(chatId, `Уведомления не настроены (объект <b>${escapeHtml(obj.dID)}</b>).`);
      const lines = list.map((it) => {
        const on = status[it.id]?.status === 'ON';
        const place = [it.roomTitle || it.group || it.room, it.title || it.item].filter(Boolean).join(' · ');
        return `${on ? '🚨' : '✅'} <b>${escapeHtml(place)}</b> ${escapeHtml(rules.conditionText(it.condition, it.unit))}\n` +
          `   контроль: ${escapeHtml(windowText(it))}\n` +
          `   канал: ${CHANNEL_LABEL[it.channel] || it.channel}${it.cameras?.length ? `, камер: ${it.cameras.length}` : ''}` +
          `${on ? `\n   активно с ${escapeHtml(mskTime(status[it.id].since))}` : ''}`;
      });
      return ui.send(chatId, [`📋 <b>Уведомления</b> · ${escapeHtml(obj.dID)}`, ...lines].join('\n\n'));
    }
    return ui.send(chatId, 'Укажите: /alarm активные или /alarm все');
  }

  // ── /set ─────────────────────────────────────────────────────────────
  const requestOf = (section) => (section === 'setpoints' ? 'setpoints' : 'system');

  function denyText(obj, request) {
    return `⛔ Недостаточно прав: изменение ${request === 'setpoints' ? 'уставок' : 'переключателей'} доступно ` +
      `с уровня ${requiredLevel(request)}, у учётной записи <b>${escapeHtml(obj.username)}</b> — уровень ${obj.level}.`;
  }

  const canChange = (obj, request) => obj.level >= requiredLevel(request);

  function decimals(step) {
    const part = String(step).split('.')[1] || '';
    return Math.min(4, part.length);
  }

  function valueText(item, v) {
    if (item.kind === 'bool') return ov.boolOf(v) ? 'ON' : 'OFF';
    return `${v}${item.unit ? ` ${item.unit}` : ''}`;
  }

  // Число из текста: «22,5» → 22.5; выход за лимиты — ошибка; округление по шагу
  function parseNumber(item, raw) {
    const n = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(n)) return { error: `«${raw}» — не число` };
    const { low, high, step } = item.limits;
    if (n < low || n > high) return { error: `значение вне диапазона ${low}–${high}${item.unit ? ` ${item.unit}` : ''}` };
    return { value: Number((Math.round(n / step) * step).toFixed(decimals(step))) };
  }

  function parseBool(raw) {
    const w = ov.norm(raw);
    if (['on', 'вкл', 'включить', '1', 'да', 'true'].includes(w)) return true;
    if (['off', 'выкл', 'выключить', '0', 'нет', 'false'].includes(w)) return false;
    return null;
  }

  function editorText(item, roomTitle, p) {
    const cur = item.kind === 'bool' ? ov.boolOf(item.entry.value) : Number(item.entry.value);
    const lines = [
      `✏️ <b>${escapeHtml(roomTitle)} · ${escapeHtml(item.title)}</b>`,
      `Сейчас: ${escapeHtml(item.entry.value === undefined || item.entry.value === null ? '—' : valueText(item, cur))}`,
      `Новое: <b>${escapeHtml(valueText(item, p.value))}</b>`,
    ];
    if (item.kind === 'number') {
      const { low, high, step } = item.limits;
      lines.push(`Диапазон ${low}–${high}${item.unit ? ` ${item.unit}` : ''}, шаг ${step}`);
      lines.push('Измените кнопками или отправьте число сообщением.');
    }
    return lines.join('\n');
  }

  function editorKeyboard(item, p) {
    const rows = [];
    if (item.kind === 'number') {
      const s = item.limits.step;
      const deltas = s < 1 ? [-1, -s, s, 1] : [-5 * s, -s, s, 5 * s];
      rows.push(deltas.map((d) => btn(`${d > 0 ? '+' : '−'}${Math.abs(d)}`, `s:d:${d}`)));
    } else {
      const on = ov.boolOf(p.value);
      rows.push([btn(`${on ? '● ' : ''}ON`, 's:b:1'), btn(`${on ? '' : '● '}OFF`, 's:b:0')]);
    }
    const changed = item.kind === 'bool'
      ? ov.boolOf(p.value) !== ov.boolOf(item.entry.value)
      : Number(p.value) !== Number(item.entry.value);
    rows.push([
      ...(changed ? [btn(`✅ Подтвердить: ${valueText(item, p.value)}`, 's:ok')] : []),
      btn('✖️ Отмена', 's:x'),
    ]);
    return { inline_keyboard: rows };
  }

  async function loadItem(dID, room, section, key) {
    const config = await readConfig(dID);
    const item = ov.settableItems(config, room).find((i) => i.section === section && i.key === key);
    const roomTitle = ov.buildRooms(config).find((r) => r.key === room)?.title
      || config?.[room]?.group || config?.[room]?.title || room;
    return { item, roomTitle };
  }

  // Открыть редактор значения; value — сразу новое значение (/set … 22.5)
  async function openEditor(chatId, obj, room, section, key, value) {
    const { item, roomTitle } = await loadItem(obj.dID, room, section, key);
    if (!item) return ui.send(chatId, 'Параметр не найден. /set — выбрать заново.');
    if (!canChange(obj, requestOf(section))) return ui.send(chatId, denyText(obj, requestOf(section)));
    const start = value !== undefined ? value
      : item.kind === 'bool' ? !ov.boolOf(item.entry.value)
        : Number.isFinite(Number(item.entry.value)) && item.entry.value !== null && item.entry.value !== '' ? Number(item.entry.value) : item.limits.low;
    const p = { dID: obj.dID, room, section, key, value: start, expires: now() + SET_TTL_MS };
    const sent = await ui.send(chatId, editorText(item, roomTitle, p), editorKeyboard(item, p));
    p.messageId = sent?.message_id;
    pendingSet.set(chatId, p);
    return true;
  }

  async function showSetRooms(chatId, obj) {
    const config = await readConfig(obj.dID);
    const rooms = ov.buildRooms(config).filter((r) => ov.settableItems(config, r.key).length);
    // Комнаты только с уставками (без датчиков) buildRooms не показывает — добавим их
    for (const key of Object.keys(config || {})) {
      if (!rooms.some((r) => r.key === key) && ov.settableItems(config, key).length) {
        rooms.push({ key, title: key === ov.COMMON_KEY ? ov.COMMON_TITLE : config[key].group || config[key].title || key });
      }
    }
    if (!rooms.length) return ui.send(chatId, 'Изменяемых параметров нет.');
    return ui.send(chatId, 'В какой комнате изменить значение?', keyboard(rooms.map((r) => btn(`🏠 ${r.title}`, `s:r:${r.key}`)), 2));
  }

  async function showSetItems(chatId, obj, room, items = null) {
    const config = await readConfig(obj.dID);
    const list = items || ov.settableItems(config, room);
    if (!list.length) return ui.send(chatId, 'В этой комнате нечего изменять.');
    return ui.send(chatId, 'Что изменить?', keyboard(list.map((i) => btn(
      `${i.title}: ${valueText(i, i.kind === 'bool' ? ov.boolOf(i.entry.value) : i.entry.value)}`,
      `s:i:${i.room}:${SEC_CODE[i.section]}:${i.key}`,
    )), 1));
  }

  async function set(chatId, obj, arg) {
    if (!canChange(obj, 'setpoints') && !canChange(obj, 'system')) return ui.send(chatId, denyText(obj, 'setpoints'));
    if (!arg) return showSetRooms(chatId, obj);

    const config = await readConfig(obj.dID);
    const words = arg.split(/\s+/);
    const last = words[words.length - 1];
    const hasValue = words.length > 1 && (Number.isFinite(Number(last.replace(',', '.'))) || parseBool(last) !== null);
    const rest = ov.norm((hasValue ? words.slice(0, -1) : words).join(' '));

    // Комната — самое длинное совпадение с началом текста, иначе первое слово
    const allRooms = Object.keys(config || {})
      .filter((k) => ov.settableItems(config, k).length)
      .map((k) => ({ key: k, title: k === ov.COMMON_KEY ? ov.COMMON_TITLE : config[k].group || config[k].title || k }));
    let room = allRooms
      .filter((r) => rest === ov.norm(r.title) || rest.startsWith(`${ov.norm(r.title)} `))
      .sort((a, b) => b.title.length - a.title.length)[0];
    let itemQuery = room ? rest.slice(ov.norm(room.title).length).trim() : '';
    if (!room) {
      const first = rest.split(' ')[0];
      const cands = allRooms.filter((r) => ov.matches(first, r.title));
      if (cands.length > 1) return ui.send(chatId, 'Уточните комнату:', keyboard(cands.map((r) => btn(`🏠 ${r.title}`, `s:r:${r.key}`)), 2));
      [room] = cands;
      itemQuery = rest.split(' ').slice(1).join(' ');
    }
    if (!room) return ui.send(chatId, `Комната не найдена в «${escapeHtml(arg)}». /set — выбрать кнопками.`);
    if (!itemQuery) return showSetItems(chatId, obj, room.key);

    const found = ov.findSettable(config, room.key, itemQuery);
    if (!found.length) return ui.send(chatId, `В комнате «${escapeHtml(room.title)}» нет «${escapeHtml(itemQuery)}». /set — выбрать кнопками.`);
    if (found.length > 1) return showSetItems(chatId, obj, room.key, found);

    const item = found[0];
    let value;
    if (hasValue) {
      if (item.kind === 'bool') {
        value = parseBool(last);
        if (value === null) return ui.send(chatId, 'Для переключателя укажите ON или OFF.');
      } else {
        const r = parseNumber(item, last);
        if (r.error) return ui.send(chatId, `❌ ${escapeHtml(r.error)}`);
        value = r.value;
      }
    }
    return openEditor(chatId, obj, room.key, item.section, item.key, value);
  }

  async function refreshEditor(chatId, p) {
    const { item, roomTitle } = await loadItem(p.dID, p.room, p.section, p.key);
    if (!item) return null;
    if (p.messageId) await ui.edit(chatId, p.messageId, editorText(item, roomTitle, p), editorKeyboard(item, p));
    return item;
  }

  async function confirmSet(chatId, users, p) {
    pendingSet.delete(chatId);
    const obj = objects(users).find((o) => o.dID === p.dID);
    const { item, roomTitle } = await loadItem(p.dID, p.room, p.section, p.key);
    const done = (html) => (p.messageId ? ui.edit(chatId, p.messageId, html) : ui.send(chatId, html));
    if (!obj || !item) return done('❌ Параметр больше недоступен.');
    const request = requestOf(p.section);
    if (!canChange(obj, request)) return done(denyText(obj, request));

    let value = p.value;
    if (item.kind === 'number') {
      const r = parseNumber(item, value);
      if (r.error) return done(`❌ ${escapeHtml(r.error)}`);
      value = r.value;
    }
    const place = `${roomTitle} · ${item.title}`;
    await done(`⏳ ${escapeHtml(place)}: записываю ${escapeHtml(valueText(item, value))}…`);

    const time = mskTime(now());
    const message = request === 'setpoints'
      ? {
        type: 'post', request, name: p.dID,
        payload: {
          room: p.room, param: `d${ov.clearKey(p.key)}${(p.key.match(/\d+$/) || [''])[0]}`, key: ov.clearKey(p.key),
          setKey: p.key, value: item.kind === 'bool' ? ov.boolInStoredForm(item.entry, value) : value, time,
        },
      }
      : {
        type: 'post', request, name: p.dID,
        payload: { room: p.room, item_name: p.key, value: ov.boolInStoredForm(item.entry, value), value_type: item.entry.type },
      };
    const old = valueText(item, item.kind === 'bool' ? ov.boolOf(item.entry.value) : item.entry.value);
    logger.logInfoMessage(
      `[telegramCommands] - /set ${p.dID} ${p.room}/${p.section}/${p.key}: ${old} → ${valueText(item, value)} ` +
      `(${obj.username}, Telegram-чат ${chatId})`
    );
    let res;
    try {
      res = await executeCommand({ dID: p.dID, message });
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (!res?.ok) {
      logger.logErrorMessage(`[telegramCommands] - /set ${p.dID} ${p.room}/${p.key}: ${res?.error}`);
      return done(`❌ ${escapeHtml(place)}: не удалось записать — ${escapeHtml(res?.error || 'ошибка')}`);
    }
    return done(`✅ ${escapeHtml(place)}: <b>${escapeHtml(valueText(item, value))}</b>` +
      `${res.via && res.via !== 'config' ? ' (устройство подтвердило)' : ''}`);
  }

  // ── Маршрутизация ────────────────────────────────────────────────────
  const COMMANDS = { info, photo, alarm, set };

  async function runCommand(chatId, cmd, arg, users) {
    if (cmd === 'object') {
      if (arg) return selectObject(chatId, users, arg);
      return askObject(chatId, users);
    }
    const fn = COMMANDS[cmd];
    if (!fn) return false;
    if (cmd !== 'set') pendingSet.delete(chatId);
    return withObject(chatId, users, cmd, arg, (obj) => fn(chatId, obj, arg));
  }

  // Команда: true — обработана здесь
  async function command(chatId, cmd, arg, users) {
    if (cmd !== 'object' && !COMMANDS[cmd]) return false;
    await runCommand(String(chatId), cmd, (arg || '').trim(), users);
    return true;
  }

  // Текст без команды: число / ON-OFF для открытого /set. true — обработан
  async function text(chatId, raw, users) {
    const id = String(chatId);
    const p = pendingSet.get(id);
    if (!p || p.expires < now()) {
      pendingSet.delete(id);
      return false;
    }
    const { item } = await loadItem(p.dID, p.room, p.section, p.key);
    if (!item) return false;
    if (item.kind === 'bool') {
      const b = parseBool(raw);
      if (b === null) return false;
      p.value = b;
    } else {
      const r = parseNumber(item, raw);
      if (r.error) {
        await ui.send(id, `❌ ${escapeHtml(r.error)}`);
        return true;
      }
      p.value = r.value;
    }
    // новое сообщение-редактор внизу чата: старое уже далеко
    const { roomTitle } = await loadItem(p.dID, p.room, p.section, p.key);
    const sent = await ui.send(id, editorText(item, roomTitle, p), editorKeyboard(item, p));
    if (p.messageId) await ui.edit(id, p.messageId, '✏️ Изменение продолжено ниже.').catch(() => {});
    p.messageId = sent?.message_id;
    p.expires = now() + SET_TTL_MS;
    return true;
  }

  async function callback(cq, users) {
    const chatId = String(cq.message?.chat?.id);
    const data = String(cq.data || '');
    const [kind, a, ...restParts] = data.split(':');
    const b = restParts.join(':');
    await ui.answer(cq.id);

    if (kind === 'o') return selectObject(chatId, users, [a, b].filter(Boolean).join(':'));
    if (kind === 'i') {
      if (a === 'a') return runCommand(chatId, 'info', 'все', users);
      if (a === 'c') return runCommand(chatId, 'info', 'камеры', users);
      if (a === 'n') {
        return withObject(chatId, users, 'info', '', async (obj) => {
          const title = ov.paramTitles(ov.buildRooms(await readConfig(obj.dID)))[Number(b)];
          return title ? info(chatId, obj, title) : ui.send(chatId, 'Список изменился. /info — заново.');
        });
      }
      return runCommand(chatId, 'info', b, users);
    }
    if (kind === 'p') return runCommand(chatId, 'photo', a === 'a' ? 'все' : [a, b].filter(Boolean).join(':'), users);
    if (kind === 'a') return runCommand(chatId, 'alarm', a === 'on' ? 'активные' : 'все', users);
    if (kind !== 's') return true;

    return withObject(chatId, users, 'set', '', async (obj) => {
      if (a === 'r') return showSetItems(chatId, obj, b);
      if (a === 'i') {
        const [room, sec, ...key] = b.split(':');
        return openEditor(chatId, obj, room, SEC[sec], key.join(':'));
      }
      const p = pendingSet.get(chatId);
      if (!p || p.expires < now() || (cq.message?.message_id && p.messageId && cq.message.message_id !== p.messageId)) {
        pendingSet.delete(chatId);
        if (cq.message?.message_id) await ui.edit(chatId, cq.message.message_id, 'Изменение устарело. /set — начать заново.').catch(() => {});
        return true;
      }
      if (a === 'x') {
        pendingSet.delete(chatId);
        return ui.edit(chatId, p.messageId, '✖️ Изменение отменено.');
      }
      if (a === 'ok') return confirmSet(chatId, users, p);
      const { item } = await loadItem(p.dID, p.room, p.section, p.key);
      if (!item) return true;
      if (a === 'b') p.value = b === '1';
      if (a === 'd' && item.kind === 'number') {
        const { low, high, step } = item.limits;
        const next = Math.min(high, Math.max(low, Number(p.value) + Number(b)));
        p.value = Number((Math.round(next / step) * step).toFixed(decimals(step)));
      }
      p.expires = now() + SET_TTL_MS;
      return refreshEditor(chatId, p);
    });
  }

  function cancel(chatId) {
    const had = pendingSet.delete(String(chatId));
    after.delete(String(chatId));
    return had;
  }

  return { command, text, callback, cancel, currentObject };
}

module.exports = { createTelegramCommands, keyboard, btn };
