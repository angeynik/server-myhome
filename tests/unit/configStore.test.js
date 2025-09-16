// configStore.test.js - исправленная версия
const fs = require('fs').promises;
const path = require('path');
const { writeFileSafely, readFileSafely } = require('../../services/configStore');

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

      const content = JSON.stringify(global.mockConfigData.validConfig);
      
      await writeFileSafely(mockFilePath, content);

      expect(fs.access).toHaveBeenCalledWith(mockDataDir);
      expect(fs.mkdir).toHaveBeenCalledWith(mockDataDir, { recursive: true });
    });

    it('должен записывать файл через временный файл', async () => {
      fs.access.mockResolvedValueOnce();
      fs.writeFile.mockResolvedValueOnce();
      fs.rename.mockResolvedValueOnce();

      const content = JSON.stringify(global.mockConfigData.validConfig);
      const tempPath = `${mockFilePath}.tmp`;
      
      await writeFileSafely(mockFilePath, content);

      expect(fs.writeFile).toHaveBeenCalledWith(tempPath, content);
      expect(fs.rename).toHaveBeenCalledWith(tempPath, mockFilePath);
    });
  });

  describe('readFileSafely', () => {
    it('должен возвращать данные из кэша если файл уже загружен', async () => {
      // Заполняем кэш напрямую
      const cache = require('../../services/configStore').fileCache;
      cache.set(mockFilePath, global.mockConfigData.validConfig);

      const result = await readFileSafely(mockDID);
      
      expect(fs.readFile).not.toHaveBeenCalled();
      expect(result.data).toEqual(global.mockConfigData.validConfig);
    });

    it('должен читать файл с диска если нет в кэше', async () => {
      fs.access.mockResolvedValueOnce();
      fs.readFile.mockResolvedValueOnce(JSON.stringify(global.mockConfigData.validConfig));

      const result = await readFileSafely(mockDID);

      expect(fs.readFile).toHaveBeenCalledWith(mockFilePath, 'utf8');
      expect(result.data).toEqual(global.mockConfigData.validConfig);
    });

    it('должен создавать файл с начальными данными если файл не существует', async () => {
      fs.access.mockResolvedValueOnce();
      fs.readFile.mockRejectedValueOnce({ code: 'ENOENT' });

      const result = await readFileSafely(mockDID);

      expect(result.data.init.dID).toBe(mockDID);
      expect(result.data.init.limits.Default).toEqual(
        global.mockConfigData.defaultConfig.init.limits.Default
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
      fs.readFile.mockResolvedValue(JSON.stringify(global.mockConfigData.minimalConfig));

      const testData = global.mockConfigData.minimalConfig;
      const content = JSON.stringify(testData);
      
      await writeFileSafely(mockFilePath, content);
      const result = await readFileSafely(mockDID);
      
      expect(result.data).toEqual(testData);
    });

    it('должен использовать кэш для повторных чтений', async () => {
      fs.access.mockResolvedValueOnce();
      fs.readFile.mockResolvedValueOnce(JSON.stringify(global.mockConfigData.validConfig));

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