import abi from '../example/abi/ABI';
import { StarknetIndexer } from '../src/index';

describe('StarknetIndexer', () => {
  it('should instantiate with minimal config', () => {
    const indexer = new StarknetIndexer({
      rpcNodeUrl: 'http://localhost:9944',
      wsNodeUrl: 'ws://localhost:9945',
      databaseUrl: 'postgresql://user:password@localhost:5432/testdb',
      startingBlockNumber: 0,
    });
    expect(indexer).toBeInstanceOf(StarknetIndexer);
  });

  it('should throw error if onEvent is called without contractAddress', async () => {
    const indexer = new StarknetIndexer({
      rpcNodeUrl: 'http://localhost:9944',
      wsNodeUrl: 'ws://localhost:9945',
      databaseUrl: 'postgresql://user:password@localhost:5432/testdb',
      startingBlockNumber: 0,
    });
    await expect(
      indexer.onEvent({
        handler: jest.fn(),
        contractAddress: '',
        abi: abi,
        eventName: 'src::strk::erc20_lockable::ERC20Lockable::Event',
      })
    ).rejects.toThrow('Contract address is required');
  });

  it('should call stop without throwing', async () => {
    const indexer = new StarknetIndexer({
      rpcNodeUrl: 'http://localhost:9944',
      wsNodeUrl: 'ws://localhost:9945',
      databaseUrl: 'postgresql://user:password@localhost:5432/testdb',
      startingBlockNumber: 0,
    });
    await expect(indexer.stop()).resolves.not.toThrow();
  });
});
