
const logger = require('../../services/logger');

describe('logger.redactSecrets', () => {
  test('маскирует пароли и токены в JSON', () => {
    const raw = '{"type":"auth","payload":{"username":"u","password":"p\\"ss","token":"abc"}}';
    const out = logger.redactSecrets(raw);
    expect(out).not.toContain('p\\"ss');
    expect(out).not.toContain('abc');
    expect(out).toContain('"username":"u"');
    expect(out).toContain('"password":"***"');
  });

  test('принимает Buffer', () => {
    const out = logger.redactSecrets(Buffer.from('{"newPassword":"secret123"}'));
    expect(out).toBe('{"newPassword":"***"}');
  });
});

describe('logger: уровни LOG_LEVEL', () => {
  const saved = process.env.LOG_LEVEL;
  let out;
  let err;

  beforeEach(() => {
    out = jest.spyOn(console, 'log').mockImplementation(() => {});
    err = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.LOG_LEVEL = saved;
    logger.initLogging();
    out.mockRestore();
    err.mockRestore();
  });

  function emitAll(level) {
    process.env.LOG_LEVEL = level;
    logger.initLogging();
    logger.logErrorMessage('e');
    logger.logInfoMessage('i');
    logger.logDevMessage('d');
    return { errors: err.mock.calls.length, lines: out.mock.calls.map((c) => c[0]) };
  }

  test.each([
    ['error', 1, []],
    ['info', 1, ['i']],
    ['production', 1, ['i']],
    ['dev', 1, ['i', '[DEV] d']],
    ['none', 0, []],
    ['что-то-неизвестное', 1, ['i']],
  ])('%s: ошибок %i, прочие строки %j', (level, errors, lines) => {
    const res = emitAll(level);
    expect(res.errors).toBe(errors);
    expect(res.lines).toEqual(lines);
  });

  test('ошибки пишутся и на уровне info (по умолчанию)', () => {
    delete process.env.LOG_LEVEL;
    logger.initLogging();
    logger.logErrorMessage('boom');
    expect(err).toHaveBeenCalledWith('[ERROR] boom');
  });

  test('несколько аргументов склеиваются в одну строку', () => {
    process.env.LOG_LEVEL = 'dev';
    logger.initLogging();
    logger.logDevMessage('a', { x: 1 }, new Error('oops'), 5);
    expect(out).toHaveBeenCalledWith('[DEV] a { x: 1 } oops 5');
  });
});
