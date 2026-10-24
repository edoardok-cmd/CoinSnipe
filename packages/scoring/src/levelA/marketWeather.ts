/**
 * Level A, part 1: Market weather, -100..+100 (master plan 5.1, inputs A1-A10).
 *
 * Each input A1-A9 becomes a sub-score from -100 to +100 by scaling its raw measures against
 * their own 1-year history (method and the Score Lab difference: ./subScore.ts and
 * DISCREPANCIES.md D-08), then the sub-scores are combined with the config weights:
 *
 *   - Measures inside an input (A1: 40/30/30, ...) use `levelA.market.parts`. A measure the data
 *     layer could not supply is dropped and the rest of the input is reweighted; an input with no
 *     measure left is dropped, the other weights are rescaled to 100, and the dropped ones are
 *     listed in `missingInputs`.
 *   - Macro scaling: A4, A6 and A7 are multiplied by the 90-day BTC-Nasdaq correlation, floored
 *     at `market.corrFloor` (0.3) and capped at 1. The freed weight goes to A1-A3 pro rata to
 *     their weights, so the weights still add up to 100.
 *   - Labels: above `market.tailwind` Tailwind, between the two (inclusive) Neutral, below
 *     `market.headwind` Headwind.
 *   - A10 (event calendar) carries no weight; it lists FOMC, CPI, ETF decisions and large unlocks
 *     within the configured number of days.
 *
 * Every function is pure and deterministic: no clock, no network, no randomness. `asOf` is an
 * argument; all history windows end the day before it. The output carries, for every input and
 * every measure, the raw value, sub-score, effective weight and source, so the app can render
 * "How we scored it" and the Pro "every input" view. It describes data only; it never advises.
 */
import { MODEL_CONFIG_V0_3, type ModelConfig } from '../config/schema';
import { maSlope, returnCorrelation, sma } from '../indicators';
import { renormalisedWeights, weightedAverage } from '../normalize';
import {
  MARKET_MEASURES,
  MARKET_WEIGHT_IDS,
  type MarketMeasureKey,
  type MarketWeightId,
  type ScaledMeasureKey,
  type SubScoreMethod,
} from '../types';
import {
  clamp,
  clamp100,
  finiteOrNull,
  isoDay,
  joinSources,
  noNegativeZero,
  scaleSubScore,
  scaleValue,
  shiftMonths,
  type Measure,
  type MeasureResult,
  type MissingReason,
  type ScaleRule,
} from './subScore';

export type { Measure, MeasureResult, MissingReason } from './subScore';

/** Inputs scaled by the BTC-Nasdaq correlation (master plan 5.1, "Macro scaling"). */
export const MACRO_SCALED_IDS = ['A4', 'A6', 'A7'] as const satisfies readonly MarketWeightId[];
/** Inputs that receive the weight freed by macro scaling. */
export const CRYPTO_NATIVE_IDS = ['A1', 'A2', 'A3'] as const satisfies readonly MarketWeightId[];

export type MarketLabel = 'Tailwind' | 'Neutral' | 'Headwind';

export const MARKET_INPUT_NAMES: Readonly<Record<MarketWeightId | 'A10', string>> = {
  A1: 'Bitcoin trend',
  A2: 'Crypto liquidity',
  A3: 'Leverage and mood',
  A4: 'Stocks and risk appetite',
  A5: 'Bitcoin dominance',
  A6: 'Dollar and rates',
  A7: 'Oil and gold',
  A8: 'Global money supply (M2)',
  A9: 'News risk',
  A10: 'Event calendar',
};

/* ------------------------------------------------------------------------------- inputs */

/** A dated observation of a level (Global M2). */
export interface DatedValue {
  readonly date: string;
  readonly value: number;
}

/**
 * A8 input. Either the M2 level series (`series`, any frequency, dated 'YYYY-MM-DD'): the engine
 * applies the lag, then computes the 3-month and yearly change and their 1-year history; or the
 * two changes already computed by the data layer (`threeMonthChange`, `yearlyChange`, in percent),
 * which are used as given, so the caller has applied the lag itself.
 */
export interface GlobalM2Input {
  readonly series?: readonly DatedValue[] | null;
  readonly threeMonthChange?: Measure | null;
  readonly yearlyChange?: Measure | null;
  readonly source?: string;
}

/** One regulation headline for A9: tone -100..+100, and whether the report is confirmed. */
export interface NewsToneItem {
  readonly tone: number;
  readonly confirmed: boolean;
}

export const EVENT_KINDS = ['FOMC', 'CPI', 'ETF_DECISION', 'TOKEN_UNLOCK'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** A dated market event for A10. `title` is passed through; the engine writes no copy. */
export interface CalendarEvent {
  readonly date: string;
  readonly kind: EventKind;
  readonly title: string;
  /** Token unlocks only: the unlock as a percent of circulating supply. */
  readonly unlockPctSupply?: number | null;
}

type DerivedKey =
  'btcVs200dma' | 'btcSlope50dma' | 'btcMaStack' | 'globalM2Change3m' | 'globalM2ChangeYoY';
type DirectKey = Exclude<MarketMeasureKey, DerivedKey>;

/**
 * Everything market weather reads. All fields except `asOf` may be missing; missing inputs are
 * dropped and the rest reweighted. Units: changes in percent (2.6 = +2.6%), dominance and yields
 * in percentage points, funding in percent per 8 hours, VIX and GPR as index levels, Fear & Greed
 * 0-100, regulation tone -100..+100.
 */
export type MarketWeatherInputs = {
  /** The scoring day, 'YYYY-MM-DD'. */
  readonly asOf: string;
  /** Daily Bitcoin closes, oldest first, the last one being asOf (A1). */
  readonly btcCloses?: readonly number[] | null;
  /** Provenance label for the Bitcoin closes. */
  readonly btcSource?: string;
  /** A8: Global M2, see {@link GlobalM2Input}. */
  readonly globalM2?: GlobalM2Input | null;
  /** A9: regulation headlines, used only when `regulationTone` has no value. */
  readonly regulationNews?: readonly NewsToneItem[] | null;
  /** Macro scaling: the 90-day BTC-Nasdaq return correlation, if the data layer computed it. */
  readonly btcNasdaqCorrelation?: number | null;
  /** Macro scaling: Nasdaq closes aligned bar for bar with `btcCloses`, to compute it here. */
  readonly nasdaqCloses?: readonly number[] | null;
  /** A10: upcoming events. */
  readonly events?: readonly CalendarEvent[] | null;
} & { readonly [K in DirectKey]?: Measure | null };

/* ------------------------------------------------------------------------------- outputs */

export interface MarketInputScore {
  readonly id: MarketWeightId;
  readonly name: string;
  /** ok = every measure present; partial = some dropped; missing = no sub-score at all. */
  readonly status: 'ok' | 'partial' | 'missing';
  /** -100..+100, or null when the whole input is missing. */
  readonly subScore: number | null;
  /** The weight from `market` in the config. */
  readonly configuredWeight: number;
  /** Distinct source labels of the measures that were used. */
  readonly source: string;
  /** Raw value of each measure, keyed by measure; null when missing. */
  readonly raw: Readonly<Record<string, number | null>>;
  readonly measures: readonly MeasureResult[];
  readonly missingMeasures: readonly string[];
}

export interface MarketInputResult extends MarketInputScore {
  /** Weight after macro scaling, before rescaling to 100 (plan points). */
  readonly scaledWeight: number;
  /** Final share of the score in percent; the present inputs add up to 100. 0 when missing. */
  readonly effectiveWeight: number;
  /** subScore x effectiveWeight / 100: how many points of the score this input supplied. */
  readonly contribution: number | null;
}

export interface MacroScaling {
  /** The correlation used, or null when none was available. */
  readonly correlation: number | null;
  readonly correlationSource: 'input' | 'computed' | 'missing';
  readonly floor: number;
  /** clamp(correlation, floor, 1); 1 (or the floor) when the correlation is missing. */
  readonly factor: number;
  /** Plan points taken from the present A4/A6/A7. */
  readonly freedWeight: number;
  /** Plan points given to A1-A3 (equals `freedWeight` unless none of A1-A3 is present). */
  readonly redistributedWeight: number;
  readonly redistributedTo: readonly MarketWeightId[];
}

export interface EventFlag {
  readonly date: string;
  readonly kind: EventKind;
  readonly title: string;
  readonly daysAway: number;
  readonly unlockPctSupply: number | null;
}

export interface EventCalendarResult {
  readonly id: 'A10';
  readonly name: string;
  /** A10 is a flag only. */
  readonly weight: 0;
  readonly windowDays: number;
  readonly flagged: boolean;
  readonly events: readonly EventFlag[];
}

export interface MarketWeatherResult {
  readonly asOf: string;
  readonly modelVersion: string;
  readonly subScoreMethod: SubScoreMethod;
  /** -100..+100, or null when no input could be scored. */
  readonly score: number | null;
  readonly label: MarketLabel | null;
  /** A1-A9 in order, including the missing ones (weight 0). */
  readonly inputs: readonly MarketInputResult[];
  readonly missingInputs: readonly MarketWeightId[];
  readonly partialInputs: readonly MarketWeightId[];
  /** Sum of the effective weights: 100, or 0 when nothing could be scored. */
  readonly weightSum: number;
  readonly macroScaling: MacroScaling;
  readonly eventCalendar: EventCalendarResult;
}

/* ------------------------------------------------------------------------------- labels */

/**
 * Tailwind above `market.tailwind` (+25), Headwind below `market.headwind` (-25), Neutral in
 * between with both ends inclusive.
 */
export function marketWeatherLabel(
  score: number,
  config: ModelConfig = MODEL_CONFIG_V0_3,
): MarketLabel {
  if (score > config.market.tailwind) return 'Tailwind';
  if (score < config.market.headwind) return 'Headwind';
  return 'Neutral';
}

/* ------------------------------------------------------------------------------- measures */

interface MeasureDef {
  readonly label: (cfg: ModelConfig) => string;
  readonly unit: string;
  readonly source: string;
  /** null = rule-based (no scaling against history). */
  readonly rule: { readonly centre: 'history' | 'gprBaseline'; readonly direction: 1 | -1 } | null;
}

const H = 'history' as const;
const FRED = 'FRED';

const MEASURE_DEFS: Readonly<Record<MarketMeasureKey, MeasureDef>> = {
  btcVs200dma: {
    label: (c) => `Bitcoin vs its ${c.levelA.market.trend.longMa}-day average`,
    unit: '%',
    source: 'CoinGecko',
    rule: { centre: H, direction: 1 },
  },
  btcSlope50dma: {
    label: (c) =>
      `${c.levelA.market.trend.midMa}-day average of Bitcoin, change over ${c.levelA.market.trend.slopeDays} days`,
    unit: '%',
    source: 'CoinGecko',
    rule: { centre: H, direction: 1 },
  },
  btcMaStack: {
    label: (c) => {
      const t = c.levelA.market.trend;
      return `Bitcoin above its ${t.shortMa}, ${t.midMa} and ${t.longMa}-day averages, and ${t.midMa}-day above ${t.longMa}-day`;
    },
    unit: 'conditions met, of 4',
    source: 'CoinGecko',
    rule: null,
  },
  stablecoinSupplyChange30d: {
    label: () => 'Stablecoin supply, 30-day change',
    unit: '%',
    source: 'DefiLlama',
    rule: { centre: H, direction: 1 },
  },
  fundingRate: {
    label: () => 'Perpetual-futures funding rate, per 8 hours',
    unit: '% per 8h',
    source: 'Exchange public APIs',
    rule: { centre: H, direction: 1 },
  },
  openInterestChange30d: {
    label: () => 'Futures open interest, 30-day change',
    unit: '%',
    source: 'Exchange public APIs',
    rule: { centre: H, direction: 1 },
  },
  fearGreed: {
    label: () => 'Crypto Fear & Greed index',
    unit: 'index 0-100',
    source: 'alternative.me',
    rule: { centre: H, direction: 1 },
  },
  nasdaqVs50dma: {
    label: () => 'Nasdaq vs its 50-day average',
    unit: '%',
    source: FRED,
    rule: { centre: H, direction: 1 },
  },
  spxVs50dma: {
    label: () => 'S&P 500 vs its 50-day average',
    unit: '%',
    source: FRED,
    rule: { centre: H, direction: 1 },
  },
  vix: {
    label: () => 'VIX, inverted (calmer scores higher)',
    unit: 'index points',
    source: FRED,
    rule: { centre: H, direction: -1 },
  },
  btcDominanceChange30d: {
    label: () => 'Bitcoin dominance, 30-day change, inverted (rising is a headwind for alts)',
    unit: 'percentage points',
    source: 'CoinGecko',
    rule: { centre: H, direction: -1 },
  },
  dollarIndexChange30d: {
    label: () => 'Dollar index, 30-day change, inverted',
    unit: '%',
    source: FRED,
    rule: { centre: H, direction: -1 },
  },
  us10yChange30d: {
    label: () => 'US 10-year yield, 30-day change, inverted',
    unit: 'percentage points',
    source: FRED,
    rule: { centre: H, direction: -1 },
  },
  wtiChange30d: {
    label: () => 'WTI oil, 30-day change, inverted (a spike reads as inflation risk)',
    unit: '%',
    source: FRED,
    rule: { centre: H, direction: -1 },
  },
  goldChange30d: {
    label: () => 'Gold, 30-day change',
    unit: '%',
    source: 'unspecified',
    rule: { centre: H, direction: 1 },
  },
  globalM2Change3m: {
    label: () => 'Global M2, 3-month change (lagged)',
    unit: '%',
    source: FRED,
    rule: { centre: H, direction: 1 },
  },
  globalM2ChangeYoY: {
    label: () => 'Global M2, yearly change (lagged)',
    unit: '%',
    source: FRED,
    rule: { centre: H, direction: 1 },
  },
  regulationTone: {
    label: () => 'Regulation tone, confirmed reports only',
    unit: 'points -100..+100',
    source: 'GDELT, CryptoPanic',
    rule: null,
  },
  geopoliticalRisk: {
    label: (c) => `Geopolitical risk (GPR index vs ${c.levelA.market.gprBaseline}), inverted`,
    unit: 'index points',
    source: 'GPR index (Caldara and Iacoviello)',
    rule: { centre: 'gprBaseline', direction: -1 },
  },
};

interface Resolved {
  readonly value: number | null;
  readonly history: readonly number[] | null;
  readonly source?: string | undefined;
  readonly observedOn?: string | undefined;
}

const NO_VALUE: Resolved = { value: null, history: null };

const asResolved = (m: Measure | null | undefined): Resolved =>
  m ? { value: finiteOrNull(m.value), history: m.history ?? null, source: m.source } : NO_VALUE;

/** Mean tone of regulation headlines; an unconfirmed report scores 0 (it still counts as a report). */
export function regulationToneFromNews(items: readonly NewsToneItem[]): number | null {
  if (items.length === 0) return null;
  let sum = 0;
  for (const it of items) if (it.confirmed && Number.isFinite(it.tone)) sum += clamp100(it.tone);
  return sum / items.length;
}

/* Bitcoin-derived measures (A1) --------------------------------------------------------- */

interface BtcMeasures {
  readonly vs200: Resolved;
  readonly slope: Resolved;
  readonly stack: Resolved;
}

function btcMeasures(inputs: MarketWeatherInputs, cfg: ModelConfig): BtcMeasures {
  const empty = { vs200: NO_VALUE, slope: NO_VALUE, stack: NO_VALUE };
  const closes = inputs.btcCloses;
  if (!closes || closes.length === 0) return empty;
  const source = inputs.btcSource;
  const t = cfg.levelA.market.trend;
  const last = closes.length - 1;
  const vs = (j: number): number | null => {
    const m = sma(closes, t.longMa, j);
    return m === null ? null : finiteOrNull((closes[j]! / m - 1) * 100);
  };
  const slopeAt = (j: number): number | null => {
    const s = maSlope(closes, t.midMa, t.slopeDays, j);
    return s === null ? null : finiteOrNull(s * 100);
  };
  const needHistory = cfg.levelA.subScore.method !== 'fixedScale';
  const histOf = (f: (j: number) => number | null): number[] | null => {
    if (!needHistory) return null;
    const out: number[] = [];
    for (let j = Math.max(0, last - cfg.levelA.subScore.historyDays); j < last; j++) {
      const v = f(j);
      if (v !== null) out.push(v);
    }
    return out;
  };
  const px = closes[last]!;
  const m1 = sma(closes, t.shortMa, last);
  const m2 = sma(closes, t.midMa, last);
  const m3 = sma(closes, t.longMa, last);
  // A non-finite close or average (a bad data point) makes the stack missing, never "0 of 4".
  const finite = (x: number | null): x is number => x !== null && Number.isFinite(x);
  const stackValue =
    finite(px) && finite(m1) && finite(m2) && finite(m3)
      ? Number(px > m1) + Number(px > m2) + Number(px > m3) + Number(m2 > m3)
      : null;
  return {
    vs200: { value: vs(last), history: histOf(vs), source },
    slope: { value: slopeAt(last), history: histOf(slopeAt), source },
    stack: { value: stackValue, history: null, source },
  };
}

/* Global M2 (A8) ------------------------------------------------------------------------- */

/**
 * M2 is monthly. An observation more than this many days away from the date it should stand for
 * is treated as absent rather than silently stretched. Not a model parameter.
 */
const M2_MATCH_TOLERANCE_DAYS = 45;

function m2Measures(
  input: GlobalM2Input | null | undefined,
  asOf: string,
  cfg: ModelConfig,
): { change3m: Resolved; yoy: Resolved } {
  const none = { change3m: NO_VALUE, yoy: NO_VALUE };
  if (!input) return none;
  if (!input.series || input.series.length === 0)
    return {
      change3m: asResolved(input.threeMonthChange),
      yoy: asResolved(input.yearlyChange),
    };

  const points = input.series
    .filter((p) => Number.isFinite(p.value) && p.value > 0)
    .map((p) => ({ day: isoDay(p.date), date: p.date, value: p.value }))
    .sort((a, b) => a.day - b.day);
  const at = (day: number, tolerance: number) => {
    for (let k = points.length - 1; k >= 0; k--) {
      const p = points[k]!;
      if (p.day <= day) return day - p.day <= tolerance ? p : undefined;
    }
    return undefined;
  };
  const changeAt = (day: number, months: number): number | null => {
    const cur = points.find((p) => p.day === day);
    if (!cur) return null;
    const prev = at(shiftMonths(day, -months), M2_MATCH_TOLERANCE_DAYS);
    return prev ? (cur.value / prev.value - 1) * 100 : null;
  };

  const lagDay = isoDay(asOf) - cfg.levelA.market.m2LagDays;
  const cur = at(lagDay, M2_MATCH_TOLERANCE_DAYS);
  if (!cur) return none;
  const histFrom = lagDay - cfg.levelA.subScore.historyDays;
  const hist = (months: number): number[] =>
    points
      .filter((p) => p.day < cur.day && p.day >= histFrom)
      .map((p) => changeAt(p.day, months))
      .filter((v): v is number => v !== null);
  const make = (months: number): Resolved => ({
    value: changeAt(cur.day, months),
    history: cfg.levelA.subScore.method === 'fixedScale' ? null : hist(months),
    source: input.source,
    observedOn: cur.date,
  });
  return { change3m: make(3), yoy: make(12) };
}

/* ------------------------------------------------------------------------------- scoring */

function makeResolver(inputs: MarketWeatherInputs, cfg: ModelConfig) {
  let btc: BtcMeasures | undefined;
  let m2: { change3m: Resolved; yoy: Resolved } | undefined;
  return (key: MarketMeasureKey): Resolved => {
    switch (key) {
      case 'btcVs200dma':
        return (btc ??= btcMeasures(inputs, cfg)).vs200;
      case 'btcSlope50dma':
        return (btc ??= btcMeasures(inputs, cfg)).slope;
      case 'btcMaStack':
        return (btc ??= btcMeasures(inputs, cfg)).stack;
      case 'globalM2Change3m':
        return (m2 ??= m2Measures(inputs.globalM2, inputs.asOf, cfg)).change3m;
      case 'globalM2ChangeYoY':
        return (m2 ??= m2Measures(inputs.globalM2, inputs.asOf, cfg)).yoy;
      case 'regulationTone': {
        const given = asResolved(inputs.regulationTone);
        if (given.value !== null || !inputs.regulationNews) return given;
        return { ...given, value: regulationToneFromNews(inputs.regulationNews) };
      }
      default:
        return asResolved(inputs[key]);
    }
  };
}

interface MeasureScore {
  readonly subScore: number | null;
  readonly missing: MissingReason | null;
}

/** Sub-score of one measure (-100..+100). */
function scoreMeasure(key: MarketMeasureKey, r: Resolved, cfg: ModelConfig): MeasureScore {
  const def = MEASURE_DEFS[key];
  const v = r.value;
  if (v === null) return { subScore: null, missing: 'noValue' };
  if (def.rule === null) {
    // Rule-based: the A1 stack counts conditions met (0-4; two of four is neutral); the A9
    // regulation tone is already a -100..+100 score.
    return key === 'btcMaStack'
      ? { subScore: (v - 2) * 50, missing: null }
      : { subScore: noNegativeZero(clamp100(v)), missing: null };
  }
  const rule: ScaleRule = {
    centre: def.rule.centre === 'gprBaseline' ? cfg.levelA.market.gprBaseline : 'history',
    direction: def.rule.direction,
  };
  const o = scaleSubScore(key as ScaledMeasureKey, v, r.history, rule, cfg.levelA.subScore);
  if (o.score === null) return { subScore: null, missing: o.missing };
  if (key === 'fundingRate') {
    // A3: "inverted above 0.03% per 8h". Up to the threshold a higher rate scores higher; above
    // it, crowded leverage is a fragility, so the distance above the threshold scores negative.
    const thr = cfg.levelA.market.fundingInvertAbove;
    if (v > thr) return { subScore: scaleValue(v, thr, o.aboveUnit ?? o.unit!, -1), missing: null };
  }
  return { subScore: o.score, missing: null };
}

/**
 * Score one input A1-A9 on its own (no macro scaling or final weights yet). The A1..A9 wrappers
 * below call this; {@link marketWeather} combines the nine.
 */
export function scoreMarketInput(
  id: MarketWeightId,
  inputs: MarketWeatherInputs,
  config: ModelConfig = MODEL_CONFIG_V0_3,
): MarketInputScore {
  const resolve = makeResolver(inputs, config);
  const keys = MARKET_MEASURES[id] as readonly MarketMeasureKey[];
  const parts = config.levelA.market.parts[id] as Readonly<Record<string, number>>;
  const scored = keys.map((key) => {
    const r = resolve(key);
    return { key, r, ...scoreMeasure(key, r, config) };
  });
  const eff = renormalisedWeights(parts, (k) => scored.find((s) => s.key === k)?.subScore != null);
  const measures: MeasureResult[] = scored.map(({ key, r, subScore, missing }) => {
    const def = MEASURE_DEFS[key];
    return {
      key,
      label: def.label(config),
      raw: r.value,
      unit: def.unit,
      subScore,
      weight: (eff as Record<string, number | undefined>)[key] ?? 0,
      configuredWeight: parts[key] ?? 0,
      source: r.source ?? def.source,
      missing,
      ...(r.observedOn ? { observedOn: r.observedOn } : {}),
    };
  });
  const avg = weightedAverage(scored.map((s) => [s.subScore, parts[s.key] ?? 0] as const));
  const missingMeasures = measures.filter((m) => m.subScore === null).map((m) => m.key);
  return {
    id,
    name: MARKET_INPUT_NAMES[id],
    status: avg.value === null ? 'missing' : missingMeasures.length > 0 ? 'partial' : 'ok',
    subScore: avg.value === null ? null : noNegativeZero(avg.value),
    configuredWeight: config.market[id],
    source: joinSources(measures.filter((m) => m.subScore !== null).map((m) => m.source)),
    raw: Object.fromEntries(measures.map((m) => [m.key, m.raw])),
    measures,
    missingMeasures,
  };
}

/** A1 Bitcoin trend: BTC vs 200D MA 40%, 50D MA slope over 14D 30%, MA stack 30%. */
export const scoreA1 = (i: MarketWeatherInputs, c?: ModelConfig) => scoreMarketInput('A1', i, c);
/** A2 Crypto liquidity: stablecoin supply change over 30D. */
export const scoreA2 = (i: MarketWeatherInputs, c?: ModelConfig) => scoreMarketInput('A2', i, c);
/** A3 Leverage and mood: funding rate (inverted above 0.03% per 8h), open interest 30D, Fear & Greed. */
export const scoreA3 = (i: MarketWeatherInputs, c?: ModelConfig) => scoreMarketInput('A3', i, c);
/** A4 Stocks and risk appetite: Nasdaq and S&P vs their 50D MA, VIX inverted. */
export const scoreA4 = (i: MarketWeatherInputs, c?: ModelConfig) => scoreMarketInput('A4', i, c);
/** A5 Bitcoin dominance: 30D change; rising dominance is a headwind for alts. */
export const scoreA5 = (i: MarketWeatherInputs, c?: ModelConfig) => scoreMarketInput('A5', i, c);
/** A6 Dollar and rates: dollar index 30D change and US 10Y change, both inverted. */
export const scoreA6 = (i: MarketWeatherInputs, c?: ModelConfig) => scoreMarketInput('A6', i, c);
/** A7 Oil and gold: WTI 30D change (a spike reads as inflation risk), gold. */
export const scoreA7 = (i: MarketWeatherInputs, c?: ModelConfig) => scoreMarketInput('A7', i, c);
/** A8 Global M2: 3-month change 60% and yearly change 40%, lagged `levelA.market.m2LagDays`. */
export const scoreA8 = (i: MarketWeatherInputs, c?: ModelConfig) => scoreMarketInput('A8', i, c);
/** A9 News risk: regulation tone 50%, minus geopolitical risk vs its baseline 50%; unconfirmed scores 0. */
export const scoreA9 = (i: MarketWeatherInputs, c?: ModelConfig) => scoreMarketInput('A9', i, c);

/* ------------------------------------------------------------------------------- A10 */

/**
 * A10 Event calendar (flag only, no weight): FOMC, CPI, ETF decisions and token unlocks of at
 * least `events.largeUnlockPct` of supply, dated from asOf to asOf + `events.windowDays`, both
 * ends inclusive, in date order. An unlock without a stated size is not called large.
 */
export function eventCalendarA10(
  inputs: Pick<MarketWeatherInputs, 'asOf' | 'events'>,
  config: ModelConfig = MODEL_CONFIG_V0_3,
): EventCalendarResult {
  const { windowDays, largeUnlockPct } = config.levelA.market.events;
  const today = isoDay(inputs.asOf);
  const flags: EventFlag[] = [];
  for (const e of inputs.events ?? []) {
    const daysAway = isoDay(e.date) - today;
    if (daysAway < 0 || daysAway > windowDays) continue;
    const pct = finiteOrNull(e.unlockPctSupply);
    if (e.kind === 'TOKEN_UNLOCK' && (pct === null || pct < largeUnlockPct)) continue;
    flags.push({
      date: e.date,
      kind: e.kind,
      title: e.title,
      daysAway,
      unlockPctSupply: e.kind === 'TOKEN_UNLOCK' ? pct : null,
    });
  }
  flags.sort(
    (a, b) =>
      a.daysAway - b.daysAway ||
      EVENT_KINDS.indexOf(a.kind) - EVENT_KINDS.indexOf(b.kind) ||
      (a.title < b.title ? -1 : a.title > b.title ? 1 : 0),
  );
  return {
    id: 'A10',
    name: MARKET_INPUT_NAMES.A10,
    weight: 0,
    windowDays,
    flagged: flags.length > 0,
    events: flags,
  };
}

/* ------------------------------------------------------------------------------- macro scaling */

function resolveCorrelation(
  inputs: MarketWeatherInputs,
  cfg: ModelConfig,
): { value: number | null; source: MacroScaling['correlationSource'] } {
  const given = finiteOrNull(inputs.btcNasdaqCorrelation);
  if (given !== null) return { value: clamp(given, -1, 1), source: 'input' };
  if (inputs.btcCloses && inputs.nasdaqCloses) {
    if (inputs.btcCloses.length !== inputs.nasdaqCloses.length)
      throw new RangeError('nasdaqCloses must be aligned with btcCloses (same length, same days)');
    const value = returnCorrelation(inputs.btcCloses, inputs.nasdaqCloses, {
      days: cfg.indicators.correlationDays,
      returns: cfg.indicators.returns,
    });
    // A zero, negative or NaN close in the window makes a return non-finite and the correlation
    // NaN; that is a missing correlation, not a result (the rest of the score must still work).
    if (value !== null && Number.isFinite(value)) return { value, source: 'computed' };
  }
  return { value: null, source: 'missing' };
}

/* ------------------------------------------------------------------------------- aggregate */

/**
 * Market weather for one day: A1-A9 sub-scores, macro scaling, missing-input reweighting, the
 * weighted sum and the label, plus the A10 event flags. See the file header for the rules.
 */
export function marketWeather(
  inputs: MarketWeatherInputs,
  config: ModelConfig = MODEL_CONFIG_V0_3,
): MarketWeatherResult {
  const scores = MARKET_WEIGHT_IDS.map((id) => scoreMarketInput(id, inputs, config));
  const present = scores.filter((s) => s.subScore !== null);
  const presentIds = new Set(present.map((s) => s.id));
  const base = (id: MarketWeightId): number => config.market[id];

  const corr = resolveCorrelation(inputs, config);
  const floor = config.market.corrFloor;
  const factor =
    corr.value === null
      ? config.levelA.market.corrMissing === 'floor'
        ? floor
        : 1
      : clamp(corr.value, floor, 1);

  const scaled = new Map<MarketWeightId, number>();
  for (const s of present) scaled.set(s.id, base(s.id));
  let freed = 0;
  for (const id of MACRO_SCALED_IDS) {
    if (!presentIds.has(id)) continue;
    scaled.set(id, base(id) * factor);
    freed += base(id) * (1 - factor);
  }
  const recipients = CRYPTO_NATIVE_IDS.filter((id) => presentIds.has(id));
  const recipientBase = recipients.reduce((s, id) => s + base(id), 0);
  const redistributed = recipientBase > 0 ? freed : 0;
  if (redistributed > 0)
    for (const id of recipients)
      scaled.set(id, scaled.get(id)! + (freed * base(id)) / recipientBase);

  const total = [...scaled.values()].reduce((s, w) => s + w, 0);
  const inputsOut: MarketInputResult[] = scores.map((s) => {
    const sw = scaled.get(s.id) ?? 0;
    const eff = total > 0 ? (sw / total) * 100 : 0;
    return {
      ...s,
      scaledWeight: sw,
      effectiveWeight: eff,
      contribution: s.subScore === null ? null : (s.subScore * eff) / 100,
    };
  });
  const score =
    total > 0 ? noNegativeZero(inputsOut.reduce((sum, i) => sum + (i.contribution ?? 0), 0)) : null;

  return {
    asOf: inputs.asOf,
    modelVersion: config.model_version,
    subScoreMethod: config.levelA.subScore.method,
    score,
    label: score === null ? null : marketWeatherLabel(score, config),
    inputs: inputsOut,
    missingInputs: scores.filter((s) => s.status === 'missing').map((s) => s.id),
    partialInputs: scores.filter((s) => s.status === 'partial').map((s) => s.id),
    weightSum: inputsOut.reduce((sum, i) => sum + i.effectiveWeight, 0),
    macroScaling: {
      correlation: corr.value,
      correlationSource: corr.source,
      floor,
      factor,
      freedWeight: freed,
      redistributedWeight: redistributed,
      redistributedTo: redistributed > 0 ? recipients : [],
    },
    eventCalendar: eventCalendarA10(inputs, config),
  };
}
