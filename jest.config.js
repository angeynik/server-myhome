module.exports = {
  testEnvironment: 'node', // Устанавливаем окружение Node.js
  testMatch: [
    '**/tests/unit/**/*.test.js',
    '**/tests/integration/**/*.integration.js'
  ],
  collectCoverageFrom: [
    'auth.js',
    'services/**/*.js',
    'routes/**/*.js',
    'middleware/**/*.js'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'clover'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  // moduleNameMapper: {
  //   '^@/(.*)$': '<rootDir>/$1'
  // },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^services/(.*)$': '<rootDir>/services/$1',
    '^classes/(.*)$': '<rootDir>/classes/$1'
  },
  testPathIgnorePatterns: [
    '/node_modules/',
    '/coverage/'
  ]
};
  