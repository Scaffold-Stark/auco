import { Abi } from 'abi-wan-kanabi';
import { ExtractAbiEventNames, EventToPrimitiveType } from 'abi-wan-kanabi/kanabi';
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

export interface IndexerConfig {
  rpcNodeUrl: string;
  wsNodeUrl: string;
  database: DatabaseConfig;
  startingBlockNumber: number | 'latest';
  contractAddresses?: string[];
  cursorKey?: string;
  logLevel?: LogLevel;
  logger?: Logger;
}

export type StarknetEvent<TAbi extends Abi, TEventName extends ExtractAbiEventNames<TAbi>> = {
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

export type EventHandler<TAbi extends Abi, TEventName extends ExtractAbiEventNames<TAbi>> = (
  event: StarknetEvent<TAbi, TEventName>,
  dbHandler: BaseDbHandler,
  indexer: StarknetIndexer
) => Promise<void>;

export interface EventHandlerParams<
  TAbi extends Abi,
  TEventName extends ExtractAbiEventNames<TAbi>,
> {
  contractAddress: string;
  abi: TAbi;
  eventName: TEventName;
  handler: EventHandler<TAbi, TEventName>;
}

export interface EventHandlerConfig {
  handler: EventHandler<any, any>;
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
