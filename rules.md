# Инструкции для проекта serverApp

## Стек и окружение
- Node.js 20+ (глобальный `fetch`; joi 18, @aws-sdk и serialport требуют 20+), системный `ffmpeg` для видео, CommonJS: `require` / `module.exports`, в каждом модуле `'use strict'`.
- Express используется только как HTTP-сервер (`SERVER_PORT`) с CORS. Весь обмен данными идёт по WebSocket (библиотека `ws`), см. раздел «Обмен данными по WebSocket». HTTP-эндпоинты для обмена данными не добавлять.
- Настройки только из `conf.env` (dotenv). Переменная, заданная в окружении терминала, перекрывает `conf.env` — при старте сервер пишет в лог их имена (`ENV_OVERRIDES` в `authConfig`). Новый параметр: читать в `services/authConfig.js`, `notifyConfig.js` или `videoConfig.js`, задавать значение по умолчанию, описывать в `conf.env`.
- Секреты (`JWT_SECRET`, `AUTH_MASTER_KEY`, `TELEGRAM_BOT_TOKEN`, пароли, ключи S3, пароль RTSP) хранятся только в окружении. В логи, ответы клиентам и сообщения об ошибках не попадают.

## Стиль кода
- ES6+, `async/await`, отступ 2 пробела, одинарные кавычки, точки с запятой.
- Только `let` и `const`, `var` не использовать.
- Комментарии на русском и по делу: шапка модуля (назначение, формат данных) и неочевидные решения. Закомментированный код не оставлять.
- jQuery, DOM API и браузерные объекты не использовать.

## Логирование
- Логирование сервера — через `services/logger.js`: `logInfoMessage`, `logDevMessage`, `logErrorMessage` (исключение — `console.*` пользователя, см. ниже). Формат: `[Модуль] - функция - сообщение`. Функции принимают несколько аргументов (объекты выводятся через `util.inspect`).
- Уровень `LOG_LEVEL`: `error` — только ошибки; `info` (по умолчанию) и `production` — ошибки и info; `dev` — всё; `none` — ничего (только для тестов). Каждый уровень включает более важные, поэтому ошибки вне тестов пишутся всегда.
- Вызовы `console.*` (отладочный вывод) добавляет и удаляет только пользователь. Claude их не добавляет, не удаляет и не переводит на `logger.js`; при ревью и правках проверяет только корректность их работы (не роняют процесс, не выводят секреты, не мешают тестам). Собственные сообщения Claude пишет через `logger.js`.
- Сырые входящие сообщения логировать только через `logger.redactSecrets()` (маскирует `password`, `oldPassword`, `newPassword`, `token`).

## Структура проекта
- `serverapp.js` — точка входа: Express, WS-серверы, маршрутизация сообщений. Бизнес-логики не содержит.
- `services/` — бизнес-логика: `auth`, `authConfig`, `userStore`, `notifyConfig`, `notifyService`, `telegramService`, `videoConfig`, `videoStreamService` (одна камера), `videoHub` (камеры, подписки, доставка), `messageHandlers`, `messageStore`, `configStore`, `validate`, `logger`, `modbusTCPBridge`, `modbusRTUBridge`.
- `classes/` — классы: `wsManager`, `modBusTCPManager`, `telegramBot`.
- `scripts/` — CLI администрирования (`authAdmin.js`).
- `tools/` — инструменты разработчика, не загружаются сервером: `modbusSlaveEmulator.js` (эмулятор Modbus TCP-устройства), `modbusDiag.js` (чтение всех тегов карты с устройства), `modbusRtuCheck.js` + `ptyPair.py` (проверка Modbus RTU на виртуальных портах), `videoLoadTest.js` + `fakeFfmpeg.js` (нагрузочная проверка видео без камер).
- `modBus/` — Modbus RTU (`modbusMaster`, `modbusSlave`, `modbusManager`, `modbusUtils`), к серверу подключается через `services/modbusRTUBridge.js` при `MODBUS_RTU_ENABLED=true` (конфиг `MODBUS_RTU_CONF`). Все обращения Master к шине идут через одну очередь: на RS-485 запросы не должны пересекаться. Slave проверяет CRC входящих кадров и отбрасывает искажённые без ответа.
- `gpio.js` — GPIO через sysfs (замок, датчики двери), включается `MANAGE_DOOR`.
- `tests/` — Jest: `unit/<модуль>.test.js`, `integration/*.integration.js`, `modbusRTU/*.test.js`, общий `setup.js`, помощники в `helpers/`.
- Сервис с зависимостями оформляется как фабрика `createXService(deps)` плюс синглтон-обёртка. Так его можно тестировать с фейками.

## Обмен данными по WebSocket

Весь обмен между NodeRED и сервером и между клиентом (Vue 3) и сервером идёт только по WebSocket. Внешние каналы (Telegram Bot API, S3, RTSP-камера) подключаются только через свои сервисы.

### Каналы
| Канал | Порт (env, по умолчанию) | Клиент | Аутентификация | Heartbeat (ping / таймаут) |
|---|---|---|---|---|
| Dashboard | `WSD_PORT_IN` (9202) | Vue 3 | JWT-сессия: `auth/login` или `auth/resume` | 180 с / 370 с |
| NodeRED | `WSR_PORT_IN` (9200) на `WSR_HOST` (127.0.0.1), включается `NODERED_ENABLED` | NodeRED | нет (доверенный канал) | 240 с / 500 с |

- Порт NodeRED не защищён токеном (`AUTH_STRICT` пока не реализован), поэтому по умолчанию слушает только `127.0.0.1` (`WSR_HOST`). Если NodeRED работает на другой машине, задать `WSR_HOST` адресом внутреннего интерфейса и ограничить доступ файрволом.
- Соединение регистрируется в `wsManager` (`VUE_connections`, `nRED_connections`) и получает `clientId`. Сессия Vue привязана к `clientId` и удаляется при закрытии соединения.
- Получатели рассылок определяются по `dID` соединения. `dID` ставится при `auth/login` или `auth/resume` (Vue) и из первого сообщения (NodeRED). Соединение без `dID` рассылок не получает.

### Формат сообщения
Текстовый кадр JSON (UTF-8), бинарные кадры не используются:
```
{ "type": "...", "request": "...", "name": "<dID>", "payload": { ... }, "time": "..." }
```
- `type` — класс сообщения (см. ниже), `request` — конкретный запрос или ответ.
- `name` — `dID` источника данных. Исключения: `server` в `info/serverConnected` и `unknown` в служебных ответах.
- `payload` — всегда объект (может быть пустым `{}`).
- `time` — служебное поле, добавляет сервер (при пересылке строка даты, в оповещениях ISO 8601). Клиент его не отправляет.
- Допустимые значения `type` для входящих сообщений задаёт `validType` (`validate.js`).

### Направления и типы
| Направление | type | Допустимые request |
|---|---|---|
| Vue → сервер | `auth` | `login`, `resume` (без сессии); `logout`, `refresh`, `changePassword`, `profile`, `updateProfile`, `telegramLinkCode`, `telegramUnlink` (нужна сессия) |
| Vue → сервер | `get` | `config`, `statistics`, `schedules`, `notifications`, `messages`, `videoCameras`, `videoSnapshot`, `videoStatus` |
| Vue → сервер | `post` | `setpoints`, `system`, `sensors`, `wsConnect`, `videoSubscribe`, `add/del/update` + `schedules` / `notifications` / `statistics`, администрирование: `createUser`, `linkUserToDataSource`, `userConfigRequest`, `userConfigEdit`, `resetUserPassword`, `deleteUser` |
| NodeRED → сервер | `init` | `init_ws` — регистрация соединения |
| NodeRED → сервер | `post` | данные датчиков (`payload.room`, `item_name`, `item_value`; необязательно `item_type`, `title`, `group`) |
| NodeRED → сервер | `message` | `notify` — оповещение |
| Сервер → Vue | `response` | успешный ответ на запрос |
| Сервер → Vue | `error` | ошибка запроса, `payload: { message, code? }` |
| Сервер → Vue | `info` | служебное (`serverConnected`) |
| Сервер → Vue | `post` | push: данные от NodeRED и других клиентов того же `dID`, кадры камер (`videoSnapshot`) |
| Сервер → Vue | `message` | push: оповещение |
| Сервер → NodeRED | `post` | команды от Vue того же `dID`; `message/telegramIn` — текст из Telegram |

Тип, которого нет в таблице направления, сервер игнорирует. Vue может отправлять только `auth`, `get`, `post` (`DASH_ALLOWED_TYPES`).

### Обработка входящего сообщения от Vue
1. `JSON.parse` и `checkMessage`: `validType`, для `post` ещё `validPost`. Невалидное сообщение отбрасывается без ответа и логируется.
2. Проверка, что `type` разрешён для Dashboard. Иначе сообщение отбрасывается без ответа.
3. `auth.checkMessageAccess(clientId, type, request, name)`: сессия, уровень (`REQUIRED_LEVEL`), `name === dID` сессии (уровень 3 исключён). Отказ даёт `error/accessError` с `payload: { code, message, type, request }`, коды `NO_SESSION`, `FORBIDDEN`, `DID_MISMATCH`.
4. Маршрутизация: `auth` → `handleAuth`, `get` → `handleGet`, `post` → `handlePost`, затем пересылка (см. «Рассылка»).

### Обработка входящего сообщения от NodeRED
1. `checkMessage`; при ошибке сообщение отбрасывается. Для `message` дополнительно `validMessage`.
2. Сообщение с `name`, не прошедшим `cfg.isValidDID`, отбрасывается целиком. Если соединению ещё не назначен `dID`, он берётся из `name` первого валидного сообщения. Дальше `dID` не меняют.
3. `init/init_ws` обновляет соединение; `post` ставится в очередь `messageStore` и пересылается клиентам Vue; `message` передаётся в `notifyService.dispatch`.

### Правила для клиента Vue 3
- После подключения сервер отправляет `info/serverConnected`.
- Первое сообщение: `auth/login` (`payload: { username, password }`) или `auth/resume` (`payload: { token }`). Успех приходит как `response/loginSuccess` с `token`, `username`, `userlevel`, `dID`, `mustChangePassword`, `profile`. До этого любой другой запрос получит `accessError/NO_SESSION`.
- Во всех сообщениях `name` равен `dID` пользователя.
- Сессия живёт, пока открыто соединение: по бездействию она не истекает и заканчивается только при `auth/logout`, отзыве (смена пароля, уровня, dID, блокировка, удаление) или закрытии соединения. После переподключения нужен новый `auth/resume` с сохранённым токеном. При `TOKEN_REVOKED`, `BAD_TOKEN` или `TIMEOUT` выполнить повторный вход.
- Таймаут входа `AUTH_TIMEOUT_MS` (60 с, `0` — выключен): соединение, которое столько времени остаётся без сессии (после подключения, logout или отзыва), получает `error/accessError` с `code: 'TIMEOUT'` и закрывается с кодом `4401` (`auth timeout`). Проверка идёт периодически, поэтому фактическое закрытие наступает с задержкой до четверти таймаута (не меньше 5 с, не больше 60 с).
- Срок жизни токена (`JWT_EXPIRES`) ограничивает только `auth/resume`; чтобы сохранённый токен не истёк, продлевайте его через `auth/refresh`.
- Токен продлевается запросом `auth/refresh`; при `mustChangePassword: true` требовать смену пароля.
- Корреляционного идентификатора нет: ответ сопоставляется по `request`. Не отправлять параллельно два одинаковых запроса.
- Имена ответов:
  - `auth`: `response/<request>Success` и `error/<request>Error` (исключения: `resume` отвечает `loginSuccess` / `resumeError`; `profile` и `telegramLinkCode` отвечают под своим именем; общая ошибка — `authError`).
  - `get`: `response/<ресурс>` (имя совпадает с `request`) и `error/<request>Error`.
  - `post`: `response/<действие>Success` и `error/<действие>Error`, конкретные имена задаёт обработчик в `messageHandlers.js`.
- Реконнект с нарастающей паузой; сервер закрывает соединения без ответа на ping.

### Правила для NodeRED
- Подключаться к `WSR_PORT_IN`. Параметр `?id=` необязателен и только логируется.
- Первым сообщением отправить `init/init_ws` с `name = dID`, иначе соединение не получит команд от Vue.
- Датчики отправлять как `post` с обязательными `room`, `item_name`, `item_value`. Сервер ставит их в очередь по ключу `type|name|request|room|item_name`: повтор с тем же ключом заменяет значение. Очередь обрабатывается каждые 15 с, до 3 повторов с паузой не меньше 5 с.
- Оповещения: `{ "type": "message", "request": "notify", "name": "<dID>", "payload": { "level": 1, "message": "...", "severity": "alarm", "title": "...", "room": "...", "item_name": "..." } }`.
  - `level` (1..3, по умолчанию 1) — минимальный уровень получателя (`permissionLevel >= level`).
  - `message` — текст (обязательно, до 3500 символов).
  - `severity`: `info` | `ok` | `warning` | `alarm`, по умолчанию `info`.
  - Остальные поля необязательны. Лишние поля `payload` отбрасываются.
  - Сервер добавляет `time`, `payload.id`, `payload.source` и подавляет одинаковые сообщения в течение `NOTIFY_DEDUP_TTL_MS`.
- От сервера NodeRED получает `post` от Vue (кроме служебных) и `message/telegramIn` с `payload: { level, message, from: { source, username, uid } }`.
- Не отправлять NodeRED-сообщения чужого `dID`: соединение привязано к одному `dID`.

### Рассылка
- `post` от Vue пересылается всем остальным соединениям Vue с тем же `dID` (кроме отправителя) и, если включён NodeRED (`NODERED_ENABLED`), соединениям NodeRED этого `dID`. Сервер добавляет `time`.
- Команду, относящуюся к тегу Modbus TCP/RTU, выполняет мост: она не пересылается и не обрабатывается `handlePost`. Мост сохраняет значение в config-файл и рассылает его Vue (`post` с `item_name`/`item_value`) только после подтверждения записи устройством; при отказе отправитель получает `error/modbusWriteError`, а файл не меняется.
- `post` от NodeRED пересылается всем соединениям Vue с этим `dID`.
- Запросы из `NO_BROADCAST_POST` (`authConfig.js`) не пересылаются никому: они содержат пароли и данные учётных записей.
- Оповещения (`message`) и снимки камеры (`post/videoSnapshot`) идут не через `broadcast`, а адресно: сессии Vue с нужным `dID` и уровнем (`notifyService`, `videoHub`). Соединение без сессии их не получает.
- Оповещения дополнительно уходят в Telegram привязанным пользователям. Оповещение доступно после переподключения запросом `get/messages` (последние `NOTIFY_HISTORY_SIZE` сообщений на `dID`).
- Видео (`services/videoHub.js`): 1–16 камер из `cameras.json` (`VIDEO_CAMERAS_FILE`, по умолчанию `$DATA_DIR/cameras.json`, образец `cameras.example.json`). Без файла: задан `VIDEO_RTSP_URL` — одна камера из него; иначе файл создаётся с `VIDEO_MOCK_CAMERAS` муляжами (`source: test`, по умолчанию 4, 0 — не создавать). Настройка камер — `docs/cameras.md`. У камеры `id`, `title`, `source` (`rtsp(s)://…` или `test` — ffmpeg генерирует картинку, эмуляция без устройства), `dID`, `minLevel`, `previewIntervalMs`, `fullIntervalMs`, `maxWidth`, `quality`, `archive`. Камеру видят сессии с одним из её `dID` и уровнем `>= minLevel`: `dID` — строка, список или `"*"` (все пользователи; для реальной камеры — предупреждение в логе). По умолчанию `dID` камеры — `VIDEO_DID` (строка, JSON-список, список через запятую или `*`; разбор — `parseDIDSetting`), без него — `DEFAULT_USER_DID`, у муляжей — `"*"`. Кадр сериализуется один раз на каждый dID получателей, `name` — dID получателя.
  - Кадр: `post/videoSnapshot`, `name` — dID получателя, `payload: { cameraId, title, image (base64 JPEG), mimeType, size, timestamp }`. Кадр сериализуется один раз на dID получателей; клиенту с переполненным буфером (`bufferedAmount` > 1 МБ) кадр пропускается.
  - Подписка: `post/videoSubscribe`, `payload: { cameras: [id…], full: id | null }` → `response/videoSubscribeSuccess` с принятыми (доступными) камерами. Миниатюры — не чаще `previewIntervalMs`, камера `full` — не чаще `fullIntervalMs`; новым камерам последний кадр отправляется сразу. Пустой список — кадров нет. Без подписки соединение получает миниатюры всех доступных камер (прежнее поведение). Подписка живёт, пока открыто соединение: после переподключения клиент подписывается снова. Не пересылается (`NO_BROADCAST_POST`).
  - `get/videoCameras` → `{ cameras: [{ id, title, status: online | starting | offline, lastFrameAt, previewIntervalMs, fullIntervalMs }] }`; `get/videoSnapshot` с `payload.cameraId` (без него — первая доступная камера); `get/videoStatus` (уровень 3) — статистика по камерам.
  - `cameras.json` перечитывается на лету (`fs.watchFile`, опрос 2 с): изменённые камеры перезапускаются, новые запускаются, удалённые останавливаются и убираются из подписок; порядок — как в файле. Клиентам Vue уходит `response/videoCameras` с новым списком (без запроса). Файл с ошибкой JSON — работающие камеры не трогаются. Наличие ffmpeg проверяется асинхронно при старте, без ffmpeg — ошибка в логе с подсказкой.
  - ffmpeg на камеру кодирует JPEG с частотой `min(previewIntervalMs, fullIntervalMs)`; архив MP4/S3 — только при `archive: true` (у `test` архива нет).
  - Проверка без камер: `tools/videoLoadTest.js` (N камер × M клиентов, доставка, задержка, трафик, CPU/RAM; `--ffmpeg fake` — `tools/fakeFfmpeg.js` без кодирования).

### Права доступа (`REQUIRED_LEVEL`)
- Уровень 1 — просмотр и управление: `get` `config`, `statistics`, `messages`, `videoCameras`, `videoSnapshot`; `post` `setpoints`, `system`, `sensors`, `wsConnect`, `videoSubscribe`.
- Уровень 2 — настройки: `get` `schedules`, `notifications`; `post` `add/del/update` расписаний, уведомлений, статистики.
- Уровень 3 — администратор: `get/videoStatus`; `post` `createUser`, `linkUserToDataSource`, `userConfigRequest`, `userConfigEdit`, `resetUserPassword`, `deleteUser`.
- Неизвестный `request` получает `_default` своего типа (уровень 1). Для запросов, влияющих на безопасность, всегда задавать уровень явно.

### Правила разработки WebSocket-обмена
- Новый запрос добавлять во всех местах сразу: обработчик в `messageHandlers.js`, уровень в `REQUIRED_LEVEL`, при необходимости схема в `validate.js`, `NO_BROADCAST_POST` для запросов с секретами, тесты, строка в таблицах этого раздела.
- Ответы клиенту отправлять через `wsManager.sendToConnection`. Push многим клиентам: напрямую `ws.send`, предварительно проверив `readyState === OPEN` (для больших сообщений ещё `bufferedAmount`) и сериализовав сообщение один раз.
- Успех: `type: 'response'`, имя `<действие>Success` или имя ресурса. Ошибка: `type: 'error'`, имя `<действие>Error`, `payload: { message, code }`. `code` — стабильный машинный код (`NO_USER`, `LAST_ADMIN`, ...), `message` — текст для пользователя. Внутренние детали и стеки клиенту не отправлять.
- Сообщения, не прошедшие валидацию, молча отбрасываются. Не добавлять ответы на невалидный ввод без согласования: это раскрывает схему.
- `name` из сообщения Vue не считать доверенным: данные и права определять по сессии (`auth.getSession`). Для push-каналов выбирать получателей только по сессии (`dID` и уровень).
- Обработчик не должен блокировать цикл событий: тяжёлую работу выполнять асинхронно или через очередь.
- Изменения протокола делать совместимыми: добавлять поля и запросы, не менять смысл существующих. Каждое изменение сразу отражать в этом разделе.

## Безопасность и доступ
- Каждое сообщение Vue проходит `checkMessage` и `auth.checkMessageAccess` (см. «Обработка входящего сообщения от Vue»).
- Уровни доступа описаны в разделе «Права доступа». Новый `request` обязательно добавлять в `REQUIRED_LEVEL`.
- `dID` допускает только `^[A-Za-z0-9_-]{1,64}$` (`cfg.isValidDID`): он используется в именах файлов. Проверка стоит на всех уровнях:
  - `validPost` требует, чтобы `name` был допустимым `dID`; `validMessage` — тоже;
  - `checkMessageAccess` отклоняет недопустимый `name` с `DID_MISMATCH` для любого уровня, включая администратора;
  - канал NodeRED отбрасывает сообщения с недопустимым `name`;
  - `configStore.resolveConfigPath` бросает `BAD_DID` / `BAD_CONFIG_NAME`, а `writeFileSafely` — `BAD_PATH` для пути вне `DATA_DIR`. Новый код, превращающий данные в путь, обязан идти через `resolveConfigPath`.
- Пользователи:
  - пароли только bcrypt;
  - наружу отдавать только `userStore.toPublic()` (без хеша и `telegram.chatId`);
  - при смене уровня, dID, пароля или блокировке — `tokenVersion++` и `auth.invalidateUserSessions()`;
  - нельзя удалить или понизить последнего администратора, нельзя понизить, заблокировать или удалить себя.
- Telegram: только личные чаты, привязка по одноразовому коду с TTL, лимит неверных кодов и частоты сообщений, один чат — одна учётная запись.
- Видео: сервис камеры следит за ffmpeg (watchdog при отсутствии кадров, перезапуск с нарастающей паузой), перед стартом останавливает осиротевший ffmpeg по pid-файлу (у каждой камеры свой `ffmpeg-<id>.pid`). Пароль RTSP маскируется во всех логах (`maskUrl`), локальный архив ограничен `VIDEO_TMP_MAX_MB`.

## Тесты
- Jest (`npm test`). На каждый новый или изменённый модуль создавать или обновлять тесты в `tests/`.
- Сеть, файловую систему и WS не использовать напрямую: фейки, моки или временные каталоги (`os.tmpdir()`). Реальные запросы к Telegram и S3 запрещены, ffmpeg в юнит-тестах подменяется фейковым процессом (`spawn` передаётся в фабрику).
- Тесты зависят только от `tests/setup.js` (тихий лог `LOG_LEVEL=none`, тестовый `JWT_SECRET`, `DATA_DIR` во временном каталоге). Глобальных моков нет: каждый тест сам подменяет `fs`, логгер и другие модули. История вызовов моков очищается перед каждым тестом (`clearMocks` в `jest.config.js`).
- Пути в тестах относительно файла теста: из `tests/unit/` — `../../services/...`, `../../classes/...`.
- Перед завершением работы прогонять весь набор.
