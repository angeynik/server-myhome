
const fs = require('fs').promises; // Используем асинхронные методы
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: './conf.env' });
const dataDir = process.env.DATA_DIR || './configData';

// Объявляем кэш файлов
const fileCache = new Map();

// Функция для безопасного извлечения значений
function getValue(value) {
    return Array.isArray(value) ? value[0] : value;
}

// Безопасная запись с блокировкой
async function writeFileSafely(filePath, content) {
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, content);
    await fs.rename(tempPath, filePath);
    fileCache.set(filePath, JSON.parse(content));
}

async function handlePost(clientId, message) {
    const { name, payload = {}, time = new Date().toISOString() } = message;
    
    // Извлекаем значения из payload
    const room = getValue(payload.room);
    const item_name = getValue(payload.item_name);
    const item_value = getValue(payload.item_value);
    const title = getValue(payload.title);
    const group = getValue(payload.group);

    // Проверка обязательных полей (раскомментировать)
    if (!room || !item_name || item_value === undefined) {
        throw new Error(`Missing required fields: room=${room}, item_name=${item_name}, item_value=${item_value}`);
    }

    // Создаем директорию рекурсивно (асинхронно)
    try {
        await fs.access(dataDir);
    } catch (err) {
        if (err.code === 'ENOENT') {
            await fs.mkdir(dataDir, { recursive: true });
            console.log(`📂 Создана директория: ${dataDir}`);
        } else {
            throw err;
        }
    }

    const filePath = path.join(dataDir, `${name}.json`);
    let data;

    try {
        // Используем кэш или читаем файл
        if (fileCache.has(filePath)) {
            data = fileCache.get(filePath);
        } else {
            try {
                const fileData = await fs.readFile(filePath, 'utf8');
                data = JSON.parse(fileData);
                fileCache.set(filePath, data);
            } catch (error) {
                if (error.code === 'ENOENT') {
                    data = { init: { title: "", dID: name } };
                    fileCache.set(filePath, data);
                } else {
                    throw error;
                }
            }
        }

        // Проверяем, существует ли комната
        if (!data[room]) {
            // Создаем новую комнату
            data[room] = {
                id: Object.keys(data).filter(k => k.startsWith('room')).length,
                title: title || `Комната-${room}`,
                group: group || '',
                sensors: {},
                time: {},
                actuators: {}
            };
        }

        // Обновляем сенсор и временную метку
        data[room].sensors[item_name] = item_value;
        data[room].time[`${item_name}_time`] = Date.now();

        // Сохранение данных
        const dataString = JSON.stringify(data, null, 2);
        await writeFileSafely(filePath, dataString);
        console.log(`✅ Данные успешно обновлены в ${filePath}`);
        //console.log('Содержимое файла:', dataString);
        return 'ok';
    } catch (err) {
        console.error(`Ошибка при работе с файлом ${filePath}:`, err);
        // В случае ошибки сбрасываем кэш для этого файла
        fileCache.delete(filePath);
        return 'error';
    }
}

module.exports = {
    handlePost
};