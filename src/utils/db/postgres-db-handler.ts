import { Pool, PoolClient } from 'pg';
import type {
  BlockData,
  EventData,
  IndexerState,
  PostgresDbHandlerConfig,
} from '../../types/db-handler';
import { BaseDbHandler } from './base-db-handler';
export class PostgresDbHandler extends BaseDbHandler {
  private client?: PoolClient;
  private pool: Pool;

  constructor(private config: PostgresDbHandlerConfig) {
    super();
    this.pool = new Pool({
      connectionString: config.connectionString,
    });
  }

  async initializeDb(): Promise<void> {
    if (!this.client) {
      throw new Error('Database client not initialized');
    }

    // Create tables and indexes
    await this.client.query(`
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
  }

  async connect(): Promise<void> {
    this.client = await this.pool.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.release();
      this.client = undefined;
    }
  }

  async cleanup(): Promise<void> {
    try {
      await this.pool.end();
    } catch (error) {
      console.error('Error closing database pool:', error);
    }
  }

  isConnected(): boolean {
    return !!this.client;
  }

  // State management methods
  async getIndexerState(cursorKey?: string): Promise<IndexerState | null> {
    if (!this.client) {
      throw new Error('Database client not initialized');
    }

    const result = await this.client.query(
      `
        SELECT last_block_number, last_block_hash 
        FROM indexer_state 
        WHERE id = 1 AND (cursor_key IS NULL OR cursor_key = $1)
      `,
      [cursorKey || null]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return {
      last_block_number: result.rows[0].last_block_number,
      last_block_hash: result.rows[0].last_block_hash,
      cursor_key: cursorKey,
    };
  }

  async initializeIndexerState(startingBlock: number, cursorKey?: string): Promise<void> {
    if (!this.client) {
      throw new Error('Database client not initialized');
    }

    await this.client.query(
      `
        INSERT INTO indexer_state (last_block_number, last_block_hash, cursor_key) 
        VALUES ($1, $2, $3)
      `,
      [startingBlock, '', cursorKey || null]
    );
  }

  async updateCursor(blockNumber: number, blockHash: string, cursorKey?: string): Promise<void> {
    if (!this.client) {
      throw new Error('Database client not initialized');
    }

    await this.client.query(
      `
        UPDATE indexer_state 
        SET last_block_number = $1, last_block_hash = $2
        WHERE id = 1 AND (cursor_key IS NULL OR cursor_key = $3)
      `,
      [blockNumber, blockHash, cursorKey || null]
    );
  }

  // Block operations
  async insertBlock(blockData: BlockData): Promise<void> {
    if (!this.client) {
      throw new Error('Database client not initialized');
    }

    const timestamp =
      typeof blockData.timestamp === 'number'
        ? blockData.timestamp * 1000
        : new Date(blockData.timestamp).getTime();

    await this.client.query(
      `
        INSERT INTO blocks (number, hash, parent_hash, timestamp)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (number) DO UPDATE
        SET hash = $2, parent_hash = $3, timestamp = $4, is_canonical = TRUE
      `,
      [blockData.block_number, blockData.block_hash, blockData.parent_hash, timestamp]
    );
  }

  async batchInsertBlocks(blocks: BlockData[]): Promise<void> {
    if (blocks.length === 0) return;

    if (!this.client) {
      throw new Error('Database client not initialized');
    }

    const values = blocks
      .map((block) => {
        const timestamp =
          typeof block.timestamp === 'number'
            ? block.timestamp * 1000
            : new Date(block.timestamp).getTime();
        return `(${block.block_number}, '${block.block_hash}', '${block.parent_hash}', ${timestamp})`;
      })
      .join(',');

    await this.client.query(`
      INSERT INTO blocks (number, hash, parent_hash, timestamp)
      VALUES ${values}
      ON CONFLICT (number) DO UPDATE
      SET hash = EXCLUDED.hash, 
          parent_hash = EXCLUDED.parent_hash, 
          timestamp = EXCLUDED.timestamp, 
          is_canonical = TRUE
    `);
  }

  async checkIsBlockProcessed(blockNumber: number): Promise<boolean> {
    if (!this.client) {
      throw new Error('Database client not initialized');
    }

    const result = await this.client.query(
      `SELECT EXISTS (SELECT 1 FROM blocks WHERE number = $1) AS "exists"`,
      [blockNumber]
    );

    return result.rows[0].exists;
  }

  async getBlockByNumber(blockNumber: number): Promise<BlockData | null> {
    if (!this.client) {
      throw new Error('Database client not initialized');
    }

    const result = await this.client.query(`SELECT * FROM blocks WHERE number = $1`, [blockNumber]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      block_number: row.number,
      block_hash: row.hash,
      parent_hash: row.parent_hash,
      timestamp: row.timestamp,
    };
  }

  async getBlockByParentHash(parentHash: string): Promise<BlockData | null> {
    if (!this.client) {
      throw new Error('Database client not initialized');
    }

    const result = await this.client.query(`SELECT * FROM blocks WHERE parent_hash = $1`, [
      parentHash,
    ]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      block_number: row.number,
      block_hash: row.hash,
      parent_hash: row.parent_hash,
      timestamp: row.timestamp,
    };
  }

  // Reorg operations
  async deleteBlock(blockHash: string): Promise<void> {
    if (!this.client) {
      throw new Error('Database client not initialized');
    }

    await this.client.query(`DELETE FROM blocks WHERE hash = $1`, [blockHash]);
  }

  async deleteEventsByBlockNumber(blockNumber: number): Promise<void> {
    if (!this.client) {
      throw new Error('Database client not initialized');
    }

    await this.client.query(`DELETE FROM events WHERE block_number = $1`, [blockNumber]);
  }

  // Transaction management
  async beginTransaction(): Promise<void> {
    if (!this.client) {
      throw new Error('Database client not initialized');
    }

    await this.client.query('BEGIN');
  }

  async commitTransaction(): Promise<void> {
    if (!this.client) {
      throw new Error('Database client not initialized');
    }

    await this.client.query('COMMIT');
  }

  async rollbackTransaction(): Promise<void> {
    if (!this.client) {
      throw new Error('Database client not initialized');
    }

    await this.client.query('ROLLBACK');
  }

  // Event operations
  async insertEvent(eventData: EventData): Promise<void> {
    if (!this.client) {
      throw new Error('Database client not initialized');
    }

    await this.client.query(
      `
        INSERT INTO events (block_number, transaction_hash, from_address, event_index, keys, data)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        eventData.block_number,
        eventData.transaction_hash,
        eventData.from_address,
        eventData.event_index,
        eventData.keys,
        eventData.data,
      ]
    );
  }

  async query(query: string, params: any[] = []): Promise<any> {
    if (!this.client) {
      throw new Error('Database client not initialized');
    }
    return await this.client.query(query, params);
  }

  async healthCheck(): Promise<void> {
    if (!this.client) {
      throw new Error('Database client not initialized');
    }

    try {
      await this.client.query('SELECT 1');
    } catch (error) {
      console.error('Database health check failed:', error);
      throw error;
    }
  }
}
