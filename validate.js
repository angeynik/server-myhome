const Joi = require('joi');

const roomSchema = Joi.object({
    sensors: Joi.object().pattern(/^d[a-zA-Z0-9]{0,15}$/, // Имя должно начинаться с "d" и содержать не более 16 букв или цифр
        Joi.alternatives().try(Joi.boolean(), Joi.number()).required() // Тип данных - числовой или логический
    ).required()
}).unknown(true); // Разрешить неизвестные ключи

const schemaPostSensor = Joi.object({
    type: Joi.string().required(),
    // Используем pattern для проверки объектов с динамическими ключами
    ...Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`room_${String(i).padStart(2, '0')}`, roomSchema])
    ),
    // Добавляем проверку для любых других ключей, соответствующих шаблону
    ...{
        room: Joi.object().pattern(/^room_\d{2}$/, roomSchema)
    }
}).unknown(true); // Разрешить неизвестные ключи

function validType(message) {
    console.log('Сообщение для валидации:', message);
    const { error, value } = schemaPostSensor.validate(message);

    if (error) {
        console.log('Ошибка валидации данных датчика:', error.details);
    } else {
        console.log('Формат данных корректный:', value);
    }
};

function validConfig(message) {
    console.log('Сообщение для валидации:', message);
    return "ok";  
};

module.exports = { validType, validConfig };

