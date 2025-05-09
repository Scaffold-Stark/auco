export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error'
}

export interface Logger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

export interface BlockData {
  block_number: number;
  block_hash: string;
  parent_hash: string;
  timestamp: number;
}

export interface QueuedBlock extends BlockData {}

export interface Cursor {
  blockNumber: number;
  blockHash: string;
}

export interface EventHandlerParams {
  contractAddress: string;
  eventName?: string;
  handler: EventHandler;
}

export interface EventHandlerConfig {
  handler: EventHandler;
}

export type EventHandler = (event: any, client: any, indexer: any) => Promise<void>;

export interface IndexerConfig {
  wsNodeUrl: string;
  rpcNodeUrl?: string | undefined;
  databaseUrl: string;
  startingBlockNumber?: number;
  contractAddresses?: string[];
  cursorKey?: string;
  logLevel?: LogLevel;
  logger?: Logger;
} 