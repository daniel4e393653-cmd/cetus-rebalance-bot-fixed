import BN from 'bn.js';

/**
 * Percentage representation for slippage calculations
 */
export class Percentage {
  readonly numerator: BN;
  readonly denominator: BN;

  constructor(numerator: BN, denominator: BN) {
    this.numerator = numerator;
    this.denominator = denominator;
  }

  /**
   * Create a percentage from a decimal (e.g., 0.5 for 0.5%)
   */
  static fromDecimal(decimal: number): Percentage {
    // Convert to basis points (1% = 100 basis points)
    const basisPoints = Math.floor(decimal * 100);
    return new Percentage(new BN(basisPoints), new BN(10000));
  }

  /**
   * Create a percentage from basis points (e.g., 50 for 0.5%)
   */
  static fromBasisPoints(basisPoints: number): Percentage {
    return new Percentage(new BN(basisPoints), new BN(10000));
  }

  /**
   * Apply percentage to a value
   */
  apply(value: BN, roundUp: boolean = false): BN {
    const result = value.mul(this.numerator).div(this.denominator);
    if (roundUp && value.mul(this.numerator).mod(this.denominator).gtn(0)) {
      return result.addn(1);
    }
    return result;
  }

  /**
   * Add percentage to a value (for max calculations)
   */
  addTo(value: BN): BN {
    const increase = this.apply(value, true);
    return value.add(increase);
  }

  /**
   * Subtract percentage from a value (for min calculations)
   */
  subtractFrom(value: BN): BN {
    const decrease = this.apply(value, false);
    return value.sub(decrease);
  }

  /**
   * Convert to string representation
   */
  toString(): string {
    const decimal = this.numerator.muln(10000).div(this.denominator).toNumber() / 100;
    return `${decimal}%`;
  }
}
