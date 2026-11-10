process.env.AUTH_BCRYPT_ROUNDS = '4';
process.env.DEFAULT_USER_PASSWORD = 'Passw0rd!x';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let dir;
let store;

function loadStore() {
  jest.resetModules();
  process.env.USERS_FILE = path.join(dir, 'users.enc');
  process.env.AUTH_KEY_FILE = path.join(dir, 'auth.key');
  store = require('../services/userStore');
  return store;
}

function writeLegacyFile(data) {
  const key = crypto.randomBytes(32);
  fs.writeFileSync(path.join(dir, 'auth.key'), key.toString('hex'));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(data))), cipher.final()]);
  fs.writeFileSync(path.join(dir, 'users.enc'), Buffer.concat([iv, cipher.getAuthTag(), enc]));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'userstore-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('userStore: начальные данные и миграция', () => {
  test('bootstrap создаёт администратора с новыми полями', async () => {
    loadStore();
    const { users } = await store.loadUsers();
    const u = users[0];
    expect(u.uid).toMatch(/^[0-9a-f-]{36}$/);
    expect(u.disabled).toBe(false);
    expect(u.telegram).toEqual({ chatId: null, username: null, firstName: null, linkedAt: null });
    expect(u.notify).toEqual({ telegram: true, minSeverity: 'info' });
  });

  test('старые записи дополняются полями и сохраняются', async () => {
    writeLegacyFile({
      users: [{ id: 1, username: 'olduser', password: 'hash', permissionLevel: 3, dID: 'old_base', dataSourceName: 'Old' }],
      datasources: [{ id: 1, did: 'old_base', name: 'Old' }],
    });
    loadStore();
    const { users } = await store.loadUsers();
    const uid = users[0].uid;
    expect(uid).toBeDefined();
    expect(users[0].notify.telegram).toBe(true);

    loadStore();
    const again = await store.loadUsers();
    expect(again.version).toBe(2);
    expect(again.users[0].uid).toBe(uid);
  });
});

describe('userStore: регистрация', () => {
  test('сохраняет email, имя и настройки оповещений', async () => {
    loadStore();
    const res = await store.registerUser('ivan', 'longpassword', 1, 'house1', 'House', {
      email: 'ivan@example.com',
      displayName: 'Иван',
      notify: { minSeverity: 'warning' },
    });
    expect(res.user.email).toBe('ivan@example.com');
    expect(res.user.displayName).toBe('Иван');
    expect(res.user.notify).toEqual({ telegram: true, minSeverity: 'warning' });
    expect(res.user.password).toBeUndefined();
  });

  test('выводит dID из username', async () => {
    loadStore();
    const res = await store.registerUser('john.doe', 'longpassword', 2);
    expect(res.user.dID).toBe('john_doe_base');
  });

  test('отклоняет дубликат, плохой email и плохой minSeverity', async () => {
    loadStore();
    await store.registerUser('ivan', 'longpassword', 1, 'h1');
    await expect(store.registerUser('IVAN', 'longpassword', 1, 'h1')).rejects.toMatchObject({ code: 'USER_EXISTS' });
    await expect(store.registerUser('petr', 'longpassword', 1, 'h1', 'h1', { email: 'nope' }))
      .rejects.toMatchObject({ code: 'BAD_EMAIL' });
    await expect(store.registerUser('petr', 'longpassword', 1, 'h1', 'h1', { notify: { minSeverity: 'x' } }))
      .rejects.toMatchObject({ code: 'BAD_NOTIFY' });
  });
});

describe('userStore: управление', () => {
  test('смена уровня отзывает токены', async () => {
    loadStore();
    await store.registerUser('ivan', 'longpassword', 1, 'h1');
    const before = (await store.findUser('ivan')).tokenVersion;
    const res = await store.updateUser('ivan', { permissionLevel: 2 });
    expect(res.revoked).toBe(true);
    expect((await store.findUser('ivan')).tokenVersion).toBe(before + 1);
  });

  test('изменение email не отзывает токены', async () => {
    loadStore();
    await store.registerUser('ivan', 'longpassword', 1, 'h1');
    const res = await store.updateUser('ivan', { email: 'a@b.co' });
    expect(res.revoked).toBe(false);
  });

  test('неизвестные поля отклоняются', async () => {
    loadStore();
    await expect(store.updateUser('poddy', { password: 'x' })).rejects.toMatchObject({ code: 'BAD_FIELD' });
  });

  test('нельзя лишить систему последнего администратора', async () => {
    loadStore();
    await expect(store.updateUser('poddy', { permissionLevel: 1 })).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    await expect(store.updateUser('poddy', { disabled: true })).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    await expect(store.deleteUser('poddy')).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    expect((await store.findUser('poddy')).permissionLevel).toBe(3);
  });

  test('второго администратора можно понизить', async () => {
    loadStore();
    await store.registerUser('boss2', 'longpassword', 3, 'h1');
    const res = await store.updateUser('boss2', { permissionLevel: 1 });
    expect(res.user.permissionLevel).toBe(1);
  });

  test('linkUserToDataSource меняет dID и отзывает токены', async () => {
    loadStore();
    const { user } = await store.registerUser('ivan', 'longpassword', 1, 'h1');
    await store.registerUser('petr', 'longpassword', 1, 'h2');
    const target = (await store.listDataSources()).find((d) => d.did === 'h2');
    const res = await store.linkUserToDataSource(user.id, target.id);
    expect(res.user.dID).toBe('h2');
    expect(res.revoked).toBe(true);
  });

  test('setPassword с mustChange', async () => {
    loadStore();
    await store.registerUser('ivan', 'longpassword', 1, 'h1');
    await store.setPassword('ivan', 'newlongpassword', { mustChange: true });
    expect((await store.findUser('ivan')).mustChangePassword).toBe(true);
    expect(await store.verifyCredentials('ivan', 'newlongpassword')).not.toBeNull();
  });
});

describe('userStore: Telegram и получатели', () => {
  test('привязка, поиск по chatId и отвязка', async () => {
    loadStore();
    await store.registerUser('ivan', 'longpassword', 1, 'h1');
    const user = await store.setTelegram('ivan', { chatId: 12345, username: 'ivan_tg', firstName: 'Иван' });
    expect(user.telegram.linked).toBe(true);
    expect((await store.findByTelegramChatId(12345)).username).toBe('ivan');

    await store.clearTelegram('ivan');
    expect(await store.findByTelegramChatId(12345)).toBeNull();
  });

  test('один чат нельзя привязать к двум учётным записям', async () => {
    loadStore();
    await store.registerUser('ivan', 'longpassword', 1, 'h1');
    await store.registerUser('petr', 'longpassword', 1, 'h1');
    await store.setTelegram('ivan', { chatId: 1 });
    await expect(store.setTelegram('petr', { chatId: 1 })).rejects.toMatchObject({ code: 'TELEGRAM_BUSY' });
  });

  test('findUsersForNotification учитывает dID, уровень и блокировку', async () => {
    loadStore();
    await store.registerUser('low', 'longpassword', 1, 'h1');
    await store.registerUser('mid', 'longpassword', 2, 'h1');
    await store.registerUser('off', 'longpassword', 3, 'h1');
    await store.registerUser('other', 'longpassword', 3, 'h2');
    await store.updateUser('off', { disabled: true });

    const names = (await store.findUsersForNotification({ dID: 'h1', minLevel: 2 })).map((u) => u.username);
    expect(names).toEqual(['mid']);
  });

  test('toPublic не раскрывает chatId и хеш пароля', async () => {
    loadStore();
    await store.registerUser('ivan', 'longpassword', 1, 'h1');
    const pub = await store.setTelegram('ivan', { chatId: 98765432101 });
    const json = JSON.stringify(pub);
    expect(json).not.toContain('98765432101');
    expect(json).not.toContain('password');
  });
});
