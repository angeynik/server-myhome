
jest.mock('../services/userStore', () => ({
  verifyCredentials: jest.fn(),
  recordLogin: jest.fn(() => Promise.resolve()),
  findUser: jest.fn(),
  toPublic: jest.fn((u) => (u ? { username: u.username } : null)),
}));

const userStore = require('../services/userStore');
const auth = require('../services/auth');

const session = (extra = {}) => ({
  userId: 1, username: 'ivan', dID: 'd1', level: 1, tokenVersion: 0, mustChangePassword: false, ...extra,
});

describe('auth.checkMessageAccess: изоляция по dID', () => {
  beforeEach(() => {
    auth.setSession('c1', session());
    auth.setSession('admin', session({ username: 'boss', level: 3 }));
  });
  afterEach(() => {
    auth.clearSession('c1');
    auth.clearSession('admin');
  });

  test('пользователь работает со своим dID', () => {
    expect(auth.checkMessageAccess('c1', 'get', 'config', 'd1').ok).toBe(true);
  });

  test('чужой dID блокируется', () => {
    const res = auth.checkMessageAccess('c1', 'get', 'config', 'other');
    expect(res).toMatchObject({ ok: false, code: 'DID_MISMATCH' });
  });

  test('администратор (уровень 3) не ограничен', () => {
    expect(auth.checkMessageAccess('admin', 'post', 'createUser', 'other').ok).toBe(true);
  });

  test('без name проверка dID не выполняется (совместимость)', () => {
    expect(auth.checkMessageAccess('c1', 'get', 'config').ok).toBe(true);
  });

  test('уровня 1 недостаточно для управления пользователями и расписаний', () => {
    expect(auth.checkMessageAccess('c1', 'post', 'deleteUser', 'd1').code).toBe('FORBIDDEN');
    expect(auth.checkMessageAccess('c1', 'post', 'resetUserPassword', 'd1').code).toBe('FORBIDDEN');
    expect(auth.checkMessageAccess('c1', 'get', 'schedules', 'd1').code).toBe('FORBIDDEN');
    expect(auth.checkMessageAccess('c1', 'get', 'messages', 'd1').ok).toBe(true);
  });

  test('видео: снимок доступен с уровня 1, статус только администратору', () => {
    expect(auth.checkMessageAccess('c1', 'get', 'videoSnapshot', 'd1').ok).toBe(true);
    expect(auth.checkMessageAccess('c1', 'get', 'videoStatus', 'd1').code).toBe('FORBIDDEN');
    expect(auth.checkMessageAccess('admin', 'get', 'videoStatus', 'd1').ok).toBe(true);
  });

  test('новые auth-запросы требуют сессию', () => {
    expect(auth.checkMessageAccess('c1', 'auth', 'telegramLinkCode').ok).toBe(true);
    expect(auth.checkMessageAccess('nobody', 'auth', 'telegramLinkCode').code).toBe('NO_SESSION');
    expect(auth.checkMessageAccess('nobody', 'auth', 'login').ok).toBe(true);
  });
});

describe('auth.invalidateUserSessions', () => {
  test('удаляет все сессии пользователя без учёта регистра', () => {
    auth.setSession('a', session({ username: 'Ivan' }));
    auth.setSession('b', session({ username: 'ivan' }));
    auth.setSession('c', session({ username: 'petr' }));
    expect(auth.invalidateUserSessions('IVAN')).toBe(2);
    expect(auth.getSession('a')).toBeNull();
    expect(auth.getSession('c')).not.toBeNull();
    auth.clearSession('c');
  });
});

describe('auth.loginUser', () => {
  const user = {
    id: 1, uid: 'u-1', username: 'ivan', dID: 'd1', permissionLevel: 2, tokenVersion: 0, disabled: false,
  };

  test('успешный вход создаёт сессию и возвращает профиль', async () => {
    userStore.verifyCredentials.mockResolvedValue(user);
    const res = await auth.loginUser('cl-ok', 'ivan', 'pass', '1.1.1.1');
    expect(res.token).toBeDefined();
    expect(res.profile).toEqual({ username: 'ivan' });
    expect(auth.getSession('cl-ok')).toMatchObject({ uid: 'u-1', level: 2 });
    expect(userStore.recordLogin).toHaveBeenCalledWith('ivan');
    auth.clearSession('cl-ok');
  });

  test('отключённая учётная запись не входит, сессия не создаётся', async () => {
    userStore.verifyCredentials.mockResolvedValue({ ...user, disabled: true });
    const res = await auth.loginUser('cl-off', 'ivan', 'pass', '2.2.2.2');
    expect(res.code).toBe('ACCOUNT_DISABLED');
    expect(auth.getSession('cl-off')).toBeNull();
  });

  test('неверный пароль', async () => {
    userStore.verifyCredentials.mockResolvedValue(null);
    const res = await auth.loginUser('cl-bad', 'ivan', 'nope', '3.3.3.3');
    expect(res.code).toBe('BAD_CREDENTIALS');
  });

  test('resume отключённого пользователя отклоняется', async () => {
    userStore.findUser.mockResolvedValue({ ...user, disabled: true });
    const token = auth.issueToken(user);
    const res = await auth.resumeSession('cl-res', token);
    expect(res.code).toBe('ACCOUNT_DISABLED');
  });
});
