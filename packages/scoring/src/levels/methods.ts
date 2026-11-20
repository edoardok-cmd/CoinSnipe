/**
 * Key levels, part 1: candidate price generators K1-K8 (master plan 5.4).
 *
 *   K1 swing highs and lows (5-bar pivots on daily and weekly candles)
 *   K2 volume-profile high-volume nodes over 90D and 365D from hourly candles
 *   K3 moving averages (50D, 200D, 200W)
 *   K4 round numbers
 *   K5 options strikes with heavy open interest at the next monthly expiry (BTC/ETH, caller input)
 *   K6 liquidation clusters (BTC/ETH, caller input)
 *   K7 short-term-holder realised price (BTC, optional caller input)
 *   K8 order-book walls (BTC/ETH, caller input): reported apart, never a zone candidate
 *
 * Pure and deterministic: no I/O, no clock, no market data. Every number comes from the config
 * (`levels`, `indicators.pivotBars`, `candles.weeklyBars`). A level is a price a zone is built
 * around; it is never an exact line and never advice.
 */
import { MODEL_CONFIG_V0_3, type ModelConfig } from '../config/schema';
import { pivotPoints, resampleCandles, sma } from '../indicators';
import type { Candle } from '../types';

export const CANDIDATE_METHODS = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7'] as const;
export type CandidateMethod = (typeof CANDIDATE_METHODS)[number];

export interface Candidate {
  readonly method: CandidateMethod;
  readonly price: number;
  /** Plain description of where the price comes from. */
  readonly note: string;
}

/** One strike at the next monthly expiry with its open interest (K5 input). */
export interface OptionsStrike {
  readonly strike: number;
  readonly openInterest: number;
}

/** One liquidation cluster (K6 input); `size` is optional and unused for strength. */
export interface LiquidationCluster {
  readonly price: number;
  readonly size?: number;
}

/** One order-book wall (K8 input). */
export interface OrderBookWall {
  readonly price: number;
  readonly size: number;
}

const finitePositive = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x) && x > 0;

/** K1: swing highs and lows, 5-bar (config `indicators.pivotBars`) on daily and weekly candles. */
export function k1SwingPivots(
  daily: readonly Candle[],
  config: ModelConfig = MODEL_CONFIG_V0_3,
): Candidate[] {
  const bars = config.indicators.pivotBars;
  const out: Candidate[] = [];
  const scan = (candles: readonly Candle[], weekly: boolean) => {
    const pivots = pivotPoints(
      candles.map((c) => c.high),
      candles.map((c) => c.low),
      { bars },
    );
    for (const p of pivots)
      out.push({
        method: 'K1',
        price: p.value,
        note: `${weekly ? 'Weekly' : 'Daily'} swing ${p.kind}`,
      });
  };
  scan(daily, false);
  scan(resampleCandles(daily, config.candles.weeklyBars), true);
  return out;
}

/** Linear-interpolated percentile (0-1) of a numeric list. */
function percentile(values: readonly number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** Bins above this count are skipped (a degenerate ATR would otherwise allocate without bound). */
const MAX_PROFILE_BINS = 200_000;

/**
 * K2: volume-profile high-volume nodes. For each window in `levels.profileDays` the last
 * days x 24 hourly candles put their volume into bins of `levels.binAtr` x ATR (by typical price,
 * (high + low + close) / 3). A node is a bin whose volume is a local maximum and above the
 * `levels.binPercentile` percentile of all bin volumes (empty bins between the extremes count as
 * zero). The node price is the bin centre.
 */
export function k2VolumeNodes(
  hourly: readonly Candle[],
  atrValue: number,
  config: ModelConfig = MODEL_CONFIG_V0_3,
): Candidate[] {
  if (!finitePositive(atrValue)) return [];
  const { binAtr, binPercentile, profileDays } = config.levels;
  const binSize = binAtr * atrValue;
  const out: Candidate[] = [];
  for (const days of profileDays) {
    const window = hourly.slice(Math.max(0, hourly.length - days * 24));
    if (window.length === 0) continue;
    const typical = window.map((c) => (c.high + c.low + c.close) / 3);
    const minP = Math.min(...typical);
    const maxP = Math.max(...typical);
    const nBins = Math.floor((maxP - minP) / binSize) + 1;
    if (nBins > MAX_PROFILE_BINS) continue;
    const vol = new Array<number>(nBins).fill(0);
    window.forEach((c, k) => {
      const idx = Math.floor((typical[k]! - minP) / binSize);
      vol[idx] = (vol[idx] ?? 0) + c.volume;
    });
    const threshold = percentile(vol, binPercentile);
    for (let b = 0; b < nBins; b++) {
      const v = vol[b]!;
      if (!(v > threshold)) continue;
      if (!(v > (vol[b - 1] ?? -1)) || !(v >= (vol[b + 1] ?? -1))) continue;
      out.push({
        method: 'K2',
        price: minP + (b + 0.5) * binSize,
        note: `High-volume node, ${days}D`,
      });
    }
  }
  return out;
}

/** K3: simple moving averages: `levels.maDays` daily and `levels.maWeeks` weekly (200-week). */
export function k3MovingAverages(
  daily: readonly Candle[],
  config: ModelConfig = MODEL_CONFIG_V0_3,
): Candidate[] {
  const out: Candidate[] = [];
  const closes = daily.map((c) => c.close);
  for (const n of config.levels.maDays) {
    const v = sma(closes, n);
    if (v !== null) out.push({ method: 'K3', price: v, note: `${n}-day average` });
  }
  const weekly = resampleCandles(daily, config.candles.weeklyBars).map((c) => c.close);
  for (const n of config.levels.maWeeks) {
    const v = sma(weekly, n);
    if (v !== null) out.push({ method: 'K3', price: v, note: `${n}-week average` });
  }
  return out;
}

/**
 * K4 step for a non-Bitcoin coin: the mantissa x 10^n (mantissas in `levels.roundMantissas`)
 * whose count of steps across +-`levels.roundBand` of the price is closest, in ratio terms, to
 * `levels.roundTargetSteps`.
 */
export function k4RoundStep(price: number, config: ModelConfig = MODEL_CONFIG_V0_3): number | null {
  if (!finitePositive(price)) return null;
  const { roundMantissas, roundTargetSteps, roundBand } = config.levels;
  const ideal = (2 * roundBand * price) / roundTargetSteps;
  const base = Math.floor(Math.log10(ideal));
  let best: number | null = null;
  let bestErr = Infinity;
  for (let n = base - 1; n <= base + 1; n++) {
    for (const m of roundMantissas) {
      const step = Number((m * 10 ** n).toPrecision(12));
      const err = Math.abs(Math.log(step / ideal));
      if (err < bestErr) {
        bestErr = err;
        best = step;
      }
    }
  }
  return best;
}

/**
 * K4: round numbers within +-`levels.roundBand` (30%) of the price. Bitcoin uses every step in
 * `levels.roundBtcSteps` (5K and 10K); other coins use the single step from k4RoundStep.
 */
export function k4RoundNumbers(
  price: number,
  isBitcoin: boolean,
  config: ModelConfig = MODEL_CONFIG_V0_3,
): Candidate[] {
  if (!finitePositive(price)) return [];
  const steps = isBitcoin ? config.levels.roundBtcSteps : [k4RoundStep(price, config)];
  const lo = price * (1 - config.levels.roundBand);
  const hi = price * (1 + config.levels.roundBand);
  const seen = new Set<number>();
  const out: Candidate[] = [];
  for (const step of steps) {
    if (step === null) continue;
    for (let k = Math.ceil(lo / step); k * step <= hi; k++) {
      const p = Number((k * step).toPrecision(12));
      if (p <= 0 || seen.has(p)) continue;
      seen.add(p);
      out.push({ method: 'K4', price: p, note: 'Round number' });
    }
  }
  return out.sort((a, b) => a.price - b.price);
}

/** K5: the `levels.topStrikes` strikes with the largest open interest (BTC/ETH). */
export function k5OptionsStrikes(
  strikes: readonly OptionsStrike[],
  config: ModelConfig = MODEL_CONFIG_V0_3,
): Candidate[] {
  return strikes
    .filter((s) => finitePositive(s.strike) && finitePositive(s.openInterest))
    .sort((a, b) => b.openInterest - a.openInterest || a.strike - b.strike)
    .slice(0, config.levels.topStrikes)
    .map((s) => ({ method: 'K5', price: s.strike, note: 'Heavy options open interest' }));
}

/** K6: liquidation clusters supplied by the caller (BTC/ETH). */
export function k6LiquidationClusters(clusters: readonly LiquidationCluster[]): Candidate[] {
  return clusters
    .filter((c) => finitePositive(c.price))
    .map((c) => ({ method: 'K6', price: c.price, note: 'Liquidation cluster' }));
}

/** K7: short-term-holder realised price (BTC); skipped when absent or not a positive number. */
export function k7ShortTermHolderPrice(value: number | null | undefined): Candidate[] {
  return finitePositive(value)
    ? [{ method: 'K7', price: value, note: 'Short-term-holder realised price' }]
    : [];
}

/**
 * K8: order-book walls (BTC/ETH). Reported separately in the Detailed view and NEVER a zone
 * candidate, so they can never add strength points.
 */
export function k8OrderBookWalls(walls: readonly OrderBookWall[], price: number): KeyWall[] {
  return walls
    .filter((w) => finitePositive(w.price) && finitePositive(w.size))
    .map((w) => ({
      price: w.price,
      size: w.size,
      side: w.price < price ? ('below' as const) : ('above' as const),
    }))
    .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
}

export interface KeyWall {
  readonly price: number;
  readonly size: number;
  readonly side: 'above' | 'below';
}
