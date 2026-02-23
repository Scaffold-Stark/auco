import type { ProgressUiState } from '../ui/progress';

export class ProgressStats {
  public syncStats = {
    startBlock: 0,
    endBlock: 0,
    startTime: 0,
    lastBlock: 0,
    eventStats: {} as Record<string, { count: number }>,
    blocksProcessed: 0,
    health: {
      database: true,
      ws: true,
      rpc: true,
    },
  };
  private eventContractMap: Record<string, string> = {};
  private rpcRequestCount = 0;
  private rpsWindow: { count: number; timestamp: number }[] = [];
  private readonly RPS_WINDOW_SIZE = 100;

  initSyncStats(fromBlock: number, toBlock: number) {
    this.syncStats = {
      startBlock: fromBlock,
      endBlock: toBlock,
      startTime: Date.now(),
      lastBlock: fromBlock - 1,
      eventStats: {},
      blocksProcessed: 0,
      health: {
        database: true,
        ws: true,
        rpc: true,
      },
    };
  }

  updateEvent(blockNumber: number, eventName: string, contractAddress: string) {
    const baseKey = eventName;
    const contractKey = `${baseKey}|${contractAddress}`;
    const key = contractKey;
    const statsObj = this.syncStats.eventStats;

    if (!this.eventContractMap[contractKey]) {
      this.eventContractMap[contractKey] = baseKey;
    }

    if (!statsObj[key]) {
      statsObj[key] = { count: 0 };
    }
    statsObj[key].count += 1;
    this.syncStats.lastBlock = blockNumber;
    this.syncStats.blocksProcessed += 1;
  }

  updateHealth(health: { database: boolean; ws: boolean; rpc: boolean }) {
    this.syncStats.health = health;
  }

  incrementRpcRequest() {
    this.rpcRequestCount++;
  }

  updateRpsWindow() {
    const now = Date.now();
    this.rpsWindow.push({ count: this.rpcRequestCount, timestamp: now });
    if (this.rpsWindow.length > this.RPS_WINDOW_SIZE) {
      this.rpsWindow.shift();
    }
  }

  getCurrentRps(): number {
    if (this.rpsWindow.length < 2) return 0;
    const first = this.rpsWindow[0];
    const last = this.rpsWindow[this.rpsWindow.length - 1];
    const requests = last.count - first.count;
    const seconds = (last.timestamp - first.timestamp) / 1000;
    return seconds > 0 ? requests / seconds : 0;
  }

  getUiState(): ProgressUiState {
    this.updateRpsWindow();
    const { startBlock, endBlock, startTime, lastBlock, eventStats, blocksProcessed, health } =
      this.syncStats;
    const totalBlocks = endBlock - startBlock + 1;
    const processedBlocks = lastBlock - startBlock + 1;
    const percent = totalBlocks > 0 ? processedBlocks / totalBlocks : 0;
    const elapsed = (Date.now() - startTime) / 1000;
    const rps = this.getCurrentRps();
    const eta =
      (totalBlocks - processedBlocks) / ((rps > 0 ? rps : blocksProcessed / (elapsed || 1)) || 1);
    const events = Object.entries(eventStats).map(([key, { count }]) => {
      const [eventName, contractAddress] = key.split('|');
      let formattedAddress = '';
      if (contractAddress && contractAddress.length > 20) {
        formattedAddress = `${contractAddress.slice(0, 7)}...${contractAddress.slice(-6)}`;
      } else {
        formattedAddress = contractAddress || '';
      }
      return {
        eventName: eventName.includes('::') ? eventName.split('::').pop() || eventName : eventName,
        count,
        averageDuration: 0,
        contractAddress: formattedAddress,
      };
    });

    return {
      chain: 'starknet',
      status: percent < 1 ? 'historical' : 'live',
      block: lastBlock,
      rps,
      percent: percent > 1 ? 1 : percent,
      eta,
      mode: percent < 1 ? 'historical' : 'live',
      events,
      health,
    };
  }
}
