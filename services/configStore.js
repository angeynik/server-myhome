//configStore - Работа с файловой системой
//Создание, чтение и запись файлов

const fs = require('fs').promises; // Используем асинхронные методы
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: './conf.env' });
const dataDir = process.env.DATA_DIR || './configData';

const logger = require('./logger.js');
logger.initLogging();

// Объявляем кэш файлов
const fileCache = new Map();

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
    await ensureDataDir(); 
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, content);
    await fs.rename(tempPath, filePath);
    fileCache.set(filePath, JSON.parse(content));
}


async function readFileSafely(dID) {
    await ensureDataDir();
    const filePath = path.join(dataDir, `${dID}.json`);
    
    if (fileCache.has(filePath)) {
        const data = fileCache.get(filePath);
        return { data, dataDir, filePath };
    }

    try {
        const fileData = await fs.readFile(filePath, 'utf8');
        const data = JSON.parse(fileData);
        fileCache.set(filePath, data);
        return { data, dataDir, filePath };
    } catch (error) {
        if (error.code === 'ENOENT') {
            const initData = { 
                init: { 
                    title: "", 
                    dID, 
                    limits: { 
                        Default: { low: 14, high: 30, step: 1 }, 
                        Temp: { low: 8, high: 36, step: 0.5 }, 
                        Hum: { low: 14, high: 60, step: 1 }
                    }
                } 
            };
            fileCache.set(filePath, initData);
            return { data: initData, dataDir, filePath }; // Всегда возвращаем одинаковую структуру
        } else if (error instanceof SyntaxError) {
            logger.logErrorMessage(`[ConfigStore] - Ошибка парсинга файла ${filePath}: ${error.message}`);
            //console.error(`[ConfigStore] - Ошибка парсинга файла ${filePath}:`, error);
            const initData = { init: { title: "", dID } };
            fileCache.set(filePath, initData);
            return { data: initData, dataDir, filePath }; // Всегда возвращаем одинаковую структуру
        } else {
            throw error;
        }
    }
};

module.exports = {
  writeFileSafely,
  readFileSafely,
  fileCache
};