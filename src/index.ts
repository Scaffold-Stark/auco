import {
  WebSocketChannel,
  RpcProvider,
  validateAndParseAddress,
  CallData,
  events,
  hash,
  EmittedEvent,
} from 'starknet';
import { Pool, PoolClient } from 'pg';

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
  wsNodeUrl: string;
  rpcNodeUrl?: string | undefined;
  databaseUrl: string;
  startingBlockNumber?: number;
  contractAddresses?: string[];
  cursorKey?: string;
  logLevel?: LogLevel;
  logger?: Logger;
}

export type EventHandler = (
  event: any,
  client: PoolClient,
  indexer: StarknetIndexer
) => Promise<void>;

interface EventHandlerConfig {
  handler: EventHandler;
}

interface QueuedBlock {
  block_number: number;
  block_hash: string;
  parent_hash: string;
  timestamp: number;
}

interface EventHandlerParams {
  contractAddress: string;
  eventName?: string;
  handler: EventHandler;
}

interface Cursor {
  blockNumber: number;
  blockHash: string;
}

export class StarknetIndexer {
  private wsChannel: WebSocketChannel;
  private pool: Pool;
  private eventHandlers: Map<string, EventHandlerConfig[]> = new Map();
  private started: boolean = false;
  private provider?: RpcProvider;
  private blockQueue: QueuedBlock[] = [];
  private isProcessingBlocks: boolean = false;
  private contractAddresses: Set<string> = new Set();
  private abiMapping: Map<string, any> = new Map();
  private cursor: Cursor | null = null;
  private logger: Logger;

  constructor(private config: IndexerConfig) {
    this.logger = config.logger || new ConsoleLogger(config.logLevel);

    this.pool = new Pool({
      connectionString: config.databaseUrl,
    });

    this.wsChannel = new WebSocketChannel({
      nodeUrl: config.wsNodeUrl,
    });

    if (config.contractAddresses) {
      config.contractAddresses.forEach((address) => {
        this.contractAddresses.add(this.normalizeAddress(address));
      });
    }

    if (config.rpcNodeUrl) {
      try {
        this.provider = new RpcProvider({ nodeUrl: config.rpcNodeUrl, specVersion: '0.8' });
      } catch (error) {
        this.logger.error('Failed to initialize RPC provider:', error);
      }
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

          if (this.isProcessingBlocks) {
            this.logger.info(`Queuing block #${blockData.block_number} for later processing`);
            this.blockQueue.push(blockData);
          } else {
            if (!this.cursor || blockData.block_number > this.cursor.blockNumber) {
              this.logger.info(`Processing new block #${blockData.block_number}`);
              await this.processNewHead(blockData);
            } else {
              this.logger.debug(`Skipping block #${blockData.block_number} - already processed`);
            }
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

    this.wsChannel.onClose = async () => {
      if (this.started) {
        this.logger.info('Connection closed, attempting to reconnect...');
        await this.withErrorHandling('Reconnecting WebSocket', async () => {
          await this.wsChannel.reconnect();
          await this.wsChannel.subscribeNewHeads();
          this.logger.info('Successfully reconnected');
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

  private async validateEventName(contractAddress: string, eventName: string): Promise<boolean> {
    const abi = await this.getContractABI(contractAddress);
    if (!abi) {
      this.logger.error(`No ABI found for contract ${contractAddress}`);
      return false;
    }

    for (const item of abi) {
      if (item.type !== 'event') continue;

      const fullName = item.name;
      const cleanEventName = fullName.split('::').pop() || '';

      if (cleanEventName.toLowerCase() === eventName.toLowerCase()) {
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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      this.logger.error(`${operation} failed:`, { ...context, error });
      return undefined;
    } finally {
      client.release();
    }
  }

  // Process block transactions and extract events
  private async processBlockTransactions(blockNumber: number): Promise<void> {
    if (!this.provider) return;

    try {
      const blockWithReceipts = await this.provider.getBlockWithReceipts(blockNumber);

      if (!blockWithReceipts || !blockWithReceipts.transactions) {
        return;
      }

      for (const txWithReceipt of blockWithReceipts.transactions) {
        const receipt = txWithReceipt.receipt;

        if (!receipt.events || receipt.events.length === 0) continue;

        for (let eventIndex = 0; eventIndex < receipt.events.length; eventIndex++) {
          const event = receipt.events[eventIndex];
          const fromAddress = this.normalizeAddress(event.from_address);

          if (this.contractAddresses.size > 0 && !this.contractAddresses.has(fromAddress)) {
            continue;
          }

          const eventObj = {
            block_number: blockNumber,
            block_hash: (blockWithReceipts as any).block_hash || '',
            transaction_hash: receipt.transaction_hash,
            from_address: fromAddress,
            event_index: eventIndex,
            keys: event.keys,
            data: event.data,
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

                const parsedEvents = events.parseEvents(
                  [eventObj],
                  abiEvents,
                  abiStructs,
                  abiEnums
                );

                if (parsedEvents && parsedEvents.length > 0) {
                  // Get the first key of the parsed event (the event name)
                  const eventKey = Object.keys(parsedEvents[0])[0];
                  const parsedValues = parsedEvents[0][eventKey];

                  const parsedEventWithOriginal = {
                    ...parsedEvents[0],
                    _rawEvent: eventObj,
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
              }
            }

            for (const { handler } of handlerConfigs) {
              try {
                await handler(parsedEvent, await this.pool.connect(), this);
              } catch (error) {
                this.logger.error(
                  `Error processing event handler for contract ${fromAddress}:`,
                  error
                );
              }
            }
          }
        }
      }
    } catch (error) {
      this.logger.error(`Error processing block ${blockNumber} transactions:`, error);
    }
  }

  // Initialize the database schema
  public async initializeDatabase(): Promise<number | undefined> {
    const client = await this.pool.connect();
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
        const startingBlock = this.config.startingBlockNumber || 0;
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
      client.release();
    }
  }

  // Get the ABI for a contract address and cache it
  private async getContractABI(address: string): Promise<any> {
    if (!this.provider) {
      this.logger.error('No RPC provider available to fetch ABI');
      return undefined;
    }

    if (this.abiMapping.has(address)) {
      this.logger.debug(`Using cached ABI for contract ${address}`);
      return this.abiMapping.get(address);
    }

    return await this.withErrorHandling(
      'Fetching contract ABI',
      async () => {
        const contractClass = await this.provider!.getClassAt(address);
        const abi = contractClass.abi;
        this.abiMapping.set(address, abi);
        this.logger.info(`Cached ABI for contract ${address}`);
        return abi;
      },
      { address }
    );
  }

  // Register an event handler for a contract address with optional event name
  public async onEvent(params: EventHandlerParams): Promise<void> {
    const { contractAddress, eventName, handler } = params;

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
      const isValid = await this.validateEventName(normalizedAddress, eventName);
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

    await this.getContractABI(normalizedAddress);
  }

  // Start the indexer
  public async start(): Promise<void> {
    await this.initializeDatabase();
    this.logger.info(`Starting from block ${this.cursor?.blockNumber}`);

    const currentBlock = this.provider ? await this.provider.getBlockNumber() : 0;
    const targetBlock = this.config.startingBlockNumber || 0;

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
      this.logger.info(`Processing historical blocks from ${targetBlock} to ${currentBlock}`);
      this.isProcessingBlocks = true;

      await this.processHistoricalBlocks(targetBlock, currentBlock);

      this.isProcessingBlocks = false;
      this.logger.info('[Indexer] Processing queued blocks...');
      await this.processBlockQueue();
    }
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
      } else {
        this.logger.debug(`Skipping block #${blockData.block_number} - already processed`);
        return;
      }
    }

    await this.withTransaction(
      'Processing block',
      async (client) => {
        await this.insertBlock(blockData, client);

        await this.updateCursor(blockData.block_number, blockData.block_hash, client);
        this.logger.info(`Successfully processed block #${blockData.block_number}`);

        if (this.provider) {
          await this.processBlockEvents(blockData.block_number, blockData.block_number, client);
        }
      },
      { blockNumber: blockData.block_number }
    );
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

    // Unsubscribe from all subscriptions
    try {
      for (const [type, subId] of this.wsChannel.subscriptions.entries()) {
        try {
          if (type === 'newHeads') {
            await this.wsChannel.unsubscribeNewHeads();
          } else {
            await this.wsChannel.unsubscribe(subId);
          }
        } catch (error) {
          this.logger.error(`Error unsubscribing from ${type}:`, error);
        }
      }
    } catch (error) {
      this.logger.error('Error unsubscribing:', error);
    }

    // Disconnect WebSocket
    try {
      this.wsChannel.disconnect();
    } catch (error) {
      this.logger.error('Error disconnecting WebSocket:', error);
    }

    // Close database pool
    try {
      await this.pool.end();
    } catch (error) {
      this.logger.error('Error closing database pool:', error);
    }

    this.logger.info('Indexer stopped');
  }

  private async processBlockQueue(): Promise<void> {
    if (this.blockQueue.length === 0) return;

    const blocksToProcess = [...this.blockQueue];
    this.blockQueue = [];
    this.logger.info(`Processing ${blocksToProcess.length} queued blocks`);

    for (const block of blocksToProcess) {
      try {
        this.logger.info(`Processing queued block #${block.block_number}`);
        await this.processNewHead(block);
        if (this.provider) {
          await this.processBlockTransactions(block.block_number);
        }
        this.logger.info(`Successfully processed queued block #${block.block_number}`);
      } catch (error) {
        this.logger.error(`[Block] Error processing queued block ${block.block_number}:`, error);
      }
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
      //TODO (Bao): Filter events by multiple contract addresses, event keys when supported
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

    for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += chunkSize) {
      const chunkEndBlock = Math.min(blockNumber + chunkSize - 1, toBlock);

      // Pre-fetch all blocks and events before starting transaction
      const blocks: any[] = [];
      for (let currentBlock = blockNumber; currentBlock <= chunkEndBlock; currentBlock++) {
        const block = await this.provider?.getBlock(currentBlock);
        if (!block || !block.block_hash) {
          this.logger.error(`No block found for block #${currentBlock}`);
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
          }

          // Process events if we have any
          await this.processBlockEvents(blockNumber, chunkEndBlock, client);
        }
      );
    }
  }

  private async processBlockEvents(fromBlock: number, toBlock: number, client: PoolClient) {
    if (!this.provider) {
      this.logger.error('No RPC provider available to fetch ABI');
      return undefined;
    }

    try {
      const blockEvents = await this.fetchEvents(fromBlock, toBlock);

      if (!blockEvents) {
        this.logger.error(`No events found for block #${fromBlock} to #${toBlock}`);
        return;
      }

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
}
