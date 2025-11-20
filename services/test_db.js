// Проверка авторизации пользователя по умолчанию в случае сбоев DB 

const { Pool } = require('pg');

const pool = new Pool({
  user: 'root',
  host: 'localhost',
  database: 'spring',
  password: 'poddyPASS',
  port: 2354,
});

async function testConnection() {
  try {
    const client = await pool.connect();
    console.log('✅ Подключение к PostgreSQL успешно!');
    const result = await client.query('SELECT NOW()');
    console.log('Время сервера:', result.rows[0].now);
    client.release();
    process.exit(0);
  } catch (error) {
    console.error('❌ Ошибка подключения:', error.message);
    process.exit(1);
  }
}

testConnection();