// configStore.test.js
// fs.promises подменяется целиком: тест проверяет вызовы, а не реальную запись на диск.
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: {
    access: jest.fn(),
    mkdir: jest.fn(),
    writeFile: jest.fn(),
    rename: jest.fn(),
    readFile: jest.fn(),
    unlink: jest.fn(),
  },
}));

const fs = require('fs').promises;
const path = require('path');
const { writeFileSafely, readFileSafely } = require('../../services/configStore');

const mockConfigData = {
  validConfig: {
    init: {
      title: 'Test Device Configuration',
      dID: 'test-device-123',
      limits: {
        Default: { low: 14, high: 30, step: 1 },
        Temp: { low: 8, high: 36, step: 0.5 },
        Hum: { low: 14, high: 60, step: 1 },
        Custom: { low: 0, high: 100, step: 5 },
      },
      settings: { autoUpdate: true, notifications: false },
    },
  },
  minimalConfig: {
    init: { title: '', dID: 'minimal-device', limits: { Default: { low: 14, high: 30, step: 1 } } },
  },
};

describe('ConfigStore Service', () => {
  const mockDID = 'thermostat-living-room';
  const mockDataDir = process.env.DATA_DIR;
  const mockFilePath = path.join(mockDataDir, `${mockDID}.json`);
  
  beforeEach(() => {
    jest.clearAllMocks();
    // Сбрасываем кэш перед каждым тестом
    require('../../services/configStore').fileCache.clear();
  });

  describe('writeFileSafely', () => {
    it('должен создавать директорию если она не существует', async () => {
      // Мокируем ENOENT ошибку для fs.access
      fs.access.mockRejectedValueOnce({ code: 'ENOENT' });
      fs.mkdir.mockResolvedValueOnce();
      fs.writeFile.mockResolvedValueOnce();
      fs.rename.mockResolvedValueOnce();

      const content = JSON.stringify(mockConfigData.validConfig);
      
      await writeFileSafely(mockFilePath, content);

      expect(fs.access).toHaveBeenCalledWith(mockDataDir);
      expect(fs.mkdir).toHaveBeenCalledWith(mockDataDir, { recursive: true });
    });

    it('должен записывать файл через временный файл', async () => {
      fs.access.mockResolvedValueOnce();
      fs.writeFile.mockResolvedValueOnce();
      fs.rename.mockResolvedValueOnce();

      const content = JSON.stringify(mockConfigData.validConfig);
      
      await writeFileSafely(mockFilePath, content);

      const tempPath = fs.writeFile.mock.calls[0][0];
      expect(tempPath.startsWith(`${mockFilePath}.`)).toBe(true);
      expect(tempPath.endsWith('.tmp')).toBe(true);
      expect(fs.writeFile).toHaveBeenCalledWith(tempPath, content);
      expect(fs.rename).toHaveBeenCalledWith(tempPath, mockFilePath);
    });

    it('параллельные записи в один файл идут по очереди и не делят временный файл', async () => {
      const events = [];
      fs.access.mockResolvedValue();
      fs.writeFile.mockImplementation(async (tmp) => {
        events.push(`write ${tmp}`);
        await new Promise((r) => setTimeout(r, 10));
      });
      fs.rename.mockImplementation(async (tmp) => { events.push(`rename ${tmp}`); });

      await Promise.all([
        writeFileSafely(mockFilePath, '{"n":1}'),
        writeFileSafely(mockFilePath, '{"n":2}'),
        writeFileSafely(mockFilePath, '{"n":3}'),
      ]);

      const tmps = fs.writeFile.mock.calls.map((c) => c[0]);
      expect(new Set(tmps).size).toBe(3);
      // каждая запись завершается rename до начала следующей
      expect(events).toEqual(tmps.flatMap((t) => [`write ${t}`, `rename ${t}`]));
      expect(require('../../services/configStore').fileCache.get(mockFilePath)).toEqual({ n: 3 });
    });
  });

  describe('readFileSafely', () => {
    it('должен возвращать данные из кэша если файл уже загружен', async () => {
      // Заполняем кэш напрямую
      const cache = require('../../services/configStore').fileCache;
      cache.set(mockFilePath, mockConfigData.validConfig);

      const result = await readFileSafely(mockDID);
      
      expect(fs.readFile).not.toHaveBeenCalled();
      expect(result.data).toEqual(mockConfigData.validConfig);
    });

    it('должен читать файл с диска если нет в кэше', async () => {
      fs.access.mockResolvedValueOnce();
      fs.readFile.mockResolvedValueOnce(JSON.stringify(mockConfigData.validConfig));

      const result = await readFileSafely(mockDID);

      expect(fs.readFile).toHaveBeenCalledWith(mockFilePath, 'utf8');
      expect(result.data).toEqual(mockConfigData.validConfig);
    });

    it('должен создавать файл с начальными данными если файл не существует', async () => {
      fs.access.mockResolvedValueOnce();
      fs.readFile.mockRejectedValueOnce({ code: 'ENOENT' });

      const result = await readFileSafely(mockDID);

      expect(result.data.init.dID).toBe(mockDID);
      expect(result.data.init.limits.Default).toEqual(
        { low: 8, high: 36, step: 1 }
      );
    });

    it('должен обрабатывать ошибки парсинга JSON', async () => {
      fs.access.mockResolvedValueOnce();
      fs.readFile.mockResolvedValueOnce('invalid json content');

      const result = await readFileSafely(mockDID);

      expect(result.data.init.dID).toBe(mockDID);
      expect(result.dataDir).toBe(mockDataDir);
      expect(result.filePath).toBe(mockFilePath);
    });

    it('должен возвращать dataDir и filePath в ответе', async () => {
      fs.access.mockResolvedValueOnce();
      fs.readFile.mockRejectedValueOnce({ code: 'ENOENT' });

      const result = await readFileSafely(mockDID);

      expect(result.dataDir).toBe(mockDataDir);
      expect(result.filePath).toBe(mockFilePath);
      expect(result.data.init.dID).toBe(mockDID);
    });
  });

  describe('Интеграционные тесты', () => {
    it('должен корректно работать цикл запись-чтение', async () => {
      fs.access.mockResolvedValue();
      fs.writeFile.mockResolvedValue();
      fs.rename.mockResolvedValue();
      fs.readFile.mockResolvedValue(JSON.stringify(mockConfigData.minimalConfig));

      const testData = mockConfigData.minimalConfig;
      const content = JSON.stringify(testData);
      
      await writeFileSafely(mockFilePath, content);
      const result = await readFileSafely(mockDID);
      
      expect(result.data).toEqual(testData);
    });

    it('должен использовать кэш для повторных чтений', async () => {
      fs.access.mockResolvedValueOnce();
      fs.readFile.mockResolvedValueOnce(JSON.stringify(mockConfigData.validConfig));

      const result1 = await readFileSafely(mockDID);
      const result2 = await readFileSafely(mockDID);

      expect(fs.readFile).toHaveBeenCalledTimes(1);
      expect(result1.data).toEqual(result2.data);
    });
  });

  describe('Обработка ошибок', () => {
    it('должен пробрасывать ошибки кроме ENOENT при создании директории', async () => {
      fs.access.mockRejectedValueOnce(new Error('Permission denied'));
      
      await expect(writeFileSafely(mockFilePath, '{}'))
        .rejects
        .toThrow('Permission denied');
    });

    it('должен пробрасывать ошибки при записи файла', async () => {
      fs.access.mockResolvedValueOnce();
      fs.writeFile.mockRejectedValueOnce(new Error('File system error'));

      await expect(writeFileSafely(mockFilePath, '{}'))
        .rejects
        .toThrow('File system error');
    });
  });

  describe('Тестирование с разными device IDs', () => {
    const testDeviceIDs = ['device-1', 'device-2', 'device-3'];
    
    testDeviceIDs.forEach((deviceId) => {
      it(`должен работать с device ID: ${deviceId}`, async () => {
        fs.access.mockResolvedValueOnce();
        fs.readFile.mockRejectedValueOnce({ code: 'ENOENT' });

        const result = await readFileSafely(deviceId);

        expect(result.data.init.dID).toBe(deviceId);
        expect(result.data.init.limits).toBeDefined();
      });
    });
  });
});
describe('ConfigStore: защита путей', () => {
  const store = require('../../services/configStore');
  const path = require('path');

  test.each(['../etc/passwd', 'a/b', '..', 'a b', '', undefined, 'x'.repeat(65)])(
    'readFileSafely отклоняет dID %j', async (did) => {
      await expect(store.readFileSafely(did, 'config')).rejects.toMatchObject({ code: 'BAD_DID' });
    }
  );

  test('resolveConfigPath отклоняет имя конфига с разделителями', () => {
    expect(() => store.resolveConfigPath('dev1', '../../evil')).toThrow(expect.objectContaining({ code: 'BAD_CONFIG_NAME' }));
  });

  test('writeFileSafely не пишет вне DATA_DIR', async () => {
    const outside = path.join(process.env.DATA_DIR, '..', 'evil.json');
    await expect(store.writeFileSafely(outside, '{}')).rejects.toMatchObject({ code: 'BAD_PATH' });
    const nested = path.join(process.env.DATA_DIR, 'sub', 'evil.json');
    await expect(store.writeFileSafely(nested, '{}')).rejects.toMatchObject({ code: 'BAD_PATH' });
  });

  test('допустимый dID даёт путь внутри DATA_DIR', () => {
    expect(store.resolveConfigPath('angey_bmax', 'schedules'))
      .toBe(path.join(process.env.DATA_DIR, 'angey_bmax_schedules.json'));
  });
});
