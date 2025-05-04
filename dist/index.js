"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StarknetIndexer = void 0;
const starknet_1 = require("starknet");
const pg_1 = require("pg");
class StarknetIndexer {
    constructor(config) {
        this.config = config;
        this.eventHandlers = new Map();
        this.started = false;
        this.eventQueue = [];
        this.isProcessingQueue = false;
        this.contractAddresses = new Set();
        this.pool = new pg_1.Pool({
            connectionString: config.databaseUrl
        });
        this.wsChannel = new starknet_1.WebSocketChannel({
            nodeUrl: config.wsNodeUrl
        });
        this.maxConcurrentEvents = config.maxConcurrentEvents || 5;
        if (config.contractAddresses) {
            config.contractAddresses.forEach(address => {
                this.contractAddresses.add((0, starknet_1.validateAndParseAddress)(address).toLowerCase());
            });
        }
        if (config.rpcNodeUrl) {
            try {
                this.provider = new starknet_1.RpcProvider({ nodeUrl: config.rpcNodeUrl, specVersion: '0.8' });
            }
            catch (error) {
                console.warn('Failed to initialize RPC provider:', error);
            }
        }
        this.setupEventHandlers();
    }
    setupEventHandlers() {
        // Handle new block heads
        this.wsChannel.onNewHeads = async (data) => {
            console.log('New block received:', data.result.block_number);
            try {
                const blockNumber = data.result.block_number;
                // Store block data
                await this.processNewHead({
                    block_number: blockNumber,
                    block_hash: data.result.block_hash,
                    parent_hash: data.result.parent_hash,
                    timestamp: data.result.timestamp
                });
                // If we have a provider, fetch the block with receipts to get the transactions
                if (this.provider) {
                    await this.processBlockTransactions(blockNumber);
                }
            }
            catch (error) {
                console.error('Error processing new head:', error);
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
        this.wsChannel.onClose = async (event) => {
            console.log('WebSocket connection closed:', event);
            if (this.started) {
                console.log('Attempting to reconnect...');
                try {
                    await this.wsChannel.reconnect();
                    // After reconnection, resubscribe to new heads
                    await this.wsChannel.subscribeNewHeads();
                    console.log('Successfully reconnected and resubscribed to new heads');
                }
                catch (error) {
                    console.error('Failed to reconnect:', error);
                }
            }
        };
    }
    // Process block transactions and extract events
    async processBlockTransactions(blockNumber) {
        if (!this.provider)
            return;
        try {
            console.log(`Fetching block ${blockNumber} with receipts`);
            const blockWithReceipts = await this.provider.getBlockWithReceipts(blockNumber);
            if (!blockWithReceipts || !blockWithReceipts.transactions) {
                console.log(`No transactions found in block ${blockNumber}`);
                return;
            }
            console.log(`Processing ${blockWithReceipts.transactions.length} transactions in block ${blockNumber}`);
            // Process each transaction's events
            for (const txWithReceipt of blockWithReceipts.transactions) {
                const receipt = txWithReceipt.receipt;
                if (!receipt.events || receipt.events.length === 0)
                    continue;
                // Process each event in the transaction
                for (let eventIndex = 0; eventIndex < receipt.events.length; eventIndex++) {
                    const event = receipt.events[eventIndex];
                    const fromAddress = (0, starknet_1.validateAndParseAddress)(event.from_address).toLowerCase();
                    if (this.contractAddresses.size > 0 && !this.contractAddresses.has(fromAddress)) {
                        continue;
                    }
                    // Create a standardized event object
                    const eventObj = {
                        block_number: blockNumber,
                        transaction_hash: receipt.transaction_hash,
                        from_address: fromAddress,
                        event_index: eventIndex,
                        keys: event.keys,
                        data: event.data
                    };
                    console.log("eventObj", eventObj);
                    // Find handlers for this event
                    await this.processEvent(eventObj);
                }
            }
        }
        catch (error) {
            console.error(`Error processing block ${blockNumber} transactions:`, error);
        }
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
    onEvent(fromAddress, arg1, arg2) {
        let eventKey;
        let handler;
        if (typeof arg2 === 'function') {
            eventKey = arg1;
            handler = arg2;
        }
        else {
            handler = arg1;
        }
        // Normalize address to lowercase
        const normalizedAddress = (0, starknet_1.validateAndParseAddress)(fromAddress).toLowerCase();
        // Add to contract addresses set
        this.contractAddresses.add(normalizedAddress);
        const key = eventKey ? `${normalizedAddress}:${eventKey}` : normalizedAddress;
        console.log(`Registering handler for key: ${key}`);
        if (!this.eventHandlers.has(key)) {
            this.eventHandlers.set(key, []);
        }
        this.eventHandlers.get(key)?.push(handler);
        // Log all registered handlers
        console.log('Current registered handlers:', Array.from(this.eventHandlers.entries()).map(([k, h]) => ({
            key: k,
            handlerCount: h.length
        })));
    }
    // Start the indexer
    async start() {
        const startingBlock = await this.initializeDatabase() || 0;
        // Get current block number if RPC is available
        const currentBlock = this.provider ? await this.provider.getBlockNumber() : 0;
        const targetBlock = this.config.startingBlockNumber || 0;
        // Connect to WebSocket first
        try {
            await this.wsChannel.waitForConnection();
            console.log('WebSocket connection established');
        }
        catch (error) {
            console.error('Failed to establish WebSocket connection:', error);
            throw error;
        }
        // Fetch historical events if needed
        const shouldFetchHistorical = targetBlock < currentBlock &&
            (this.config.fetchHistoricalEvents !== false) &&
            this.provider;
        if (shouldFetchHistorical && this.provider) {
            console.log(`Fetching historical blocks from ${targetBlock} to ${currentBlock}...`);
            try {
                // First fetch and insert all blocks
                console.log('Fetching historical blocks...');
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
                            // Process transactions in this block
                            await this.processBlockTransactions(blockNumber);
                        }
                    }
                    catch (error) {
                        console.error(`Error fetching block ${blockNumber}:`, error);
                    }
                }
                console.log('Historical blocks fetched and processed');
            }
            catch (error) {
                console.warn('Failed to fetch historical events:', error);
            }
        }
        // Subscribe to new heads
        try {
            await this.wsChannel.subscribeNewHeads();
            this.started = true;
            console.log('Indexer started successfully and subscribed to new blocks');
        }
        catch (error) {
            console.error('Failed to subscribe to new heads:', error);
            throw error;
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
            // Check if block already exists
            const existingBlock = await client.query('SELECT 1 FROM blocks WHERE number = $1', [blockData.block_number]);
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
            }
            else {
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
            // After block is added, schedule queue processing
            if (this.eventQueue.length > 0) {
                console.log(`Block ${blockData.block_number} added, scheduling processing of ${this.eventQueue.length} queued events`);
                setImmediate(() => this.processEventQueue());
            }
        }
        catch (error) {
            await client.query('ROLLBACK');
            console.error('Failed to process block:', error);
        }
        finally {
            client.release();
        }
    }
    // Process a single event
    async processEvent(event) {
        const blockNumber = event.block_number;
        if (!blockNumber) {
            console.error('Invalid event data structure:', event);
            return;
        }
        // Get handlers for this address
        const normalizedAddress = event.from_address.toLowerCase();
        let handlers = [];
        // Check for handlers for this address (with or without event key)
        if (event.keys && event.keys.length > 0) {
            const eventKey = event.keys[0];
            const specificHandlerKey = `${normalizedAddress}:${eventKey}`;
            const specificHandlers = this.eventHandlers.get(specificHandlerKey) || [];
            handlers = [...specificHandlers];
        }
        // Also get general handlers for this address
        const generalHandlers = this.eventHandlers.get(normalizedAddress) || [];
        handlers = [...handlers, ...generalHandlers];
        if (handlers.length > 0) {
            console.log(`Found ${handlers.length} handlers for event from ${event.from_address}, enqueueing`);
            this.enqueueEvent(event, handlers);
        }
        else {
            console.log(`No handlers found for event from ${event.from_address}, skipping`);
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
    async processEventQueue() {
        if (this.isProcessingQueue || this.eventQueue.length === 0) {
            return;
        }
        this.isProcessingQueue = true;
        const client = await this.pool.connect();
        try {
            const eventsToProcess = [...this.eventQueue];
            this.eventQueue = []; // Clear the queue before processing
            console.log(`Processing ${eventsToProcess.length} events from queue`);
            while (eventsToProcess.length > 0) {
                const batch = eventsToProcess.splice(0, this.maxConcurrentEvents);
                await client.query('BEGIN');
                try {
                    for (const { event, handlers } of batch) {
                        // First, ensure the block exists
                        const blockResult = await client.query('SELECT 1 FROM blocks WHERE number = $1', [event.block_number]);
                        if (blockResult.rows.length === 0) {
                            // Block doesn't exist yet, put the event back in the queue
                            this.eventQueue.push({
                                event,
                                handlers,
                                timestamp: Date.now()
                            });
                            continue;
                        }
                        // Process all handlers for the event
                        for (const handler of handlers) {
                            try {
                                await handler(event, client);
                            }
                            catch (error) {
                                console.error(`Error processing event handler:`, error);
                                // Continue with other handlers even if one fails
                            }
                        }
                    }
                    await client.query('COMMIT');
                }
                catch (error) {
                    await client.query('ROLLBACK');
                    console.error(`Error processing event batch:`, error);
                    // Put the failed batch back in the queue
                    this.eventQueue.push(...batch);
                }
            }
        }
        finally {
            client.release();
            this.isProcessingQueue = false;
            // If there are still events in the queue, schedule next processing
            if (this.eventQueue.length > 0) {
                console.log(`${this.eventQueue.length} events still in queue, scheduling next processing`);
                setTimeout(() => this.processEventQueue(), 1000); // Wait 1 second before retrying
            }
        }
    }
    enqueueEvent(event, handlers) {
        this.eventQueue.push({
            event,
            handlers,
            timestamp: Date.now()
        });
        // Start processing if not already processing
        if (!this.isProcessingQueue) {
            setImmediate(() => this.processEventQueue());
        }
    }
}
exports.StarknetIndexer = StarknetIndexer;
