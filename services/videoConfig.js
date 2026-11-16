// services/videoConfig.js
// Настройки сервиса видеонаблюдения. Читаются в момент вызова, чтобы тесты могли подменять env.
// authConfig подключается первым: он загружает conf.env.
'use strict';

require('./authConfig');

function loadVideoConfig(env = process.env) {
  const int = (v, d, min = 0) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= min ? n : d;
  };
  const bool = (v, d) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');

  return {
    enabled: bool(env.VIDEO_ENABLED, true),
    rtspUrl: env.VIDEO_RTSP_URL || '',

    // dID, которому принадлежит камера, и минимальный уровень пользователя для просмотра
    dID: env.VIDEO_DID || env.DEFAULT_USER_DID || 'poddy_base',
    minLevel: int(env.VIDEO_MIN_LEVEL, 1, 1),

    snapshotInterval: int(env.VIDEO_SNAPSHOT_INTERVAL_MS, 5000, 500),
    snapshotQuality: Math.min(31, int(env.VIDEO_SNAPSHOT_QUALITY, 3, 2)),
    snapshotMaxWidth: int(env.VIDEO_SNAPSHOT_MAX_WIDTH, 0, 0),
    decodeKeyframesOnly: bool(env.VIDEO_DECODE_KEYFRAMES_ONLY, false),

    segmentDuration: int(env.VIDEO_SEGMENT_DURATION_SEC, 600, 10),
    fragmentedMp4: bool(env.VIDEO_FRAGMENTED_MP4, true),
    tmpDir: env.VIDEO_TMP_DIR || './tmp/video',
    tmpMaxMb: int(env.VIDEO_TMP_MAX_MB, 2048, 0),

    uploadIntervalSec: int(env.VIDEO_UPLOAD_INTERVAL_SEC, 300, 10),
    uploadMinAgeSec: int(env.VIDEO_UPLOAD_MIN_AGE_SEC, 30, 5),
    watchdogSec: int(env.VIDEO_WATCHDOG_SEC, 60, 10),

    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    ffmpegExtraArgs: env.FFMPEG_EXTRA_ARGS || '',

    s3Prefix: env.MTS_S3_PREFIX || 'video-archive',
    s3: {
      endpoint: env.MTS_S3_ENDPOINT || '',
      region: env.MTS_S3_REGION || 'ru-central-1',
      bucket: env.MTS_S3_BUCKET || '',
      accessKeyId: env.MTS_S3_ACCESS_KEY_ID || '',
      secretAccessKey: env.MTS_S3_SECRET_ACCESS_KEY || '',
      forcePathStyle: bool(env.MTS_S3_FORCE_PATH_STYLE, true),
    },
  };
}

// ── Список камер ─────────────────────────────────────────────────────────
// Файл VIDEO_CAMERAS_FILE (по умолчанию $DATA_DIR/cameras.json, образец — cameras.example.json):
//   { "defaults": { ...общие поля камер... },
//     "cameras": [ { "id": "cam01", "title": "Ворота", "source": "rtsp://user:pass@host/stream" },
//                  { "id": "test01", "title": "Тест", "source": "test" } ] }
// Поля камеры (значение по умолчанию — из defaults, затем из conf.env):
//   id                — ^[A-Za-z0-9_-]{1,32}$, уникальный
//   title             — подпись в интерфейсе (до 64 символов), по умолчанию id
//   source            — rtsp(s)://… или "test" (ffmpeg генерирует тестовую картинку — эмуляция камеры)
//   dID, minLevel     — кто видит камеру: сессии с этим dID и уровнем >= minLevel
//   enabled           — false — камера не запускается
//   previewIntervalMs — частота кадров в миниатюрах (>= 500, по умолчанию VIDEO_SNAPSHOT_INTERVAL_MS)
//   fullIntervalMs    — частота кадров на полном экране (>= 200, по умолчанию 1000); ffmpeg кодирует
//                       кадры с этой частотой, миниатюрам сервер отдаёт реже
//   maxWidth, quality — ширина (0 — без масштабирования) и качество JPEG (2 — лучшее … 31)
//   archive           — true — запись сегментов MP4 и выгрузка в S3 (по умолчанию false)
//   test              — для source "test": { size: "1280x720", rate: 10, noise: 20 }
// Нет файла:
//   задан VIDEO_RTSP_URL → одна камера из него (прежний режим);
//   иначе → файл создаётся с VIDEO_MOCK_CAMERAS муляжами (source "test", по умолчанию 4; 0 — не создавать).
//   Муляж заменяется реальной камерой правкой "source" (и "title") в файле — сервер подхватит без перезапуска.
const MAX_CAMERAS = 16;
const CAMERA_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const SIZE_RE = /^\d{2,4}x\d{2,4}$/;

function camerasFilePath(env = process.env) {
  const path = require('path');
  return env.VIDEO_CAMERAS_FILE || path.join(env.DATA_DIR || '.configData', 'cameras.json');
}

// Содержимое cameras.json с муляжами — первый запуск без камер
function mockCamerasConfig(base, count) {
  return {
    defaults: {
      dID: base.dID,
      minLevel: base.minLevel,
      previewIntervalMs: base.snapshotInterval,
      fullIntervalMs: 1000,
      maxWidth: 640,
      quality: 5,
      archive: false,
    },
    cameras: Array.from({ length: count }, (_, i) => ({
      id: `cam${String(i + 1).padStart(2, '0')}`,
      title: `Камера ${i + 1} (муляж)`,
      source: 'test',
      test: { size: '1280x720', rate: 10, noise: 20 },
    })),
  };
}

function writeJsonFile(file, data) {
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' }); // не перезаписываем чужой файл
}

function mockCount(env) {
  if (env.VIDEO_MOCK_CAMERAS === undefined || env.VIDEO_MOCK_CAMERAS === '') return 4;
  const n = parseInt(env.VIDEO_MOCK_CAMERAS, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_CAMERAS, n)) : 4;
}

function loadCameras(env = process.env, {
  readFile = (f) => require('fs').readFileSync(f, 'utf8'),
  writeFile = writeJsonFile,
} = {}) {
  const { isValidDID } = require('./authConfig');
  const base = loadVideoConfig(env);
  const file = camerasFilePath(env);
  const errors = [];

  let raw;
  try {
    raw = JSON.parse(readFile(file));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      errors.push(`${file}: ${e.message}`);
      return { file, cameras: [], errors, legacy: false, invalid: true };
    }
    if (base.rtspUrl) {
      raw = { cameras: [{ id: 'cam1', title: 'Камера 1', source: base.rtspUrl, archive: true }] };
      return { file, ...normalizeCameras(raw, base, isValidDID, errors), errors, legacy: true };
    }
    const count = mockCount(env);
    if (count === 0) return { file, cameras: [], errors, legacy: false };
    raw = mockCamerasConfig(base, count);
    let created = true;
    try {
      writeFile(file, raw);
    } catch (we) {
      created = false; // муляжи работают и без файла; править будет нечего — сообщаем
      errors.push(`не удалось создать ${file}: ${we.message} (муляжи только в памяти)`);
    }
    return { file, ...normalizeCameras(raw, base, isValidDID, errors), errors, legacy: false, created };
  }
  return { file, ...normalizeCameras(raw, base, isValidDID, errors), errors, legacy: false };
}

function normalizeCameras(raw, base, isValidDID, errors) {
  const int = (v, d, min, max = Infinity) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : d;
  };
  const defaults = raw && typeof raw.defaults === 'object' && raw.defaults ? raw.defaults : {};
  const list = Array.isArray(raw && raw.cameras) ? raw.cameras : [];
  if (!Array.isArray(raw && raw.cameras)) errors.push('нет массива "cameras"');

  const cameras = [];
  const ids = new Set();
  list.forEach((item, i) => {
    const c = { ...defaults, ...(item && typeof item === 'object' ? item : {}) };
    const fail = (msg) => errors.push(`камера #${i + 1}${c.id ? ` (${c.id})` : ''}: ${msg}`);

    if (!CAMERA_ID_RE.test(String(c.id || ''))) return fail('id — латиница, цифры, _ и -, до 32 символов');
    if (ids.has(c.id)) return fail('повторяющийся id');
    if (c.enabled === false) return;

    const source = String(c.source || '');
    if (source !== 'test' && !/^rtsps?:\/\/\S+$/.test(source)) return fail('source — rtsp(s)://… или "test"');
    const dID = c.dID ?? base.dID;
    if (!isValidDID(dID)) return fail(`недопустимый dID "${dID}"`);
    if (cameras.length >= MAX_CAMERAS) return fail(`больше ${MAX_CAMERAS} камер — пропущена`);

    const test = { size: '1280x720', rate: 10, noise: 20, ...(typeof c.test === 'object' && c.test ? c.test : {}) };
    ids.add(c.id);
    cameras.push({
      id: c.id,
      title: String(c.title || c.id).slice(0, 64),
      source,
      dID,
      minLevel: int(c.minLevel, base.minLevel, 1, 3),
      previewIntervalMs: int(c.previewIntervalMs, base.snapshotInterval, 500),
      fullIntervalMs: int(c.fullIntervalMs, 1000, 200),
      maxWidth: int(c.maxWidth, base.snapshotMaxWidth || 640, 0, 4096),
      quality: int(c.quality, base.snapshotQuality, 2, 31),
      archive: c.archive === true,
      test: {
        size: SIZE_RE.test(String(test.size)) ? String(test.size) : '1280x720',
        rate: int(test.rate, 10, 1, 60),
        noise: int(test.noise, 20, 0, 100),
      },
    });
  });
  if (cameras.length === 0 && list.length > 0) errors.push('нет ни одной корректной камеры');
  return { cameras };
}

module.exports = { loadVideoConfig, loadCameras, camerasFilePath, mockCamerasConfig, MAX_CAMERAS };
