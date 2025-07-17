import { StarknetIndexer, LogLevel } from '../src/index';
import { abi } from './abi/ABI';
import { Pool } from 'pg';

const POSTGRES_URL = 'postgresql://postgres:password123@127.0.0.1:6500/app';
const CONTRACT_ADDRESS = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const WS_URL = 'wss://starknet-sepolia.blastapi.io/e2796f65-5df9-4bee-b101-ca89cd850415/rpc/v0_8';
const RPC_URL = 'https://starknet-sepolia.blastapi.io/e2796f65-5df9-4bee-b101-ca89cd850415/rpc/v0_8';
const FROM_BLOCK = 1053700;
const TO_BLOCK = 1696688;

async function truncateTables(pool: Pool) {
  await pool.query('TRUNCATE TABLE events, blocks, indexer_state RESTART IDENTITY CASCADE;');
}

async function getDbSize(pool: Pool): Promise<number> {
  const res = await pool.query(`SELECT pg_database_size(current_database()) as size;`);
  return Number(res.rows[0].size);
}

async function runIndexer(label: string): Promise<{elapsed: number, eventCount: number}> {
  return new Promise((resolve, reject) => {
    let eventCount = 0;
    let currentBlock = FROM_BLOCK;

    const indexer = new StarknetIndexer({
      rpcNodeUrl: RPC_URL,
      wsNodeUrl: WS_URL,
      database: {
        type: 'postgres',
        config: { connectionString: POSTGRES_URL },
      },
      logLevel: LogLevel.INFO ,
      startingBlockNumber: FROM_BLOCK,
      contractAddresses: [CONTRACT_ADDRESS],
    });

    const start = Date.now();
    indexer.onEvent({
      contractAddress: "0x04a41a3bfa29b744aefa1dac436578eb5a7c61edc54c9ffe1ffccb2e97c5a763",
      abi,
      eventName: "stormbit_contracts_cairo::lending_manager::LendingManager::TermInitialized",
      handler: async (event) => {
        console.log("==============DEBUG NOBODY===============");
        console.log(event);
        console.log("==============DEBUG NOBODY===============");
        // eventCount++;
        // currentBlock = event.block_number;
        // if (currentBlock >= TO_BLOCK) {
        //   const elapsed = (Date.now() - start) / 1000;
        //   await indexer.stop();
        //   resolve({ elapsed, eventCount });
        // }
      },
    });

    indexer.start()
  });
}

(async () => {
  const pool = new Pool({ connectionString: POSTGRES_URL });
  try {
    // Cold sync
    await truncateTables(pool);
    console.log('Starting cold sync...');
    const cold = await runIndexer('Cold');
    const dbSize = await getDbSize(pool);

    // Print results
    console.log('\nBenchmark Results:');
    console.log('------------------');
    console.log(`Sync (Cold):  ${cold.elapsed.toFixed(2)}s, Events: ${cold.eventCount}`);
    console.log(`Database Size: ${(dbSize / (1024 * 1024)).toFixed(2)} MB`);
  } catch (err) {
    console.error('Benchmark failed:', err);
  } finally {
    await pool.end();
    process.exit(0);
  }
})(); 