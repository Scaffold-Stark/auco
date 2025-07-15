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
