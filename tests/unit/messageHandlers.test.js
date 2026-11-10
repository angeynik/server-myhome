
jest.mock('../services/userStore', () => ({
  registerUser: jest.fn(),
  updateUser: jest.fn(),
  updateOwnProfile: jest.fn(),
  clearTelegram: jest.fn(),
  setPassword: jest.fn(),
  deleteUser: jest.fn(),
  linkUserToDataSource: jest.fn(),
  listUsers: jest.fn(),
  listDataSources: jest.fn(),
  fetchUsers: jest.fn(),
}));
jest.mock('../services/auth', () => ({
  getSession: jest.fn(),
  invalidateUserSessions: jest.fn(),
  getProfile: jest.fn(),
  loginUser: jest.fn(),
}));
jest.mock('../classes/wsManager', () => ({
  sendToConnection: jest.fn(),
  updateConnection: jest.fn(),
}));
jest.mock('../services/notifyService', () => ({ getRecent: jest.fn(() => [{ payload: { message: 'm' } }]) }));
jest.mock('../services/telegramService', () => ({ get: jest.fn() }));
jest.mock('../services/videoStreamService', () => ({ getLastSnapshot: jest.fn(), getStats: jest.fn() }));
jest.mock('../services/configStore', () => ({
  writeFileSafely: jest.fn(),
  readFileSafely: jest.fn(),
  saveNamedConfig: jest.fn(),
  namedConfigExists: jest.fn(),
}));
jest.mock('../services/clientsStore', () => ({ nodeRedClients: new Map() }));

const userStore = require('../services/userStore');
const auth = require('../services/auth');
const wsManager = require('../classes/wsManager');
const notifyService = require('../services/notifyService');
const telegramService = require('../services/telegramService');
const videoStreamService = require('../services/videoStreamService');
const { handlePost, handleAuth, handleGet } = require('../services/messageHandlers');

const post = (request, payload) => handlePost('c1', { type: 'post', request, name: 'd1', payload });
const sent = (request) => wsManager.sendToConnection.mock.calls.find((c) => c[3] === request);

beforeEach(() => {
  jest.clearAllMocks();
  auth.getSession.mockReturnValue({ username: 'boss', level: 3, dID: 'd1' });
});

describe('handlePost: пользователи', () => {
  test('createUser передаёт email, имя и настройки', async () => {
    userStore.registerUser.mockResolvedValue({ user: { username: 'ivan' }, userCreated: true });
    await post('createUser', {
      username: 'ivan', password: 'longpassword', permissionLevel: 1, dataSource: 'h1',
      email: 'a@b.co', displayName: 'Иван', notify: { telegram: false },
    });
    expect(userStore.registerUser).toHaveBeenCalledWith(
      'ivan', 'longpassword', 1, 'h1', 'h1',
      { email: 'a@b.co', displayName: 'Иван', notify: { telegram: false }, mustChangePassword: false }
    );
    expect(sent('createUserSuccess')).toBeDefined();
  });

  test('createUser без dataSource допустим (dID выводится из имени)', async () => {
    userStore.registerUser.mockResolvedValue({ user: {}, userCreated: true });
    await post('createUser', { username: 'ivan', password: 'longpassword', permissionLevel: 1 });
    expect(userStore.registerUser.mock.calls[0].slice(3, 5)).toEqual([undefined, undefined]);
  });

  test('createUser без обязательных полей — ошибка', async () => {
    await post('createUser', { username: 'ivan' });
    expect(userStore.registerUser).not.toHaveBeenCalled();
    expect(sent('createUserError')).toBeDefined();
  });

  test('userConfigRequest возвращает пользователей и источники', async () => {
    userStore.listUsers.mockResolvedValue([{ username: 'a' }]);
    userStore.listDataSources.mockResolvedValue([{ did: 'd1' }]);
    await post('userConfigRequest', {});
    expect(sent('userConfig')[5]).toEqual({ users: [{ username: 'a' }], datasources: [{ did: 'd1' }] });
  });

  test('userConfigEdit: отзыв сессий при revoked', async () => {
    userStore.updateUser.mockResolvedValue({ user: { username: 'ivan' }, revoked: true });
    await post('userConfigEdit', { username: 'ivan', patch: { permissionLevel: 2 } });
    expect(auth.invalidateUserSessions).toHaveBeenCalledWith('ivan');
    expect(sent('userConfigEditSuccess')).toBeDefined();
  });

  test('userConfigEdit: нельзя понизить или заблокировать себя', async () => {
    await post('userConfigEdit', { username: 'BOSS', patch: { permissionLevel: 1 } });
    await post('userConfigEdit', { username: 'boss', patch: { disabled: true } });
    expect(userStore.updateUser).not.toHaveBeenCalled();
    expect(wsManager.sendToConnection.mock.calls.filter((c) => c[3] === 'userConfigEditError')).toHaveLength(2);
    expect(sent('userConfigEditError')[5].code).toBe('SELF_EDIT');
  });

  test('userConfigEdit: свои настройки оповещений менять можно', async () => {
    userStore.updateUser.mockResolvedValue({ user: {}, revoked: false });
    await post('userConfigEdit', { username: 'boss', patch: { notify: { telegram: false } } });
    expect(userStore.updateUser).toHaveBeenCalled();
    expect(auth.invalidateUserSessions).not.toHaveBeenCalled();
  });

  test('userConfigEdit: ошибка store возвращается с кодом', async () => {
    userStore.updateUser.mockRejectedValue(Object.assign(new Error('last'), { code: 'LAST_ADMIN' }));
    await post('userConfigEdit', { username: 'other', patch: { disabled: true } });
    expect(sent('userConfigEditError')[5].code).toBe('LAST_ADMIN');
  });

  test('resetUserPassword ставит mustChange и сбрасывает сессии', async () => {
    userStore.setPassword.mockResolvedValue({ username: 'ivan' });
    await post('resetUserPassword', { username: 'ivan', newPassword: 'newlongpassword' });
    expect(userStore.setPassword).toHaveBeenCalledWith('ivan', 'newlongpassword', { mustChange: true });
    expect(auth.invalidateUserSessions).toHaveBeenCalledWith('ivan');
    expect(JSON.stringify(sent('resetUserPasswordSuccess')[5])).not.toContain('newlongpassword');
  });

  test('deleteUser: себя удалить нельзя', async () => {
    await post('deleteUser', { username: 'boss' });
    expect(userStore.deleteUser).not.toHaveBeenCalled();
    expect(sent('deleteUserError')[5].code).toBe('SELF_DELETE');
  });

  test('deleteUser: удаляет и сбрасывает сессии', async () => {
    userStore.deleteUser.mockResolvedValue({ username: 'ivan', dID: 'd1', otherUsersOnSameDID: 0 });
    await post('deleteUser', { username: 'ivan' });
    expect(auth.invalidateUserSessions).toHaveBeenCalledWith('ivan');
    expect(sent('deleteUserSuccess')).toBeDefined();
  });

  test('linkUserToDataSource сбрасывает сессии при смене dID', async () => {
    userStore.linkUserToDataSource.mockResolvedValue({ user: { username: 'ivan' }, revoked: true });
    await post('linkUserToDataSource', { userId: 2, dataSourceId: 3 });
    expect(auth.invalidateUserSessions).toHaveBeenCalledWith('ivan');
    expect(sent('linkUserToDataSourceSuccess')).toBeDefined();
  });
});

describe('handleAuth: профиль и Telegram', () => {
  const run = (request, payload = {}) => handleAuth('c1', { type: 'auth', request, name: 'd1', payload });

  test('login отдаёт profile', async () => {
    auth.loginUser.mockResolvedValue({
      token: 't', username: 'ivan', userlevel: 1, dID: 'd1', mustChangePassword: false, profile: { uid: 'u' },
    });
    await run('login', { username: 'ivan', password: 'x' });
    expect(sent('loginSuccess')[5].profile).toEqual({ uid: 'u' });
  });

  test('telegramLinkCode: Telegram выключен', async () => {
    telegramService.get.mockReturnValue(null);
    await run('telegramLinkCode');
    expect(sent('telegramLinkError')[5].code).toBe('TELEGRAM_DISABLED');
  });

  test('telegramLinkCode: код выдаётся текущему пользователю', async () => {
    const createLinkCode = jest.fn(() => ({ code: 'ABCD2345' }));
    telegramService.get.mockReturnValue({ createLinkCode });
    await run('telegramLinkCode');
    expect(createLinkCode).toHaveBeenCalledWith('boss');
    expect(sent('telegramLinkCode')[5]).toEqual({ code: 'ABCD2345' });
  });

  test('telegramUnlink отвязывает чат текущего пользователя', async () => {
    userStore.clearTelegram.mockResolvedValue({ username: 'boss' });
    await run('telegramUnlink');
    expect(userStore.clearTelegram).toHaveBeenCalledWith('boss');
    expect(sent('telegramUnlinkSuccess')).toBeDefined();
  });

  test('updateProfile: только свои поля, ошибки с кодом', async () => {
    userStore.updateOwnProfile.mockRejectedValue(Object.assign(new Error('bad'), { code: 'BAD_EMAIL' }));
    await run('updateProfile', { email: 'x', level: 3 });
    expect(userStore.updateOwnProfile).toHaveBeenCalledWith('boss', { email: 'x', displayName: undefined, notify: undefined });
    expect(sent('updateProfileError')[5].code).toBe('BAD_EMAIL');
  });

  test('profile', async () => {
    auth.getProfile.mockResolvedValue({ username: 'boss' });
    await run('profile');
    expect(sent('profile')[5]).toEqual({ profile: { username: 'boss' } });
  });
});

describe('handleGet: messages', () => {
  test('история берётся по dID и уровню сессии, а не по name из сообщения', async () => {
    auth.getSession.mockReturnValue({ username: 'ivan', level: 2, dID: 'mine' });
    await handleGet('c1', { type: 'get', request: 'messages', name: 'someone_else' });
    expect(notifyService.getRecent).toHaveBeenCalledWith('mine', 2);
    expect(sent('messages')[5].items).toHaveLength(1);
  });
});

describe('handleGet: видео', () => {
  const get = (request) => handleGet('c1', { type: 'get', request, name: 'd1' });

  test('videoSnapshot отдаёт последний кадр с учётом сессии', async () => {
    const session = { username: 'ivan', level: 1, dID: 'd1' };
    auth.getSession.mockReturnValue(session);
    videoStreamService.getLastSnapshot.mockReturnValue({ image: 'AAA', mimeType: 'image/jpeg' });
    await get('videoSnapshot');
    expect(videoStreamService.getLastSnapshot).toHaveBeenCalledWith(session);
    expect(sent('videoSnapshot')[5]).toEqual({ image: 'AAA', mimeType: 'image/jpeg' });
  });

  test('videoSnapshot: нет кадра или нет доступа — ошибка NO_SNAPSHOT', async () => {
    videoStreamService.getLastSnapshot.mockReturnValue(null);
    await get('videoSnapshot');
    expect(sent('videoSnapshotError')[5].code).toBe('NO_SNAPSHOT');
    expect(sent('videoSnapshot')).toBeUndefined();
  });

  test('videoStatus возвращает статистику', async () => {
    videoStreamService.getStats.mockReturnValue({ isRunning: true });
    await get('videoStatus');
    expect(sent('videoStatus')[5]).toEqual({ isRunning: true });
  });
});
