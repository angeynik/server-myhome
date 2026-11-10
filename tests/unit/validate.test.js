
const { validType, validMessage } = require('../services/validate');

const base = () => ({
  type: 'message',
  name: 'angey_bmax',
  payload: { message: 'Протечка в котельной' },
});

describe('validate.validMessage', () => {
  test('подставляет значения по умолчанию', () => {
    const { value, error } = validMessage(base());
    expect(error).toBeUndefined();
    expect(value.request).toBe('notify');
    expect(value.payload.level).toBe(1);
    expect(value.payload.severity).toBe('info');
  });

  test('приводит level из строки к числу', () => {
    const msg = base();
    msg.payload.level = '2';
    expect(validMessage(msg).value.payload.level).toBe(2);
  });

  test('отклоняет некорректный dID', () => {
    const msg = base();
    msg.name = '../etc/passwd';
    expect(validMessage(msg).error).toBeDefined();
  });

  test.each([
    ['пустой текст', { message: '   ' }],
    ['уровень вне диапазона', { message: 'x', level: 5 }],
    ['неизвестная важность', { message: 'x', severity: 'critical' }],
    ['слишком длинный текст', { message: 'x'.repeat(3501) }],
  ])('отклоняет: %s', (_name, payload) => {
    expect(validMessage({ type: 'message', name: 'd1', payload }).error).toBeDefined();
  });

  test('требует payload', () => {
    expect(validMessage({ type: 'message', name: 'd1' }).error).toBeDefined();
  });

  test('отбрасывает лишние поля payload', () => {
    const msg = base();
    msg.payload.evil = '<script>';
    expect(validMessage(msg).value.payload.evil).toBeUndefined();
  });
});

describe('validate.validType', () => {
  test('допускает type message', () => {
    expect(validType({ type: 'message' }).error).toBeUndefined();
  });
});
