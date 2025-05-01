import { PoolClient } from 'pg';

export interface IndexerConfig {
  nodeUrl: string;
  databaseUrl: string;
  startingBlockNumber?: number;
}

export type EventHandler = (event: any, client: PoolClient) => Promise<void>;

export interface StarknetIndexerInterface {
  onEvent(fromAddress: string, handler: EventHandler): void;
  onEvent(fromAddress: string, eventKey: string, handler: EventHandler): void;
}
