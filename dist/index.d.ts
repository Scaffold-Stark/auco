import { PoolClient } from 'pg';
export declare enum LogLevel {
    DEBUG = "debug",
    INFO = "info",
    WARN = "warn",
    ERROR = "error"
}
export interface Logger {
    debug(message: string, ...args: any[]): void;
    info(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;
}
export declare class ConsoleLogger implements Logger {
    private level;
    constructor(level?: LogLevel);
    private shouldLog;
    debug(message: string, ...args: any[]): void;
    info(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;
}
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
export type EventHandler = (event: any, client: PoolClient, indexer: StarknetIndexer) => Promise<void>;
interface EventHandlerParams {
    contractAddress: string;
    eventName?: string;
    handler: EventHandler;
}
export declare class StarknetIndexer {
    private config;
    private wsChannel;
    private pool;
    private eventHandlers;
    private started;
    private provider?;
    private blockQueue;
    private isProcessingBlocks;
    private contractAddresses;
    private abiMapping;
    private cursor;
    private logger;
    constructor(config: IndexerConfig);
    private setupEventHandlers;
    private getEventSelector;
    private validateEventName;
    private normalizeAddress;
    private withTransaction;
    private processBlockTransactions;
    initializeDatabase(): Promise<number | undefined>;
    private getContractABI;
    onEvent(params: EventHandlerParams): Promise<void>;
    start(): Promise<void>;
    private processNewHead;
    handleReorg(forkBlockNumber: number): Promise<void>;
    stop(): Promise<void>;
    private processBlockQueue;
    private updateCursor;
    private withErrorHandling;
}
export {};
