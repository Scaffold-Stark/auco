import { PoolClient } from 'pg';
export interface IndexerConfig {
    wsNodeUrl: string;
    rpcNodeUrl?: string | undefined;
    databaseUrl: string;
    startingBlockNumber?: number;
    contractAddresses?: string[];
    cursorKey?: string;
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
    constructor(config: IndexerConfig);
    private setupEventHandlers;
    private getEventSelector;
    private validateEventName;
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
}
export {};
