#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { program } from 'commander';
import * as readline from 'readline';

interface CreateOptions {
  name?: string;
  skipPrompts?: boolean;
}

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

function log(message: string) {
  console.log(message);
}

function success(message: string) {
  console.log(`${colors.green}✓${colors.reset} ${message}`);
}

function info(message: string) {
  console.log(`${colors.cyan}ℹ${colors.reset} ${message}`);
}

function warn(message: string) {
  console.log(`${colors.yellow}⚠${colors.reset} ${message}`);
}

function error(message: string) {
  console.log(`${colors.red}✗${colors.reset} ${message}`);
}

async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const defaultHint = defaultValue ? ` ${colors.dim}(${defaultValue})${colors.reset}` : '';
    rl.question(`${colors.cyan}?${colors.reset} ${question}${defaultHint}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function getPackageJsonTemplate(projectName: string): string {
  return JSON.stringify(
    {
      name: projectName,
      version: '0.1.0',
      private: true,
      scripts: {
        dev: 'npx ts-node src/index.ts',
        build: 'tsc',
        start: 'node dist/index.js',
        'db:up': 'docker compose up -d',
        'db:down': 'docker compose down',
        'db:reset': 'docker compose down -v && docker compose up -d',
        'download-abi': 'npx auco-download-abi',
      },
      dependencies: {
        auco: '^0.1.4',
        express: '^4.21.0',
        dotenv: '^16.4.5',
      },
      devDependencies: {
        '@types/express': '^4.17.21',
        '@types/node': '^20.11.0',
        'ts-node': '^10.9.2',
        typescript: '^5.0.0',
      },
    },
    null,
    2
  );
}

function getTsConfigTemplate(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2020',
        module: 'commonjs',
        lib: ['ES2020'],
        outDir: './dist',
        rootDir: './src',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
      },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist'],
    },
    null,
    2
  );
}

function getDockerComposeTemplate(): string {
  return `services:
  postgres:
    image: postgres:16-alpine
    container_name: auco-postgres
    restart: unless-stopped
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: starknet_indexer
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
`;
}

function getEnvTemplate(): string {
  return `# Starknet RPC Configuration
RPC_URL=https://starknet-sepolia-rpc.publicnode.com
WS_URL=wss://starknet-sepolia-rpc.publicnode.com

# Database Configuration
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/starknet_indexer

# Server Configuration
PORT=3000

# Indexer Configuration
STARTING_BLOCK=latest
LOG_LEVEL=info
`;
}

function getEnvExampleTemplate(): string {
  return `# Starknet RPC Configuration
RPC_URL=https://starknet-sepolia-rpc.publicnode.com
WS_URL=wss://starknet-sepolia-rpc.publicnode.com

# Database Configuration
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/starknet_indexer

# Server Configuration
PORT=3000

# Indexer Configuration
# Use 'latest' to start from the latest block, or a specific block number
STARTING_BLOCK=latest
LOG_LEVEL=info
`;
}

function getGitignoreTemplate(): string {
  return `# Dependencies
node_modules/

# Build output
dist/

# Environment files
.env
.env.local
.env.*.local

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*

# Database
*.db
*.sqlite
`;
}

function getExampleAbiTemplate(): string {
  return `// Example ABI for STRK Token on Starknet
// Contract Address: 0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d
// You can download ABIs using: npm run download-abi single -r <RPC_URL> -a <CONTRACT_ADDRESS> -n <NAME>

export const StrkTokenAbi = [
  {
    type: 'struct',
    name: 'core::integer::u256',
    members: [
      { name: 'low', type: 'core::integer::u128' },
      { name: 'high', type: 'core::integer::u128' },
    ],
  },
  {
    type: 'event',
    name: 'src::strk::erc20_lockable::ERC20Lockable::Transfer',
    kind: 'struct',
    members: [
      { name: 'from', type: 'core::starknet::contract_address::ContractAddress', kind: 'data' },
      { name: 'to', type: 'core::starknet::contract_address::ContractAddress', kind: 'data' },
      { name: 'value', type: 'core::integer::u256', kind: 'data' },
    ],
  },
  {
    type: 'event',
    name: 'src::strk::erc20_lockable::ERC20Lockable::Approval',
    kind: 'struct',
    members: [
      { name: 'owner', type: 'core::starknet::contract_address::ContractAddress', kind: 'data' },
      { name: 'spender', type: 'core::starknet::contract_address::ContractAddress', kind: 'data' },
      { name: 'value', type: 'core::integer::u256', kind: 'data' },
    ],
  },
  {
    type: 'event',
    name: 'src::strk::erc20_lockable::ERC20Lockable::Event',
    kind: 'enum',
    variants: [
      { name: 'Transfer', type: 'src::strk::erc20_lockable::ERC20Lockable::Transfer', kind: 'nested' },
      { name: 'Approval', type: 'src::strk::erc20_lockable::ERC20Lockable::Approval', kind: 'nested' },
    ],
  },
] as const;

export default StrkTokenAbi;
`;
}

function getIndexerTemplate(): string {
  return `import 'dotenv/config';
import express, { Request, Response } from 'express';
import { StarknetIndexer, LogLevel } from 'auco';
import { StrkTokenAbi } from './abi/StrkToken';

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

const config = {
  rpcUrl: process.env.RPC_URL || 'https://starknet-sepolia-rpc.publicnode.com',
  wsUrl: process.env.WS_URL || 'wss://starknet-sepolia-rpc.publicnode.com',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/starknet_indexer',
  port: parseInt(process.env.PORT || '3000', 10),
  startingBlock: process.env.STARTING_BLOCK === 'latest' 
    ? 'latest' as const 
    : parseInt(process.env.STARTING_BLOCK || '0', 10),
  logLevel: (process.env.LOG_LEVEL as LogLevel) || LogLevel.INFO,
};

// ═══════════════════════════════════════════════════════════════════════════════
// In-Memory Store (for demo purposes - use database in production)
// ═══════════════════════════════════════════════════════════════════════════════

interface TransferEvent {
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  from: string;
  to: string;
  value: string;
  timestamp: Date;
}

const recentTransfers: TransferEvent[] = [];
const MAX_STORED_TRANSFERS = 100;

// ═══════════════════════════════════════════════════════════════════════════════
// Initialize Indexer
// ═══════════════════════════════════════════════════════════════════════════════

const indexer = new StarknetIndexer({
  rpcNodeUrl: config.rpcUrl,
  wsNodeUrl: config.wsUrl,
  database: {
    type: 'postgres',
    config: {
      connectionString: config.databaseUrl,
    },
  },
  logLevel: config.logLevel,
  startingBlockNumber: config.startingBlock,
});

// ═══════════════════════════════════════════════════════════════════════════════
// Event Handlers
// ═══════════════════════════════════════════════════════════════════════════════

// STRK Token contract address on Sepolia
const STRK_TOKEN_ADDRESS = '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

indexer.onEvent({
  contractAddress: STRK_TOKEN_ADDRESS,
  abi: StrkTokenAbi,
  eventName: 'src::strk::erc20_lockable::ERC20Lockable::Transfer',
  handler: async (event, dbHandler, indexerInstance) => {
    const transfer: TransferEvent = {
      blockNumber: event.block_number,
      blockHash: event.block_hash,
      transactionHash: event.transaction_hash,
      from: String(event.parsed.from),
      to: String(event.parsed.to),
      value: String(event.parsed.value),
      timestamp: new Date(),
    };

    // Store in memory for API access
    recentTransfers.unshift(transfer);
    if (recentTransfers.length > MAX_STORED_TRANSFERS) {
      recentTransfers.pop();
    }

    console.log(\`[Transfer] Block \${event.block_number}: \${transfer.from} → \${transfer.to} (\${transfer.value})\`);

    // You can also store in the database using dbHandler
    // Example: await dbHandler.query('INSERT INTO transfers ...', [...])
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// Express.js API Server
// ═══════════════════════════════════════════════════════════════════════════════

const app = express();
app.use(express.json());

// Health check endpoint
app.get('/health', async (req: Request, res: Response) => {
  try {
    const health = await indexer.healthCheck();
    const status = health.database && health.ws && health.rpc ? 'healthy' : 'degraded';
    res.json({
      status,
      services: health,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: String(error),
      timestamp: new Date().toISOString(),
    });
  }
});

// Get recent transfers
app.get('/api/transfers', (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 10, MAX_STORED_TRANSFERS);
  res.json({
    transfers: recentTransfers.slice(0, limit),
    total: recentTransfers.length,
  });
});

// Get transfer by transaction hash
app.get('/api/transfers/:txHash', (req: Request, res: Response) => {
  const transfer = recentTransfers.find(t => t.transactionHash === req.params.txHash);
  if (transfer) {
    res.json(transfer);
  } else {
    res.status(404).json({ error: 'Transfer not found' });
  }
});

// Get transfers by address (sender or recipient)
app.get('/api/address/:address/transfers', (req: Request, res: Response) => {
  const address = req.params.address.toLowerCase();
  const transfers = recentTransfers.filter(
    t => t.from.toLowerCase() === address || t.to.toLowerCase() === address
  );
  res.json({
    address: req.params.address,
    transfers,
    total: transfers.length,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Start Services
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║                     🚀 Auco Indexer                           ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log('');

  // Start Express server
  app.listen(config.port, () => {
    console.log(\`[Server] API running at http://localhost:\${config.port}\`);
    console.log(\`[Server] Health check: http://localhost:\${config.port}/health\`);
    console.log(\`[Server] Transfers API: http://localhost:\${config.port}/api/transfers\`);
    console.log('');
  });

  // Start the indexer
  console.log('[Indexer] Starting...');
  console.log(\`[Indexer] RPC: \${config.rpcUrl}\`);
  console.log(\`[Indexer] Starting block: \${config.startingBlock}\`);
  console.log('');

  await indexer.start();
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\\n[Shutdown] Received SIGINT, shutting down gracefully...');
  await indexer.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\\n[Shutdown] Received SIGTERM, shutting down gracefully...');
  await indexer.stop();
  process.exit(0);
});

main().catch((err) => {
  console.error('[Fatal] Failed to start:', err);
  process.exit(1);
});
`;
}

function getReadmeTemplate(projectName: string): string {
  return `# ${projectName}

A Starknet indexer built with [Auco](https://github.com/auco/starknet-js-indexer).

## Quick Start

### 1. Install Dependencies

\`\`\`bash
npm install
\`\`\`

### 2. Start PostgreSQL

\`\`\`bash
npm run db:up
\`\`\`

This starts a PostgreSQL instance using Docker Compose.

### 3. Configure Environment

Copy the example environment file and adjust as needed:

\`\`\`bash
cp .env.example .env
\`\`\`

### 4. Run the Indexer

\`\`\`bash
npm run dev
\`\`\`

The indexer will start and:
- Connect to Starknet Sepolia
- Listen for Transfer events from the STRK token
- Expose an API at http://localhost:3000

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| \`GET /health\` | Health check with service status |
| \`GET /api/transfers\` | Get recent transfers (query: \`?limit=10\`) |
| \`GET /api/transfers/:txHash\` | Get transfer by transaction hash |
| \`GET /api/address/:address/transfers\` | Get transfers for an address |

## Project Structure

\`\`\`
${projectName}/
├── src/
│   ├── index.ts          # Main entry point with indexer + Express server
│   └── abi/
│       └── StrkToken.ts  # Example ABI (STRK token)
├── docker-compose.yml    # PostgreSQL configuration
├── .env                  # Environment variables
├── package.json
└── tsconfig.json
\`\`\`

## Commands

| Command | Description |
|---------|-------------|
| \`npm run dev\` | Start the indexer in development mode |
| \`npm run build\` | Build TypeScript to JavaScript |
| \`npm start\` | Start the built application |
| \`npm run db:up\` | Start PostgreSQL container |
| \`npm run db:down\` | Stop PostgreSQL container |
| \`npm run db:reset\` | Reset database (delete all data) |

## Customization

### Adding New Event Handlers

Edit \`src/index.ts\` to add handlers for additional contracts/events:

\`\`\`typescript
import { YourContractAbi } from './abi/YourContract';

indexer.onEvent({
  contractAddress: 'YOUR_CONTRACT_ADDRESS',
  abi: YourContractAbi,
  eventName: 'YourEventName',
  handler: async (event, dbHandler, indexer) => {
    // Process the event
    console.log('Event received:', event.parsed);
  },
});
\`\`\`

### Downloading ABIs

Use the built-in ABI downloader:

\`\`\`bash
npx auco-download-abi single -r https://starknet-sepolia-rpc.publicnode.com -a <CONTRACT_ADDRESS> -n <NAME>
\`\`\`

## Configuration

Environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| \`RPC_URL\` | Starknet RPC endpoint | Sepolia public node |
| \`WS_URL\` | Starknet WebSocket endpoint | Sepolia public node |
| \`DATABASE_URL\` | PostgreSQL connection string | localhost:5432 |
| \`PORT\` | API server port | 3000 |
| \`STARTING_BLOCK\` | Block to start indexing from | latest |
| \`LOG_LEVEL\` | Log verbosity (debug/info/warn/error) | info |

## License

MIT
`;
}

async function createProject(projectPath: string, projectName: string) {
  log('');
  log(`${colors.bright}Creating Auco project in ${colors.cyan}${projectPath}${colors.reset}`);
  log('');

  // Create directories
  const directories = [
    projectPath,
    path.join(projectPath, 'src'),
    path.join(projectPath, 'src', 'abi'),
  ];

  for (const dir of directories) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Write files
  const files: Array<{ path: string; content: string; name: string }> = [
    {
      path: path.join(projectPath, 'package.json'),
      content: getPackageJsonTemplate(projectName),
      name: 'package.json',
    },
    {
      path: path.join(projectPath, 'tsconfig.json'),
      content: getTsConfigTemplate(),
      name: 'tsconfig.json',
    },
    {
      path: path.join(projectPath, 'docker-compose.yml'),
      content: getDockerComposeTemplate(),
      name: 'docker-compose.yml',
    },
    { path: path.join(projectPath, '.env'), content: getEnvTemplate(), name: '.env' },
    {
      path: path.join(projectPath, '.env.example'),
      content: getEnvExampleTemplate(),
      name: '.env.example',
    },
    {
      path: path.join(projectPath, '.gitignore'),
      content: getGitignoreTemplate(),
      name: '.gitignore',
    },
    {
      path: path.join(projectPath, 'README.md'),
      content: getReadmeTemplate(projectName),
      name: 'README.md',
    },
    {
      path: path.join(projectPath, 'src', 'index.ts'),
      content: getIndexerTemplate(),
      name: 'src/index.ts',
    },
    {
      path: path.join(projectPath, 'src', 'abi', 'StrkToken.ts'),
      content: getExampleAbiTemplate(),
      name: 'src/abi/StrkToken.ts',
    },
  ];

  for (const file of files) {
    fs.writeFileSync(file.path, file.content);
    success(`Created ${file.name}`);
  }

  log('');
  success(`${colors.bright}Project created successfully!${colors.reset}`);
  log('');
  log(`${colors.bright}Next steps:${colors.reset}`);
  log('');
  log(`  ${colors.cyan}cd${colors.reset} ${projectName}`);
  log(`  ${colors.cyan}npm${colors.reset} install`);
  log(`  ${colors.cyan}npm run${colors.reset} db:up`);
  log(`  ${colors.cyan}npm run${colors.reset} dev`);
  log('');
  log(`${colors.dim}The indexer will start on http://localhost:3000${colors.reset}`);
  log('');
}

async function run(options: CreateOptions) {
  log('');
  log(
    `${colors.bright}${colors.magenta}╔═══════════════════════════════════════════════════════════════╗${colors.reset}`
  );
  log(
    `${colors.bright}${colors.magenta}║${colors.reset}           ${colors.bright}🔮 Create Auco - Starknet Indexer${colors.reset}                 ${colors.bright}${colors.magenta}║${colors.reset}`
  );
  log(
    `${colors.bright}${colors.magenta}╚═══════════════════════════════════════════════════════════════╝${colors.reset}`
  );
  log('');

  let projectName = options.name;

  if (!projectName && !options.skipPrompts) {
    projectName = await prompt('Project name', 'my-starknet-indexer');
  }

  if (!projectName) {
    projectName = 'my-starknet-indexer';
  }

  // Validate project name
  const validNameRegex = /^[a-zA-Z0-9-_]+$/;
  if (!validNameRegex.test(projectName)) {
    error('Project name can only contain letters, numbers, hyphens, and underscores');
    process.exit(1);
  }

  const projectPath = path.join(process.cwd(), projectName);

  // Check if directory already exists
  if (fs.existsSync(projectPath)) {
    const files = fs.readdirSync(projectPath);
    if (files.length > 0) {
      error(`Directory ${projectName} already exists and is not empty`);
      process.exit(1);
    }
  }

  await createProject(projectPath, projectName);
}

// CLI setup
program
  .name('create-auco')
  .description('Create a new Auco Starknet indexer project')
  .version('0.1.0')
  .argument('[name]', 'Project name')
  .option('-y, --yes', 'Skip prompts and use defaults')
  .action(async (name?: string, opts?: { yes?: boolean }) => {
    try {
      await run({ name, skipPrompts: opts?.yes });
    } catch (err) {
      error(`Failed to create project: ${err}`);
      process.exit(1);
    }
  });

program.parse();
