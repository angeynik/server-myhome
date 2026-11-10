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

module.exports = { loadVideoConfig };
