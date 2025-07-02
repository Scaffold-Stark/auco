import { Account, Contract, RpcProvider } from 'starknet';
import { StarknetEvent, StarknetIndexer } from '../src';
import { universalErc20Abi } from '../test/constants';
const contractAddress = '0x4718F5A0FC34CC1AF16A1CDEE98FFB20C31F5CD61D6AB07201858F4287C938D';

const provider = new RpcProvider({ nodeUrl: 'http://127.0.0.1:5050' });

const indexer = new StarknetIndexer({
  rpcNodeUrl: 'http://127.0.0.1:5050',
  wsNodeUrl: 'ws://127.0.0.1:5050/ws',
  databaseUrl: 'postgresql://postgres:postgres@localhost:5432/starknet_indexer',
  startingBlockNumber: 1,
  contractAddresses: [contractAddress],
});

indexer.start();

(async () => {
  const events: StarknetEvent<
    typeof universalErc20Abi,
    'src::strk::erc20_lockable::ERC20Lockable::Transfer'
  >[] = [];

  indexer.onEvent({
    contractAddress,
    abi: universalErc20Abi,
    eventName: 'src::strk::erc20_lockable::ERC20Lockable::Transfer',
    handler: async (event, poolClient) => {
      console.log('Received event', event);
      events.push(event);

      poolClient.query(
        `
        INSERT INTO events (block_number, transaction_hash, from_address, event_index, keys, data)
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          event.block_number,
          event.transaction_hash,
          event.from_address,
          event.event_index,
          event.keys,
          event.data,
        ]
      );
    },
  });

  const strkContract = new Contract(universalErc20Abi, contractAddress, provider);

  // this would be the first account on devnet
  strkContract.connect(
    new Account(
      provider,
      '0x064b48806902a367c8598f4f95c305e8c1a1acba5f082d294a43793113115691',
      '0x0000000000000000000000000000000071d7bb07b9a64f6f78ac4c816aff4da9'
    )
  );

  // transfer to account 2 in devnet
  await strkContract.transfer(
    '0x078662e7352d062084b0010068b99288486c2d8b914f6e2a55ce945f8792c8b1',
    10n * 10n ** 18n
  );

  await strkContract.transfer(
    '0x078662e7352d062084b0010068b99288486c2d8b914f6e2a55ce945f8792c8b1',
    10n * 10n ** 18n
  );

  // await strkContract.transfer(
  //   '0x078662e7352d062084b0010068b99288486c2d8b914f6e2a55ce945f8792c8b1',
  //   10n * 10n ** 18n
  // );

  // wait for the event to be processed
  await new Promise((resolve) => setTimeout(resolve, 4000));

  // Perform a manual reorg in devnet by aborting blocks from a certain point
  const reorgResponse = await fetch('http://127.0.0.1:5050', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      method: 'devnet_abortBlocks',
      params: {
        starting_block_id: 'latest',
      },
    }),
  });

  await strkContract.transfer(
    '0x078662e7352d062084b0010068b99288486c2d8b914f6e2a55ce945f8792c8b1',
    10n * 10n ** 18n
  );

  await strkContract.transfer(
    '0x078662e7352d062084b0010068b99288486c2d8b914f6e2a55ce945f8792c8b1',
    1000000000000000000n
  );

  if (!reorgResponse.ok) {
    throw new Error(`Failed to trigger reorg: ${await reorgResponse.text()}`);
  }

  console.log('Reorg triggered successfully');

  // wait for the event to be processed
  await new Promise((resolve) => setTimeout(resolve, 4000));

  // check if the event was processed
  console.log(`Total events processed: ${events.length}`);
})();
