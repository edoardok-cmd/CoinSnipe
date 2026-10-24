/**
 * @coinsnipe/scoring: the CoinSnipe scoring engine (master plan v0.3). Pure TypeScript, no I/O.
 *
 * CSN-030 provides the core: the versioned model config, normalisation (7.1), the indicator
 * library and, under `lab`, line-by-line ports of the Score Lab helpers used to reproduce the
 * golden outputs. CSN-031 adds Level A: market weather (A1-A10) and Bitcoin vs alt season
 * (C1-C3). Level B/C scoring, gates and signals build on these in CSN-032 to CSN-038.
 */
export const SCORING_PACKAGE = '@coinsnipe/scoring' as const;

export * from './types';
export * from './config/schema';
export * from './normalize';
export * as indicators from './indicators';
export type { AdxReading, AdxSeries, HLC, Pivot, ReturnKind } from './indicators';
export * as lab from './lab/reference';
export * from './levelA/marketWeather';
export * from './levelA/altSeason';
export type { Measure as LevelAMeasure, MeasureResult, MissingReason } from './levelA/subScore';
