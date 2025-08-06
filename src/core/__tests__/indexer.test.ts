import { universalErc20Abi } from '../../../test-utils/constants';
import { StarknetIndexer } from '../../index';
import { LogLevel } from '../../types/indexer';
import Database from 'better-sqlite3';

// Mock the UI progress module to prevent dynamic imports
jest.mock('../../ui/progress', () => ({
  setupProgressUi: jest.fn(() => jest.fn()), // Returns a shutdown function
}));

// Mock the patch module as well
jest.mock('../../ui/patch', () => ({
  patchWriteStreams: jest.fn(),
}));

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
        config: { dbInstance: new Database('./memory.db') },
      },
      startingBlockNumber: 0,
    });
    expect(indexer).toBeInstanceOf(StarknetIndexer);
  });

  it('should instantiate with full config including logger and cursor key', () => {
    const indexer = new StarknetIndexer({
      rpcNodeUrl: 'http://localhost:9944',
      wsNodeUrl: 'ws://localhost:9945',
      database: {
        type: 'sqlite',
        config: { dbInstance: new Database('./memory.db') },
      },
      startingBlockNumber: 'latest',
      contractAddresses: ['0x123'],
      cursorKey: 'test-cursor',
      logLevel: LogLevel.DEBUG,
      maxHistoricalBlockConcurrentRequests: 10,
    });
    expect(indexer).toBeInstanceOf(StarknetIndexer);
  });

  it('should throw error if onEvent is called without contractAddress', async () => {
    const indexer = new StarknetIndexer({
      rpcNodeUrl: 'http://localhost:9944',
      wsNodeUrl: 'ws://localhost:9945',
      database: {
        type: 'sqlite',
        config: { dbInstance: new Database('./memory.db') },
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
        config: { dbInstance: new Database('./memory.db') },
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
        withTransaction: jest.fn().mockImplementation(async (fn) => await fn()),
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
        checkIsBlockProcessed: jest.fn().mockResolvedValue(false),
        insertEvent: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue(undefined),
        cleanup: jest.fn().mockResolvedValue(undefined),
        healthCheck: jest.fn().mockResolvedValue(undefined),
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
          config: { dbInstance: new Database('./memory.db') },
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
      it('should handle transaction errors during reorg', async () => {
        const forkBlockNumber = 50;

        // Mock database error during reorg by making withTransaction throw
        mockDbHandler.withTransaction.mockRejectedValueOnce(
          new Error('Database transaction error')
        );
        mockDbHandler.getBlockByNumber.mockResolvedValueOnce({
          block_number: 50,
          block_hash: '0xfork50',
          parent_hash: '0xparent49',
          timestamp: Date.now(),
        });

        // The reorg should handle the error gracefully
        await mockIndexer.handleReorg(forkBlockNumber);

        // Verify withTransaction was called
        expect(mockDbHandler.withTransaction).toHaveBeenCalled();
      });

      it('should execute reorg operations within a transaction', async () => {
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

        // Verify withTransaction was called for the reorg operation
        expect(mockDbHandler.withTransaction).toHaveBeenCalled();
      });
    });
  });

  describe('health check functionality', () => {
    let mockIndexer: StarknetIndexer;
    let mockDbHandler: any;
    let mockProvider: any;
    let mockWsChannel: any;

    beforeEach(() => {
      mockDbHandler = {
        healthCheck: jest.fn().mockResolvedValue(undefined),
        isConnected: jest.fn().mockReturnValue(true),
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        withTransaction: jest.fn().mockImplementation(async (fn) => await fn()),
        initializeDb: jest.fn().mockResolvedValue(undefined),
        getIndexerState: jest.fn().mockResolvedValue(null),
        initializeIndexerState: jest.fn().mockResolvedValue(undefined),
        updateCursor: jest.fn().mockResolvedValue(undefined),
        insertBlock: jest.fn().mockResolvedValue(undefined),
        batchInsertBlocks: jest.fn().mockResolvedValue(undefined),
        checkIsBlockProcessed: jest.fn().mockResolvedValue(false),
        getBlockByNumber: jest.fn().mockResolvedValue(null),
        deleteBlock: jest.fn().mockResolvedValue(undefined),
        deleteEventsByBlockNumber: jest.fn().mockResolvedValue(undefined),
        getBlockByParentHash: jest.fn().mockResolvedValue(null),
        insertEvent: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue(undefined),
        cleanup: jest.fn().mockResolvedValue(undefined),
      };

      mockProvider = {
        getBlockNumber: jest.fn().mockResolvedValue(100),
        getBlock: jest.fn(),
        getEvents: jest.fn().mockResolvedValue({ events: [], continuation_token: undefined }),
      };

      mockWsChannel = {
        isConnected: jest.fn().mockReturnValue(true),
        on: jest.fn(),
        waitForConnection: jest.fn().mockResolvedValue(undefined),
        subscribeNewHeads: jest.fn().mockResolvedValue({ on: jest.fn() }),
      };

      mockIndexer = new StarknetIndexer({
        rpcNodeUrl: 'http://127.0.0.1:5050',
        wsNodeUrl: 'ws://127.0.0.1:5050/ws',
        database: {
          type: 'sqlite',
          config: { dbInstance: new Database('./memory.db') },
        },
        startingBlockNumber: 1,
      });

      (mockIndexer as any).dbHandler = mockDbHandler;
      (mockIndexer as any).provider = mockProvider;
      (mockIndexer as any).wsChannel = mockWsChannel;
    });

    afterEach(async () => {
      await mockIndexer.stop();
      jest.clearAllMocks();
    });

    it('should return healthy status when all systems are working', async () => {
      const health = await mockIndexer.healthCheck();

      expect(health).toEqual({
        database: true,
        ws: true,
        rpc: true,
      });

      expect(mockDbHandler.healthCheck).toHaveBeenCalled();
      expect(mockProvider.getBlockNumber).toHaveBeenCalled();
      expect(mockWsChannel.isConnected).toHaveBeenCalled();
    });

    it('should return unhealthy database status when database fails', async () => {
      mockDbHandler.healthCheck.mockRejectedValueOnce(new Error('Database error'));

      const health = await mockIndexer.healthCheck();

      expect(health.database).toBe(false);
      expect(health.ws).toBe(true);
      expect(health.rpc).toBe(true);
    });

    it('should return unhealthy RPC status when provider fails', async () => {
      mockProvider.getBlockNumber.mockRejectedValueOnce(new Error('RPC error'));

      const health = await mockIndexer.healthCheck();

      expect(health.database).toBe(true);
      expect(health.ws).toBe(true);
      expect(health.rpc).toBe(false);
    });

    it('should return unhealthy WebSocket status when disconnected', async () => {
      mockWsChannel.isConnected.mockReturnValue(false);

      const health = await mockIndexer.healthCheck();

      expect(health.database).toBe(true);
      expect(health.ws).toBe(false);
      expect(health.rpc).toBe(true);
    });

    it('should handle missing provider gracefully', async () => {
      (mockIndexer as any).provider = null;

      const health = await mockIndexer.healthCheck();

      expect(health.rpc).toBe(false);
    });
  });

  describe('reorg handler registration', () => {
    let indexer: StarknetIndexer;

    beforeEach(() => {
      indexer = new StarknetIndexer({
        rpcNodeUrl: 'http://localhost:9944',
        wsNodeUrl: 'ws://localhost:9945',
        database: {
          type: 'sqlite',
          config: { dbInstance: new Database('./memory.db') },
        },
        startingBlockNumber: 0,
      });
    });

    afterEach(async () => {
      await indexer.stop();
    });

    it('should register reorg handler successfully', async () => {
      const reorgHandler = jest.fn();

      await expect(
        indexer.onReorg({
          handler: reorgHandler,
        })
      ).resolves.not.toThrow();
    });

    it('should throw error when handler is missing', async () => {
      await expect(
        indexer.onReorg({
          handler: null as any,
        })
      ).rejects.toThrow('Handler is required');
    });

    it('should throw error when registering duplicate handler without override', async () => {
      const reorgHandler1 = jest.fn();
      const reorgHandler2 = jest.fn();

      await indexer.onReorg({ handler: reorgHandler1 });

      await expect(indexer.onReorg({ handler: reorgHandler2 })).rejects.toThrow(
        'Reorg handler already registered, use isOverride to override'
      );
    });

    it('should allow override of existing reorg handler', async () => {
      const reorgHandler1 = jest.fn();
      const reorgHandler2 = jest.fn();

      await indexer.onReorg({ handler: reorgHandler1 });

      await expect(
        indexer.onReorg({ handler: reorgHandler2, isOverride: true })
      ).resolves.not.toThrow();
    });
  });

  describe('event validation', () => {
    let indexer: StarknetIndexer;
    const contractAddress = '0x4718F5A0FC34CC1AF16A1CDEE98FFB20C31F5CD61D6AB07201858F4287C938D';

    beforeEach(() => {
      indexer = new StarknetIndexer({
        rpcNodeUrl: 'http://localhost:9944',
        wsNodeUrl: 'ws://localhost:9945',
        database: {
          type: 'sqlite',
          config: { dbInstance: new Database('./memory.db') },
        },
        startingBlockNumber: 0,
      });
    });

    afterEach(async () => {
      await indexer.stop();
    });

    it('should validate event name exists in ABI', async () => {
      const mockHandler = jest.fn();

      await expect(
        indexer.onEvent({
          contractAddress,
          abi: universalErc20Abi,
          eventName: 'src::strk::erc20_lockable::ERC20Lockable::Transfer',
          handler: mockHandler,
        })
      ).resolves.not.toThrow();
    });

    it('should throw error for non-existent event name', async () => {
      const mockHandler = jest.fn();

      await expect(
        indexer.onEvent({
          contractAddress,
          abi: universalErc20Abi,
          eventName: 'NonExistentEvent' as any, // Use 'as any' to bypass type checking for this error test
          handler: mockHandler,
        })
      ).rejects.toThrow('Event "NonExistentEvent" not found');
    });

    it('should register handler without event name validation', async () => {
      const mockHandler = jest.fn();

      await expect(
        indexer.onEvent({
          contractAddress,
          abi: universalErc20Abi,
          handler: mockHandler,
        } as any) // Use 'as any' since eventName is required by types but should be optional
      ).resolves.not.toThrow();
    });
  });

  describe('failed block retry mechanism', () => {
    let mockIndexer: StarknetIndexer;
    let mockDbHandler: any;
    let mockProvider: any;

    beforeEach(() => {
      mockDbHandler = {
        isConnected: jest.fn().mockReturnValue(true),
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        withTransaction: jest.fn().mockImplementation(async (fn) => await fn()),
        initializeDb: jest.fn().mockResolvedValue(undefined),
        getIndexerState: jest.fn().mockResolvedValue(null),
        initializeIndexerState: jest.fn().mockResolvedValue(undefined),
        updateCursor: jest.fn().mockResolvedValue(undefined),
        insertBlock: jest.fn().mockResolvedValue(undefined),
        batchInsertBlocks: jest.fn().mockResolvedValue(undefined),
        checkIsBlockProcessed: jest.fn().mockResolvedValue(false),
        getBlockByNumber: jest.fn().mockResolvedValue(null),
        deleteBlock: jest.fn().mockResolvedValue(undefined),
        deleteEventsByBlockNumber: jest.fn().mockResolvedValue(undefined),
        getBlockByParentHash: jest.fn().mockResolvedValue(null),
        insertEvent: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue(undefined),
        cleanup: jest.fn().mockResolvedValue(undefined),
        healthCheck: jest.fn().mockResolvedValue(undefined),
      };

      mockProvider = {
        getBlockNumber: jest.fn().mockResolvedValue(100),
        getBlock: jest.fn().mockResolvedValue({
          block_number: 50,
          block_hash: '0xblock50',
          parent_hash: '0xblock49',
          timestamp: Date.now(),
        }),
        getEvents: jest.fn().mockResolvedValue({ events: [], continuation_token: undefined }),
      };

      mockIndexer = new StarknetIndexer({
        rpcNodeUrl: 'http://127.0.0.1:5050',
        wsNodeUrl: 'ws://127.0.0.1:5050/ws',
        database: {
          type: 'sqlite',
          config: { dbInstance: new Database('./memory.db') },
        },
        startingBlockNumber: 1,
      });

      (mockIndexer as any).dbHandler = mockDbHandler;
      (mockIndexer as any).provider = mockProvider;
      (mockIndexer as any).started = true;
    });

    afterEach(async () => {
      if ((mockIndexer as any).retryTimeout) {
        clearTimeout((mockIndexer as any).retryTimeout);
        (mockIndexer as any).retryTimeout = undefined;
      }
      (mockIndexer as any).started = false;
      await mockIndexer.stop();
      jest.clearAllMocks();
    });

    it('should add failed blocks to retry queue', () => {
      const blockData = {
        block_number: 50,
        block_hash: '0xblock50',
        parent_hash: '0xblock49',
        timestamp: Date.now(),
      };

      (mockIndexer as any).addFailedBlock(blockData, new Error('Processing failed'));

      const failedBlocks = (mockIndexer as any).failedBlocks;
      expect(failedBlocks).toContain(50);
    });

    it('should not duplicate failed blocks', () => {
      const blockData = {
        block_number: 50,
        block_hash: '0xblock50',
        parent_hash: '0xblock49',
        timestamp: Date.now(),
      };

      (mockIndexer as any).addFailedBlock(blockData, new Error('Processing failed'));
      (mockIndexer as any).addFailedBlock(blockData, new Error('Processing failed again'));

      const failedBlocks = (mockIndexer as any).failedBlocks;
      expect(failedBlocks.filter((block: number) => block === 50)).toHaveLength(1);
    });

    it('should retry failed blocks successfully', async () => {
      (mockIndexer as any).failedBlocks = [45, 46];

      // Mock processHistoricalBlocks to avoid complex dependencies
      (mockIndexer as any).processHistoricalBlocks = jest.fn().mockResolvedValue(undefined);

      await (mockIndexer as any).retryFailedBlocks();

      expect((mockIndexer as any).processHistoricalBlocks).toHaveBeenCalledWith(45, 45);
      expect((mockIndexer as any).processHistoricalBlocks).toHaveBeenCalledWith(46, 46);
      expect((mockIndexer as any).failedBlocks).toHaveLength(0);
    });
  });

  describe('exponential backoff retry', () => {
    let mockIndexer: StarknetIndexer;

    beforeEach(() => {
      mockIndexer = new StarknetIndexer({
        rpcNodeUrl: 'http://127.0.0.1:5050',
        wsNodeUrl: 'ws://127.0.0.1:5050/ws',
        database: {
          type: 'sqlite',
          config: { dbInstance: new Database('./memory.db') },
        },
        startingBlockNumber: 1,
      });
    });

    afterEach(async () => {
      await mockIndexer.stop();
    });

    it('should retry operation with exponential backoff', async () => {
      let attempts = 0;
      const mockOperation = jest.fn().mockImplementation(() => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Temporary failure');
        }
        return 'success';
      });

      const result = await (mockIndexer as any).withExponentialBackoff(
        'Test operation',
        mockOperation,
        5, // maxRetries
        10, // initialDelay (reduced for testing)
        true // silent
      );

      expect(result).toBe('success');
      expect(mockOperation).toHaveBeenCalledTimes(3);
    });

    it('should return undefined after max retries', async () => {
      const mockOperation = jest.fn().mockRejectedValue(new Error('Persistent failure'));

      const result = await (mockIndexer as any).withExponentialBackoff(
        'Test operation',
        mockOperation,
        2, // maxRetries
        10, // initialDelay
        true // silent
      );

      expect(result).toBeUndefined();
      expect(mockOperation).toHaveBeenCalledTimes(2);
    });
  });

  describe('concurrent processing configuration', () => {
    it('should configure maximum concurrent requests', () => {
      const indexer = new StarknetIndexer({
        rpcNodeUrl: 'http://localhost:9944',
        wsNodeUrl: 'ws://localhost:9945',
        database: {
          type: 'sqlite',
          config: { dbInstance: new Database('./memory.db') },
        },
        startingBlockNumber: 0,
        maxHistoricalBlockConcurrentRequests: 15,
      });

      // Access private property for testing
      const maxConcurrentRequests = (indexer as any).MAX_HISTORICAL_BLOCK_CONCURRENT_REQUESTS;
      expect(maxConcurrentRequests).toBe(15);
    });

    it('should use default concurrent requests when not specified', () => {
      const indexer = new StarknetIndexer({
        rpcNodeUrl: 'http://localhost:9944',
        wsNodeUrl: 'ws://localhost:9945',
        database: {
          type: 'sqlite',
          config: { dbInstance: new Database('./memory.db') },
        },
        startingBlockNumber: 0,
      });

      // Access private property for testing
      const maxConcurrentRequests = (indexer as any).MAX_HISTORICAL_BLOCK_CONCURRENT_REQUESTS;
      expect(maxConcurrentRequests).toBe(5); // Default value
    });
  });

  describe('WebSocket reconnection handling', () => {
    let mockIndexer: StarknetIndexer;
    let mockWsChannel: any;

    beforeEach(() => {
      mockWsChannel = {
        on: jest.fn(),
        waitForConnection: jest.fn().mockResolvedValue(undefined),
        subscribeNewHeads: jest.fn().mockResolvedValue({ on: jest.fn() }),
        isConnected: jest.fn().mockReturnValue(true),
      };

      mockIndexer = new StarknetIndexer({
        rpcNodeUrl: 'http://127.0.0.1:5050',
        wsNodeUrl: 'ws://127.0.0.1:5050/ws',
        database: {
          type: 'sqlite',
          config: { dbInstance: new Database('./memory.db') },
        },
        startingBlockNumber: 1,
      });

      (mockIndexer as any).wsChannel = mockWsChannel;
      (mockIndexer as any).started = true;
    });

    afterEach(async () => {
      (mockIndexer as any).started = false;
      await mockIndexer.stop();
      jest.clearAllMocks();
    });

    it('should set up WebSocket event handlers', () => {
      (mockIndexer as any).setupEventHandlers();

      expect(mockWsChannel.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockWsChannel.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockWsChannel.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('should handle WebSocket close event when indexer is started', async () => {
      let closeHandler: Function | undefined;

      // Capture the close handler
      mockWsChannel.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'close') {
          closeHandler = handler;
        }
      });

      // Mock the withExponentialBackoff method to avoid actual reconnection
      (mockIndexer as any).withExponentialBackoff = jest.fn().mockResolvedValue(undefined);

      (mockIndexer as any).setupEventHandlers();

      // Simulate close event
      if (closeHandler) {
        await closeHandler({ reason: 'test', code: 1000 });
      }

      expect((mockIndexer as any).withExponentialBackoff).toHaveBeenCalledWith(
        'Reconnecting WebSocket',
        expect.any(Function)
      );
    });

    it('should not attempt reconnection when indexer is stopped', async () => {
      let closeHandler: Function | undefined;

      // Capture the close handler
      mockWsChannel.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'close') {
          closeHandler = handler;
        }
      });

      (mockIndexer as any).started = false; // Simulate stopped state
      (mockIndexer as any).withExponentialBackoff = jest.fn().mockResolvedValue(undefined);

      (mockIndexer as any).setupEventHandlers();

      // Simulate close event
      if (closeHandler) {
        await closeHandler({ reason: 'test', code: 1000 });
      }

      expect((mockIndexer as any).withExponentialBackoff).not.toHaveBeenCalled();
    });

    it('should handle reorg messages from WebSocket', async () => {
      let messageHandler: Function | undefined;

      // Capture the message handler
      mockWsChannel.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'message') {
          messageHandler = handler;
        }
      });

      // Mock handleReorg method
      (mockIndexer as any).handleReorg = jest.fn().mockResolvedValue(undefined);

      (mockIndexer as any).setupEventHandlers();

      // Simulate reorg message
      const reorgMessage = {
        data: JSON.stringify({
          method: 'starknet_subscriptionReorg',
          params: {
            result: {
              starting_block_number: 100,
            },
          },
        }),
      };

      if (messageHandler) {
        await messageHandler(reorgMessage);
      }

      expect((mockIndexer as any).handleReorg).toHaveBeenCalledWith(100);
    });
  });

  describe('progress statistics and UI', () => {
    let mockIndexer: StarknetIndexer;

    beforeEach(() => {
      mockIndexer = new StarknetIndexer({
        rpcNodeUrl: 'http://127.0.0.1:5050',
        wsNodeUrl: 'ws://127.0.0.1:5050/ws',
        database: {
          type: 'sqlite',
          config: { dbInstance: new Database('./memory.db') },
        },
        startingBlockNumber: 1,
      });
    });

    afterEach(async () => {
      await mockIndexer.stop();
    });

    it('should initialize progress stats', () => {
      const progressStats = (mockIndexer as any).progressStats;
      expect(progressStats).toBeDefined();
    });

    it('should start and stop progress UI loop', () => {
      const progressUiShutdown = (mockIndexer as any).progressUiShutdown;

      (mockIndexer as any).startProgressUiLoop();
      expect((mockIndexer as any).progressUiShutdown).toBeDefined();

      (mockIndexer as any).stopProgressUiLoop();
      expect((mockIndexer as any).progressUiShutdown).toBeUndefined();
    });

    it('should not start progress UI if already running', () => {
      const mockShutdown = jest.fn();
      (mockIndexer as any).progressUiShutdown = mockShutdown;

      (mockIndexer as any).startProgressUiLoop();

      // Should not have changed the existing shutdown function
      expect((mockIndexer as any).progressUiShutdown).toBe(mockShutdown);
    });
  });
});
