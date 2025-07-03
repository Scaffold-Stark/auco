import { Account, Contract, RpcProvider } from 'starknet';
import { StarknetEvent, StarknetIndexer } from '../src';
import { universalErc20Abi } from '../test-utils/constants';

// Configuration constants
const CONFIG = {
  CONTRACT_ADDRESS: '0x4718F5A0FC34CC1AF16A1CDEE98FFB20C31F5CD61D6AB07201858F4287C938D',
  RPC_URL: 'http://127.0.0.1:5050',
  WS_URL: 'ws://127.0.0.1:5050/ws',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/starknet_indexer',
  STARTING_BLOCK: 1,
  DEVNET_ACCOUNT_1: {
    ADDRESS: '0x064b48806902a367c8598f4f95c305e8c1a1acba5f082d294a43793113115691',
    PRIVATE_KEY: '0x0000000000000000000000000000000071d7bb07b9a64f6f78ac4c816aff4da9',
  },
  DEVNET_ACCOUNT_2: {
    ADDRESS: '0x078662e7352d062084b0010068b99288486c2d8b914f6e2a55ce945f8792c8b1',
  },
  TRANSFER_AMOUNT: 10n * 10n ** 18n, // 10 tokens with 18 decimals
  LARGE_TRANSFER_AMOUNT: 1000000000000000000n, // 1 token with 18 decimals
  PROCESSING_DELAY: 4000, // 4 seconds
} as const;

const EVENT_NAME = 'src::strk::erc20_lockable::ERC20Lockable::Transfer' as const;

const provider = new RpcProvider({ nodeUrl: CONFIG.RPC_URL });

const indexer = new StarknetIndexer({
  rpcNodeUrl: CONFIG.RPC_URL,
  wsNodeUrl: CONFIG.WS_URL,
  databaseUrl: CONFIG.DATABASE_URL,
  startingBlockNumber: CONFIG.STARTING_BLOCK,
  contractAddresses: [CONFIG.CONTRACT_ADDRESS],
});

async function triggerReorg(): Promise<void> {
  const response = await fetch(CONFIG.RPC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      method: 'devnet_abortBlocks',
      params: {
        starting_block_id: 'latest',
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to trigger reorg: ${await response.text()}`);
  }

  console.log('Reorg triggered successfully');
}

async function waitForProcessing(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, CONFIG.PROCESSING_DELAY));
}

async function runReorgExample(): Promise<void> {
  const events: StarknetEvent<typeof universalErc20Abi, typeof EVENT_NAME>[] = [];

  // Set up event handler
  indexer.onEvent({
    contractAddress: CONFIG.CONTRACT_ADDRESS,
    abi: universalErc20Abi,
    eventName: EVENT_NAME,
    handler: async (event, poolClient) => {
      console.log('Received event', event);
      events.push(event);

      await poolClient.query(
        `
        INSERT INTO events (block_number, transaction_hash, from_address, event_index, keys, data)
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          event.block_number,
          event.transaction_hash,
          event.from_address,
          event.event_index,
          event.keys,
          event.data,
        ]
      );
    },
  });

  // Set up reorg handler
  indexer.onReorg({
    handler: async (forkedBlock) => {
      console.log('Reorg detected at block', forkedBlock);
    },
  });

  // Set up contract with first devnet account
  const strkContract = new Contract(universalErc20Abi, CONFIG.CONTRACT_ADDRESS, provider);
  strkContract.connect(
    new Account(provider, CONFIG.DEVNET_ACCOUNT_1.ADDRESS, CONFIG.DEVNET_ACCOUNT_1.PRIVATE_KEY)
  );

  // Perform initial transfers
  console.log('Performing initial transfers...');
  await strkContract.transfer(CONFIG.DEVNET_ACCOUNT_2.ADDRESS, CONFIG.TRANSFER_AMOUNT);
  await strkContract.transfer(CONFIG.DEVNET_ACCOUNT_2.ADDRESS, CONFIG.TRANSFER_AMOUNT);

  // Wait for events to be processed
  console.log('Waiting for events to be processed...');
  await waitForProcessing();

  // Trigger reorg
  console.log('Triggering reorg...');
  await triggerReorg();

  // Perform post-reorg transfers
  console.log('Performing post-reorg transfers...');
  await strkContract.transfer(CONFIG.DEVNET_ACCOUNT_2.ADDRESS, CONFIG.TRANSFER_AMOUNT);
  await strkContract.transfer(CONFIG.DEVNET_ACCOUNT_2.ADDRESS, CONFIG.LARGE_TRANSFER_AMOUNT);

  // Wait for final events to be processed
  console.log('Waiting for final events to be processed...');
  await waitForProcessing();

  // Display results
  console.log(`Total events processed: ${events.length}`);
}

// Start the indexer and run the example
indexer.start();
runReorgExample().catch(console.error);
