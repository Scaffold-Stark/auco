import { Abi } from 'abi-wan-kanabi';
import { EventToPrimitiveType } from './abi-wan-helpers';
import { StarknetIndexer } from '..';
import { BaseDbHandler } from '../utils/db/base-db-handler';
import { MysqlDbHandlerConfig, PostgresDbHandlerConfig, SqliteDbHandlerConfig } from './db-handler';

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

// Type-safe database configuration using discriminated unions
type DatabaseConfig =
  | {
      type: 'postgres';
      config: PostgresDbHandlerConfig;
    }
  | {
      type: 'mysql';
      config: MysqlDbHandlerConfig;
    }
  | {
      type: 'sqlite';
      config: SqliteDbHandlerConfig;
    };

/**
 * Configuration interface for the StarknetIndexer
 *
 * This interface defines all the configuration options needed to initialize
 * and run a Starknet indexer instance.
 */
export interface IndexerConfig {
  /** RPC node URL for fetching block data and events */
  rpcNodeUrl: string;

  /** WebSocket node URL for real-time block updates and event subscriptions */
  wsNodeUrl: string;

  /** Database configuration for storing indexed data and cursor state */
  database: DatabaseConfig;

  /** Block number to start indexing from, or 'latest' to start from current block */
  startingBlockNumber?: number | 'latest';

  /** Optional array of contract addresses to monitor for events */
  contractAddresses?: string[];

  /** Unique key for tracking indexer progress in the database */
  cursorKey?: string;

  /** Log level for controlling output verbosity */
  logLevel?: LogLevel;

  /** Custom logger instance to use instead of default ConsoleLogger */
  logger?: Logger;

  /** Maximum number of concurrent block fetch requests (default: 10) */
  maxConcurrentRequests?: number;

  /**
   * Maximum number of concurrent requests for fetching historical blocks (default: 10)
   * This controls how many historical blocks are fetched and processed in parallel during
   * catch-up or backfill operations. Increasing this value can speed up historical syncs,
   * but may increase load on the node and database.
   */
  maxHistoricalBlockConcurrentRequests?: number;

  /** Enable UI progress bar for tracking indexer progress */
  enableUiProgress?: boolean;
}

export type StarknetEvent<TAbi extends Abi, TEventName extends string> = {
  block_number: number;
  block_hash: string;
  transaction_hash: string;
  from_address: string;
  event_index: number;
  keys: string[];
  data: string[];
  parsed: EventToPrimitiveType<TAbi, TEventName>;
};

export interface QueuedBlock {
  block_number: number;
  block_hash: string;
  parent_hash: string;
  timestamp: number;
}

export type EventHandler<TAbi extends Abi, TEventName extends string> = (
  event: StarknetEvent<TAbi, TEventName>,
  dbHandler: BaseDbHandler,
  indexer: StarknetIndexer
) => Promise<void>;

// Extract only struct event names from ABI - provides intellisense for event names
type ExtractStructEventNames<TAbi extends Abi> = {
  [K in keyof TAbi]: TAbi[K] extends {
    type: 'event';
    kind: 'struct';
    name: infer TName extends string;
  }
    ? TName
    : never;
}[number];

export interface EventHandlerParams<
  TAbi extends Abi,
  TEventName extends ExtractStructEventNames<TAbi>,
> {
  contractAddress: string;
  abi: TAbi;
  eventName: TEventName;
  handler: EventHandler<TAbi, TEventName>;
}

// Base interface for storage
export interface BaseEventHandlerConfig {
  handler: (event: any, dbHandler: BaseDbHandler, indexer: StarknetIndexer) => Promise<void>;
}

// Typed interface for public API
export interface EventHandlerConfig<TAbi extends Abi, TEventName extends string>
  extends BaseEventHandlerConfig {
  handler: EventHandler<TAbi, TEventName>;
}

export type ReorgHandler = (forkedBlock: QueuedBlock) => Promise<void>;

export interface ReorgHandlerParams {
  handler: ReorgHandler;
  isOverride?: boolean;
}

export interface Cursor {
  blockNumber: number;
  blockHash: string;
}
