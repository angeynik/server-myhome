
jest.mock('../../services/userStore', () => ({
  registerUser: jest.fn(),
  updateUser: jest.fn(),
  updateOwnProfile: jest.fn(),
  clearTelegram: jest.fn(),
  setPassword: jest.fn(),
  deleteUser: jest.fn(),
  linkUserToDataSource: jest.fn(),
  listUsers: jest.fn(),
  listDataSources: jest.fn(),
}));
jest.mock('../../services/auth', () => ({
  getSession: jest.fn(),
  invalidateUserSessions: jest.fn(),
  getProfile: jest.fn(),
  loginUser: jest.fn(),
}));
jest.mock('../../classes/wsManager', () => ({
  sendToConnection: jest.fn(),
  updateConnection: jest.fn(),
}));
jest.mock('../../services/notifyService', () => ({ getRecent: jest.fn(() => [{ payload: { message: 'm' } }]) }));
jest.mock('../../services/telegramService', () => ({ get: jest.fn() }));
jest.mock('../../services/videoHub', () => ({
  getLastSnapshot: jest.fn(), getStats: jest.fn(), listCameras: jest.fn(), subscribe: jest.fn(),
}));
const mockNotificationService = {
  applyChange: jest.fn(),
  getSnapshot: jest.fn(),
};
jest.mock('../../services/notificationService', () => ({ get: () => mockNotificationService }));
const mockNotificationStore = { list: jest.fn(), readStatus: jest.fn() };
const mockScenarioService = { applyChange: jest.fn() };
jest.mock('../../services/scenarioService', () => ({ get: () => mockScenarioService }));
const mockScenarioStore = { read: jest.fn() };
jest.mock('../../services/scenarioStore', () => ({
  createScenarioStore: () => mockScenarioStore,
  validateSettings: () => ({ tzOffsetMin: 180, manualOverrideSec: 3600, maxCommandsPerMin: 6 }),
}));
jest.mock('../../services/notificationStore', () => ({ createNotificationStore: () => mockNotificationStore }));
jest.mock('../../services/configStore', () => ({
  writeFileSafely: jest.fn(),
  readFileSafely: jest.fn(),
}));

const userStore = require('../../services/userStore');
const auth = require('../../services/auth');
const wsManager = require('../../classes/wsManager');
const notifyService = require('../../services/notifyService');
const telegramService = require('../../services/telegramService');
const videoHub = require('../../services/videoHub');
const { readFileSafely } = require('../../services/configStore');
const { handlePost, handleAuth, handleGet } = require('../../services/messageHandlers');

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
  const get = (request, payload) => handleGet('c1', { type: 'get', request, name: 'd1', payload });

  test('videoSnapshot отдаёт последний кадр с учётом сессии', async () => {
    const session = { username: 'ivan', level: 1, dID: 'd1' };
    auth.getSession.mockReturnValue(session);
    videoHub.getLastSnapshot.mockReturnValue({ image: 'AAA', mimeType: 'image/jpeg' });
    await get('videoSnapshot');
    expect(videoHub.getLastSnapshot).toHaveBeenCalledWith(session, undefined);
    expect(sent('videoSnapshot')[5]).toEqual({ image: 'AAA', mimeType: 'image/jpeg' });
  });

  test('videoSnapshot: нет кадра или нет доступа — ошибка NO_SNAPSHOT', async () => {
    videoHub.getLastSnapshot.mockReturnValue(null);
    await get('videoSnapshot');
    expect(sent('videoSnapshotError')[5].code).toBe('NO_SNAPSHOT');
    expect(sent('videoSnapshot')).toBeUndefined();
  });

  test('videoSnapshot с cameraId запрашивает кадр этой камеры', async () => {
    const session = { username: 'ivan', level: 1, dID: 'd1' };
    auth.getSession.mockReturnValue(session);
    videoHub.getLastSnapshot.mockReturnValue({ cameraId: 'cam02', image: 'BBB' });
    await get('videoSnapshot', { cameraId: 'cam02' });
    expect(videoHub.getLastSnapshot).toHaveBeenCalledWith(session, 'cam02');
    expect(sent('videoSnapshot')[5]).toEqual({ cameraId: 'cam02', image: 'BBB' });
  });

  test('videoCameras возвращает камеры, доступные сессии', async () => {
    const session = { username: 'ivan', level: 1, dID: 'd1' };
    auth.getSession.mockReturnValue(session);
    videoHub.listCameras.mockReturnValue([{ id: 'cam01', title: 'Ворота', status: 'online' }]);
    await get('videoCameras');
    expect(videoHub.listCameras).toHaveBeenCalledWith(session);
    expect(sent('videoCameras')[5]).toEqual({ cameras: [{ id: 'cam01', title: 'Ворота', status: 'online' }] });
  });

  test('videoStatus возвращает статистику', async () => {
    videoHub.getStats.mockReturnValue({ isRunning: true });
    await get('videoStatus');
    expect(sent('videoStatus')[5]).toEqual({ isRunning: true });
  });
});

describe('handlePost: подписка на камеры', () => {
  test('videoSubscribe передаёт подписку хабу и отвечает принятым списком', async () => {
    const session = { username: 'ivan', level: 1, dID: 'd1' };
    auth.getSession.mockReturnValue(session);
    videoHub.subscribe.mockReturnValue({ cameras: ['cam01'], full: null });
    await post('videoSubscribe', { cameras: ['cam01', 'чужая'], full: 'x', лишнее: 1 });
    expect(videoHub.subscribe).toHaveBeenCalledWith('c1', session, { cameras: ['cam01', 'чужая'], full: 'x' });
    expect(sent('videoSubscribeSuccess')[5]).toEqual({ cameras: ['cam01'], full: null });
  });
});

describe('уведомления', () => {
  const get = (request, payload) => handleGet('c1', { type: 'get', request, name: 'd1', payload });
  const allSent = () => wsManager.sendToConnection.mock.calls.map((c) => c[3]);

  test('get/config: вместе с config — конфигурация уведомлений и статусы, если есть', async () => {
    readFileSafely.mockResolvedValue({ data: { room01: {} } });
    mockNotificationStore.list.mockResolvedValue({ 'room01:sensors:dTemp01': { id: 'room01:sensors:dTemp01' } });
    mockNotificationStore.readStatus.mockResolvedValue({ 'room01:sensors:dTemp01': { status: 'ON', read: 'OFF' } });
    await get('config');
    expect(allSent()).toEqual(['config', 'notification', 'notificationStatus']);
    expect(sent('notificationStatus')[5]).toEqual({ 'room01:sensors:dTemp01': { status: 'ON', read: 'OFF' } });
  });

  test('get/config: файлов уведомлений нет — только config', async () => {
    readFileSafely.mockResolvedValue({ data: {} });
    mockNotificationStore.list.mockResolvedValue(null);
    mockNotificationStore.readStatus.mockResolvedValue(null);
    await get('config');
    expect(allSent()).toEqual(['config']);
  });

  test('get/notificationSnapshot: кадр или ошибка NO_SNAPSHOT', async () => {
    mockNotificationService.getSnapshot.mockResolvedValueOnce({ id: 'x', cameraId: 'cam01', image: 'AAA' });
    await get('notificationSnapshot', { id: 'x', cameraId: 'cam01' });
    expect(mockNotificationService.getSnapshot).toHaveBeenCalledWith('d1', 'x', 'cam01');
    expect(sent('notificationSnapshot')[5]).toMatchObject({ image: 'AAA' });

    mockNotificationService.getSnapshot.mockResolvedValueOnce(null);
    await get('notificationSnapshot', { id: 'x', cameraId: 'cam02' });
    expect(sent('notificationSnapshotError')[5]).toMatchObject({ code: 'NO_SNAPSHOT' });
  });

  test('post/notification: действие и данные передаются службе с автором; автору — подтверждение', async () => {
    mockNotificationService.applyChange.mockResolvedValue({ id: 'room01:sensors:dTemp01', items: {} });
    const configData = { room: 'room01', section: 'sensors', item: 'dTemp01', condition: { op: 'gt', value: 25 } };
    await post('notification', { action: 'create', configData });
    expect(mockNotificationService.applyChange).toHaveBeenCalledWith('d1', 'create', configData, expect.objectContaining({ username: 'boss' }));
    expect(sent('notificationSuccess')[5]).toEqual({ action: 'create', id: 'room01:sensors:dTemp01' });
  });

  test('post/notification: ошибка — notificationError с кодом', async () => {
    mockNotificationService.applyChange.mockRejectedValue(Object.assign(new Error('Неверные данные'), { code: 'BAD_NOTIFICATION' }));
    await post('notification', { action: 'edit', configData: {} });
    expect(sent('notificationError')[5]).toMatchObject({ code: 'BAD_NOTIFICATION', action: 'edit', message: 'Неверные данные' });
  });
});

describe('handlePost: результат для commandGateway', () => {
  test('успех — { ok: true }; ошибка — { ok: false, error, code }', async () => {
    readFileSafely.mockResolvedValue({ data: { room01: { setpoints: { sTemp01: { value: 20 } } } }, filePath: '/tmp/x.json' });
    await expect(post('setpoints', { room: 'room01', setKey: 'sTemp01', value: 22 })).resolves.toEqual({ ok: true });
    readFileSafely.mockRejectedValue(new Error('диск недоступен'));
    await expect(post('setpoints', { room: 'room01', setKey: 'sTemp01', value: 22 }))
      .resolves.toEqual({ ok: false, error: 'диск недоступен', code: 'setpointError' });
  });
});

describe('сценарии', () => {
  const get = (request, payload = {}) => handleGet('c1', { type: 'get', request, name: 'd1', payload });

  test('get/scenarios: файл или пустой набор с настройками по умолчанию', async () => {
    mockScenarioStore.read.mockResolvedValueOnce({ settings: {}, scenarios: { a: {} } });
    await get('scenarios');
    expect(sent('scenarios')[5]).toEqual({ settings: {}, scenarios: { a: {} } });
    wsManager.sendToConnection.mockClear();
    mockScenarioStore.read.mockResolvedValueOnce(null);
    await get('scenarios');
    expect(sent('scenarios')[5]).toEqual({ settings: { tzOffsetMin: 180, manualOverrideSec: 3600, maxCommandsPerMin: 6 }, scenarios: {} });
  });

  test('post/scenarios: служба получает действие и автора; автору — подтверждение или ошибка с кодом', async () => {
    mockScenarioService.applyChange.mockResolvedValueOnce({ id: 'a', delivered: 1 });
    const r = await post('scenarios', { action: 'create', configData: { id: 'a' } });
    expect(mockScenarioService.applyChange).toHaveBeenCalledWith('d1', 'create', { id: 'a' }, expect.objectContaining({ username: 'boss' }));
    expect(sent('scenariosSuccess')[5]).toEqual({ action: 'create', id: 'a', delivered: 1 });
    expect(r).toEqual({ ok: true });
    mockScenarioService.applyChange.mockRejectedValueOnce(Object.assign(new Error('Неверный сценарий'), { code: 'BAD_SCENARIO' }));
    const r2 = await post('scenarios', { action: 'edit', configData: {} });
    expect(sent('scenariosError')[5]).toEqual({ message: 'Неверный сценарий', code: 'BAD_SCENARIO', action: 'edit' });
    expect(r2).toMatchObject({ ok: false, code: 'BAD_SCENARIO' });
  });
});
