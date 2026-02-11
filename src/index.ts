import { initCetusSDK, CetusClmmSDK, Position, Pool } from '@cetusprotocol/cetus-sui-clmm-sdk';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import BN from 'bn.js';
import winston from 'winston';
import dotenv from 'dotenv';
import { TickMath } from './math/tick';
import { ClmmPoolUtil } from './math/clmm';
import { Percentage } from './math/percentage';
import { adjustForCoinSlippage, getLiquidityFromCoinAmounts } from './math/position';

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
  private isRebalancing: boolean = false; // Prevent concurrent rebalance operations
  private lastCheckTime: Date | null = null;
  private currentRpcIndex: number = 0;
  private poolCache: Map<string, { pool: Pool; timestamp: number }> = new Map();
  private lastRebalanceTimestamp: Map<string, number> = new Map();
  private readonly POOL_CACHE_TTL = 5000; // 5 seconds cache
  private readonly REBALANCE_COOLDOWN_MS = 60000; // 60 seconds minimum between rebalances per position
  // Minimum threshold in raw units (1 = smallest unit, e.g., 1 = 10^-decimals of a full token)
  // This prevents completely zero amounts but allows single-sided positions
  private readonly MIN_LIQUIDITY_THRESHOLD = new BN(1);
  
  // Token balance swap thresholds
  private readonly BALANCE_SUFFICIENT_PERCENT = 95; // Consider balance sufficient if >= 95% of required
  private readonly MAX_SWAP_ATTEMPTS = 2; // Maximum swap attempts to prevent infinite loops
  private readonly SWAP_DEFICIT_BUFFER_PERCENT = 110; // Add 10% buffer when swapping based on deficit
  private readonly MAX_SWAP_PERCENT = 95; // Use max 95% of available balance when capping swap amount

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
  private async executeTransaction(tx: Transaction, description: string): Promise<{ digest: string; effects?: any; objectChanges?: any[]; balanceChanges?: any[] }> {
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
          showEvents: true,
          showBalanceChanges: true
        }
      });
      
      if (!result || !result.digest) {
        throw new Error('Transaction failed: no digest returned');
      }
      
      logger.info(`Transaction executed. Digest: ${result.digest}`);
      
      // Wait for confirmation
      await this.waitForTransaction(result.digest);
      
      return { digest: result.digest, effects: result.effects, objectChanges: result.objectChanges || [], balanceChanges: (result as any).balanceChanges || [] };
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
      logger.info(`Position liquidity: ${position.liquidity}`);
      
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

      const hasLiquidity = new BN(position.liquidity).gt(new BN(0));

      let removedAmountA = new BN(0);
      let removedAmountB = new BN(0);

      // FIX A & B: Only remove liquidity if position has liquidity > 0
      if (hasLiquidity) {
        try {
          // Step 1: Remove all liquidity and collect fees
          const amounts = await this.removeAllLiquidity(position);
          removedAmountA = amounts.amountA;
          removedAmountB = amounts.amountB;
          
          logger.info(`Stored removed amounts - CoinA: ${removedAmountA.toString()}, CoinB: ${removedAmountB.toString()}`);
          
          // Safety check: If either amount is zero, skip rebalance
          // The Move contract repay_add_liquidity requires BOTH amounts > 0; single-sided liquidity causes MoveAbort
          if (removedAmountA.isZero() || removedAmountB.isZero()) {
            logger.warn(`One or both token amounts are zero (CoinA: ${removedAmountA.toString()}, CoinB: ${removedAmountB.toString()})`);
            logger.warn(`Skipping rebalance: Move contract requires both token amounts > 0 for add_liquidity`);
            
            // Still need to close the position since we already removed liquidity
            try {
              await this.closePosition(position);
            } catch (error: any) {
              logger.error(`Error closing position: ${error.message || error}`);
            }
            return;
          }
        } catch (error: any) {
          logger.error(`Error removing liquidity: ${error.message || error}`);
          throw error;
        }

        try {
          // Step 2: Close the old position
          await this.closePosition(position);
        } catch (error: any) {
          logger.error(`Error closing position: ${error.message || error}`);
          throw error;
        }
      } else {
        logger.info(`Position has zero liquidity, skipping remove_liquidity and close_position steps`);
        logger.warn(`No liquidity to rebalance, aborting rebalance operation`);
        return;
      }

      // Step 3: Open new position
      let newPositionId: string;
      try {
        newPositionId = await this.openNewPosition(
          position.poolId,
          lowerTick,
          upperTick,
          position.coinTypeA,
          position.coinTypeB
        );
      } catch (error: any) {
        logger.error(`Error opening new position: ${error.message || error}`);
        throw error;
      }

      // Step 3.5: Check wallet balances and perform swap if needed
      let finalAmountA = removedAmountA;
      let finalAmountB = removedAmountB;
      
      try {
        logger.info(`Step 3.5: Checking token balance and performing swap if needed`);
        
        // Get current wallet balances
        let walletBalanceA = await this.getWalletBalance(position.coinTypeA);
        let walletBalanceB = await this.getWalletBalance(position.coinTypeB);
        
        logger.info(`Current wallet balances - CoinA: ${walletBalanceA.toString()}, CoinB: ${walletBalanceB.toString()}`);
        
        // Calculate optimal amounts that can be deposited based on current balances and price
        const { optimalA, optimalB } = this.calculateOptimalAmountsFromBalances(
          pool,
          lowerTick,
          upperTick,
          walletBalanceA,
          walletBalanceB
        );
        
        logger.info(`Optimal amounts for new range - CoinA: ${optimalA.toString()}, CoinB: ${optimalB.toString()}`);
        
        // Check if we need to swap (only swap if we can't meet the optimal ratio)
        // Swap is needed if our current balance is insufficient (< 95% of optimal)
        const needsSwap = !this.isBalanceSufficient(walletBalanceA, optimalA) || 
                         !this.isBalanceSufficient(walletBalanceB, optimalB);
        
        if (needsSwap) {
          let swapAttempts = 0;
          
          while (swapAttempts < this.MAX_SWAP_ATTEMPTS) {
            swapAttempts++;
            logger.info(`Swap attempt ${swapAttempts}/${this.MAX_SWAP_ATTEMPTS}`);
            
            // Perform swap
            const swapResult = await this.performRebalanceSwap(
              position.poolId,
              position.coinTypeA,
              position.coinTypeB,
              walletBalanceA,
              walletBalanceB,
              optimalA,
              optimalB,
              currentTick,
              lowerTick,
              upperTick
            );
            
            walletBalanceA = swapResult.newBalanceA;
            walletBalanceB = swapResult.newBalanceB;
            
            // Check if balances are now sufficient
            const balanceASufficient = this.isBalanceSufficient(walletBalanceA, optimalA);
            const balanceBSufficient = this.isBalanceSufficient(walletBalanceB, optimalB);
            
            if (balanceASufficient && balanceBSufficient) {
              logger.info('Token balances are now sufficient after swap');
              break;
            }
            
            if (swapAttempts < this.MAX_SWAP_ATTEMPTS) {
              logger.info('Balances still insufficient, will attempt another swap');
            } else {
              logger.warn('Reached maximum swap attempts, proceeding with current balances');
            }
          }
          
          // Use wallet balances after swap
          finalAmountA = walletBalanceA;
          finalAmountB = walletBalanceB;
        } else {
          logger.info('Token balances are sufficient for optimal ratio, no swap needed');
          // Balances are sufficient - use wallet balances for adding liquidity
          finalAmountA = walletBalanceA;
          finalAmountB = walletBalanceB;
        }
      } catch (error: any) {
        logger.error(`Error during balance check/swap: ${error.message || error}`);
        logger.error('Swap failed — aborting rebalance to prevent token imbalance issues');
        logger.warn(`New position ${newPositionId} was created but has no liquidity added`);
        return;
      }

      // Step 4: Add liquidity to new position using final amounts
      try {
        await this.addLiquidityToPosition(
          newPositionId,
          position.poolId,
          lowerTick,
          upperTick,
          position.coinTypeA,
          position.coinTypeB,
          finalAmountA,
          finalAmountB
        );
      } catch (error: any) {
        logger.error(`Error adding liquidity: ${error.message || error}`);
        throw error;
      }

      logger.info(`=== REBALANCE COMPLETED SUCCESSFULLY ===`);
      logger.info(`New position ID: ${newPositionId}`);
    } catch (error: any) {
      logger.error(`Error rebalancing position ${position.positionId}: ${error.message || error}`);
      throw error;
    }
  }

  /**
   * Remove all liquidity from a position
   * Returns the exact token amounts that were removed
   */
  private async removeAllLiquidity(position: PositionInfo): Promise<{ amountA: BN; amountB: BN }> {
    try {
      logger.info(`Step 1/4: Removing liquidity from position ${position.positionId}`);
      
      // FIX E: Log liquidity before removal
      const liquidityBN = new BN(position.liquidity);
      logger.info(`Position liquidity (raw): ${position.liquidity}`);
      logger.info(`Position liquidity (BN): ${liquidityBN.toString()}`);
      
      // FIX B: Verify liquidity is not zero
      if (liquidityBN.isZero()) {
        throw new Error('Cannot remove liquidity: position liquidity is zero');
      }
      
      const pool = await this.getPoolWithCache(position.poolId);
      const curSqrtPrice = new BN(pool.current_sqrt_price);
      const lowerSqrtPrice = TickMath.tickIndexToSqrtPriceX64(position.tickLower);
      const upperSqrtPrice = TickMath.tickIndexToSqrtPriceX64(position.tickUpper);
      
      const slippageTolerance = new Percentage(
        new BN(Math.floor(this.config.slippagePercent * 100)),
        new BN(10000)
      );

      const coinAmounts = ClmmPoolUtil.getCoinAmountFromLiquidity(
        liquidityBN,
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

      // FIX E: Log calculated amounts
      logger.debug(`Calculated min amounts: A=${tokenMaxA.toString()}, B=${tokenMaxB.toString()}`);

      // Store the exact expected amounts (without slippage) that will be returned
      const expectedAmountA = coinAmounts.coinA;
      const expectedAmountB = coinAmounts.coinB;
      
      logger.info(`Expected token amounts to be returned - CoinA: ${expectedAmountA.toString()}, CoinB: ${expectedAmountB.toString()}`);

      const removeLiquidityParams = {
        coinTypeA: position.coinTypeA,
        coinTypeB: position.coinTypeB,
        delta_liquidity: position.liquidity, // FIX B: Use exact liquidity as string (u128 compatible)
        min_amount_a: tokenMaxA.toString(),
        min_amount_b: tokenMaxB.toString(),
        pool_id: position.poolId,
        pos_id: position.positionId,
        rewarder_coin_types: [],
        collect_fee: true
      };

      // FIX E: Log transaction inputs
      logger.debug(`Remove liquidity params: ${JSON.stringify({
        delta_liquidity: removeLiquidityParams.delta_liquidity,
        min_amount_a: removeLiquidityParams.min_amount_a,
        min_amount_b: removeLiquidityParams.min_amount_b
      })}`);

      const tx = await this.sdk.Position.removeLiquidityTransactionPayload(removeLiquidityParams);
      
      const result = await this.executeTransaction(tx, 'Remove Liquidity');
      
      logger.info(`Liquidity removed successfully`);
      
      // PART 1 FIX: Parse on-chain balanceChanges to get real returned amounts
      // Do NOT rely on math calculations — only trust on-chain data
      let onChainAmountA = new BN(0);
      let onChainAmountB = new BN(0);
      
      try {
        // Fetch full transaction block with balance changes
        const txBlock = await this.sdk.fullClient.getTransactionBlock({
          digest: result.digest,
          options: { showEffects: true, showBalanceChanges: true }
        });
        
        const balanceChanges = (txBlock as any).balanceChanges || result.balanceChanges || [];
        logger.info(`Balance changes count: ${balanceChanges.length}`);
        
        for (const change of balanceChanges) {
          // Only consider positive changes to our wallet (tokens returned to us)
          const amount = BigInt(change.amount || '0');
          if (amount <= BigInt(0)) continue;
          
          const coinType = change.coinType || '';
          
          // Normalize coin type for comparison (remove leading 0x if needed)
          const normalizedCoinType = coinType.replace(/^0x0*/, '0x');
          const normalizedCoinTypeA = position.coinTypeA.replace(/^0x0*/, '0x');
          const normalizedCoinTypeB = position.coinTypeB.replace(/^0x0*/, '0x');
          
          if (normalizedCoinType === normalizedCoinTypeA) {
            onChainAmountA = onChainAmountA.add(new BN(amount.toString()));
            logger.info(`Detected CoinA balance change: +${amount.toString()}`);
          } else if (normalizedCoinType === normalizedCoinTypeB) {
            onChainAmountB = onChainAmountB.add(new BN(amount.toString()));
            logger.info(`Detected CoinB balance change: +${amount.toString()}`);
          }
        }
        
        logger.info(`On-chain removed amounts - CoinA: ${onChainAmountA.toString()}, CoinB: ${onChainAmountB.toString()}`);
      } catch (parseError: any) {
        logger.warn(`Failed to parse balance changes: ${parseError.message || parseError}`);
        logger.warn(`Falling back to calculated amounts`);
      }
      
      // Use on-chain amounts if available, otherwise fall back to calculated amounts
      const finalAmountA = onChainAmountA.gt(new BN(0)) ? onChainAmountA : expectedAmountA;
      const finalAmountB = onChainAmountB.gt(new BN(0)) ? onChainAmountB : expectedAmountB;
      
      logger.info(`Final removed amounts - CoinA: ${finalAmountA.toString()}, CoinB: ${finalAmountB.toString()}`);
      
      return { amountA: finalAmountA, amountB: finalAmountB };
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
      
      // Extract the newly created position object ID directly from transaction effects
      // Cetus mints the position as an object owned by another object (not address-owned),
      // so we extract it from objectChanges instead of trying to fetch via getOwnedObjects
      logger.debug('Extracting position object ID from transaction effects...');
      
      if (!result.objectChanges || result.objectChanges.length === 0) {
        throw new Error('Failed to retrieve position from transaction: no object changes returned. This may indicate the transaction did not complete successfully.');
      }
      
      // Find the created object whose type matches the Cetus Position type
      // Note: Position types include type parameters like Position<CoinA, CoinB>
      let newPositionId = '';
      const expectedPositionTypePrefix = `${this.sdk.sdkOptions.clmm_pool.package_id}::position::Position`;
      for (const change of result.objectChanges) {
        if (
          change.type === 'created' &&
          change.objectType &&
          change.objectType.startsWith(expectedPositionTypePrefix)
        ) {
          newPositionId = change.objectId;
          logger.info(`Found newly created position object: ${newPositionId}`);
          break;
        }
      }
      
      if (!newPositionId) {
        const foundTypes = result.objectChanges.map(c => c.objectType || 'unknown').join(', ');
        throw new Error(`Could not find Position object in transaction object changes. Expected type prefix: ${expectedPositionTypePrefix}. Found types: ${foundTypes}`);
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
   * Check if balance is sufficient (>= required amount × BALANCE_SUFFICIENT_PERCENT)
   * Uses division to avoid potential overflow with large values
   */
  private isBalanceSufficient(balance: BN, required: BN): boolean {
    if (required.isZero()) {
      return true;
    }
    // Check if balance >= required * 0.95
    // Equivalent to: balance >= required * 95 / 100
    return balance.gte(required.muln(this.BALANCE_SUFFICIENT_PERCENT).divn(100));
  }

  /**
   * Get wallet balance for a specific coin type
   */
  private async getWalletBalance(coinType: string): Promise<BN> {
    try {
      const coins = await this.sdk.fullClient.getCoins({
        owner: this.sdk.senderAddress,
        coinType
      });
      
      if (!coins.data || coins.data.length === 0) {
        return new BN(0);
      }
      
      // Sum up all coin objects
      let totalBalance = new BN(0);
      for (const coin of coins.data) {
        totalBalance = totalBalance.add(new BN(coin.balance));
      }
      
      return totalBalance;
    } catch (error: any) {
      logger.error(`Error fetching wallet balance for ${coinType}: ${error.message || error}`);
      throw error;
    }
  }

  /**
   * Calculate optimal token amounts for a new position range based on current wallet balances
   * This determines the ratio and amounts that can be deposited given available tokens
   */
  private calculateOptimalAmountsFromBalances(
    pool: Pool,
    lowerTick: number,
    upperTick: number,
    balanceA: BN,
    balanceB: BN
  ): { optimalA: BN; optimalB: BN } {
    const curSqrtPrice = new BN(pool.current_sqrt_price);
    const lowerSqrtPrice = TickMath.tickIndexToSqrtPriceX64(lowerTick);
    const upperSqrtPrice = TickMath.tickIndexToSqrtPriceX64(upperTick);
    
    // Calculate liquidity from available balances
    const liquidityBN = getLiquidityFromCoinAmounts(
      balanceA,
      balanceB,
      lowerSqrtPrice,
      upperSqrtPrice,
      curSqrtPrice
    );
    
    // Calculate exact amounts needed for this liquidity
    const coinAmounts = ClmmPoolUtil.getCoinAmountFromLiquidity(
      liquidityBN,
      curSqrtPrice,
      lowerSqrtPrice,
      upperSqrtPrice,
      false // Use roundUp=false to get exact amounts
    );
    
    return {
      optimalA: coinAmounts.coinA,
      optimalB: coinAmounts.coinB
    };
  }

  /**
   * Perform a swap to rebalance token amounts
   * Uses half-value logic when price is inside the range
   */
  private async performRebalanceSwap(
    poolId: string,
    coinTypeA: string,
    coinTypeB: string,
    balanceA: BN,
    balanceB: BN,
    optimalA: BN,
    optimalB: BN,
    currentTick: number,
    lowerTick: number,
    upperTick: number
  ): Promise<{ newBalanceA: BN; newBalanceB: BN }> {
    try {
      logger.info('=== TOKEN IMBALANCE DETECTED ===');
      logger.info(`Wallet Balance - CoinA: ${balanceA.toString()}, CoinB: ${balanceB.toString()}`);
      logger.info(`Optimal Amount - CoinA: ${optimalA.toString()}, CoinB: ${optimalB.toString()}`);
      
      // Determine swap direction and amount
      let swapAtoB: boolean;
      let swapAmount: BN;
      
      // Check if price is inside the range
      const priceInsideRange = currentTick >= lowerTick && currentTick < upperTick;
      
      if (priceInsideRange) {
        // PART 3: Smart ratio logic — compute approximate values using pool price
        // Use sqrtPrice to estimate price: price ≈ (sqrtPrice / 2^64)^2
        // For value comparison, we use a simplified approach:
        // valueA ≈ balanceA * price, valueB ≈ balanceB (price denominated in B)
        const pool = await this.getPoolWithCache(poolId);
        const curSqrtPrice = new BN(pool.current_sqrt_price);
        
        // Approximate price as a rational number: price ≈ sqrtPrice^2 / 2^128
        // valueA (in B terms) ≈ balanceA * sqrtPrice^2 / 2^128
        // valueB (in B terms) ≈ balanceB
        // To avoid overflow, use: valueA_scaled = balanceA * (sqrtPrice / 2^64) * (sqrtPrice / 2^64)
        // We'll scale down to prevent BN overflow
        const sqrtPriceHigh = curSqrtPrice.shrn(32); // scale down for safe multiplication
        const valueAScaled = balanceA.mul(sqrtPriceHigh).mul(sqrtPriceHigh).shrn(64); // final shift for 2^(32+32) = 2^64 remaining
        const valueBScaled = balanceB.shln(0); // no scaling needed
        
        const totalValue = valueAScaled.add(valueBScaled);
        const targetValueEach = totalValue.divn(2);
        
        logger.info(`Price inside range - smart ratio logic`);
        logger.info(`ValueA (scaled): ${valueAScaled.toString()}, ValueB (scaled): ${valueBScaled.toString()}`);
        logger.info(`Total value: ${totalValue.toString()}, Target each: ${targetValueEach.toString()}`);
        
        // 1% safety buffer: only swap 99% of the excess
        const SAFETY_BUFFER_PERCENT = 99;
        
        if (valueAScaled.gt(targetValueEach)) {
          // Excess A, swap A -> B
          swapAtoB = true;
          const excessValue = valueAScaled.sub(targetValueEach);
          // Convert excess value back to token A amount: excessA = excessValue / price
          // excessA = excessValue * 2^64 / (sqrtPriceHigh^2) — but we need to avoid division by zero
          const priceFactor = sqrtPriceHigh.mul(sqrtPriceHigh);
          if (priceFactor.isZero()) {
            logger.warn('Cannot compute swap amount: price factor is zero');
            return { newBalanceA: balanceA, newBalanceB: balanceB };
          }
          swapAmount = excessValue.shln(64).div(priceFactor).muln(SAFETY_BUFFER_PERCENT).divn(100);
          
          // Cap swap to never exceed available balance
          if (swapAmount.gt(balanceA)) {
            swapAmount = balanceA.muln(this.MAX_SWAP_PERCENT).divn(100);
          }
          logger.info(`Swapping CoinA -> CoinB, amount: ${swapAmount.toString()}`);
        } else if (valueBScaled.gt(targetValueEach)) {
          // Excess B, swap B -> A
          swapAtoB = false;
          const excessValue = valueBScaled.sub(targetValueEach);
          // excessB is directly the excess value (already in B terms)
          swapAmount = excessValue.muln(SAFETY_BUFFER_PERCENT).divn(100);
          
          // Cap swap to never exceed available balance
          if (swapAmount.gt(balanceB)) {
            swapAmount = balanceB.muln(this.MAX_SWAP_PERCENT).divn(100);
          }
          logger.info(`Swapping CoinB -> CoinA, amount: ${swapAmount.toString()}`);
        } else {
          logger.info('Token values are balanced, no swap needed');
          return { newBalanceA: balanceA, newBalanceB: balanceB };
        }
      } else if (optimalA.gt(balanceA)) {
        // Price outside range: Need more A, swap B -> A
        swapAtoB = false;
        const deficit = optimalA.sub(balanceA);
        swapAmount = deficit.muln(this.SWAP_DEFICIT_BUFFER_PERCENT).divn(100);
        logger.info(`Price outside range - deficit-based swap`);
        logger.info(`Swapping CoinB -> CoinA, amount: ${swapAmount.toString()}`);
      } else if (optimalB.gt(balanceB)) {
        // Price outside range: Need more B, swap A -> B
        swapAtoB = true;
        const deficit = optimalB.sub(balanceB);
        swapAmount = deficit.muln(this.SWAP_DEFICIT_BUFFER_PERCENT).divn(100);
        logger.info(`Price outside range - deficit-based swap`);
        logger.info(`Swapping CoinA -> CoinB, amount: ${swapAmount.toString()}`);
      } else {
        // No swap needed - balances are sufficient
        logger.info('Token balances are sufficient, no swap needed');
        return { newBalanceA: balanceA, newBalanceB: balanceB };
      }
      
      // Safety check: ensure swap amount is positive and not too large
      if (swapAmount.lte(new BN(0))) {
        logger.warn('Calculated swap amount is zero or negative, skipping swap');
        return { newBalanceA: balanceA, newBalanceB: balanceB };
      }
      
      const availableAmount = swapAtoB ? balanceA : balanceB;
      if (swapAmount.gt(availableAmount)) {
        logger.warn(`Swap amount ${swapAmount.toString()} exceeds available balance ${availableAmount.toString()}, capping to available`);
        swapAmount = availableAmount.muln(this.MAX_SWAP_PERCENT).divn(100);
      }
      
      // Perform the swap
      const slippageTolerance = new Percentage(
        new BN(Math.floor(this.config.slippagePercent * 100)),
        new BN(10000)
      );
      
      // Calculate amount limit with slippage (minimum output)
      const amountLimit = slippageTolerance.subtractFrom(swapAmount);
      
      const swapParams = {
        pool_id: poolId,
        coinTypeA,
        coinTypeB,
        a2b: swapAtoB,
        by_amount_in: true,
        amount: swapAmount.toString(),
        amount_limit: amountLimit.toString()
      };
      
      logger.info(`Executing swap transaction...`);
      const swapTx = await this.sdk.Swap.createSwapTransactionPayload(swapParams);
      await this.executeTransaction(swapTx, 'Swap Tokens');
      
      logger.info('Swap completed successfully');
      
      // Fetch updated balances
      const newBalanceA = await this.getWalletBalance(coinTypeA);
      const newBalanceB = await this.getWalletBalance(coinTypeB);
      
      logger.info(`Updated Balance - CoinA: ${newBalanceA.toString()}, CoinB: ${newBalanceB.toString()}`);
      
      return { newBalanceA, newBalanceB };
    } catch (error: any) {
      logger.error(`Error performing rebalance swap: ${error.message || error}`);
      throw error;
    }
  }

  /**
   * Add liquidity to a position using exact token amounts
   */
  private async addLiquidityToPosition(
    positionId: string,
    poolId: string,
    lowerTick: number,
    upperTick: number,
    coinTypeA: string,
    coinTypeB: string,
    amountA: BN,
    amountB: BN
  ): Promise<void> {
    try {
      logger.info(`Step 4/4: Adding liquidity to position ${positionId}`);
      
      const pool = await this.getPoolWithCache(poolId);
      
      // Ensure correct token ordering by using pool's canonical order
      const poolCoinTypeA = pool.coinTypeA;
      const poolCoinTypeB = pool.coinTypeB;
      
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
      
      // Fetch current pool state
      const curSqrtPrice = new BN(pool.current_sqrt_price);
      const currentTick = Number(pool.current_tick_index);
      const lowerSqrtPrice = TickMath.tickIndexToSqrtPriceX64(lowerTick);
      const upperSqrtPrice = TickMath.tickIndexToSqrtPriceX64(upperTick);
      
      logger.info(`Current pool tick: ${currentTick}`);
      logger.info(`Position range: [${lowerTick}, ${upperTick}]`);
      logger.info(`Current sqrtPrice: ${curSqrtPrice.toString()}`);
      logger.info(`Using exact token amounts - CoinA: ${amountA.toString()}, CoinB: ${amountB.toString()}`);
      
      // Safety check: The Move contract requires both amounts > 0
      // This is a defensive check in case this function is called directly
      if (amountA.isZero() || amountB.isZero()) {
        logger.warn(`Skipping add_liquidity: One or both amounts are zero - Move contract requires both > 0`);
        return;
      }
      
      // Calculate liquidity from the exact token amounts provided
      // Add safety check to prevent division by zero
      let liquidityBN: BN;
      try {
        liquidityBN = getLiquidityFromCoinAmounts(
          amountA,
          amountB,
          lowerSqrtPrice,
          upperSqrtPrice,
          curSqrtPrice
        );
      } catch (error: any) {
        logger.error(`Error calculating liquidity from coin amounts: ${error.message || error}`);
        logger.warn(`Skipping add_liquidity due to calculation error`);
        return;
      }
      
      logger.info(`Calculated liquidity from exact amounts: ${liquidityBN.toString()}`);
      
      if (liquidityBN.isZero()) {
        logger.warn(`Skipping add_liquidity: Calculated liquidity is zero`);
        return;
      }
      
      // Calculate token amounts needed for this liquidity
      const slippageTolerance = new Percentage(
        new BN(Math.floor(this.config.slippagePercent * 100)),
        new BN(10000)
      );

      // Use roundUp=true for adding liquidity (calculating max amounts)
      const coinAmounts = ClmmPoolUtil.getCoinAmountFromLiquidity(
        liquidityBN,
        curSqrtPrice,
        lowerSqrtPrice,
        upperSqrtPrice,
        true
      );

      logger.info(`Token amounts from liquidity - CoinA: ${coinAmounts.coinA.toString()}, CoinB: ${coinAmounts.coinB.toString()}`);

      // Apply slippage tolerance (roundUp=true for adding liquidity)
      const { tokenMaxA, tokenMaxB } = adjustForCoinSlippage(
        coinAmounts,
        slippageTolerance,
        true
      );

      // Apply minimum threshold only to non-zero amounts
      const safeMaxA = this.applyMinimumThreshold(tokenMaxA, this.MIN_LIQUIDITY_THRESHOLD);
      const safeMaxB = this.applyMinimumThreshold(tokenMaxB, this.MIN_LIQUIDITY_THRESHOLD);

      logger.info(`Final amounts with slippage - CoinA: ${safeMaxA.toString()}, CoinB: ${safeMaxB.toString()}`);

      // Validate both amounts are greater than zero before building transaction
      // The Move contract (repay_add_liquidity) requires both amounts to be > 0
      if (safeMaxA.lte(new BN(0)) || safeMaxB.lte(new BN(0))) {
        logger.warn(`Skipping add_liquidity: amountA=${safeMaxA.toString()}, amountB=${safeMaxB.toString()} - Move contract requires both amounts > 0`);
        return;
      }

      const addLiquidityParams = {
        coinTypeA: correctedCoinTypeA,
        coinTypeB: correctedCoinTypeB,
        pool_id: poolId,
        pos_id: positionId,
        tick_lower: lowerTick.toString(),
        tick_upper: upperTick.toString(),
        delta_liquidity: liquidityBN.toString(),
        max_amount_a: safeMaxA.toString(),
        max_amount_b: safeMaxB.toString(),
        collect_fee: false,
        rewarder_coin_types: []
      };

      logger.debug(`Add liquidity params: ${JSON.stringify({
        delta_liquidity: addLiquidityParams.delta_liquidity,
        max_amount_a: addLiquidityParams.max_amount_a,
        max_amount_b: addLiquidityParams.max_amount_b,
        tick_lower: addLiquidityParams.tick_lower,
        tick_upper: addLiquidityParams.tick_upper
      })}`);

      // SDK handles coin selection and splitting automatically from wallet balance
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
    const maxRetries = 10;
    
    logger.debug(`Waiting for transaction ${digest}...`);
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
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
        // Check if this is the specific RPC indexing error
        if (error.message?.includes('Could not find the referenced transaction')) {
          // Transaction not indexed yet, retry after delay
          if (attempt < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500));
            continue;
          } else {
            // Last attempt failed, throw the error
            throw new Error(`Transaction ${digest} not confirmed after ${maxRetries} attempts`);
          }
        } else {
          // For any other error, throw immediately
          throw error;
        }
      }
    }
    
    throw new Error(`Transaction ${digest} not confirmed after ${maxRetries} attempts`);
  }

  /**
   * Main check and rebalance loop
   */
  async checkAndRebalance(): Promise<void> {
    // FIX C: Prevent concurrent execution
    if (this.isRebalancing) {
      logger.warn('Rebalance operation already in progress, skipping this cycle');
      return;
    }

    this.isRebalancing = true;

    try {
      logger.info('=== Starting position check ===');
      this.lastCheckTime = new Date();

      const positions = await this.getWalletPositions();
      
      if (positions.length === 0) {
        logger.info('No positions to check');
        return;
      }

      // FIX F: Wrap each position in try/catch for production safety
      for (const position of positions) {
        try {
          const isOutOfRange = await this.isPositionOutOfRange(position);
          
          if (isOutOfRange) {
            logger.info(`Position ${position.positionId} is OUT OF RANGE`);
            logger.info(`  Pool: ${position.poolId}`);
            logger.info(`  Current range: [${position.tickLower}, ${position.tickUpper}]`);
            logger.info(`  Liquidity: ${position.liquidity}`);
            
            // PART 4: Enforce per-position cooldown to prevent infinite loops
            const lastRebalance = this.lastRebalanceTimestamp.get(position.positionId);
            if (lastRebalance && (Date.now() - lastRebalance) < this.REBALANCE_COOLDOWN_MS) {
              const remainingSec = Math.ceil((this.REBALANCE_COOLDOWN_MS - (Date.now() - lastRebalance)) / 1000);
              logger.warn(`Position ${position.positionId} is in cooldown (${remainingSec}s remaining), skipping rebalance`);
              continue;
            }
            
            // FIX C: Early check for zero liquidity to avoid unnecessary work
            // (rebalancePosition also checks this, but this saves a function call)
            if (new BN(position.liquidity).isZero()) {
              logger.warn(`Position ${position.positionId} has zero liquidity, skipping rebalance`);
              continue;
            }
            
            await this.rebalancePosition(position);
            
            // PART 4: Record rebalance timestamp
            this.lastRebalanceTimestamp.set(position.positionId, Date.now());
            
            // PART 4: Post-rebalance validation — re-fetch positions and verify
            // If the new position is already in range, log success
            try {
              const updatedPositions = await this.getWalletPositions();
              const newPos = updatedPositions.find(p => p.poolId === position.poolId);
              if (newPos) {
                const stillOutOfRange = await this.isPositionOutOfRange(newPos);
                if (stillOutOfRange) {
                  logger.warn(`Post-rebalance check: New position ${newPos.positionId} is still out of range`);
                } else {
                  logger.info(`Post-rebalance check: New position ${newPos.positionId} is now in range`);
                }
              }
            } catch (postCheckError: any) {
              logger.warn(`Post-rebalance validation failed: ${postCheckError.message || postCheckError}`);
            }
          } else {
            logger.info(`Position ${position.positionId} is IN RANGE`);
          }
        } catch (error: any) {
          // FIX F: Continue processing other positions even if one fails
          logger.error(`Error processing position ${position.positionId}: ${error.message || error}`);
          logger.error(`Stack trace: ${error.stack}`);
          logger.info(`Continuing to next position...`);
        }
      }

      logger.info('=== Position check completed ===');
    } catch (error: any) {
      logger.error(`Error in checkAndRebalance: ${error.message || error}`);
      logger.error(`Stack trace: ${error.stack}`);
    } finally {
      // FIX C: Always reset the flag in finally block
      this.isRebalancing = false;
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
