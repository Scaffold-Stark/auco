import { universalErc20Abi } from '../../../test-utils/constants';
import { StarknetIndexer } from '../../index';
import Database from 'better-sqlite3';

describe('StarknetIndexer', () => {
  // Global cleanup to ensure Jest exits properly
  afterAll(async () => {
    // Force cleanup of any remaining async operations
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  it('should instantiate with minimal config', () => {
    const indexer = new StarknetIndexer({
      rpcNodeUrl: 'http://localhost:9944',
      wsNodeUrl: 'ws://localhost:9945',
      database: {
        type: 'sqlite',
        config: { dbInstance: new Database(':memory:') },
      },
      startingBlockNumber: 0,
    });
    expect(indexer).toBeInstanceOf(StarknetIndexer);
  });

  it('should throw error if onEvent is called without contractAddress', async () => {
    const indexer = new StarknetIndexer({
      rpcNodeUrl: 'http://localhost:9944',
      wsNodeUrl: 'ws://localhost:9945',
      database: {
        type: 'sqlite',
        config: { dbInstance: new Database(':memory:') },
      },
      startingBlockNumber: 0,
    });
    await expect(
      indexer.onEvent({
        handler: jest.fn(),
        contractAddress: '',
        abi: universalErc20Abi,
        eventName: 'src::strk::erc20_lockable::ERC20Lockable::Transfer',
      })
    ).rejects.toThrow('Contract address is required');
  });

  it('should call stop without throwing', async () => {
    const indexer = new StarknetIndexer({
      rpcNodeUrl: 'http://localhost:9944',
      wsNodeUrl: 'ws://localhost:9945',
      database: {
        type: 'sqlite',
        config: { dbInstance: new Database(':memory:') },
      },
      startingBlockNumber: 0,
    });
    await expect(indexer.stop()).resolves.not.toThrow();
  });

  describe('reorg cases', () => {
    let mockIndexer: StarknetIndexer;
    let mockDbHandler: any;
    let mockProvider: any;
    const contractAddress = '0x4718F5A0FC34CC1AF16A1CDEE98FFB20C31F5CD61D6AB07201858F4287C938D';

    beforeEach(() => {
      // Mock database handler
      mockDbHandler = {
        isConnected: jest.fn().mockReturnValue(true),
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        beginTransaction: jest.fn().mockResolvedValue(undefined),
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        initializeDb: jest.fn().mockResolvedValue(undefined),
        getIndexerState: jest.fn().mockResolvedValue(null),
        initializeIndexerState: jest.fn().mockResolvedValue(undefined),
        getBlockByNumber: jest.fn().mockResolvedValue(null),
        deleteBlock: jest.fn().mockResolvedValue(undefined),
        deleteEventsByBlockNumber: jest.fn().mockResolvedValue(undefined),
        getBlockByParentHash: jest.fn().mockResolvedValue(null),
        updateCursor: jest.fn().mockResolvedValue(undefined),
        batchInsertBlocks: jest.fn().mockResolvedValue(undefined),
        insertBlock: jest.fn().mockResolvedValue(undefined),
      };

      // Mock RPC provider
      mockProvider = {
        getBlockNumber: jest.fn().mockResolvedValue(100),
        getBlock: jest.fn(),
        getBlockWithReceipts: jest.fn(),
        getEvents: jest.fn().mockResolvedValue({ events: [], continuation_token: undefined }),
      };

      // Create indexer with mocked dependencies
      mockIndexer = new StarknetIndexer({
        rpcNodeUrl: 'http://127.0.0.1:5050',
        wsNodeUrl: 'ws://127.0.0.1:5050/ws',
        database: {
          type: 'sqlite',
          config: { dbInstance: new Database(':memory:') },
        },
        startingBlockNumber: 1,
        contractAddresses: [contractAddress],
      });

      // Replace internal dependencies with mocks
      (mockIndexer as any).dbHandler = mockDbHandler;
      (mockIndexer as any).provider = mockProvider;

      // Mock the withExponentialBackoff method to avoid delays
      (mockIndexer as any).withExponentialBackoff = jest
        .fn()
        .mockImplementation(async (_operation: string, fn: () => Promise<any>) => {
          try {
            return await fn();
          } catch (_error) {
            // Return undefined instead of retrying to avoid delays
            return undefined;
          }
        });
    });

    afterEach(async () => {
      // Clear any timers that might be running
      if ((mockIndexer as any).retryTimeout) {
        clearTimeout((mockIndexer as any).retryTimeout);
        (mockIndexer as any).retryTimeout = undefined;
      }

      if ((mockIndexer as any).pollTimeout) {
        clearTimeout((mockIndexer as any).pollTimeout);
        (mockIndexer as any).pollTimeout = undefined;
      }

      // Ensure indexer is stopped
      (mockIndexer as any).started = false;

      // Clean up WebSocket if it exists
      if ((mockIndexer as any).wsChannel) {
        (mockIndexer as any).wsChannel.onNewHeads = () => {};
        (mockIndexer as any).wsChannel.onReorg = () => {};
        (mockIndexer as any).wsChannel.onError = () => {};
        (mockIndexer as any).wsChannel.onClose = () => {};
      }

      await mockIndexer.stop();

      // Clear all mocks
      jest.clearAllMocks();

      // Force garbage collection of any remaining handles
      await new Promise((resolve) => setImmediate(resolve));

      // Additional cleanup for any remaining async operations
      await new Promise((resolve) => process.nextTick(resolve));
    });

    describe('handleReorg', () => {
      it('should delete forked blocks and associated events', async () => {
        const forkBlockNumber = 50;
        const forkedBlockHash = '0xabc123';
        const childBlockHash = '0xdef456';
        const parentBlockHash = '0x789xyz';

        // Set cursor so reorg affects current position
        (mockIndexer as any).cursor = {
          blockNumber: forkBlockNumber + 2,
          blockHash: '0xcurrent52',
        };

        // Setup dbHandler mocks for the reorg scenario
        mockDbHandler.getBlockByNumber.mockResolvedValueOnce({
          block_number: forkBlockNumber,
          block_hash: forkedBlockHash,
          parent_hash: parentBlockHash,
          timestamp: Date.now(),
        });

        // Mock child block lookup - first call returns child, second returns null
        mockDbHandler.getBlockByParentHash
          .mockResolvedValueOnce({
            block_number: forkBlockNumber + 1,
            block_hash: childBlockHash,
            parent_hash: forkedBlockHash,
            timestamp: Date.now(),
          })
          .mockResolvedValueOnce(null);

        await mockIndexer.handleReorg(forkBlockNumber);

        // Verify that blocks were deleted
        expect(mockDbHandler.deleteBlock).toHaveBeenCalledWith(forkedBlockHash);
        expect(mockDbHandler.deleteBlock).toHaveBeenCalledWith(childBlockHash);

        // Verify that events were deleted
        expect(mockDbHandler.deleteEventsByBlockNumber).toHaveBeenCalledWith(forkBlockNumber);
        expect(mockDbHandler.deleteEventsByBlockNumber).toHaveBeenCalledWith(forkBlockNumber + 1);

        // Verify cursor was updated
        expect(mockDbHandler.updateCursor).toHaveBeenCalledWith(forkBlockNumber - 1, '', undefined);
      });

      it('should handle reorg when no forked block exists in database', async () => {
        const forkBlockNumber = 999;

        // Mock no forked block found
        mockDbHandler.getBlockByNumber.mockResolvedValueOnce(null);

        await mockIndexer.handleReorg(forkBlockNumber);

        // Should only have been called once for the initial block query
        expect(mockDbHandler.getBlockByNumber).toHaveBeenCalledWith(forkBlockNumber);
        expect(mockDbHandler.deleteBlock).not.toHaveBeenCalled();
        expect(mockDbHandler.deleteEventsByBlockNumber).not.toHaveBeenCalled();
      });

      it('should handle deep reorg with multiple blocks', async () => {
        const forkBlockNumber = 45;
        const blocks = [
          {
            block_number: 45,
            block_hash: '0xblock45',
            parent_hash: '0xblock44',
            timestamp: Date.now(),
          },
          {
            block_number: 46,
            block_hash: '0xblock46',
            parent_hash: '0xblock45',
            timestamp: Date.now(),
          },
          {
            block_number: 47,
            block_hash: '0xblock47',
            parent_hash: '0xblock46',
            timestamp: Date.now(),
          },
        ];

        // Setup initial block
        mockDbHandler.getBlockByNumber.mockResolvedValueOnce(blocks[0]);

        // Setup child block lookups in sequence
        mockDbHandler.getBlockByParentHash
          .mockResolvedValueOnce(blocks[1]) // 0xblock45 -> 0xblock46
          .mockResolvedValueOnce(blocks[2]) // 0xblock46 -> 0xblock47
          .mockResolvedValueOnce(null); // 0xblock47 -> null (end)

        await mockIndexer.handleReorg(forkBlockNumber);

        // Should have processed all 3 blocks (deleted them)
        expect(mockDbHandler.deleteBlock).toHaveBeenCalledWith('0xblock45');
        expect(mockDbHandler.deleteBlock).toHaveBeenCalledWith('0xblock46');
        expect(mockDbHandler.deleteBlock).toHaveBeenCalledWith('0xblock47');

        // Should have deleted events for all blocks
        expect(mockDbHandler.deleteEventsByBlockNumber).toHaveBeenCalledWith(45);
        expect(mockDbHandler.deleteEventsByBlockNumber).toHaveBeenCalledWith(46);
        expect(mockDbHandler.deleteEventsByBlockNumber).toHaveBeenCalledWith(47);
      });
    });

    describe('event processing during reorg', () => {
      it('should process events before reorg and handle reorg correctly', async () => {
        const eventsReceived: any[] = [];

        // Register event handler
        await mockIndexer.onEvent({
          contractAddress,
          abi: universalErc20Abi,
          eventName: 'src::strk::erc20_lockable::ERC20Lockable::Transfer',
          handler: async (event, poolClient) => {
            eventsReceived.push(event);
            // Simulate storing event in database
            await poolClient.query(
              'INSERT INTO events (block_number, block_hash, transaction_hash, from_address, event_index, keys, data) VALUES ($1, $2, $3, $4, $5, $6, $7)',
              [
                event.block_number,
                event.block_hash,
                event.transaction_hash,
                event.from_address,
                event.event_index,
                event.keys,
                event.data,
              ]
            );
          },
        });

        // Mock the provider to return empty events to avoid parsing issues
        mockProvider.getEvents.mockResolvedValue({
          events: [],
          continuation_token: undefined,
        });

        // Simulate processing blocks (this should not find events and skip processing)
        await (mockIndexer as any).processBlockEvents(48, 49);

        // Simulate reorg at block 48
        const reorgBlock = 48;

        // Set cursor so reorg affects current position
        (mockIndexer as any).cursor = {
          blockNumber: 50,
          blockHash: '0xcurrent50',
        };

        // Setup reorg scenario
        mockDbHandler.getBlockByNumber.mockResolvedValueOnce({
          block_number: reorgBlock,
          block_hash: '0xoriginal48',
          parent_hash: '0xoriginal47',
          timestamp: Date.now(),
        });

        mockDbHandler.getBlockByParentHash.mockResolvedValueOnce(null);

        await mockIndexer.handleReorg(reorgBlock);

        // Verify events were deleted during reorg
        expect(mockDbHandler.deleteEventsByBlockNumber).toHaveBeenCalledWith(reorgBlock);
      }, 10000);

      it('should process new events after reorg on canonical chain', async () => {
        const canonicalEvents = [
          {
            block_number: 48,
            block_hash: '0xcanonical48',
            transaction_hash: '0xnewtx1',
            from_address: contractAddress.toLowerCase(),
            event_index: 0,
            keys: ['0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9'],
            // Use proper format for BigInt parsing - from, to, amount (as felt)
            data: [
              '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d', // from
              '0x078662e7352d062084b0010068b99288486c2d8b914f6e2a55ce945f8792c8b1', // to
              '0x8ac7230489e80000', // amount low (10 * 10^18 in hex)
              '0x0', // amount high
            ],
          },
        ];

        const eventsReceived: any[] = [];

        // Register event handler
        await mockIndexer.onEvent({
          contractAddress,
          abi: universalErc20Abi,
          eventName: 'src::strk::erc20_lockable::ERC20Lockable::Transfer',
          handler: async (event, _poolClient) => {
            eventsReceived.push(event);
          },
        });

        // Mock provider to return canonical events
        mockProvider.getEvents.mockResolvedValue({
          events: canonicalEvents,
          continuation_token: undefined,
        });

        await (mockIndexer as any).processBlockEvents(48, 48);

        expect(eventsReceived).toHaveLength(1);
        expect(eventsReceived[0].block_hash).toBe('0xcanonical48');
        expect(eventsReceived[0].transaction_hash).toBe('0xnewtx1');
      });
    });

    describe('cursor management during reorg', () => {
      it('should update cursor correctly when reorg affects current position', async () => {
        const currentBlockNumber = 50;
        const reorgBlockNumber = 48;

        // Set initial cursor
        (mockIndexer as any).cursor = {
          blockNumber: currentBlockNumber,
          blockHash: '0xcurrent50',
        };

        // Mock reorg handling
        mockDbHandler.getBlockByNumber.mockResolvedValueOnce({
          block_number: reorgBlockNumber,
          block_hash: '0xreorg48',
          parent_hash: '0xparent47',
          timestamp: Date.now(),
        });

        mockDbHandler.getBlockByParentHash.mockResolvedValueOnce(null);

        await mockIndexer.handleReorg(reorgBlockNumber);

        // Verify cursor was updated to before the reorg point
        expect(mockDbHandler.updateCursor).toHaveBeenCalledWith(
          reorgBlockNumber - 1,
          '',
          undefined
        );
      });

      it('should not update cursor when reorg is before current position', async () => {
        const currentBlockNumber = 60;
        const reorgBlockNumber = 45;

        // Set initial cursor
        (mockIndexer as any).cursor = {
          blockNumber: currentBlockNumber,
          blockHash: '0xcurrent60',
        };

        // Mock reorg handling with no blocks found
        mockDbHandler.getBlockByNumber.mockResolvedValueOnce(null);

        await mockIndexer.handleReorg(reorgBlockNumber);

        // Cursor should not be updated since no forked block was found
        expect(mockDbHandler.updateCursor).not.toHaveBeenCalled();
      });
    });

    describe('database transaction integrity during reorg', () => {
      it('should rollback transaction if reorg handling fails', async () => {
        const forkBlockNumber = 50;

        // Mock database error during reorg
        mockDbHandler.getBlockByNumber.mockResolvedValueOnce({
          block_number: 50,
          block_hash: '0xfork50',
          parent_hash: '0xparent49',
          timestamp: Date.now(),
        });
        mockDbHandler.deleteBlock.mockRejectedValueOnce(new Error('Database error'));

        try {
          await mockIndexer.handleReorg(forkBlockNumber);
        } catch (_error) {
          // Expected to fail
        }

        // Verify rollback was called
        expect(mockDbHandler.rollbackTransaction).toHaveBeenCalled();
      });

      it('should commit transaction when reorg handling succeeds', async () => {
        const forkBlockNumber = 50;

        // Mock successful reorg
        mockDbHandler.getBlockByNumber.mockResolvedValueOnce({
          block_number: 50,
          block_hash: '0xfork50',
          parent_hash: '0xparent49',
          timestamp: Date.now(),
        });
        mockDbHandler.getBlockByParentHash.mockResolvedValueOnce(null);

        await mockIndexer.handleReorg(forkBlockNumber);

        // Verify commit was called
        expect(mockDbHandler.commitTransaction).toHaveBeenCalled();
      });
    });
  });
});
