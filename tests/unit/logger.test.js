
const logger = require('../services/logger');

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
