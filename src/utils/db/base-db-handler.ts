import { BlockData, EventData, IndexerState } from '../../types/db-handler';

export abstract class BaseDbHandler {
  abstract initializeDb(): Promise<void>;

  abstract connect(): Promise<void>;

  abstract disconnect(): Promise<void>;

  abstract isConnected(): boolean;

  abstract getIndexerState(cursorKey?: string): Promise<IndexerState | null>;

  abstract initializeIndexerState(startingBlock: number, cursorKey?: string): Promise<void>;

  abstract updateCursor(blockNumber: number, blockHash: string, cursorKey?: string): Promise<void>;

  abstract insertBlock(blockData: BlockData): Promise<void>;

  abstract batchInsertBlocks(blocks: BlockData[]): Promise<void>;

  abstract checkIsBlockProcessed(blockNumber: number): Promise<boolean>;

  abstract getBlockByNumber(blockNumber: number): Promise<BlockData | null>;

  abstract getBlockByParentHash(parentHash: string): Promise<BlockData | null>;

  abstract deleteBlock(blockHash: string): Promise<void>;

  abstract deleteEventsByBlockNumber(blockNumber: number): Promise<void>;

  abstract beginTransaction(): Promise<void>;

  abstract commitTransaction(): Promise<void>;

  abstract rollbackTransaction(): Promise<void>;

  abstract insertEvent(eventData: EventData): Promise<void>;

  abstract query(query: string, params: any[]): Promise<any>;

  abstract cleanup(): Promise<void>;

  abstract healthCheck(): Promise<void>;
}
