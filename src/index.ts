import {
  RpcProvider,
  validateAndParseAddress,
  CallData,
  events,
  hash,
  Abi,
  EmittedEvent,
  WebSocketChannel,
} from 'starknet';
import { Pool, PoolClient } from 'pg';
import { EventToPrimitiveType } from './types/abi-wan-helpers';
import { ExtractAbiEventNames } from 'abi-wan-kanabi/kanabi';
import { groupConsecutiveBlocks } from './utils/blockUtils';

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

export interface Logger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

export class ConsoleLogger implements Logger {
  constructor(private level: LogLevel = LogLevel.INFO) {}

  private shouldLog(level: LogLevel): boolean {
    const levels = Object.values(LogLevel);
    return levels.indexOf(level) >= levels.indexOf(this.level);
  }

  debug(message: string, ...args: any[]): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.debug(`[DEBUG] ${message}`, ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.info(`[INFO] ${message}`, ...args);
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(`[WARN] ${message}`, ...args);
    }
  }

  error(message: string, ...args: any[]): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      console.error(`[ERROR] ${message}`, ...args);
    }
  }
}

export interface IndexerConfig {
  rpcNodeUrl: string;
  wsNodeUrl: string;
  databaseUrl: string;
  startingBlockNumber: number | 'latest';
  contractAddresses?: string[];
  cursorKey?: string;
  logLevel?: LogLevel;
  logger?: Logger;
}

export type StarknetEvent<TAbi extends Abi, TEventName extends ExtractAbiEventNames<TAbi>> = {
  block_number: number;
  block_hash: string;
  transaction_hash: string;
  from_address: string;
  event_index: number;
  keys: string[];
  data: string[];
  parsed: EventToPrimitiveType<TAbi, TEventName>;
};

export type EventHandler<TAbi extends Abi, TEventName extends ExtractAbiEventNames<TAbi>> = (
  event: StarknetEvent<TAbi, TEventName>,
  client: PoolClient,
  indexer: StarknetIndexer
) => Promise<void>;

interface EventHandlerParams<TAbi extends Abi, TEventName extends ExtractAbiEventNames<TAbi>> {
  contractAddress: string;
  abi: TAbi;
  eventName: TEventName;
  handler: EventHandler<TAbi, TEventName>;
}

interface EventHandlerConfig {
  handler: EventHandler<any, any>;
}

interface QueuedBlock {
  block_number: number;
  block_hash: string;
  parent_hash: string;
  timestamp: number;
}

interface Cursor {
  blockNumber: number;
  blockHash: string;
}

export class StarknetIndexer {
  private wsChannel: WebSocketChannel;
  private pool: Pool;
  private persistentClient?: PoolClient;
  private eventHandlers: Map<string, EventHandlerConfig[]> = new Map();
  private started: boolean = false;
  private provider?: RpcProvider;
  private blockQueue: QueuedBlock[] = [];
  private isProcessingHistoricalBlocks: boolean = false;
  private contractAddresses: Set<string> = new Set();
  private abiMapping: Map<string, any> = new Map();
  private cursor: Cursor | null = null;
  private logger: Logger;
  private pollTimeout?: NodeJS.Timeout;

  private failedBlocks: number[] = [];
  private retryTimeout?: NodeJS.Timeout;
  private readonly RETRY_INTERVAL = 10000; // 10 seconds between retry checks
  private readonly reconnectDelay: number = 1000;

  private wsUrl: string;

  constructor(private config: IndexerConfig) {
    this.logger = config.logger || new ConsoleLogger(config.logLevel);

    this.wsUrl = config.wsNodeUrl;

    this.wsChannel = new WebSocketChannel({
      nodeUrl: config.wsNodeUrl,
    });

    this.pool = new Pool({
      connectionString: config.databaseUrl,
    });

    if (config.contractAddresses) {
      config.contractAddresses.forEach((address) => {
        this.contractAddresses.add(this.normalizeAddress(address));
      });
    }

    try {
      this.provider = new RpcProvider({ nodeUrl: config.rpcNodeUrl, specVersion: '0.8' });
    } catch (error) {
      this.logger.error('Failed to initialize RPC provider:', error);
    }

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    this.wsChannel.onNewHeads = async (data) => {
      await this.withErrorHandling(
        'Processing new head',
        async () => {
          const blockData = {
            block_number: data.result.block_number,
            block_hash: data.result.block_hash,
            parent_hash: data.result.parent_hash,
            timestamp: data.result.timestamp,
          };

          if (this.isProcessingHistoricalBlocks) {
            this.logger.info(`Queuing block #${blockData.block_number} for later processing`);
            this.blockQueue.push(blockData);
          } else {
            this.logger.info(`Processing new block #${blockData.block_number}`);
            await this.processNewHead(blockData);
          }
        },
        { blockNumber: data.result.block_number }
      );
    };

    this.wsChannel.onReorg = async (data) => {
      const reorgPoint = data.result?.starting_block_number;
      if (reorgPoint) {
        this.logger.info(`Handling reorg from block #${reorgPoint}`);
        await this.handleReorg(reorgPoint);
      }
    };

    this.wsChannel.onError = (error) => {
      this.logger.error('WebSocket error:', error);
    };

    this.wsChannel.onClose = async (event) => {
      if (this.started) {
        this.logger.info('Connection closed, attempting to reconnect...');
        this.logger.info('Reason: ', event.reason);
        this.logger.info('Code: ', event.code);

        await this.withExponentialBackoff('Reconnecting WebSocket', async () => {
          await new Promise((resolve) => setTimeout(resolve, this.reconnectDelay));
          this.logger.info('Reconnecting WebSocket...');
          this.wsChannel = new WebSocketChannel({
            nodeUrl: this.wsUrl,
          });
          this.logger.info('Reconnecting Websocket Successfully');
          this.setupEventHandlers();
          this.logger.info('Setup Event Handlers Successfully');
          await this.wsChannel.waitForConnection();
          this.logger.info('Wait For Connection Successfully');
          await this.wsChannel.subscribeNewHeads();
          this.logger.info('Subscribe New Heads Successfully');
        });
      }
    };
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
    fn: (client: PoolClient) => Promise<T>,
    context: Record<string, any> = {}
  ): Promise<T | undefined> {
    if (!this.persistentClient) {
      this.logger.warn('Persistent database client not initialized, attempting to connect...');
      try {
        this.persistentClient = await this.pool.connect();
        this.logger.info('Persistent database client connected successfully');
      } catch (err) {
        this.logger.error('Failed to connect persistent database client:', err);
        return undefined;
      }
    }

    try {
      await this.persistentClient.query('BEGIN');
      const result = await fn(this.persistentClient);
      await this.persistentClient.query('COMMIT');
      return result;
    } catch (error) {
      await this.persistentClient.query('ROLLBACK');
      this.logger.error(`${operation} failed:`, { ...context, error });
      return undefined;
    }
  }

  // Initialize the database schema
  public async initializeDatabase(): Promise<number | undefined> {
    const client = this.persistentClient || (await this.pool.connect());
    const shouldRelease = !this.persistentClient;

    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS blocks (
          number BIGINT PRIMARY KEY,
          hash TEXT UNIQUE NOT NULL,
          parent_hash TEXT NOT NULL,
          timestamp BIGINT NOT NULL,
          is_canonical BOOLEAN NOT NULL DEFAULT TRUE
        );
        
        CREATE TABLE IF NOT EXISTS events (
          id SERIAL PRIMARY KEY,
          block_number BIGINT NOT NULL,
          transaction_hash TEXT NOT NULL,
          from_address TEXT NOT NULL,
          event_index INTEGER NOT NULL,
          keys TEXT[] NOT NULL,
          data TEXT[] NOT NULL,
          CONSTRAINT fk_block FOREIGN KEY (block_number) 
            REFERENCES blocks(number) ON DELETE CASCADE
        );
        
        CREATE TABLE IF NOT EXISTS indexer_state (
          id INTEGER PRIMARY KEY DEFAULT 1,
          last_block_number BIGINT,
          last_block_hash TEXT,
          cursor_key TEXT,
          CONSTRAINT singleton CHECK (id = 1)
        );
        
        CREATE INDEX IF NOT EXISTS idx_events_block ON events(block_number);
        CREATE INDEX IF NOT EXISTS idx_events_from ON events(from_address);
      `);

      const result = await client.query(
        `
        SELECT last_block_number, last_block_hash 
        FROM indexer_state 
        WHERE id = 1 AND (cursor_key IS NULL OR cursor_key = $1)
      `,
        [this.config.cursorKey || null]
      );

      if (result.rows.length === 0) {
        let startingBlock: number;
        if (this.config.startingBlockNumber === 'latest') {
          if (!this.provider) throw new Error('Provider not initialized');
          startingBlock = await this.provider.getBlockNumber();
        } else {
          startingBlock = this.config.startingBlockNumber;
        }
        this.cursor = { blockNumber: startingBlock, blockHash: '' };

        await client.query(
          `
          INSERT INTO indexer_state (last_block_number, last_block_hash, cursor_key) 
          VALUES ($1, $2, $3)
        `,
          [startingBlock, '', this.config.cursorKey || null]
        );

        return startingBlock;
      } else {
        this.cursor = {
          blockNumber: result.rows[0].last_block_number,
          blockHash: result.rows[0].last_block_hash,
        };
        return this.cursor.blockNumber;
      }
    } finally {
      if (shouldRelease) {
        client.release();
      }
    }
  }

  // Register an event handler for a contract address with optional event name
  public async onEvent<TAbi extends Abi, TEventName extends ExtractAbiEventNames<TAbi>>(
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

    const handlerConfig: EventHandlerConfig = {
      handler,
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

  // Start the indexer
  public async start(): Promise<void> {
    await this.initializeDatabase();
    this.logger.info(`Starting from block ${this.cursor?.blockNumber}`);

    // Establish persistent database connection
    this.logger.info('[Database] Establishing connection...');
    this.persistentClient = await this.pool.connect();
    this.logger.info('[Database] Connection established');

    const currentBlock = this.provider ? await this.provider.getBlockNumber() : 0;
    let targetBlock: number;
    if (this.config.startingBlockNumber === 'latest') {
      targetBlock = currentBlock;
    } else {
      targetBlock = this.config.startingBlockNumber;
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
      await this.wsChannel.subscribeNewHeads();
      this.started = true;
      this.logger.info('[WebSocket] Successfully subscribed to new heads');
    } catch (error) {
      this.logger.error('[WebSocket] Failed to subscribe to new heads:', error);
      throw error;
    }

    if (targetBlock < currentBlock && this.provider) {
      this.isProcessingHistoricalBlocks = true;
      await this.processHistoricalBlocks(targetBlock, currentBlock);
      this.isProcessingHistoricalBlocks = false;
    }
    this.logger.info('[Indexer] Processing queued blocks...');
    await this.processBlockQueue();
    this.logger.info('[Indexer] Finished processing queued blocks');
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
        async (client) => {
          await this.insertBlock(blockData, client);
          await this.updateCursor(blockData.block_number, blockData.block_hash, client);
          this.logger.info(`Successfully processed block #${blockData.block_number}`);

          if (this.provider) {
            await this.processBlockEvents(blockData.block_number, blockData.block_number, client);
          }

          if (this.failedBlocks.length > 0 && this.failedBlocks.includes(blockData.block_number)) {
            this.failedBlocks = this.failedBlocks.filter(
              (block) => block !== blockData.block_number
            );
          }
        },
        { blockNumber: blockData.block_number }
      );
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
      async (client) => {
        await client.query(
          `
        UPDATE blocks
        SET is_canonical = FALSE
        WHERE number >= $1
      `,
          [forkBlockNumber]
        );

        if (this.cursor && this.cursor.blockNumber >= forkBlockNumber) {
          await this.updateCursor(forkBlockNumber - 1, '', client);
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
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = undefined;
    }

    // Close persistent database connection
    if (this.persistentClient) {
      this.logger.info('[Database] Closing connection...');
      this.persistentClient.release();
      this.persistentClient = undefined;
      this.logger.info('[Database] Connection closed');
    }

    try {
      await this.pool.end();
    } catch (error) {
      this.logger.error('Error closing database pool:', error);
    }

    this.logger.info('Indexer stopped');
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

  private async updateCursor(
    blockNumber: number,
    blockHash: string,
    client: PoolClient
  ): Promise<void> {
    this.cursor = { blockNumber, blockHash };
    await client.query(
      `
      UPDATE indexer_state 
      SET last_block_number = $1, last_block_hash = $2
      WHERE id = 1 AND (cursor_key IS NULL OR cursor_key = $3)
    `,
      [blockNumber, blockHash, this.config.cursorKey || null]
    );
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

  private async fetchEvents(
    fromBlock: number,
    toBlock: number
  ): Promise<EmittedEvent[] | undefined> {
    if (!this.provider || !this.contractAddresses) {
      this.logger.error('No provider or contract addresses found');
      return;
    }

    let continuationToken;
    let allEvents: EmittedEvent[] = [];

    do {
      const response = await this.provider.getEvents({
        from_block: { block_number: fromBlock },
        to_block: { block_number: toBlock },
        chunk_size: 1000,
        continuation_token: continuationToken,
      });

      allEvents = [...allEvents, ...response.events];
      continuationToken = response.continuation_token;
    } while (continuationToken);

    return allEvents;
  }

  private async processHistoricalBlocks(fromBlock: number, toBlock: number): Promise<void> {
    const chunkSize = 100;
    const TAG = 'processHistoricalBlocks';

    for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += chunkSize) {
      const chunkEndBlock = Math.min(blockNumber + chunkSize - 1, toBlock);
      const chunkLabel = `blocks_${blockNumber}_to_${chunkEndBlock}`;

      this.logger.info(`[${TAG}] Starting processing of ${chunkLabel}`);

      // Pre-fetch all blocks and events before starting transaction
      const blocks: any[] = [];
      for (let currentBlock = blockNumber; currentBlock <= chunkEndBlock; currentBlock++) {
        if (await this.checkIsBlockProcessed(currentBlock)) {
          this.logger.debug(`[${TAG}] Skipping block #${currentBlock} - already processed`);
          continue;
        }

        const blockFetchStart = Date.now();
        const block = await this.provider?.getBlock(currentBlock);
        const fetchDuration = Date.now() - blockFetchStart;

        if (!block || !block.block_hash) {
          this.logger.error(
            `[${TAG}] No block found for #${currentBlock} (fetch took ${fetchDuration}ms)`
          );
          continue;
        }

        blocks.push({
          block_number: block.block_number,
          block_hash: block.block_hash,
          parent_hash: block.parent_hash,
          timestamp: block.timestamp,
        });
      }

      // Process all blocks and their events in a single transaction
      await this.withTransaction(
        `Processing blocks ${blockNumber} to ${chunkEndBlock} and their events`,
        async (client) => {
          const insertStart = Date.now();

          // Batch insert all blocks
          if (blocks.length > 0) {
            const values = blocks
              .map((block) => {
                const timestamp =
                  typeof block.timestamp === 'number'
                    ? block.timestamp * 1000
                    : new Date(block.timestamp).getTime();
                return `(${block.block_number}, '${block.block_hash}', '${block.parent_hash}', ${timestamp})`;
              })
              .join(',');

            await client.query(`
              INSERT INTO blocks (number, hash, parent_hash, timestamp)
              VALUES ${values}
              ON CONFLICT (number) DO UPDATE
              SET hash = EXCLUDED.hash, 
                  parent_hash = EXCLUDED.parent_hash, 
                  timestamp = EXCLUDED.timestamp, 
                  is_canonical = TRUE
            `);

            this.logger.info(
              `[${TAG}] Inserted ${blocks.length} blocks in ${Date.now() - insertStart}ms`
            );
            const eventsStart = Date.now();

            if (blocks.length < chunkSize) {
              const blockRanges = groupConsecutiveBlocks(blocks.map((block) => block.block_number));
              for (const range of blockRanges) {
                await this.processBlockEvents(range.from, range.to, client);
              }
            } else {
              await this.processBlockEvents(blockNumber, chunkEndBlock, client);
            }
            this.logger.info(`[${TAG}] Events processed in ${Date.now() - eventsStart}ms`);
          } else {
            this.logger.info(
              `[${TAG}] Skipping blocks ${blockNumber} to ${chunkEndBlock} - already processed`
            );
          }
        }
      );
    }
  }

  private async processBlockEvents(fromBlock: number, toBlock: number, client: PoolClient) {
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
          const events = await this.fetchEvents(fromBlock, toBlock);
          if (!events || events.length === 0) {
            throw new Error(`No events returned for blocks ${fromBlock} to ${toBlock}`);
          }
          return events;
        }
      );

      const fetchDuration = Date.now() - fetchStart;

      if (!blockEvents || blockEvents.length === 0) {
        this.logger.error(`No events found for block #${fromBlock} to #${toBlock}`);
        return;
      }

      this.logger.info(`[${TAG}] Fetched ${blockEvents.length} events in ${fetchDuration}ms`);

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

        let handlerConfigs: EventHandlerConfig[] = [];

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
                this.logger.debug(`Parsed event values:`, parsedValues);
              }
            } catch (error) {
              this.logger.error(`Error parsing event from contract ${fromAddress}:`, error);
              throw error; // Rethrow to trigger rollback
            }
          }

          for (const { handler } of handlerConfigs) {
            try {
              await handler(parsedEvent, client, this);
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

  private async insertBlock(
    blockData: {
      block_number: number;
      block_hash: string;
      parent_hash: string;
      timestamp: number;
    },
    client: PoolClient
  ) {
    let timestamp;
    if (typeof blockData.timestamp === 'number') {
      timestamp = blockData.timestamp * 1000;
    } else {
      timestamp = new Date(blockData.timestamp).getTime();
    }

    await client.query(
      `
        INSERT INTO blocks (number, hash, parent_hash, timestamp)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (number) DO UPDATE
        SET hash = $2, parent_hash = $3, timestamp = $4, is_canonical = TRUE
      `,
      [blockData.block_number, blockData.block_hash, blockData.parent_hash, timestamp]
    );
  }

  private async withExponentialBackoff<T>(
    operation: string,
    fn: () => Promise<T>,
    maxRetries: number = 5,
    initialDelay: number = 500
  ): Promise<T | undefined> {
    let retries = 0;
    let delay = initialDelay;

    while (retries < maxRetries) {
      try {
        return await fn();
      } catch (error) {
        retries++;
        if (retries === maxRetries) {
          this.logger.error(`${operation} failed after ${maxRetries} retries:`, error);
          return undefined;
        }

        this.logger.warn(
          `${operation} failed, retrying in ${delay}ms (attempt ${retries}/${maxRetries}):`,
          error
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 30000); // Double the delay, max 30 seconds
      }
    }

    return undefined;
  }

  private async checkIsBlockProcessed(blockNumber: number): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT EXISTS (SELECT 1 FROM blocks WHERE number = $1) AS "exists"`,
      [blockNumber]
    );
    return result.rows[0].exists;
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
}
