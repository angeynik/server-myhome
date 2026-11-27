//configStore - Работа с файловой системой
//Создание, чтение и запись файлов

const fs = require('fs').promises; // Используем асинхронные методы
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: './conf.env', quiet: true });
const dataDir = process.env.DATA_DIR;
const cfg = require('./authConfig');
const logger = require('./logger.js');
logger.initLogging();

logger.logDevMessage(`[ConfigStore] - ДИАГ: process.env.DATA_DIR="${process.env.DATA_DIR}" → dataDir="${dataDir}"`);
// Объявляем кэш файлов
const fileCache = new Map();

// dID и имя конфига становятся частью имени файла, поэтому допускаем только
// безопасный алфавит (cfg.isValidDID): никаких '/', '..' и прочих разделителей.
const CONFIG_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function storeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function resolveConfigPath(dID, typeConfig) {
  if (!cfg.isValidDID(dID)) throw storeError('BAD_DID', 'Недопустимый dID');
  if (typeof typeConfig !== 'string' || !CONFIG_NAME_RE.test(typeConfig)) {
    throw storeError('BAD_CONFIG_NAME', 'Недопустимое имя конфигурации');
  }
  const suffix = (typeConfig === 'config') ? '' : `_${typeConfig}`;
  return path.join(dataDir, `${dID}${suffix}.json`);
}

// Все файлы конфигураций лежат прямо в DATA_DIR — запись в другое место запрещена
function assertInsideDataDir(filePath) {
  if (path.dirname(path.resolve(filePath)) !== path.resolve(dataDir)) {
    throw storeError('BAD_PATH', 'Запись вне каталога данных запрещена');
  }
}

// Общая функция для проверки/создания директории
async function ensureDataDir() {
    try {
        await fs.access(dataDir);
    } catch (err) {
        if (err.code === 'ENOENT') {
            await fs.mkdir(dataDir, { recursive: true });
            logger.logDevMessage(`[ConfigStore] - 📂 Создана директория: ${dataDir}`);
            //console.log(`[ConfigStore] - 📂 Создана директория: ${dataDir}`);
        } else {
            throw err;
        }
    }
}

// Записи в один файл выполняются строго по очереди, у каждой свой временный файл:
// иначе параллельные записи (пачка команд от Vue, данные Modbus/NodeRED)
// делили один .tmp, и вторая падала на rename с ENOENT.
const writeChains = new Map();
let tmpSeq = 0;

async function writeNow(filePath, content) {
    await ensureDataDir();
    const tempPath = `${filePath}.${process.pid}.${++tmpSeq}.tmp`;
    await fs.writeFile(tempPath, content);
    await fs.rename(tempPath, filePath);
    fileCache.set(filePath, JSON.parse(content));
}

async function writeFileSafely(filePath, content) {
    assertInsideDataDir(filePath);
    logger.logDevMessage(`[ConfigStore] - writeFileSafely - записываем ${filePath}`);

    const prev = writeChains.get(filePath) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => writeNow(filePath, content));
    writeChains.set(filePath, run);
    try {
        await run;
    } finally {
        if (writeChains.get(filePath) === run) writeChains.delete(filePath);
    }
}

// notification        — <dID>_notification.json: условия уведомлений (services/notificationStore.js)
// notification_status — <dID>_notification_status.json: статусы уведомлений (ON/OFF, флаг прочтения)
const CONFIG_TYPES = ['config', 'schedules', 'statistics', 'notification', 'notification_status', 'scenarios'];

async function readFileSafely(dID, typeConfig = 'config') {
    if (!CONFIG_TYPES.includes(typeConfig)) {
        throw new Error(`Неизвестный тип конфигурации: ${typeConfig}`);
    }
    await ensureDataDir();
    const filePath = resolveConfigPath(dID, typeConfig);
    logger.logDevMessage(`[ConfigStore] - readFileSafely - читаем ${filePath}`);

    // Проверяем кэш
    if (fileCache.has(filePath)) {
        const data = fileCache.get(filePath);
        console.log(`[ConfigStore] - readFileSafely - 📂 Возвращаем данные из кэша ${filePath}, ${data}`);
        return { data, dataDir, filePath };
    }

    try {
        const fileData = await fs.readFile(filePath, 'utf8');
        const data = JSON.parse(fileData);
        fileCache.set(filePath, data);
        console.log(`[ConfigStore] - readFileSafely - 📂 Получаем данные из хранилища ${data}`);
        return { data, dataDir, filePath };
    } catch (error) {
        let initData;
        
        if (error.code === 'ENOENT') {
            // Файл не существует - создаем новый
            if (typeConfig === 'config') {
                initData = { 
                    init: { 
                        title: "", 
                        dID, 
                        limits: { 
                            Default: { low: 8, high: 36, step: 1 }, 
                            Temp: { low: 8, high: 36, step: 0.5 },
                            CurSetpoint: { low: 8,  high: 36,  step: 0.5 }, 
                            Hum: { low: 14, high: 60, step: 1 },
                            Actuator: { low: 0, high: 100, step: 0.1 },
                            Bool: { low: false, high: true, step: 1 },
                            Switch: {high: 1, low: 0, step: 1},
                            Status: { low: 0,  high: 10, step: 1 }, 
                            hours: { low: 0, high: 23, step: 1 },
                            minutes: { low: 0, high: 59, step: 1 },
                        }
                    }
                };
            } else {
                initData = {};
            }
            console.log(`[ConfigStore] - readFileSafely - 📂 Конфигурация ${typeConfig} отсутствует Создаем новый файл ${filePath}`);
            console.log(`[ConfigStore] - readFileSafely - 📂 Данные: ${JSON.stringify(initData)}`);

            // ВАЖНО: Записываем файл на диск!
            await writeFileSafely(filePath, JSON.stringify(initData, null, 2));
            
            fileCache.set(filePath, initData);
            return { data: initData, dataDir, filePath };
            
        } else if (error instanceof SyntaxError) {
            // Ошибка парсинга JSON
            logger.logErrorMessage(`[ConfigStore] - Ошибка парсинга файла ${filePath}: ${error.message}`);
            
            if (typeConfig === 'config') {
                initData = { init: { title: "", dID } };
            } else if (typeConfig === 'schedules') {
                initData = {};
            } else {
                initData = {};
            }
            
            console.log(`[ConfigStore] - readFileSafely - 📂 Восстанавливаем поврежденный файл ${filePath}`);
            
            // ВАЖНО: Записываем исправленный файл на диск!
            await writeFileSafely(filePath, JSON.stringify(initData, null, 2));
            
            fileCache.set(filePath, initData);
            return { data: initData, dataDir, filePath };
        } else {
            throw error;
        }
    }
};


// Чтение без создания: файла нет — null (конфигурация уведомлений «не существует», пока не создано
// ни одного уведомления). Битый JSON — ошибка: файл с данными пользователя не перезаписываем.
async function readFileIfExists(dID, typeConfig) {
    if (!CONFIG_TYPES.includes(typeConfig)) {
        throw new Error(`Неизвестный тип конфигурации: ${typeConfig}`);
    }
    const filePath = resolveConfigPath(dID, typeConfig);
    if (fileCache.has(filePath)) return { data: fileCache.get(filePath), dataDir, filePath };
    let raw;
    try {
        raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    const data = JSON.parse(raw);
    fileCache.set(filePath, data);
    return { data, dataDir, filePath };
}

module.exports = {
  writeFileSafely, readFileSafely, readFileIfExists, fileCache, resolveConfigPath, CONFIG_TYPES,
};