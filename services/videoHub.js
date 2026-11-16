// services/videoHub.js
// Видеонаблюдение на 1–16 камер: список камер, подписки клиентов Vue и доставка кадров.
//
// Камеры описаны в cameras.json (services/videoConfig.loadCameras). На каждую камеру —
// свой videoStreamService (ffmpeg, разбор MJPEG, watchdog, перезапуск); кадры он отдаёт сюда.
//
// Подписка (post/videoSubscribe, payload { cameras: [id...], full: id|null }):
//   cameras — миниатюры: кадр не чаще previewIntervalMs камеры;
//   full    — камера на полном экране: кадр не чаще fullIntervalMs.
// Соединение без подписки получает миниатюры всех доступных ему камер (прежнее поведение
// одной камеры). Подписка пустым списком — кадров нет. Подписка живёт, пока открыто
// соединение: после переподключения клиент подписывается заново.
//
// Push: { type: 'post', request: 'videoSnapshot', name: <dID камеры>,
//         payload: { cameraId, title, image (base64 JPEG), mimeType, size, timestamp } }.
// Доступ к камере: сессия с dID камеры и уровнем >= minLevel камеры.
'use strict';

const path = require('path');
const logger = require('./logger.js');
const { loadVideoConfig, loadCameras } = require('./videoConfig.js');
const { createVideoStreamService } = require('./videoStreamService.js');

const WS_OPEN = 1;
const MAX_WS_BUFFERED = 1024 * 1024;

function createVideoHub({
  wsManager = require('../classes/wsManager.js'),
  auth = require('./auth.js'),
  createWorker = createVideoStreamService,
  loadConfig = loadVideoConfig,
  loadCameraList = loadCameras,
  now = Date.now,
} = {}) {
  const cameras = new Map(); // id -> { camera, worker, lastFrame, raw, stats }
  const subscriptions = new Map(); // clientId -> { preview: Set<id>, full: id|null, lastSent: Map<id, ts> }
  let configInfo = { file: null, errors: [], legacy: false };

  const canView = (session, camera) =>
    Boolean(session && camera && session.dID === camera.dID && session.level >= camera.minLevel);

  // ── Инициализация ───────────────────────────────────────────────────
  function init() {
    const base = loadConfig();
    const { file, cameras: list, errors, legacy } = loadCameraList();
    configInfo = { file, errors, legacy };
    errors.forEach((e) => logger.logErrorMessage(`[videoHub] - cameras: ${e}`));

    for (const camera of list) {
      const worker = createWorker({ deliver: (frame) => onFrame(camera.id, frame) });
      const ok = worker.init({
        ...base,
        cameraId: camera.id,
        title: camera.title,
        source: camera.source,
        rtspUrl: camera.source === 'test' ? '' : camera.source,
        dID: camera.dID,
        minLevel: camera.minLevel,
        // ffmpeg кодирует с частотой полного экрана; миниатюрам кадры отдаются реже
        snapshotInterval: Math.min(camera.previewIntervalMs, camera.fullIntervalMs),
        snapshotMaxWidth: camera.maxWidth,
        snapshotQuality: camera.quality,
        archive: camera.archive,
        test: camera.test,
        tmpDir: legacy ? base.tmpDir : path.join(base.tmpDir, camera.id),
      });
      if (!ok) continue;
      cameras.set(camera.id, {
        camera,
        worker,
        lastFrame: null,
        raw: null,
        stats: { framesCaptured: 0, framesSent: 0, bytesSent: 0, skippedSlow: 0 },
      });
    }
    logger.logInfoMessage(
      `[videoHub] - init: камер ${cameras.size}${legacy ? ' (VIDEO_RTSP_URL)' : ` из ${file}`}` +
      (cameras.size ? `: ${[...cameras.keys()].join(', ')}` : '')
    );
    return cameras.size > 0;
  }

  function start() {
    for (const { worker } of cameras.values()) worker.start();
  }

  async function stop() {
    await Promise.all([...cameras.values()].map(({ worker }) => worker.stop()));
  }

  // ── Доставка ────────────────────────────────────────────────────────
  function snapshotPayload(entry) {
    const { camera, lastFrame } = entry;
    return {
      cameraId: camera.id,
      title: camera.title,
      image: lastFrame.jpeg.toString('base64'),
      mimeType: 'image/jpeg',
      size: lastFrame.jpeg.length,
      timestamp: lastFrame.timestamp,
    };
  }

  // Сериализуем кадр один раз на всех получателей
  function rawFrame(entry) {
    if (!entry.raw) {
      entry.raw = JSON.stringify({
        type: 'post', request: 'videoSnapshot', name: entry.camera.dID, payload: snapshotPayload(entry),
      });
    }
    return entry.raw;
  }

  // Режим подписки соединения на камеру: 'full' | 'preview' | null
  function modeFor(clientId, cameraId) {
    const sub = subscriptions.get(clientId);
    if (!sub) return 'preview';
    if (sub.full === cameraId) return 'full';
    return sub.preview.has(cameraId) ? 'preview' : null;
  }

  function sendTo(entry, clientId, connection, { force = false } = {}) {
    const { camera } = entry;
    const mode = modeFor(clientId, camera.id);
    if (!mode) return false;
    const ws = connection.ws;
    if (!ws || ws.readyState !== WS_OPEN) return false;

    const sub = subscriptions.get(clientId);
    const lastSent = sub ? sub.lastSent : legacyLastSent(clientId);
    const interval = mode === 'full' ? camera.fullIntervalMs : camera.previewIntervalMs;
    // ffmpeg выдаёт кадры с шагом захвата (min интервалов) и небольшим разбросом:
    // допуск — половина шага, иначе миниатюры уходили бы чаще заданного
    const capture = Math.min(camera.previewIntervalMs, camera.fullIntervalMs);
    const t = entry.lastFrame.timestamp;
    if (!force && t - (lastSent.get(camera.id) || 0) < interval - capture / 2) return false;
    if (ws.bufferedAmount > MAX_WS_BUFFERED) {
      entry.stats.skippedSlow++;
      return false;
    }
    const raw = rawFrame(entry);
    try {
      ws.send(raw);
    } catch (e) {
      logger.logDevMessage(`[videoHub] - send ${camera.id}: ${e.message}`);
      return false;
    }
    lastSent.set(camera.id, t);
    entry.stats.framesSent++;
    entry.stats.bytesSent += raw.length;
    return true;
  }

  // lastSent для соединений без явной подписки (прежнее поведение)
  const legacySent = new Map();
  function legacyLastSent(clientId) {
    if (!legacySent.has(clientId)) legacySent.set(clientId, new Map());
    return legacySent.get(clientId);
  }

  function onFrame(cameraId, frame) {
    const entry = cameras.get(cameraId);
    if (!entry) return;
    entry.lastFrame = frame;
    entry.raw = null;
    entry.stats.framesCaptured++;

    let connections;
    try {
      connections = wsManager.getUserConnections('VUE_connections', entry.camera.dID);
    } catch (e) {
      logger.logErrorMessage(`[videoHub] - onFrame ${cameraId}: ${e.message}`);
      return;
    }
    for (const { clientId, connection } of connections) {
      if (!canView(auth.getSession(clientId), entry.camera)) continue;
      sendTo(entry, clientId, connection);
    }
  }

  // ── Подписки ────────────────────────────────────────────────────────
  // Возвращает принятую подписку: недоступные и неизвестные камеры отбрасываются.
  // Новым камерам последний кадр отправляется сразу — миниатюры не ждут интервал.
  function subscribe(clientId, session, payload = {}) {
    const requested = Array.isArray(payload.cameras) ? payload.cameras : [];
    const allowed = (id) => typeof id === 'string' && canView(session, cameras.get(id)?.camera);
    const preview = new Set(requested.filter(allowed));
    const full = allowed(payload.full) ? payload.full : null;

    const prev = subscriptions.get(clientId);
    const lastSent = prev ? prev.lastSent : legacyLastSent(clientId);
    legacySent.delete(clientId);
    const sub = { preview, full, lastSent };
    subscriptions.set(clientId, sub);

    const fresh = new Set([...preview, ...(full ? [full] : [])]);
    if (prev) {
      prev.preview.forEach((id) => fresh.delete(id));
      if (prev.full === full) fresh.delete(full);
    }
    const connection = wsManager.VUE_connections?.get?.(clientId);
    if (connection) {
      for (const id of fresh) {
        const entry = cameras.get(id);
        if (entry?.lastFrame) sendTo(entry, clientId, connection, { force: true });
      }
    }
    return { cameras: [...preview], full };
  }

  function unsubscribe(clientId) {
    subscriptions.delete(clientId);
    legacySent.delete(clientId);
  }

  // ── Запросы ─────────────────────────────────────────────────────────
  function cameraStatus(entry) {
    const s = entry.worker.getStats();
    if (!s.isRunning) return 'offline';
    return entry.lastFrame && now() - entry.lastFrame.timestamp < Math.max(entry.camera.fullIntervalMs * 5, 10000)
      ? 'online'
      : 'starting';
  }

  function listCameras(session) {
    return [...cameras.values()]
      .filter((e) => canView(session, e.camera))
      .map((e) => ({
        id: e.camera.id,
        title: e.camera.title,
        status: cameraStatus(e),
        lastFrameAt: e.lastFrame ? e.lastFrame.timestamp : null,
        previewIntervalMs: e.camera.previewIntervalMs,
        fullIntervalMs: e.camera.fullIntervalMs,
      }));
  }

  // Последний кадр камеры (без cameraId — первой доступной); null — нет доступа или кадра
  function getLastSnapshot(session, cameraId) {
    const entry = cameraId
      ? cameras.get(cameraId)
      : [...cameras.values()].find((e) => canView(session, e.camera));
    if (!entry || !canView(session, entry.camera) || !entry.lastFrame) return null;
    return snapshotPayload(entry);
  }

  function getStats() {
    return {
      configFile: configInfo.file,
      legacy: configInfo.legacy,
      configErrors: configInfo.errors,
      subscriptions: subscriptions.size,
      cameras: [...cameras.values()].map((e) => {
        const w = e.worker.getStats();
        return {
          id: e.camera.id,
          title: e.camera.title,
          dID: e.camera.dID,
          source: w.source,
          status: cameraStatus(e),
          lastFrameAt: e.lastFrame ? e.lastFrame.timestamp : null,
          lastFrameBytes: e.lastFrame ? e.lastFrame.jpeg.length : 0,
          ffmpegRestarts: w.stats.ffmpegRestarts,
          watchdogKills: w.stats.watchdogKills,
          ...e.stats,
        };
      }),
    };
  }

  return { init, start, stop, subscribe, unsubscribe, listCameras, getLastSnapshot, getStats, onFrame };
}

const defaultHub = createVideoHub();

module.exports = {
  createVideoHub,
  init: (...a) => defaultHub.init(...a),
  start: (...a) => defaultHub.start(...a),
  stop: (...a) => defaultHub.stop(...a),
  subscribe: (...a) => defaultHub.subscribe(...a),
  unsubscribe: (...a) => defaultHub.unsubscribe(...a),
  listCameras: (...a) => defaultHub.listCameras(...a),
  getLastSnapshot: (...a) => defaultHub.getLastSnapshot(...a),
  getStats: (...a) => defaultHub.getStats(...a),
};
