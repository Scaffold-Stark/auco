module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: './src',
  testMatch: ['**/__tests__/**/*.(t|j)s', '**/*.(test|spec).(t|j)s'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/../src/$1',
  },
  maxWorkers: 1,
  transformIgnorePatterns: [
    'node_modules/(?!(terminal-size|ansi-escapes)/)',
  ],
  setupFilesAfterEnv: ['<rootDir>/../jest.setup.js'],
};
