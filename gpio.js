const fs = require('fs');

// Функции для работы с GPIO
function gpioExport(pin) {
  try {
    fs.writeFileSync('/sys/class/gpio/export', pin.toString());
    console.log(`GPIO ${pin} успешно экспортирован`);
  } catch (err) {
    console.error(`Ошибка при экспорте GPIO ${pin}:`, err);
  }
}

function gpioSetDirection(pin, direction) {
  const directionPath = `/sys/class/gpio/gpio${pin}/direction`;
  try {
    fs.writeFileSync(directionPath, direction);
    console.log(`Направление GPIO ${pin} установлено в "${direction}"`);
  } catch (err) {
    console.error(`Ошибка при настройке направления GPIO ${pin}:`, err);
  }
}

function gpioReadValue(pin) {
  const valuePath = `/sys/class/gpio/gpio${pin}/value`;
  try {
    const value = fs.readFileSync(valuePath, 'utf8').trim();
    console.log(`GPIO ${pin} значение:`, value);
    return value;
  } catch (err) {
    console.error(`Ошибка при чтении GPIO ${pin}:`, err);
  }
}

function gpioWriteValue(pin, value) {
  const valuePath = `/sys/class/gpio/gpio${pin}/value`;
  try {
    fs.writeFileSync(valuePath, value.toString());
    console.log(`GPIO ${pin} установлен в`, value);
  } catch (err) {
    console.error(`Ошибка при записи GPIO ${pin}:`, err);
  }
}

function gpioUnexport(pin) {
  try {
    fs.writeFileSync('/sys/class/gpio/unexport', pin.toString());
    console.log(`GPIO ${pin} успешно освобожден`);
  } catch (err) {
    console.error(`Ошибка при освобождении GPIO ${pin}:`, err);
  }
}

// // Пример использования
// const gpioPin = 70; // Используйте правильный номер GPIO

// gpioExport(gpioPin); // Экспорт GPIO
// gpioSetDirection(gpioPin, 'out'); // Установка направления (вывод)

// // Установка значения GPIO
// gpioWriteValue(gpioPin, 1); // Включение
// setTimeout(() => {
//   gpioWriteValue(gpioPin, 0); // Выключение через 2 секунды
//   gpioUnexport(gpioPin); // Освобождение GPIO
// }, 1000);

module.exports = { gpioExport, gpioUnexport, gpioSetDirection, gpioReadValue, gpioWriteValue};