import { PoolClient } from 'pg';
export interface IndexerConfig {
    wsNodeUrl: string;
    rpcNodeUrl?: string | undefined;
    databaseUrl: string;
    startingBlockNumber?: number;
    fetchHistoricalEvents?: boolean;
    maxConcurrentEvents?: number;
    contractAddresses?: string[];
}
export type EventHandler = (event: any, client: PoolClient) => Promise<void>;
export declare class StarknetIndexer {
    private config;
    private wsChannel;
    private pool;
    private eventHandlers;
    private started;
    private provider?;
    private eventQueue;
    private isProcessingQueue;
    private maxConcurrentEvents;
    private contractAddresses;
    constructor(config: IndexerConfig);
    private setupEventHandlers;
    private processBlockTransactions;
    initializeDatabase(): Promise<number | undefined>;
    onEvent(fromAddress: string, handler: EventHandler): void;
    onEvent(fromAddress: string, eventKey: string, handler: EventHandler): void;
    start(): Promise<void>;
    private processNewHead;
    private processEvent;
    handleReorg(forkBlockNumber: number): Promise<void>;
    stop(): Promise<void>;
    private processEventQueue;
    private enqueueEvent;
}
