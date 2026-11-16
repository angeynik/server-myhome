#!/usr/bin/env node
// tools/videoLoadTest.js
//
// Нагрузочная проверка видеоцепочки без камер: сервер (serverapp.js) с N эмулированными камерами
// (source "test": ffmpeg генерирует картинку и кодирует JPEG — реальная нагрузка) и M клиентов Vue,
// которые входят, получают список камер и подписываются как интерфейс: миниатюры всех камер,
// первые --full клиентов держат cam01 на полном экране.
//
// Запуск (из каталога сервера):
//   node tools/videoLoadTest.js                          # 1, 4, 8, 16 камер, 2 клиента, 30 с, системный ffmpeg
//   node tools/videoLoadTest.js --cameras 16 --clients 4 --duration 60
//   node tools/videoLoadTest.js --ffmpeg /opt/homebrew/bin/ffmpeg --size 1920x1080 --rate 25
//   node tools/videoLoadTest.js --ffmpeg fake --frame-kb 80   # без ffmpeg: tools/fakeFfmpeg.js (проверка цепочки и сети,
//                                                               # без нагрузки кодирования; кадры — не настоящий JPEG)
// Параметры: --cameras 1,4,8,16  --clients 2  --full 1  --duration 30  --warmup 5
//            --preview-ms 5000  --full-ms 1000  --size 1280x720  --rate 10  --noise 20  --max-width 640  --quality 5
//            --ffmpeg ffmpeg|fake|<путь>  --frame-kb 60 (для fake)  --port 19302  --json <файл>
//
// Результат по каждому N: доставлено кадров от ожидаемого, задержка (кадр закодирован → получен
// клиентом), максимальный разрыв между кадрами камеры на полном экране, трафик на клиента,
// CPU и память процесса сервера и всех ffmpeg, размер кадра, пропуски медленным клиентам,
// перезапуски ffmpeg. Сервер слушает только 127.0.0.1, данные — во временном каталоге.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const o = {
    cameras: [1, 4, 8, 16], clients: 2, full: 1, duration: 30, warmup: 5,
    previewMs: 5000, fullMs: 1000, size: '1280x720', rate: 10, noise: 20, maxWidth: 640, quality: 5,
    ffmpeg: 'ffmpeg', frameKb: 60, port: 19302, json: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = [argv[i], argv[i + 1]];
    const num = () => { i++; return Number(v); };
    if (k === '--cameras') { o.cameras = v.split(',').map(Number).filter((n) => n >= 1 && n <= 16); i++; }
    else if (k === '--clients') o.clients = num();
    else if (k === '--full') o.full = num();
    else if (k === '--duration') o.duration = num();
    else if (k === '--warmup') o.warmup = num();
    else if (k === '--preview-ms') o.previewMs = num();
    else if (k === '--full-ms') o.fullMs = num();
    else if (k === '--size') { o.size = v; i++; }
    else if (k === '--rate') o.rate = num();
    else if (k === '--noise') o.noise = num();
    else if (k === '--max-width') o.maxWidth = num();
    else if (k === '--quality') o.quality = num();
    else if (k === '--ffmpeg') { o.ffmpeg = v; i++; }
    else if (k === '--frame-kb') o.frameKb = num();
    else if (k === '--port') o.port = num();
    else if (k === '--json') { o.json = v; i++; }
    else if (k === '--help' || k === '-h') o.help = true;
  }
  return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const camId = (i) => `cam${String(i + 1).padStart(2, '0')}`;

// ── Процессы: суммарное время CPU и RSS сервера и его потомков (Linux и macOS) ──
function parseCpuTime(s) {
  // [[DD-]HH:]MM:SS[.ss]
  let days = 0;
  let rest = s;
  if (rest.includes('-')) [days, rest] = [Number(rest.split('-')[0]), rest.split('-')[1]];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// Linux: время CPU из /proc/<pid>/stat (utime+stime, тики 1/100 с) — точнее, чем ps (секунды)
function procCpuSeconds(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return (Number(fields[11]) + Number(fields[12])) / 100;
  } catch {
    return null;
  }
}

function processTree(rootPid) {
  let out;
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time=,rss='], { encoding: 'utf8' });
  } catch {
    return null;
  }
  const rows = out.trim().split('\n').map((l) => l.trim().split(/\s+/)).map(([pid, ppid, time, rss]) => {
    const precise = procCpuSeconds(Number(pid));
    return { pid: Number(pid), ppid: Number(ppid), cpu: precise ?? parseCpuTime(time), rss: Number(rss) * 1024 };
  });
  const server = rows.find((r) => r.pid === rootPid);
  if (!server) return null;
  const children = [];
  const queue = [rootPid];
  while (queue.length) {
    const p = queue.shift();
    for (const r of rows) if (r.ppid === p) { children.push(r); queue.push(r.pid); }
  }
  return {
    server: { cpu: server.cpu, rss: server.rss },
    ffmpeg: { cpu: children.reduce((s, r) => s + r.cpu, 0), rss: children.reduce((s, r) => s + r.rss, 0), count: children.length },
  };
}

// ── Клиент Vue ──────────────────────────────────────────────────────
function connectClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiters = new Map();
    const client = {
      ws,
      frames: new Map(), // cameraId -> [{ t, latency, bytes }]
      measuring: false,
      request(msg, expect) {
        return new Promise((res, rej) => {
          waiters.set(expect, res);
          ws.send(JSON.stringify(msg));
          setTimeout(() => rej(new Error(`нет ответа ${expect}`)), 10000);
        });
      },
    };
    ws.on('message', (data) => {
      const raw = data.toString();
      const msg = JSON.parse(raw);
      if (msg.type === 'post' && msg.request === 'videoSnapshot') {
        if (!client.measuring) return;
        const t = Date.now();
        const list = client.frames.get(msg.payload.cameraId) || [];
        list.push({ t, latency: t - msg.payload.timestamp, bytes: raw.length, size: msg.payload.size });
        client.frames.set(msg.payload.cameraId, list);
        return;
      }
      const w = waiters.get(msg.request);
      if (w) { waiters.delete(msg.request); w(msg); }
    });
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}

async function waitForServer(url, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const c = await connectClient(url);
      c.ws.close();
      return;
    } catch {
      await sleep(300);
    }
  }
  throw new Error('сервер не поднялся');
}

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

// ── Один прогон для N камер ─────────────────────────────────────────
async function runOnce(n, o) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `video-load-${n}-`));
  const camerasFile = path.join(tmp, 'cameras.json');
  fs.writeFileSync(camerasFile, JSON.stringify({
    defaults: {
      dID: 'loadtest', source: 'test', previewIntervalMs: o.previewMs, fullIntervalMs: o.fullMs,
      maxWidth: o.maxWidth, quality: o.quality, test: { size: o.size, rate: o.rate, noise: o.noise },
    },
    cameras: Array.from({ length: n }, (_, i) => ({ id: camId(i), title: `Тест ${i + 1}` })),
  }, null, 2));

  const fake = o.ffmpeg === 'fake';
  const env = {
    PATH: process.env.PATH, HOME: tmp, LOG_LEVEL: 'error',
    SERVER_PORT: String(o.port + 1), WSD_PORT_IN: String(o.port), WSR_PORT_IN: String(o.port + 2), WSR_HOST: '127.0.0.1',
    NODERED_ENABLED: 'false', MODBUS_ENABLED: 'false', MODBUS_RTU_ENABLED: 'false', TELEGRAM_ENABLED: 'false',
    VIDEO_ENABLED: 'true', VIDEO_CAMERAS_FILE: camerasFile, VIDEO_TMP_DIR: path.join(tmp, 'video'),
    FFMPEG_PATH: fake ? path.join(__dirname, 'fakeFfmpeg.js') : o.ffmpeg, FAKE_FFMPEG_FRAME_KB: String(o.frameKb),
    DATA_DIR: path.join(tmp, 'data'), USERS_FILE: path.join(tmp, 'users.enc'), AUTH_KEY_FILE: path.join(tmp, 'auth.key'),
    DEFAULT_USER_NAME: 'loadtest', DEFAULT_USER_PASSWORD: 'loadtest-pass', DEFAULT_USER_DID: 'loadtest', DEFAULT_USER_LEVEL: '3',
    JWT_SECRET: crypto.randomBytes(32).toString('hex'), AUTH_TIMEOUT_MS: '0',
  };
  const server = spawn(process.execPath, ['serverapp.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  const url = `ws://127.0.0.1:${o.port}`;
  const clients = [];
  try {
    await waitForServer(url);
    for (let i = 0; i < o.clients; i++) {
      const c = await connectClient(url);
      const login = await c.request({ type: 'auth', request: 'login', name: '', payload: { username: 'loadtest', password: 'loadtest-pass' } }, 'loginSuccess');
      const dID = login.payload.dID;
      const list = await c.request({ type: 'get', request: 'videoCameras', name: dID, payload: {} }, 'videoCameras');
      const ids = list.payload.cameras.map((x) => x.id);
      await c.request({
        type: 'post', request: 'videoSubscribe', name: dID,
        payload: { cameras: ids, full: i < o.full ? ids[0] : null },
      }, 'videoSubscribeSuccess');
      c.dID = dID;
      c.full = i < o.full ? ids[0] : null;
      clients.push(c);
    }

    await sleep(o.warmup * 1000); // запуск ffmpeg и первые кадры
    const before = processTree(server.pid);
    const t0 = Date.now();
    clients.forEach((c) => { c.measuring = true; });
    await sleep(o.duration * 1000);
    clients.forEach((c) => { c.measuring = false; });
    const elapsed = (Date.now() - t0) / 1000;
    const after = processTree(server.pid);
    const status = await clients[0].request({ type: 'get', request: 'videoStatus', name: clients[0].dID, payload: {} }, 'videoStatus');

    // ── Подсчёт ──
    let received = 0;
    let expected = 0;
    let bytes = 0;
    const latencies = [];
    const frameSizes = [];
    let fullMaxGap = 0;
    for (const c of clients) {
      for (let i = 0; i < n; i++) {
        const id = camId(i);
        const list = c.frames.get(id) || [];
        received += list.length;
        expected += (elapsed * 1000) / (c.full === id ? o.fullMs : o.previewMs);
        list.forEach((f) => { bytes += f.bytes; latencies.push(f.latency); frameSizes.push(f.size); });
        if (c.full === id) {
          for (let k = 1; k < list.length; k++) fullMaxGap = Math.max(fullMaxGap, list[k].t - list[k - 1].t);
        }
      }
    }
    const cams = status.payload.cameras || [];
    const cpuPct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? ((b - a) / elapsed) * 100 : null);
    return {
      cameras: n,
      clients: o.clients,
      delivered: received,
      expected: Math.round(expected),
      deliveredPct: expected ? (received / expected) * 100 : 0,
      latencyAvgMs: latencies.length ? latencies.reduce((s, x) => s + x, 0) / latencies.length : null,
      latencyP95Ms: pct(latencies, 95),
      latencyMaxMs: pct(latencies, 100),
      fullMaxGapMs: o.full > 0 ? fullMaxGap : null,
      kbPerSecPerClient: bytes / 1024 / elapsed / o.clients,
      frameKbAvg: frameSizes.length ? frameSizes.reduce((s, x) => s + x, 0) / frameSizes.length / 1024 : null,
      serverCpuPct: cpuPct(before?.server.cpu, after?.server.cpu),
      ffmpegCpuPct: cpuPct(before?.ffmpeg.cpu, after?.ffmpeg.cpu),
      ffmpegProcesses: after?.ffmpeg.count ?? null,
      serverRssMb: after ? after.server.rss / 1048576 : null,
      ffmpegRssMb: after ? after.ffmpeg.rss / 1048576 : null,
      skippedSlow: cams.reduce((s, c) => s + (c.skippedSlow || 0), 0),
      ffmpegRestarts: cams.reduce((s, c) => s + (c.ffmpegRestarts || 0), 0),
      camerasOnline: cams.filter((c) => c.status === 'online').length,
    };
  } catch (e) {
    e.serverLog = serverLog;
    throw e;
  } finally {
    clients.forEach((c) => c.ws.close());
    server.kill('SIGTERM');
    await new Promise((r) => { server.once('exit', r); setTimeout(r, 8000); });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const f1 = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d));

(async () => {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 22).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  console.log(
    `Видео: нагрузочная проверка — камеры ${o.cameras.join(', ')}, клиентов ${o.clients} (на полном экране ${o.full}), ` +
    `${o.duration} с, ffmpeg: ${o.ffmpeg}${o.ffmpeg === 'fake' ? ` (кадр ~${o.frameKb} КБ, без кодирования)` : `, источник ${o.size}@${o.rate}`}, ` +
    `миниатюры ${o.previewMs} мс, полный экран ${o.fullMs} мс, ядер CPU ${os.cpus().length}`
  );
  const results = [];
  for (const n of o.cameras) {
    process.stdout.write(`  ${n} камер… `);
    try {
      const r = await runOnce(n, o);
      results.push(r);
      console.log(`готово (доставлено ${f1(r.deliveredPct, 0)} %)`);
    } catch (e) {
      console.log(`ошибка: ${e.message}`);
      if (e.serverLog) console.log(e.serverLog.split('\n').slice(-15).join('\n'));
      process.exitCode = 1;
    }
  }
  if (!results.length) return;

  const head = ['Камер', 'Онлайн', 'Доставлено', 'Задержка ср/p95/max, мс', 'Разрыв full, мс', 'КБ/с на клиента',
    'Кадр, КБ', 'CPU сервер %', 'CPU ffmpeg %', 'RAM сервер/ffmpeg, МБ', 'Пропуски', 'Перезапуски'];
  const rows = results.map((r) => [
    r.cameras, `${r.camerasOnline}/${r.cameras}`, `${r.delivered}/${r.expected} (${f1(r.deliveredPct, 0)}%)`,
    `${f1(r.latencyAvgMs, 0)}/${f1(r.latencyP95Ms, 0)}/${f1(r.latencyMaxMs, 0)}`, f1(r.fullMaxGapMs, 0), f1(r.kbPerSecPerClient),
    f1(r.frameKbAvg), f1(r.serverCpuPct), f1(r.ffmpegCpuPct), `${f1(r.serverRssMb, 0)}/${f1(r.ffmpegRssMb, 0)}`,
    r.skippedSlow, r.ffmpegRestarts,
  ].map(String));
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  console.log(`\n${line(head)}\n|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|\n${rows.map(line).join('\n')}`);
  console.log('\nCPU % — от одного ядра (100 % = одно ядро полностью). Задержка — от кодирования кадра до получения клиентом.');
  console.log('Доставлено — от расчётного числа кадров за окно замера; на коротких замерах ниже 100 % из-за краёв окна (миниатюра раз в --preview-ms).');
  if (o.json) {
    fs.writeFileSync(o.json, JSON.stringify({ options: o, cpus: os.cpus().length, results }, null, 2));
    console.log(`Результаты: ${o.json}`);
  }
})();
