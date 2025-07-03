# Contributing to Auco

Thank you for your interest in contributing to Auco! This document provides guidelines and information for contributors.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Code Style](#code-style)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)
- [Reporting Issues](#reporting-issues)
- [Feature Requests](#feature-requests)

## Code of Conduct

This project and everyone participating in it is governed by our Code of Conduct. By participating, you are expected to uphold this code.

## Getting Started

### Prerequisites

- **Node.js**: Version 18 or higher
- **PostgreSQL**: Version 12 or higher
- **Git**: For version control
- **Docker**: Optional, for local development environment
- **Starknet Node**: For local development environment

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/starknet-js-indexer.git
   cd starknet-js-indexer
   ```
3. Add the upstream repository:
   ```bash
   git remote add upstream https://github.com/your-org/starknet-js-indexer.git
   ```

## Development Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Setup Database

#### Option A: Local PostgreSQL
```bash
# Create database
createdb starknet_indexer

# Or using psql
psql -c "CREATE DATABASE starknet_indexer;"
```

#### Option B: Docker PostgreSQL
```bash
docker run --name postgres-dev \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=starknet_indexer \
  -p 5432:5432 \
  -d postgres:13
```

### 3. Setup StarkNet Node

#### Option A: Local Devnet
```bash
npm run chain
```

#### Option B: External Node
Update the example configuration with your node URLs:
```typescript
// example/index.ts
const indexer = new StarknetIndexer({
  rpcNodeUrl: 'https://your-node-url',
  wsNodeUrl: 'wss://your-node-url',
  // ...
});
```

### 4. Verify Setup

```bash
# Run tests
npm test

# Build the project
npm run build

# Run linting
npm run lint
```

## Code Style

### TypeScript Guidelines

- Use TypeScript for all new code
- Prefer `const` over `let` when possible
- Use explicit return types for public functions
- Use interfaces for object shapes
- Prefer `async/await` over Promises

### Naming Conventions

- **Files**: kebab-case (e.g., `block-utils.ts`)
- **Classes**: PascalCase (e.g., `StarknetIndexer`)
- **Functions/Variables**: camelCase (e.g., `processBlock`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `MAX_RETRY_ATTEMPTS`)
- **Interfaces**: PascalCase with `I` prefix (e.g., `IEventHandler`)

### Code Organization

- Keep functions small and focused
- Use meaningful variable and function names
- Add JSDoc comments for public APIs
- Group related functionality together

### Example

```typescript
/**
 * Processes a block and extracts events
 * @param blockNumber - The block number to process
 * @param client - Database client for transactions
 * @returns Promise that resolves when processing is complete
 */
private async processBlock(
  blockNumber: number,
  client: PoolClient
): Promise<void> {
  const events = await this.fetchEvents(blockNumber, blockNumber);
  
  if (events && events.length > 0) {
    await this.processBlockEvents(blockNumber, blockNumber, client);
  }
}
```

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run tests with coverage
npm test -- --coverage

# Run specific test file
npm test -- indexer.test.ts
```

### Writing Tests

- Write tests for all new functionality
- Use descriptive test names
- Test both success and failure cases
- Mock external dependencies
- Use test fixtures for complex data

### Test Structure

```typescript
describe('StarknetIndexer', () => {
  describe('onEvent', () => {
    it('should register event handler successfully', async () => {
      // Arrange
      const indexer = new StarknetIndexer(config);
      const handler = jest.fn();
      
      // Act
      await indexer.onEvent({
        contractAddress: '0x123',
        abi: mockAbi,
        eventName: 'Transfer',
        handler
      });
      
      // Assert
      expect(handler).toBeDefined();
    });
    
    it('should throw error for invalid event name', async () => {
      // Test error case
    });
  });
});
```

### Integration Tests

For integration tests that require real database and network connections:

```typescript
describe('Integration Tests', () => {
  beforeAll(async () => {
    // Setup test database
  });
  
  afterAll(async () => {
    // Cleanup test database
  });
  
  it('should process real events from testnet', async () => {
    // Integration test logic
  });
});
```

## Pull Request Process

### 1. Create a Feature Branch

```bash
git checkout -b feature/your-feature-name
```

### 2. Make Your Changes

- Write your code following the style guidelines
- Add tests for new functionality
- Update documentation as needed
- Keep commits small and focused

### 3. Commit Your Changes

```bash
# Stage your changes
git add .

# Commit with a descriptive message
git commit -m "feat: add support for custom event filters

- Add EventFilter interface for flexible event filtering
- Implement filter validation and application
- Add tests for filter functionality
- Update documentation with filter examples"
```

### 4. Push and Create Pull Request

```bash
git push origin feature/your-feature-name
```

Then create a pull request on GitHub with:

- **Title**: Clear, descriptive title
- **Description**: Detailed description of changes
- **Checklist**: Mark completed items
- **Screenshots**: If UI changes are involved

### 5. Pull Request Checklist

- [ ] Code follows style guidelines
- [ ] Tests pass and coverage is adequate
- [ ] Documentation is updated
- [ ] No breaking changes (or breaking changes are documented)
- [ ] Commit messages are clear and descriptive

### 6. Review Process

- Maintainers will review your PR
- Address any feedback or requested changes
- Once approved, your PR will be merged

## Reporting Issues

### Before Reporting

1. Check existing issues to avoid duplicates
2. Try to reproduce the issue with the latest version
3. Check the troubleshooting section in the README

### Issue Template

Use the issue template when reporting bugs:

```markdown
## Bug Report

### Description
Brief description of the issue

### Steps to Reproduce
1. Step 1
2. Step 2
3. Step 3

### Expected Behavior
What you expected to happen

### Actual Behavior
What actually happened

### Environment
- Node.js version:
- PostgreSQL version:
- StarkNet node version:
- Operating system:

### Additional Information
Any additional context, logs, or screenshots
```

## Feature Requests

### Before Requesting

1. Check if the feature is already planned in the roadmap
2. Consider if the feature aligns with the project's goals
3. Think about implementation complexity and maintenance

### Feature Request Template

```markdown
## Feature Request

### Problem Statement
Describe the problem this feature would solve

### Proposed Solution
Describe your proposed solution

### Alternative Solutions
Describe any alternative solutions you've considered

### Additional Context
Any additional context, use cases, or examples
```

## Getting Help

- 📖 **Documentation**: Check the [README](README.md) and [API docs](docs/API.md)
- 🐛 **Issues**: Search existing [GitHub Issues](https://github.com/your-org/starknet-js-indexer/issues)
- 💬 **Discussions**: Join [GitHub Discussions](https://github.com/your-org/starknet-js-indexer/discussions)
- 📧 **Email**: Contact maintainers directly for sensitive issues

## Recognition

Contributors will be recognized in:

- [Contributors list](https://github.com/your-org/starknet-js-indexer/graphs/contributors)
- Release notes for significant contributions
- Project documentation for major features

Thank you for contributing to Auco! 🚀 