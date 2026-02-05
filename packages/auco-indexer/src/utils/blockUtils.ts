import { RpcProvider } from 'starknet';

type BlockRange = { from: number; to: number };

export const groupConsecutiveBlocks = (blocks: number[]): BlockRange[] => {
  if (blocks.length === 0) return [];

  const sorted = [...blocks].sort((a, b) => a - b);
  const ranges: BlockRange[] = [];

  let start = sorted[0];
  let end = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push({ from: start, to: end });
      start = sorted[i];
      end = sorted[i];
    }
  }

  ranges.push({ from: start, to: end });
  return ranges;
};

export async function parallelMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array(concurrency).fill(0).map(worker));
  return results;
}

type FindDeploymentOptions = {
  onRpcRequest?: () => void;
};

export async function findContractDeploymentBlock(
  provider: RpcProvider,
  contractAddress: string,
  options: FindDeploymentOptions = {}
): Promise<number> {
  let low = 0;
  let high = await provider.getBlockNumber();

  let foundBlock: number | null = null;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);

    try {
      options.onRpcRequest?.();
      await provider.getNonceForAddress(contractAddress, mid);
      foundBlock = mid;
      high = mid - 1;
    } catch (_error) {
      low = mid + 1;
    }
  }

  if (foundBlock === null) {
    throw new Error(`Unable to find deployment block for contract ${contractAddress}`);
  }

  return foundBlock;
}
