// tests/unit/videoConfig.test.js
// Загрузка и проверка списка камер (cameras.json).
'use strict';

const { loadCameras, MAX_CAMERAS } = require('../../services/videoConfig');

const env = (extra = {}) => ({ DATA_DIR: '/data', VIDEO_DID: 'd1', ...extra });
const fromJson = (obj, extra) => loadCameras(env(extra), { readFile: () => JSON.stringify(obj) });
const missing = () => { const e = new Error('нет файла'); e.code = 'ENOENT'; throw e; };

describe('videoConfig.loadCameras', () => {
  test('файл по умолчанию — $DATA_DIR/cameras.json; поля по умолчанию', () => {
    let read = null;
    const res = loadCameras(env(), { readFile: (f) => { read = f; return JSON.stringify({ cameras: [{ id: 'cam01', source: 'test' }] }); } });
    expect(read).toBe('/data/cameras.json');
    expect(res.errors).toEqual([]);
    expect(res.cameras[0]).toEqual({
      id: 'cam01', title: 'cam01', source: 'test', dID: 'd1', minLevel: 1,
      previewIntervalMs: 5000, fullIntervalMs: 1000, maxWidth: 640, quality: 3, archive: false,
      test: { size: '1280x720', rate: 10, noise: 20 },
    });
  });

  test('defaults применяются ко всем камерам, поля камеры важнее', () => {
    const res = fromJson({
      defaults: { dID: 'house', minLevel: 2, previewIntervalMs: 3000 },
      cameras: [{ id: 'a', source: 'test' }, { id: 'b', source: 'rtsp://u:p@h/s', minLevel: 3 }],
    });
    expect(res.cameras.map((c) => [c.id, c.dID, c.minLevel, c.previewIntervalMs])).toEqual([
      ['a', 'house', 2, 3000], ['b', 'house', 3, 3000],
    ]);
  });

  test('не больше 16 камер: лишние пропускаются с ошибкой', () => {
    const cameras = Array.from({ length: 18 }, (_, i) => ({ id: `c${i}`, source: 'test' }));
    const res = fromJson({ cameras });
    expect(res.cameras).toHaveLength(MAX_CAMERAS);
    expect(res.errors.filter((e) => /больше 16/.test(e))).toHaveLength(2);
  });

  test.each([
    [{ id: 'bad id', source: 'test' }, /id/],
    [{ id: 'a', source: 'http://x' }, /source/],
    [{ id: 'a', source: 'test', dID: '../x' }, /dID/],
  ])('некорректная камера %j пропускается', (cam, re) => {
    const res = fromJson({ cameras: [cam, { id: 'ok', source: 'test' }] });
    expect(res.cameras.map((c) => c.id)).toEqual(['ok']);
    expect(res.errors.some((e) => re.test(e))).toBe(true);
  });

  test('повторяющийся id и enabled:false', () => {
    const res = fromJson({ cameras: [{ id: 'a', source: 'test' }, { id: 'a', source: 'test' }, { id: 'b', source: 'test', enabled: false }] });
    expect(res.cameras.map((c) => c.id)).toEqual(['a']);
    expect(res.errors.some((e) => /повторяющийся/.test(e))).toBe(true);
  });

  test('интервалы и качество ограничены снизу/сверху', () => {
    const res = fromJson({ cameras: [{ id: 'a', source: 'test', previewIntervalMs: 10, fullIntervalMs: 50, quality: 99, test: { size: 'huge', rate: 500 } }] });
    expect(res.cameras[0]).toMatchObject({ previewIntervalMs: 5000, fullIntervalMs: 1000, quality: 3, test: { size: '1280x720', rate: 10 } });
  });

  test('нет файла — одна камера из VIDEO_RTSP_URL (прежний режим) с архивом', () => {
    const res = loadCameras(env({ VIDEO_RTSP_URL: 'rtsp://u:p@h/s' }), { readFile: missing });
    expect(res.legacy).toBe(true);
    expect(res.cameras).toEqual([expect.objectContaining({ id: 'cam1', source: 'rtsp://u:p@h/s', archive: true })]);
  });

  test('нет файла и VIDEO_RTSP_URL — создаётся cameras.json с 4 муляжами', () => {
    const writeFile = jest.fn();
    const res = loadCameras(env(), { readFile: missing, writeFile });
    expect(res).toMatchObject({ errors: [], legacy: false, created: true });
    expect(res.cameras.map((c) => c.id)).toEqual(['cam01', 'cam02', 'cam03', 'cam04']);
    expect(res.cameras.every((c) => c.source === 'test' && c.archive === false)).toBe(true);
    const [file, data] = writeFile.mock.calls[0];
    expect(file).toBe(res.file);
    expect(data.cameras[0]).toMatchObject({ id: 'cam01', title: 'Камера 1 (муляж)', source: 'test' });
    expect(data.defaults.dID).toBe(res.cameras[0].dID);
  });

  test('VIDEO_MOCK_CAMERAS задаёт число муляжей (до 16), 0 — без камер и без файла', () => {
    const writeFile = jest.fn();
    expect(loadCameras(env({ VIDEO_MOCK_CAMERAS: '16' }), { readFile: missing, writeFile }).cameras).toHaveLength(16);
    expect(loadCameras(env({ VIDEO_MOCK_CAMERAS: '40' }), { readFile: missing, writeFile }).cameras).toHaveLength(16);
    writeFile.mockClear();
    expect(loadCameras(env({ VIDEO_MOCK_CAMERAS: '0' }), { readFile: missing, writeFile })).toMatchObject({ cameras: [], errors: [] });
    expect(writeFile).not.toHaveBeenCalled();
  });

  test('файл не создаётся — муляжи работают из памяти, ошибка в errors', () => {
    const res = loadCameras(env(), { readFile: missing, writeFile: () => { throw new Error('EACCES'); } });
    expect(res.cameras).toHaveLength(4);
    expect(res.created).toBe(false);
    expect(res.errors[0]).toMatch(/EACCES/);
  });

  test('битый JSON — ошибка, камер нет', () => {
    const res = loadCameras(env(), { readFile: () => '{ не json' });
    expect(res.cameras).toEqual([]);
    expect(res.errors).toHaveLength(1);
  });
});
