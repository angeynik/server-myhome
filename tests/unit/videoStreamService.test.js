const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const logger = require('../services/logger');
const {
  createVideoStreamService, createFrameParser, maskUrl,
} = require('../services/videoStreamService');
const { loadVideoConfig } = require('../services/videoConfig');

const jpeg = (n = 10) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(n, 1), Buffer.from([0xff, 0xd9])]);

function makeProc() {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.autoClose = true;
  p.kill = jest.fn((sig) => {
    if (p.autoClose || sig === 'SIGKILL') Promise.resolve().then(() => p.emit('close', null, sig));
    return true;
  });
  return p;
}

function baseConfig(extra = {}) {
  return {
    rtspUrl: 'rtsp://user:secret@cam/stream',
    dID: 'cam1',
    minLevel: 2,
    snapshotInterval: 5000,
    snapshotQuality: 3,
    snapshotMaxWidth: 0,
    decodeKeyframesOnly: false,
    segmentDuration: 600,
    fragmentedMp4: true,
    tmpDir: path.join(os.tmpdir(), `video-test-${process.pid}-${Math.random().toString(36).slice(2)}`),
    tmpMaxMb: 0,
    uploadIntervalSec: 300,
    uploadMinAgeSec: 30,
    watchdogSec: 60,
    ffmpegPath: 'ffmpeg',
    ffmpegExtraArgs: '',
    s3Prefix: 'video-archive',
    s3: { endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '', region: 'r', forcePathStyle: true },
    ...extra,
  };
}

const s3Config = { endpoint: 'http://s3', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', region: 'r', forcePathStyle: true };

class FakeUpload {
  constructor({ params }) {
    this.params = params;
    FakeUpload.calls.push(params);
  }
  async done() {
    if (FakeUpload.fail) throw new Error('s3 down');
    // eslint-disable-next-line no-unused-vars
    for await (const _chunk of this.params.Body) { /* читаем файл целиком */ }
  }
}
FakeUpload.calls = [];
FakeUpload.fail = false;

function makeService({ procs = [], time = { t: Date.now() }, sessions = {}, connections = [], withS3 = false, cfg = {} } = {}) {
  const spawn = jest.fn(() => {
    const p = makeProc();
    procs.push(p);
    return p;
  });
  const wsManager = { getUserConnections: jest.fn(() => connections) };
  const auth = { getSession: jest.fn((id) => sessions[id] || null) };
  const service = createVideoStreamService({
    spawn,
    wsManager,
    auth,
    loadS3: () => ({ S3Client: class { constructor(o) { this.o = o; } }, Upload: FakeUpload }),
    now: () => time.t,
  });
  const config = baseConfig({ ...(withS3 ? { s3: s3Config } : {}), ...cfg });
  return { service, spawn, procs, time, config, wsManager, auth };
}

const wsConn = (id, extra = {}) => ({ clientId: id, connection: { ws: { readyState: 1, bufferedAmount: 0, send: jest.fn(), ...extra } } });

const cleanups = [];
afterEach(async () => {
  jest.useRealTimers();
  while (cleanups.length) await cleanups.pop()();
  FakeUpload.calls = [];
  FakeUpload.fail = false;
});

function track(env) {
  cleanups.push(async () => {
    await env.service.stop();
    fs.rmSync(env.config.tmpDir, { recursive: true, force: true });
  });
  return env;
}

describe('createFrameParser', () => {
  test('режет кадры, склеенные и разорванные между чанками', () => {
    const frames = [];
    const parse = createFrameParser((f) => frames.push(f));
    const stream = Buffer.concat([jpeg(5), jpeg(7), jpeg(9)]);
    for (let i = 0; i < stream.length; i += 4) parse(stream.subarray(i, i + 4));
    expect(frames.map((f) => f.length)).toEqual([9, 11, 13]);
    expect(frames.every((f) => f[0] === 0xff && f[1] === 0xd8 && f.at(-2) === 0xff && f.at(-1) === 0xd9)).toBe(true);
  });

  test('игнорирует мусор перед кадром', () => {
    const frames = [];
    createFrameParser((f) => frames.push(f))(Buffer.concat([Buffer.from([1, 2, 3, 0xff, 0x00]), jpeg(4)]));
    expect(frames).toHaveLength(1);
  });

  test('сбрасывает переполненный буфер без кадров', () => {
    const frames = [];
    const parse = createFrameParser((f) => frames.push(f));
    parse(Buffer.alloc(11 * 1024 * 1024, 7));
    parse(jpeg(3));
    expect(frames).toHaveLength(1);
  });
});

describe('videoConfig', () => {
  test('значения по умолчанию и границы', () => {
    const c = loadVideoConfig({ VIDEO_SNAPSHOT_INTERVAL_MS: '10', VIDEO_SNAPSHOT_QUALITY: '99', VIDEO_SEGMENT_DURATION_SEC: '1' });
    expect(c.snapshotInterval).toBe(5000);
    expect(c.snapshotQuality).toBe(31);
    expect(c.segmentDuration).toBe(600);
    expect(c.fragmentedMp4).toBe(true);
    expect(c.minLevel).toBe(1);
    expect(c.tmpMaxMb).toBe(2048);
  });

  test('dID камеры: VIDEO_DID, затем DEFAULT_USER_DID', () => {
    expect(loadVideoConfig({ VIDEO_DID: 'a', DEFAULT_USER_DID: 'b' }).dID).toBe('a');
    expect(loadVideoConfig({ DEFAULT_USER_DID: 'b' }).dID).toBe('b');
  });
});

describe('maskUrl', () => {
  test('маскирует пароль в rtsp и rtsps', () => {
    expect(maskUrl('rtsp://u:pa55@h/x')).toBe('rtsp://u:***@h/x');
    expect(maskUrl('open rtsps://u:pa55@h/x failed')).toBe('open rtsps://u:***@h/x failed');
  });
});

describe('init', () => {
  test('без RTSP сервис не запускается', () => {
    const { service } = makeService();
    expect(service.init(baseConfig({ rtspUrl: '' }))).toBe(false);
  });

  test('создаёт временную директорию', () => {
    const env = track(makeService());
    expect(env.service.init(env.config)).toBe(true);
    expect(fs.existsSync(env.config.tmpDir)).toBe(true);
    expect(env.service.getStats().s3Enabled).toBe(false);
  });

  test('S3 включается только при полной настройке', () => {
    const env = track(makeService({ withS3: true }));
    env.service.init(env.config);
    expect(env.service.getStats().s3Enabled).toBe(true);
  });
});

describe('buildFfmpegArgs', () => {
  const build = (cfg) => {
    const env = makeService({ cfg });
    env.service.init(env.config);
    cleanups.push(async () => fs.rmSync(env.config.tmpDir, { recursive: true, force: true }));
    return env.service.buildFfmpegArgs();
  };
  const after = (args, flag) => args[args.indexOf(flag) + 1];

  test('снимки прореживаются фильтром fps', () => {
    expect(after(build({ snapshotInterval: 2000 }), '-vf')).toBe('fps=1000/2000');
  });

  test('масштабирование добавляется после fps', () => {
    expect(after(build({ snapshotMaxWidth: 640 }), '-vf')).toBe("fps=1000/5000,scale='min(640,iw)':-2");
  });

  test('сегменты пишутся без перекодирования во фрагментированный mp4', () => {
    const args = build({});
    expect(args.join(' ')).toContain('-c:v copy');
    expect(after(args, '-segment_format_options')).toContain('empty_moov');
    expect(after(args, '-segment_time')).toBe('600');
    expect(args.at(-1)).toMatch(/video_%Y-%m-%d_%H-%M-%S\.mp4$/);
  });

  test('фрагментация и keyframes-only выключаются', () => {
    expect(build({ fragmentedMp4: false })).not.toContain('-segment_format_options');
    expect(build({ decodeKeyframesOnly: false })).not.toContain('-skip_frame');
    const args = build({ decodeKeyframesOnly: true });
    expect(args.indexOf('-skip_frame')).toBeLessThan(args.indexOf('-i'));
  });

  test('дополнительные аргументы идут до входа', () => {
    const args = build({ ffmpegExtraArgs: '-rtsp_flags prefer_tcp  -analyzeduration 1000000' });
    expect(args.indexOf('-rtsp_flags')).toBeLessThan(args.indexOf('-i'));
    expect(args).toContain('-analyzeduration');
  });
});

describe('снимки для Vue', () => {
  function setup(extra = {}) {
    const connections = [
      wsConn('ok'),
      wsConn('low'),
      wsConn('other'),
      wsConn('anon'),
      wsConn('closed', { readyState: 3 }),
      wsConn('slow', { bufferedAmount: 5 * 1024 * 1024 }),
    ];
    const env = track(makeService({
      connections,
      sessions: {
        ok: { dID: 'cam1', level: 2 },
        low: { dID: 'cam1', level: 1 },
        other: { dID: 'cam2', level: 3 },
        closed: { dID: 'cam1', level: 3 },
        slow: { dID: 'cam1', level: 3 },
      },
      ...extra,
    }));
    env.service.init(env.config);
    env.service.start();
    env.connections = connections;
    return env;
  }

  test('кадр получают только авторизованные сессии камеры с достаточным уровнем', () => {
    const env = setup();
    env.procs[0].stdout.emit('data', jpeg(20));

    const sentBy = (id) => env.connections.find((c) => c.clientId === id).connection.ws.send;
    expect(sentBy('ok')).toHaveBeenCalledTimes(1);
    for (const id of ['low', 'other', 'anon', 'closed', 'slow']) expect(sentBy(id)).not.toHaveBeenCalled();

    const msg = JSON.parse(sentBy('ok').mock.calls[0][0]);
    expect(msg).toMatchObject({ type: 'post', request: 'videoSnapshot', name: 'cam1' });
    expect(msg.payload).toMatchObject({ mimeType: 'image/jpeg', size: 24, timestamp: env.time.t });
    expect(Buffer.from(msg.payload.image, 'base64').equals(jpeg(20))).toBe(true);
    expect(env.service.getStats().stats.snapshotsSent).toBe(1);
  });

  test('медленный клиент пропускается и учитывается в статистике', () => {
    const env = setup({ sessions: { slow: { dID: 'cam1', level: 3 } } });
    env.procs[0].stdout.emit('data', jpeg());
    expect(env.service.getStats().stats.snapshotsSkippedSlow).toBe(1);
  });

  test('частота ограничена интервалом (с допуском 20%)', () => {
    const env = setup();
    const send = env.connections[0].connection.ws.send;
    env.procs[0].stdout.emit('data', jpeg());
    env.time.t += 1000;
    env.procs[0].stdout.emit('data', jpeg());
    expect(send).toHaveBeenCalledTimes(1);
    env.time.t += 3100;
    env.procs[0].stdout.emit('data', jpeg());
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('без зрителей кадр не кодируется в base64 и не отправляется, но запоминается', () => {
    const env = setup({ connections: [] });
    env.procs[0].stdout.emit('data', jpeg());
    expect(env.service.getStats().stats.snapshotsSent).toBe(0);
    expect(env.service.getLastSnapshot({ dID: 'cam1', level: 2 })).not.toBeNull();
  });

  test('getLastSnapshot проверяет dID и уровень', () => {
    const env = setup();
    expect(env.service.getLastSnapshot({ dID: 'cam1', level: 2 })).toBeNull();
    env.procs[0].stdout.emit('data', jpeg());
    expect(env.service.getLastSnapshot({ dID: 'cam1', level: 2 }).mimeType).toBe('image/jpeg');
    expect(env.service.getLastSnapshot({ dID: 'cam1', level: 1 })).toBeNull();
    expect(env.service.getLastSnapshot({ dID: 'cam2', level: 3 })).toBeNull();
    expect(env.service.getLastSnapshot(null)).toBeNull();
  });
});

describe('жизненный цикл ffmpeg', () => {
  function setup(cfg) {
    jest.useFakeTimers();
    const env = track(makeService({ cfg }));
    env.service.init(env.config);
    return env;
  }

  test('start идемпотентен', () => {
    const env = setup();
    env.service.start();
    env.service.start();
    expect(env.spawn).toHaveBeenCalledTimes(1);
    expect(env.service.getStats().isRunning).toBe(true);
  });

  test('после падения перезапуск с нарастающей паузой', async () => {
    const env = setup();
    env.service.start();
    env.procs[0].emit('close', 1, null);
    expect(env.spawn).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(4999);
    expect(env.spawn).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(2);
    expect(env.spawn).toHaveBeenCalledTimes(2);

    env.procs[1].emit('close', 1, null);
    jest.advanceTimersByTime(9000);
    expect(env.spawn).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1100);
    expect(env.spawn).toHaveBeenCalledTimes(3);
    expect(env.service.getStats().stats.ffmpegRestarts).toBe(2);
  });

  test('долгая стабильная работа сбрасывает паузу', () => {
    const env = setup();
    env.service.start();
    env.procs[0].emit('close', 1, null);
    jest.advanceTimersByTime(5100);
    env.time.t += 120000;
    env.procs[1].emit('close', 1, null);
    jest.advanceTimersByTime(5100);
    expect(env.spawn).toHaveBeenCalledTimes(3);
  });

  test('ошибка запуска (нет ffmpeg) тоже ведёт к перезапуску', () => {
    const env = setup();
    env.service.start();
    env.procs[0].emit('error', new Error('spawn ffmpeg ENOENT'));
    expect(env.service.getStats().isRunning).toBe(false);
    jest.advanceTimersByTime(5100);
    expect(env.spawn).toHaveBeenCalledTimes(2);
  });

  test('stop завершает ffmpeg и не перезапускает его', async () => {
    const env = setup();
    env.service.start();
    await env.service.stop();
    expect(env.procs[0].kill).toHaveBeenCalledWith('SIGTERM');
    jest.advanceTimersByTime(120000);
    expect(env.spawn).toHaveBeenCalledTimes(1);
    expect(env.service.getStats()).toMatchObject({ isRunning: false, shouldRun: false });
  });

  test('stop убивает зависший ffmpeg через SIGKILL', async () => {
    const env = setup();
    env.service.start();
    env.procs[0].autoClose = false;
    const stopped = env.service.stop();
    await Promise.resolve();
    jest.advanceTimersByTime(3100);
    await stopped;
    expect(env.procs[0].kill).toHaveBeenCalledWith('SIGKILL');
  });

  test('watchdog перезапускает ffmpeg, если кадры перестали приходить', async () => {
    const env = setup();
    env.service.start();
    env.procs[0].stdout.emit('data', jpeg());
    env.time.t += 30000;
    jest.advanceTimersByTime(10000);
    expect(env.procs[0].kill).not.toHaveBeenCalled();

    env.time.t += 61000;
    jest.advanceTimersByTime(10000);
    expect(env.procs[0].kill).toHaveBeenCalledWith('SIGKILL');
    expect(env.service.getStats().stats.watchdogKills).toBe(1);

    await Promise.resolve();
    jest.advanceTimersByTime(5100);
    expect(env.spawn).toHaveBeenCalledTimes(2);
  });

  test('stderr: пароль RTSP не попадает в лог', () => {
    const env = setup();
    const spy = jest.spyOn(logger, 'logErrorMessage').mockImplementation(() => {});
    env.service.start();
    env.procs[0].stderr.emit('data', Buffer.from('Error opening input rtsp://user:secret@cam/stream: failed'));
    const logged = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toContain('rtsp://user:***@cam');
    expect(logged).not.toContain('secret');
    spy.mockRestore();
  });
});

describe('архив: выгрузка в S3 и лимит диска', () => {
  const OLD = () => (Date.now() - 3600 * 1000) / 1000;

  function seed(env, files) {
    fs.mkdirSync(env.config.tmpDir, { recursive: true });
    for (const [name, { size = 100, age = OLD() } = {}] of Object.entries(files)) {
      const p = path.join(env.config.tmpDir, name);
      fs.writeFileSync(p, Buffer.alloc(size, 1));
      fs.utimesSync(p, age, age);
    }
  }

  const left = (env) => fs.readdirSync(env.config.tmpDir).sort();

  function setup(opts = {}) {
    const env = track(makeService({ withS3: true, ...opts }));
    env.service.init(env.config);
    return env;
  }

  test('загружает старые файлы в ключ prefix/дата/имя и удаляет их', async () => {
    const env = setup();
    seed(env, { 'video_2026-11-09_10-00-00.mp4': {}, 'note.txt': {} });
    const res = await env.service.uploadAndCleanupSegments();

    expect(res).toMatchObject({ uploaded: 1, failed: 0 });
    expect(FakeUpload.calls[0]).toMatchObject({
      Bucket: 'b', Key: 'video-archive/2026-11-09/video_2026-11-09_10-00-00.mp4', ContentType: 'video/mp4',
    });
    expect(left(env)).toEqual(['note.txt']);
    expect(env.service.getStats().stats).toMatchObject({ filesUploaded: 1, bytesUploaded: 100 });
  });

  test('свежие файлы (моложе uploadMinAgeSec) не трогаются', async () => {
    const env = setup();
    seed(env, { 'video_2026-11-09_10-00-00.mp4': { age: Date.now() / 1000 - 5 } });
    expect((await env.service.uploadAndCleanupSegments()).skipped).toBe(1);
    expect(FakeUpload.calls).toHaveLength(0);
  });

  test('файл, который сейчас пишет ffmpeg (новейший по имени), пропускается', async () => {
    const env = setup();
    env.service.start();
    seed(env, { 'video_2026-11-09_10-00-00.mp4': {}, 'video_2026-11-09_10-10-00.mp4': {} });
    const res = await env.service.uploadAndCleanupSegments();
    expect(res.uploaded).toBe(1);
    expect(left(env)).toEqual(['video_2026-11-09_10-10-00.mp4']);
  });

  test('при ошибке S3 файл остаётся на диске', async () => {
    const env = setup();
    FakeUpload.fail = true;
    seed(env, { 'video_2026-11-09_10-00-00.mp4': {} });
    const res = await env.service.uploadAndCleanupSegments();
    expect(res).toMatchObject({ uploaded: 0, failed: 1 });
    expect(left(env)).toHaveLength(1);
    expect(env.service.getStats().stats.filesFailed).toBe(1);
  });

  test('пустые файлы удаляются без загрузки', async () => {
    const env = setup();
    seed(env, { 'video_2026-11-09_10-00-00.mp4': { size: 0 } });
    await env.service.uploadAndCleanupSegments();
    expect(FakeUpload.calls).toHaveLength(0);
    expect(left(env)).toEqual([]);
  });

  test('параллельный запуск не дублирует загрузку', async () => {
    const env = setup();
    seed(env, { 'video_2026-11-09_10-00-00.mp4': {} });
    const [a, b] = await Promise.all([env.service.uploadAndCleanupSegments(), env.service.uploadAndCleanupSegments()]);
    expect(a.uploaded + b.uploaded).toBe(1);
    expect(FakeUpload.calls).toHaveLength(1);
  });

  test('лимит диска удаляет самые старые файлы, но не активный', async () => {
    const env = setup({ cfg: { tmpMaxMb: 1, s3: { ...s3Config, endpoint: '' } } });
    const mb = 1024 * 1024;
    env.service.start();
    seed(env, {
      'video_2026-11-09_10-00-00.mp4': { size: mb },
      'video_2026-11-09_10-10-00.mp4': { size: mb },
      'video_2026-11-09_10-20-00.mp4': { size: mb },
    });
    const res = await env.service.uploadAndCleanupSegments();
    expect(res.evicted).toBe(2);
    expect(left(env)).toEqual(['video_2026-11-09_10-20-00.mp4']);
    expect(env.service.getStats().stats.filesEvicted).toBe(2);
  });

  test('без S3 архив не растёт бесконечно (лимит работает)', async () => {
    const env = track(makeService({ cfg: { tmpMaxMb: 1 } }));
    env.service.init(env.config);
    const mb = 1024 * 1024;
    seed(env, { 'video_2026-11-09_10-00-00.mp4': { size: mb }, 'video_2026-11-09_10-10-00.mp4': { size: mb } });
    await env.service.uploadAndCleanupSegments();
    expect(left(env)).toEqual(['video_2026-11-09_10-10-00.mp4']);
    expect(FakeUpload.calls).toHaveLength(0);
  });
});

describe('защита от осиротевшего ffmpeg', () => {
  const { spawn: realSpawn } = require('child_process');

  test('при старте останавливается ffmpeg из pid-файла прошлого запуска', async () => {
    const env = track(makeService());
    env.service.init(env.config);
    const stale = realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', '--', env.config.tmpDir], { stdio: 'ignore' });
    const closed = new Promise((resolve) => stale.on('close', (code, signal) => resolve(signal)));
    fs.writeFileSync(path.join(env.config.tmpDir, 'ffmpeg.pid'), String(stale.pid));
    await new Promise((r) => setTimeout(r, 150));

    env.service.start();
    expect(await closed).toBe('SIGTERM');
    expect(fs.existsSync(path.join(env.config.tmpDir, 'ffmpeg.pid'))).toBe(false);
  });

  test('чужой процесс с тем же pid не трогается (cmdline не содержит tmpDir)', async () => {
    const env = track(makeService());
    env.service.init(env.config);
    const other = realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(env.config.tmpDir, 'ffmpeg.pid'), String(other.pid));
    await new Promise((r) => setTimeout(r, 150));

    env.service.start();
    await new Promise((r) => setTimeout(r, 150));
    expect(other.exitCode).toBeNull();
    expect(other.signalCode).toBeNull();
    other.kill('SIGKILL');
  });

  test('pid-файл пишется при запуске и удаляется при завершении', () => {
    const env = track(makeService());
    env.service.init(env.config);
    env.spawn.mockImplementationOnce(() => {
      const p = makeProc();
      p.pid = 424242;
      env.procs.push(p);
      return p;
    });
    env.service.start();
    const file = path.join(env.config.tmpDir, 'ffmpeg.pid');
    expect(fs.readFileSync(file, 'utf8')).toBe('424242');
    env.procs[0].emit('close', 0, null);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('хук exit регистрируется на start и снимается на stop', async () => {
    const before = process.listenerCount('exit');
    const env = track(makeService());
    env.service.init(env.config);
    env.service.start();
    expect(process.listenerCount('exit')).toBe(before + 1);
    await env.service.stop();
    expect(process.listenerCount('exit')).toBe(before);
  });
});
