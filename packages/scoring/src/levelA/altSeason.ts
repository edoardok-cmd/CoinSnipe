/**
 * Level A, part 2: Bitcoin vs alt season, 0-100 (master plan 5.2, inputs C1-C3).
 *
 *   C1 Alt season index (50): the share of the top 50 alts by market cap, leaving out gold tokens
 *      (PAXG, XAUT) and stablecoins, whose 90-day return beats Bitcoin's.
 *   C2 Bitcoin dominance (25): its 30-day change; falling dominance scores higher.
 *   C3 ETH vs BTC (25): the 30-day change in the ETH/BTC ratio; a rising ratio scores higher.
 *
 * C1 is already a 0-100 share. C2 and C3 are scaled like the market-weather inputs (same method,
 * ./subScore.ts and DISCREPANCIES.md D-08) to -100..+100 and then mapped to 0-100 with
 * (sub-score + 100) / 2, so a flat reading is 50. The score is the weighted mean of the inputs
 * present (a missing input is dropped and the weights rescaled to 100, and it is listed).
 *
 * Phase: at or above `cycle.altSeason` (65) Alt season, at or below `cycle.btcSeason` (35)
 * Bitcoin season, Mixed in between; both ends are inclusive.
 *
 * Pure and deterministic: no clock, no network. `asOf` is an argument and every history window
 * ends the day before it. Output carries each input's raw value, sub-score, effective weight and
 * source. It describes data only; it never advises.
 */
import { MODEL_CONFIG_V0_3, type ModelConfig } from '../config/schema';
import { rateOfChange } from '../indicators';
import type { CycleInputId, SubScoreMethod } from '../types';
import {
  finiteOrNull,
  noNegativeZero,
  scaleSubScore,
  type Measure,
  type MissingReason,
} from './subScore';

export type AltSeasonPhase = 'Alt season' | 'Bitcoin season' | 'Mixed';

export const ALT_INPUT_NAMES: Readonly<Record<CycleInputId, string>> = {
  C1: 'Alt season index',
  C2: 'Bitcoin dominance',
  C3: 'ETH vs BTC',
};

const WEIGHT_KEY = { C1: 'altIndex', C2: 'dominance', C3: 'ethBtc' } as const;

/* ------------------------------------------------------------------------------- inputs */

/** One coin considered for the C1 top-50 list. */
export interface AltCandidate {
  readonly symbol: string;
  /** Market cap on asOf, in any one currency. Coins without one cannot be ranked. */
  readonly marketCap: number | null | undefined;
  /** Daily closes, oldest first, the last one being asOf (aligned with `btcCloses`). */
  readonly closes: readonly number[] | null | undefined;
  /** True for a stablecoin according to the data layer (the config also lists symbols). */
  readonly isStablecoin?: boolean;
}

/**
 * Everything alt season reads. Dominance change is in percentage points and comes from the data
 * layer (it is the same measure as market weather A5). `btcCloses` and `ethCloses` must be
 * aligned bar for bar, ending on asOf.
 */
export interface AltSeasonInputs {
  /** The scoring day, 'YYYY-MM-DD'. */
  readonly asOf: string;
  readonly btcCloses?: readonly number[] | null;
  readonly ethCloses?: readonly number[] | null;
  readonly alts?: readonly AltCandidate[] | null;
  readonly btcDominanceChange30d?: Measure | null;
  /** Provenance labels, defaults below. */
  readonly priceSource?: string;
}

/* ------------------------------------------------------------------------------- outputs */

export interface C1Detail {
  readonly topN: number;
  readonly returnDays: number;
  /** Bitcoin's return over the window, in percent. */
  readonly btcReturn: number;
  /** Alts in the top list that had a return (the denominator). */
  readonly counted: number;
  /** Of those, how many beat Bitcoin (strictly). */
  readonly beat: number;
  /** Symbols left out as gold tokens, stablecoins or Bitcoin itself. */
  readonly excluded: readonly string[];
  /** Top-list alts without enough price history; they are not counted either way. */
  readonly unrated: readonly string[];
}

export interface AltInputScore {
  readonly id: CycleInputId;
  readonly name: string;
  readonly status: 'ok' | 'missing';
  /** The raw value: C1 share in percent, C2 change in percentage points, C3 change in percent. */
  readonly raw: number | null;
  readonly unit: string;
  /** C2 and C3 on the -100..+100 scale before the 0-100 mapping; null for C1 and when missing. */
  readonly signedSubScore: number | null;
  /** 0-100, or null when missing. */
  readonly subScore: number | null;
  readonly configuredWeight: number;
  readonly source: string;
  readonly missing: MissingReason | null;
  /** C1 only. */
  readonly detail?: C1Detail;
}

export interface AltInputResult extends AltInputScore {
  /** Final share of the score in percent; the present inputs add up to 100. 0 when missing. */
  readonly effectiveWeight: number;
  /** subScore x effectiveWeight / 100. */
  readonly contribution: number | null;
}

export interface AltSeasonResult {
  readonly asOf: string;
  readonly modelVersion: string;
  readonly subScoreMethod: SubScoreMethod;
  /** 0-100, or null when no input could be scored. */
  readonly score: number | null;
  readonly phase: AltSeasonPhase | null;
  /** C1-C3 in order, including a missing one (weight 0). */
  readonly inputs: readonly AltInputResult[];
  readonly missingInputs: readonly CycleInputId[];
  /** 100, or 0 when nothing could be scored. */
  readonly weightSum: number;
}

/* ------------------------------------------------------------------------------- phase */

/** 65 or above Alt season, 35 or below Bitcoin season, Mixed in between (both ends inclusive). */
export function altSeasonPhase(
  score: number,
  config: ModelConfig = MODEL_CONFIG_V0_3,
): AltSeasonPhase {
  if (score >= config.cycle.altSeason) return 'Alt season';
  if (score <= config.cycle.btcSeason) return 'Bitcoin season';
  return 'Mixed';
}

/* ------------------------------------------------------------------------------- inputs C1-C3 */

const missingInput = (
  id: CycleInputId,
  config: ModelConfig,
  unit: string,
  source: string,
  missing: MissingReason,
  detail?: C1Detail,
): AltInputScore => ({
  id,
  name: ALT_INPUT_NAMES[id],
  status: 'missing',
  raw: null,
  unit,
  signedSubScore: null,
  subScore: null,
  configuredWeight: config.cycle[WEIGHT_KEY[id]],
  source,
  missing,
  ...(detail ? { detail } : {}),
});

/** Symbols that never enter the top-alts list: Bitcoin, gold tokens and stablecoins. */
function isExcluded(c: AltCandidate, config: ModelConfig): boolean {
  const sym = c.symbol.toUpperCase();
  return (
    sym === 'BTC' ||
    c.isStablecoin === true ||
    config.cycle.dex.some((x) => x.toUpperCase() === sym) ||
    config.levelA.cycle.stablecoins.some((x) => x.toUpperCase() === sym)
  );
}

/**
 * C1 Alt season index: share of the top `topN` alts by market cap (gold tokens, stablecoins and
 * Bitcoin left out) whose return over `returnDays` beats Bitcoin's. Ties in market cap break by
 * symbol so the result is deterministic.
 */
export function scoreC1(
  inputs: AltSeasonInputs,
  config: ModelConfig = MODEL_CONFIG_V0_3,
): AltInputScore {
  const source = inputs.priceSource ?? 'CoinGecko';
  const { topN, returnDays } = config.levelA.cycle;
  const btcRet = inputs.btcCloses ? rateOfChange(inputs.btcCloses, returnDays) : null;
  if (btcRet === null || !Number.isFinite(btcRet) || !inputs.alts)
    return missingInput('C1', config, '% of top alts', source, 'noValue');

  const excluded: string[] = [];
  const ranked: { c: AltCandidate; cap: number }[] = [];
  for (const c of inputs.alts) {
    if (isExcluded(c, config)) {
      excluded.push(c.symbol);
      continue;
    }
    const cap = finiteOrNull(c.marketCap);
    if (cap !== null && cap > 0) ranked.push({ c, cap });
  }
  ranked.sort(
    (a, b) => b.cap - a.cap || (a.c.symbol < b.c.symbol ? -1 : a.c.symbol > b.c.symbol ? 1 : 0),
  );

  let beat = 0;
  let counted = 0;
  const unrated: string[] = [];
  for (const { c } of ranked.slice(0, topN)) {
    const r = c.closes ? rateOfChange(c.closes, returnDays) : null;
    if (r === null || !Number.isFinite(r)) {
      unrated.push(c.symbol);
      continue;
    }
    counted++;
    if (r > btcRet) beat++;
  }
  const detail: C1Detail = {
    topN,
    returnDays,
    btcReturn: btcRet * 100,
    counted,
    beat,
    excluded,
    unrated,
  };
  if (counted === 0) return missingInput('C1', config, '% of top alts', source, 'noValue', detail);
  const share = (beat / counted) * 100;
  return {
    id: 'C1',
    name: ALT_INPUT_NAMES.C1,
    status: 'ok',
    raw: share,
    unit: '% of top alts',
    signedSubScore: null,
    subScore: share,
    configuredWeight: config.cycle.altIndex,
    source,
    missing: null,
    detail,
  };
}

/** Signed -100..+100 sub-score to the 0-100 scale of alt season. */
const toZeroHundred = (signed: number): number => (signed + 100) / 2;

/** C2 Bitcoin dominance: 30-day change in percentage points; falling dominance scores higher. */
export function scoreC2(
  inputs: AltSeasonInputs,
  config: ModelConfig = MODEL_CONFIG_V0_3,
): AltInputScore {
  const m = inputs.btcDominanceChange30d;
  const source = m?.source ?? 'CoinGecko';
  const unit = 'percentage points';
  const o = scaleSubScore(
    'btcDominanceChange30d',
    m?.value,
    m?.history,
    { centre: 'history', direction: -1 },
    config.levelA.subScore,
  );
  if (o.score === null) return missingInput('C2', config, unit, source, o.missing ?? 'noValue');
  return {
    id: 'C2',
    name: ALT_INPUT_NAMES.C2,
    status: 'ok',
    raw: finiteOrNull(m?.value),
    unit,
    signedSubScore: o.score,
    subScore: toZeroHundred(o.score),
    configuredWeight: config.cycle.dominance,
    source,
    missing: null,
  };
}

/** C3 ETH vs BTC: 30-day change in the ETH/BTC ratio, from aligned daily closes. */
export function scoreC3(
  inputs: AltSeasonInputs,
  config: ModelConfig = MODEL_CONFIG_V0_3,
): AltInputScore {
  const source = inputs.priceSource ?? 'CoinGecko';
  const unit = '%';
  const { btcCloses: btc, ethCloses: eth } = inputs;
  if (!btc || !eth || btc.length === 0) return missingInput('C3', config, unit, source, 'noValue');
  if (btc.length !== eth.length)
    throw new RangeError('ethCloses must be aligned with btcCloses (same length, same days)');
  const days = config.levelA.cycle.ethBtcDays;
  const ratio = eth.map((e, j) => e / btc[j]!);
  const last = ratio.length - 1;
  const changeAt = (j: number): number | null => {
    const v = rateOfChange(ratio, days, j);
    return v === null || !Number.isFinite(v) ? null : v * 100;
  };
  const value = changeAt(last);
  const history: number[] = [];
  if (config.levelA.subScore.method !== 'fixedScale')
    for (let j = Math.max(0, last - config.levelA.subScore.historyDays); j < last; j++) {
      const v = changeAt(j);
      if (v !== null) history.push(v);
    }
  const o = scaleSubScore(
    'ethBtcChange30d',
    value,
    history,
    { centre: 'history', direction: 1 },
    config.levelA.subScore,
  );
  if (o.score === null) return missingInput('C3', config, unit, source, o.missing ?? 'noValue');
  return {
    id: 'C3',
    name: ALT_INPUT_NAMES.C3,
    status: 'ok',
    raw: value,
    unit,
    signedSubScore: o.score,
    subScore: toZeroHundred(o.score),
    configuredWeight: config.cycle.ethBtc,
    source,
    missing: null,
  };
}

/* ------------------------------------------------------------------------------- aggregate */

/**
 * Alt season for one day: C1-C3, missing inputs dropped and reweighted, the weighted mean and
 * the phase.
 */
export function altSeason(
  inputs: AltSeasonInputs,
  config: ModelConfig = MODEL_CONFIG_V0_3,
): AltSeasonResult {
  const scores = [scoreC1(inputs, config), scoreC2(inputs, config), scoreC3(inputs, config)];
  const total = scores.reduce((s, i) => (i.subScore === null ? s : s + i.configuredWeight), 0);
  const out: AltInputResult[] = scores.map((s) => {
    const eff = s.subScore === null || total <= 0 ? 0 : (s.configuredWeight / total) * 100;
    return {
      ...s,
      effectiveWeight: eff,
      contribution: s.subScore === null ? null : (s.subScore * eff) / 100,
    };
  });
  const score =
    total > 0 ? noNegativeZero(out.reduce((sum, i) => sum + (i.contribution ?? 0), 0)) : null;
  return {
    asOf: inputs.asOf,
    modelVersion: config.model_version,
    subScoreMethod: config.levelA.subScore.method,
    score,
    phase: score === null ? null : altSeasonPhase(score, config),
    inputs: out,
    missingInputs: scores.filter((s) => s.status === 'missing').map((s) => s.id),
    weightSum: out.reduce((sum, i) => sum + i.effectiveWeight, 0),
  };
}
