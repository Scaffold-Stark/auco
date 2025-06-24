module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: './test',
  testRegex: '.*\\.int\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/../src/$1',
  },
  maxWorkers: 1,
};
