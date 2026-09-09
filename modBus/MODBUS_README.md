# Modbus RTU сервис для serverapp.js (Orange Pi 3B / 3B 4G)

## Состав

```
modbus/
  modbusUtils.js    # кодирование/декодирование регистров (int16/uint16/int32/uint32/float32/bool, scale, swapWords)
  modbusMaster.js    # Master: последовательный опрос slave-устройств на шине
  modbusSlave.js      # Slave: Orange Pi отвечает на запросы внешнего Master
  modbusManager.js  # оркестратор: поднимает Master и/или Slave по modbusConf.json
modbusConf.example.json  # пример конфига (скопировать в modbusConf.json и отредактировать)
serverapp.js         # ваш файл с уже добавленной интеграцией
```

## 1. Установка зависимостей

```bash
npm install modbus-serial serialport
```

`serialport` — нативный модуль, собирается под ARM при установке. На Orange Pi нужны build-essential/python3:

```bash
sudo apt update && sudo apt install -y build-essential python3
```

## 2. Настройка UART на Orange Pi 3B (встроенный UART, без USB-переходника)

Вы выбрали встроенный UART через GPIO — учтите три момента, специфичных именно для этого варианта:

1. **UART нужно включить оверлеем.** По умолчанию нужные пины Orange Pi 3B часто заняты другими функциями. На Armbian это делается через `armbian-config` → System → Hardware → включить нужный `uartX`, либо вручную в `/boot/orangepiEnv.txt`:
   ```
   overlays=uart3
   ```
   (номер UART зависит от того, какие пины физически разведены под RS-485 на вашей плате/расширении — проверьте распиновку конкретно 3B, не 3B 4G, если есть отличия).

2. **Права доступа.** Node обычно не должен работать под root. Добавьте пользователя, от которого запускается сервис, в группу `dialout`:
   ```bash
   sudo usermod -aG dialout $USER
   ```
   либо создайте udev-правило.

3. **Направление передачи RS-485 (DE/RE).** Голый UART отдаёт только TX/RX — для RS-485 нужен приёмопередатчик (например, на MAX485/SP3485), а ему нужно вовремя переключать направление (TX/RX). Настоятельно рекомендуется **микросхема с автоматическим управлением направлением** (auto-flow-control, например MAX13487E) — переключение направления вручную из Node.js через GPIO ненадёжно: event loop не гарантирует переключение с точностью до микросекунд, что на скорости 9600–19200 бод почти всегда обрезает первый/последний байт кадра. Если у вас уже есть модуль без автонаправления и придётся управлять DE/RE вручную через GPIO — это отдельная, более сложная задача (на уровне драйвера/нативного биндинга), дайте знать, разберём отдельно.

## 3. Режим "обе роли" (Master + Slave) — важное ограничение

Modbus RTU — это half-duplex шина с одним ведущим. **Master и Slave не могут делить один физический serial-порт** — либо конфликт при открытии порта, либо (что хуже) оба будут пытаться разобрать одни и те же байты на шине как «свои», что приведёт к постоянным ошибкам кадров.

Поэтому в `modbusConf.json` у `master.port` и `slave.port` должны быть **разные интерфейсы**, например:
- `master.port` — встроенный UART (`/dev/ttyS3`) для опроса ваших датчиков/контроллеров;
- `slave.port` — отдельный USB-RS485 переходник (`/dev/ttyUSB0`) для шины, на которой Orange Pi сам является ведомым устройством для внешнего PLC/SCADA.

`modbusManager.js` при старте с ролью `"both"` проверяет это и **бросает ошибку**, если оба порта совпадают (если вы точно понимаете, что делаете — можно обойти флагом `"allowSharedPort": true`, но это нестандартный и рискованный сценарий).

Если оба порта у вас физически совпадают (то есть реально только один UART), возможные варианты:
- держать только одну роль (`"role": "master"` или `"role": "slave"`) на этом порту;
- добавить USB-RS485 переходник под вторую роль (недорого и снимает проблему полностью).

## 4. Конфигурация modbusConf.json

Скопируйте `modbusConf.example.json` → `modbusConf.json`, впишите свои устройства/регистры. Ключевые поля:

- `role`: `"master"` | `"slave"` | `"both"` (можно переопределить переменной окружения `MODBUS_ROLE`)
- `master.devices[].registers[]`: `name`, `type` (`holding`/`input`/`coil`/`discrete`), `address`, `dataType` (`bool`/`int16`/`uint16`/`int32`/`uint32`/`float32`), опционально `scale` и `swapWords` (для 32-битных типов, если устройство отдаёт слова в обратном порядке)
- `slave.registerMap[]`: то же самое + `initial` (начальное значение) — что видит внешний Master, пока Orange Pi не обновит значение через `modbusManager.updateSlaveValueByName(...)`

## 5. Переменные окружения (conf.env)

```
MANAGE_MODBUS=true       # включить сервис (по аналогии с MANAGE_DOOR)
MODBUS_ROLE=both         # необязательно, переопределяет "role" из modbusConf.json
```

## 6. Что уже подключено в serverapp.js

- при `MANAGE_MODBUS=true` поднимается `ModbusManager('./modbusConf.json')`
- новые показания от Master уходят в `broadcast()` — так же, как остальные данные приложения (GPIO, БД) — Dashboard и NodeRED получают их без доработок на своей стороне
- запись во внешние Modbus-устройства доступна с Dashboard командой:
  ```json
  { "type": "post", "request": "modbusWrite", "name": "boiler1",
    "payload": { "item_name": "pump_state", "item_value": true } }
  ```
- если внешний Master (в режиме Slave) что-то пишет в Orange Pi — это тоже уходит в `broadcast()` с `request: 'modbusSlaveWrite'`
- при остановке сервера (SIGINT/SIGTERM) serial-порт(ы) закрываются корректно

## 7. Как передать данные с GPIO/БД во внешний Modbus-сервер (роль Slave)

Там, где у вас в `serverapp.js` обновляется состояние GPIO-датчика (`gpioManager.watchPin` и т.п.), добавьте вызов:

```js
if (modbusManager) {
  modbusManager.updateSlaveValueByName('door_sensor', newState);
}
```

Значение сразу станет видно внешнему Modbus Master при следующем опросе — никакого дополнительного опроса/поллинга с нашей стороны не требуется, чтение полностью пассивное.
