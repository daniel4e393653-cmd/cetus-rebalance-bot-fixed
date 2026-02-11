import BN from 'bn.js';
import { CoinAmounts } from './clmm';
import { Percentage } from './percentage';

/**
 * Position math utilities
 */

export interface TokenAmounts {
  tokenMaxA: BN;
  tokenMaxB: BN;
}

/**
 * Adjust coin amounts for slippage tolerance
 * Used to calculate min/max amounts for transactions
 */
export function adjustForCoinSlippage(
  coinAmounts: CoinAmounts,
  slippageTolerance: Percentage,
  roundUp: boolean
): TokenAmounts {
  const { coinA, coinB } = coinAmounts;
  
  // For remove liquidity: min amounts (subtract slippage)
  // For add liquidity: max amounts (add slippage)
  if (roundUp) {
    // Adding liquidity - calculate max amounts
    return {
      tokenMaxA: slippageTolerance.addTo(coinA),
      tokenMaxB: slippageTolerance.addTo(coinB)
    };
  } else {
    // Removing liquidity - calculate min amounts
    return {
      tokenMaxA: slippageTolerance.subtractFrom(coinA),
      tokenMaxB: slippageTolerance.subtractFrom(coinB)
    };
  }
}

/**
 * Calculate liquidity from coin amounts
 */
export function getLiquidityFromCoinAmounts(
  amountA: BN,
  amountB: BN,
  sqrtPriceLower: BN,
  sqrtPriceUpper: BN,
  sqrtPriceCurrent: BN
): BN {
  // Safety check: Prevent division by zero
  if (sqrtPriceUpper.lte(sqrtPriceLower)) {
    throw new Error('Invalid tick range: sqrtPriceUpper must be greater than sqrtPriceLower');
  }
  
  if (sqrtPriceCurrent.lt(sqrtPriceLower)) {
    // All in token A
    if (amountA.isZero()) {
      return new BN(0);
    }
    const numerator = amountA.mul(sqrtPriceLower).mul(sqrtPriceUpper);
    const denominator = sqrtPriceUpper.sub(sqrtPriceLower).shln(64);
    if (denominator.isZero()) {
      throw new Error('Division by zero: invalid denominator in liquidity calculation (below range)');
    }
    return numerator.div(denominator);
  } else if (sqrtPriceCurrent.gte(sqrtPriceUpper)) {
    // All in token B
    if (amountB.isZero()) {
      return new BN(0);
    }
    const numerator = amountB.shln(64);
    const denominator = sqrtPriceUpper.sub(sqrtPriceLower);
    if (denominator.isZero()) {
      throw new Error('Division by zero: invalid denominator in liquidity calculation (above range)');
    }
    return numerator.div(denominator);
  } else {
    // Mixed - use the smaller liquidity
    let liquidityA = new BN(0);
    let liquidityB = new BN(0);
    
    if (!amountA.isZero()) {
      const denominatorA = sqrtPriceUpper.sub(sqrtPriceCurrent).shln(64);
      if (denominatorA.isZero()) {
        throw new Error('Division by zero: invalid denominatorA in liquidity calculation (in range)');
      }
      liquidityA = amountA
        .mul(sqrtPriceCurrent)
        .mul(sqrtPriceUpper)
        .div(denominatorA);
    }
    
    if (!amountB.isZero()) {
      const denominatorB = sqrtPriceCurrent.sub(sqrtPriceLower);
      if (denominatorB.isZero()) {
        throw new Error('Division by zero: invalid denominatorB in liquidity calculation (in range)');
      }
      liquidityB = amountB
        .shln(64)
        .div(denominatorB);
    }
    
    // If one amount is zero, use the non-zero liquidity
    if (liquidityA.isZero()) {
      return liquidityB;
    }
    if (liquidityB.isZero()) {
      return liquidityA;
    }
    
    return liquidityA.lt(liquidityB) ? liquidityA : liquidityB;
  }
}

/**
 * Calculate fee growth inside a position's tick range
 */
export function getFeeGrowthInside(
  feeGrowthGlobal0: BN,
  feeGrowthGlobal1: BN,
  feeGrowthOutsideLower0: BN,
  feeGrowthOutsideLower1: BN,
  feeGrowthOutsideUpper0: BN,
  feeGrowthOutsideUpper1: BN,
  tickLower: number,
  tickUpper: number,
  tickCurrent: number
): { feeGrowthInside0: BN; feeGrowthInside1: BN } {
  let feeGrowthInside0: BN;
  let feeGrowthInside1: BN;

  if (tickCurrent >= tickLower) {
    feeGrowthInside0 = feeGrowthGlobal0.sub(feeGrowthOutsideLower0);
    feeGrowthInside1 = feeGrowthGlobal1.sub(feeGrowthOutsideLower1);
  } else {
    feeGrowthInside0 = feeGrowthOutsideLower0;
    feeGrowthInside1 = feeGrowthOutsideLower1;
  }

  if (tickCurrent < tickUpper) {
    feeGrowthInside0 = feeGrowthInside0.sub(feeGrowthOutsideUpper0);
    feeGrowthInside1 = feeGrowthInside1.sub(feeGrowthOutsideUpper1);
  } else {
    feeGrowthInside0 = feeGrowthInside0.add(feeGrowthOutsideUpper0);
    feeGrowthInside1 = feeGrowthInside1.add(feeGrowthOutsideUpper1);
  }

  return { feeGrowthInside0, feeGrowthInside1 };
}

/**
 * Calculate tokens owed from fee growth
 */
export function getTokensOwed(
  feeGrowthInside0: BN,
  feeGrowthInside1: BN,
  feeGrowthInsideLast0: BN,
  feeGrowthInsideLast1: BN,
  liquidity: BN
): { tokensOwed0: BN; tokensOwed1: BN } {
  const tokensOwed0 = feeGrowthInside0
    .sub(feeGrowthInsideLast0)
    .mul(liquidity)
    .shrn(64);
  
  const tokensOwed1 = feeGrowthInside1
    .sub(feeGrowthInsideLast1)
    .mul(liquidity)
    .shrn(64);

  return { tokensOwed0, tokensOwed1 };
}
