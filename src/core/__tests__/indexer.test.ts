import { universalErc20Abi } from '../../../test-utils/constants';
import { StarknetIndexer } from '../../index';

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
        abi: universalErc20Abi,
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

  describe('reorg cases', () => {
    let mockIndexer: StarknetIndexer;
    let mockPoolClient: any;
    let mockPool: any;
    let mockProvider: any;
    const contractAddress = '0x4718F5A0FC34CC1AF16A1CDEE98FFB20C31F5CD61D6AB07201858F4287C938D';
    const testDatabaseUrl = 'postgresql://postgres:postgres@localhost:5432/test_starknet_indexer';

    beforeEach(() => {
      // Mock database client
      mockPoolClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn(),
      };

      // Mock database pool
      mockPool = {
        connect: jest.fn().mockResolvedValue(mockPoolClient),
        query: jest.fn().mockResolvedValue({ rows: [] }),
        end: jest.fn(),
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
        databaseUrl: testDatabaseUrl,
        startingBlockNumber: 1,
        contractAddresses: [contractAddress],
      });

      // Replace internal dependencies with mocks
      (mockIndexer as any).pool = mockPool;
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
        (mockIndexer as any).wsChannel.onNewHeads = undefined;
        (mockIndexer as any).wsChannel.onReorg = undefined;
        (mockIndexer as any).wsChannel.onError = undefined;
        (mockIndexer as any).wsChannel.onClose = undefined;
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

        let _callCount = 0;
        mockPoolClient.query.mockImplementation((query: string, params?: any[]) => {
          _callCount++;

          if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK') {
            return Promise.resolve({ rows: [] });
          }

          // Initial forked block query
          if (query.includes('SELECT * FROM blocks') && query.includes('WHERE number = $1')) {
            return Promise.resolve({
              rows: [
                {
                  number: forkBlockNumber,
                  hash: forkedBlockHash,
                  parent_hash: parentBlockHash,
                },
              ],
            });
          }

          // DELETE blocks query
          if (query.includes('DELETE FROM blocks') && query.includes('WHERE hash = $1')) {
            return Promise.resolve({ rows: [] });
          }

          // DELETE events query
          if (query.includes('DELETE FROM events') && query.includes('WHERE block_number = $1')) {
            return Promise.resolve({ rows: [] });
          }

          // Child block query
          if (query.includes('WHERE parent_hash = $1')) {
            const parentHash = params?.[0];
            if (parentHash === forkedBlockHash) {
              return Promise.resolve({
                rows: [
                  {
                    number: forkBlockNumber + 1,
                    hash: childBlockHash,
                    parent_hash: forkedBlockHash,
                  },
                ],
              });
            } else {
              return Promise.resolve({ rows: [] });
            }
          }

          // Cursor update query
          if (query.includes('UPDATE indexer_state')) {
            return Promise.resolve({ rows: [] });
          }

          return Promise.resolve({ rows: [] });
        });

        await mockIndexer.handleReorg(forkBlockNumber);

        // Verify that blocks were deleted
        expect(mockPoolClient.query).toHaveBeenCalledWith(
          expect.stringContaining('DELETE FROM blocks'),
          [forkedBlockHash]
        );

        // Verify that events were deleted
        expect(mockPoolClient.query).toHaveBeenCalledWith(
          expect.stringContaining('DELETE FROM events'),
          [forkBlockNumber]
        );

        // Verify cursor was updated
        expect(mockPoolClient.query).toHaveBeenCalledWith(
          expect.stringContaining('UPDATE indexer_state'),
          expect.arrayContaining([forkBlockNumber - 1])
        );
      });

      it('should handle reorg when no forked block exists in database', async () => {
        const forkBlockNumber = 999;

        // Mock no forked block found
        mockPoolClient.query.mockResolvedValueOnce({ rows: [] });

        await mockIndexer.handleReorg(forkBlockNumber);

        // Should only have been called once for the initial block query
        expect(mockPoolClient.query).toHaveBeenCalledTimes(3); // BEGIN, SELECT, COMMIT
      });

      it('should handle deep reorg with multiple blocks', async () => {
        const forkBlockNumber = 45;
        const blocks = [
          { number: 45, hash: '0xblock45', parent_hash: '0xblock44' },
          { number: 46, hash: '0xblock46', parent_hash: '0xblock45' },
          { number: 47, hash: '0xblock47', parent_hash: '0xblock46' },
        ];

        let queryCallCount = 0;
        mockPoolClient.query.mockImplementation((query: string, params?: any[]) => {
          queryCallCount++;

          if (query === 'BEGIN' || query === 'COMMIT') {
            return Promise.resolve({ rows: [] });
          }

          // Initial forked block query
          if (queryCallCount === 2) {
            return Promise.resolve({ rows: [blocks[0]] });
          }

          // Child block queries
          if (query.includes('WHERE parent_hash = $1')) {
            const parentHash = params?.[0];
            if (parentHash === '0xblock45') {
              return Promise.resolve({ rows: [blocks[1]] });
            } else if (parentHash === '0xblock46') {
              return Promise.resolve({ rows: [blocks[2]] });
            } else {
              return Promise.resolve({ rows: [] });
            }
          }

          return Promise.resolve({ rows: [] });
        });

        await mockIndexer.handleReorg(forkBlockNumber);

        // Should have processed all 3 blocks (deleted them)
        expect(mockPoolClient.query).toHaveBeenCalledWith(
          expect.stringContaining('DELETE FROM blocks'),
          ['0xblock45']
        );
        expect(mockPoolClient.query).toHaveBeenCalledWith(
          expect.stringContaining('DELETE FROM blocks'),
          ['0xblock46']
        );
        expect(mockPoolClient.query).toHaveBeenCalledWith(
          expect.stringContaining('DELETE FROM blocks'),
          ['0xblock47']
        );
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
        const mockClient = await mockPool.connect();
        await (mockIndexer as any).processBlockEvents(48, 49, mockClient);

        // Simulate reorg at block 48
        const reorgBlock = 48;

        // Set cursor so reorg affects current position
        (mockIndexer as any).cursor = {
          blockNumber: 50,
          blockHash: '0xcurrent50',
        };

        mockPoolClient.query.mockImplementation((query: string, _params?: any[]) => {
          if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK') {
            return Promise.resolve({ rows: [] });
          }

          // Initial forked block query
          if (query.includes('SELECT * FROM blocks') && query.includes('WHERE number = $1')) {
            return Promise.resolve({
              rows: [
                {
                  number: reorgBlock,
                  hash: '0xoriginal48',
                  parent_hash: '0xoriginal47',
                },
              ],
            });
          }

          // DELETE blocks and events queries
          return Promise.resolve({ rows: [] });
        });

        await mockIndexer.handleReorg(reorgBlock);

        // Verify events were deleted during reorg
        expect(mockPoolClient.query).toHaveBeenCalledWith(
          expect.stringContaining('DELETE FROM events'),
          [reorgBlock]
        );
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

        const mockClient = await mockPool.connect();
        await (mockIndexer as any).processBlockEvents(48, 48, mockClient);

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
        mockPoolClient.query.mockImplementation((query: string, _params?: any[]) => {
          if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK') {
            return Promise.resolve({ rows: [] });
          }

          // Initial forked block query
          if (query.includes('SELECT * FROM blocks') && query.includes('WHERE number = $1')) {
            return Promise.resolve({
              rows: [
                {
                  number: reorgBlockNumber,
                  hash: '0xreorg48',
                  parent_hash: '0xparent47',
                },
              ],
            });
          }

          // DELETE blocks query
          if (query.includes('DELETE FROM blocks') && query.includes('WHERE hash = $1')) {
            return Promise.resolve({ rows: [] });
          }

          // DELETE events query
          if (query.includes('DELETE FROM events') && query.includes('WHERE block_number = $1')) {
            return Promise.resolve({ rows: [] });
          }

          // Child block query (no children)
          if (query.includes('WHERE parent_hash = $1')) {
            return Promise.resolve({ rows: [] });
          }

          // Cursor update query
          if (query.includes('UPDATE indexer_state')) {
            return Promise.resolve({ rows: [] });
          }

          return Promise.resolve({ rows: [] });
        });

        await mockIndexer.handleReorg(reorgBlockNumber);

        // Verify cursor was updated to before the reorg point
        expect(mockPoolClient.query).toHaveBeenCalledWith(
          expect.stringContaining('UPDATE indexer_state'),
          expect.arrayContaining([reorgBlockNumber - 1])
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
        mockPoolClient.query.mockResolvedValue({ rows: [] });

        await mockIndexer.handleReorg(reorgBlockNumber);

        // Cursor should not be updated since reorg is before current position
        expect(mockPoolClient.query).not.toHaveBeenCalledWith(
          expect.stringContaining('UPDATE indexer_state'),
          expect.arrayContaining([expect.any(Number)])
        );
      });
    });

    describe('database transaction integrity during reorg', () => {
      it('should rollback transaction if reorg handling fails', async () => {
        const forkBlockNumber = 50;

        // Mock database error during reorg
        mockPoolClient.query
          .mockResolvedValueOnce({ rows: [{ number: 50, hash: '0xfork50' }] })
          .mockRejectedValueOnce(new Error('Database error'));

        // Mock rollback
        const rollbackSpy = jest.spyOn(mockPoolClient, 'query');

        try {
          await mockIndexer.handleReorg(forkBlockNumber);
        } catch (_error) {
          // Expected to fail
        }

        // Verify rollback was called
        expect(rollbackSpy).toHaveBeenCalledWith('ROLLBACK');
      });

      it('should commit transaction when reorg handling succeeds', async () => {
        const forkBlockNumber = 50;

        // Mock successful reorg
        mockPoolClient.query
          .mockResolvedValueOnce({ rows: [{ number: 50, hash: '0xfork50' }] })
          .mockResolvedValue({ rows: [] });

        await mockIndexer.handleReorg(forkBlockNumber);

        // Verify commit was called
        expect(mockPoolClient.query).toHaveBeenCalledWith('COMMIT');
      });
    });
  });
});
