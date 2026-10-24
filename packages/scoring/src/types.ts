/**
 * Shared types and ID catalogues for the CoinSnipe scoring engine.
 *
 * Master-plan IDs (A1, U3, G2, SG7, ...) are the contract: config keys, functions and tests are
 * named after them. Source: scoring-model-master-plan v0.3 (hub score-lab/coinsnipe-master-plan).
 */

/** Holding horizon. Sets the Quality/Timing blend, the rate-of-change blend and the candles. */
export const HORIZONS = ['short', 'medium', 'long'] as const;
export type Horizon = (typeof HORIZONS)[number];

/** Profile = which archetypes the user chooses to see. A filter the user picks, never advice. */
export const PROFILES = ['safe', 'moderate', 'risky'] as const;
export type Profile = (typeof PROFILES)[number];

/** Status of every master-plan ID (master plan, "How to change this model"). */
export const ID_STATUSES = ['proposed', 'agreed', 'open', 'retired'] as const;
export type IdStatus = (typeof ID_STATUSES)[number];

/** Quality pillars (Q) and Timing parts (T); H is Temperature, which only adjusts Timing. */
export const QUALITY_PILLARS = ['U', 'E', 'T', 'L', 'R'] as const;
export type QualityPillar = (typeof QUALITY_PILLARS)[number];
export const TIMING_PARTS = ['M', 'S'] as const;
export type TimingPart = (typeof TIMING_PARTS)[number];
export const METRIC_PILLARS = [...QUALITY_PILLARS, ...TIMING_PARTS, 'H'] as const;
export type MetricPillar = (typeof METRIC_PILLARS)[number];

/** Level C metric IDs (master plan 7.2 and 7.3), including the retired R3 and S4. */
export const METRIC_IDS = [
  'U1',
  'U2',
  'U3',
  'U4',
  'U5',
  'E1',
  'E2',
  'E3',
  'E4',
  'T1',
  'T2',
  'T3',
  'T4',
  'T5',
  'L1',
  'L2',
  'L3',
  'L4',
  'R1',
  'R2',
  'R3',
  'R4',
  'R5',
  'R6',
  'M1',
  'M2',
  'M3',
  'M4',
  'M5',
  'M6',
  'M7',
  'S1',
  'S2',
  'S3',
  'S4',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

/**
 * Growth metrics (master plan 7.1, "Absolute check"): percent changes that can be negative, so
 * they are never log-transformed.
 */
export const GROWTH_METRIC_IDS = ['U1', 'U2', 'U3', 'E3'] as const satisfies readonly MetricId[];

/** Level A market-weather inputs with a weight (A10 is a flag only). */
export const MARKET_WEIGHT_IDS = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9'] as const;
export type MarketWeightId = (typeof MARKET_WEIGHT_IDS)[number];

/**
 * The measures behind each Level A input (CSN-031). One input can combine several measures with
 * their own weights inside the input (config `levelA.market.parts`); the keys name the raw value
 * the data layer supplies, so "How we scored it" can show them one by one.
 */
export const MARKET_MEASURES = {
  A1: ['btcVs200dma', 'btcSlope50dma', 'btcMaStack'],
  A2: ['stablecoinSupplyChange30d'],
  A3: ['fundingRate', 'openInterestChange30d', 'fearGreed'],
  A4: ['nasdaqVs50dma', 'spxVs50dma', 'vix'],
  A5: ['btcDominanceChange30d'],
  A6: ['dollarIndexChange30d', 'us10yChange30d'],
  A7: ['wtiChange30d', 'goldChange30d'],
  A8: ['globalM2Change3m', 'globalM2ChangeYoY'],
  A9: ['regulationTone', 'geopoliticalRisk'],
} as const satisfies Record<MarketWeightId, readonly string[]>;
export type MarketMeasureKey = (typeof MARKET_MEASURES)[MarketWeightId][number];

/** Measures behind the alt-season inputs C2 and C3 (C1 is a share of coins, not a measure). */
export const CYCLE_MEASURES = ['btcDominanceChange30d', 'ethBtcChange30d'] as const;
export type CycleMeasureKey = (typeof CYCLE_MEASURES)[number];

/**
 * Measures that are scaled against their own history. Two are rule-based and need no scale:
 * the A1 moving-average stack (points) and the A9 regulation tone (already -100..+100).
 */
export const SCALED_MEASURE_KEYS = [
  'btcVs200dma',
  'btcSlope50dma',
  'stablecoinSupplyChange30d',
  'fundingRate',
  'openInterestChange30d',
  'fearGreed',
  'nasdaqVs50dma',
  'spxVs50dma',
  'vix',
  'btcDominanceChange30d',
  'dollarIndexChange30d',
  'us10yChange30d',
  'wtiChange30d',
  'goldChange30d',
  'globalM2Change3m',
  'globalM2ChangeYoY',
  'geopoliticalRisk',
  'ethBtcChange30d',
] as const satisfies readonly (MarketMeasureKey | CycleMeasureKey)[];
export type ScaledMeasureKey = (typeof SCALED_MEASURE_KEYS)[number];

/** How a raw value becomes a sub-score (config `levelA.subScore.method`, DISCREPANCIES D-08). */
export const SUB_SCORE_METHODS = ['zscore', 'minmax', 'fixedScale'] as const;
export type SubScoreMethod = (typeof SUB_SCORE_METHODS)[number];

/** Level A alt-season inputs (master plan 5.2). */
export const CYCLE_IDS = ['C1', 'C2', 'C3'] as const;
export type CycleInputId = (typeof CYCLE_IDS)[number];

/** Level B sector-pulse inputs. */
export const SECTOR_IDS = ['B1', 'B2', 'B3', 'B4', 'B5'] as const;
export type SectorInputId = (typeof SECTOR_IDS)[number];

const range = <P extends string>(prefix: P, from: number, to: number): `${P}${number}`[] => {
  const out: `${P}${number}`[] = [];
  for (let k = from; k <= to; k++) out.push(`${prefix}${k}`);
  return out;
};

/** Every master-plan ID that carries a status in the model config. */
export const MODEL_IDS: readonly string[] = [
  ...range('A', 1, 10),
  ...range('C', 1, 3),
  ...range('D', 1, 5),
  ...range('K', 1, 8),
  ...SECTOR_IDS,
  ...METRIC_IDS,
  ...range('P', 1, 5),
  ...range('G', 1, 5),
  ...range('SG', 1, 14),
];

/** Archetype labels (master plan 7.5). */
export const ARCHETYPES = ['Blue chip', 'Established', 'Emerging', 'Early', 'Hype-driven'] as const;
export type Archetype = (typeof ARCHETYPES)[number];

/** Which way a metric points, or `fixed` when its value is already on a fixed 0-100 style scale. */
export const DIRECTIONS = ['higher', 'lower', 'fixed'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** Peer group a ranked metric is compared within (master plan 7.1). */
export const PEER_SCOPES = ['sector', 'all'] as const;
export type PeerScope = (typeof PEER_SCOPES)[number];

/** One daily (or weekly) candle. Close-only sources can pass high = low = close. */
export interface Candle {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** Value that may be missing. Missing metrics are dropped and the rest reweighted. */
export type Maybe<T> = T | null;
