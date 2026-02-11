# Cetus Rebalance Bot (Fixed)

An automated liquidity rebalance bot for Cetus Protocol on the Sui Network. This bot monitors your concentrated liquidity positions and automatically rebalances them when they go out of range, maintaining the same liquidity amount and range width.

## Features

- **Automated Monitoring**: Checks your positions every 30 seconds (configurable)
- **Real Transaction Execution**: Actually executes rebalance transactions on-chain
- **Auto-Rebalancing**: Automatically rebalances positions when they go out of range
- **Same Parameters**: Maintains the same liquidity amount and range width after rebalancing
- **Fee Collection**: Collects fees before rebalancing
- **Safe Execution**: Includes slippage protection and transaction confirmation
- **Transaction Simulation**: Simulates transactions before execution to catch errors early
- **Comprehensive Logging**: Detailed logs for all operations
- **Dry Run Mode**: Monitor-only mode for testing (`REBALANCE_ENABLED=false`)
- **Multiple RPC Support**: Load balancing across multiple RPC endpoints
- **Smart Caching**: Reduces redundant API calls with intelligent pool data caching
- **Automatic Failover**: Automatically retries failed requests with different RPC endpoints

## Prerequisites

- Node.js 18+
- npm or yarn
- A Sui wallet with private key
- SUI tokens for gas fees
- Existing Cetus liquidity positions

## Installation

### 1. Clone or Download the Project

```bash
git clone <repository-url>
cd cetus-rebalance-bot-fixed
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```env
# Required: Your wallet private key (64 hex characters)
PRIVATE_KEY=your_private_key_here

# Required: Network (mainnet or testnet)
NETWORK=mainnet

# RPC URL
RPC_URL=https://fullnode.mainnet.sui.io

# Bot settings
CHECK_INTERVAL_SECONDS=30
SLIPPAGE_PERCENT=0.5
GAS_BUDGET=100000000
REBALANCE_ENABLED=true
LOG_LEVEL=info
```

### 4. Run the Bot

#### Development Mode (with auto-reload)
```bash
npm run dev
```

#### Production Mode
```bash
npm run build
npm start
```

## Configuration Options

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PRIVATE_KEY` | Yes | - | Your Sui wallet private key (64 hex chars) |
| `NETWORK` | Yes | - | Network to connect to (`mainnet` or `testnet`) |
| `RPC_URL` | No | Auto | Single RPC URL to use |
| `RPC_URLS` | No | Auto | Multiple RPC URLs (comma-separated) for failover |
| `CHECK_INTERVAL_SECONDS` | No | 30 | How often to check positions (seconds) |
| `SLIPPAGE_PERCENT` | No | 0.5 | Slippage tolerance for transactions (%) |
| `GAS_BUDGET` | No | 100000000 | Gas budget in MIST (0.1 SUI) |
| `REBALANCE_ENABLED` | No | true | Enable actual rebalancing (false = monitor only) |
| `LOG_LEVEL` | No | info | Logging level (error, warn, info, debug) |

## How It Works

### Rebalance Process

When a position goes out of range, the bot executes the following steps:

1. **Remove Liquidity**: Removes all liquidity from the old position and collects fees
2. **Close Position**: Closes the old position NFT
3. **Open New Position**: Creates a new position centered around the current price
4. **Add Liquidity**: Adds the same liquidity amount to the new position

### Transaction Flow

Each transaction follows this safety flow:

1. **Build Transaction**: Creates the transaction payload using Cetus SDK
2. **Set Gas Budget**: Configures appropriate gas budget
3. **Simulate**: Runs a dry-run simulation to catch errors before spending gas
4. **Sign & Execute**: Signs with your private key and submits to the network
5. **Wait for Confirmation**: Polls until the transaction is confirmed
6. **Verify Result**: Checks transaction effects for success

## Safety Features

### Transaction Simulation
Every transaction is simulated before execution to catch potential errors and save gas costs.

### Slippage Protection
All liquidity operations include slippage protection based on your configured `SLIPPAGE_PERCENT`.

### Gas Budget
Configurable gas budget prevents unexpectedly high transaction costs.

### Dry Run Mode
Set `REBALANCE_ENABLED=false` to monitor positions without executing transactions.

## Logging

Logs are written to both console and `bot.log` file. Log levels:

- `error`: Only errors
- `warn`: Warnings and errors
- `info`: General information (default)
- `debug`: Detailed debugging information

Example log output:
```
[2026-02-11T03:25:07.119Z] INFO: Configured 1 RPC endpoint(s)
[2026-02-11T03:25:07.200Z] INFO: Bot initialized for address: 0x...
[2026-02-11T03:25:09.115Z] INFO: Position 0x... is OUT OF RANGE
[2026-02-11T03:25:09.116Z] INFO: Starting rebalance for position 0x...
[2026-02-11T03:25:09.117Z] INFO: Step 1/4: Removing liquidity from position 0x...
```

## Troubleshooting

### "No SUI coins found for gas"
Make sure your wallet has enough SUI for gas fees. Each rebalance requires ~0.05-0.1 SUI.

### "Transaction simulation failed"
Check that:
- Your position has liquidity
- You have sufficient token balances
- The pool is still active

### "Position not found"
The position might have been closed manually or by another bot instance.

### RPC Errors
If you see RPC errors, try:
- Using multiple RPC URLs with `RPC_URLS`
- Increasing `CHECK_INTERVAL_SECONDS`
- Switching to a different RPC provider

## Security Considerations

⚠️ **WARNING**: This bot requires your private key to sign transactions.

- Never share your private key
- Never commit your `.env` file
- Use a dedicated wallet for the bot
- Only fund the wallet with necessary amounts
- Consider using a hardware wallet for production

## Architecture

```
src/
├── index.ts          # Main bot logic and transaction execution
└── math/
    ├── tick.ts       # Tick math utilities
    ├── clmm.ts       # CLMM pool calculations
    ├── percentage.ts # Slippage percentage handling
    └── position.ts   # Position math utilities
```

## API Reference

### CetusRebalanceBot

#### Constructor
```typescript
new CetusRebalanceBot(config: RebalanceConfig)
```

#### Methods

- `start()`: Start the bot
- `stop()`: Stop the bot
- `getStatus()`: Get current bot status
- `getWalletPositions()`: Get all positions for the wallet
- `isPositionOutOfRange(position)`: Check if a position is out of range
- `rebalancePosition(position)`: Rebalance a single position

## License

MIT

## Disclaimer

This software is provided as-is without any warranties. Use at your own risk. Always test thoroughly on testnet before using on mainnet.
