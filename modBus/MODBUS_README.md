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

- `role`: `"master"` | `"slave"` | `"both"` (можно переопределить переменной окружения `MODBUS_ROLE`; по умолчанию `slave`)
- `slave.unitId` (или `unitID`): адрес нашего Slave на шине, по умолчанию 21
- `master.devices[].registers[]`: `name`, `type` (`holding`/`input`/`coil`/`discrete`), `address`, `dataType` (`bool`/`int16`/`uint16`/`int32`/`uint32`/`float32`), опционально `scale` и `swapWords` (для 32-битных типов, если устройство отдаёт слова в обратном порядке)
- `slave.registerMap[]`: то же самое + `initial` (начальное значение) — что видит внешний Master, пока Orange Pi не обновит значение через `modbusManager.updateSlaveValueByName(...)`

## 5. Подключение к serverapp.js

Включается в `conf.env`:
```
MODBUS_RTU_ENABLED=true
MODBUS_RTU_CONF=./modBus/modbusConf.json   # путь к конфигу (по умолчанию этот)
#MODBUS_ROLE=both                          # переопределяет "role" из конфига
```
Связку с сервером выполняет `services/modbusRTUBridge.js` (аналог моста Modbus TCP):
- значения опроса Master уходят в Vue как `post` в формате NodeRED (`request` из поля регистра, по умолчанию `sensors`;
  `room` — регистра или устройства) и сохраняются в конфиг `dID` через общую очередь. Повтор без изменений
  (с учётом `deadband`) клиентам не рассылается, раз в минуту только перезаписывается в файл;
- команда Vue (`post` с тем же `name`/`request`/`room`/`item_name`, для уставок — `setKey`) на регистр с
  `"writable": true` (coil/holding) пишется в устройство и подтверждается рассылкой; иначе — `error/modbusWriteError`
  с кодом `READ_ONLY`, ошибка шины — `MODBUS_ERROR`;
- запись внешнего Master в наш Slave уходит в Vue текущим декодированным значением тега (`request` по умолчанию `system`).

Дополнительные поля регистра: `request`, `item_type` (`num` | `bool`), `writable`, `deadband`, `room`, `title`, `group`.
`dID` устройства и Slave должен быть допустимым (`^[A-Za-z0-9_-]{1,64}$`), иначе теги пропускаются.
Ошибка RTU (нет порта, неверный конфиг) пишется в лог и не мешает работе остального сервера.

## Проверка контрольной суммы (CRC)

`ServerSerial` из `modbus-serial` не проверяет CRC входящих запросов — пересчитывает и записывает поверх.
`modbusSlave.js` встаёт перед его обработчиком: кадр с неверным CRC или короче 4 байт отбрасывается без ответа
(Master получит таймаут и повторит запрос), счётчик — `slave.stats.crcErrors`, событие — `crcError`.
Отключить можно `"crcCheck": false` в секции `slave`. Если внутреннее устройство `ServerSerial` изменится
(обновление библиотеки), Slave не стартует с понятной ошибкой, а не будет молча работать без проверки.
Ответы Slave проверяет сама библиотека на стороне Master (`CRC error`).

## Проверка без железа

```bash
node tools/modbusRtuCheck.js            # все сценарии: master, crc, manager
node tools/modbusRtuCheck.js crc        # только CRC
```
Виртуальные порты создаёт `tools/ptyPair.py` (нужен python3, Linux/macOS).

## 6. Формат событий Master

Событие `data` на каждое прочитанное значение:
```json
{ "dID": "boiler1", "type": "post", "request": "modbusUpdate",
  "payload": { "room": "boiler_room", "item_name": "temperature", "item_value": 21.5 } }
```

## 7. Как передать данные с GPIO/БД во внешний Modbus-сервер (роль Slave)

Там, где у вас в `serverapp.js` обновляется состояние GPIO-датчика (`gpioManager.watchPin` и т.п.), добавьте вызов:

```js
modbusRtuBridge.setSlaveValue('door_sensor', newState);
```

Значение сразу станет видно внешнему Modbus Master при следующем опросе — никакого дополнительного опроса/поллинга с нашей стороны не требуется, чтение полностью пассивное.
