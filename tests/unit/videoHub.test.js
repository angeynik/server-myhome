// tests/unit/videoHub.test.js
// Хаб видеокамер: подписки, частота кадров, доступ, сериализация один раз.
// Работники камер (videoStreamService) и WebSocket подменены фейками.
'use strict';

const { createVideoHub } = require('../../services/videoHub');

const OPEN = 1;

function makeCamera(id, extra = {}) {
  return {
    id, title: `Камера ${id}`, source: 'test', dID: 'd1', minLevel: 1,
    previewIntervalMs: 5000, fullIntervalMs: 1000, maxWidth: 640, quality: 5, archive: false,
    test: { size: '1280x720', rate: 10, noise: 20 }, ...extra,
  };
}

function setup({ cameras = [makeCamera('cam01'), makeCamera('cam02')], sessions = {}, list } = {}) {
  const workers = new Map();
  const createWorker = jest.fn(({ deliver }) => {
    const w = {
      deliver,
      config: null,
      init: jest.fn((cfg) => { w.config = cfg; workers.set(cfg.cameraId, w); return true; }),
      start: jest.fn(),
      stop: jest.fn(async () => {}),
      getStats: jest.fn(() => ({ isRunning: true, source: 'test', stats: { ffmpegRestarts: 0, watchdogKills: 0 } })),
    };
    return w;
  });
  const conns = new Map();
  const wsManager = {
    VUE_connections: conns,
    getUserConnections: jest.fn((_, dID) => [...conns.entries()]
      .filter(([, c]) => c.dID === dID)
      .map(([clientId, connection]) => ({ clientId, connection }))),
  };
  const auth = { getSession: jest.fn((id) => sessions[id] || null) };
  let t = 1_000_000;
  const hub = createVideoHub({
    wsManager, auth, createWorker, now: () => t,
    loadConfig: () => ({ tmpDir: '/tmp/v', snapshotInterval: 5000 }),
    loadCameraList: list || (() => ({ file: 'cameras.json', cameras, errors: [], legacy: false })),
    checkFfmpeg: () => null,
    watchFile: jest.fn(),
    unwatchFile: jest.fn(),
  });
  const connect = (clientId, dID = 'd1', level = 1) => {
    const ws = { readyState: OPEN, bufferedAmount: 0, send: jest.fn() };
    conns.set(clientId, { ws, dID });
    sessions[clientId] = { dID, level, username: clientId };
    return ws;
  };
  const frame = (camId, bytes = 1000) => workers.get(camId).deliver({ jpeg: Buffer.alloc(bytes, 7), timestamp: t });
  return { hub, workers, connect, frame, sessions, wsManager, advance: (ms) => { t += ms; } };
}

const frames = (ws) => ws.send.mock.calls.map(([raw]) => JSON.parse(raw).payload.cameraId);

describe('videoHub: инициализация', () => {
  test('по работнику на камеру; ffmpeg кодирует с частотой полного экрана; свой tmpDir', () => {
    const { hub, workers } = setup();
    expect(hub.init()).toBe(true);
    expect([...workers.keys()]).toEqual(['cam01', 'cam02']);
    expect(workers.get('cam01').config).toMatchObject({
      cameraId: 'cam01', source: 'test', rtspUrl: '', snapshotInterval: 1000, archive: false, tmpDir: '/tmp/v/cam01',
    });
  });

  test('16 камер поднимаются и запускаются', () => {
    const list = Array.from({ length: 16 }, (_, i) => makeCamera(`cam${String(i + 1).padStart(2, '0')}`));
    const { hub, workers } = setup({ cameras: list });
    hub.init();
    hub.start();
    expect(workers.size).toBe(16);
    expect([...workers.values()].every((w) => w.start.mock.calls.length === 1)).toBe(true);
  });

  test('нет камер — init возвращает false', () => {
    const { hub } = setup({ cameras: [] });
    expect(hub.init()).toBe(false);
  });
});

describe('videoHub: доставка кадров', () => {
  test('без подписки — миниатюры всех доступных камер (прежнее поведение)', () => {
    const { hub, connect, frame } = setup();
    hub.init();
    const ws = connect('c1');
    frame('cam01');
    frame('cam02');
    expect(frames(ws)).toEqual(['cam01', 'cam02']);
    const msg = JSON.parse(ws.send.mock.calls[0][0]);
    expect(msg).toMatchObject({ type: 'post', request: 'videoSnapshot', name: 'd1' });
    expect(msg.payload).toMatchObject({ cameraId: 'cam01', title: 'Камера cam01', mimeType: 'image/jpeg', size: 1000 });
  });

  test('миниатюра — не чаще previewIntervalMs, полный экран — не чаще fullIntervalMs', () => {
    const { hub, connect, frame, advance } = setup();
    hub.init();
    const ws = connect('c1');
    hub.subscribe('c1', { dID: 'd1', level: 1 }, { cameras: ['cam01'], full: 'cam02' });
    for (let i = 0; i < 10; i++) { // 10 с, кадр каждую секунду
      frame('cam01');
      frame('cam02');
      advance(1000);
    }
    const got = frames(ws);
    expect(got.filter((id) => id === 'cam01')).toHaveLength(2);
    expect(got.filter((id) => id === 'cam02')).toHaveLength(10);
  });

  test('подписка пустым списком — кадров нет; чужие и неизвестные камеры отбрасываются', () => {
    const { hub, connect, frame } = setup({ cameras: [makeCamera('cam01'), makeCamera('other', { dID: 'd2' })] });
    hub.init();
    const ws = connect('c1');
    expect(hub.subscribe('c1', { dID: 'd1', level: 1 }, { cameras: ['cam01', 'other', 'nope', 5], full: 'other' }))
      .toEqual({ cameras: ['cam01'], full: null });
    hub.subscribe('c1', { dID: 'd1', level: 1 }, { cameras: [] });
    frame('cam01');
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('камеру видят только сессии с её dID и уровнем >= minLevel', () => {
    const { hub, connect, frame } = setup({ cameras: [makeCamera('cam01', { minLevel: 2 })] });
    hub.init();
    const low = connect('low', 'd1', 1);
    const ok = connect('ok', 'd1', 2);
    const other = connect('other', 'd2', 3);
    frame('cam01');
    expect(low.send).not.toHaveBeenCalled();
    expect(other.send).not.toHaveBeenCalled();
    expect(ok.send).toHaveBeenCalledTimes(1);
  });

  test('соединение без сессии кадров не получает', () => {
    const { hub, connect, frame, sessions } = setup();
    hub.init();
    const ws = connect('c1');
    delete sessions.c1;
    frame('cam01');
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('кадр сериализуется один раз на всех получателей', () => {
    const { hub, connect, frame } = setup();
    hub.init();
    const a = connect('a');
    const b = connect('b');
    frame('cam01');
    expect(a.send.mock.calls[0][0]).toBe(b.send.mock.calls[0][0]);
  });

  test('медленному клиенту кадр пропускается и учитывается в статистике', () => {
    const { hub, connect, frame } = setup();
    hub.init();
    const ws = connect('c1');
    ws.bufferedAmount = 5 * 1024 * 1024;
    frame('cam01');
    expect(ws.send).not.toHaveBeenCalled();
    expect(hub.getStats().cameras[0].skippedSlow).toBe(1);
  });

  test('при подписке последний кадр новой камеры приходит сразу', () => {
    const { hub, connect, frame } = setup();
    hub.init();
    const ws = connect('c1');
    hub.subscribe('c1', { dID: 'd1', level: 1 }, { cameras: [] });
    frame('cam02');
    expect(ws.send).not.toHaveBeenCalled();
    hub.subscribe('c1', { dID: 'd1', level: 1 }, { cameras: ['cam02'] });
    expect(frames(ws)).toEqual(['cam02']);
  });

  test('unsubscribe при закрытии соединения: следующее соединение начинает с прежнего поведения', () => {
    const { hub, connect, frame } = setup();
    hub.init();
    connect('c1');
    hub.subscribe('c1', { dID: 'd1', level: 1 }, { cameras: [] });
    hub.unsubscribe('c1');
    const ws = connect('c1');
    frame('cam01');
    expect(frames(ws)).toEqual(['cam01']);
  });
});

describe('videoHub: запросы', () => {
  test('listCameras — только доступные, со статусом', () => {
    const { hub, frame } = setup({ cameras: [makeCamera('cam01'), makeCamera('x', { dID: 'd2' })] });
    hub.init();
    const session = { dID: 'd1', level: 1 };
    expect(hub.listCameras(session)).toEqual([expect.objectContaining({ id: 'cam01', status: 'starting', lastFrameAt: null })]);
    frame('cam01');
    expect(hub.listCameras(session)[0].status).toBe('online');
  });

  test('getLastSnapshot по cameraId и без него (первая доступная)', () => {
    const { hub, frame } = setup();
    hub.init();
    const session = { dID: 'd1', level: 1 };
    expect(hub.getLastSnapshot(session, 'cam02')).toBeNull();
    frame('cam02');
    expect(hub.getLastSnapshot(session, 'cam02')).toMatchObject({ cameraId: 'cam02', size: 1000 });
    expect(hub.getLastSnapshot({ dID: 'd2', level: 3 }, 'cam02')).toBeNull();
    frame('cam01');
    expect(hub.getLastSnapshot(session)).toMatchObject({ cameraId: 'cam01' });
  });

  test('getStats — по камерам: кадры, байты, отправки', () => {
    const { hub, connect, frame } = setup();
    hub.init();
    connect('c1');
    frame('cam01', 2000);
    const cam = hub.getStats().cameras.find((c) => c.id === 'cam01');
    expect(cam).toMatchObject({ framesCaptured: 1, framesSent: 1, lastFrameBytes: 2000 });
    expect(cam.bytesSent).toBeGreaterThan(2000);
  });
});

describe('videoHub: перечитывание cameras.json', () => {
  function reloadable() {
    let current = { file: 'cameras.json', cameras: [makeCamera('cam01'), makeCamera('cam02')], errors: [], legacy: false };
    const ctx = setup({ list: () => current });
    ctx.set = (next) => { current = { file: 'cameras.json', errors: [], legacy: false, ...next }; };
    return ctx;
  }

  test('муляж заменён реальной камерой: только она перезапускается, клиент получает новый список', async () => {
    const { hub, workers, connect, set } = reloadable();
    hub.init();
    hub.start();
    const ws = connect('c1');
    const old01 = workers.get('cam01');
    const old02 = workers.get('cam02');
    set({ cameras: [makeCamera('cam01', { source: 'rtsp://u:p@h/s', title: 'Ворота' }), makeCamera('cam02')] });
    expect(await hub.reload()).toBe(true);
    expect(old01.stop).toHaveBeenCalled();
    expect(old02.stop).not.toHaveBeenCalled();
    const fresh = workers.get('cam01');
    expect(fresh).not.toBe(old01);
    expect(fresh.config).toMatchObject({ source: 'rtsp://u:p@h/s', rtspUrl: 'rtsp://u:p@h/s' });
    expect(fresh.start).toHaveBeenCalled();
    const msg = JSON.parse(ws.send.mock.calls.at(-1)[0]);
    expect(msg).toMatchObject({ type: 'response', request: 'videoCameras', name: 'd1' });
    expect(msg.payload.cameras.map((c) => c.title)).toEqual(['Ворота', 'Камера cam02']);
  });

  test('добавление и удаление камер; удалённая исчезает из подписок', async () => {
    const { hub, workers, connect, sessions, set } = reloadable();
    hub.init();
    connect('c1');
    hub.subscribe('c1', sessions.c1, { cameras: ['cam01', 'cam02'], full: 'cam02' });
    const old02 = workers.get('cam02');
    set({ cameras: [makeCamera('cam01'), makeCamera('cam03')] });
    await hub.reload();
    expect(old02.stop).toHaveBeenCalled();
    expect(hub.listCameras(sessions.c1).map((c) => c.id)).toEqual(['cam01', 'cam03']);
    expect(hub.subscribe('c1', sessions.c1, { cameras: ['cam01', 'cam02', 'cam03'] }).cameras).toEqual(['cam01', 'cam03']);
  });

  test('без изменений — ничего не перезапускается и не рассылается', async () => {
    const { hub, workers, connect } = reloadable();
    hub.init();
    const ws = connect('c1');
    expect(await hub.reload()).toBe(false);
    expect(workers.get('cam01').stop).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('битый файл при правке — камеры работают как были', async () => {
    const { hub, workers, sessions, connect, set } = reloadable();
    hub.init();
    connect('c1');
    set({ cameras: [], errors: ['cameras.json: Unexpected token'], invalid: true });
    expect(await hub.reload()).toBe(false);
    expect(workers.get('cam01').stop).not.toHaveBeenCalled();
    expect(hub.listCameras(sessions.c1)).toHaveLength(2);
  });

  test('watch следит за файлом, stop снимает слежение', async () => {
    const watchFile = jest.fn();
    const unwatchFile = jest.fn();
    const hub = createVideoHub({
      wsManager: { VUE_connections: new Map(), getUserConnections: () => [] },
      auth: { getSession: () => null },
      createWorker: () => ({ init: () => true, start: jest.fn(), stop: jest.fn(async () => {}), getStats: () => ({}) }),
      loadConfig: () => ({ tmpDir: '/tmp/v' }),
      loadCameraList: () => ({ file: '/data/cameras.json', cameras: [], errors: [], legacy: false }),
      checkFfmpeg: () => null, watchFile, unwatchFile,
    });
    hub.init();
    hub.watch();
    expect(watchFile).toHaveBeenCalledWith('/data/cameras.json', expect.any(Object), expect.any(Function));
    await hub.stop();
    expect(unwatchFile).toHaveBeenCalledWith('/data/cameras.json');
  });

  test('ffmpeg не найден — ошибка в логе один раз, камеры создаются', () => {
    const checkFfmpeg = jest.fn(() => 'ffmpeg не найден');
    const hub = createVideoHub({
      wsManager: { VUE_connections: new Map(), getUserConnections: () => [] },
      auth: { getSession: () => null },
      createWorker: () => ({ init: () => true, start: jest.fn(), stop: jest.fn(async () => {}), getStats: () => ({}) }),
      loadConfig: () => ({ tmpDir: '/tmp/v', ffmpegPath: 'ffmpeg' }),
      loadCameraList: () => ({ file: 'c.json', cameras: [makeCamera('cam01')], errors: [], legacy: false }),
      checkFfmpeg, watchFile: jest.fn(), unwatchFile: jest.fn(),
    });
    expect(hub.init()).toBe(true);
    hub.reload();
    expect(checkFfmpeg).toHaveBeenCalledTimes(1);
  });
});

describe('videoHub: dID камеры — список и "*"', () => {
  test('"*" — кадры всем пользователям, name — dID получателя, уровень учитывается', () => {
    const { hub, connect, frame } = setup({ cameras: [makeCamera('cam01', { dID: '*', dIDs: ['*'], minLevel: 2 })] });
    hub.init();
    const a = connect('a', 'igumen', 2);
    const b = connect('b', 'poddy_base', 3);
    const low = connect('low', 'igumen', 1);
    frame('cam01');
    expect(JSON.parse(a.send.mock.calls[0][0]).name).toBe('igumen');
    expect(JSON.parse(b.send.mock.calls[0][0]).name).toBe('poddy_base');
    expect(low.send).not.toHaveBeenCalled();
  });

  test('список dID — видят только перечисленные', () => {
    const { hub, connect, frame, sessions } = setup({ cameras: [makeCamera('cam01', { dID: 'd1,d2', dIDs: ['d1', 'd2'] })] });
    hub.init();
    const a = connect('a', 'd1');
    const b = connect('b', 'd2');
    const c = connect('c', 'd3');
    frame('cam01');
    expect(a.send).toHaveBeenCalledTimes(1);
    expect(b.send).toHaveBeenCalledTimes(1);
    expect(c.send).not.toHaveBeenCalled();
    expect(hub.listCameras(sessions.c)).toEqual([]);
    expect(hub.listCameras(sessions.b).map((x) => x.id)).toEqual(['cam01']);
  });
});
