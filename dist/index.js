"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StarknetIndexer = void 0;
const starknet_1 = require("starknet");
const pg_1 = require("pg");
// Main indexer class
class StarknetIndexer {
    constructor(config) {
        this.config = config;
        this.eventHandlers = new Map();
        this.started = false;
        // Create PostgreSQL connection pool
        this.pool = new pg_1.Pool({
            connectionString: config.databaseUrl
        });
        // Create WebSocket channel
        this.wsChannel = new starknet_1.WebSocketChannel({
            nodeUrl: config.nodeUrl
        });
        // Setup event handlers
        this.setupEventHandlers();
    }
    setupEventHandlers() {
        // Handle new block heads
        this.wsChannel.onNewHeads = async (data) => {
            console.log('New block received:', data);
            try {
                await this.processNewHead(data.result);
            }
            catch (error) {
                console.error('Error processing new head:', error);
            }
        };
        // Handle events
        this.wsChannel.onEvents = async (data) => {
            console.log('Events received:', data);
            try {
                await this.processEvents(data.result);
            }
            catch (error) {
                console.error('Error processing events:', error);
            }
        };
        // Handle reorgs
        this.wsChannel.onReorg = async (data) => {
            console.log('Reorg detected:', data);
            // Get the starting block number from the reorg data
            const reorgPoint = data.result?.starting_block_number;
            if (reorgPoint) {
                await this.handleReorg(reorgPoint);
            }
        };
        // Handle connection errors
        this.wsChannel.onError = (error) => {
            console.error('WebSocket error:', error);
            // Reconnection is handled automatically by the library
        };
        // Handle connection closure
        this.wsChannel.onClose = (event) => {
            console.log('WebSocket connection closed:', event);
            if (this.started) {
                console.log('Attempting to reconnect...');
                this.wsChannel.reconnect();
            }
        };
    }
    // Initialize the database schema
    async initializeDatabase() {
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
            let startingBlock;
            if (result.rows.length === 0) {
                // Initialize with starting block if specified
                startingBlock = this.config.startingBlockNumber || 0;
                await client.query(`
          INSERT INTO indexer_state (last_block_number) VALUES ($1)
        `, [startingBlock]);
            }
            else {
                startingBlock = result.rows[0].last_block_number;
            }
            console.log(`Database schema initialized. Starting from block ${startingBlock}`);
            return startingBlock;
        }
        finally {
            client.release();
        }
    }
    // Register an event handler for a specific contract address and event key
    onEvent(fromAddress, eventKey, handler) {
        const key = `${fromAddress}:${eventKey}`;
        if (!this.eventHandlers.has(key)) {
            this.eventHandlers.set(key, []);
        }
        this.eventHandlers.get(key)?.push(handler);
    }
    // Start the indexer
    async start() {
        console.log('Starting Starknet WebSocket indexer...');
        // Initialize database
        const startingBlock = await this.initializeDatabase();
        // Wait for connection to establish
        await this.wsChannel.waitForConnection();
        console.log('Connected to Starknet WebSocket');
        // Subscribe to new block heads
        try {
            const newHeadsSubId = await this.wsChannel.subscribeNewHeads();
            console.log('Subscribed to new heads with ID:', newHeadsSubId);
            // Subscribe to events based on registered handlers
            await this.subscribeToEvents();
            this.started = true;
            console.log('Indexer started successfully');
        }
        catch (error) {
            console.error('Error subscribing to events:', error);
            throw error;
        }
    }
    // Subscribe to events based on registered handlers
    async subscribeToEvents() {
        // Group by from_address for efficiency
        const addressMap = new Map();
        for (const key of this.eventHandlers.keys()) {
            const [address, eventKey] = key.split(':');
            if (!addressMap.has(address)) {
                addressMap.set(address, []);
            }
            addressMap.get(address)?.push(eventKey);
        }
        // Subscribe for each address
        for (const [address, eventKeys] of addressMap.entries()) {
            const keys = eventKeys.map(key => [key]);
            try {
                // Use subscribeEventsUnmanaged for multiple subscriptions
                const subId = await this.wsChannel.subscribeEventsUnmanaged(address, keys);
                console.log(`Subscribed to events from ${address} with ID:`, subId);
            }
            catch (error) {
                console.error(`Error subscribing to events for address ${address}:`, error);
                // Continue with other subscriptions
            }
        }
    }
    // Process a new block head
    async processNewHead(blockData) {
        console.log(`Processing block #${blockData.block_number}, hash: ${blockData.block_hash}`);
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            // Convert timestamp to a valid format
            let timestamp;
            if (typeof blockData.timestamp === 'number') {
                timestamp = blockData.timestamp * 1000; // Convert to milliseconds if in seconds
            }
            else {
                // Try to parse it if it's a string
                timestamp = new Date(blockData.timestamp).getTime();
            }
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
            // Update indexer state
            await client.query(`
        UPDATE indexer_state 
        SET last_block_number = $1, last_block_hash = $2
        WHERE id = 1
      `, [blockData.block_number, blockData.block_hash]);
            await client.query('COMMIT');
        }
        catch (error) {
            await client.query('ROLLBACK');
            console.error('Failed to process block:', error);
        }
        finally {
            client.release();
        }
    }
    // Process events
    async processEvents(data) {
        const events = data.events || [];
        const blockNumber = data.block_number;
        console.log(`Processing ${events.length} events from block #${blockNumber}`);
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            for (const event of events) {
                // Insert the event
                const eventResult = await client.query(`
          INSERT INTO events (
            block_number, 
            transaction_hash, 
            from_address, 
            event_index, 
            keys, 
            data
          ) VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id
        `, [
                    blockNumber,
                    event.transaction_hash,
                    event.from_address,
                    event.event_index || 0,
                    event.keys || [],
                    event.data || []
                ]);
                // Call appropriate event handlers
                for (const key of event.keys || []) {
                    const handlerKey = `${event.from_address}:${key}`;
                    const handlers = this.eventHandlers.get(handlerKey) || [];
                    for (const handler of handlers) {
                        try {
                            await handler(event, client);
                        }
                        catch (error) {
                            console.error(`Error in event handler for ${handlerKey}:`, error);
                            // Continue processing other handlers
                        }
                    }
                }
            }
            await client.query('COMMIT');
        }
        catch (error) {
            await client.query('ROLLBACK');
            console.error('Failed to process events:', error);
        }
        finally {
            client.release();
        }
    }
    // Handle chain reorgs
    async handleReorg(forkBlockNumber) {
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
        }
        catch (error) {
            await client.query('ROLLBACK');
            console.error('Failed to handle reorg:', error);
        }
        finally {
            client.release();
        }
    }
    // Stop the indexer
    async stop() {
        console.log('Stopping indexer...');
        this.started = false;
        // Unsubscribe from all subscriptions
        try {
            for (const [type, subId] of this.wsChannel.subscriptions.entries()) {
                try {
                    if (type === 'newHeads') {
                        await this.wsChannel.unsubscribeNewHeads();
                    }
                    else if (type === 'events') {
                        await this.wsChannel.unsubscribeEvents();
                    }
                    else {
                        await this.wsChannel.unsubscribe(subId);
                    }
                }
                catch (error) {
                    console.error(`Error unsubscribing from ${type}:`, error);
                }
            }
        }
        catch (error) {
            console.error('Error unsubscribing:', error);
        }
        // Disconnect WebSocket
        try {
            this.wsChannel.disconnect();
        }
        catch (error) {
            console.error('Error disconnecting WebSocket:', error);
        }
        // Close database pool
        try {
            await this.pool.end();
        }
        catch (error) {
            console.error('Error closing database pool:', error);
        }
        console.log('Indexer stopped');
    }
}
exports.StarknetIndexer = StarknetIndexer;
