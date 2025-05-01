import { IndexerConfig, EventHandler } from './types';
export { IndexerConfig, EventHandler };
export declare class StarknetIndexer {
    private config;
    private wsChannel;
    private pool;
    private eventHandlers;
    private started;
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
}
