//configStore - Работа с файловой системой
//Создание, чтение и запись файлов

const fs = require('fs').promises; // Используем асинхронные методы
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: './conf.env' });
const dataDir = process.env.DATA_DIR || './configData';
console.log(`[ConfigStore] - ДИАГ: process.env.DATA_DIR="${process.env.DATA_DIR}" → dataDir="${dataDir}"`);

const logger = require('./logger.js');
logger.initLogging();

// Объявляем кэш файлов
const fileCache = new Map();

function resolveConfigPath(dID, typeConfig) {
  const suffix = (typeConfig === 'config') ? '' : `_${typeConfig}`;
  return path.join(dataDir, `${dID}${suffix}.json`);
}

async function saveNamedConfig(dID, configName, configData) {
  const filePath = resolveConfigPath(dID, configName);
  await writeFileSafely(filePath, JSON.stringify(configData, null, 2));
  logger.logDevMessage(`[ConfigStore] - saveNamedConfig - ${filePath}`);
  return { filePath };
}

async function namedConfigExists(dID, configName) {
  const filePath = resolveConfigPath(dID, configName);
  try { await fs.access(filePath); return { exists: true, filePath }; }
  catch { return { exists: false, filePath }; }
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

async function writeFileSafely(filePath, content) {
    console.log(`[ConfigStore] - writeFileSafely - 📂 Записываем данные в ${filePath}`);
    //console.log(`[ConfigStore] - writeFileSafely - 📂 Данные в ${content}`);

    await ensureDataDir(); 
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, content);
    await fs.rename(tempPath, filePath);
    fileCache.set(filePath, JSON.parse(content));
}

async function readFileSafely(dID, typeConfig) {
    console.log(` [ConfigStore] - readFileSafely - Читаем конфигурацию для ${typeConfig}`);
    await ensureDataDir();
    let filePath = '';
    
    switch (typeConfig) {
        case 'config':
            filePath = path.join(dataDir, `${dID}.json`);
        break;
        case 'schedules':
            filePath = path.join(dataDir, `${dID}_${typeConfig}.json`);
        break;
        case 'notifications':
            filePath = path.join(dataDir, `${dID}_${typeConfig}.json`);
            //console.log(`[ConfigStore] - readFileSafely - 📂 Читаем данные для NOTIFICATIONS  из ${filePath}`);
        break;
        case 'statistics':
            filePath = path.join(dataDir, `${dID}_${typeConfig}.json`);
            //console.log(`[ConfigStore] - readFileSafely - 📂 Читаем данные для NOTIFICATIONS  из ${filePath}`);
        break;
        default:
            // filePath = path.join(dataDir, `${dID}.json`);// По умолчанию основной конфиг
    }
    console.log(`[ConfigStore] - readFileSafely - 📂 Читаем данные из ${filePath}`);

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
                            Default: { low: 14, high: 30, step: 1 }, 
                            dTemp: { low: 0, high: 50, step: 0.5 },
                            sTemp: { low: 8,  high: 36,  step: 0.5 }, 
                            dHum: { low: 14, high: 60, step: 1 },
                            dActuator: { low: 0, high: 100, step: 0.1 },
                            dBool: { low: 0, high: 1, step: 1 },
                            xStatus: { low: 0,  high: 10, step: 1 }, 
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
            } else if (typeConfig === 'notifications') {
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


module.exports = {
  writeFileSafely, readFileSafely, fileCache,
  saveNamedConfig, namedConfigExists, resolveConfigPath,
};