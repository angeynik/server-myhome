# Инструкции для проекта serverApp

## Стек и окружение
- Node.js 18+ (глобальный `fetch`), системный `ffmpeg` для видео, CommonJS: `require` / `module.exports`, в каждом модуле `'use strict'`.
- Express используется только как HTTP-сервер (`SERVER_PORT`) с CORS. Весь обмен данными идёт по WebSocket (библиотека `ws`), см. раздел «Обмен данными по WebSocket». HTTP-эндпоинты для обмена данными не добавлять.
- Настройки только из `conf.env` (dotenv). Новый параметр: читать в `services/authConfig.js`, `notifyConfig.js` или `videoConfig.js`, задавать значение по умолчанию, описывать в `conf.env`.
- Секреты (`JWT_SECRET`, `AUTH_MASTER_KEY`, `TELEGRAM_BOT_TOKEN`, пароли, ключи S3, пароль RTSP) хранятся только в окружении. В логи, ответы клиентам и сообщения об ошибках не попадают.

## Стиль кода
- ES6+, `async/await`, отступ 2 пробела, одинарные кавычки, точки с запятой.
- Только `let` и `const`, `var` не использовать.
- Комментарии на русском и по делу: шапка модуля (назначение, формат данных) и неочевидные решения. Закомментированный код не оставлять.
- jQuery, DOM API и браузерные объекты не использовать.

## Логирование
- Только `services/logger.js`: `logInfoMessage`, `logDevMessage`, `logErrorMessage`. Формат: `[Модуль] - функция - сообщение`.
- `console.*` в новом коде не использовать.
- Сырые входящие сообщения логировать только через `logger.redactSecrets()` (маскирует `password`, `oldPassword`, `newPassword`, `token`).

## Структура проекта
- `serverapp.js` — точка входа: Express, WS-серверы, маршрутизация сообщений. Бизнес-логики не содержит.
- `services/` — бизнес-логика: `auth`, `authConfig`, `userStore`, `notifyConfig`, `notifyService`, `telegramService`, `videoConfig`, `videoStreamService`, `messageHandlers`, `messageStore`, `configStore`, `validate`, `logger`, `clientsStore`, `modbusTCPBridge`.
- `classes/` — классы: `wsManager`, `modBusTCPManager`, `telegramBot`.
- `scripts/` — CLI администрирования (`authAdmin.js`).
- `tests/` — Jest-тесты `<модуль>.test.js` и `setup.js`.
- Сервис с зависимостями оформляется как фабрика `createXService(deps)` плюс синглтон-обёртка. Так его можно тестировать с фейками.

## Обмен данными по WebSocket

Весь обмен между NodeRED и сервером и между клиентом (Vue 3) и сервером идёт только по WebSocket. Внешние каналы (Telegram Bot API, S3, RTSP-камера) подключаются только через свои сервисы.

### Каналы
| Канал | Порт (env, по умолчанию) | Клиент | Аутентификация | Heartbeat (ping / таймаут) |
|---|---|---|---|---|
| Dashboard | `WSD_PORT_IN` (9202) | Vue 3 | JWT-сессия: `auth/login` или `auth/resume` | 180 с / 370 с |
| NodeRED | `WSR_PORT_IN` (9200), включается `NODERED_ENABLED` | NodeRED | нет (доверенный канал) | 240 с / 500 с |

- Порт NodeRED не защищён токеном (`AUTH_STRICT` пока не реализован). Его нужно закрывать на уровне сети: слушать только внутренний интерфейс или ограничить файрволом.
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
| Vue → сервер | `get` | `config`, `statistics`, `schedules`, `notifications`, `messages`, `videoSnapshot`, `videoStatus` |
| Vue → сервер | `post` | `setpoints`, `system`, `sensors`, `wsConnect`, `add/del/update` + `schedules` / `notifications` / `statistics`, администрирование: `createUser`, `linkUserToDataSource`, `userConfigRequest`, `userConfigEdit`, `resetUserPassword`, `deleteUser` |
| NodeRED → сервер | `init` | `init_ws` — регистрация соединения |
| NodeRED → сервер | `post` | данные датчиков (`payload.room`, `item_name`, `item_value`; необязательно `item_type`, `title`, `group`) |
| NodeRED → сервер | `message` | `notify` — оповещение |
| Сервер → Vue | `response` | успешный ответ на запрос |
| Сервер → Vue | `error` | ошибка запроса, `payload: { message, code? }` |
| Сервер → Vue | `info` | служебное (`serverConnected`) |
| Сервер → Vue | `post` | push: данные от NodeRED и других клиентов того же `dID`, снимки камеры (`videoSnapshot`) |
| Сервер → Vue | `message` | push: оповещение |
| Сервер → NodeRED | `post` | команды от Vue того же `dID`; `message/telegramIn` — текст из Telegram |

Тип, которого нет в таблице направления, сервер игнорирует. Vue может отправлять только `auth`, `get`, `post` (`DASH_ALLOWED_TYPES`).

### Обработка входящего сообщения от Vue
1. `JSON.parse` и `checkMessage`: `validType`, для `post` ещё `validPost`. Невалидное сообщение отбрасывается без ответа и логируется.
2. Проверка, что `type` разрешён для Dashboard. Иначе сообщение отбрасывается без ответа.
3. `auth.checkMessageAccess(clientId, type, request, name)`: сессия, таймаут `AUTH_TIMEOUT_MS`, уровень (`REQUIRED_LEVEL`), `name === dID` сессии (уровень 3 исключён). Отказ даёт `error/accessError` с `payload: { code, message, type, request }`, коды `NO_SESSION`, `TIMEOUT`, `FORBIDDEN`, `DID_MISMATCH`.
4. Маршрутизация: `auth` → `handleAuth`, `get` → `handleGet`, `post` → `handlePost`, затем пересылка (см. «Рассылка»).

### Обработка входящего сообщения от NodeRED
1. `checkMessage`; при ошибке сообщение отбрасывается. Для `message` дополнительно `validMessage`.
2. Если соединению ещё не назначен `dID`, он берётся из `name` первого валидного сообщения. Дальше `dID` не меняют.
3. `init/init_ws` обновляет соединение; `post` ставится в очередь `messageStore` и пересылается клиентам Vue; `message` передаётся в `notifyService.dispatch`.

### Правила для клиента Vue 3
- После подключения сервер отправляет `info/serverConnected`.
- Первое сообщение: `auth/login` (`payload: { username, password }`) или `auth/resume` (`payload: { token }`). Успех приходит как `response/loginSuccess` с `token`, `username`, `userlevel`, `dID`, `mustChangePassword`, `profile`. До этого любой другой запрос получит `accessError/NO_SESSION`.
- Во всех сообщениях `name` равен `dID` пользователя.
- Сессия живёт, пока открыто соединение. После переподключения нужен новый `auth/resume` с сохранённым токеном. При `TOKEN_REVOKED`, `BAD_TOKEN` или `TIMEOUT` выполнить повторный вход.
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
- `post` от Vue пересылается (если команду не обработал Modbus) всем остальным соединениям Vue и NodeRED с тем же `dID`, кроме отправителя. Сервер добавляет `time`.
- `post` от NodeRED пересылается всем соединениям Vue с этим `dID`.
- Запросы из `NO_BROADCAST_POST` (`authConfig.js`) не пересылаются никому: они содержат пароли и данные учётных записей.
- Оповещения (`message`) и снимки камеры (`post/videoSnapshot`) идут не через `broadcast`, а адресно: сессии Vue с нужным `dID` и уровнем (`notifyService`, `videoStreamService`). Соединение без сессии их не получает.
- Оповещения дополнительно уходят в Telegram привязанным пользователям. Оповещение доступно после переподключения запросом `get/messages` (последние `NOTIFY_HISTORY_SIZE` сообщений на `dID`).
- Снимок камеры: `payload: { image (base64), mimeType, size, timestamp }`, `name` — `VIDEO_DID`. Получают сессии с `dID === VIDEO_DID` и уровнем `>= VIDEO_MIN_LEVEL`. Последний кадр доступен по `get/videoSnapshot`, статистика по `get/videoStatus` (уровень 3).

### Права доступа (`REQUIRED_LEVEL`)
- Уровень 1 — просмотр и управление: `get` `config`, `statistics`, `messages`, `videoSnapshot`; `post` `setpoints`, `system`, `sensors`, `wsConnect`.
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
- `dID` допускает только `^[A-Za-z0-9_-]{1,64}$` (`cfg.isValidDID`): он используется в именах файлов.
- Пользователи:
  - пароли только bcrypt;
  - наружу отдавать только `userStore.toPublic()` (без хеша и `telegram.chatId`);
  - при смене уровня, dID, пароля или блокировке — `tokenVersion++` и `auth.invalidateUserSessions()`;
  - нельзя удалить или понизить последнего администратора, нельзя понизить, заблокировать или удалить себя.
- Telegram: только личные чаты, привязка по одноразовому коду с TTL, лимит неверных кодов и частоты сообщений, один чат — одна учётная запись.
- Видео: сервис следит за ffmpeg (watchdog при отсутствии кадров, перезапуск с нарастающей паузой), перед стартом останавливает осиротевший ffmpeg по pid-файлу. Пароль RTSP маскируется во всех логах (`maskUrl`), локальный архив ограничен `VIDEO_TMP_MAX_MB`.

## Тесты
- Jest (`npm test`). На каждый новый или изменённый модуль создавать или обновлять тесты в `tests/`.
- Сеть, файловую систему и WS не использовать напрямую: фейки, моки или временные каталоги (`os.tmpdir()`). Реальные запросы к Telegram и S3 запрещены, ffmpeg в юнит-тестах подменяется фейковым процессом (`spawn` передаётся в фабрику).
- Тесты зависят только от `tests/setup.js` (тихий лог, тестовый `JWT_SECRET`).
- Перед завершением работы прогонять весь набор.
