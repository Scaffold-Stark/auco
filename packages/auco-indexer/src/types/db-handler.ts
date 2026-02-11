import Database from 'better-sqlite3';

export interface BlockData {
  block_number: number;
  block_hash: string;
  parent_hash: string;
  timestamp: number;
}

export interface IndexerState {
  last_block_number: number;
  last_block_hash: string;
  cursor_key?: string;
}

export interface EventData {
  block_number: number;
  transaction_hash: string;
  from_address: string;
  event_index: number;
  keys: string[];
  data: string[];
}

export interface PostgresDbHandlerConfig {
  connectionString: string;
}

export interface SqliteDbHandlerConfig {
  dbInstance: Database.Database;
}

export interface MysqlDbHandlerConfig {
  connectionString: string;
}

export type DbHandlerType = 'postgres' | 'mysql' | 'sqlite';
