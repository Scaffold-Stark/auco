// Mock terminal-size module to avoid ES module import issues
jest.mock('terminal-size', () => ({
  default: jest.fn(() => ({ columns: 80, rows: 24 })),
}));

// Mock ansi-escapes module
jest.mock('ansi-escapes', () => ({
  default: {
    clearLines: jest.fn(() => ''),
    cursorUp: jest.fn(() => ''),
    cursorDown: jest.fn(() => ''),
    eraseLines: jest.fn(() => ''),
  },
}));

// Note: We intentionally allow console output in tests to verify logging behavior
// If you want to suppress console output, uncomment the lines below:

// const originalConsole = global.console;
// beforeEach(() => {
//   global.console = {
//     ...originalConsole,
//     log: jest.fn(),
//     info: jest.fn(),
//     warn: jest.fn(),
//     error: jest.fn(),
//     debug: jest.fn(),
//   };
// });
// afterEach(() => {
//   global.console = originalConsole;
// });