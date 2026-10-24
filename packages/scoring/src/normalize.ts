/**
 * How metrics become 0-100 scores (master plan v0.3, section 7.1).
 *
 * - Size metrics (U5 usage size, R4 market cap) are log-transformed first.
 * - Ranked metrics are winsorised at the 5th and 95th percentile within the peer group, then
 *   percentile-ranked 0-100 with ties averaged; "lower is better" metrics are flipped.
 * - Peer groups: Usage, Earnings and Token supply rank within the coin's sector, falling back to
 *   all coins when fewer than 8 have data (decision D16); Market access, Price trend and Safety
 *   rank across all coins.
 * - Growth metrics U1, U2, U3, E3 blend 70% rank with 30% absolute growth
 *   (-30% -> 0, flat -> 50, +30% -> 100, clamped).
 * - Fixed-scale metrics (L2, L4, S1-S3, Temperature inputs) map a fixed range linearly to 0-100.
 * - Missing metrics are dropped and the remaining weights renormalised; the coverage share is
 *   returned so gate G4 can use it.
 *
 * Every parameter comes from the model config (see config/schema.ts). Pure functions only.
 */
import type { ModelConfig } from './config/schema';
import type { Direction, MetricId, PeerScope } from './types';

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

const isNumber = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/** Base-10 log for size metrics; null for missing or non-positive values. */
export function log10Size(x: number | null | undefined): number | null {
  return isNumber(x) && x > 0 ? Math.log10(x) : null;
}

/**
 * Percentile `pct` (0-100) of `values` by linear interpolation between closest ranks
 * (Hyndman-Fan type 7; the same as Excel PERCENTILE.INC and numpy's default).
 */
export function percentile(values: readonly number[], pct: number): number {
  if (values.length === 0) throw new RangeError('percentile of an empty list');
  if (!(pct >= 0 && pct <= 100)) throw new RangeError(`percentile must be 0-100, got ${pct}`);
  const s = values.slice().sort((a, b) => a - b);
  const h = ((s.length - 1) * pct) / 100;
  const lo = Math.floor(h);
  const frac = h - lo;
  const a = s[lo]!;
  return frac === 0 ? a : a + frac * (s[lo + 1]! - a);
}

/** Winsorising bounds: the values at the lower and upper percentile. */
export function winsorBounds(
  values: readonly number[],
  pcts: readonly [number, number] = [5, 95],
): { readonly low: number; readonly high: number } {
  return { low: percentile(values, pcts[0]), high: percentile(values, pcts[1]) };
}

/** Clamp every value into the winsorising bounds. */
export function winsorize(
  values: readonly number[],
  pcts: readonly [number, number] = [5, 95],
): number[] {
  const { low, high } = winsorBounds(values, pcts);
  return values.map((v) => clamp(v, low, high));
}

/**
 * Percentile rank of `x` among `values`, 0-100, ties averaged:
 * (count below + half the count equal) / count x 100. The same convention as the Score Lab,
 * so a list of n distinct values ranks from 50 / n up to 100 - 50 / n.
 */
export function percentRank(values: readonly number[], x: number): number {
  if (values.length === 0) throw new RangeError('percentRank of an empty list');
  let below = 0;
  let equal = 0;
  for (const v of values) {
    if (v < x) below++;
    else if (v === x) equal++;
  }
  return ((below + 0.5 * equal) / values.length) * 100;
}

/**
 * Absolute check for growth metrics: growth in percent mapped linearly so -span -> 0,
 * 0 -> 50 and +span -> 100, clamped (span 30 by default).
 */
export function absoluteGrowthScore(growthPct: number, span = 30): number {
  return clamp(50 + (growthPct / span) * 50, 0, 100);
}

/** Map a fixed-scale value linearly from [low, high] to 0-100, clamped. */
export function fixedScaleScore(x: number, range: readonly [number, number] = [0, 100]): number {
  const [lo, hi] = range;
  const width = hi - lo;
  return clamp(width === 100 ? x - lo : ((x - lo) / width) * 100, 0, 100);
}

/** One coin's raw value for a metric, with the sector it is ranked within. */
export interface PeerCandidate {
  readonly id: string;
  readonly sector: string | null;
  /** Raw value (before any log transform). Growth metrics are in percent (12.5 = +12.5%). */
  readonly value: number | null | undefined;
}

export interface NormalizeMetricOptions {
  readonly better: Direction;
  /** Peer group for ranked metrics. Default 'all'. */
  readonly peerScope?: PeerScope;
  /** Log-transform before ranking (size metrics). */
  readonly log?: boolean;
  /** Range for fixed-scale metrics. Default [0, 100]. */
  readonly range?: readonly [number, number];
  /** 70/30 absolute blend for growth metrics; null or absent = rank only. */
  readonly absolute?: { readonly share: number; readonly span: number } | null;
  /** Winsorising percentiles within the peer group; null = no winsorising. Default [5, 95]. */
  readonly winsorPct?: readonly [number, number] | null;
  /** Minimum sector peers with data before the sector is used. Default 8 (D16). */
  readonly peerMin?: number;
  /** Whether the coin itself counts toward peerMin. Default true (as in the Score Lab). */
  readonly peerCountIncludesSelf?: boolean;
}

export interface MetricScore {
  readonly id: string;
  /** 0-100, or null when the coin has no value for this metric. */
  readonly score: number | null;
  /** Group the coin was ranked in; 'fixed' for fixed-scale metrics. */
  readonly peerGroup: PeerScope | 'fixed' | null;
  /** Number of coins with data in that group (including the coin itself). */
  readonly peerCount: number;
  /** True when a sector ranking fell back to all coins. */
  readonly fellBack: boolean;
}

/**
 * Score one metric for every coin (master plan 7.1). Returns one entry per candidate, in input
 * order. A coin without data gets score null; it is dropped from the pillar average later.
 */
export function normalizeMetric(
  candidates: readonly PeerCandidate[],
  options: NormalizeMetricOptions,
): MetricScore[] {
  const transform = (v: number | null | undefined): number | null =>
    !isNumber(v) ? null : options.log ? log10Size(v) : v;

  if (options.better === 'fixed') {
    return candidates.map((c) => {
      const x = isNumber(c.value) ? c.value : null;
      return {
        id: c.id,
        score: x == null ? null : fixedScaleScore(x, options.range ?? [0, 100]),
        peerGroup: x == null ? null : 'fixed',
        peerCount: 0,
        fellBack: false,
      };
    });
  }

  const withData = candidates
    .map((c) => ({ c, t: transform(c.value) }))
    .filter((e): e is { c: PeerCandidate; t: number } => e.t != null);
  const scope = options.peerScope ?? 'all';
  const peerMin = options.peerMin ?? 8;
  const selfCounts = options.peerCountIncludesSelf ?? true;
  const winsorPct = options.winsorPct === undefined ? ([5, 95] as const) : options.winsorPct;

  const groups = new Map<string, { values: number[]; low: number; high: number }>();
  const groupFor = (key: string, members: readonly { t: number }[]) => {
    let g = groups.get(key);
    if (!g) {
      const values = members.map((m) => m.t);
      const b = winsorPct ? winsorBounds(values, winsorPct) : { low: -Infinity, high: Infinity };
      g = { values: values.map((v) => clamp(v, b.low, b.high)), low: b.low, high: b.high };
      groups.set(key, g);
    }
    return g;
  };

  return candidates.map((c) => {
    const x = transform(c.value);
    if (x == null) return { id: c.id, score: null, peerGroup: null, peerCount: 0, fellBack: false };
    let key = '\u0000all';
    let members = withData;
    let peerGroup: PeerScope = 'all';
    let fellBack = false;
    if (scope === 'sector') {
      const sectorMembers = c.sector == null ? [] : withData.filter((e) => e.c.sector === c.sector);
      const count = selfCounts ? sectorMembers.length : sectorMembers.length - 1;
      if (c.sector != null && count >= peerMin) {
        key = `sector:${c.sector}`;
        members = sectorMembers;
        peerGroup = 'sector';
      } else {
        fellBack = true;
      }
    }
    const g = groupFor(key, members);
    let score = percentRank(g.values, clamp(x, g.low, g.high));
    if (options.better === 'lower') score = 100 - score;
    if (options.absolute) {
      const raw = c.value as number;
      const abs = absoluteGrowthScore(raw, options.absolute.span);
      const absDirected = options.better === 'lower' ? 100 - abs : abs;
      score = (1 - options.absolute.share) * score + options.absolute.share * absDirected;
    }
    return { id: c.id, score, peerGroup, peerCount: members.length, fellBack };
  });
}

/** Normalisation options for one metric, read from the model config. */
export function metricNormalizeOptions(config: ModelConfig, id: MetricId): NormalizeMetricOptions {
  const spec = config.metricSpec[id];
  if (!spec) throw new RangeError(`${id} has no metricSpec (retired?)`);
  const n = config.normalization;
  const pillar = spec.pillar;
  const scope: PeerScope | undefined =
    pillar === 'S' || pillar === 'H' ? undefined : n.peerScope[pillar];
  return {
    better: spec.better,
    ...(scope ? { peerScope: scope } : {}),
    ...(spec.range ? { range: spec.range } : {}),
    log: n.logIds.includes(id),
    absolute: config.absBlend.ids.includes(id)
      ? { share: config.absBlend.share, span: config.absBlend.span }
      : null,
    winsorPct: n.winsorPct,
    peerMin: n.peerMin,
    peerCountIncludesSelf: n.peerCountIncludesSelf,
  };
}

/** {@link normalizeMetric} with every parameter taken from the model config. */
export function normalizeMetricFromConfig(
  config: ModelConfig,
  id: MetricId,
  candidates: readonly PeerCandidate[],
): MetricScore[] {
  return normalizeMetric(candidates, metricNormalizeOptions(config, id));
}

export interface WeightedAverage {
  /** Weighted mean of the values present, or null when none are. */
  readonly value: number | null;
  /**
   * Share of the weighted items passed in that had a value (count based), 0-1. It is a valid G4
   * coverage only if the caller passed just the items that apply to the coin (see
   * {@link weightedAverage}).
   */
  readonly coverage: number;
  /** Share of the total weight that had a value, 0-1. */
  readonly weightCoverage: number;
  readonly used: number;
  readonly expected: number;
}

/**
 * Weighted average that ignores missing values (null, undefined, NaN) and renormalises the
 * remaining weights. Items with weight 0 (for example retired IDs) are not counted at all.
 *
 * Coverage contract for gate G4 ("less than 60% of fundamental data available"): `coverage`
 * counts every positive-weight item it is given, so the caller must pass only the metrics that
 * apply to the coin. Following the Score Lab, that means the U/E/T/L metrics minus U2 and E4
 * outside deposit sectors, the fee metrics (U3, E1, E2, E3) for coins without protocol revenue,
 * T4 for coins that cannot be staked, and the meme-coin exclusions (G5). Passing a pillar's full
 * weight list instead under-counts coverage and over-flags "Low confidence". G4 itself, and the
 * applicability rule, belong to CSN-036.
 */
export function weightedAverage(
  items: Iterable<readonly [value: number | null | undefined, weight: number]>,
): WeightedAverage {
  let sum = 0;
  let usedWeight = 0;
  let totalWeight = 0;
  let used = 0;
  let expected = 0;
  for (const [v, w] of items) {
    if (!(w > 0)) continue;
    expected++;
    totalWeight += w;
    if (v == null || Number.isNaN(v)) continue;
    sum += v * w;
    usedWeight += w;
    used++;
  }
  return {
    value: usedWeight ? sum / usedWeight : null,
    coverage: expected ? used / expected : 0,
    weightCoverage: totalWeight ? usedWeight / totalWeight : 0,
    used,
    expected,
  };
}

/**
 * Effective weights after dropping missing items, rescaled to sum to 100 (what "How we scored it"
 * shows). Items with weight 0 or no value are omitted.
 */
export function renormalisedWeights<K extends string>(
  weights: Readonly<Record<K, number>>,
  hasValue: (key: K) => boolean,
): Partial<Record<K, number>> {
  const keys = (Object.keys(weights) as K[]).filter((k) => weights[k] > 0 && hasValue(k));
  const total = keys.reduce((s, k) => s + weights[k], 0);
  const out: Partial<Record<K, number>> = {};
  for (const k of keys) out[k] = (weights[k] / total) * 100;
  return out;
}
