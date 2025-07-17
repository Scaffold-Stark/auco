import { StarknetIndexer, LogLevel } from '../src/index';
import abi from './abi/ABI';

const indexer = new StarknetIndexer({
  // Change your node urls here if needed
  rpcNodeUrl: 'https://starknet-mainnet.blastapi.io/4bfb6a18-ad4e-49ef-ab65-e1e00be11fb1/rpc/v0_8',
  wsNodeUrl: 'wss://starknet-mainnet.blastapi.io/4bfb6a18-ad4e-49ef-ab65-e1e00be11fb1/rpc/v0_8',

  // Change your database connection string here if needed
  database: {
    type: 'postgres',
    config: {
      connectionString: 'postgresql://postgres:password123@127.0.0.1:6500/app',
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
  },
});

indexer.start();
