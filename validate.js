const Joi = require('joi');

// Валидация типа сообщения - type
const schemaType = Joi.object({
    type: Joi.string().valid('response', 'config', 'post', 'get', 'req', 'set', 'init', 'auth', 'log').required(),
    // Добавьте другие поля, которые должны быть в сообщении
}).unknown(true); // Позволяет дополнительные поля
  
  function validType(message) {
    const { error, value } = schemaType.validate(message); // Передаем весь объект message
    if (error) {
      console.log(`Ошибка валидации Type: ${value.type} - ${error.message}`);
      return { error };
    } else {
      //console.log('Формат данных корректный - Type:', value.type);
      return { value };
    }
  };

  // Проверка сообщения с типом - post
const roomSchema = Joi.object({
    sensors: Joi.object().pattern(/^[das][a-zA-Z0-9]{0,15}$/, // Имя должно начинаться с "d", "a" или "s" и содержать не более 16 букв или цифр
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
function validPost(message) {
    const { error, value } = schemaPostSensor.validate(message);

    if (error) {
        console.log('Ошибка валидации данных POST:', error.details);
        return { error };
    } else {
        console.log('Формат данных корректный:', value);
        
    }
};

function validConfig(message) {
    console.log('Сообщение для валидации:', message);
    return "ok";  
};

module.exports = { validType, validConfig, validPost};

