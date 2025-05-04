import { WebSocketChannel, RpcProvider, validateAndParseAddress, CallData, events, Abi, hash } from 'starknet';
import { Pool, PoolClient } from 'pg';

export interface IndexerConfig {
  wsNodeUrl: string;
  rpcNodeUrl?: string | undefined;
  databaseUrl: string;
  startingBlockNumber?: number;
  contractAddresses?: string[];
}

export type EventHandler = (event: any, client: PoolClient, indexer: StarknetIndexer) => Promise<void>;

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
  
  constructor(private config: IndexerConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl
    });
    
    this.wsChannel = new WebSocketChannel({
      nodeUrl: config.wsNodeUrl
    });

    if (config.contractAddresses) {
      config.contractAddresses.forEach(address => {
        this.contractAddresses.add(validateAndParseAddress(address).toLowerCase());
      });
    }

    if (config.rpcNodeUrl) {
      try {
        this.provider = new RpcProvider({ nodeUrl: config.rpcNodeUrl, specVersion: '0.8' });
      } catch (error) {
        console.warn('Failed to initialize RPC provider:', error);
      }
    }
    
    this.setupEventHandlers();
  }
  
  private setupEventHandlers() {
    // Handle new block heads
    this.wsChannel.onNewHeads = async (data) => {
      try {
        const blockData = {
          block_number: data.result.block_number,
          block_hash: data.result.block_hash,
          parent_hash: data.result.parent_hash,
          timestamp: data.result.timestamp
        };
        
        // If we're processing historical blocks, queue the new block
        if (this.isProcessingBlocks) {
          this.blockQueue.push(blockData);
        } else {
          // Otherwise process it immediately
          await this.processNewHead(blockData);
          if (this.provider) {
            await this.processBlockTransactions(blockData.block_number);
          }
        }
      } catch (error) {
        console.error('Error processing new head:', error);
      }
    };
    
    // Handle reorgs
    this.wsChannel.onReorg = async (data) => {
      const reorgPoint = data.result?.starting_block_number;
      
      if (reorgPoint) {
        await this.handleReorg(reorgPoint);
      }
    };
    
    // Handle connection errors
    this.wsChannel.onError = (error) => {
      console.error('WebSocket error:', error);
    };
    
    // Handle connection closure
    this.wsChannel.onClose = async (event) => {
      if (this.started) {
        try {
          await this.wsChannel.reconnect();
          await this.wsChannel.subscribeNewHeads();
        } catch (error) {
          console.error('Failed to reconnect:', error);
        }
      }
    };
  }
  
  private getEventSelector(eventName: string): string {
    const cleanName = eventName.includes('::') 
      ? eventName.split('::').pop() 
      : eventName;
    if (!cleanName) {
      throw new Error(`Invalid event name: ${eventName}`);
    }
    return hash.getSelectorFromName(cleanName);
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
          const fromAddress = validateAndParseAddress(event.from_address).toLowerCase();

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
            data: event.data
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
                  const parsedEventWithOriginal = {
                    ...parsedEvents[0],
                    _rawEvent: eventObj,
                    block_number: eventObj.block_number,
                    block_hash: eventObj.block_hash,
                    transaction_hash: eventObj.transaction_hash,
                    from_address: eventObj.from_address,
                    event_index: eventObj.event_index,
                    keys: eventObj.keys,
                    data: eventObj.data
                  };
                  parsedEvent = parsedEventWithOriginal;
                }
              } catch (error) {
                console.error(`Error parsing event:`, error);
              }
            }

            for (const { handler } of handlerConfigs) {
              try {
                await handler(parsedEvent, await this.pool.connect(), this);
              } catch (error) {
                console.error(`Error processing event handler:`, error);
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error processing block ${blockNumber} transactions:`, error);
    }
  }
  
  // Initialize the database schema
  public async initializeDatabase(): Promise<number | undefined> {
    console.log('Initializing database schema...');
    const client = await this.pool.connect();
    try {
      // Create tables if they don't exist
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
          CONSTRAINT singleton CHECK (id = 1)
        );
        
        CREATE INDEX IF NOT EXISTS idx_events_block ON events(block_number);
        CREATE INDEX IF NOT EXISTS idx_events_from ON events(from_address);
      `);
      
      // Get the last indexed block number
      const result = await client.query(`
        SELECT last_block_number FROM indexer_state WHERE id = 1
      `);
      
      let startingBlock: number | undefined;
      
      if (result.rows.length === 0) {
        // Initialize with starting block if specified
        startingBlock = this.config.startingBlockNumber || 0;
        await client.query(`
          INSERT INTO indexer_state (last_block_number) VALUES ($1)
        `, [startingBlock]);
      } else {
        startingBlock = result.rows[0].last_block_number;
      }
      
      console.log(`Database schema initialized. Starting from block ${startingBlock}`);
      return startingBlock;
    } finally {
      client.release();
    }
  }
  
  // Get the ABI for a contract address and cache it
  private async getContractABI(address: string): Promise<any> {
    if (!this.provider) {
      console.warn('No RPC provider available to fetch ABI');
      return undefined;
    }

    const normalizedAddress = validateAndParseAddress(address).toLowerCase();
    
    // Return cached ABI if available
    if (this.abiMapping.has(normalizedAddress)) {
      return this.abiMapping.get(normalizedAddress);
    }

    try {
      const contractClass = await this.provider.getClassAt(normalizedAddress);
      const abi = contractClass.abi;
      this.abiMapping.set(normalizedAddress, abi);
      console.log(`Cached ABI for contract ${normalizedAddress}`);
      return abi;
    } catch (error) {
      console.warn(`Failed to fetch ABI for contract ${normalizedAddress}:`, error);
      return undefined;
    }
  }
  
  // Register an event handler for a contract address with optional event name
  public onEvent(params: EventHandlerParams): void {
    const { contractAddress, eventName, handler } = params;

    // Validate and normalize the contract address
    const normalizedAddress = validateAndParseAddress(contractAddress).toLowerCase();
    
    // Add to contract addresses set for filtering
    this.contractAddresses.add(normalizedAddress);
    
    // Create handler config
    const handlerConfig: EventHandlerConfig = {
      handler
    };
    
    // Create the handler key using event selector if eventName is provided
    const handlerKey = eventName 
      ? `${normalizedAddress}:${this.getEventSelector(eventName)}` 
      : normalizedAddress;
    
    // Initialize the handlers array if it doesn't exist
    if (!this.eventHandlers.has(handlerKey)) {
      this.eventHandlers.set(handlerKey, []);
    }
    
    // Add the handler to the array
    const handlers = this.eventHandlers.get(handlerKey)!;
    handlers.push(handlerConfig);

    // Fetch and cache the ABI for this contract
    this.getContractABI(normalizedAddress).catch(error => {
      console.error(`Failed to fetch ABI for contract ${normalizedAddress}:`, error);
    });
  }
  
  // Start the indexer
  public async start(): Promise<void> {
    const startingBlock = await this.initializeDatabase() || 0;
    
    // Get current block number if RPC is available
    const currentBlock = this.provider ? await this.provider.getBlockNumber() : 0;
    const targetBlock = this.config.startingBlockNumber || 0;
    
    // Connect to WebSocket first
    try {
      await this.wsChannel.waitForConnection();
    } catch (error) {
      console.error('Failed to establish WebSocket connection:', error);
      throw error;
    }
    
    // Subscribe to new heads immediately
    try {
      await this.wsChannel.subscribeNewHeads();
      this.started = true;
    } catch (error) {
      console.error('Failed to subscribe to new heads:', error);
      throw error;
    }
    
    // Process historical blocks if needed
    if (targetBlock < currentBlock && this.provider) {
      this.isProcessingBlocks = true;
      
      try {
        for (let blockNumber = targetBlock; blockNumber <= currentBlock; blockNumber++) {
          try {
            const block = await this.provider.getBlock(blockNumber);
            if (block) {
              await this.processNewHead({
                block_number: blockNumber,
                block_hash: block.block_hash,
                parent_hash: block.parent_hash,
                timestamp: block.timestamp
              });
              
              await this.processBlockTransactions(blockNumber);
            }
          } catch (error) {
            console.error(`Error fetching block ${blockNumber}:`, error);
          }
        }
      } catch (error) {
        console.warn('Failed to fetch historical blocks:', error);
      }
      
      // Process any queued blocks
      this.isProcessingBlocks = false;
      await this.processBlockQueue();
    }
  }
  
  // Process a new block head
  private async processNewHead(blockData: any): Promise<void> {
    console.log(`Processing block #${blockData.block_number}, hash: ${blockData.block_hash}`);
    
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      
      // Convert timestamp to a valid format
      let timestamp;
      if (typeof blockData.timestamp === 'number') {
        timestamp = blockData.timestamp * 1000; // Convert to milliseconds if in seconds
      } else {
        // Try to parse it if it's a string
        timestamp = new Date(blockData.timestamp).getTime();
      }
      
      // Check if block already exists
      const existingBlock = await client.query(
        'SELECT 1 FROM blocks WHERE number = $1',
        [blockData.block_number]
      );

      if (existingBlock.rows.length === 0) {
        console.log(`Inserting new block #${blockData.block_number}`);
        // Insert the block
        await client.query(`
          INSERT INTO blocks (number, hash, parent_hash, timestamp)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (number) DO UPDATE
          SET hash = $2, parent_hash = $3, timestamp = $4, is_canonical = TRUE
        `, [
          blockData.block_number,
          blockData.block_hash,
          blockData.parent_hash,
          timestamp
        ]);
      } else {
        console.log(`Block #${blockData.block_number} already exists`);
      }
      
      // Update indexer state
      await client.query(`
        UPDATE indexer_state 
        SET last_block_number = $1, last_block_hash = $2
        WHERE id = 1
      `, [blockData.block_number, blockData.block_hash]);
      
      await client.query('COMMIT');
      console.log(`Successfully processed block #${blockData.block_number}`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Failed to process block:', error);
    } finally {
      client.release();
    }
  }
  
  // Handle chain reorgs
  public async handleReorg(forkBlockNumber: number): Promise<void> {
    console.log(`Handling reorg from block #${forkBlockNumber}`);
    
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      
      // Mark affected blocks as non-canonical
      await client.query(`
        UPDATE blocks
        SET is_canonical = FALSE
        WHERE number >= $1
      `, [forkBlockNumber]);
      
      // Update indexer state if needed
      await client.query(`
        UPDATE indexer_state
        SET last_block_number = $1
        WHERE id = 1 AND last_block_number >= $1
      `, [forkBlockNumber - 1]);
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Failed to handle reorg:', error);
    } finally {
      client.release();
    }
  }
  
  // Stop the indexer
  public async stop(): Promise<void> {
    console.log('Stopping indexer...');
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
          console.error(`Error unsubscribing from ${type}:`, error);
        }
      }
    } catch (error) {
      console.error('Error unsubscribing:', error);
    }
    
    // Disconnect WebSocket
    try {
      this.wsChannel.disconnect();
    } catch (error) {
      console.error('Error disconnecting WebSocket:', error);
    }
    
    // Close database pool
    try {
      await this.pool.end();
    } catch (error) {
      console.error('Error closing database pool:', error);
    }
    
    console.log('Indexer stopped');
  }

  private async processBlockQueue(): Promise<void> {
    if (this.blockQueue.length === 0) return;
    
    const blocksToProcess = [...this.blockQueue];
    this.blockQueue = [];
    
    for (const block of blocksToProcess) {
      try {
        await this.processNewHead(block);
        if (this.provider) {
          await this.processBlockTransactions(block.block_number);
        }
      } catch (error) {
        console.error(`Error processing queued block ${block.block_number}:`, error);
      }
    }
  }
}