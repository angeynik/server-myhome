jest.useFakeTimers(); // Используем фейковые таймеры

test('watchGpio should detect state changes', () => {
  const pin = 70;
  const checkTime = 100;
  const debounceTime = 50;

  // Мокируем gpioReadValue
  const gpioReadValue = jest.fn()
    .mockReturnValueOnce('0') // Начальное состояние
    .mockReturnValueOnce('1') // Первое изменение
    .mockReturnValueOnce('1') // Состояние не изменилось
    .mockReturnValueOnce('0'); // Второе изменение

  const stopWatching = watchGpio(pin, checkTime, debounceTime, gpioReadValue);

  // Симулируем прохождение времени
  jest.advanceTimersByTime(checkTime);
  expect(gpioReadValue).toHaveBeenCalledTimes(1);

  jest.advanceTimersByTime(checkTime);
  expect(gpioReadValue).toHaveBeenCalledTimes(2);

  jest.advanceTimersByTime(checkTime);
  expect(gpioReadValue).toHaveBeenCalledTimes(3);

  stopWatching();
});