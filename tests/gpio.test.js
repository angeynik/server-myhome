const { gpioExport, gpioUnexport, gpioSetDirection, gpioReadValue, gpioWriteValue } = require('../src/gpio');
const fs = require('fs');

// Мокируем модуль fs
jest.mock('fs');

describe('GPIO Functions', () => {
  beforeEach(() => {
    // Очищаем все моки перед каждым тестом
    jest.clearAllMocks();
  });

  test('gpioExport should write to export file', () => {
    const pin = 70;
    gpioExport(pin);
    expect(fs.writeFileSync).toHaveBeenCalledWith('/sys/class/gpio/export', pin.toString());
  });

  test('gpioUnexport should write to unexport file', () => {
    const pin = 70;
    gpioUnexport(pin);
    expect(fs.writeFileSync).toHaveBeenCalledWith('/sys/class/gpio/unexport', pin.toString());
  });

  test('gpioSetDirection should write to direction file', () => {
    const pin = 70;
    const direction = 'out';
    gpioSetDirection(pin, direction);
    expect(fs.writeFileSync).toHaveBeenCalledWith(`/sys/class/gpio/gpio${pin}/direction`, direction);
  });

  test('gpioReadValue should read from value file', () => {
    const pin = 70;
    fs.readFileSync.mockReturnValue('1'); // Мокируем возвращаемое значение
    const value = gpioReadValue(pin);
    expect(fs.readFileSync).toHaveBeenCalledWith(`/sys/class/gpio/gpio${pin}/value`, 'utf8');
    expect(value).toBe('1');
  });

  test('gpioWriteValue should write to value file', () => {
    const pin = 70;
    const value = 1;
    gpioWriteValue(pin, value);
    expect(fs.writeFileSync).toHaveBeenCalledWith(`/sys/class/gpio/gpio${pin}/value`, value.toString());
  });
});