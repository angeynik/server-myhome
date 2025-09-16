const fs = require('fs');
const GpioManager = require('../../gpio.js');

jest.mock('fs');

describe('GpioManager', () => {
  let gpioManager;

  const mockConfig = {
    device1: {
      outputPins: [1, 2],
      inputPins: [3, 4],
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    fs.readFileSync.mockReturnValue(JSON.stringify(mockConfig));
    gpioManager = new GpioManager('device1', '../gpioConf.json');
  });

  describe('loadConfig', () => {
    it('должен загружать конфигурацию из файла', () => {
      expect(gpioManager.config).toEqual(mockConfig);
      expect(fs.readFileSync).toHaveBeenCalledWith('../gpioConf.json', 'utf8');
    });

    it('должен возвращать null при ошибке чтения файла', () => {
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Ошибка чтения файла');
      });

      const manager = new GpioManager('device1', '../gpioConf.json');
      expect(manager.config).toBeNull();
      expect(manager.deviceConfig).toBeNull();
    });
  });

  describe('initializeGpio', () => {
    it('должен возвращать конфигурацию устройства', () => {
      expect(gpioManager.deviceConfig).toEqual(mockConfig.device1);
    });

    it('должен возвращать null, если устройство не найдено', () => {
      const manager = new GpioManager('unknownDevice', '../gpioConf.json');
      expect(manager.deviceConfig).toBeNull();
    });

    it('должен возвращать null, если конфигурация не загружена', () => {
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Ошибка чтения файла');
      });

      const manager = new GpioManager('device1', '../gpioConf.json');
      expect(manager.deviceConfig).toBeNull();
    });
  });

  // Остальные тесты остаются без изменений
  describe('gpioExport', () => {
    it('должен экспортировать пин', () => {
      gpioManager.gpioExport(1);
      expect(fs.writeFileSync).toHaveBeenCalledWith('/sys/class/gpio/export', '1');
    });

    it('должен логировать ошибку при экспорте', () => {
      fs.writeFileSync.mockImplementation(() => {
        throw new Error('Ошибка экспорта');
      });

      gpioManager.gpioExport(1);
      expect(fs.writeFileSync).toHaveBeenCalledWith('/sys/class/gpio/export', '1');
    });
  });

  describe('gpioSetDirection', () => {
    it('должен устанавливать направление пина', () => {
      gpioManager.gpioSetDirection(1, 'out');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/sys/class/gpio/gpio1/direction',
        'out'
      );
    });

    it('должен логировать ошибку при установке направления', () => {
      fs.writeFileSync.mockImplementation(() => {
        throw new Error('Ошибка установки направления');
      });

      gpioManager.gpioSetDirection(1, 'out');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/sys/class/gpio/gpio1/direction',
        'out'
      );
    });
  });

  describe('writePin', () => {
    it('должен записывать значение на пин', () => {
      fs.existsSync.mockReturnValue(true);
      gpioManager.writePin(1, 1);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/sys/class/gpio/gpio1/value',
        '1'
      );
    });

    it('должен логировать ошибку, если пин не существует', () => {
      fs.existsSync.mockReturnValue(false);
      gpioManager.writePin(1, 1);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('readPin', () => {
    it('должен читать значение с пина', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('1');

      const value = gpioManager.readPin(1);
      expect(value).toBe('1');
      expect(fs.readFileSync).toHaveBeenCalledWith(
        '/sys/class/gpio/gpio1/value',
        'utf8'
      );
    });

    it('должен возвращать null, если пин не существует', () => {
      fs.existsSync.mockReturnValue(false);
      const value = gpioManager.readPin(1);
      expect(value).toBeNull();
    });
  });

  describe('watchPin', () => {
    it('должен отслеживать изменения состояния пина', () => {
      jest.useFakeTimers();

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValueOnce('0').mockReturnValueOnce('1');

      const stopWatching = gpioManager.watchPin(1);
      jest.advanceTimersByTime(1000);

      expect(stopWatching).toBeDefined();
      stopWatching();
    });
  });

  describe('cleanupGpio', () => {
    it('должен освобождать все пины', () => {
      fs.existsSync.mockReturnValue(true);
      gpioManager.cleanupGpio();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/sys/class/gpio/unexport',
        '1'
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/sys/class/gpio/unexport',
        '2'
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/sys/class/gpio/unexport',
        '3'
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/sys/class/gpio/unexport',
        '4'
      );
    });
  });
});