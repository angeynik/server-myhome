const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv'); // Подключаем .ENV файл с переменными окружения
dotenv.config({path: './conf.env'}); // Указываем путь к  файлу .env
const dataDir = process.env.DATA_DIR ||'.configData'; // Путь к директории с данными

async function handlePost(clientId, message) {
    const { name, payload, time } = message;
    const { room, item_name, item_value } = payload;

    // Создаем директорию для хранения данных рекурсивно
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true }); // Добавляем рекурсивное создание
        console.log(`📂 Создана директория: ${dataDir}`);
    }

    // Путь к файлу данных
    const filePath = path.join(dataDir, `${name}.json`);

    let data = { rooms: [] };
    
    try {
        // Чтение существующих данных, если файл есть
        if (fs.existsSync(filePath)) {
            console.log(`📂 Читаем данные из ${filePath}`);
            const rawData = fs.readFileSync(filePath, 'utf8');
            data = JSON.parse(rawData);
        }
    } catch (err) {
        console.error(`Ошибка чтения файла ${filePath}:`, err);
        return 'error';
    }

    // Поиск комнаты
    let roomObj = data.rooms.find(r => r.roomName === room);
    
    // Создаем новую комнату если не найдена
    if (!roomObj) {
        roomObj = {
            id: data.rooms.length + 1,
            roomName: room,
            params: []
        };
        data.rooms.push(roomObj);
    }

    // Поиск параметра в комнате
    let param = roomObj.params.find(p => p.paramName === item_name);
    
    if (param) {
        // Обновляем существующий параметр
        param.value = item_value;
        param.time = time;
    } else {
        // Создаем новый параметр
        param = {
            paramName: item_name,
            value: item_value,
            time: time
        };
        roomObj.params.push(param);
    }

    // Сохранение обновленных данных
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log(`✅ Данные успешно обновлены в ${filePath}`);
            // Вывод содержимого файла в консоль
        console.log('Содержимое файла:');
        console.log(dataString);
        return 'ok';
    } catch (err) {
        console.error(`Ошибка записи в файл ${filePath}:`, err);
        return 'error';
    }
}

module.exports = {
    handlePost
};