# server-myhome

Сервер умного дома: WebSocket-обмен с клиентом Vue 3 (Dashboard) и NodeRED, опрос устройств по Modbus TCP,
видеонаблюдение (RTSP → снимки и архив в S3), оповещения в Telegram, управление замком через GPIO.
Протокол обмена, права доступа и правила разработки — в [rules.md](rules.md).

## Запуск

```bash
npm ci
cp conf_example conf.env   # заполнить JWT_SECRET, порты, Modbus, видео, Telegram
npm start                  # node serverapp.js
npm run dev                # то же под nodemon (перезапуск при изменении кода)
```

Каталоги данных (в git не попадают): `data/` — пользователи и ключ шифрования,
`.configData/` (`DATA_DIR`) — конфигурации dID и `modbusMap.json`, `tmp/` — видеоархив до выгрузки.

## Тесты

```bash
npm test
```

## Инструкции

- [docs/modbus-tcp.md](docs/modbus-tcp.md) — Modbus TCP: контроллер по сети, карта тегов, эмулятор, диагностика.
- [docs/modbus-rtu.md](docs/modbus-rtu.md) — Modbus RTU: RS-485, роли Master/Slave, `modbusConf.json`, проверка без железа.
- [docs/cameras.md](docs/cameras.md) — видеокамеры и муляжи.

## Инструменты

- `node tools/modbusSlaveEmulator.js --port 5020 [--jitter]` — эмулятор Modbus TCP-устройства по `modbusMap.json`
  (консольные команды `list`, `get`, `set`, `jitter on|off`). Для работы сервера с ним:
  `MODBUS_DEVICES='[{"id":"pr205","host":"127.0.0.1","port":5020,"unitId":1}]'`.
- `node tools/modbusDiag.js --host 192.168.10.5 [--port 502] [--unit 1]` — прочитать все теги карты
  с устройства (или эмулятора) и показать сырые регистры и значения.
- Камеры и муляжи: [docs/cameras.md](docs/cameras.md) — при первом запуске без камер создаётся `cameras.json` с 4 муляжами.
- `node tools/videoLoadTest.js [--cameras 1,4,8,16] [--clients 2] [--duration 30]` — нагрузочная проверка видео:
  сервер с N тестовыми камерами (ffmpeg генерирует картинку) и M клиентами; доставка, задержка, трафик, CPU и память.
  Без ffmpeg — `--ffmpeg fake` (проверка цепочки и сети, без нагрузки кодирования).
- `node scripts/authAdmin.js` — администрирование пользователей из консоли.
- `node tools/modbusRtuCheck.js [master|crc|manager]` — проверка Modbus RTU без железа на виртуальных портах
  (`tools/ptyPair.py`, нужен python3).
- `modBus/` — Modbus RTU (Master/Slave по RS-485), включается `MODBUS_RTU_ENABLED=true`: см. [docs/modbus-rtu.md](docs/modbus-rtu.md).

## История

Release v.0.0.2 - 20.11.25

server_Igumem - 9.11.26
Реализован механизм опроса устройств по сети modbus и передача данных на сторону клиента

План текущий Main -
Добален сервис рассылки сообщений через Telegram
Добавлен сервис обработки видеосообщений и рассылки на веб приложение и в Telegram
