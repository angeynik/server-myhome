// tests/unit/messageStore.test.js
'use strict';

jest.mock('../../services/messageHandlers.js', () => ({ handlePostNodeRED: jest.fn() }));

const { handlePostNodeRED } = require('../../services/messageHandlers.js');
const store = require('../../services/messageStore');

const post = (value, extra = {}) => ({
  type: 'post', request: 'sensors', name: 'd1',
  payload: { room: 'room01', item_name: 'dTemp01', item_value: value, ...extra },
});

describe('messageStore', () => {
  let now;
  beforeEach(() => {
    store.messageQueue.clear();
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());

  test('повтор с тем же ключом заменяет значение, в файл уходит последнее', async () => {
    handlePostNodeRED.mockResolvedValue('ok');
    store.addMessageToQueue('d1', post(20));
    store.addMessageToQueue('d1', post(21));
    await store.processAllQueues();

    expect(handlePostNodeRED).toHaveBeenCalledTimes(1);
    expect(handlePostNodeRED.mock.calls[0][1].payload.item_value).toBe(21);
    expect(store.messageQueue.size).toBe(0);
  });

  test('сообщение, которое бросает ошибку, удаляется после 3 повторов, а не висит вечно', async () => {
    handlePostNodeRED.mockRejectedValue(new Error('Missing required fields'));
    store.addMessageToQueue('d1', post(1));

    for (let i = 0; i < 4; i++) {
      await store.processAllQueues();
      now += 5000;
    }
    expect(handlePostNodeRED).toHaveBeenCalledTimes(4);
    expect(store.messageQueue.size).toBe(0);
  });

  test('между попытками выдерживается пауза 5 с', async () => {
    handlePostNodeRED.mockResolvedValue('error');
    store.addMessageToQueue('d1', post(1));
    await store.processAllQueues();
    now += 1000;
    await store.processAllQueues();
    expect(handlePostNodeRED).toHaveBeenCalledTimes(1);
  });

  test('свежее значение, пришедшее во время записи, не теряется', async () => {
    handlePostNodeRED.mockImplementationOnce(async () => {
      store.addMessageToQueue('d1', post(30)); // пришло, пока писали 29
      return 'ok';
    });
    store.addMessageToQueue('d1', post(29));
    await store.processAllQueues();

    const left = [...store.messageQueue.get('d1').values()];
    expect(left).toHaveLength(1);
    expect(left[0].message.payload.item_value).toBe(30);
  });
});
