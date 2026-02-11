import { initCetusSDK, CetusClmmSDK, Position, Pool } from '@cetusprotocol/cetus-sui-clmm-sdk';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import BN from 'bn.js';
import winston from 'winston';
import dotenv from 'dotenv';
import { TickMath } from './math/tick';
import { ClmmPoolUtil } from './math/clmm';
import { Percentage } from './math/percentage';
import { adjustForCoinSlippage } from './math/position';

dotenv.config();

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log' })
  ]
});

interface RebalanceConfig {
  network: 'mainnet' | 'testnet';
  rpcUrls: string[];
  privateKey: string;
  checkIntervalSeconds: number;
  slippagePercent: number;
  rebalanceEnabled: boolean;
  gasBudget: number;
}

interface PositionInfo {
  positionId: string;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  coinTypeA: string;
  coinTypeB: string;
}

class CetusRebalanceBot {
  private sdk: CetusClmmSDK;
  private keypair: Ed25519Keypair;
  private config: RebalanceConfig;
  private isRunning: boolean = false;
  private lastCheckTime: Date | null = null;
  private currentRpcIndex: number = 0;
  private poolCache: Map<string, { pool: Pool; timestamp: number }> = new Map();
  private readonly POOL_CACHE_TTL = 5000; // 5 seconds cache
  // Minimum threshold in raw units (1 = smallest unit, e.g., 1 = 10^-decimals of a full token)
  // This prevents completely zero amounts but allows single-sided positions
  private readonly MIN_LIQUIDITY_THRESHOLD = new BN(1);

  constructor(config: RebalanceConfig) {
    this.config = config;
    
    // Initialize SDK with first RPC URL
    this.sdk = initCetusSDK({
      network: config.network,
      fullNodeUrl: config.rpcUrls[0]
    });

    // Initialize keypair from private key
    const privateKeyHex = config.privateKey.replace('0x', '');
    this.keypair = Ed25519Keypair.fromSecretKey(Buffer.from(privateKeyHex, 'hex'));

    // Set sender address
    this.sdk.senderAddress = this.keypair.getPublicKey().toSuiAddress();
    
    logger.info(`Bot initialized for address: ${this.sdk.senderAddress}`);
    logger.info(`Network: ${config.network}`);
    logger.info(`RPC URLs configured: ${config.rpcUrls.length}`);
    logger.info(`Check interval: ${config.checkIntervalSeconds} seconds`);
    logger.info(`Rebalance enabled: ${config.rebalanceEnabled}`);
    logger.info(`Gas budget: ${config.gasBudget}`);
  }

  /**
   * Get next RPC URL using round-robin
   */
  private getNextRpcUrl(): string {
    const url = this.config.rpcUrls[this.currentRpcIndex];
    this.currentRpcIndex = (this.currentRpcIndex + 1) % this.config.rpcUrls.length;
    return url;
  }

  /**
   * Reinitialize SDK with next RPC URL (for failover)
   */
  private switchToNextRpc(): void {
    const nextUrl = this.getNextRpcUrl();
    logger.info(`Switching to RPC: ${nextUrl}`);
    
    this.sdk = initCetusSDK({
      network: this.config.network,
      fullNodeUrl: nextUrl
    });
    this.sdk.senderAddress = this.keypair.getPublicKey().toSuiAddress();
  }

  /**
   * Get pool with caching and retry logic
   */
  private async getPoolWithCache(poolId: string, maxRetries = 3): Promise<Pool> {
    const cached = this.poolCache.get(poolId);
    if (cached && Date.now() - cached.timestamp < this.POOL_CACHE_TTL) {
      logger.debug(`Using cached pool data for ${poolId}`);
      return cached.pool;
    }

    let lastError: any;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const pool = await this.sdk.Pool.getPool(poolId);
        this.poolCache.set(poolId, { pool, timestamp: Date.now() });
        return pool;
      } catch (error) {
        lastError = error;
        logger.warn(`Failed to fetch pool ${poolId} (attempt ${attempt + 1}/${maxRetries}): ${error}`);
        
        if (attempt < maxRetries - 1) {
          this.switchToNextRpc();
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    
    throw new Error(`Failed to fetch pool after ${maxRetries} attempts: ${lastError}`);
  }

  /**
   * Get all positions owned by the wallet
   */
  async getWalletPositions(): Promise<PositionInfo[]> {
    try {
      logger.info('Fetching wallet positions...');
      
      const positionList = await this.sdk.Position.getPositionList(
        this.sdk.senderAddress,
        []
      );

      if (!positionList || positionList.length === 0) {
        logger.info('No positions found for this wallet');
        return [];
      }

      const positions: PositionInfo[] = [];

      for (const pos of positionList) {
        try {
          const pool = await this.getPoolWithCache(pos.pool);
          
          positions.push({
            positionId: pos.pos_object_id,
            poolId: pos.pool,
            tickLower: Number(pos.tick_lower_index),
            tickUpper: Number(pos.tick_upper_index),
            liquidity: pos.liquidity,
            coinTypeA: pool.coinTypeA,
            coinTypeB: pool.coinTypeB
          });
        } catch (error) {
          logger.error(`Error fetching pool info for position ${pos.pos_object_id}: ${error}`);
        }
      }

      logger.info(`Found ${positions.length} positions`);
      return positions;
    } catch (error) {
      logger.error(`Error fetching wallet positions: ${error}`);
      throw error;
    }
  }

  /**
   * Check if a position is out of range
   */
  async isPositionOutOfRange(position: PositionInfo): Promise<boolean> {
    try {
      const pool = await this.getPoolWithCache(position.poolId);
      const currentTick = Number(pool.current_tick_index);
      
      const isInRange = currentTick >= position.tickLower && currentTick < position.tickUpper;
      
      logger.debug(`Position ${position.positionId}: currentTick=${currentTick}, range=[${position.tickLower}, ${position.tickUpper}], inRange=${isInRange}`);
      
      return !isInRange;
    } catch (error) {
      logger.error(`Error checking position range for ${position.positionId}: ${error}`);
      throw error;
    }
  }

  /**
   * Calculate new tick range centered around current price
   */
  calculateNewTickRange(
    currentTick: number, 
    tickSpacing: number, 
    originalRangeWidth: number
  ): { lowerTick: number; upperTick: number } {
    const halfRange = Math.floor(originalRangeWidth / 2);
    
    let lowerTick = TickMath.getPrevInitializableTickIndex(
      currentTick - halfRange,
      tickSpacing
    );
    
    let upperTick = TickMath.getNextInitializableTickIndex(
      currentTick + halfRange,
      tickSpacing
    );

    lowerTick = Math.floor(lowerTick / tickSpacing) * tickSpacing;
    upperTick = Math.ceil(upperTick / tickSpacing) * tickSpacing;

    return { lowerTick, upperTick };
  }

  /**
   * Execute a transaction with proper signing and simulation
   */
  private async executeTransaction(tx: Transaction, description: string): Promise<{ digest: string; effects?: any }> {
    try {
      logger.info(`Executing transaction: ${description}`);
      
      // Set sender address - CRITICAL: Must be set before building/executing transaction
      tx.setSender(this.sdk.senderAddress);
      
      // Set gas budget
      tx.setGasBudget(this.config.gasBudget);
      
      // Get fresh coins for gas if needed
      const coins = await this.sdk.fullClient.getCoins({
        owner: this.sdk.senderAddress,
        coinType: '0x2::sui::SUI'
      });
      
      if (!coins.data || coins.data.length === 0) {
        throw new Error('No SUI coins found for gas');
      }
      
      // Simulate transaction first
      logger.debug('Simulating transaction...');
      const simulationResult = await this.sdk.fullClient.dryRunTransactionBlock({
        transactionBlock: await tx.build({ client: this.sdk.fullClient })
      });
      
      if (simulationResult.effects.status.status !== 'success') {
        throw new Error(`Transaction simulation failed: ${simulationResult.effects.status.error}`);
      }
      
      logger.debug('Transaction simulation successful');
      
      // Sign and execute the transaction
      const result = await this.sdk.fullClient.signAndExecuteTransaction({
        transaction: tx,
        signer: this.keypair,
        options: {
          showEffects: true,
          showObjectChanges: true,
          showEvents: true
        }
      });
      
      if (!result || !result.digest) {
        throw new Error('Transaction failed: no digest returned');
      }
      
      logger.info(`Transaction executed. Digest: ${result.digest}`);
      
      // Wait for confirmation
      await this.waitForTransaction(result.digest);
      
      return { digest: result.digest, effects: result.effects };
    } catch (error: any) {
      logger.error(`Transaction execution failed: ${error.message || error}`);
      throw error;
    }
  }

  /**
   * Rebalance a single position
   */
  async rebalancePosition(position: PositionInfo): Promise<void> {
    if (!this.config.rebalanceEnabled) {
      logger.info(`Rebalance disabled. Skipping rebalance for position ${position.positionId}`);
      return;
    }

    try {
      logger.info(`=== STARTING REBALANCE FOR POSITION ${position.positionId} ===`);
      
      const pool = await this.getPoolWithCache(position.poolId);
      const currentTick = Number(pool.current_tick_index);
      const tickSpacing = Number(pool.tickSpacing);
      
      const originalRangeWidth = position.tickUpper - position.tickLower;
      
      const { lowerTick, upperTick } = this.calculateNewTickRange(
        currentTick,
        tickSpacing,
        originalRangeWidth
      );

      logger.info(`Current tick: ${currentTick}`);
      logger.info(`New range: [${lowerTick}, ${upperTick}]`);
      logger.info(`Original range width: ${originalRangeWidth}`);

      // Step 1: Remove all liquidity and collect fees
      await this.removeAllLiquidity(position);

      // Step 2: Close the old position
      await this.closePosition(position);

      // Step 3: Open new position
      const newPositionId = await this.openNewPosition(
        position.poolId,
        lowerTick,
        upperTick,
        position.coinTypeA,
        position.coinTypeB
      );

      // Step 4: Add liquidity to new position
      await this.addLiquidityToPosition(
        newPositionId,
        position.poolId,
        position.liquidity,
        lowerTick,
        upperTick,
        position.coinTypeA,
        position.coinTypeB
      );

      logger.info(`=== REBALANCE COMPLETED SUCCESSFULLY ===`);
      logger.info(`New position ID: ${newPositionId}`);
    } catch (error: any) {
      logger.error(`Error rebalancing position ${position.positionId}: ${error.message || error}`);
      throw error;
    }
  }

  /**
   * Remove all liquidity from a position
   */
  private async removeAllLiquidity(position: PositionInfo): Promise<void> {
    try {
      logger.info(`Step 1/4: Removing liquidity from position ${position.positionId}`);
      
      const pool = await this.getPoolWithCache(position.poolId);
      const curSqrtPrice = new BN(pool.current_sqrt_price);
      const lowerSqrtPrice = TickMath.tickIndexToSqrtPriceX64(position.tickLower);
      const upperSqrtPrice = TickMath.tickIndexToSqrtPriceX64(position.tickUpper);
      const liquidity = new BN(position.liquidity);
      
      const slippageTolerance = new Percentage(
        new BN(Math.floor(this.config.slippagePercent * 100)),
        new BN(10000)
      );

      const coinAmounts = ClmmPoolUtil.getCoinAmountFromLiquidity(
        liquidity,
        curSqrtPrice,
        lowerSqrtPrice,
        upperSqrtPrice,
        false
      );

      const { tokenMaxA, tokenMaxB } = adjustForCoinSlippage(
        coinAmounts,
        slippageTolerance,
        false
      );

      const removeLiquidityParams = {
        coinTypeA: position.coinTypeA,
        coinTypeB: position.coinTypeB,
        delta_liquidity: position.liquidity,
        min_amount_a: tokenMaxA.toString(),
        min_amount_b: tokenMaxB.toString(),
        pool_id: position.poolId,
        pos_id: position.positionId,
        rewarder_coin_types: [],
        collect_fee: true
      };

      const tx = await this.sdk.Position.removeLiquidityTransactionPayload(removeLiquidityParams);
      
      await this.executeTransaction(tx, 'Remove Liquidity');
      
      logger.info(`Liquidity removed successfully`);
    } catch (error: any) {
      logger.error(`Error removing liquidity: ${error.message || error}`);
      throw error;
    }
  }

  /**
   * Close a position
   */
  private async closePosition(position: PositionInfo): Promise<void> {
    try {
      logger.info(`Step 2/4: Closing position ${position.positionId}`);
      
      const pool = await this.getPoolWithCache(position.poolId);
      
      let rewardCoinTypes: string[] = [];
      try {
        const rewards = await this.sdk.Rewarder.fetchPositionRewarders(pool, position.positionId);
        rewardCoinTypes = rewards.map((item: any) => item.coin_address);
      } catch (e) {
        logger.warn(`Could not fetch rewarders: ${e}`);
      }

      const closePositionParams = {
        coinTypeA: position.coinTypeA,
        coinTypeB: position.coinTypeB,
        min_amount_a: '0',
        min_amount_b: '0',
        rewarder_coin_types: rewardCoinTypes,
        pool_id: position.poolId,
        pos_id: position.positionId,
        collect_fee: true
      };

      const tx = await this.sdk.Position.closePositionTransactionPayload(closePositionParams);
      
      await this.executeTransaction(tx, 'Close Position');
      
      logger.info(`Position closed successfully`);
    } catch (error: any) {
      logger.error(`Error closing position: ${error.message || error}`);
      throw error;
    }
  }

  /**
   * Open a new position
   */
  private async openNewPosition(
    poolId: string,
    lowerTick: number,
    upperTick: number,
    coinTypeA: string,
    coinTypeB: string
  ): Promise<string> {
    try {
      logger.info(`Step 3/4: Opening new position with range [${lowerTick}, ${upperTick}]`);
      
      const openPositionParams = {
        coinTypeA,
        coinTypeB,
        tick_lower: lowerTick.toString(),
        tick_upper: upperTick.toString(),
        pool_id: poolId
      };

      const tx = await this.sdk.Position.openPositionTransactionPayload(openPositionParams);
      
      const result = await this.executeTransaction(tx, 'Open Position');
      
      // Extract position ID from transaction result
      let newPositionId = '';
      
      if (result.effects && result.effects.created) {
        for (const created of result.effects.created) {
          if (created.reference && created.reference.objectId) {
            try {
              const obj = await this.sdk.fullClient.getObject({
                id: created.reference.objectId,
                options: { showType: true }
              });
              if (obj.data?.type?.includes('Position')) {
                newPositionId = created.reference.objectId;
                break;
              }
            } catch (e) {
              // Continue checking other objects
            }
          }
        }
      }

      if (!newPositionId && result.effects?.created) {
        // Fallback: try to find position in created objects
        for (const created of result.effects.created) {
          if (created.reference?.objectId) {
            newPositionId = created.reference.objectId;
            break;
          }
        }
      }

      if (!newPositionId) {
        throw new Error('Could not find new position ID in transaction result');
      }

      logger.info(`New position opened: ${newPositionId}`);
      return newPositionId;
    } catch (error: any) {
      logger.error(`Error opening new position: ${error.message || error}`);
      throw error;
    }
  }

  /**
   * Apply minimum threshold to avoid completely zero amounts while preserving single-sided positions
   */
  private applyMinimumThreshold(amount: BN, threshold: BN): BN {
    if (amount.isZero()) {
      return new BN(0); // Preserve zero for single-sided positions
    }
    return amount.lt(threshold) ? threshold : amount;
  }

  /**
   * Add liquidity to a position
   */
  private async addLiquidityToPosition(
    positionId: string,
    poolId: string,
    liquidity: string,
    lowerTick: number,
    upperTick: number,
    coinTypeA: string,
    coinTypeB: string
  ): Promise<void> {
    try {
      logger.info(`Step 4/4: Adding liquidity to position ${positionId}`);
      
      const pool = await this.getPoolWithCache(poolId);
      
      // FIX 1: Ensure correct token ordering by using pool's canonical order
      const poolCoinTypeA = pool.coinTypeA;
      const poolCoinTypeB = pool.coinTypeB;
      
      // Use corrected coin types to avoid parameter reassignment issues
      // Note: In normal flow, coinTypes are already from pool (see getWalletPositions method)
      // This validation is a safety check in case of direct API usage
      let correctedCoinTypeA = coinTypeA;
      let correctedCoinTypeB = coinTypeB;
      
      if (coinTypeA !== poolCoinTypeA || coinTypeB !== poolCoinTypeB) {
        // Safety check: ensure input tokens match pool tokens (not just swapped)
        if ((coinTypeA !== poolCoinTypeA && coinTypeA !== poolCoinTypeB) ||
            (coinTypeB !== poolCoinTypeB && coinTypeB !== poolCoinTypeA)) {
          throw new Error(`Invalid coin types. Pool uses ${poolCoinTypeA} and ${poolCoinTypeB}`);
        }
        
        logger.warn(`Token order mismatch detected. Pool expects: A=${poolCoinTypeA}, B=${poolCoinTypeB}`);
        logger.warn(`Correcting to use pool's canonical order...`);
        correctedCoinTypeA = poolCoinTypeA;
        correctedCoinTypeB = poolCoinTypeB;
      }
      
      const curSqrtPrice = new BN(pool.current_sqrt_price);
      const lowerSqrtPrice = TickMath.tickIndexToSqrtPriceX64(lowerTick);
      const upperSqrtPrice = TickMath.tickIndexToSqrtPriceX64(upperTick);
      const liquidityBN = new BN(liquidity);
      
      const slippageTolerance = new Percentage(
        new BN(Math.floor(this.config.slippagePercent * 100)),
        new BN(10000)
      );

      // FIX 3: Use roundUp=true for adding liquidity (calculating max amounts)
      const coinAmounts = ClmmPoolUtil.getCoinAmountFromLiquidity(
        liquidityBN,
        curSqrtPrice,
        lowerSqrtPrice,
        upperSqrtPrice,
        true
      );

      // FIX 3: Use roundUp=true for adding liquidity
      const { tokenMaxA, tokenMaxB } = adjustForCoinSlippage(
        coinAmounts,
        slippageTolerance,
        true
      );

      // FIX 2: Validate amounts are not zero
      // Note: In concentrated liquidity, one amount can be zero if the position is entirely
      // above or below the current price (single-sided liquidity). This is valid.
      if (tokenMaxA.isZero() && tokenMaxB.isZero()) {
        throw new Error('Both token amounts are zero. Cannot add liquidity.');
      }
      
      // Apply minimum threshold only to non-zero amounts
      const safeMaxA = this.applyMinimumThreshold(tokenMaxA, this.MIN_LIQUIDITY_THRESHOLD);
      const safeMaxB = this.applyMinimumThreshold(tokenMaxB, this.MIN_LIQUIDITY_THRESHOLD);

      logger.debug(`Calculated amounts: maxA=${safeMaxA.toString()}, maxB=${safeMaxB.toString()}`);

      const addLiquidityParams = {
        coinTypeA: correctedCoinTypeA,
        coinTypeB: correctedCoinTypeB,
        pool_id: poolId,
        pos_id: positionId,
        tick_lower: lowerTick.toString(),
        tick_upper: upperTick.toString(),
        delta_liquidity: liquidity,
        max_amount_a: safeMaxA.toString(),
        max_amount_b: safeMaxB.toString(),
        collect_fee: false,
        rewarder_coin_types: []
      };

      // SDK handles coin selection and splitting automatically from wallet balance
      // This addresses proper coin management and slippage protection
      const tx = await this.sdk.Position.createAddLiquidityPayload(addLiquidityParams);
      
      await this.executeTransaction(tx, 'Add Liquidity');
      
      logger.info(`Liquidity added successfully`);
    } catch (error: any) {
      logger.error(`Error adding liquidity: ${error.message || error}`);
      throw error;
    }
  }

  /**
   * Wait for a transaction to be confirmed
   */
  private async waitForTransaction(digest: string): Promise<void> {
    let attempts = 0;
    const maxAttempts = 60;
    
    logger.debug(`Waiting for transaction ${digest}...`);
    
    while (attempts < maxAttempts) {
      try {
        const tx = await this.sdk.fullClient.getTransactionBlock({
          digest,
          options: { showEffects: true }
        });
        
        if (tx.effects?.status?.status === 'success') {
          logger.info(`Transaction ${digest.slice(0, 16)}... confirmed`);
          return;
        } else if (tx.effects?.status?.status === 'failure') {
          throw new Error(`Transaction failed: ${tx.effects.status.error}`);
        }
      } catch (error: any) {
        if (error.message?.includes('not found')) {
          // Transaction not found yet, wait and retry
        } else {
          throw error;
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }
    
    throw new Error(`Transaction ${digest} not confirmed after ${maxAttempts} attempts`);
  }

  /**
   * Main check and rebalance loop
   */
  async checkAndRebalance(): Promise<void> {
    try {
      logger.info('=== Starting position check ===');
      this.lastCheckTime = new Date();

      const positions = await this.getWalletPositions();
      
      if (positions.length === 0) {
        logger.info('No positions to check');
        return;
      }

      for (const position of positions) {
        try {
          const isOutOfRange = await this.isPositionOutOfRange(position);
          
          if (isOutOfRange) {
            logger.info(`Position ${position.positionId} is OUT OF RANGE`);
            logger.info(`  Pool: ${position.poolId}`);
            logger.info(`  Current range: [${position.tickLower}, ${position.tickUpper}]`);
            logger.info(`  Liquidity: ${position.liquidity}`);
            
            await this.rebalancePosition(position);
          } else {
            logger.info(`Position ${position.positionId} is IN RANGE`);
          }
        } catch (error: any) {
          logger.error(`Error processing position ${position.positionId}: ${error.message || error}`);
        }
      }

      logger.info('=== Position check completed ===');
    } catch (error: any) {
      logger.error(`Error in checkAndRebalance: ${error.message || error}`);
    }
  }

  /**
   * Start the bot
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Bot is already running');
      return;
    }

    this.isRunning = true;
    logger.info('=== Cetus Rebalance Bot Started ===');
    logger.info('Press Ctrl+C to stop');

    // Run immediately on start (fire-and-forget with error handling)
    this.checkAndRebalance().catch((error) => {
      logger.error(`Unhandled error in initial checkAndRebalance: ${error}`);
    });

    // Schedule periodic checks
    const intervalMs = this.config.checkIntervalSeconds * 1000;
    
    const runCheck = async () => {
      if (!this.isRunning) return;
      await this.checkAndRebalance();
      if (this.isRunning) {
        setTimeout(runCheck, intervalMs);
      }
    };

    setTimeout(runCheck, intervalMs);
  }

  /**
   * Stop the bot
   */
  stop(): void {
    this.isRunning = false;
    logger.info('=== Cetus Rebalance Bot Stopped ===');
  }

  /**
   * Get bot status
   */
  getStatus(): { isRunning: boolean; lastCheckTime: Date | null; address: string } {
    return {
      isRunning: this.isRunning,
      lastCheckTime: this.lastCheckTime,
      address: this.sdk.senderAddress
    };
  }
}

// Main execution
async function main() {
  // Validate environment variables
  const requiredEnvVars = ['PRIVATE_KEY', 'NETWORK'];
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      logger.error(`Missing required environment variable: ${envVar}`);
      process.exit(1);
    }
  }

  // Parse RPC URLs
  let rpcUrls: string[];
  if (process.env.RPC_URLS) {
    rpcUrls = process.env.RPC_URLS.split(',').map(url => url.trim()).filter(url => url.length > 0);
  } else if (process.env.RPC_URL) {
    rpcUrls = [process.env.RPC_URL];
  } else {
    rpcUrls = process.env.NETWORK === 'mainnet'
      ? ['https://fullnode.mainnet.sui.io']
      : ['https://fullnode.testnet.sui.io'];
  }

  // Validate URLs
  const validUrls = rpcUrls.filter(url => {
    try {
      new URL(url);
      return true;
    } catch {
      logger.warn(`Invalid RPC URL ignored: ${url}`);
      return false;
    }
  });

  if (validUrls.length === 0) {
    logger.error('No valid RPC URLs configured');
    process.exit(1);
  }

  logger.info(`Configured ${validUrls.length} RPC endpoint(s)`);

  const config: RebalanceConfig = {
    network: process.env.NETWORK as 'mainnet' | 'testnet',
    rpcUrls: validUrls,
    privateKey: process.env.PRIVATE_KEY!,
    checkIntervalSeconds: parseInt(process.env.CHECK_INTERVAL_SECONDS || '30'),
    slippagePercent: parseFloat(process.env.SLIPPAGE_PERCENT || '0.5'),
    rebalanceEnabled: process.env.REBALANCE_ENABLED !== 'false',
    gasBudget: parseInt(process.env.GAS_BUDGET || '100000000')
  };

  const bot = new CetusRebalanceBot(config);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down...');
    bot.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down...');
    bot.stop();
    process.exit(0);
  });

  // Start the bot
  bot.start();
}

// Run main if this file is executed directly
if (require.main === module) {
  main().catch((error) => {
    logger.error(`Fatal error: ${error}`);
    process.exit(1);
  });
}

export { CetusRebalanceBot, RebalanceConfig, PositionInfo };
