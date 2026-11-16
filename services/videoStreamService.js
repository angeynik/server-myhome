// services/videoStreamService.js
// Видеонаблюдение: одна камера (RTSP-регистратор или тестовый источник) → ffmpeg →
// снимки для Vue и архив сегментов в S3. Несколько камер (1–16) собирает services/videoHub.js:
// он создаёт этот сервис на каждую камеру и сам доставляет кадры (опция deliver).
//
// Один процесс ffmpeg, до двух выходов:
//   1) MJPEG в stdout, не чаще одного кадра за snapshotInterval (фильтр fps) — снимки для Vue;
//   2) сегменты MP4 без перекодирования (-c:v copy) в tmpDir — архив для выгрузки в S3
//      (только при config.archive !== false; для source "test" архива нет).
// Источник "test" (config.source): ffmpeg сам генерирует картинку (lavfi testsrc2 + сдвиг оттенка
// по камере + шум, чтобы размер JPEG был ближе к реальному кадру) — эмуляция камеры без устройства.
//
// Доступ: снимки получают только авторизованные VUE-сессии с dID камеры (VIDEO_DID)
// и уровнем не ниже VIDEO_MIN_LEVEL.
// Локальный архив ограничен по размеру (VIDEO_TMP_MAX_MB): самые старые файлы удаляются первыми.
'use strict';

const { spawn: nodeSpawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const logger = require('./logger.js');
logger.initLogging();
const { loadVideoConfig } = require('./videoConfig.js');

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
const MAX_FRAME_BUFFER = 10 * 1024 * 1024;
const MAX_WS_BUFFERED = 1024 * 1024;
const WS_OPEN = 1;
const RESTART_MIN_MS = 5000;
const RESTART_MAX_MS = 60000;
const STABLE_UPTIME_MS = 60000;
const FIRST_UPLOAD_DELAY_MS = 15000;
const STOP_TIMEOUT_MS = 3000;
const WATCHDOG_CHECK_MS = 10000;

const maskUrl = (text) => String(text).replace(/(rtsps?:\/\/[^:/@\s]+:)[^@\s]*(@)/g, '$1***$2');

function defaultLoadS3() {
  const { S3Client } = require('@aws-sdk/client-s3');
  const { Upload } = require('@aws-sdk/lib-storage');
  return { S3Client, Upload };
}

// Режет MJPEG-поток на отдельные JPEG-кадры (SOI FFD8 … EOI FFD9).
function createFrameParser(onFrame) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;

    if (buffer.length > MAX_FRAME_BUFFER) {
      const last = buffer.lastIndexOf(JPEG_SOI);
      buffer = last > 0 ? buffer.subarray(last) : Buffer.alloc(0);
    }

    let soi = buffer.indexOf(JPEG_SOI);
    while (soi !== -1) {
      const eoi = buffer.indexOf(JPEG_EOI, soi + 2);
      if (eoi === -1) {
        buffer = buffer.subarray(soi);
        return;
      }
      onFrame(Buffer.from(buffer.subarray(soi, eoi + 2)));
      buffer = buffer.subarray(eoi + 2);
      soi = buffer.indexOf(JPEG_SOI);
    }
    // маркер SOI мог разорваться между чанками: оставляем последний байт
    buffer = buffer.length ? Buffer.from(buffer.subarray(buffer.length - 1)) : buffer;
  };
}

function createVideoStreamService({
  spawn = nodeSpawn,
  wsManager = require('../classes/wsManager.js'),
  auth = require('./auth.js'),
  loadS3 = defaultLoadS3,
  loadConfig = loadVideoConfig,
  now = Date.now,
  deliver = null, // (frame: { jpeg, timestamp }) => void — кадры доставляет videoHub, а не этот сервис
} = {}) {
  let config = {};
  let s3 = null;
  let UploadClass = null;

  let proc = null;
  let shouldRun = false;
  let running = false;
  let procStartedAt = 0;
  let lastFrameAt = 0;
  let lastSentAt = 0;
  let lastFrame = null;
  let restartDelay = RESTART_MIN_MS;

  let restartTimer = null;
  let watchdogTimer = null;
  let uploadTimer = null;
  let firstUploadTimer = null;
  let uploadRunning = false;
  let exitHook = null;

  const stats = {
    snapshotsSent: 0,
    snapshotsSkippedSlow: 0,
    filesUploaded: 0,
    filesFailed: 0,
    filesEvicted: 0,
    bytesUploaded: 0,
    ffmpegRestarts: 0,
    watchdogKills: 0,
    lastSnapshotAt: null,
    lastUploadAt: null,
    startedAt: null,
  };

  // ── Инициализация ───────────────────────────────────────────────────
  function init(overrideConfig) {
    config = overrideConfig || loadConfig();

    if (!config.rtspUrl && !isTestSource()) {
      logger.logInfoMessage(`${tag()} - init: VIDEO_RTSP_URL не задан, сервис не запускается`);
      return false;
    }

    s3 = null;
    const c = config.s3 || {};
    if (!archiveEnabled()) {
      // архив выключен — S3 не нужен
    } else if (c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey) {
      try {
        const sdk = loadS3();
        UploadClass = sdk.Upload;
        s3 = new sdk.S3Client({
          endpoint: c.endpoint,
          region: c.region,
          credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
          forcePathStyle: c.forcePathStyle,
        });
      } catch (e) {
        logger.logErrorMessage(`${tag()} - init: S3 недоступен: ${e.message}`);
        s3 = null;
      }
    } else {
      logger.logErrorMessage(`${tag()} - init: параметры MTS S3 не заданы, выгрузка отключена`);
    }

    try {
      fs.mkdirSync(config.tmpDir, { recursive: true });
    } catch (e) {
      logger.logErrorMessage(`${tag()} - init: не удалось создать ${config.tmpDir}: ${e.message}`);
      return false;
    }

    logger.logInfoMessage(
      `${tag()} - init: ${isTestSource() ? 'источник test' : `RTSP=${maskUrl(config.rtspUrl)}`}, dID=${config.dID}, ` +
      `уровень>=${config.minLevel}, снимок раз в ${config.snapshotInterval} мс, ` +
      (archiveEnabled() ? `сегмент ${config.segmentDuration} с, S3=${s3 ? 'ON' : 'OFF'}` : 'архив OFF')
    );
    return true;
  }

  const isTestSource = () => config.source === 'test';
  const archiveEnabled = () => config.archive !== false && !isTestSource();
  const tag = () => (config.cameraId ? `[VideoStreamService:${config.cameraId}]` : '[VideoStreamService]');

  // Сдвиг оттенка тестовой картинки по id камеры: камеры различимы на экране
  function hueFor(id) {
    let h = 0;
    for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }

  // ── Аргументы ffmpeg ────────────────────────────────────────────────
  function buildFfmpegArgs() {
    const c = config;
    const args = [];

    // ffmpegExtraArgs относятся ко входу (например, учётные данные или -rtsp_flags)
    const filters = [];
    if (isTestSource()) {
      // -re: генерация в реальном времени (иначе lavfi выдаёт кадры с максимальной скоростью)
      const t = c.test || {};
      args.push('-re', '-f', 'lavfi', '-i', `testsrc2=size=${t.size || '1280x720'}:rate=${t.rate || 10}`);
      filters.push(`hue=h=${hueFor(c.cameraId)}`);
      if (t.noise) filters.push(`noise=alls=${t.noise}:allf=t`);
    } else {
      if (c.ffmpegExtraArgs) args.push(...c.ffmpegExtraArgs.split(/\s+/).filter(Boolean));
      if (c.decodeKeyframesOnly) args.push('-skip_frame', 'nokey');
      args.push(
        '-rtsp_transport', 'tcp',
        '-fflags', 'nobuffer',
        '-flags', 'low_delay',
        '-i', c.rtspUrl
      );
    }

    // Выход 1: не чаще одного кадра за интервал, иначе в JPEG кодируется весь поток
    filters.push(`fps=1000/${c.snapshotInterval}`);
    if (c.snapshotMaxWidth > 0) filters.push(`scale='min(${c.snapshotMaxWidth},iw)':-2`);
    args.push(
      '-map', '0:v:0',
      '-an',
      '-vf', filters.join(','),
      '-c:v', 'mjpeg',
      '-q:v', String(c.snapshotQuality),
      '-f', 'mjpeg',
      'pipe:1'
    );
    if (!archiveEnabled()) return args;

    // Выход 2: сегменты MP4. Фрагментированный MP4 остаётся читаемым после обрыва питания
    args.push(
      '-map', '0:v:0',
      '-c:v', 'copy',
      '-an',
      '-f', 'segment',
      '-segment_format', 'mp4'
    );
    if (c.fragmentedMp4) {
      args.push('-segment_format_options', 'movflags=+frag_keyframe+empty_moov+default_base_moof');
    }
    args.push(
      '-segment_time', String(c.segmentDuration),
      '-reset_timestamps', '1',
      '-strftime', '1',
      path.join(c.tmpDir, 'video_%Y-%m-%d_%H-%M-%S.mp4')
    );
    return args;
  }

  // ── Процесс ffmpeg ──────────────────────────────────────────────────
  const pidFile = () => path.join(config.tmpDir, config.cameraId ? `ffmpeg-${config.cameraId}.pid` : 'ffmpeg.pid');
  // По чему узнать «свой» осиротевший ffmpeg в /proc/<pid>/cmdline
  const staleMarker = () => (archiveEnabled() ? config.tmpDir : (isTestSource() ? 'testsrc2' : config.rtspUrl));

  // ffmpeg, оставшийся от аварийно завершившегося сервера, держит RTSP и пишет такие же сегменты
  function killStaleFfmpeg() {
    let pid = NaN;
    try {
      pid = parseInt(fs.readFileSync(pidFile(), 'utf8'), 10);
    } catch {
      return;
    }
    try {
      if (Number.isInteger(pid) && pid > 1 && fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(staleMarker())) {
        process.kill(pid, 'SIGTERM');
        logger.logInfoMessage(`${tag()} - остановлен осиротевший ffmpeg (pid ${pid})`);
      }
    } catch {
      // процесса уже нет или нет /proc
    }
    try {
      fs.unlinkSync(pidFile());
    } catch {
      // файл уже удалён
    }
  }

  function writePidFile(child) {
    if (!child.pid) return;
    try {
      fs.writeFileSync(pidFile(), String(child.pid));
    } catch (e) {
      logger.logErrorMessage(`${tag()} - pid-файл: ${e.message}`);
    }
  }

  function removePidFile() {
    try {
      fs.unlinkSync(pidFile());
    } catch {
      // файла нет
    }
  }

  function onStderr(chunk) {
    const msg = maskUrl(chunk.toString()).trim();
    if (!msg) return;
    if (/error|failed|cannot/i.test(msg)) logger.logErrorMessage(`${tag()} - ffmpeg: ${msg}`);
    else logger.logDevMessage(`${tag()} - ffmpeg: ${msg}`);
  }

  function scheduleRestart() {
    if (!shouldRun || restartTimer) return;
    const delay = restartDelay;
    restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS);
    logger.logInfoMessage(`${tag()} - перезапуск ffmpeg через ${Math.round(delay / 1000)} с`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (shouldRun && !running) startFfmpeg();
    }, delay);
    restartTimer.unref?.();
  }

  function startFfmpeg() {
    const args = buildFfmpegArgs();
    logger.logDevMessage(`${tag()} - ffmpeg ${args.map(maskUrl).join(' ')}`);

    let child;
    try {
      child = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      logger.logErrorMessage(`${tag()} - не удалось запустить ffmpeg: ${e.message}`);
      scheduleRestart();
      return;
    }

    proc = child;
    running = true;
    procStartedAt = now();
    lastFrameAt = procStartedAt;
    writePidFile(child);

    child.stdout.on('data', createFrameParser(onFrame));
    child.stdout.on('error', () => {});
    child.stderr.on('data', onStderr);
    child.stderr.on('error', () => {});

    child.on('error', (e) => {
      logger.logErrorMessage(
        `${tag()} - ffmpeg: ${e.message}. Проверьте, что ffmpeg установлен и задан FFMPEG_PATH`
      );
      if (proc === child) {
        proc = null;
        running = false;
      }
      scheduleRestart();
    });

    child.on('close', (code, signal) => {
      const uptime = now() - procStartedAt;
      if (proc === child) {
        proc = null;
        running = false;
        removePidFile();
      }
      logger.logInfoMessage(`${tag()} - ffmpeg завершился (code=${code}, signal=${signal || 'none'})`);
      if (!shouldRun) return;
      if (uptime >= STABLE_UPTIME_MS) restartDelay = RESTART_MIN_MS;
      stats.ffmpegRestarts++;
      scheduleRestart();
    });

    startWatchdog();
    logger.logInfoMessage(`${tag()} - ffmpeg запущен`);
  }

  // ffmpeg может «зависнуть» на живом TCP-соединении без кадров: убиваем и перезапускаем
  function startWatchdog() {
    if (watchdogTimer) return;
    const limitMs = Math.max(config.watchdogSec * 1000, config.snapshotInterval * 3);
    watchdogTimer = setInterval(() => {
      if (!shouldRun || !running || !proc) return;
      const silentFor = now() - Math.max(lastFrameAt, procStartedAt);
      if (silentFor <= limitMs) return;
      stats.watchdogKills++;
      logger.logErrorMessage(`${tag()} - нет кадров ${Math.round(silentFor / 1000)} с, перезапускаем ffmpeg`);
      try {
        proc.kill('SIGKILL');
      } catch (e) {
        logger.logErrorMessage(`${tag()} - watchdog kill: ${e.message}`);
      }
    }, WATCHDOG_CHECK_MS);
    watchdogTimer.unref?.();
  }

  // ── Снимки для Vue ──────────────────────────────────────────────────
  function canView(session) {
    return Boolean(session && session.dID === config.dID && session.level >= config.minLevel);
  }

  function viewers() {
    const list = [];
    for (const { clientId, connection } of wsManager.getUserConnections('VUE_connections', config.dID)) {
      if (!connection.ws || connection.ws.readyState !== WS_OPEN) continue;
      if (canView(auth.getSession(clientId))) list.push(connection.ws);
    }
    return list;
  }

  function snapshotPayload(frame) {
    return {
      image: frame.jpeg.toString('base64'),
      mimeType: 'image/jpeg',
      size: frame.jpeg.length,
      timestamp: frame.timestamp,
    };
  }

  function onFrame(jpeg) {
    const t = now();
    lastFrameAt = t;
    lastFrame = { jpeg, timestamp: t };

    if (deliver) {
      try {
        deliver(lastFrame);
      } catch (e) {
        logger.logErrorMessage(`${tag()} - deliver: ${e.message}`);
      }
      return;
    }

    if (t - lastSentAt < config.snapshotInterval * 0.8) return;

    let targets;
    try {
      targets = viewers();
    } catch (e) {
      logger.logErrorMessage(`${tag()} - viewers: ${e.message}`);
      return;
    }
    if (targets.length === 0) return;

    lastSentAt = t;
    const raw = JSON.stringify({
      type: 'post',
      request: 'videoSnapshot',
      name: config.dID,
      payload: snapshotPayload(lastFrame),
    });

    let sent = 0;
    for (const ws of targets) {
      if (ws.bufferedAmount > MAX_WS_BUFFERED) {
        stats.snapshotsSkippedSlow++;
        continue;
      }
      try {
        ws.send(raw);
        sent++;
      } catch (e) {
        logger.logDevMessage(`${tag()} - send: ${e.message}`);
      }
    }
    if (sent > 0) {
      stats.snapshotsSent++;
      stats.lastSnapshotAt = t;
    }
  }

  // Последний кадр для запроса get/videoSnapshot; null — нет доступа или кадра ещё нет
  function getLastSnapshot(session) {
    if (!canView(session) || !lastFrame) return null;
    return snapshotPayload(lastFrame);
  }

  // ── Архив: выгрузка в S3 и ограничение диска ────────────────────────
  async function listSegments() {
    let names;
    try {
      names = await fsp.readdir(config.tmpDir);
    } catch (e) {
      logger.logErrorMessage(`${tag()} - readdir ${config.tmpDir}: ${e.message}`);
      return [];
    }
    const items = [];
    for (const file of names.filter((n) => n.endsWith('.mp4')).sort()) {
      const filePath = path.join(config.tmpDir, file);
      try {
        const stat = await fsp.stat(filePath);
        items.push({ file, filePath, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // файл исчез между readdir и stat
      }
    }
    return items;
  }

  async function uploadFile(filePath, fileName) {
    const datePart = (fileName.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || new Date(now()).toISOString().slice(0, 10);
    const key = `${config.s3Prefix}/${datePart}/${fileName}`;
    const body = fs.createReadStream(filePath);
    body.on('error', (e) => logger.logErrorMessage(`${tag()} - чтение ${fileName}: ${e.message}`));
    try {
      const upload = new UploadClass({
        client: s3,
        params: { Bucket: config.s3.bucket, Key: key, Body: body, ContentType: 'video/mp4' },
        partSize: 8 * 1024 * 1024,
        queueSize: 3,
        leavePartsOnError: false,
      });
      await upload.done();
    } finally {
      body.destroy();
    }
    return key;
  }

  async function enforceDiskLimit(activeName) {
    if (!config.tmpMaxMb) return 0;
    const limit = config.tmpMaxMb * 1024 * 1024;
    const items = await listSegments();
    let total = items.reduce((sum, i) => sum + i.size, 0);
    let evicted = 0;
    for (const item of items) {
      if (total <= limit) break;
      if (item.file === activeName) continue;
      try {
        await fsp.unlink(item.filePath);
        total -= item.size;
        evicted++;
        stats.filesEvicted++;
        logger.logErrorMessage(
          `${tag()} - диск: удалён ${item.file} (лимит ${config.tmpMaxMb} МБ)` +
          `${s3 ? ', файл не был выгружен в S3' : ''}`
        );
      } catch (e) {
        logger.logErrorMessage(`${tag()} - удаление ${item.file}: ${e.message}`);
      }
    }
    return evicted;
  }

  // Выгружает завершённые сегменты и удаляет их; затем применяет лимит диска.
  // Не запускается параллельно сам с собой. Файл, который сейчас пишет ffmpeg
  // (самый новый по имени), не трогается.
  async function uploadAndCleanupSegments() {
    const result = { uploaded: 0, failed: 0, skipped: 0, evicted: 0 };
    if (uploadRunning) return result;
    uploadRunning = true;
    try {
      const items = await listSegments();
      const activeName = running && items.length ? items[items.length - 1].file : null;
      const minAgeMs = config.uploadMinAgeSec * 1000;

      for (const item of items) {
        if (item.file === activeName) {
          result.skipped++;
          continue;
        }
        if (item.size === 0) {
          await fsp.unlink(item.filePath).catch(() => {});
          continue;
        }
        if (!s3 || now() - item.mtimeMs < minAgeMs) {
          result.skipped++;
          continue;
        }
        try {
          const key = await uploadFile(item.filePath, item.file);
          await fsp.unlink(item.filePath);
          result.uploaded++;
          stats.filesUploaded++;
          stats.bytesUploaded += item.size;
          stats.lastUploadAt = now();
          logger.logInfoMessage(
            `${tag()} - загружен и удалён ${item.file} → ${key} (${(item.size / 1048576).toFixed(2)} МБ)`
          );
        } catch (e) {
          result.failed++;
          stats.filesFailed++;
          logger.logErrorMessage(`${tag()} - ошибка загрузки ${item.file}: ${e.message}`);
        }
      }
      result.evicted = await enforceDiskLimit(activeName);
    } catch (e) {
      logger.logErrorMessage(`${tag()} - uploadAndCleanupSegments: ${e.message}`);
    } finally {
      uploadRunning = false;
    }
    return result;
  }

  function startUploadTimer() {
    clearTimers(['upload']);
    const run = () => uploadAndCleanupSegments().catch(() => {});
    firstUploadTimer = setTimeout(run, FIRST_UPLOAD_DELAY_MS);
    firstUploadTimer.unref?.();
    uploadTimer = setInterval(run, config.uploadIntervalSec * 1000);
    uploadTimer.unref?.();
  }

  function clearTimers(which = ['restart', 'watchdog', 'upload']) {
    if (which.includes('restart') && restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (which.includes('watchdog') && watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    if (which.includes('upload')) {
      if (uploadTimer) clearInterval(uploadTimer);
      if (firstUploadTimer) clearTimeout(firstUploadTimer);
      uploadTimer = null;
      firstUploadTimer = null;
    }
  }

  // ── Запуск / остановка ──────────────────────────────────────────────
  function start() {
    if (!config.rtspUrl && !isTestSource()) {
      logger.logInfoMessage(`${tag()} - start пропущен: RTSP не задан`);
      return;
    }
    if (shouldRun) return;
    shouldRun = true;
    stats.startedAt = stats.startedAt || now();
    restartDelay = RESTART_MIN_MS;
    killStaleFfmpeg();
    if (!exitHook) {
      exitHook = () => {
        try {
          if (proc) proc.kill('SIGTERM');
        } catch {
          // процесс уже завершён
        }
      };
      process.once('exit', exitHook);
    }
    startFfmpeg();
    if (archiveEnabled()) startUploadTimer();
  }

  // Останавливает ffmpeg (SIGTERM, затем SIGKILL по таймауту) и ждёт его завершения
  async function stop() {
    shouldRun = false;
    clearTimers();
    if (exitHook) {
      process.removeListener('exit', exitHook);
      exitHook = null;
    }
    const child = proc;
    if (!child) {
      running = false;
      return;
    }
    logger.logInfoMessage(`${tag()} - остановка ffmpeg`);
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // процесс уже завершён
        }
        resolve();
      }, STOP_TIMEOUT_MS);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
    proc = null;
    running = false;
  }

  function getStats() {
    return {
      isRunning: running,
      shouldRun,
      cameraId: config.cameraId || null,
      source: isTestSource() ? 'test' : 'rtsp',
      archive: archiveEnabled(),
      rtspUrlMasked: config.rtspUrl ? maskUrl(config.rtspUrl) : null,
      dID: config.dID,
      minLevel: config.minLevel,
      s3Enabled: Boolean(s3),
      hasSnapshot: Boolean(lastFrame),
      lastFrameAt: lastFrame ? lastFrame.timestamp : null,
      tmpDir: config.tmpDir,
      config: {
        snapshotInterval: config.snapshotInterval,
        segmentDuration: config.segmentDuration,
        uploadIntervalSec: config.uploadIntervalSec,
        uploadMinAgeSec: config.uploadMinAgeSec,
        tmpMaxMb: config.tmpMaxMb,
      },
      stats: { ...stats },
    };
  }

  return {
    init,
    start,
    stop,
    getStats,
    getLastSnapshot,
    canView,
    buildFfmpegArgs,
    uploadAndCleanupSegments,
  };
}

const defaultService = createVideoStreamService();

module.exports = defaultService;
module.exports.createVideoStreamService = createVideoStreamService;
module.exports.createFrameParser = createFrameParser;
module.exports.maskUrl = maskUrl;
