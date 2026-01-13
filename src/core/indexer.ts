import {
  RpcProvider,
  validateAndParseAddress,
  CallData,
  events,
  hash,
  Abi,
  EmittedEvent,
  WebSocketChannel,
  Subscription,
} from 'starknet';

import { groupConsecutiveBlocks, parallelMap } from '../utils/blockUtils';
import {
  EventHandlerConfig,
  BaseEventHandlerConfig,
  EventHandlerParams,
  IndexerConfig,
  Logger,
  ReorgHandler,
  ReorgHandlerParams,
  Cursor,
  ConsoleLogger,
  QueuedBlock,
} from '../types/indexer';
import { BaseDbHandler } from '../utils/db/base-db-handler';
import { initializeDbHandler } from '../utils/db/helpers/initialize-db-handler';
import { setupProgressUi } from '../ui/progress';
import { ProgressStats } from './progressStats';

// Extract only struct event names from ABI - provides intellisense for event names
type ExtractStructEventNames<TAbi extends Abi> = {
  [K in keyof TAbi]: TAbi[K] extends {
    type: 'event';
    kind: 'struct';
    name: infer TName extends string;
  }
    ? TName
    : never;
}[number];

export class StarknetIndexer {
  private wsChannel: WebSocketChannel;
  private newHeadsSubscription?: Subscription<any>;
  private eventHandlers: Map<string, BaseEventHandlerConfig[]> = new Map();
  private reorgHandler: ReorgHandler | null = null; // using dedicated variable to avoid type conflicts
  private started: boolean = false;
  private provider?: RpcProvider;
  private blockQueue: QueuedBlock[] = [];
  private isProcessingHistoricalBlocks: boolean = false;
  private contractAddresses: Set<string> = new Set();
  private abiMapping: Map<string, any> = new Map();
  private cursor: Cursor | null = null;
  private logger: Logger;
  private pollTimeout?: NodeJS.Timeout;
  private readonly dbHandler: BaseDbHandler;
  private healthCheckInterval?: NodeJS.Timeout;

  private failedBlocks: number[] = [];
  private retryTimeout?: NodeJS.Timeout;
  private readonly RETRY_INTERVAL = 10000; // 10 seconds between retry checks
  private readonly HEALTH_CHECK_INTERVAL = 3000; // 1 second between health checks
  private readonly reconnectDelay: number = 1000;
  private readonly MAX_HISTORICAL_BLOCK_CONCURRENT_REQUESTS: number;
  private wsUrl: string;

  private progressStats: ProgressStats;
  private progressUiShutdown?: () => void;
  private hasExistingState: boolean = false;

  constructor(private config: IndexerConfig) {
    this.logger = config.logger || new ConsoleLogger(config.logLevel);
    this.progressStats = new ProgressStats();

    this.wsUrl = config.wsNodeUrl;

    this.wsChannel = new WebSocketChannel({
      nodeUrl: config.wsNodeUrl,
    });

    this.dbHandler = initializeDbHandler(config.database.type, config.database.config);

    if (config.contractAddresses) {
      config.contractAddresses.forEach((address) => {
        this.contractAddresses.add(this.normalizeAddress(address));
      });
    }

    try {
      this.provider = new RpcProvider({ nodeUrl: config.rpcNodeUrl, specVersion: '0.8.1' });
    } catch (error) {
      this.logger.error('Failed to initialize RPC provider:', error);
    }

    // Set concurrency for historical block fetching (default: 5, configurable)
    this.MAX_HISTORICAL_BLOCK_CONCURRENT_REQUESTS =
      config.maxHistoricalBlockConcurrentRequests ?? 5;

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    // Set up WebSocket channel event listeners
    this.wsChannel.on('error', (error) => {
      this.logger.error('WebSocket error:', error);
    });

    this.wsChannel.on('message', async (event: MessageEvent) => {
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (
          data &&
          data.method === 'starknet_subscriptionReorg' &&
          data.params?.result?.starting_block_number
        ) {
          const reorgPoint = data.params.result.starting_block_number;
          this.logger.info(`Handling reorg from block #${reorgPoint} (via WS reorg event)`);
          await this.handleReorg(reorgPoint);
        }
      } catch (err) {
        this.logger.error('Error parsing WebSocket message for reorg:', err);
      }
    });

    this.wsChannel.on('close', async (event) => {
      if (this.started) {
        this.logger.debug('Connection closed, attempting to reconnect...');
        this.logger.debug('Reason: ', event.reason);
        this.logger.debug('Code: ', event.code);

        await this.withExponentialBackoff('Reconnecting WebSocket', async () => {
          await new Promise((resolve) => setTimeout(resolve, this.reconnectDelay));
          this.logger.debug('Reconnecting WebSocket...');
          this.wsChannel = new WebSocketChannel({
            nodeUrl: this.wsUrl,
          });
          this.logger.debug('Reconnecting Websocket Successfully');
          this.setupEventHandlers();
          this.logger.debug('Setup Event Handlers Successfully');
          await this.wsChannel.waitForConnection();
          this.logger.debug('Wait For Connection Successfully');
          await this.subscribeToNewHeads();
          this.logger.debug('Subscribe New Heads Successfully');
        });
      }
    });
  }

  private async subscribeToNewHeads() {
    try {
      this.newHeadsSubscription = await this.wsChannel.subscribeNewHeads();

      this.newHeadsSubscription.on(async (data) => {
        // Skip processing if indexer has been stopped
        if (!this.started) {
          return;
        }

        await this.withErrorHandling(
          'Processing new head',
          async () => {
            const blockData = {
              block_number: data.block_number,
              block_hash: data.block_hash,
              parent_hash: data.parent_hash,
              timestamp: data.timestamp,
            };

            if (this.isProcessingHistoricalBlocks) {
              this.blockQueue.push(blockData);
            } else {
              this.logger.info(`Processing new block #${blockData.block_number}`);
              await this.processNewHead(blockData);
            }
          },
          { blockNumber: data.block_number }
        );
      });
    } catch (error) {
      this.logger.error('Failed to subscribe to new heads:', error);
      throw error;
    }
  }

  private getEventSelector(eventName: string): string {
    const cleanName = eventName.includes('::') ? eventName.split('::').pop() : eventName;
    if (!cleanName) {
      throw new Error(`Invalid event name: ${eventName}`);
    }
    return hash.getSelectorFromName(cleanName);
  }

  private async validateEventName(
    abi: Abi,
    contractAddress: string,
    eventName: string
  ): Promise<boolean> {
    if (!abi) {
      this.logger.error(`No ABI found for contract ${contractAddress}`);
      return false;
    }

    for (const item of abi) {
      if (item.type !== 'event') continue;

      const fullName = item.name;

      if (fullName.toLowerCase() === eventName.toLowerCase()) {
        this.logger.info(`Found event "${eventName}" in contract ${contractAddress}`);
        return true;
      }

      if (item.kind === 'enum' && Array.isArray(item.variants)) {
        for (const variant of item.variants) {
          if (variant.name?.toLowerCase() === eventName.toLowerCase()) {
            this.logger.info(`Found enum variant "${eventName}" in contract ${contractAddress}`);
            return true;
          }
        }
      }
    }

    this.logger.error(`Event "${eventName}" not found in contract ${contractAddress} ABI`);
    return false;
  }

  private normalizeAddress(address: string): string {
    return validateAndParseAddress(address).toLowerCase();
  }

  private async withTransaction<T>(
    operation: string,
    fn: () => Promise<T>,
    context: Record<string, any> = {}
  ): Promise<T | undefined> {
    if (!this.dbHandler.isConnected()) {
      this.logger.warn('Persistent database client not initialized, attempting to connect...');
      try {
        await this.dbHandler.connect();
        this.logger.debug('Persistent database client connected successfully');
      } catch (err) {
        this.logger.error('Failed to connect persistent database client:', err);
        return undefined;
      }
    }

    try {
      return await this.dbHandler.withTransaction(fn);
    } catch (error) {
      this.logger.error(`${operation} failed:`, { ...context, error });
      return undefined;
    }
  }

  // Initialize the database schema
  public async initializeDatabase(): Promise<number | undefined> {
    const shouldRelease = !this.dbHandler.isConnected();

    if (shouldRelease) {
      this.logger.warn('Persistent database client not initialized, attempting to connect...');
      try {
        await this.dbHandler.connect();
        this.logger.info('Persistent database client connected successfully');
      } catch (err) {
        this.logger.error('Failed to connect persistent database client:', err);
        return undefined;
      }
    }

    try {
      // in blocks table, composite primary key with both number and hash
      await this.dbHandler.initializeDb();

      const result = await this.dbHandler.getIndexerState(this.config.cursorKey);

      if (!result) {
        this.hasExistingState = false;
        let startingBlock: number;
        if (this.config.startingBlockNumber === 'latest') {
          if (!this.provider) throw new Error('Provider not initialized');
          this.progressStats.incrementRpcRequest();
          startingBlock = await this.provider.getBlockNumber();
        } else {
          startingBlock = this.config.startingBlockNumber;
        }
        this.cursor = { blockNumber: startingBlock, blockHash: '' };
        await this.dbHandler.initializeIndexerState(startingBlock, this.config.cursorKey);
        return startingBlock;
      } else {
        this.hasExistingState = true;
        this.cursor = {
          blockNumber: result.last_block_number,
          blockHash: result.last_block_hash,
        };
        return this.cursor.blockNumber;
      }
    } finally {
      if (shouldRelease) {
        await this.dbHandler.disconnect();
      }
    }
  }

  // Register an event handler for a contract address with optional event name
  public async onEvent<TAbi extends Abi, TEventName extends ExtractStructEventNames<TAbi>>(
    params: EventHandlerParams<TAbi, TEventName>
  ): Promise<void> {
    const { contractAddress, eventName, abi, handler } = params;

    if (!contractAddress) {
      throw new Error('Contract address is required');
    }

    if (!handler) {
      throw new Error('Handler is required');
    }

    const normalizedAddress = this.normalizeAddress(contractAddress);
    this.logger.info(
      `Registering handler for contract ${normalizedAddress}${eventName ? `, event: ${eventName}` : ''}`
    );

    this.contractAddresses.add(normalizedAddress);
    const handlerConfig: EventHandlerConfig<TAbi, TEventName> = {
      handler: handler,
    };

    if (eventName) {
      const isValid = await this.validateEventName(abi, normalizedAddress, eventName);
      if (!isValid) {
        throw new Error(`Event "${eventName}" not found in contract ${normalizedAddress} ABI`);
      }
    }

    const handlerKey = eventName
      ? `${normalizedAddress}:${this.getEventSelector(eventName)}`
      : normalizedAddress;

    if (!this.eventHandlers.has(handlerKey)) {
      this.eventHandlers.set(handlerKey, []);
    }

    const handlers = this.eventHandlers.get(handlerKey)!;
    handlers.push(handlerConfig);
    this.logger.info(`Successfully registered handler for ${handlerKey}`);

    this.abiMapping.set(normalizedAddress, abi);
  }

  // Register an event handler for a contract address with optional event name
  public async onReorg(params: ReorgHandlerParams): Promise<void> {
    const { handler, isOverride } = params;

    if (!handler) {
      throw new Error('Handler is required');
    }

    if (!!this.reorgHandler) {
      if (isOverride) {
        this.logger.warn('Reorg handler already registered, overriding...');
      }

      // we want to be able to throw to prevent accidental errors
      else {
        throw new Error('Reorg handler already registered, use isOverride to override');
      }
    }

    this.reorgHandler = handler;
  }

  // Start the indexer
  public async start(): Promise<void> {
    await this.initializeDatabase();
    this.logger.info(`Starting from block ${this.cursor?.blockNumber}`);

    // Establish persistent database connection
    this.logger.info('[Database] Establishing connection...');
    await this.dbHandler.connect();
    this.logger.info('[Database] Connection established');

    let currentBlock = 0;
    if (this.provider) {
      this.progressStats.incrementRpcRequest();
      currentBlock = await this.provider.getBlockNumber();
    }
    let targetBlock: number;
    if (this.hasExistingState && this.cursor) {
      // Resume from the block after the last processed block
      targetBlock = this.cursor.blockNumber;
    } else {
      // Fresh start: honor configured starting block (or latest)
      if (this.config.startingBlockNumber === 'latest') {
        targetBlock = currentBlock;
      } else {
        targetBlock = this.config.startingBlockNumber;
      }
    }

    try {
      this.logger.info('[WebSocket] Connecting to node...');
      await this.wsChannel.waitForConnection();
      this.logger.info('[WebSocket] Successfully connected');
    } catch (error) {
      this.logger.error('[WebSocket] Failed to establish connection:', error);
      throw error;
    }

    try {
      this.logger.info('[WebSocket] Subscribing to new heads...');
      await this.subscribeToNewHeads();
      this.started = true;
      this.logger.info('[WebSocket] Successfully subscribed to new heads');
    } catch (error) {
      this.logger.error('[WebSocket] Failed to subscribe to new heads:', error);
      throw error;
    }

    if (this.config.enableUiProgress) {
      this.startProgressUiLoop();
    }

    if (targetBlock < currentBlock && this.provider) {
      this.isProcessingHistoricalBlocks = true;
      await this.processHistoricalBlocks(targetBlock, currentBlock);
      this.isProcessingHistoricalBlocks = false;
    }
    this.logger.info('[Indexer] Processing queued blocks...');
    await this.processBlockQueue();
    this.logger.info('[Indexer] Finished processing queued blocks');

    // start health check interval
    this.healthCheckInterval = setInterval(async () => {
      const health = await this.healthCheck();
      this.progressStats.updateHealth(health);
    }, this.HEALTH_CHECK_INTERVAL);
  }

  // Process a new block head
  private async processNewHead(blockData: any): Promise<void> {
    if (this.cursor && blockData.block_number <= this.cursor.blockNumber) {
      if (
        blockData.block_number === this.cursor.blockNumber &&
        blockData.block_hash !== this.cursor.blockHash
      ) {
        this.logger.info(`Detected reorg at block #${blockData.block_number}`);
        await this.handleReorg(blockData.block_number);
      }
    }

    try {
      await this.withTransaction(
        'Processing block',
        async () => {
          await this.insertBlock(blockData);
          await this.updateCursor(blockData.block_number, blockData.block_hash);
          this.logger.info(`Successfully processed block #${blockData.block_number}`);

          if (this.provider) {
            await this.processBlockEvents(
              blockData.block_number,
              blockData.block_number,
              blockData.block_hash
            );
          }

          if (this.failedBlocks.length > 0 && this.failedBlocks.includes(blockData.block_number)) {
            this.failedBlocks = this.failedBlocks.filter(
              (block) => block !== blockData.block_number
            );
          }
        },
        { blockNumber: blockData.block_number }
      );
      // No need to call updateEvent for blocks unless you want to track them as events
    } catch (error) {
      this.logger.error(`Failed to process block #${blockData.block_number}:`, error);
      this.addFailedBlock(blockData, error);
    }
  }

  // Handle chain reorgs
  public async handleReorg(forkBlockNumber: number): Promise<void> {
    this.logger.info(`Handling reorg from block #${forkBlockNumber}`);

    await this.withTransaction(
      'Handling reorg',
      async () => {
        // find the forked block in DB
        const forkedBlock = await this.dbHandler.getBlockByNumber(forkBlockNumber);

        if (!forkedBlock) {
          return;
        }

        // find blockhash of the forked block
        let deletionPointerBlockHash: string | null = forkedBlock.block_hash;
        let deletionPointerBlockNumber: number | null = forkedBlock.block_number;

        // build queries to mark non-canonical and delete events
        while (!!deletionPointerBlockHash && !!deletionPointerBlockNumber) {
          // deletes the forked block from the blocks table
          await this.dbHandler.deleteBlock(deletionPointerBlockHash);

          // delete all events associated with the non-canonical block
          await this.dbHandler.deleteEventsByBlockNumber(deletionPointerBlockNumber);

          // find next block to delete (based on parent hash)
          // find child block of the deletion pointer block
          const childBlock = await this.dbHandler.getBlockByParentHash(deletionPointerBlockHash);

          if (childBlock) {
            deletionPointerBlockHash = childBlock.block_hash;
            deletionPointerBlockNumber = childBlock.block_number;
          } else {
            deletionPointerBlockHash = null;
            deletionPointerBlockNumber = null;
          }
        }

        if (this.cursor && this.cursor.blockNumber >= forkBlockNumber) {
          await this.updateCursor(forkBlockNumber - 1, '');
        }

        if (this.reorgHandler) {
          const forkedBlockDataForHandler = {
            block_number: forkedBlock.block_number,
            block_hash: forkedBlock.block_hash,
            parent_hash: forkedBlock.parent_hash,
            timestamp: forkedBlock.timestamp,
          };
          await this.reorgHandler(forkedBlockDataForHandler);
        }

        this.logger.info(`Successfully handled reorg from block #${forkBlockNumber}`);
      },
      { forkBlockNumber }
    );
  }

  // Stop the indexer
  public async stop(): Promise<void> {
    this.logger.info('Stopping indexer...');
    this.started = false;

    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
    }

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = undefined;
    }
    this.stopProgressUiLoop();

    // Unsubscribe from new heads subscription to stop event processing
    if (this.newHeadsSubscription) {
      this.logger.info('[WebSocket] Unsubscribing from new heads...');
      try {
        if (!this.newHeadsSubscription.isClosed) {
          await this.newHeadsSubscription.unsubscribe();
        }
        this.logger.info('[WebSocket] Successfully unsubscribed from new heads');
      } catch (error: any) {
        // Error code 66 means "Invalid subscription id" - subscription already closed on server
        const isAlreadyClosed =
          error?.message?.includes('code":66') || error?.message?.includes('Invalid subscription');
        if (isAlreadyClosed) {
          this.logger.debug('[WebSocket] Subscription already closed on server');
        } else {
          this.logger.error('[WebSocket] Error unsubscribing from new heads:', error);
        }
      }
    }
    this.newHeadsSubscription = undefined;

    // Close WebSocket connection
    if (this.wsChannel.isConnected()) {
      this.logger.info('[WebSocket] Closing connection...');
      this.wsChannel.disconnect();
      this.logger.info('[WebSocket] Connection closed');
    }

    // Close persistent database connection
    if (this.dbHandler.isConnected()) {
      this.logger.info('[Database] Closing connection...');
      await this.dbHandler.disconnect();
      this.logger.info('[Database] Connection closed');
    }

    this.logger.info('Indexer stopped');
  }

  public async healthCheck(): Promise<{ database: boolean; ws: boolean; rpc: boolean }> {
    this.logger.debug('Checking health...');

    let databaseHealthy = true;
    let wsHealthy = true;
    let rpcHealthy = true;

    // Perform health checks - separate try-catch blocks for each function
    try {
      await this.dbHandler.healthCheck();
    } catch (error) {
      this.logger.error('Database health check failed:', error);
      databaseHealthy = false;
    }

    try {
      let blockNumber: number;
      if (!this.provider) {
        this.logger.error('RPC provider not initialized');
        rpcHealthy = false;
        blockNumber = -1;
      } else {
        blockNumber = await this.provider.getBlockNumber();
        // Validate provider response
        if (typeof blockNumber !== 'number' || blockNumber < 0) {
          this.logger.error('Invalid block number returned from provider');
          rpcHealthy = false;
        }
      }
    } catch (error) {
      this.logger.error('RPC provider health check failed:', error);
      rpcHealthy = false;
    }

    // WebSocket check
    if (!this.wsChannel.isConnected()) {
      this.logger.error('WebSocket disconnected');
      wsHealthy = false;
    }

    return { database: databaseHealthy, ws: wsHealthy, rpc: rpcHealthy };
  }

  private async processBlockQueue(): Promise<void> {
    if (this.blockQueue.length === 0) return;
    const TAG = 'processBlockQueue';
    const blocksToProcess = [...this.blockQueue];
    this.blockQueue = [];

    this.logger.info(`[${TAG}] Processing ${blocksToProcess.length} queued blocks`);

    const maxBlockNumber = Math.max(...blocksToProcess.map((block) => block.block_number));
    const minBlockNumber = Math.min(...blocksToProcess.map((block) => block.block_number));

    try {
      this.logger.info(`[${TAG}] Processing queued blocks ${minBlockNumber} to ${maxBlockNumber}`);
      await this.processHistoricalBlocks(minBlockNumber, maxBlockNumber);
      this.logger.info(
        `[${TAG}] Successfully processed queued blocks ${minBlockNumber} to ${maxBlockNumber}`
      );
    } catch (error) {
      this.logger.error(
        `[${TAG}] Error processing queued blocks ${minBlockNumber} to ${maxBlockNumber}:`,
        error
      );
    }
  }

  private async updateCursor(blockNumber: number, blockHash: string): Promise<void> {
    this.cursor = { blockNumber, blockHash };
    await this.dbHandler.updateCursor(blockNumber, blockHash, this.config.cursorKey);
  }

  private async withErrorHandling<T>(
    operation: string,
    fn: () => Promise<T>,
    context: Record<string, any> = {}
  ): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      this.logger.error(`${operation} failed:`, { ...context, error });
      return undefined;
    }
  }

  private async fetchEventsByRange(
    fromBlock: number,
    toBlock: number
  ): Promise<EmittedEvent[] | undefined> {
    if (!this.provider || !this.contractAddresses) {
      this.logger.error('No provider or contract addresses found');
      return;
    }

    let continuationToken;
    let allEvents: EmittedEvent[] = [];

    const eventSelectors: string[] = [];

    for (const [handlerKey] of this.eventHandlers.entries()) {
      if (handlerKey.includes(':')) {
        const [_, eventSelector] = handlerKey.split(':');
        eventSelectors.push(eventSelector);
      }
    }

    do {
      const request = {
        from_block: { block_number: fromBlock },
        to_block: { block_number: toBlock },
        keys: eventSelectors.length > 0 ? [eventSelectors] : [],
        chunk_size: 1000,
        continuation_token: continuationToken,
      } as const;

      const response = await this.provider.getEvents(request);
      allEvents = [...allEvents, ...response.events];
      continuationToken = response.continuation_token;
    } while (continuationToken);

    return allEvents;
  }

  private async fetchEventsByBlockHash(blockHash: string): Promise<EmittedEvent[] | undefined> {
    if (!this.provider || !this.contractAddresses) {
      this.logger.error('No provider or contract addresses found');
      return;
    }

    let continuationToken;
    let allEvents: EmittedEvent[] = [];

    const eventSelectors: string[] = [];

    for (const [handlerKey] of this.eventHandlers.entries()) {
      if (handlerKey.includes(':')) {
        const [_, eventSelector] = handlerKey.split(':');
        eventSelectors.push(eventSelector);
      }
    }

    do {
      const request = {
        from_block: { block_hash: blockHash },
        keys: eventSelectors.length > 0 ? [eventSelectors] : [],
        chunk_size: 1000,
        continuation_token: continuationToken,
      } as const;

      const response = await this.provider.getEvents(request);
      allEvents = [...allEvents, ...response.events];
      continuationToken = response.continuation_token;
    } while (continuationToken);

    return allEvents;
  }

  private async processHistoricalBlocks(fromBlock: number, toBlock: number): Promise<void> {
    const chunkSize = 100;
    const TAG = 'processHistoricalBlocks';

    // Initialize stats for progress logging
    this.progressStats.initSyncStats(fromBlock, toBlock);

    for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += chunkSize) {
      const chunkEndBlock = Math.min(blockNumber + chunkSize - 1, toBlock);
      const chunkLabel = `blocks_${blockNumber}_to_${chunkEndBlock}`;

      this.logger.info(`[${TAG}] Starting processing of ${chunkLabel}`);

      // Parallelize block fetching with concurrency control
      const blockNumbersToFetch: number[] = [];

      for (let currentBlock = blockNumber; currentBlock <= chunkEndBlock; currentBlock++) {
        if (await this.checkIsBlockProcessed(currentBlock)) {
          this.logger.debug(`[${TAG}] Skipping block #${currentBlock} - already processed`);
          continue;
        }
        blockNumbersToFetch.push(currentBlock);
      }

      const blocks: any[] = [];
      const time = Date.now();
      const fetchedBlocks = await parallelMap(
        blockNumbersToFetch,
        async (currentBlock) => {
          const blockFetchStart = Date.now();
          this.progressStats.incrementRpcRequest();
          const block = await this.provider?.getBlock(currentBlock);
          const fetchDuration = Date.now() - blockFetchStart;

          if (!block || !block.block_hash) {
            this.logger.error(
              `[${TAG}] No block found for #${currentBlock} (fetch took ${fetchDuration}ms)`
            );
            return undefined;
          }

          return {
            block_number: block.block_number,
            block_hash: block.block_hash,
            parent_hash: block.parent_hash,
            timestamp: block.timestamp,
          };
        },
        this.MAX_HISTORICAL_BLOCK_CONCURRENT_REQUESTS
      );
      for (const b of fetchedBlocks) {
        if (b) blocks.push(b);
      }

      const fetchDuration = Date.now() - time;
      this.logger.debug(`[${TAG}] Fetched ${blocks.length} blocks in ${fetchDuration}ms`);

      // Process all blocks and their events in a single transaction
      await this.withTransaction(
        `Processing blocks ${blockNumber} to ${chunkEndBlock} and their events`,
        async () => {
          const insertStart = Date.now();

          // Batch insert all blocks
          if (blocks.length > 0) {
            await this.dbHandler.batchInsertBlocks(blocks);

            this.logger.debug(
              `[${TAG}] Inserted ${blocks.length} blocks in ${Date.now() - insertStart}ms`
            );
            const eventsStart = Date.now();

            if (blocks.length < chunkSize) {
              const blockRanges = groupConsecutiveBlocks(blocks.map((block) => block.block_number));
              for (const range of blockRanges) {
                await this.processBlockEvents(range.from, range.to);
              }
            } else {
              await this.processBlockEvents(blockNumber, chunkEndBlock);
            }
            this.logger.debug(`[${TAG}] Events processed in ${Date.now() - eventsStart}ms`);
          } else {
            this.logger.info(
              `[${TAG}] Skipping blocks ${blockNumber} to ${chunkEndBlock} - already processed`
            );
          }
        }
      );
    }
  }

  private async processBlockEvents(fromBlock: number, toBlock: number, blockHash?: string) {
    if (!this.provider) {
      this.logger.error('No RPC provider available to fetch ABI');
      return;
    }

    const TAG = 'processBlockEvents';

    try {
      const fetchStart = Date.now();

      const blockEvents = await this.withExponentialBackoff(
        `Fetch events for blocks ${fromBlock} to ${toBlock}`,
        async () => {
          const events = blockHash
            ? await this.fetchEventsByBlockHash(blockHash)
            : await this.fetchEventsByRange(fromBlock, toBlock);
          return events;
        }
      );

      const fetchDuration = Date.now() - fetchStart;

      if (!blockEvents || blockEvents.length === 0) {
        return;
      }

      this.logger.debug(`[${TAG}] Fetched ${blockEvents.length} events in ${fetchDuration}ms`);

      for (let eventIndex = 0; eventIndex < blockEvents.length; eventIndex++) {
        const event = blockEvents[eventIndex];
        const fromAddress = this.normalizeAddress(event.from_address);

        if (this.contractAddresses.size > 0 && !this.contractAddresses.has(fromAddress)) {
          continue;
        }

        const eventObj = {
          block_number: event.block_number,
          block_hash: event.block_hash || '',
          transaction_hash: event.transaction_hash,
          from_address: fromAddress,
          event_index: eventIndex,
          keys: event.keys,
          data: event.data,
          parsed: {},
        };

        let handlerConfigs: BaseEventHandlerConfig[] = [];

        if (event.keys && event.keys.length > 0) {
          const eventSelector = event.keys[0];
          const specificHandlerKey = `${fromAddress}:${eventSelector}`;
          const specificHandlers = this.eventHandlers.get(specificHandlerKey) || [];
          handlerConfigs = [...specificHandlers];
        }

        const generalHandlers = this.eventHandlers.get(fromAddress) || [];
        handlerConfigs = [...handlerConfigs, ...generalHandlers];

        if (handlerConfigs.length > 0) {
          const abi = this.abiMapping.get(fromAddress);
          let parsedEvent = eventObj;

          if (abi) {
            try {
              const abiEvents = events.getAbiEvents(abi);
              const abiStructs = CallData.getAbiStruct(abi);
              const abiEnums = CallData.getAbiEnum(abi);

              const parsedEvents = events.parseEvents([eventObj], abiEvents, abiStructs, abiEnums);

              if (parsedEvents && parsedEvents.length > 0) {
                // Get the first key of the parsed event (the event name)
                const eventKey = Object.keys(parsedEvents[0])[0];
                const parsedValues = parsedEvents[0][eventKey];

                const parsedEventWithOriginal = {
                  block_number: eventObj.block_number,
                  block_hash: eventObj.block_hash,
                  transaction_hash: eventObj.transaction_hash,
                  from_address: fromAddress,
                  event_index: eventObj.event_index,
                  keys: eventObj.keys,
                  data: eventObj.data,
                  parsed: parsedValues, // Add the parsed values directly
                };
                parsedEvent = parsedEventWithOriginal;
                // this.logger.debug(`Parsed event values:`, parsedValues);
                const eventName = eventKey;
                this.progressStats.updateEvent(event.block_number, eventName, fromAddress);
              }
            } catch (error) {
              this.logger.error(`Error parsing event from contract ${fromAddress}:`, error);
              throw error; // Rethrow to trigger rollback
            }
          }

          for (const { handler } of handlerConfigs) {
            try {
              await handler(parsedEvent, this.dbHandler, this);
            } catch (error) {
              this.logger.error(
                `Error processing event handler for contract ${fromAddress}:`,
                error
              );
              throw error; // Rethrow to trigger rollback
            }
          }
        }
      }
    } catch (error) {
      this.logger.error(`Error processing block ${fromBlock} to ${toBlock} transactions:`, error);
      throw error; // Rethrow to trigger rollback
    }
  }

  private async insertBlock(blockData: {
    block_number: number;
    block_hash: string;
    parent_hash: string;
    timestamp: number;
  }) {
    await this.dbHandler.insertBlock(blockData);
  }

  private async withExponentialBackoff<T>(
    operation: string,
    fn: () => Promise<T>,
    maxRetries: number = 5,
    initialDelay: number = 500,
    silent: boolean = true
  ): Promise<T | undefined> {
    let retries = 0;
    let delay = initialDelay;

    while (retries < maxRetries) {
      try {
        return await fn();
      } catch (error) {
        retries++;
        if (retries === maxRetries) {
          if (!silent) {
            this.logger.error(`${operation} failed after ${maxRetries} retries:`, error);
          }
          return undefined;
        }

        if (!silent) {
          this.logger.warn(
            `${operation} failed, retrying in ${delay}ms (attempt ${retries}/${maxRetries}):`,
            error
          );
        }

        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 30000); // Double the delay, max 30 seconds
      }
    }

    return undefined;
  }

  private async checkIsBlockProcessed(blockNumber: number): Promise<boolean> {
    return await this.dbHandler.checkIsBlockProcessed(blockNumber);
  }

  private addFailedBlock(blockData: QueuedBlock, _error: any): void {
    if (!this.failedBlocks.includes(blockData.block_number)) {
      this.failedBlocks.push(blockData.block_number);
      this.logger.warn(`Added block #${blockData.block_number} to failed blocks queue`);
    }

    // Start retry process if it's not already running
    if (!this.retryTimeout) {
      this.startRetryProcess();
    }
  }

  private async retryFailedBlocks(): Promise<void> {
    if (this.failedBlocks.length === 0) return;

    const latestBlock = await this.provider!.getBlock('latest');
    const blocksToRetry = this.failedBlocks.filter(
      (blockNumber) => blockNumber < latestBlock.block_number
    );

    if (blocksToRetry.length === 0) return;

    this.logger.info(`Attempting to retry ${blocksToRetry.length} failed blocks`);

    for (const blockNumber of blocksToRetry) {
      try {
        await this.processHistoricalBlocks(blockNumber, blockNumber);
        // Remove from failed blocks if successful
        this.failedBlocks = this.failedBlocks.filter((b) => b !== blockNumber);
      } catch (error) {
        this.logger.error(`Retry failed for block #${blockNumber}:`, error);
      }
    }
  }

  private startRetryProcess(): void {
    const retryProcess = async () => {
      if (!this.started) return;

      try {
        await this.retryFailedBlocks();
      } catch (error) {
        this.logger.error('Error in retry process:', error);
      }

      // Only schedule next retry if there are failed blocks
      if (this.failedBlocks.length > 0) {
        this.retryTimeout = setTimeout(retryProcess, this.RETRY_INTERVAL);
      } else {
        this.logger.debug('No failed blocks to retry, stopping retry process');
        clearTimeout(this.retryTimeout);
        this.retryTimeout = undefined;
      }
    };

    retryProcess();
  }

  private startProgressUiLoop() {
    if (this.progressUiShutdown) return;
    this.progressUiShutdown = setupProgressUi(() => this.progressStats.getUiState());
  }

  private stopProgressUiLoop() {
    if (this.progressUiShutdown) {
      this.progressUiShutdown();
      this.progressUiShutdown = undefined;
    }
  }
}
