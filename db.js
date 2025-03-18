const { Pool } = require('pg');

// Начальные настройки подключения к базе данных
const config = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_DATABASE || 'spring', // По умолчанию 'spring'
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
};

// Создаем пул соединений с начальными настройками
let pool = new Pool(config);

const setDatabase = (databaseName, user, pass ) => {
  if (pool) {
    // Завершаем старый пул, если он существует
    console.log(`setDatabase - 1 - Pool ended, Завершаем старый пул, если он существует`);
    pool.end();
  }

  // Пересоздаём новый пул соединений с указанием новой базы данных
  console.log(`setDatabase - 2 - Создаем новый Pool соединений с указанием новой базы данных ${databaseName} пользователя ${user} и пароля ${pass}`);
  pool = new Pool({
    user: user, // Замените на ваше имя пользователя
    host: 'localhost',
    database: databaseName,
    password: pass, // Замените на ваш пароль
    port: 5432,
  });
    console.log(`setDatabase - 3 - Pool создан`);
  return pool;
};

// Функция для выполнения запросов
const query = async (text, params, databaseName) => {
  if (databaseName) {
    setDatabase(databaseName);
  }

  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    // console.log('Executed query:', { text, duration, rows: res.rowCount });
    return res;
  } catch (error) {
    // Логируем ошибки только в продакшене
    if (process.env.NODE_ENV === 'production') {
      console.error('Error executing query:', error);
    }
    throw error;
  }
};

module.exports = { query, pool, setDatabase };