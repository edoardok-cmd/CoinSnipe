/**
 * Key levels, part 2: support and resistance zones with strength (master plan 5.4) and the
 * SG12 breaks detector.
 *
 * Levels are zones, never exact lines. Candidates from K1-K7 are sorted and merged into one zone
 * when each lies within `levels.mergeAtr` x ATR (daily, `indicators.atrPeriod`) of the previous
 * one (low = min, high = max). Strength points:
 *   `levels.methodPts` per distinct method in the zone (K8 is never a candidate, so never counts)
 *   + 1 per price reaction in the last `levels.reactionDays` days, at most `levels.reactMax`
 *     (a reaction is a daily candle whose high or low enters the zone and whose close is back out
 *     on the same side it came from)
 *   + 1 if the zone was touched in the last `levels.recentDays` days.
 * `levels.strong` or more is Strong, `levels.medium` or more is Medium, below that Weak.
 *
 * Output: the two nearest supports below the price and the two nearest resistances above, plus
 * the K8 walls apart. At an all-time high there is no earlier price above, so no resistance
 * zone is built from history: the text 'No earlier price above this' is returned and only
 * round-number (K4) levels above are listed.
 *
 * Pure and deterministic. Dates come from the parallel `dates` array (Candle has no timestamp).
 * It describes price history only; it never advises.
 */
import { MODEL_CONFIG_V0_3, type ModelConfig } from '../config/schema';
import { atr } from '../indicators';
import type { Candle } from '../types';
import {
  k1SwingPivots,
  k2VolumeNodes,
  k3MovingAverages,
  k4RoundNumbers,
  k5OptionsStrikes,
  k6LiquidationClusters,
  k7ShortTermHolderPrice,
  k8OrderBookWalls,
  type Candidate,
  type CandidateMethod,
  type KeyWall,
  type LiquidationCluster,
  type OptionsStrike,
  type OrderBookWall,
} from './methods';

export const NO_EARLIER_PRICE_ABOVE = 'No earlier price above this' as const;

export type ZoneStrength = 'Strong' | 'Medium' | 'Weak';
export type ZoneSide = 'support' | 'resistance';

export interface KeyLevelsInput {
  /** Ticker symbol. K5, K6 and K8 apply to BTC and ETH only, K7 to BTC only. */
  readonly asset: string;
  /** Daily candles, oldest first, last = the scoring day. */
  readonly daily: readonly Candle[];
  /** ISO dates (YYYY-MM-DD), parallel to `daily`. */
  readonly dates: readonly string[];
  /** Hourly candles, oldest first; K2 is skipped when absent. */
  readonly hourly?: readonly Candle[];
  /** Price to measure from; defaults to the last daily close. */
  readonly price?: number;
  readonly optionsStrikes?: readonly OptionsStrike[];
  readonly liquidationClusters?: readonly LiquidationCluster[];
  readonly sthRealisedPrice?: number | null;
  readonly orderBookWalls?: readonly OrderBookWall[];
}

export interface KeyZone {
  readonly low: number;
  readonly high: number;
  readonly side: ZoneSide;
  readonly points: number;
  readonly strength: ZoneStrength;
  /** Plain label, e.g. 'Strong support zone'. */
  readonly label: string;
  readonly methods: readonly CandidateMethod[];
  readonly reactions: number;
  readonly touchedRecently: boolean;
  /** Date of the latest daily candle overlapping the zone, or null if none. */
  readonly lastTouch: string | null;
}

export interface KeyLevelsResult {
  readonly price: number;
  readonly atr: number;
  readonly supports: readonly KeyZone[];
  readonly resistances: readonly KeyZone[];
  /** Set at an all-time high (no earlier price above). */
  readonly resistanceNote: typeof NO_EARLIER_PRICE_ABOVE | null;
  /** K8 order-book walls: Detailed view only, never counted toward strength. */
  readonly walls: readonly KeyWall[];
  /** Every zone built (unordered); the breaks detector reads these. */
  readonly zones: readonly KeyZone[];
}

const isMajor = (asset: string) => ['BTC', 'ETH'].includes(asset.toUpperCase());
const isBitcoin = (asset: string) => asset.toUpperCase() === 'BTC';

function candidatesFor(
  input: KeyLevelsInput,
  price: number,
  atrValue: number,
  config: ModelConfig,
): Candidate[] {
  const out: Candidate[] = [
    ...k1SwingPivots(input.daily, config),
    ...k3MovingAverages(input.daily, config),
    ...k4RoundNumbers(price, isBitcoin(input.asset), config),
  ];
  if (input.hourly) out.push(...k2VolumeNodes(input.hourly, atrValue, config));
  if (isMajor(input.asset)) {
    if (input.optionsStrikes) out.push(...k5OptionsStrikes(input.optionsStrikes, config));
    if (input.liquidationClusters) out.push(...k6LiquidationClusters(input.liquidationClusters));
  }
  if (isBitcoin(input.asset)) out.push(...k7ShortTermHolderPrice(input.sthRealisedPrice));
  const lo = price * (1 - config.levels.range);
  const hi = price * (1 + config.levels.range);
  return out.filter((c) => Number.isFinite(c.price) && c.price >= lo && c.price <= hi);
}

/** Merge sorted candidates into zones: a candidate within mergeAtr x ATR of the zone high joins. */
function mergeCandidates(
  candidates: readonly Candidate[],
  gap: number,
): { low: number; high: number; methods: CandidateMethod[] }[] {
  const sorted = [...candidates].sort((a, b) => a.price - b.price);
  const zones: { low: number; high: number; methods: CandidateMethod[] }[] = [];
  for (const c of sorted) {
    const z = zones[zones.length - 1];
    if (z && c.price - z.high <= gap) {
      z.high = Math.max(z.high, c.price);
      if (!z.methods.includes(c.method)) z.methods.push(c.method);
    } else zones.push({ low: c.price, high: c.price, methods: [c.method] });
  }
  for (const z of zones) z.methods.sort();
  return zones;
}

function strengthOf(points: number, config: ModelConfig): ZoneStrength {
  if (points >= config.levels.strong) return 'Strong';
  if (points >= config.levels.medium) return 'Medium';
  return 'Weak';
}

function scoreZone(
  raw: { low: number; high: number; methods: CandidateMethod[] },
  price: number,
  input: KeyLevelsInput,
  config: ModelConfig,
): KeyZone {
  const { daily, dates } = input;
  const { low, high } = raw;
  const n = daily.length;
  const reactFrom = Math.max(0, n - config.levels.reactionDays);
  const recentFrom = Math.max(0, n - config.levels.recentDays);
  let reactions = 0;
  let touchedRecently = false;
  let lastTouch: string | null = null;
  for (let d = 0; d < n; d++) {
    const c = daily[d]!;
    if (c.low <= high && c.high >= low) {
      lastTouch = dates[d]!;
      if (d >= recentFrom) touchedRecently = true;
    }
    if (d >= reactFrom) {
      // Came from that side (open not beyond the zone), entered it, closed back out.
      const fromBelow = c.open <= high && c.high >= low && c.close < low;
      const fromAbove = c.open >= low && c.low <= high && c.close > high;
      if (fromBelow || fromAbove) reactions++;
    }
  }
  reactions = Math.min(reactions, config.levels.reactMax);
  const points =
    raw.methods.length * config.levels.methodPts + reactions + (touchedRecently ? 1 : 0);
  const strength = strengthOf(points, config);
  const side: ZoneSide = (low + high) / 2 < price ? 'support' : 'resistance';
  return {
    low,
    high,
    side,
    points,
    strength,
    label: `${strength} ${side} zone`,
    methods: raw.methods,
    reactions,
    touchedRecently,
    lastTouch,
  };
}

function validate(input: KeyLevelsInput): void {
  if (input.daily.length === 0) throw new RangeError('keyLevels: daily candles are required');
  if (input.dates.length !== input.daily.length)
    throw new RangeError('keyLevels: dates must be parallel to daily candles');
}

/** Zones and the nearest-two selection, as of the last daily candle. */
export function computeKeyLevels(
  input: KeyLevelsInput,
  config: ModelConfig = MODEL_CONFIG_V0_3,
): KeyLevelsResult {
  validate(input);
  const price = input.price ?? input.daily[input.daily.length - 1]!.close;
  if (!(Number.isFinite(price) && price > 0)) throw new RangeError('keyLevels: price must be > 0');
  const a = atr(input.daily, config.indicators.atrPeriod);
  if (a === null || !(a > 0))
    throw new RangeError('keyLevels: not enough daily history for the ATR');
  const gap = config.levels.mergeAtr * a;
  const candidates = candidatesFor(input, price, a, config);
  const zones = mergeCandidates(candidates, gap).map((z) => scoreZone(z, price, input, config));

  const supports = zones
    .filter((z) => z.side === 'support')
    .sort((x, y) => y.high - x.high)
    .slice(0, 2);
  let resistances: KeyZone[];
  let resistanceNote: typeof NO_EARLIER_PRICE_ABOVE | null = null;
  const allTimeHigh = price >= Math.max(...input.daily.map((c) => c.high));
  if (allTimeHigh) {
    resistanceNote = NO_EARLIER_PRICE_ABOVE;
    const roundOnly = candidates.filter((c) => c.method === 'K4' && c.price > price);
    resistances = mergeCandidates(roundOnly, gap)
      .map((z) => scoreZone(z, price, input, config))
      .filter((z) => z.low > price)
      .sort((x, y) => x.low - y.low)
      .slice(0, 2);
  } else {
    resistances = zones
      .filter((z) => z.side === 'resistance')
      .sort((x, y) => x.low - y.low)
      .slice(0, 2);
  }
  const walls =
    isMajor(input.asset) && input.orderBookWalls
      ? k8OrderBookWalls(input.orderBookWalls, price)
      : [];
  return { price, atr: a, supports, resistances, resistanceNote, walls, zones };
}

export interface KeyLevelBreak {
  readonly direction: 'close-above-resistance' | 'close-below-support';
  readonly zone: KeyZone;
  readonly close: number;
  readonly date: string;
  /** True for BTC: a Bitcoin break is a market-wide signal. */
  readonly marketWide: boolean;
  readonly description: string;
}

/**
 * SG12 breaks detector. Zones are built as of the previous day; the last daily close is then
 * compared with every Medium or Strong zone: a close above a resistance zone's high, or below a
 * support zone's low, is a break. Needs at least two daily candles.
 */
export function detectKeyLevelBreaksSG12(
  input: KeyLevelsInput,
  config: ModelConfig = MODEL_CONFIG_V0_3,
): KeyLevelBreak[] {
  validate(input);
  const n = input.daily.length;
  if (n < 2) throw new RangeError('SG12: at least two daily candles are required');
  const prior = computeKeyLevels(
    {
      ...input,
      price: input.daily[n - 2]!.close,
      daily: input.daily.slice(0, n - 1),
      dates: input.dates.slice(0, n - 1),
    },
    config,
  );
  const close = input.daily[n - 1]!.close;
  const date = input.dates[n - 1]!;
  const out: KeyLevelBreak[] = [];
  for (const z of prior.zones) {
    if (z.strength === 'Weak') continue;
    if (z.side === 'resistance' && close > z.high)
      out.push(mkBreak('close-above-resistance', z, close, date, input.asset));
    else if (z.side === 'support' && close < z.low)
      out.push(mkBreak('close-below-support', z, close, date, input.asset));
  }
  return out.sort((a, b) => b.zone.points - a.zone.points);
}

function mkBreak(
  direction: KeyLevelBreak['direction'],
  zone: KeyZone,
  close: number,
  date: string,
  asset: string,
): KeyLevelBreak {
  const above = direction === 'close-above-resistance';
  const marketWide = isBitcoin(asset);
  return {
    direction,
    zone,
    close,
    date,
    marketWide,
    description:
      `Daily close ${above ? 'above' : 'below'} a ${zone.strength} ${zone.side} zone ` +
      `(${zone.low} to ${zone.high}) on ${date}` +
      (marketWide ? '; Bitcoin level breaks are market-wide' : ''),
  };
}
