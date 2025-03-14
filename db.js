const { Pool } = require('pg');

// Настройки подключения к базе данных
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST || 'localhost',
  // database: process.env.DB_DATABASE,
  database: 'spring',
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
});

// Функция для выполнения запросов
const query = async (text, params) => {
  // text — строка, содержащая SQL-запрос.
  // params — массив параметров для подстановки в запрос которые будут переданы в SQL-запрос
  const start = Date.now();
  try {
    //console.log('pool:', pool);
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    //console.log('Executed query:', { text, duration, rows: res.rowCount });
    return res;
  } catch (error) {
        // Логируем ошибки только в продакшене
    if (process.env.NODE_ENV === 'production') {
      console.error('Error executing query:', error);
    }
    throw error;
  }
};

module.exports = { query, pool };