import { StarknetIndexer, LogLevel } from '../src/index';
import abi from './abi/ABI';

const indexer = new StarknetIndexer({
  // Change your node urls here if needed
  rpcNodeUrl: 'https://starknet-sepolia-rpc.publicnode.com',
  wsNodeUrl: 'wss://starknet-sepolia-rpc.publicnode.com',

  // Change your database connection string here if needed
  database: {
    type: 'postgres',
    config: {
      connectionString: 'postgresql://postgres:postgres@localhost:5432/starknet_indexer',
    },
  },

  logLevel: LogLevel.INFO,
  startingBlockNumber: 'latest',
});

indexer.onEvent({
  contractAddress: '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
  abi: abi,
  eventName: 'src::strk::erc20_lockable::ERC20Lockable::Transfer',
  handler: async (event) => {
    console.log('Received event', event);
  },
});

indexer.start();
