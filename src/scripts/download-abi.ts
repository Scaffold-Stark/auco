#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { RpcProvider } from 'starknet';
import { program } from 'commander';

interface DownloadAbiOptions {
  rpcUrl: string;
  contractAddress: string;
  contractName: string;
  outputDir?: string;
}

async function downloadAbi(options: DownloadAbiOptions) {
  const { rpcUrl, contractAddress, contractName, outputDir = 'generated/abis' } = options;

  // Initialize RPC provider
  const provider = new RpcProvider({
    nodeUrl: rpcUrl,
  });

  try {
    // Get contract class
    const contractClass = await provider.getClassAt(contractAddress);
    const abi = contractClass.abi;

    // Create output directory if it doesn't exist
    const fullOutputDir = path.join(process.cwd(), outputDir);
    if (!fs.existsSync(fullOutputDir)) {
      fs.mkdirSync(fullOutputDir, { recursive: true });
    }

    // Create TypeScript file with ABI export
    const abiPath = path.join(fullOutputDir, `${contractName}.ts`);
    const fileContent = `// Generated ABI for ${contractName}
// Contract Address: ${contractAddress}

export const abi = ${JSON.stringify(abi, null, 2)} as const;

export default abi;
`;
    fs.writeFileSync(abiPath, fileContent);

    console.log(`Successfully downloaded ABI for ${contractName} to ${abiPath}\n`);
    return abi;
  } catch (error) {
    console.error(`Error downloading ABI for ${contractName}:`, error);
    return null;
  }
}

async function downloadAbisFromFile(rpcUrl: string, contractsFile: string, outputDir?: string) {
  try {
    // Read and parse the contracts file
    const contractsContent = fs.readFileSync(contractsFile, 'utf-8');
    const contracts = JSON.parse(contractsContent);

    console.log('\nDownloading ABIs...\n');

    // Download ABIs for all contracts
    for (const [contractName, address] of Object.entries(contracts)) {
      const abi = await downloadAbi({
        rpcUrl,
        contractAddress: address as string,
        contractName,
        outputDir,
      });

      if (!abi) {
        console.error(
          `\x1b[31mError downloading ABI for \x1b[33m\x1b[1m${contractName}\x1b[0m\x1b[31m. Please check that the contract address is correct and make sure it is deployed.\x1b[0m`
        );
        return;
      }
    }

    // Create index file to export all ABIs
    const indexContent = Object.keys(contracts)
      .map(
        (contractName) => `export { default as ${contractName}ABI } from './${contractName}.js';`
      )
      .join('\n');

    const indexPath = path.join(process.cwd(), outputDir || 'generated/abis', 'index.ts');
    fs.writeFileSync(indexPath, indexContent);

    console.log('\x1b[32mAll ABIs downloaded successfully!\x1b[0m');
  } catch (error) {
    console.error('Error downloading ABIs:', error);
    throw error;
  }
}

// CLI setup
program.name('abi-downloader').description('Download ABIs from Starknet contracts').version('1.0.0');

program
  .command('single')
  .description('Download ABI for a single contract')
  .requiredOption('-r, --rpc-url <url>', 'Starknet RPC URL')
  .requiredOption('-a, --address <address>', 'Contract address')
  .requiredOption('-n, --name <name>', 'Contract name')
  .option('-o, --output <dir>', 'Output directory', 'generated/abis')
  .action(async (options) => {
    try {
      await downloadAbi({
        rpcUrl: options.rpcUrl,
        contractAddress: options.address,
        contractName: options.name,
        outputDir: options.output,
      });
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

program
  .command('batch')
  .description('Download ABIs for multiple contracts from a JSON file')
  .requiredOption('-r, --rpc-url <url>', 'Starknet RPC URL')
  .requiredOption('-f, --file <path>', 'Path to JSON file containing contract addresses')
  .option('-o, --output <dir>', 'Output directory', 'generated/abis')
  .action(async (options) => {
    try {
      await downloadAbisFromFile(options.rpcUrl, options.file, options.output);
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

program.parse();
