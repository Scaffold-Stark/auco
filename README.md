# Auco

A TypeScript/Node.js indexer for Starknet events, supporting PostgreSQL and real-time event handling via WebSocket and RPC.

## Features
- Listen to Starknet events from specified contracts
- Store events and block data in PostgreSQL
- Handle chain reorgs and retries
- Extensible event handler registration

## Installation

```bash
npm install
yarn install
```

## Requirements

- **WebSocket endpoint is required**: The indexer needs a Starknet node with WebSocket support (e.g., Infura, local node with WS enabled).
- **Starknet node spec version 0.8 or above**: The indexer is compatible with Starknet nodes running spec version 0.8 or higher.

## Usage Example

See [`example/index.ts`](./example/index.ts) for a minimal working example.

```typescript
import { StarknetIndexer, LogLevel } from '../src/index';
import { abi as myContractAbi } from './myContractAbi'; // Provide your contract ABI

const indexer = new StarknetIndexer({
  rpcNodeUrl: 'https://starknet-mainnet.infura.io/v3/YOUR_KEY',
  wsNodeUrl: 'wss://starknet-mainnet.infura.io/ws/v3/YOUR_KEY',
  databaseUrl: 'postgresql://user:password@localhost:5432/mydb',
  contractAddresses: ['0x...'],
  logLevel: LogLevel.INFO,
});

indexer.onEvent({
  contractAddress: '0x...',
  abi: myContractAbi,
  eventName: 'Transfer',
  handler: async (event, client, indexer) => {
    console.log('Received event:', event);
    // Custom logic here
  },
});

indexer.start();
```

## Running the Example

1. Made your to setup your local postgres database
2. Edit `example/index.ts` with your node URLs and contract address if needed.
3. Edit `example/index.ts` with your postgres database connection string if needed.
4. Run:

```bash
npx ts-node example/index.ts
```

## Running Tests

```bash
npm test
```

## Configuration
- `rpcNodeUrl`: Starknet RPC endpoint
- `wsNodeUrl`: Starknet WebSocket endpoint
- `databaseUrl`: PostgreSQL connection string
- `contractAddresses`: Array of contract addresses to index
- `logLevel`: Log verbosity
- `startingBlockNumber`: Starting block number to start indexing from

## Handling Chain Reorgs

The indexer provides a mechanism to detect and respond to chain reorgs. When a reorg is detected, the indexer will roll back non-canonical blocks and events in the database, and then invoke a user-defined reorg handler.

Important: You must implement your own logic for handling reorgs in your application. The indexer only provides the hook and basic database cleanup.

## Troubleshooting
- Ensure PostgreSQL is running and accessible
- Use correct node URLs and contract addresses
- For ABI errors, check your ABI file and event names
