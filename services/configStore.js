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
    console.log(`[ConfigStore] - writeFileSafely - 📂 Записываем данные в ${filePath}`);
    await ensureDataDir(); 
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, content);
    await fs.rename(tempPath, filePath);
    fileCache.set(filePath, JSON.parse(content));
}

async function readFileSafely(dID, typeConfig) {
    console.log(` [ConfigStore] - readFileSafely - # начинаем для ${typeConfig}`);
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
        return { data, dataDir, filePath };
    }

    try {
        const fileData = await fs.readFile(filePath, 'utf8');
        const data = JSON.parse(fileData);
        fileCache.set(filePath, data);
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
                            sTemp: { low: 8, high: 36, step: 0.5 }, 
                            sHum: { low: 14, high: 60, step: 1 },
                            sActuator: { low: 0, high: 100, step: 0.1 },
                            sBool: { low: 0, high: 1, step: 1 },
                            Hours: { low: 0, high: 23, step: 1 },
                            Minutes: { low: 0, high: 59, step: 1 },

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

// async function readFileSafely(dID, typeConfig) {
//     //console.log(`# # # # # # # # # # # # # # # [ConfigStore] - readFileSafely - # начинаем`);
//     await ensureDataDir();
//     let filePath = '';
    
//     switch (typeConfig) {
//         case 'config':
//             filePath = path.join(dataDir, `${dID}.json`);
//             break;
//         case 'schedules':
//             filePath =path.join(dataDir,  `schedules_${dID}.json`);
//             break;
//         case 'notifications':
//             filePath = path.join(dataDir, `notifications_${dID}.json`);
//             break;
//         default:
//             // filePath = path.join(dataDir, `${dID}.json`);// По умолчанию основной конфиг
//     }
//     console.log(`[ConfigStore] - readFileSafely - 📂 Читаем данные из ${filePath}`);

//     //const filePath = path.join(dataDir, `${dID}.json`);
   
//     if (fileCache.has(filePath)) {
//         const data = fileCache.get(filePath);
//         return { data, dataDir, filePath };
//     }

//     try {
//         const fileData = await fs.readFile(filePath, 'utf8');
//         const data = JSON.parse(fileData);
//         fileCache.set(filePath, data);
//         return { data, dataDir, filePath };
//     } catch (error) {
//         let initData;
//         if (error.code === 'ENOENT') {
//             if (typeConfig === 'config') {
//                initData = { 
//                 init: { 
//                     title: "", 
//                     dID, 
//                     limits: { 
//                         Default: { low: 14, high: 30, step: 1 }, 
//                         Temp: { low: 8, high: 36, step: 0.5 }, 
//                         Hum: { low: 14, high: 60, step: 1 }
//                     }
//                 } 
//             };
//             } else if (typeConfig === 'schedules') {
//                initData = {};
//             } else if (typeConfig === 'notifications') {
//                initData = {};
//             }
// console.log(`[ConfigStore] - readFileSafely - 📂 Создаем новый файл ${filePath}`);
// console.log(`[ConfigStore] - readFileSafely - 📂 Создаем новый файл ${JSON.stringify(initData)}`);




//             // const initData = { 
//             //     init: { 
//             //         title: "", 
//             //         dID, 
//             //         limits: { 
//             //             Default: { low: 14, high: 30, step: 1 }, 
//             //             Temp: { low: 8, high: 36, step: 0.5 }, 
//             //             Hum: { low: 14, high: 60, step: 1 }
//             //         }
//             //     } 
//             // };
//             fileCache.set(filePath, initData);
//             return { data: initData, dataDir, filePath }; // Всегда возвращаем одинаковую структуру
//         } else if (error instanceof SyntaxError) {
//             logger.logErrorMessage(`[ConfigStore] - Ошибка парсинга файла ${filePath}: ${error.message}`);
//             //console.error(`[ConfigStore] - Ошибка парсинга файла ${filePath}:`, error);
//             const initData = { init: { title: "", dID } };
//             fileCache.set(filePath, initData);
//             return { data: initData, dataDir, filePath }; // Всегда возвращаем одинаковую структуру
//         } else {
//             throw error;
//         }
//     }
// };

module.exports = {
  writeFileSafely,
  readFileSafely,
  fileCache
};