import { findContractDeploymentBlock } from '../blockUtils';
import { RpcProvider } from 'starknet';

describe('findContractDeploymentBlock', () => {
  // Use public Starknet Sepolia RPC endpoint for testing
  const provider = new RpcProvider({
    nodeUrl: 'https://starknet-sepolia-rpc.publicnode.com',
    specVersion: '0.8.1',
  });

  // Well-known contract on Sepolia testnet
  const deployedContractAddress = '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

  it('should find deployment block for an existing contract', async () => {
    const deploymentBlock = await findContractDeploymentBlock(provider, deployedContractAddress);

    expect(deploymentBlock).toBe(6379);
    expect(typeof deploymentBlock).toBe('number');

    // Verify the contract actually exists at the found block
    const nonce = await provider.getNonceForAddress(deployedContractAddress, deploymentBlock);
    expect(nonce).toBeDefined();
  }, 30000); // Increase timeout for network calls

  it('should throw error when contract is not deployed', async () => {
    // Use an address that doesn't exist (random address)
    const nonExistentAddress = '0x1234567890123456789012345678901234567890123456789012345678901234';

    await expect(
      findContractDeploymentBlock(provider, nonExistentAddress)
    ).rejects.toThrow('Unable to find deployment block for contract');
  }, 30000);

  it('should efficiently find deployment block using binary search', async () => {
    const rpcCallCount = { count: 0 };
    const onRpcRequest = () => {
      rpcCallCount.count++;
    };

    const deploymentBlock = await findContractDeploymentBlock(provider, deployedContractAddress, {
      onRpcRequest,
    });

    expect(deploymentBlock).toBe(6379);
    // Binary search should make O(log n) calls
    // For a typical blockchain with thousands of blocks, should be reasonable
    expect(rpcCallCount.count).toBeGreaterThan(0);
    expect(rpcCallCount.count).toBeLessThan(50); // Should be much less than linear search
  }, 30000);
});

