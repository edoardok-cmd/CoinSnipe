/**
 * Bitcoin outlook (master plan 5.3 and 10; CSN-032): Regime, Fuel, Fragility, the drivers D1-D5,
 * the halving-cycle position, the plain sentence, the history line and the scenarios.
 *
 * Ports the Score Lab's `regimeAt()` and `bitcoinOutlook()` (lines 673-700 of the Lab) with the
 * thresholds in config (`outlook` for the label cut-offs, `levelA.outlook` for the rest), all status
 * proposed. Differences from the Lab, all deliberate and tested:
 * - A part with no data is dropped and the rest reweighted (Fuel: D1 when ETF flows are not
 *   connected; Fragility: D4 when liquidation data is not connected). The Lab scores a missing D4 as 0.
 * - The Lab's regime rule is kept (price vs the 200-day average, slope of the 50-day average); the
 *   200-week average is reported next to it but does not move the label (DISCREPANCIES.md 5.3).
 * - Base rates are an input (CSN-040). Until they exist the history line says so; no rate is invented.
 *
 * Pure: no I/O, no clock. `asOf` comes from the caller.
 */
import { MODEL_CONFIG_V0_3, statusOf, type ModelConfig } from '../config/schema';
import { maSlope, sma } from '../indicators';
import type { KeyLevelsResult } from '../levels/keyLevels';
import type { LiquidationCluster } from '../levels/methods';
import type { IdStatus } from '../types';
import type { MarketWeatherResult } from './marketWeather';
import {
  OUTLOOK_TEMPLATES,
  fillTemplate,
  outlookSentence,
  type Fragility,
  type Fuel,
  type OutlookSentence,
  type Regime,
  type Tier,
} from './outlookSentence';
import { buildScenarios, type Scenario } from './scenarios';
import { clamp, finiteOrNull } from './subScore';

/** Which plan tier each output field belongs to (master plan 14); enforced in CSN-043. */
export const OUTLOOK_FIELD_TIERS = {
  regime: 'free',
  fuel: 'free',
  fragility: 'free',
  levels: 'free',
  sentence: 'free',
  drivers: 'free',
  history: 'pro',
  scenarios: 'pro',
} as const satisfies Record<string, Tier>;

/* ------------------------------------------------------------------------------- inputs */

/**
 * Base rates for the current Regime x Fuel state, from the backtest (CSN-040). `n` is the number
 * of independent periods behind the rates. `higher90` and `fell20` are shares 0-1: higher 90 days
 * later, and fell more than 20% at some point in those 90 days.
 */
export interface OutlookBaseRates {
  /** The state the rates describe; when given and different from today's, they are not shown. */
  readonly regime?: Regime;
  readonly fuel?: Fuel;
  readonly n: number;
  readonly higher90: number;
  readonly fell20: number;
}

/** D5 long-term holder reading (optional, status open; used only when the data layer supplies it). */
export interface LongTermHolderReading {
  readonly state: 'accumulating' | 'distributing' | 'neutral';
  readonly value?: number | null;
}

export interface BitcoinOutlookInput {
  /** The scoring day, 'YYYY-MM-DD'. */
  readonly asOf: string;
  /** Daily Bitcoin closes, oldest first, the last one being asOf. */
  readonly btcCloses?: readonly number[] | null;
  /** The market-weather result: A2, A3, A6 and A8 feed Fuel and Fragility. */
  readonly market?: Pick<MarketWeatherResult, 'inputs'> | null;
  /** D1: spot ETF net flow summed over 20 days, billions of USD. Absent without DefiLlama Pro. */
  readonly etfFlow20dBn?: number | null;
  /** D4: liquidation clusters (CoinGlass). Absent = not connected; an empty list = none found. */
  readonly liquidationClusters?: readonly LiquidationCluster[] | null;
  /** Key levels (computeKeyLevels, CSN-033) for the sentence and the scenarios. */
  readonly levels?: KeyLevelsResult | null;
  /** Base rates for today's Regime x Fuel state (CSN-040). */
  readonly baseRates?: OutlookBaseRates | null;
  /** D5, when the data layer supplies it. */
  readonly longTermHolder?: LongTermHolderReading | null;
}

/* ------------------------------------------------------------------------------- outputs */

export interface RegimeReading {
  /** null when there are too few closes for the 200-day average and the 50-day slope. */
  readonly label: Regime | null;
  readonly price: number | null;
  readonly ma200: number | null;
  readonly ma50: number | null;
  /** Change of the 50-day average over `market.trend.slopeDays`, as a fraction. */
  readonly slope50: number | null;
  /** Price vs the 200-week average (1400 days), as a fraction; shown, not used for the label. */
  readonly vs200w: number | null;
  readonly tier: Tier;
}

export type FuelPartId = 'A2' | 'A8' | 'D1' | 'A6';
export interface FuelPart {
  readonly id: FuelPartId;
  /** -100..+100, or null when the part has no data (dropped). */
  readonly score: number | null;
}
export interface FuelReading {
  readonly label: Fuel | null;
  /** Mean of the parts present, -100..+100; null when none is present. */
  readonly score: number | null;
  readonly parts: readonly FuelPart[];
  readonly missing: readonly FuelPartId[];
  readonly tier: Tier;
}

export type FragilityPartId = 'funding' | 'openInterest' | 'liquidation' | 'sentiment';
export interface FragilityPart {
  readonly id: FragilityPartId;
  /** 0-100 before weighting, or null when the part has no data (dropped). */
  readonly value: number | null;
  /** Configured weight. */
  readonly weight: number;
  /** Share of the score after dropping missing parts and rescaling; 0 when dropped. */
  readonly effectiveWeight: number;
}
export interface FragilityReading {
  readonly label: Fragility | null;
  /** 0-100; null when no part is present. */
  readonly score: number | null;
  readonly parts: readonly FragilityPart[];
  readonly missing: readonly FragilityPartId[];
  /** Distance of the nearest liquidation cluster, percent of price; null when none or no data. */
  readonly nearestClusterPct: number | null;
  readonly tier: Tier;
}

export type DriverId = 'D1' | 'D2' | 'D3' | 'D4' | 'D5';
export interface OutlookDriver {
  readonly id: DriverId;
  readonly name: string;
  /** What it tells us (reviewed copy). */
  readonly tells: string;
  readonly value: number | null;
  readonly unit: string;
  /** Machine state, e.g. 'inflow' or 'unavailable'. */
  readonly state: string;
  /** Plain one-line meaning of today's reading (reviewed copy). */
  readonly meaning: string;
  readonly source: string;
  /** 'Leads price?' text from the master plan table. */
  readonly leads: string;
  readonly available: boolean;
  /** Status in the model config (D1-D4 proposed, D5 open). */
  readonly status: IdStatus | undefined;
  readonly tier: Tier;
}

export interface OutlookHistory {
  /** pending = no base rates yet; ready = n at or above the cut-off; thin = n below it. */
  readonly state: 'pending' | 'ready' | 'thin';
  readonly text: string;
  readonly n: number | null;
  /** Whole percent, rounded from the supplied share; null when pending. */
  readonly higher90Pct: number | null;
  readonly fell20Pct: number | null;
  readonly tier: Tier;
}

export interface BitcoinOutlook {
  readonly asOf: string;
  readonly modelVersion: string;
  readonly regime: RegimeReading;
  readonly fuel: FuelReading;
  readonly fragility: FragilityReading;
  /** D2: months since the halving, null when asOf is not a valid date. */
  readonly halvingMonths: number | null;
  /** D1-D4 always, D5 only when supplied. */
  readonly drivers: readonly OutlookDriver[];
  readonly levels: KeyLevelsResult | null;
  /** Null when a label could not be computed. */
  readonly sentence: OutlookSentence | null;
  readonly history: OutlookHistory;
  readonly scenarios: readonly Scenario[];
  readonly tiers: typeof OUTLOOK_FIELD_TIERS;
}

/* ------------------------------------------------------------------------------- readings */

/** Lab `regimeAt`: Uptrend = above the 200-day average and the 50-day average rising; mirror for Downtrend. */
export function regimeReading(
  closes: readonly number[] | null | undefined,
  config: ModelConfig = MODEL_CONFIG_V0_3,
): RegimeReading {
  const { midMa, longMa, slopeDays } = config.levelA.market.trend;
  const tier = OUTLOOK_FIELD_TIERS.regime;
  const empty: RegimeReading = {
    label: null,
    price: null,
    ma200: null,
    ma50: null,
    slope50: null,
    vs200w: null,
    tier,
  };
  if (!closes || closes.length === 0) return empty;
  const price = closes[closes.length - 1]!;
  const ma200 = sma(closes, longMa);
  const ma50 = sma(closes, midMa);
  const slope50 = maSlope(closes, midMa, slopeDays);
  const ma200w = sma(closes, config.levelA.outlook.longMaDays);
  const vs200w = ma200w !== null && ma200w !== 0 ? price / ma200w - 1 : null;
  const base = { price, ma200, ma50, slope50, vs200w, tier };
  if (![price, ma200, slope50].every((x) => x !== null && Number.isFinite(x)))
    return { ...base, label: null };
  const label: Regime =
    price > ma200! && slope50! > 0
      ? 'Uptrend'
      : price < ma200! && slope50! < 0
        ? 'Downtrend'
        : 'Range';
  return { ...base, label };
}

const subScoreOf = (market: BitcoinOutlookInput['market'], id: 'A2' | 'A6' | 'A8') =>
  finiteOrNull(market?.inputs.find((i) => i.id === id)?.subScore);

/**
 * Lab Fuel: the mean of A2, A8, D1 and A6 sub-scores (-100..+100). D1 = ETF 20-day flow scaled to
 * +-100 at `levelA.outlook.etfFullFlowBn`. A missing part is dropped, so the mean is over the rest.
 */
export function fuelReading(
  market: BitcoinOutlookInput['market'],
  etfFlow20dBn: number | null | undefined,
  config: ModelConfig = MODEL_CONFIG_V0_3,
): FuelReading {
  const etf = finiteOrNull(etfFlow20dBn);
  const d1 =
    etf === null ? null : clamp((etf / config.levelA.outlook.etfFullFlowBn) * 100, -100, 100);
  const parts: FuelPart[] = [
    { id: 'A2', score: subScoreOf(market, 'A2') },
    { id: 'A8', score: subScoreOf(market, 'A8') },
    { id: 'D1', score: d1 },
    { id: 'A6', score: subScoreOf(market, 'A6') },
  ];
  const present = parts.filter((p): p is FuelPart & { score: number } => p.score !== null);
  const score = present.length ? present.reduce((s, p) => s + p.score, 0) / present.length : null;
  const { fuelUp, fuelDown } = config.outlook;
  const label: Fuel | null =
    score === null ? null : score > fuelUp ? 'Rising' : score < fuelDown ? 'Falling' : 'Flat';
  return {
    label,
    score,
    parts,
    missing: parts.filter((p) => p.score === null).map((p) => p.id),
    tier: OUTLOOK_FIELD_TIERS.fuel,
  };
}

/** Distance in percent from `price` to the nearest cluster, or null when there is none. */
function nearestClusterPct(
  price: number | null,
  clusters: readonly LiquidationCluster[],
): number | null {
  if (price === null || !(price > 0)) return null;
  const d = clusters
    .filter((c) => Number.isFinite(c.price) && c.price > 0)
    .map((c) => Math.abs(c.price / price - 1) * 100);
  return d.length ? Math.min(...d) : null;
}

/**
 * Lab Fragility: funding, open interest, liquidation-cluster proximity and sentiment distance
 * from neutral, each 0-100, weighted .4/.3/.15/.15 and rescaled over the parts present.
 */
export function fragilityReading(
  market: BitcoinOutlookInput['market'],
  price: number | null,
  clusters: readonly LiquidationCluster[] | null | undefined,
  config: ModelConfig = MODEL_CONFIG_V0_3,
): FragilityReading {
  const o = config.levelA.outlook;
  const raw = market?.inputs.find((i) => i.id === 'A3')?.raw ?? {};
  const funding = finiteOrNull(raw['fundingRate']);
  const oi30 = finiteOrNull(raw['openInterestChange30d']);
  const fng = finiteOrNull(raw['fearGreed']);
  const near = clusters ? nearestClusterPct(price, clusters) : null;
  const values: Record<FragilityPartId, number | null> = {
    funding: funding === null ? null : clamp((funding / o.fundingFull) * 100, 0, 100),
    openInterest: oi30 === null ? null : clamp((oi30 / o.openInterestFull) * 100, 0, 100),
    // Clusters supplied but none found (or none usable) scores 0: the data is there, nothing is near.
    liquidation:
      !clusters || price === null || !(price > 0)
        ? null
        : near === null
          ? 0
          : clamp(((o.liquidationBandPct - near) / o.liquidationBandPct) * 100, 0, 100),
    sentiment: fng === null ? null : (Math.abs(fng - 50) / 50) * 100,
  };
  const ids = ['funding', 'openInterest', 'liquidation', 'sentiment'] as const;
  const weightSum = ids.reduce((s, id) => s + (values[id] === null ? 0 : o.fragWeights[id]), 0);
  const parts: FragilityPart[] = ids.map((id) => ({
    id,
    value: values[id],
    weight: o.fragWeights[id],
    effectiveWeight: values[id] === null || weightSum === 0 ? 0 : o.fragWeights[id] / weightSum,
  }));
  const score =
    weightSum > 0 ? parts.reduce((s, p) => s + (p.value ?? 0) * p.effectiveWeight, 0) : null;
  const { fragHigh, fragElev } = config.outlook;
  const label: Fragility | null =
    score === null ? null : score >= fragHigh ? 'High' : score >= fragElev ? 'Elevated' : 'Low';
  return {
    label,
    score,
    parts,
    missing: parts.filter((p) => p.value === null).map((p) => p.id),
    nearestClusterPct: near,
    tier: OUTLOOK_FIELD_TIERS.fragility,
  };
}

/** D2: months since the halving, (asOf - halving) / (daysPerMonth days); null for an invalid asOf. */
export function halvingMonthsSince(
  asOf: string,
  config: ModelConfig = MODEL_CONFIG_V0_3,
): number | null {
  const o = config.levelA.outlook;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const h = Date.parse(`${o.halvingDate}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(h)) return null;
  return (a - h) / (86_400_000 * o.daysPerMonth);
}

/**
 * The history line. `baseRates` absent, empty, malformed or for a different Regime x Fuel state
 * reads 'History not yet computed'; n below `thinHistoryPeriods` appends the thin-history note.
 * Percentages are the supplied shares rounded to whole percent; nothing is estimated here.
 */
export function historyLine(
  baseRates: OutlookBaseRates | null | undefined,
  state: { regime: Regime | null; fuel: Fuel | null },
  config: ModelConfig = MODEL_CONFIG_V0_3,
): OutlookHistory {
  const t = OUTLOOK_TEMPLATES.history;
  const tier = OUTLOOK_FIELD_TIERS.history;
  const pending: OutlookHistory = {
    state: 'pending',
    text: t.pending,
    n: null,
    higher90Pct: null,
    fell20Pct: null,
    tier,
  };
  if (!baseRates) return pending;
  const share = (x: number) => Number.isFinite(x) && x >= 0 && x <= 1;
  const { n, higher90, fell20 } = baseRates;
  if (!(Number.isInteger(n) && n > 0) || !share(higher90) || !share(fell20)) return pending;
  if (baseRates.regime !== undefined && baseRates.regime !== state.regime) return pending;
  if (baseRates.fuel !== undefined && baseRates.fuel !== state.fuel) return pending;
  const higher90Pct = Math.round(higher90 * 100);
  const fell20Pct = Math.round(fell20 * 100);
  const min = config.levelA.outlook.thinHistoryPeriods;
  const isThin = n < min;
  const body = fillTemplate(t.ready, { higher: higher90Pct, fell: fell20Pct, n });
  return {
    state: isThin ? 'thin' : 'ready',
    text: isThin ? `${body} ${fillTemplate(t.thinNote, { min })}` : body,
    n,
    higher90Pct,
    fell20Pct,
    tier,
  };
}

/* ------------------------------------------------------------------------------- drivers */

function buildDrivers(
  input: BitcoinOutlookInput,
  fragility: FragilityReading,
  halvingMonths: number | null,
  config: ModelConfig,
): OutlookDriver[] {
  const T = OUTLOOK_TEMPLATES.drivers;
  const o = config.levelA.outlook;
  const tier = OUTLOOK_FIELD_TIERS.drivers;
  const status = (id: DriverId) => statusOf(config, id) as IdStatus | undefined;
  const out: OutlookDriver[] = [];

  const etf = finiteOrNull(input.etfFlow20dBn);
  const d1State = etf === null ? 'unavailable' : etf > 0 ? 'inflow' : etf < 0 ? 'outflow' : 'flat';
  out.push({
    id: 'D1',
    name: T.D1.name,
    tells: T.D1.tells,
    value: etf,
    unit: 'USD bn',
    state: d1State,
    meaning: T.D1.states[d1State],
    source: T.D1.source,
    leads: T.D1.leads,
    available: etf !== null,
    status: status('D1'),
    tier,
  });

  const [from, to] = o.peakWindowMonths;
  const d2State =
    halvingMonths === null
      ? 'unavailable'
      : halvingMonths < from
        ? 'early'
        : halvingMonths <= to
          ? 'inWindow'
          : 'late';
  const d2Template = T.D2.states[d2State];
  out.push({
    id: 'D2',
    name: T.D2.name,
    tells: T.D2.tells,
    value: halvingMonths,
    unit: 'months',
    state: d2State,
    meaning: fillTemplate(
      d2Template,
      d2State === 'early'
        ? { from }
        : d2State === 'late'
          ? { to }
          : d2State === 'inWindow'
            ? { from, to }
            : {},
    ),
    source: T.D2.source,
    leads: T.D2.leads,
    available: halvingMonths !== null,
    status: status('D2'),
    tier,
  });

  const fng = finiteOrNull(input.market?.inputs.find((i) => i.id === 'A3')?.raw['fearGreed']);
  const d3State =
    fng === null
      ? 'unavailable'
      : fng > o.sentimentExtreme.high
        ? 'extremeGreed'
        : fng < o.sentimentExtreme.low
          ? 'extremeFear'
          : 'neutral';
  out.push({
    id: 'D3',
    name: T.D3.name,
    tells: T.D3.tells,
    value: fng,
    unit: 'index 0-100',
    state: d3State,
    meaning: T.D3.states[d3State],
    source: T.D3.source,
    leads: T.D3.leads,
    available: fng !== null,
    status: status('D3'),
    tier,
  });

  const d4Available = fragility.parts.find((p) => p.id === 'liquidation')?.value != null;
  const d4State = !d4Available
    ? 'unavailable'
    : fragility.nearestClusterPct !== null &&
        fragility.nearestClusterPct < config.levelA.outlook.liquidationBandPct
      ? 'near'
      : 'far';
  out.push({
    id: 'D4',
    name: T.D4.name,
    tells: T.D4.tells,
    value: fragility.nearestClusterPct,
    unit: 'percent from price',
    state: d4State,
    meaning: T.D4.states[d4State],
    source: T.D4.source,
    leads: T.D4.leads,
    available: d4Available,
    status: status('D4'),
    tier,
  });

  if (input.longTermHolder) {
    const s = input.longTermHolder.state;
    out.push({
      id: 'D5',
      name: T.D5.name,
      tells: T.D5.tells,
      value: finiteOrNull(input.longTermHolder.value),
      unit: 'index',
      state: s,
      meaning: T.D5.states[s],
      source: T.D5.source,
      leads: T.D5.leads,
      available: true,
      status: status('D5'),
      tier,
    });
  }
  return out;
}

/* ------------------------------------------------------------------------------- outlook */

/** The full Bitcoin outlook for one day. Deterministic: same input and config, same output. */
export function computeBitcoinOutlook(
  input: BitcoinOutlookInput,
  config: ModelConfig = MODEL_CONFIG_V0_3,
): BitcoinOutlook {
  const closes = input.btcCloses ?? null;
  const regime = regimeReading(closes, config);
  const fuel = fuelReading(input.market, input.etfFlow20dBn, config);
  const lastClose = closes && closes.length ? closes[closes.length - 1]! : null;
  const price =
    lastClose !== null && Number.isFinite(lastClose) ? lastClose : (input.levels?.price ?? null);
  const fragility = fragilityReading(input.market, price, input.liquidationClusters, config);
  const halvingMonths = halvingMonthsSince(input.asOf, config);
  const levels = input.levels ?? null;
  return {
    asOf: input.asOf,
    modelVersion: config.model_version,
    regime,
    fuel,
    fragility,
    halvingMonths,
    drivers: buildDrivers(input, fragility, halvingMonths, config),
    levels,
    sentence: outlookSentence({
      regime: regime.label,
      fuel: fuel.label,
      fragility: fragility.label,
      levels,
    }),
    history: historyLine(input.baseRates, { regime: regime.label, fuel: fuel.label }, config),
    scenarios: buildScenarios(regime.label, levels),
    tiers: OUTLOOK_FIELD_TIERS,
  };
}
