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
        this.blockQueue = [];
        this.isProcessingBlocks = false;
        this.contractAddresses = new Set();
        this.abiMapping = new Map();
        this.cursor = null;
        this.pool = new pg_1.Pool({
            connectionString: config.databaseUrl
        });
        this.wsChannel = new starknet_1.WebSocketChannel({
            nodeUrl: config.wsNodeUrl
        });
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
                console.error('Failed to initialize RPC provider:', error);
            }
        }
        this.setupEventHandlers();
    }
    setupEventHandlers() {
        this.wsChannel.onNewHeads = async (data) => {
            try {
                const blockData = {
                    block_number: data.result.block_number,
                    block_hash: data.result.block_hash,
                    parent_hash: data.result.parent_hash,
                    timestamp: data.result.timestamp
                };
                if (this.isProcessingBlocks) {
                    console.log(`[Block] Queuing block #${blockData.block_number} for later processing`);
                    this.blockQueue.push(blockData);
                }
                else {
                    if (!this.cursor || blockData.block_number > this.cursor.blockNumber) {
                        console.log(`[Block] Processing new block #${blockData.block_number}`);
                        await this.processNewHead(blockData);
                    }
                    else {
                        console.log(`[Block] Skipping block #${blockData.block_number} - already processed`);
                    }
                }
            }
            catch (error) {
                console.error('[Block] Error processing new head:', error);
            }
        };
        this.wsChannel.onReorg = async (data) => {
            const reorgPoint = data.result?.starting_block_number;
            if (reorgPoint) {
                console.log(`[Reorg] Handling reorg from block #${reorgPoint}`);
                await this.handleReorg(reorgPoint);
            }
        };
        this.wsChannel.onError = (error) => {
            console.error('[WebSocket] Error:', error);
        };
        this.wsChannel.onClose = async (event) => {
            if (this.started) {
                console.log('[WebSocket] Connection closed, attempting to reconnect...');
                try {
                    await this.wsChannel.reconnect();
                    await this.wsChannel.subscribeNewHeads();
                    console.log('[WebSocket] Successfully reconnected');
                }
                catch (error) {
                    console.error('[WebSocket] Failed to reconnect:', error);
                }
            }
        };
    }
    getEventSelector(eventName) {
        const cleanName = eventName.includes('::')
            ? eventName.split('::').pop()
            : eventName;
        if (!cleanName) {
            throw new Error(`Invalid event name: ${eventName}`);
        }
        return starknet_1.hash.getSelectorFromName(cleanName);
    }
    async validateEventName(contractAddress, eventName) {
        const abi = await this.getContractABI(contractAddress);
        if (!abi) {
            console.error(`[ABI] No ABI found for contract ${contractAddress}`);
            return false;
        }
        for (const item of abi) {
            if (item.type !== 'event')
                continue;
            const fullName = item.name;
            const cleanEventName = fullName.split('::').pop() || '';
            if (cleanEventName.toLowerCase() === eventName.toLowerCase()) {
                console.log(`[Event] Found event "${eventName}" in contract ${contractAddress}`);
                return true;
            }
            if (item.kind === 'enum' && Array.isArray(item.variants)) {
                for (const variant of item.variants) {
                    if (variant.name?.toLowerCase() === eventName.toLowerCase()) {
                        console.log(`[Event] Found enum variant "${eventName}" in contract ${contractAddress}`);
                        return true;
                    }
                }
            }
        }
        console.error(`[Event] Event "${eventName}" not found in contract ${contractAddress} ABI`);
        return false;
    }
    // Process block transactions and extract events
    async processBlockTransactions(blockNumber) {
        if (!this.provider)
            return;
        try {
            const blockWithReceipts = await this.provider.getBlockWithReceipts(blockNumber);
            if (!blockWithReceipts || !blockWithReceipts.transactions) {
                return;
            }
            for (const txWithReceipt of blockWithReceipts.transactions) {
                const receipt = txWithReceipt.receipt;
                if (!receipt.events || receipt.events.length === 0)
                    continue;
                for (let eventIndex = 0; eventIndex < receipt.events.length; eventIndex++) {
                    const event = receipt.events[eventIndex];
                    const fromAddress = (0, starknet_1.validateAndParseAddress)(event.from_address).toLowerCase();
                    if (this.contractAddresses.size > 0 && !this.contractAddresses.has(fromAddress)) {
                        continue;
                    }
                    const eventObj = {
                        block_number: blockNumber,
                        block_hash: blockWithReceipts.block_hash || '',
                        transaction_hash: receipt.transaction_hash,
                        from_address: fromAddress,
                        event_index: eventIndex,
                        keys: event.keys,
                        data: event.data
                    };
                    let handlerConfigs = [];
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
                                const abiEvents = starknet_1.events.getAbiEvents(abi);
                                const abiStructs = starknet_1.CallData.getAbiStruct(abi);
                                const abiEnums = starknet_1.CallData.getAbiEnum(abi);
                                const parsedEvents = starknet_1.events.parseEvents([eventObj], abiEvents, abiStructs, abiEnums);
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
                            }
                            catch (error) {
                                console.error(`[Event] Error parsing event from contract ${fromAddress}:`, error);
                            }
                        }
                        for (const { handler } of handlerConfigs) {
                            try {
                                await handler(parsedEvent, await this.pool.connect(), this);
                            }
                            catch (error) {
                                console.error(`[Event] Error processing event handler for contract ${fromAddress}:`, error);
                            }
                        }
                    }
                }
            }
        }
        catch (error) {
            console.error(`[Block] Error processing block ${blockNumber} transactions:`, error);
        }
    }
    // Initialize the database schema
    async initializeDatabase() {
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
            const result = await client.query(`
        SELECT last_block_number, last_block_hash 
        FROM indexer_state 
        WHERE id = 1 AND (cursor_key IS NULL OR cursor_key = $1)
      `, [this.config.cursorKey || null]);
            if (result.rows.length === 0) {
                const startingBlock = this.config.startingBlockNumber || 0;
                this.cursor = { blockNumber: startingBlock, blockHash: '' };
                await client.query(`
          INSERT INTO indexer_state (last_block_number, last_block_hash, cursor_key) 
          VALUES ($1, $2, $3)
        `, [startingBlock, '', this.config.cursorKey || null]);
                return startingBlock;
            }
            else {
                this.cursor = {
                    blockNumber: result.rows[0].last_block_number,
                    blockHash: result.rows[0].last_block_hash
                };
                return this.cursor.blockNumber;
            }
        }
        finally {
            client.release();
        }
    }
    // Get the ABI for a contract address and cache it
    async getContractABI(address) {
        if (!this.provider) {
            console.error('[ABI] No RPC provider available to fetch ABI');
            return undefined;
        }
        const normalizedAddress = (0, starknet_1.validateAndParseAddress)(address).toLowerCase();
        if (this.abiMapping.has(normalizedAddress)) {
            console.log(`[ABI] Using cached ABI for contract ${normalizedAddress}`);
            return this.abiMapping.get(normalizedAddress);
        }
        try {
            const contractClass = await this.provider.getClassAt(normalizedAddress);
            const abi = contractClass.abi;
            this.abiMapping.set(normalizedAddress, abi);
            console.log(`[ABI] Cached ABI for contract ${normalizedAddress}`);
            return abi;
        }
        catch (error) {
            console.error(`[ABI] Failed to fetch ABI for contract ${normalizedAddress}:`, error);
            return undefined;
        }
    }
    // Register an event handler for a contract address with optional event name
    async onEvent(params) {
        const { contractAddress, eventName, handler } = params;
        if (!contractAddress) {
            throw new Error('Contract address is required');
        }
        if (!handler) {
            throw new Error('Handler is required');
        }
        const normalizedAddress = (0, starknet_1.validateAndParseAddress)(contractAddress).toLowerCase();
        console.log(`[Handler] Registering handler for contract ${normalizedAddress}${eventName ? `, event: ${eventName}` : ''}`);
        this.contractAddresses.add(normalizedAddress);
        const handlerConfig = {
            handler
        };
        if (eventName) {
            const isValid = await this.validateEventName(normalizedAddress, eventName);
            if (!isValid) {
                throw new Error(`[Event] Event "${eventName}" not found in contract ${normalizedAddress} ABI`);
            }
        }
        const handlerKey = eventName
            ? `${normalizedAddress}:${this.getEventSelector(eventName)}`
            : normalizedAddress;
        if (!this.eventHandlers.has(handlerKey)) {
            this.eventHandlers.set(handlerKey, []);
        }
        const handlers = this.eventHandlers.get(handlerKey);
        handlers.push(handlerConfig);
        console.log(`[Handler] Successfully registered handler for ${handlerKey}`);
        await this.getContractABI(normalizedAddress).catch(error => {
            console.error(`[ABI] Failed to fetch ABI for contract ${normalizedAddress}:`, error);
        });
    }
    // Start the indexer
    async start() {
        const startingBlock = await this.initializeDatabase() || 0;
        console.log(`[Indexer] Starting from block ${this.cursor?.blockNumber}`);
        const currentBlock = this.provider ? await this.provider.getBlockNumber() : 0;
        const targetBlock = this.config.startingBlockNumber || 0;
        try {
            console.log('[WebSocket] Connecting to node...');
            await this.wsChannel.waitForConnection();
            console.log('[WebSocket] Successfully connected');
        }
        catch (error) {
            console.error('[WebSocket] Failed to establish connection:', error);
            throw error;
        }
        try {
            console.log('[WebSocket] Subscribing to new heads...');
            await this.wsChannel.subscribeNewHeads();
            this.started = true;
            console.log('[WebSocket] Successfully subscribed to new heads');
        }
        catch (error) {
            console.error('[WebSocket] Failed to subscribe to new heads:', error);
            throw error;
        }
        if (targetBlock < currentBlock && this.provider) {
            console.log(`[Indexer] Processing historical blocks from ${targetBlock} to ${currentBlock}`);
            this.isProcessingBlocks = true;
            try {
                for (let blockNumber = targetBlock; blockNumber <= currentBlock; blockNumber++) {
                    // Skip if already processed
                    if (this.cursor && blockNumber <= this.cursor.blockNumber) {
                        console.log(`[Block] Skipping block #${blockNumber} - already processed`);
                        continue;
                    }
                    try {
                        const block = await this.provider.getBlock(blockNumber);
                        if (block) {
                            await this.processNewHead({
                                block_number: blockNumber,
                                block_hash: block.block_hash,
                                parent_hash: block.parent_hash,
                                timestamp: block.timestamp
                            });
                        }
                    }
                    catch (error) {
                        console.error(`[Block] Error fetching block ${blockNumber}:`, error);
                    }
                }
            }
            catch (error) {
                console.error('[Indexer] Failed to fetch historical blocks:', error);
            }
            this.isProcessingBlocks = false;
            console.log('[Indexer] Processing queued blocks...');
            await this.processBlockQueue();
        }
    }
    // Process a new block head
    async processNewHead(blockData) {
        if (this.cursor && blockData.block_number <= this.cursor.blockNumber) {
            if (blockData.block_number === this.cursor.blockNumber &&
                blockData.block_hash !== this.cursor.blockHash) {
                console.log(`[Reorg] Detected reorg at block #${blockData.block_number}`);
                await this.handleReorg(blockData.block_number);
            }
            else {
                console.log(`[Block] Skipping block #${blockData.block_number} - already processed`);
                return;
            }
        }
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            let timestamp;
            if (typeof blockData.timestamp === 'number') {
                timestamp = blockData.timestamp * 1000;
            }
            else {
                timestamp = new Date(blockData.timestamp).getTime();
            }
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
            await this.updateCursor(blockData.block_number, blockData.block_hash, client);
            await client.query('COMMIT');
            console.log(`[Block] Successfully processed block #${blockData.block_number}`);
            if (this.provider) {
                await this.processBlockTransactions(blockData.block_number);
            }
        }
        catch (error) {
            await client.query('ROLLBACK');
            console.error(`[Block] Failed to process block #${blockData.block_number}:`, error);
            throw error;
        }
        finally {
            client.release();
        }
    }
    // Handle chain reorgs
    async handleReorg(forkBlockNumber) {
        console.log(`[Reorg] Handling reorg from block #${forkBlockNumber}`);
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`
        UPDATE blocks
        SET is_canonical = FALSE
        WHERE number >= $1
      `, [forkBlockNumber]);
            if (this.cursor && this.cursor.blockNumber >= forkBlockNumber) {
                await this.updateCursor(forkBlockNumber - 1, '', client);
            }
            await client.query('COMMIT');
            console.log(`[Reorg] Successfully handled reorg from block #${forkBlockNumber}`);
        }
        catch (error) {
            await client.query('ROLLBACK');
            console.error(`[Reorg] Failed to handle reorg from block #${forkBlockNumber}:`, error);
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
    async processBlockQueue() {
        if (this.blockQueue.length === 0)
            return;
        const blocksToProcess = [...this.blockQueue];
        this.blockQueue = [];
        console.log(`[Block] Processing ${blocksToProcess.length} queued blocks`);
        for (const block of blocksToProcess) {
            try {
                console.log(`[Block] Processing queued block #${block.block_number}`);
                await this.processNewHead(block);
                if (this.provider) {
                    await this.processBlockTransactions(block.block_number);
                }
            }
            catch (error) {
                console.error(`[Block] Error processing queued block ${block.block_number}:`, error);
            }
        }
    }
    async updateCursor(blockNumber, blockHash, client) {
        this.cursor = { blockNumber, blockHash };
        await client.query(`
      UPDATE indexer_state 
      SET last_block_number = $1, last_block_hash = $2
      WHERE id = 1 AND (cursor_key IS NULL OR cursor_key = $3)
    `, [blockNumber, blockHash, this.config.cursorKey || null]);
    }
}
exports.StarknetIndexer = StarknetIndexer;
