const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: './conf.env' });
const dataDir = process.env.DATA_DIR || './configData';

// Функция для безопасного извлечения значений (массив/строка)
function getValue(value) {
    return Array.isArray(value) ? value[0] : value;
}

async function handlePost(clientId, message) {

    const { name, payload = {}, time = new Date().toISOString() } = message;

// Извлекаем значения из payload (учитываем массивы)
        const room = getValue(payload.room);
        const item_name = getValue(payload.item_name);
        const item_value = getValue(payload.item_value);
        const title = getValue(payload.title);
        const group = getValue(payload.group);

        // Проверка обязательных полей
        if (!room || !item_name || item_value === undefined) {
            throw new Error(`Missing required fields: room=${room}, item_name=${item_name}, item_value=${item_value}`);
        }

    // Создаем директорию рекурсивно
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
        console.log(`📂 Создана директория: ${dataDir}`);
    }

    const filePath = path.join(dataDir, `${name}.json`);
    
    // Шаблон по умолчанию (соответствует требуемой структуре)
    let data = {
        init: {
            title: "",
            dID: name,
        }
    };

    try {
        // Загрузка существующих данных
        if (fs.existsSync(filePath)) {
            console.log(`📂 Читаем данные из ${filePath}`);
            const rawData = fs.readFileSync(filePath, 'utf8');
            data = JSON.parse(rawData);
        }
    } catch (err) {
        console.error(`Ошибка чтения файла ${filePath}:`, err);
        return 'error';
    }

    // Проверяем, существует ли комната
    if (!data[room]) {
        // Создаем новую комнату с базовой структурой
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
    try {
        const dataString = JSON.stringify(data, null, 2);
        fs.writeFileSync(filePath, dataString);
        console.log(`✅ Данные успешно обновлены в ${filePath}`);
        console.log('Содержимое файла:', dataString);
        return 'ok';
    } catch (err) {
        console.error(`Ошибка записи в файл ${filePath}:`, err);
        return 'error';
    }
}

module.exports = {
    handlePost
};