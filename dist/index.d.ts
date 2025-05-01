import { PoolClient } from 'pg';
export interface IndexerConfig {
    wsNodeUrl: string;
    rpcNodeUrl?: string | undefined;
    databaseUrl: string;
    startingBlockNumber?: number;
    fetchHistoricalEvents?: boolean;
    maxConcurrentEvents?: number;
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
    constructor(config: IndexerConfig);
    private setupEventHandlers;
    initializeDatabase(): Promise<number | undefined>;
    onEvent(fromAddress: string, handler: EventHandler): void;
    onEvent(fromAddress: string, eventKey: string, handler: EventHandler): void;
    start(): Promise<void>;
    private subscribeToEvents;
    private processNewHead;
    private processEvents;
    handleReorg(forkBlockNumber: number): Promise<void>;
    stop(): Promise<void>;
    private processEventQueue;
    private enqueueEvent;
    private fetchHistoricalEvents;
}
