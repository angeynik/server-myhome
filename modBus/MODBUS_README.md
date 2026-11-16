# modBus/ — Modbus RTU

Инструкция по настройке (оборудование, порт, `modbusConf.json`, роли, проверка, неполадки):
**[docs/modbus-rtu.md](../docs/modbus-rtu.md)**.

## Состав

| Файл | Назначение |
|---|---|
| `modbusManager.js` | читает `modbusConf.json`, поднимает Master и/или Slave по `role` (или `MODBUS_ROLE`), не даёт `both` на одном порту |
| `modbusMaster.js` | Master: последовательный опрос устройств, запись по `id` устройства и имени регистра; все обращения к шине — через одну очередь |
| `modbusSlave.js` | Slave: отвечает внешнему Master, проверяет CRC входящих кадров, событие `write` при записи извне |
| `modbusUtils.js` | кодирование/декодирование регистров: типы, `scale`, `swapWords` |
| `modbusConf.example.json` | образец конфигурации со всеми полями |

К серверу подключается через `services/modbusRTUBridge.js` (`MODBUS_RTU_ENABLED=true`).

## Проверка CRC (Slave)

`ServerSerial` из `modbus-serial` не проверяет CRC входящих запросов — пересчитывает и записывает поверх.
`modbusSlave.js` встаёт перед его обработчиком: кадр с неверным CRC или короче 4 байт отбрасывается без
ответа (Master получит таймаут и повторит запрос), счётчик — `slave.stats.crcErrors`, событие — `crcError`.
Отключается `"crcCheck": false`. Если внутреннее устройство `ServerSerial` изменится (обновление
библиотеки), Slave не стартует с понятной ошибкой, а не будет молча работать без проверки.

## Тесты

`tests/modbusRTU/*.test.js`, `tests/unit/modbusRTUBridge.test.js`; без железа — `node tools/modbusRtuCheck.js`.
