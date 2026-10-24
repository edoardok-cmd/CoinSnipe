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
