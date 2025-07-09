import Database from 'better-sqlite3';
import type {
  BlockData,
  EventData,
  IndexerState,
  SqliteDbHandlerConfig,
} from '../../types/db-handler';
import { BaseDbHandler } from './base-db-handler';

export class SqliteDbHandler extends BaseDbHandler {
  private db: Database.Database;
  private inTransaction = false;

  constructor(private config: SqliteDbHandlerConfig) {
    super();
    this.db = config.dbInstance;
  }

  async initializeDb(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    // Create tables and indexes
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        number INTEGER PRIMARY KEY,
        hash TEXT UNIQUE NOT NULL,
        parent_hash TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        is_canonical INTEGER NOT NULL DEFAULT 1
      );
      
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        block_number INTEGER NOT NULL,
        transaction_hash TEXT NOT NULL,
        from_address TEXT NOT NULL,
        event_index INTEGER NOT NULL,
        keys TEXT NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY (block_number) REFERENCES blocks(number) ON DELETE CASCADE
      );
      
      CREATE TABLE IF NOT EXISTS indexer_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        last_block_number INTEGER,
        last_block_hash TEXT,
        cursor_key TEXT,
        CHECK (id = 1)
      );
      
      CREATE INDEX IF NOT EXISTS idx_events_block ON events(block_number);
      CREATE INDEX IF NOT EXISTS idx_events_from ON events(from_address);
    `);
  }

  async connect(): Promise<void> {
    // Enable foreign keys (SQLite has them disabled by default)
    this.db.pragma('foreign_keys = ON');

    await this.initializeDb();
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
    }
  }

  isConnected(): boolean {
    return !!this.db;
  }

  // State management methods
  async getIndexerState(cursorKey?: string): Promise<IndexerState | null> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const stmt = this.db.prepare(`
      SELECT last_block_number, last_block_hash 
      FROM indexer_state 
      WHERE id = 1 AND (cursor_key IS NULL OR cursor_key = ?)
    `);

    const result = stmt.get(cursorKey || null) as any;

    if (!result) {
      return null;
    }

    return {
      last_block_number: result.last_block_number,
      last_block_hash: result.last_block_hash,
      cursor_key: cursorKey,
    };
  }

  async initializeIndexerState(startingBlock: number, cursorKey?: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const stmt = this.db.prepare(`
      INSERT INTO indexer_state (last_block_number, last_block_hash, cursor_key) 
      VALUES (?, ?, ?)
    `);

    stmt.run(startingBlock, '', cursorKey || null);
  }

  async updateCursor(blockNumber: number, blockHash: string, cursorKey?: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const stmt = this.db.prepare(`
      UPDATE indexer_state 
      SET last_block_number = ?, last_block_hash = ?
      WHERE id = 1 AND (cursor_key IS NULL OR cursor_key = ?)
    `);

    stmt.run(blockNumber, blockHash, cursorKey || null);
  }

  // Block operations
  async insertBlock(blockData: BlockData): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const timestamp =
      typeof blockData.timestamp === 'number'
        ? blockData.timestamp * 1000
        : new Date(blockData.timestamp).getTime();

    const stmt = this.db.prepare(`
      INSERT INTO blocks (number, hash, parent_hash, timestamp)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(number) DO UPDATE SET
      hash = excluded.hash,
      parent_hash = excluded.parent_hash,
      timestamp = excluded.timestamp,
      is_canonical = 1
    `);

    stmt.run(blockData.block_number, blockData.block_hash, blockData.parent_hash, timestamp);
  }

  async batchInsertBlocks(blocks: BlockData[]): Promise<void> {
    if (blocks.length === 0) return;

    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const stmt = this.db.prepare(`
      INSERT INTO blocks (number, hash, parent_hash, timestamp)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(number) DO UPDATE SET
      hash = excluded.hash,
      parent_hash = excluded.parent_hash,
      timestamp = excluded.timestamp,
      is_canonical = 1
    `);

    const transaction = this.db.transaction((blocks: BlockData[]) => {
      for (const block of blocks) {
        const timestamp =
          typeof block.timestamp === 'number'
            ? block.timestamp * 1000
            : new Date(block.timestamp).getTime();
        stmt.run(block.block_number, block.block_hash, block.parent_hash, timestamp);
      }
    });

    transaction(blocks);
  }

  async checkIsBlockProcessed(blockNumber: number): Promise<boolean> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const stmt = this.db.prepare(
      `SELECT EXISTS(SELECT 1 FROM blocks WHERE number = ?) as 'exists'`
    );
    const result = stmt.get(blockNumber) as any;

    return !!result.exists;
  }

  async getBlockByNumber(blockNumber: number): Promise<BlockData | null> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const stmt = this.db.prepare(`SELECT * FROM blocks WHERE number = ?`);
    const result = stmt.get(blockNumber) as any;

    if (!result) {
      return null;
    }

    return {
      block_number: result.number,
      block_hash: result.hash,
      parent_hash: result.parent_hash,
      timestamp: result.timestamp,
    };
  }

  async getBlockByParentHash(parentHash: string): Promise<BlockData | null> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const stmt = this.db.prepare(`SELECT * FROM blocks WHERE parent_hash = ?`);
    const result = stmt.get(parentHash) as any;

    if (!result) {
      return null;
    }

    return {
      block_number: result.number,
      block_hash: result.hash,
      parent_hash: result.parent_hash,
      timestamp: result.timestamp,
    };
  }

  // Reorg operations
  async deleteBlock(blockHash: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const stmt = this.db.prepare(`DELETE FROM blocks WHERE hash = ?`);
    stmt.run(blockHash);
  }

  async deleteEventsByBlockNumber(blockNumber: number): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const stmt = this.db.prepare(`DELETE FROM events WHERE block_number = ?`);
    stmt.run(blockNumber);
  }

  // Transaction management
  async beginTransaction(): Promise<void> {
    try {
      if (!this.db) {
        throw new Error('Database not initialized');
      }

      if (this.inTransaction) {
        throw new Error('Transaction already in progress');
      }

      this.db.exec('BEGIN TRANSACTION');
      this.inTransaction = true;
    } catch (error) {
      console.error('Error beginning transaction:', error);
      this.inTransaction = false;
      throw error;
    }
  }

  async commitTransaction(): Promise<void> {
    try {
      if (!this.db) {
        throw new Error('Database not initialized');
      }

      if (!this.inTransaction) {
        throw new Error('No transaction in progress');
      }

      this.db.exec('COMMIT');
    } catch (error) {
      console.error('Error committing transaction:', error);
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  async rollbackTransaction(): Promise<void> {
    try {
      if (!this.db) {
        throw new Error('Database not initialized');
      }

      if (!this.inTransaction) {
        throw new Error('No transaction in progress');
      }

      this.db.exec('ROLLBACK');
      this.inTransaction = false;
    } catch (error) {
      console.error('Error rolling back transaction:', error);
      throw error;
    }
  }

  // Event operations
  async insertEvent(eventData: EventData): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const stmt = this.db.prepare(`
      INSERT INTO events (block_number, transaction_hash, from_address, event_index, keys, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      eventData.block_number,
      eventData.transaction_hash,
      eventData.from_address,
      eventData.event_index,
      JSON.stringify(eventData.keys),
      JSON.stringify(eventData.data)
    );
  }

  async query(query: string, params: any[] = []): Promise<any> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const stmt = this.db.prepare(query);

    // Check if it's a SELECT query (returns data) or other types
    if (query.trim().toUpperCase().startsWith('SELECT')) {
      return { rows: stmt.all(...params) };
    } else {
      const result = stmt.run(...params);
      return {
        rows: [],
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
      };
    }
  }

  async cleanup(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
      } catch (error) {
        console.error('Error closing database:', error);
      }
    }
  }
}
