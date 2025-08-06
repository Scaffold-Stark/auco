import mysql from 'mysql2/promise';
import { BaseDbHandler } from './base-db-handler';
import type {
  BlockData,
  EventData,
  IndexerState,
  MysqlDbHandlerConfig,
} from '../../types/db-handler';

export class MysqlDbHandler extends BaseDbHandler {
  private connection?: mysql.PoolConnection;
  private pool: mysql.Pool;

  constructor(private config: MysqlDbHandlerConfig) {
    super();
    this.pool = mysql.createPool(config.connectionString);
  }

  private async execute(query: string, params: any[] = []): Promise<any> {
    if (!this.connection) {
      throw new Error('Database connection not initialized');
    }
    return this.connection.execute(query, params);
  }

  async initializeDb(): Promise<void> {
    if (!this.connection) {
      throw new Error('Database connection not initialized');
    }

    // Create tables and indexes
    await this.execute(`
      CREATE TABLE IF NOT EXISTS blocks (
        number BIGINT PRIMARY KEY,
        hash VARCHAR(66) UNIQUE NOT NULL,
        parent_hash VARCHAR(66) NOT NULL,
        timestamp BIGINT NOT NULL,
        is_canonical BOOLEAN NOT NULL DEFAULT TRUE
      );
    `);

    await this.execute(`
      CREATE TABLE IF NOT EXISTS events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        block_number BIGINT NOT NULL,
        transaction_hash VARCHAR(66) NOT NULL,
        from_address VARCHAR(66) NOT NULL,
        event_index INT NOT NULL,
        \`keys\` JSON NOT NULL,
        \`data\` JSON NOT NULL,
        FOREIGN KEY (block_number) REFERENCES blocks(number) ON DELETE CASCADE
      );
    `);

    await this.execute(`
      CREATE TABLE IF NOT EXISTS indexer_state (
        id INT PRIMARY KEY DEFAULT 1,
        last_block_number BIGINT,
        last_block_hash VARCHAR(66),
        cursor_key VARCHAR(255),
        CONSTRAINT singleton_check CHECK (id = 1)
      );
    `);

    // Create indexes (MySQL doesn't support IF NOT EXISTS for CREATE INDEX)
    try {
      await this.execute(`
        CREATE INDEX idx_events_block ON events(block_number);
      `);
    } catch (error: any) {
      // Index might already exist, ignore duplicate key error
      if (error.code !== 'ER_DUP_KEYNAME') {
        throw error;
      }
    }

    try {
      await this.execute(`
        CREATE INDEX idx_events_from ON events(from_address);
      `);
    } catch (error: any) {
      // Index might already exist, ignore duplicate key error
      if (error.code !== 'ER_DUP_KEYNAME') {
        throw error;
      }
    }
  }

  async connect(): Promise<void> {
    this.connection = await this.pool.getConnection();
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      this.connection.release();
      this.connection = undefined;
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
    return !!this.connection;
  }

  async getIndexerState(cursorKey?: string): Promise<IndexerState | null> {
    if (!this.connection) {
      throw new Error('Database connection not initialized');
    }

    const [rows] = await this.execute(
      `
        SELECT last_block_number, last_block_hash 
        FROM indexer_state 
        WHERE id = 1 AND (cursor_key IS NULL OR cursor_key = ?)
      `,
      [cursorKey || null]
    );

    const results = rows as any[];
    if (results.length === 0) {
      return null;
    }

    return {
      last_block_number: results[0].last_block_number,
      last_block_hash: results[0].last_block_hash,
      cursor_key: cursorKey,
    };
  }

  async initializeIndexerState(startingBlock: number, cursorKey?: string): Promise<void> {
    if (!this.connection) {
      throw new Error('Database connection not initialized');
    }

    await this.execute(
      `
        INSERT INTO indexer_state (last_block_number, last_block_hash, cursor_key) 
        VALUES (?, ?, ?)
      `,
      [startingBlock, '', cursorKey || null]
    );
  }

  async updateCursor(blockNumber: number, blockHash: string, cursorKey?: string): Promise<void> {
    if (!this.connection) {
      throw new Error('Database connection not initialized');
    }

    await this.execute(
      `
        UPDATE indexer_state 
        SET last_block_number = ?, last_block_hash = ?
        WHERE id = 1 AND (cursor_key IS NULL OR cursor_key = ?)
      `,
      [blockNumber, blockHash, cursorKey || null]
    );
  }

  async insertBlock(blockData: BlockData): Promise<void> {
    if (!this.connection) {
      throw new Error('Database connection not initialized');
    }

    const timestamp =
      typeof blockData.timestamp === 'number'
        ? blockData.timestamp * 1000
        : new Date(blockData.timestamp).getTime();

    await this.execute(
      `
        INSERT INTO blocks (number, hash, parent_hash, timestamp)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        hash = VALUES(hash),
        parent_hash = VALUES(parent_hash),
        timestamp = VALUES(timestamp),
        is_canonical = TRUE
      `,
      [blockData.block_number, blockData.block_hash, blockData.parent_hash, timestamp]
    );
  }

  async batchInsertBlocks(blocks: BlockData[]): Promise<void> {
    if (blocks.length === 0) return;

    if (!this.connection) {
      throw new Error('Database connection not initialized');
    }

    const values = blocks.map((block) => {
      const timestamp =
        typeof block.timestamp === 'number'
          ? block.timestamp * 1000
          : new Date(block.timestamp).getTime();
      return [block.block_number, block.block_hash, block.parent_hash, timestamp];
    });

    await this.execute(
      `
        INSERT INTO blocks (number, hash, parent_hash, timestamp)
        VALUES ?
        ON DUPLICATE KEY UPDATE
        hash = VALUES(hash),
        parent_hash = VALUES(parent_hash),
        timestamp = VALUES(timestamp),
        is_canonical = TRUE
      `,
      [values]
    );
  }

  async checkIsBlockProcessed(blockNumber: number): Promise<boolean> {
    if (!this.connection) {
      throw new Error('Database connection not initialized');
    }

    const [rows] = await this.execute(
      `SELECT EXISTS(SELECT 1 FROM blocks WHERE number = ?) as 'exists'`,
      [blockNumber]
    );

    const results = rows as any[];
    return !!results[0].exists;
  }

  async getBlockByNumber(blockNumber: number): Promise<BlockData | null> {
    if (!this.connection) {
      throw new Error('Database connection not initialized');
    }

    const [rows] = await this.execute(`SELECT * FROM blocks WHERE number = ?`, [blockNumber]);

    const results = rows as any[];
    if (results.length === 0) {
      return null;
    }

    const row = results[0];
    return {
      block_number: row.number,
      block_hash: row.hash,
      parent_hash: row.parent_hash,
      timestamp: row.timestamp,
    };
  }

  async getBlockByParentHash(parentHash: string): Promise<BlockData | null> {
    if (!this.connection) {
      throw new Error('Database connection not initialized');
    }

    const [rows] = await this.execute(`SELECT * FROM blocks WHERE parent_hash = ?`, [parentHash]);

    const results = rows as any[];
    if (results.length === 0) {
      return null;
    }

    const row = results[0];
    return {
      block_number: row.number,
      block_hash: row.hash,
      parent_hash: row.parent_hash,
      timestamp: row.timestamp,
    };
  }

  async deleteBlock(blockHash: string): Promise<void> {
    if (!this.connection) {
      throw new Error('Database connection not initialized');
    }

    await this.execute(`DELETE FROM blocks WHERE hash = ?`, [blockHash]);
  }

  async deleteEventsByBlockNumber(blockNumber: number): Promise<void> {
    if (!this.connection) {
      throw new Error('Database connection not initialized');
    }

    await this.execute(`DELETE FROM events WHERE block_number = ?`, [blockNumber]);
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    try {
      await this.beginTransaction();
      const result = await fn();
      await this.commitTransaction();
      return result;
    } catch (error) {
      await this.rollbackTransaction();
      throw error;
    }
  }
  async beginTransaction(): Promise<void> {
    if (!this.connection) {
      throw new Error('Database connection not initialized');
    }

    await this.connection.beginTransaction();
  }

  async commitTransaction(): Promise<void> {
    if (!this.connection) {
      throw new Error('Database connection not initialized');
    }

    await this.connection.commit();
  }

  async rollbackTransaction(): Promise<void> {
    if (!this.connection) {
      throw new Error('Database connection not initialized');
    }

    await this.connection.rollback();
  }

  async insertEvent(eventData: EventData): Promise<void> {
    if (!this.connection) {
      throw new Error('Database connection not initialized');
    }

    await this.execute(
      `
        INSERT INTO events (block_number, transaction_hash, from_address, event_index, \`keys\`, \`data\`)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        eventData.block_number,
        eventData.transaction_hash,
        eventData.from_address,
        eventData.event_index,
        JSON.stringify(eventData.keys),
        JSON.stringify(eventData.data),
      ]
    );
  }

  async query(query: string, params: any[] = []): Promise<any> {
    if (!this.connection) {
      throw new Error('Database connection not initialized');
    }

    const [rows] = await this.execute(query, params);
    return { rows };
  }

  async healthCheck(): Promise<void> {
    if (!this.connection) {
      throw new Error('Database connection not initialized');
    }

    try {
      await this.connection.query('SELECT 1');
    } catch (error) {
      console.error('Database health check failed:', error);
      throw error;
    }
  }
}
