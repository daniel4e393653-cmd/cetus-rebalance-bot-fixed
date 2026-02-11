import BN from 'bn.js';

/**
 * Tick math utilities for CLMM
 * Based on Uniswap V3 tick math
 */

const Q64 = new BN(2).pow(new BN(64));

export class TickMath {
  /**
   * The minimum tick that can be used on any pool.
   */
  static MIN_TICK: number = -443636;

  /**
   * The maximum tick that can be used on any pool.
   */
  static MAX_TICK: number = 443636;

  /**
   * The sqrt ratio corresponding to the minimum tick
   */
  static MIN_SQRT_RATIO: BN = new BN('4295048016');

  /**
   * The sqrt ratio corresponding to the maximum tick
   */
  static MAX_SQRT_RATIO: BN = new BN('340282366920938463463374607431768211455');

  /**
   * Returns the sqrt ratio as a Q64.64 for the given tick
   */
  static tickIndexToSqrtPriceX64(tickIndex: number): BN {
    if (tickIndex < TickMath.MIN_TICK || tickIndex > TickMath.MAX_TICK) {
      throw new Error('TICK_OUT_OF_RANGE');
    }

    const absTick = Math.abs(tickIndex);
    
    let ratio =
      (absTick & 0x1) !== 0
        ? new BN('79232123831229584817547652024')
        : new BN('79228162514264337593543950336');

    if ((absTick & 0x2) !== 0) ratio = ratio.mul(new BN('79236085330515764027303304731')).shrn(96);
    if ((absTick & 0x4) !== 0) ratio = ratio.mul(new BN('79244008939048815302430668134')).shrn(96);
    if ((absTick & 0x8) !== 0) ratio = ratio.mul(new BN('79259858533287614744194239852')).shrn(96);
    if ((absTick & 0x10) !== 0) ratio = ratio.mul(new BN('79291567240471783702096968863')).shrn(96);
    if ((absTick & 0x20) !== 0) ratio = ratio.mul(new BN('79355022662356808735212632021')).shrn(96);
    if ((absTick & 0x40) !== 0) ratio = ratio.mul(new BN('79482059297655224616705028932')).shrn(96);
    if ((absTick & 0x80) !== 0) ratio = ratio.mul(new BN('79736832582702625107785510442')).shrn(96);
    if ((absTick & 0x100) !== 0) ratio = ratio.mul(new BN('80248749738035813098930285921')).shrn(96);
    if ((absTick & 0x200) !== 0) ratio = ratio.mul(new BN('81282475239498261466420251389')).shrn(96);
    if ((absTick & 0x400) !== 0) ratio = ratio.mul(new BN('83390057793187169357684915632')).shrn(96);
    if ((absTick & 0x800) !== 0) ratio = ratio.mul(new BN('87770609909825091562026303923')).shrn(96);
    if ((absTick & 0x1000) !== 0) ratio = ratio.mul(new BN('97234110715867761020585770217')).shrn(96);
    if ((absTick & 0x2000) !== 0) ratio = ratio.mul(new BN('11904540963080830603067025136')).shrn(96 - 64);
    if ((absTick & 0x4000) !== 0) ratio = ratio.mul(new BN('17890152566686152337268874549')).shrn(96 - 64);
    if ((absTick & 0x8000) !== 0) ratio = ratio.mul(new BN('40129956205131234504948596839')).shrn(96 - 64);
    if ((absTick & 0x10000) !== 0) ratio = ratio.mul(new BN('20416942048982767279147240763')).shrn(96 - 64);
    if ((absTick & 0x20000) !== 0) ratio = ratio.mul(new BN('51764002794133727348576038843')).shrn(96 - 64);
    if ((absTick & 0x40000) !== 0) ratio = ratio.mul(new BN('33118765948842023413757434908')).shrn(96 - 64);
    if ((absTick & 0x80000) !== 0) ratio = ratio.mul(new BN('13624275240441389293572668394')).shrn(96 - 64);

    if (tickIndex > 0) {
      ratio = new BN(2).pow(new BN(128)).div(ratio);
    }

    return ratio;
  }

  /**
   * Returns the tick corresponding to a given sqrt ratio
   */
  static sqrtPriceX64ToTickIndex(sqrtPriceX64: BN): number {
    // Check bounds
    if (sqrtPriceX64.lt(TickMath.MIN_SQRT_RATIO)) {
      throw new Error('SQRT_PRICE_OUT_OF_RANGE');
    }
    if (sqrtPriceX64.gt(TickMath.MAX_SQRT_RATIO)) {
      throw new Error('SQRT_PRICE_OUT_OF_RANGE');
    }

    const sqrtPriceX128 = sqrtPriceX64.mul(sqrtPriceX64);
    
    const msb = this.mostSignificantBit(sqrtPriceX128);
    
    let r: BN;
    if (msb >= 128) {
      r = sqrtPriceX128.shrn(msb - 127);
    } else {
      r = sqrtPriceX128.shln(127 - msb);
    }

    let log_2 = new BN(msb - 128).shln(64);

    for (let i = 0; i < 14; i++) {
      r = r.mul(r).shrn(127);
      const f = r.shrn(128);
      log_2 = log_2.or(f.shln(63 - i));
      r = r.shrn(f.toNumber());
    }

    const log_sqrt10001 = log_2.mul(new BN('2557389589996048262771445250299')).shrn(128);
    
    const tickLow = log_sqrt10001.sub(new BN('3402992956809132410311348074673')).shrn(128).toNumber();
    const tickHigh = log_sqrt10001.add(new BN('2916394647719896229070276211593')).shrn(128).toNumber();

    if (tickLow === tickHigh) {
      return tickLow;
    }

    if (TickMath.tickIndexToSqrtPriceX64(tickHigh).lte(sqrtPriceX64)) {
      return tickHigh;
    }
    
    return tickLow;
  }

  /**
   * Get the most significant bit
   */
  private static mostSignificantBit(x: BN): number {
    let msb = 0;
    let value = x;
    
    while (value.gten(2)) {
      value = value.shrn(1);
      msb++;
    }
    
    return msb;
  }

  /**
   * Get the previous initializable tick index
   */
  static getPrevInitializableTickIndex(tickIndex: number, tickSpacing: number): number {
    const compressed = Math.floor(tickIndex / tickSpacing);
    return compressed * tickSpacing;
  }

  /**
   * Get the next initializable tick index
   */
  static getNextInitializableTickIndex(tickIndex: number, tickSpacing: number): number {
    const compressed = Math.floor(tickIndex / tickSpacing);
    if (tickIndex % tickSpacing === 0) {
      return compressed * tickSpacing;
    }
    return (compressed + 1) * tickSpacing;
  }

  /**
   * Get tick from price
   */
  static priceToTick(price: number): number {
    return Math.floor(Math.log(price) / Math.log(1.0001));
  }

  /**
   * Get price from tick
   */
  static tickToPrice(tick: number): number {
    return Math.pow(1.0001, tick);
  }
}
