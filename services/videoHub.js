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
// Доступ к камере: сессия с одним из dID камеры (dIDs; '*' — любой) и уровнем >= minLevel камеры.
//
// cameras.json перечитывается на лету (watch): изменённые камеры перезапускаются, новые
// запускаются, удалённые останавливаются; клиентам Vue уходит новый список камер —
// { type: 'response', request: 'videoCameras', payload: { cameras } }.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
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
  checkFfmpeg = defaultCheckFfmpeg,
  watchFile = fs.watchFile,
  unwatchFile = fs.unwatchFile,
} = {}) {
  const cameras = new Map(); // id -> { camera, worker, lastFrame, raw, stats }
  const subscriptions = new Map(); // clientId -> { preview: Set<id>, full: id|null, lastSent: Map<id, ts> }
  let configInfo = { file: null, errors: [], legacy: false };

  const cameraDIDs = (camera) => camera.dIDs || [camera.dID];
  const canView = (session, camera) => Boolean(
    session && camera && session.level >= camera.minLevel &&
    (cameraDIDs(camera).includes('*') || cameraDIDs(camera).includes(session.dID))
  );

  // Соединения Vue, которым может предназначаться кадр камеры
  function candidateConnections(camera) {
    const dIDs = cameraDIDs(camera);
    if (dIDs.includes('*')) {
      const conns = wsManager.VUE_connections;
      return conns && typeof conns.entries === 'function'
        ? [...conns.entries()].map(([clientId, connection]) => ({ clientId, connection }))
        : [];
    }
    return dIDs.flatMap((d) => wsManager.getUserConnections('VUE_connections', d));
  }

  // ── Инициализация и перечитывание cameras.json ──────────────────────
  let base = null;
  let started = false;
  let watching = null;
  let reloadTimer = null;
  let ffmpegChecked = false;

  function createEntry(camera, legacy) {
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
    if (!ok) return null;
    return {
      camera,
      spec: JSON.stringify(camera),
      worker,
      lastFrame: null,
      raw: null,
      stats: { framesCaptured: 0, framesSent: 0, bytesSent: 0, skippedSlow: 0 },
    };
  }

  // Применяет список камер: неизменённые работают дальше, остальные пересоздаются.
  // Возвращает { added, changed, removed } — id камер.
  function apply() {
    base = loadConfig();
    const { file, cameras: list, errors, legacy, created, invalid } = loadCameraList();
    errors.forEach((e) => logger.logErrorMessage(`[videoHub] - cameras: ${e}`));
    const diff = { added: [], changed: [], removed: [], stopped: [] };
    // Файл не читается (битый JSON при правке) — работающие камеры не трогаем
    if (invalid && cameras.size) {
      logger.logErrorMessage(`[videoHub] - ${file} с ошибкой — камеры без изменений до исправления файла`);
      configInfo = { ...configInfo, errors };
      return diff;
    }
    configInfo = { file, errors, legacy };
    list
      .filter((c) => c.source !== 'test' && (c.dIDs || []).includes('*'))
      .forEach((c) => logger.logErrorMessage(
        `[videoHub] - камера ${c.id} (реальная) видна всем пользователям (dID "*") — укажите dID в cameras.json`
      ));
    if (created) {
      const mocks = list.filter((c) => c.source === 'test');
      const real = list.filter((c) => c.source !== 'test');
      logger.logInfoMessage(
        `[videoHub] - создан ${path.resolve(file)}: ` +
        (real.length ? `камера из VIDEO_RTSP_URL (${real.map((c) => c.id).join(', ')}) и ` : '') +
        `${mocks.length} муляжей (source "test")` +
        (mocks.length ? `, ${mocks[0].dID === '*' ? 'видны всем пользователям (dID "*")' : `видны пользователям dID "${mocks[0].dID}"`}` : '') +
        '; реальную камеру подключают заменой "source" на rtsp://… — без перезапуска сервера'
      );
    }

    const next = new Map(list.map((c) => [c.id, c]));
    for (const [id, entry] of cameras) {
      const camera = next.get(id);
      if (camera && JSON.stringify(camera) === entry.spec) continue;
      diff.stopped.push(entry.worker.stop());
      cameras.delete(id);
      (camera ? diff.changed : diff.removed).push(id);
    }
    for (const camera of list) {
      if (cameras.has(camera.id)) continue;
      const entry = createEntry(camera, legacy);
      if (!entry) continue;
      cameras.set(camera.id, entry);
      if (!diff.changed.includes(camera.id)) diff.added.push(camera.id);
      if (started) entry.worker.start();
    }
    // Порядок камер — как в файле (пересозданные не уезжают в конец)
    const ordered = list.filter((c) => cameras.has(c.id)).map((c) => [c.id, cameras.get(c.id)]);
    cameras.clear();
    ordered.forEach(([id, entry]) => cameras.set(id, entry));
    // Удалённые камеры — из подписок
    for (const sub of subscriptions.values()) {
      diff.removed.forEach((id) => {
        sub.preview.delete(id);
        if (sub.full === id) sub.full = null;
      });
    }
    if (!ffmpegChecked && cameras.size) {
      ffmpegChecked = true;
      // Асинхронно: старт сервера не ждёт ffmpeg
      Promise.resolve(checkFfmpeg(base.ffmpegPath || 'ffmpeg'))
        .then((problem) => { if (problem) logger.logErrorMessage(`[videoHub] - ${problem}`); })
        .catch(() => {});
    }
    return diff;
  }

  function init() {
    apply();
    logger.logInfoMessage(
      `[videoHub] - init: камер ${cameras.size}${configInfo.legacy ? ' (VIDEO_RTSP_URL)' : ` из ${configInfo.file ? path.resolve(configInfo.file) : '—'}`}` +
      (cameras.size ? `: ${describe()}` : '')
    );
    return cameras.size > 0;
  }

  const describe = () => [...cameras.values()]
    .map(({ camera }) => `${camera.id}${camera.source === 'test' ? ' (муляж)' : ''}`).join(', ');

  function start() {
    started = true;
    for (const { worker } of cameras.values()) worker.start();
  }

  // Перечитать cameras.json и разослать клиентам новый список камер
  async function reload() {
    const { added, changed, removed, stopped } = apply();
    await Promise.all(stopped);
    if (!added.length && !changed.length && !removed.length) return false;
    logger.logInfoMessage(
      `[videoHub] - reload: добавлены [${added.join(', ')}], изменены [${changed.join(', ')}], удалены [${removed.join(', ')}]; ` +
      `камер ${cameras.size}${cameras.size ? `: ${describe()}` : ''}`
    );
    notifyCameraList();
    return true;
  }

  function notifyCameraList() {
    const conns = wsManager.VUE_connections;
    if (!conns || typeof conns.entries !== 'function') return;
    for (const [clientId, connection] of conns.entries()) {
      const session = auth.getSession(clientId);
      const ws = connection?.ws;
      if (!session || !ws || ws.readyState !== WS_OPEN) continue;
      try {
        ws.send(JSON.stringify({
          type: 'response', request: 'videoCameras', name: session.dID, payload: { cameras: listCameras(session) },
        }));
      } catch (e) {
        logger.logDevMessage(`[videoHub] - notifyCameraList ${clientId}: ${e.message}`);
      }
    }
  }

  // Следим за cameras.json (в том числе за его появлением). watchFile — опрос mtime:
  // надёжно при сохранении редактором через временный файл.
  function watch(intervalMs = 2000) {
    if (watching || configInfo.legacy || !configInfo.file) return;
    watching = configInfo.file;
    watchFile(watching, { interval: intervalMs }, (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reload().catch((e) => logger.logErrorMessage(`[videoHub] - reload: ${e.message}`));
      }, 300);
    });
  }

  async function stop() {
    clearTimeout(reloadTimer);
    if (watching) unwatchFile(watching);
    watching = null;
    started = false;
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

  // Сериализуем кадр один раз на всех получателей одного dID (name — dID получателя)
  function rawFrame(entry, dID) {
    if (!entry.raw) entry.raw = new Map();
    if (!entry.raw.has(dID)) {
      entry.raw.set(dID, JSON.stringify({
        type: 'post', request: 'videoSnapshot', name: dID, payload: snapshotPayload(entry),
      }));
    }
    return entry.raw.get(dID);
  }

  // Режим подписки соединения на камеру: 'full' | 'preview' | null
  function modeFor(clientId, cameraId) {
    const sub = subscriptions.get(clientId);
    if (!sub) return 'preview';
    if (sub.full === cameraId) return 'full';
    return sub.preview.has(cameraId) ? 'preview' : null;
  }

  function sendTo(entry, clientId, connection, { force = false, dID = connection.dID } = {}) {
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
    const raw = rawFrame(entry, dID);
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
      connections = candidateConnections(entry.camera);
    } catch (e) {
      logger.logErrorMessage(`[videoHub] - onFrame ${cameraId}: ${e.message}`);
      return;
    }
    for (const { clientId, connection } of connections) {
      const session = auth.getSession(clientId);
      if (!canView(session, entry.camera)) continue;
      sendTo(entry, clientId, connection, { dID: session.dID });
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
        if (entry?.lastFrame) sendTo(entry, clientId, connection, { force: true, dID: session?.dID ?? connection.dID });
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

  // Для служб сервера (уведомления): последний кадр камеры, если она видна пользователям dID.
  // { jpeg (Buffer), timestamp, cameraId, title } | null — нет камеры, доступа или кадра
  function getFrameFor(dID, cameraId) {
    const entry = cameras.get(cameraId);
    if (!entry?.lastFrame) return null;
    const dIDs = cameraDIDs(entry.camera);
    if (!dIDs.includes('*') && !dIDs.includes(dID)) return null;
    return {
      jpeg: entry.lastFrame.jpeg,
      timestamp: entry.lastFrame.timestamp,
      cameraId,
      title: entry.camera.title,
    };
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

  return { init, start, stop, reload, watch, subscribe, unsubscribe, listCameras, getLastSnapshot, getFrameFor, getStats, onFrame };
}

// ffmpeg доступен? Promise<null> — да, иначе текст ошибки с подсказкой
function defaultCheckFfmpeg(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['-hide_banner', '-version'], { timeout: 10000 }, (e) => {
      if (!e) return resolve(null);
      resolve(e.code === 'ENOENT'
        ? `ffmpeg не найден (FFMPEG_PATH=${bin}) — камеры и муляжи не будут работать. ` +
          'Установите: macOS — brew install ffmpeg, Linux — apt install ffmpeg; или укажите полный путь в FFMPEG_PATH'
        : `ffmpeg (${bin}) не запускается: ${e.message.split('\n')[0]}`);
    });
  });
}

const defaultHub = createVideoHub();

module.exports = {
  createVideoHub,
  init: (...a) => defaultHub.init(...a),
  start: (...a) => defaultHub.start(...a),
  stop: (...a) => defaultHub.stop(...a),
  reload: (...a) => defaultHub.reload(...a),
  watch: (...a) => defaultHub.watch(...a),
  subscribe: (...a) => defaultHub.subscribe(...a),
  unsubscribe: (...a) => defaultHub.unsubscribe(...a),
  listCameras: (...a) => defaultHub.listCameras(...a),
  getLastSnapshot: (...a) => defaultHub.getLastSnapshot(...a),
  getFrameFor: (...a) => defaultHub.getFrameFor(...a),
  getStats: (...a) => defaultHub.getStats(...a),
};
