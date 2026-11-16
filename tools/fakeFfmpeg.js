#!/usr/bin/env node
// tools/fakeFfmpeg.js
//
// Подмена ffmpeg для проверки видеоцепочки на машине без ffmpeg: FFMPEG_PATH=tools/fakeFfmpeg.js.
// Понимает аргументы, которые строит services/videoStreamService.buildFfmpegArgs:
//   частота — из фильтра fps=1000/<мс> в -vf; остальное игнорируется.
// Пишет в stdout поток MJPEG: кадры SOI (FF D8) … EOI (FF D9) размером ~FAKE_FFMPEG_FRAME_KB КБ
// (по умолчанию 60, разброс ±15 %), внутри кадра байт 0xFF не встречается — разбор кадров честный.
// Это НЕ настоящий JPEG (браузер его не покажет) и НЕ нагрузка кодирования: для неё нужен ffmpeg.
//
// Переменные: FAKE_FFMPEG_FRAME_KB — средний размер кадра, FAKE_FFMPEG_FAIL_AFTER_MS — завершиться
// с ошибкой через N мс (проверка перезапуска), FAKE_FFMPEG_SILENT=1 — не выдавать кадры (проверка watchdog).
'use strict';

const args = process.argv.slice(2);
const vf = args[args.indexOf('-vf') + 1] || '';
const fpsMatch = /fps=1000\/(\d+)/.exec(vf);
const intervalMs = fpsMatch ? Number(fpsMatch[1]) : 1000;
const frameKb = Number(process.env.FAKE_FFMPEG_FRAME_KB) || 60;

function makeFrame(seq) {
  const size = Math.max(64, Math.round(frameKb * 1024 * (0.85 + Math.random() * 0.3)));
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + seq * 7) & 0xfe; // без 0xFF
  buf[0] = 0xff; buf[1] = 0xd8;
  buf[size - 2] = 0xff; buf[size - 1] = 0xd9;
  return buf;
}

process.stderr.write(`fake ffmpeg: кадр ${frameKb} КБ каждые ${intervalMs} мс\n`);

let seq = 0;
const timer = process.env.FAKE_FFMPEG_SILENT === '1'
  ? null
  : setInterval(() => process.stdout.write(makeFrame(seq++)), intervalMs);

if (process.env.FAKE_FFMPEG_FAIL_AFTER_MS) {
  setTimeout(() => {
    process.stderr.write('fake ffmpeg: Connection failed\n');
    process.exit(1);
  }, Number(process.env.FAKE_FFMPEG_FAIL_AFTER_MS));
}

const stop = () => {
  if (timer) clearInterval(timer);
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdout.on('error', stop); // сервер закрыл канал
