const fs = require('fs');

class GpioManager {
  constructor(deviceName, configPath) {
    this.deviceName = deviceName;
    this.configPath = configPath;
    this.config = this.loadConfig();
    if (this.config) {
      this.deviceConfig = this.initializeGpio();
    } else {
      this.deviceConfig = null;
    }
    this.watchers = []; // Для хранения функций остановки отслеживания
  }

  // Загрузка конфигурации из файла
  loadConfig() {
    try {
      const gpioConfigFile = fs.readFileSync(this.configPath, 'utf8');
      return JSON.parse(gpioConfigFile);
    } catch (err) {
      console.error('Ошибка при чтении конфигурационного файла:', err);
      return null;
    }
  }

  // Инициализация GPIO на основе конфигурации
  initializeGpio() {
    const deviceConfig = this.config[this.deviceName];
    if (!deviceConfig) {
      console.error(`Конфигурация для устройства "${this.deviceName}" не найдена.`);
      return null;
    }
    return deviceConfig;
  }

  gpioSetDirection(pin, direction) {
    const directionPath = `/sys/class/gpio/gpio${pin}/direction`;
    try {
      fs.writeFileSync(directionPath, direction);
      console.log(`Направление GPIO ${pin} установлено в "${direction}"`);
    } catch (err) {
      console.error(`Ошибка при настройке направления GPIO ${pin}:`, err);
    }
  }

  gpioExport(pin) {
    try {
      fs.writeFileSync('/sys/class/gpio/export', pin.toString());
      console.log(`GPIO ${pin} успешно экспортирован`);
    } catch (err) {
      console.error(`Ошибка при экспорте GPIO ${pin}:`, err);
    }
  }

  // Освобождение GPIO
  cleanupGpio() {
    if (!this.deviceConfig) return;

    // Освобождение всех пинов
    this.deviceConfig.outputPins.concat(this.deviceConfig.inputPins).forEach(pin => {
      try {
        if (fs.existsSync(`/sys/class/gpio/gpio${pin}`)) {
          fs.writeFileSync('/sys/class/gpio/unexport', pin.toString());
          console.log(`GPIO ${pin} успешно освобожден`);
        } else {
          console.log(`GPIO ${pin} уже освобожден или не существует`);
        }
      } catch (err) {
        console.error(`Ошибка при освобождении GPIO ${pin}:`, err);
      }
    });
  }

  // Настройка выходных пинов
  setupOutputPins() {
    if (!this.deviceConfig) return;

    this.deviceConfig.outputPins.forEach(pin => {
      this.gpioExport(pin);
      this.gpioSetDirection(pin, 'out');
      console.log(`GPIO ${pin} настроен как выход.`);
    });
  }

  // Настройка входных пинов
  setupInputPins() {
    if (!this.deviceConfig) return;

    this.deviceConfig.inputPins.forEach(pin => {
      this.gpioExport(pin);
      this.gpioSetDirection(pin, 'in');
      console.log(`GPIO ${pin} настроен как вход.`);
    });
  }

  // Установка значения на выходном пине
  writePin(pin, value) {
    const valuePath = `/sys/class/gpio/gpio${pin}/value`;
    try {
      if (fs.existsSync(`/sys/class/gpio/gpio${pin}`)) {
        fs.writeFileSync(valuePath, value.toString());
        console.log(`GPIO ${pin} установлен в`, value);
      } else {
        console.error(`GPIO ${pin} не существует или не экспортирован`);
      }
    } catch (err) {
      console.error(`Ошибка при записи GPIO ${pin}:`, err);
    }
  }

  // Чтение значения с входного пина
  readPin(pin) {
    const valuePath = `/sys/class/gpio/gpio${pin}/value`;
    try {
      if (fs.existsSync(valuePath)) {
        const value = fs.readFileSync(valuePath, 'utf8').trim();
        console.log(`GPIO ${pin} значение:`, value);
        return value;
      } else {
        console.error(`GPIO ${pin} не существует или не экспортирован`);
        return null;
      }
    } catch (err) {
      console.error(`Ошибка при чтении GPIO ${pin}:`, err);
      return null;
    }
  }

  // Отслеживание изменений состояния GPIO с дебаунсом
  watchPin(inputPin, checkTime = 500, debounceTime = 250) {
    if (!fs.existsSync(`/sys/class/gpio/gpio${inputPin}`)) {
      console.error(`GPIO ${inputPin} не существует или не экспортирован`);
      return null;
    }

    let previousValue = this.readPin(inputPin); // Сохраняем начальное состояние
    let lastChangeTime = 0; // Время последнего изменения состояния

    console.log(`Начальное состояние GPIO ${inputPin}:`, previousValue);

    // Периодическая проверка состояния
    const interval = setInterval(() => {
      const currentValue = this.readPin(inputPin); // Читаем текущее состояние
      const currentTime = Date.now(); // Текущее время

      // Проверяем, изменилось ли состояние и прошел ли дебаунс
      if (currentValue !== previousValue && currentTime - lastChangeTime > debounceTime) {
        console.log(`Состояние GPIO ${inputPin} изменилось:`, previousValue, '->', currentValue);
        previousValue = currentValue; // Обновляем предыдущее состояние
        lastChangeTime = currentTime; // Обновляем время последнего изменения
      }
    }, checkTime); // Интервал проверки (в миллисекундах)

    // Сохраняем функцию для остановки отслеживания
    const stopWatching = () => clearInterval(interval);
    this.watchers.push(stopWatching);

    return stopWatching;
  }

  // Остановка всех отслеживаний
  stopAllWatchers() {
    this.watchers.forEach(stop => stop());
    this.watchers = [];
  }
}

module.exports = GpioManager;

//module.exports = { gpioExport, gpioUnexport, gpioSetDirection, gpioReadValue, gpioWriteValue};

// const { gpioExport, gpioUnexport, gpioSetDirection, gpioReadValue, gpioWriteValue } = require('./gpio.js');