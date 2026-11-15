'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '**/tests/unit/**/*.test.js',
    '**/tests/integration/**/*.integration.js',
    '**/tests/modbusRTU/**/*.test.js',
  ],
  collectCoverageFrom: [
    'serverapp.js',
    'gpio.js',
    'services/**/*.js',
    'classes/**/*.js',
    'modBus/**/*.js',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'clover'],
  // Тихий лог и тестовые секреты; глобальных моков нет
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  // История вызовов моков очищается перед каждым тестом (реализации сохраняются)
  clearMocks: true,
  testPathIgnorePatterns: [
    '/node_modules/',
    '/coverage/',
  ],
};
