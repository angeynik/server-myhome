const DBManager = require('./db'); // Импортируем DBManager
const bcrypt = require('bcryptjs');

class UsersManage {
    // Поиск пользователя по имени
    static async findUser(username, dbName, dbUser, dbPass) {
        try {
            const result = await DBManager.query('SELECT * FROM users WHERE username = $1', [username], dbName, dbUser, dbPass);
            return result.rows[0];
        } catch (error) {
            console.error('Ошибка при поиске пользователя:', error);
            throw error;
        }
    }

    // Регистрация нового пользователя
    static async registerUser(username, password, level, did, source, dbName, dbUser, dbPass) {
        try {
            const hashedPassword = await bcrypt.hash(password, 10); // Хешируем пароль
            const result = await DBManager.query(
                `INSERT INTO users (username, password, permission_level, did, source) 
                 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [username, hashedPassword, level, did, source],
                dbName, dbUser, dbPass
            );
            return result.rows[0].id; // Возвращаем ID нового пользователя
        } catch (error) {
            console.error('Ошибка при регистрации пользователя:', error);
            throw error;
        }
    }

    // Получение уровня доступа пользователя по его ID
    static async findLevel(userId, dbName, dbUser, dbPass) {
        try {
            const result = await DBManager.query(
                'SELECT permission_level FROM permissions WHERE user_id = $1',
                [userId],
                dbName, dbUser, dbPass
            );
            return result.rows[0] ? result.rows[0].permission_level : null;
        } catch (error) {
            console.error('Ошибка при получении уровня доступа:', error);
            throw error;
        }
    }

    // Получение списка всех пользователей
    static async getUsers(dbName, dbUser, dbPass) {
        try {
            const result = await DBManager.query('SELECT id, username FROM users', [], dbName, dbUser, dbPass);
            return result.rows.map(row => ({
                id: row.id,
                username: row.username,
            }));
        } catch (error) {
            console.error('Ошибка при получении списка пользователей:', error);
            throw error;
        }
    }

    // Получение списка всех источников данных
    static async getDataSources(dbName, dbUser, dbPass) {
        try {
            const result = await DBManager.query('SELECT id, did FROM DataSources', [], dbName, dbUser, dbPass);
            return result.rows.map(row => ({
                id: row.id,
                did: row.did,
            }));
        } catch (error) {
            console.error('Ошибка при получении списка источников данных:', error);
            throw error;
        }
    }
}

module.exports = UsersManage;