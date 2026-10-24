/**
 * Shared Level A helpers (master plan 5.1 and 5.2): the sub-score scale, dates and the
 * per-measure output record. Pure functions; nothing here reads a clock or the network.
 *
 * Sub-score method (DISCREPANCIES.md D-08). The plan says each input "becomes a sub-score from
 * -100 to +100 (clamped against its own 1-year history)" and the CSN-031 brief offers two readings:
 * the value's position between its 1-year minimum and maximum, or a z-score clipped to +-2 and
 * scaled x50. The Score Lab uses neither: it divides every input by its own fixed constant and
 * clamps. Both readings reduce to one shape,
 *
 *     sub-score = direction x clamp((value - centre) / unit x 100, -100, +100)
 *
 * and differ only in where `centre` and `unit` come from:
 *   - zscore (engine default): centre = 1-year mean, unit = zClip x 1-year standard deviation.
 *     With zClip 2 this is exactly "z clipped to +-2, x50". It is the closest to the Lab, whose
 *     fixed constant plays the part of "2 standard deviations".
 *   - minmax: centre = mid-range, unit = half the 1-year range (position between min and max).
 *   - fixedScale: the Lab's constants from config (`levelA.subScore.fixedScale`); no history.
 * A measure with a natural neutral point (GPR baseline 100) overrides `centre` and keeps the
 * history-derived `unit`. Inverted measures (VIX, dominance, dollar, ...) carry direction -1.
 */
import type { ModelConfig } from '../config/schema';
import type { ScaledMeasureKey } from '../types';

export type SubScoreConfig = ModelConfig['levelA']['subScore'];

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const finiteOrNull = (v: number | null | undefined): number | null =>
  isFiniteNumber(v) ? v : null;

export const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
/** Clamp to -100..+100. */
export const clamp100 = (x: number): number => clamp(x, -100, 100);
/** Avoid returning -0 (it prints and compares differently from 0). */
export const noNegativeZero = (x: number): number => (x === 0 ? 0 : x);

/**
 * One raw value as the data layer supplies it. `history` is the same measure on each of the
 * `levelA.subScore.historyDays` days before asOf, oldest first, asOf itself excluded; it is only
 * read by the `zscore` and `minmax` methods. `source` is the provenance label shown to the user.
 */
export interface Measure {
  readonly value: number | null | undefined;
  readonly history?: readonly number[] | null;
  readonly source?: string;
}

/** Why a measure produced no sub-score. */
export type MissingReason = 'noValue' | 'noHistory' | 'noScale';

export interface ScaleRule {
  /** 'history' = centre on the history; a number = a fixed neutral point. */
  readonly centre: 'history' | number;
  /** +1 when a higher value is better for crypto, -1 when it is inverted. */
  readonly direction: 1 | -1;
}

export interface ScaleOutcome {
  /** -100..+100, or null when it could not be scored. */
  readonly score: number | null;
  readonly missing: MissingReason | null;
  readonly centre: number | null;
  /** The distance from `centre` that scores 100 (before direction). */
  readonly unit: number | null;
  /** Unit to use above a threshold when it differs (A3 funding, fixedScale only). */
  readonly aboveUnit: number | null;
}

const NONE: Omit<ScaleOutcome, 'missing'> = {
  score: null,
  centre: null,
  unit: null,
  aboveUnit: null,
};

function meanOf(values: readonly number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/** Sample standard deviation (n - 1) of at least two values. */
function stdevOf(values: readonly number[], mean: number): number {
  let s = 0;
  for (const v of values) s += (v - mean) ** 2;
  return Math.sqrt(s / (values.length - 1));
}

/**
 * Relative tolerance for "these are the same number" and "this history is flat". Summing a
 * constant series whose value is not exactly representable (0.1, 1/3) leaves rounding noise of a
 * few ulps in the mean and standard deviation; 1e-9 of the magnitude is far above that noise and
 * far below any real movement of a market series.
 */
const FLAT_EPS = 1e-9;

const nearlyEqual = (a: number, b: number): boolean =>
  Math.abs(a - b) <= FLAT_EPS * Math.max(Math.abs(a), Math.abs(b));

/** Standard deviation, or 0 when it is only rounding noise relative to the values' size. */
function flatAwareStdev(values: readonly number[], mean: number): number {
  const sd = stdevOf(values, mean);
  let size = 0;
  for (const v of values) size = Math.max(size, Math.abs(v));
  return sd <= FLAT_EPS * size ? 0 : sd;
}

/** The centre and unit of the scale for one measure, per the configured method. */
export function resolveScale(
  key: ScaledMeasureKey,
  history: readonly number[] | null | undefined,
  rule: ScaleRule,
  cfg: SubScoreConfig,
):
  | { centre: number; unit: number; aboveUnit: number | null; missing: null }
  | { missing: MissingReason } {
  if (cfg.method === 'fixedScale') {
    const entry = cfg.fixedScale?.[key];
    if (!entry) return { missing: 'noScale' };
    return {
      centre: entry.centre,
      unit: entry.unit,
      aboveUnit: entry.aboveUnit ?? null,
      missing: null,
    };
  }
  const h = (history ?? []).filter(isFiniteNumber);
  if (h.length < cfg.minHistory) return { missing: 'noHistory' };
  if (cfg.method === 'zscore') {
    const mean = meanOf(h);
    return {
      centre: rule.centre === 'history' ? mean : rule.centre,
      unit: cfg.zClip * flatAwareStdev(h, mean),
      aboveUnit: null,
      missing: null,
    };
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of h) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return {
    centre: rule.centre === 'history' ? (lo + hi) / 2 : rule.centre,
    unit: (hi - lo) / 2,
    aboveUnit: null,
    missing: null,
  };
}

/**
 * direction x clamp((value - centre) / unit x 100). A zero unit (flat history) scores 0 when the
 * value equals the centre (to rounding) and +-100 otherwise.
 */
export function scaleValue(value: number, centre: number, unit: number, direction: 1 | -1): number {
  const raw =
    unit > 0
      ? ((value - centre) / unit) * 100
      : nearlyEqual(value, centre)
        ? 0
        : Math.sign(value - centre) * 100;
  return noNegativeZero(direction * clamp100(raw));
}

/** Score one measure against its own history (see the file header). */
export function scaleSubScore(
  key: ScaledMeasureKey,
  value: number | null | undefined,
  history: readonly number[] | null | undefined,
  rule: ScaleRule,
  cfg: SubScoreConfig,
): ScaleOutcome {
  if (!isFiniteNumber(value)) return { ...NONE, missing: 'noValue' };
  const scale = resolveScale(key, history, rule, cfg);
  if (scale.missing) return { ...NONE, missing: scale.missing };
  return {
    score: scaleValue(value, scale.centre, scale.unit, rule.direction),
    missing: null,
    centre: scale.centre,
    unit: scale.unit,
    aboveUnit: scale.aboveUnit,
  };
}

/* ------------------------------------------------------------------------- output records */

/** One measure inside a Level A input, as "How we scored it" and Pro "every input" render it. */
export interface MeasureResult {
  readonly key: string;
  readonly label: string;
  /** The raw value in the unit of `unit`, or null when missing. */
  readonly raw: number | null;
  readonly unit: string;
  /** -100..+100 for market weather; null when missing. */
  readonly subScore: number | null;
  /** Share of the input, in percent, after dropping missing measures (sums to 100). */
  readonly weight: number;
  /** The weight the config gives it inside the input. */
  readonly configuredWeight: number;
  readonly source: string;
  readonly missing: MissingReason | null;
  /** Date of the observation actually used, for lagged inputs (A8). */
  readonly observedOn?: string;
}

/* ------------------------------------------------------------------------- dates */

const DAY_MS = 86_400_000;

/** Days since 1970-01-01 for a 'YYYY-MM-DD' string; throws RangeError for anything else. */
export function isoDay(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new RangeError(`not a YYYY-MM-DD date: ${JSON.stringify(iso)}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(t).toISOString().slice(0, 10);
  if (back !== iso) throw new RangeError(`not a real calendar date: ${iso}`);
  return t / DAY_MS;
}

/** 'YYYY-MM-DD' for a day number. */
export function isoFromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** A day number shifted by whole calendar months; the day of month is clamped to the month length. */
export function shiftMonths(day: number, months: number): number {
  const d = new Date(day * DAY_MS);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), last)) / DAY_MS;
}

/** Distinct, non-empty source labels joined for display. */
export function joinSources(sources: readonly string[]): string {
  return [...new Set(sources.filter((s) => s.length > 0))].join(', ');
}
