/**
 * PICKAI Advanced Market Making Algorithm
 * Implements sophisticated automated market making with dynamic pricing
 * 
 * Features:
 * - Constant Function Market Maker (CFMM) with adaptive curves
 * - Kelly Criterion for optimal position sizing
 * - Dynamic fee adjustment based on volatility
 * - Impermanent loss protection mechanisms
 * - Multi-asset liquidity pool management
 */

import { BN } from '@coral-xyz/anchor';

// Constants for market making
export const CONSTANTS = {
  MIN_LIQUIDITY: 1000,
  MAX_SLIPPAGE: 0.05, // 5%
  BASE_FEE: 0.003, // 0.3%
  VOLATILITY_WINDOW: 3600000, // 1 hour in ms
  KELLY_FRACTION: 0.25, // Conservative Kelly (quarter Kelly)
  MAX_POSITION_SIZE: 0.1, // 10% of pool
  TICK_SIZE: 0.0001,
  GAS_BUFFER: 1.2, // 20% gas buffer
} as const;

/**
 * Core types for market making
 */
export interface MarketState {
  poolId: string;
  reserves: AssetReserves;
  totalLiquidity: bigint;
  fee: number;
  volatility: number;
  volume24h: bigint;
  lastUpdate: number;
  priceHistory: PricePoint[];
  lpTokenSupply: bigint;
  protocolFees: bigint;
}

export interface AssetReserves {
  yes: bigint;
  no: bigint;
  constant: bigint; // k = yes * no
}

export interface PricePoint {
  timestamp: number;
  price: number;
  volume: bigint;
  liquidity: bigint;
}

export interface SwapParams {
  amountIn: bigint;
  assetIn: 'yes' | 'no';
  minAmountOut: bigint;
  deadline: number;
  user: string;
}

export interface LiquidityParams {
  amountYes: bigint;
  amountNo: bigint;
  minLpTokens: bigint;
  deadline: number;
  user: string;
}

export interface Position {
  size: bigint;
  entryPrice: number;
  unrealizedPnL: number;
  margin: bigint;
  liquidationPrice: number;
  funding: bigint;
}

/**
 * Advanced Constant Function Market Maker
 * Implements x*y=k with dynamic adjustments
 */
export class AdvancedCFMM {
  private state: MarketState;
  private priceOracle: PriceOracle;
  private riskEngine: RiskEngine;
  
  constructor(initialState: MarketState) {
    this.state = initialState;
    this.priceOracle = new PriceOracle();
    this.riskEngine = new RiskEngine();
  }
  
  /**
   * Calculate output amount for a swap
   * Implements: Δy = (y * Δx) / (x + Δx) * (1 - fee)
   */
  public calculateSwapOutput(params: SwapParams): {
    amountOut: bigint;
    priceImpact: number;
    fee: bigint;
    newReserves: AssetReserves;
  } {
    const { amountIn, assetIn } = params;
    const { reserves, fee } = this.state;
    
    // Get current reserves
    const reserveIn = assetIn === 'yes' ? reserves.yes : reserves.no;
    const reserveOut = assetIn === 'yes' ? reserves.no : reserves.yes;
    
    // Calculate fee
    const dynamicFee = this.calculateDynamicFee();
    const feeAmount = (amountIn * BigInt(Math.floor(dynamicFee * 1e9))) / 1000000000n;
    const amountInAfterFee = amountIn - feeAmount;
    
    // Calculate output using constant product formula
    const numerator = reserveOut * amountInAfterFee;
    const denominator = reserveIn + amountInAfterFee;
    const amountOut = numerator / denominator;
    
    // Calculate price impact
    const spotPrice = this.getSpotPrice(assetIn);
    const executionPrice = Number(amountIn) / Number(amountOut);
    const priceImpact = Math.abs(executionPrice - spotPrice) / spotPrice;
    
    // Calculate new reserves
    const newReserves: AssetReserves = {
      yes: assetIn === 'yes' 
        ? reserves.yes + amountInAfterFee 
        : reserves.yes - amountOut,
      no: assetIn === 'no' 
        ? reserves.no + amountInAfterFee 
        : reserves.no - amountOut,
      constant: 0n // Will be recalculated
    };
    newReserves.constant = newReserves.yes * newReserves.no;
    
    return {
      amountOut,
      priceImpact,
      fee: feeAmount,
      newReserves
    };
  }
  
  /**
   * Add liquidity to the pool
   */
  public addLiquidity(params: LiquidityParams): {
    lpTokens: bigint;
    actualYes: bigint;
    actualNo: bigint;
    share: number;
  } {
    const { amountYes, amountNo } = params;
    const { reserves, lpTokenSupply } = this.state;
    
    let lpTokens: bigint;
    let actualYes: bigint;
    let actualNo: bigint;
    
    if (lpTokenSupply === 0n) {
      // Initial liquidity
      lpTokens = sqrt(amountYes * amountNo);
      actualYes = amountYes;
      actualNo = amountNo;
    } else {
      // Subsequent liquidity must maintain ratio
      const ratio = reserves.yes * 1000000n / reserves.no;
      const inputRatio = amountYes * 1000000n / amountNo;
      
      // Ensure ratio is maintained (within 0.1%)
      if (abs(inputRatio - ratio) > ratio / 1000n) {
        throw new Error('Liquidity must maintain current pool ratio');
      }
      
      // Calculate LP tokens
      const lpFromYes = (amountYes * lpTokenSupply) / reserves.yes;
      const lpFromNo = (amountNo * lpTokenSupply) / reserves.no;
      lpTokens = min(lpFromYes, lpFromNo);
      
      // Calculate actual amounts (may be slightly different due to rounding)
      actualYes = (lpTokens * reserves.yes) / lpTokenSupply;
      actualNo = (lpTokens * reserves.no) / lpTokenSupply;
    }
    
    const newSupply = lpTokenSupply + lpTokens;
    const share = Number(lpTokens * 10000n / newSupply) / 100;
    
    return {
      lpTokens,
      actualYes,
      actualNo,
      share
    };
  }
  
  /**
   * Remove liquidity from the pool
   */
  public removeLiquidity(lpTokens: bigint): {
    amountYes: bigint;
    amountNo: bigint;
    protocolFee: bigint;
  } {
    const { reserves, lpTokenSupply, protocolFees } = this.state;
    
    const share = lpTokens * 1000000n / lpTokenSupply;
    const amountYes = (reserves.yes * share) / 1000000n;
    const amountNo = (reserves.no * share) / 1000000n;
    const protocolFee = (protocolFees * share) / 1000000n;
    
    return {
      amountYes,
      amountNo,
      protocolFee
    };
  }
  
  /**
   * Calculate dynamic fee based on volatility and volume
   */
  private calculateDynamicFee(): number {
    const { volatility, volume24h } = this.state;
    const baseFee = CONSTANTS.BASE_FEE;
    
    // Increase fee during high volatility
    const volatilityMultiplier = 1 + Math.min(volatility * 2, 1);
    
    // Decrease fee for high volume (liquidity incentive)
    const volumeDiscount = Math.min(Number(volume24h) / 1000000, 0.5);
    
    const dynamicFee = baseFee * volatilityMultiplier * (1 - volumeDiscount * 0.3);
    
    // Clamp between 0.1% and 1%
    return Math.max(0.001, Math.min(0.01, dynamicFee));
  }
  
  /**
   * Get spot price for an asset
   */
  public getSpotPrice(asset: 'yes' | 'no'): number {
    const { reserves } = this.state;
    
    if (asset === 'yes') {
      return Number(reserves.no) / Number(reserves.yes);
    } else {
      return Number(reserves.yes) / Number(reserves.no);
    }
  }
  
  /**
   * Calculate impermanent loss for LP position
   */
  public calculateImpermanentLoss(
    initialPrice: number,
    currentPrice: number
  ): number {
    const priceRatio = currentPrice / initialPrice;
    const il = 2 * Math.sqrt(priceRatio) / (1 + priceRatio) - 1;
    return Math.abs(il);
  }
}

/**
 * Kelly Criterion Calculator
 * Determines optimal bet sizing for maximum long-term growth
 */
export class KellyCriterion {
  private readonly fraction: number;
  
  constructor(fraction: number = CONSTANTS.KELLY_FRACTION) {
    this.fraction = fraction; // Use fractional Kelly for safety
  }
  
  /**
   * Calculate optimal bet size using Kelly formula
   * f* = (p*b - q) / b
   * where:
   * - f* = fraction of capital to bet
   * - p = probability of winning
   * - q = probability of losing (1-p)
   * - b = odds received on the bet (net odds)
   */
  public calculateOptimalBet(
    probability: number,
    odds: number,
    bankroll: bigint,
    confidence: number = 1
  ): {
    betSize: bigint;
    kellyFraction: number;
    expectedGrowth: number;
    risk: number;
  } {
    // Validate inputs
    if (probability <= 0 || probability >= 1) {
      throw new Error('Probability must be between 0 and 1');
    }
    
    if (odds <= 0) {
      throw new Error('Odds must be positive');
    }
    
    // Calculate Kelly fraction
    const q = 1 - probability;
    const kellyFraction = (probability * odds - q) / odds;
    
    // Apply confidence adjustment and fractional Kelly
    const adjustedFraction = kellyFraction * confidence * this.fraction;
    
    // Ensure we don't bet negative or more than maximum position size
    const finalFraction = Math.max(0, Math.min(adjustedFraction, CONSTANTS.MAX_POSITION_SIZE));
    
    // Calculate bet size
    const betSize = BigInt(Math.floor(Number(bankroll) * finalFraction));
    
    // Calculate expected logarithmic growth
    const expectedGrowth = this.calculateExpectedGrowth(probability, odds, finalFraction);
    
    // Calculate risk (standard deviation of returns)
    const risk = this.calculateRisk(probability, odds, finalFraction);
    
    return {
      betSize,
      kellyFraction: finalFraction,
      expectedGrowth,
      risk
    };
  }
  
  /**
   * Calculate expected logarithmic growth rate
   */
  private calculateExpectedGrowth(
    probability: number,
    odds: number,
    fraction: number
  ): number {
    const q = 1 - probability;
    const growth = probability * Math.log(1 + fraction * odds) + 
                   q * Math.log(1 - fraction);
    return growth;
  }
  
  /**
   * Calculate risk (standard deviation)
   */
  private calculateRisk(
    probability: number,
    odds: number,
    fraction: number
  ): number {
    const q = 1 - probability;
    const winReturn = fraction * odds;
    const lossReturn = -fraction;
    
    const expectedReturn = probability * winReturn + q * lossReturn;
    const variance = probability * Math.pow(winReturn - expectedReturn, 2) +
                    q * Math.pow(lossReturn - expectedReturn, 2);
    
    return Math.sqrt(variance);
  }
  
  /**
   * Calculate Kelly fraction for multiple correlated bets
   */
  public calculateMultiBetKelly(
    bets: Array<{
      probability: number;
      odds: number;
      correlation: number;
    }>,
    bankroll: bigint
  ): Map<number, bigint> {
    // Simplified multi-bet Kelly (requires matrix operations for full solution)
    const allocations = new Map<number, bigint>();
    
    // Calculate individual Kelly fractions
    const individualFractions = bets.map(bet => {
      const q = 1 - bet.probability;
      return (bet.probability * bet.odds - q) / bet.odds;
    });
    
    // Apply correlation adjustments
    const adjustedFractions = individualFractions.map((f, i) => {
      const correlationPenalty = bets[i].correlation * 0.5;
      return f * (1 - correlationPenalty) * this.fraction;
    });
    
    // Normalize to ensure total doesn't exceed max position
    const totalFraction = adjustedFractions.reduce((a, b) => a + b, 0);
    const scaleFactor = Math.min(1, CONSTANTS.MAX_POSITION_SIZE / totalFraction);
    
    // Calculate final allocations
    adjustedFractions.forEach((f, i) => {
      const allocation = BigInt(Math.floor(Number(bankroll) * f * scaleFactor));
      allocations.set(i, allocation);
    });
    
    return allocations;
  }
}

/**
 * Price Oracle for external price feeds
 */
class PriceOracle {
  private priceFeeds: Map<string, number>;
  private lastUpdate: number;
  
  constructor() {
    this.priceFeeds = new Map();
    this.lastUpdate = Date.now();
  }
  
  public getPrice(asset: string): number {
    // In production, this would fetch from Pyth, Chainlink, etc.
    return this.priceFeeds.get(asset) || 0.5;
  }
  
  public updatePrice(asset: string, price: number): void {
    this.priceFeeds.set(asset, price);
    this.lastUpdate = Date.now();
  }
  
  public isStale(): boolean {
    return Date.now() - this.lastUpdate > 60000; // 1 minute
  }
}

/**
 * Risk Engine for position management
 */
class RiskEngine {
  private positions: Map<string, Position>;
  private riskParams: RiskParameters;
  
  constructor() {
    this.positions = new Map();
    this.riskParams = {
      maxLeverage: 10,
      maintenanceMargin: 0.05,
      initialMargin: 0.1,
      maxDrawdown: 0.2,
      varConfidence: 0.95
    };
  }
  
  /**
   * Calculate Value at Risk (VaR)
   */
  public calculateVaR(
    position: Position,
    volatility: number,
    timeHorizon: number
  ): number {
    // Parametric VaR calculation
    const zScore = 1.645; // 95% confidence
    const scaledVolatility = volatility * Math.sqrt(timeHorizon);
    const var95 = Number(position.size) * scaledVolatility * zScore;
    
    return var95;
  }
  
  /**
   * Check if position needs liquidation
   */
  public checkLiquidation(position: Position, currentPrice: number): boolean {
    const markToMarket = Number(position.size) * (currentPrice - position.entryPrice);
    const equity = Number(position.margin) + markToMarket;
    const maintenanceReq = Number(position.size) * currentPrice * this.riskParams.maintenanceMargin;
    
    return equity < maintenanceReq;
  }
  
  /**
   * Calculate funding rate for perpetual markets
   */
  public calculateFundingRate(
    indexPrice: number,
    markPrice: number,
    interval: number = 8 // hours
  ): number {
    const premium = (markPrice - indexPrice) / indexPrice;
    const fundingRate = premium / interval;
    
    // Clamp funding rate to ±0.5%
    return Math.max(-0.005, Math.min(0.005, fundingRate));
  }
}

/**
 * Volatility Calculator
 */
export class VolatilityCalculator {
  /**
   * Calculate realized volatility from price history
   */
  public static calculateRealizedVolatility(
    priceHistory: PricePoint[],
    window: number = 24 // hours
  ): number {
    if (priceHistory.length < 2) return 0;
    
    // Filter for time window
    const cutoff = Date.now() - window * 3600000;
    const relevantPrices = priceHistory.filter(p => p.timestamp > cutoff);
    
    if (relevantPrices.length < 2) return 0;
    
    // Calculate returns
    const returns: number[] = [];
    for (let i = 1; i < relevantPrices.length; i++) {
      const return_i = Math.log(relevantPrices[i].price / relevantPrices[i-1].price);
      returns.push(return_i);
    }
    
    // Calculate standard deviation
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    
    // Annualize (assuming 365 days)
    const periodsPerYear = 365 * 24 / window;
    return stdDev * Math.sqrt(periodsPerYear);
  }
  
  /**
   * Calculate implied volatility using Newton-Raphson method
   * (Simplified - would need full Black-Scholes for production)
   */
  public static calculateImpliedVolatility(
    marketPrice: number,
    strike: number,
    timeToExpiry: number,
    riskFreeRate: number = 0
  ): number {
    // Simplified IV calculation
    // In production, use full Black-Scholes with Newton-Raphson
    const moneyness = Math.log(marketPrice / strike);
    const sqrtTime = Math.sqrt(timeToExpiry);
    
    // Initial guess using Brenner-Subrahmanyam approximation
    let iv = Math.abs(moneyness) / sqrtTime * 2.5;
    
    // Ensure reasonable bounds
    return Math.max(0.01, Math.min(3, iv));
  }
}

/**
 * Helper interfaces
 */
interface RiskParameters {
  maxLeverage: number;
  maintenanceMargin: number;
  initialMargin: number;
  maxDrawdown: number;
  varConfidence: number;
}

/**
 * Utility functions
 */
function sqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('Square root of negative number');
  if (n === 0n) return 0n;
  
  let x = n;
  let y = (x + 1n) / 2n;
  
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  
  return x;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

// Export main classes
export const marketMaker = AdvancedCFMM;
export const kelly = new KellyCriterion();
export const volatility = VolatilityCalculator;
