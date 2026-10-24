/**
 * Indicator library for the scoring engine (master plan v0.3, sections 5.4 and 7.3).
 *
 * Textbook definitions: Wilder RSI, ATR and ADX use true range and Wilder smoothing (J. Welles
 * Wilder, "New Concepts in Technical Trading Systems", 1978, as documented by StockCharts
 * ChartSchool). The Score Lab's simplified versions are ported separately in ./lab/reference.ts;
 * the differences are listed in packages/scoring/DISCREPANCIES.md.
 *
 * Conventions
 * - Series are oldest first. Point functions take an `end` index (default: the last bar) and
 *   read only bars at or before it, so a backtest can call them point-in-time.
 * - Functions return `null` when there is not enough history or the value is undefined
 *   (for example a zero-width Bollinger band). Callers treat null as a missing metric.
 * - Daily candles by default; pass weekly candles (see {@link resampleCandles}) for the Long
 *   horizon where the master plan asks for "the horizon's candles".
 * - Pure: no I/O, no clock, no randomness.
 */
import type { Candle } from './types';

/** High/low/close is all the range-based indicators need. */
export type HLC = Pick<Candle, 'high' | 'low' | 'close'>;

/** How daily returns are measured. */
export type ReturnKind = 'log' | 'simple';

const lastOf = (length: number, end: number | undefined): number => end ?? length - 1;

function assertPeriod(name: string, period: number): void {
  if (!Number.isInteger(period) || period < 1)
    throw new RangeError(`${name}: period must be a positive integer, got ${period}`);
}

/** Close-only data as candles (open = high = low = close), for sources without a range. */
export function candlesFromCloses(
  closes: readonly number[],
  volumes?: readonly number[],
): Candle[] {
  return closes.map((close, k) => ({
    open: close,
    high: close,
    low: close,
    close,
    volume: volumes?.[k] ?? 0,
  }));
}

/**
 * Group candles into blocks of `size` bars that end exactly at `end` (default: the last bar),
 * e.g. size 7 turns daily candles into weekly ones aligned to the scoring day. A partial block
 * at the start is dropped. Open = first open, high = max, low = min, close = last close,
 * volume = sum.
 */
export function resampleCandles(candles: readonly Candle[], size = 7, end?: number): Candle[] {
  assertPeriod('resampleCandles', size);
  const last = lastOf(candles.length, end);
  const out: Candle[] = [];
  for (let stop = last; stop - size + 1 >= 0; stop -= size) {
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    for (let j = stop - size + 1; j <= stop; j++) {
      const c = candles[j]!;
      high = Math.max(high, c.high);
      low = Math.min(low, c.low);
      volume += c.volume;
    }
    out.push({
      open: candles[stop - size + 1]!.open,
      high,
      low,
      close: candles[stop]!.close,
      volume,
    });
  }
  return out.reverse();
}

/** Every `step`-th value ending at `end`, oldest first (weekly closes from daily closes). */
export function sampleEvery(values: readonly number[], step: number, end?: number): number[] {
  assertPeriod('sampleEvery', step);
  const out: number[] = [];
  for (let j = lastOf(values.length, end); j >= 0; j -= step) out.push(values[j]!);
  return out.reverse();
}

/* ------------------------------------------------------------------ moving averages */

/** Simple moving average of values[end-period+1..end] (M1, M2, H2, H3, K3). */
export function sma(values: readonly number[], period: number, end?: number): number | null {
  assertPeriod('sma', period);
  const last = lastOf(values.length, end);
  if (last - period + 1 < 0 || last >= values.length) return null;
  let s = 0;
  for (let j = last - period + 1; j <= last; j++) s += values[j]!;
  return s / period;
}

/** SMA at every bar (null during warm-up). */
export function smaSeries(values: readonly number[], period: number): (number | null)[] {
  return values.map((_, k) => sma(values, period, k));
}

/**
 * Exponential moving average, seeded with the SMA of the first `period` values and then
 * EMA = (value - previous EMA) x 2 / (period + 1) + previous EMA.
 */
export function emaSeries(values: readonly number[], period: number): (number | null)[] {
  assertPeriod('ema', period);
  const out: (number | null)[] = values.map(() => null);
  if (values.length < period) return out;
  const alpha = 2 / (period + 1);
  let prev = sma(values, period, period - 1)!;
  out[period - 1] = prev;
  for (let k = period; k < values.length; k++) {
    prev = (values[k]! - prev) * alpha + prev;
    out[k] = prev;
  }
  return out;
}

/** EMA at `end` (default: the last bar). */
export function ema(values: readonly number[], period: number, end?: number): number | null {
  const last = lastOf(values.length, end);
  return emaSeries(values.slice(0, last + 1), period)[last] ?? null;
}

/**
 * Slope of a moving average: MA(end) / MA(end - days) - 1, the percent change of the MA over
 * `days` bars. M2 is maSlope(closes, 50, 14).
 */
export function maSlope(
  values: readonly number[],
  maPeriod: number,
  days: number,
  end?: number,
): number | null {
  const last = lastOf(values.length, end);
  const now = sma(values, maPeriod, last);
  const before = sma(values, maPeriod, last - days);
  if (now == null || before == null || before === 0) return null;
  return now / before - 1;
}

/** Rate of change over `days` bars: value(end) / value(end - days) - 1 (M3, M4, M5). */
export function rateOfChange(values: readonly number[], days: number, end?: number): number | null {
  const last = lastOf(values.length, end);
  if (last - days < 0 || last >= values.length) return null;
  const base = values[last - days]!;
  return base === 0 ? null : values[last]! / base - 1;
}

/* ------------------------------------------------------------------ RSI */

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * Wilder RSI at every bar. The first value (index `period`) uses simple averages of the first
 * `period` gains and losses; later values use Wilder smoothing:
 * avg = (previous avg x (period - 1) + current) / period. RSI is 100 when the average loss is 0
 * and 50 when there was no movement at all.
 */
export function rsiSeries(closes: readonly number[], period = 14): (number | null)[] {
  assertPeriod('rsi', period);
  const out: (number | null)[] = closes.map(() => null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let k = 1; k <= period; k++) {
    const d = closes[k]! - closes[k - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = rsiFromAverages(avgGain, avgLoss);
  for (let k = period + 1; k < closes.length; k++) {
    const d = closes[k]! - closes[k - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[k] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

export interface RsiOptions {
  readonly period?: number;
  readonly end?: number;
  /**
   * Use only the last `changes` price changes up to `end` (null/undefined = the full history,
   * the textbook default). The Score Lab uses 4 x period + 1 changes; see DISCREPANCIES.md.
   */
  readonly changes?: number | null;
}

/** H1: Wilder RSI(14) at `end`. Pass weekly closes for the Long horizon. */
export function rsi(closes: readonly number[], options: RsiOptions = {}): number | null {
  const period = options.period ?? 14;
  const last = lastOf(closes.length, options.end);
  if (last >= closes.length) return null;
  const start = options.changes == null ? 0 : Math.max(0, last - options.changes);
  const window = closes.slice(start, last + 1);
  return rsiSeries(window, period)[window.length - 1] ?? null;
}

/* ------------------------------------------------------------------ true range, ATR, ADX */

/** True range per bar: max(high - low, |high - previous close|, |low - previous close|). Bar 0 is null. */
export function trueRangeSeries(candles: readonly HLC[]): (number | null)[] {
  return candles.map((c, k) => {
    if (k === 0) return null;
    const prevClose = candles[k - 1]!.close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

/**
 * Wilder ATR at every bar. The first value (index `period`) is the mean of the true ranges of
 * bars 1..period; then ATR = (previous ATR x (period - 1) + TR) / period. Equals the "TR14 / 14"
 * of Wilder's ADX worksheet.
 */
export function atrSeries(candles: readonly HLC[], period = 14): (number | null)[] {
  assertPeriod('atr', period);
  const tr = trueRangeSeries(candles);
  const out: (number | null)[] = candles.map(() => null);
  if (candles.length <= period) return out;
  let sum = 0;
  for (let k = 1; k <= period; k++) sum += tr[k]!;
  let prev = sum / period;
  out[period] = prev;
  for (let k = period + 1; k < candles.length; k++) {
    prev = (prev * (period - 1) + tr[k]!) / period;
    out[k] = prev;
  }
  return out;
}

/** ATR(period) at `end` (5.4 zone merging, H2). */
export function atr(candles: readonly HLC[], period = 14, end?: number): number | null {
  const last = lastOf(candles.length, end);
  return atrSeries(candles.slice(0, last + 1), period)[last] ?? null;
}

export interface AdxSeries {
  readonly plusDI: (number | null)[];
  readonly minusDI: (number | null)[];
  readonly dx: (number | null)[];
  readonly adx: (number | null)[];
}

/**
 * Wilder ADX with +DI / -DI at every bar.
 * +DM = high - previous high when that beats previous low - low and is positive, else 0;
 * -DM symmetrically. TR14, +DM14 and -DM14 start as 14-bar sums (bars 1..14) and are then
 * smoothed as S = S - S / 14 + current. +DI = 100 x +DM14 / TR14, DX = 100 x |+DI - -DI| /
 * (+DI + -DI); the first ADX (index 2 x period - 1) is the mean of the first `period` DX values,
 * then ADX = (previous ADX x (period - 1) + DX) / period.
 */
export function adxSeries(candles: readonly HLC[], period = 14): AdxSeries {
  assertPeriod('adx', period);
  const n = candles.length;
  const empty = (): (number | null)[] => candles.map(() => null);
  const plusDI = empty();
  const minusDI = empty();
  const dx = empty();
  const adxOut = empty();
  if (n <= period) return { plusDI, minusDI, dx, adx: adxOut };
  const tr = trueRangeSeries(candles);
  const pdm: number[] = [0];
  const mdm: number[] = [0];
  for (let k = 1; k < n; k++) {
    const up = candles[k]!.high - candles[k - 1]!.high;
    const down = candles[k - 1]!.low - candles[k]!.low;
    pdm.push(up > down && up > 0 ? up : 0);
    mdm.push(down > up && down > 0 ? down : 0);
  }
  let tr14 = 0;
  let p14 = 0;
  let m14 = 0;
  for (let k = 1; k <= period; k++) {
    tr14 += tr[k]!;
    p14 += pdm[k]!;
    m14 += mdm[k]!;
  }
  for (let k = period; k < n; k++) {
    if (k > period) {
      tr14 = tr14 - tr14 / period + tr[k]!;
      p14 = p14 - p14 / period + pdm[k]!;
      m14 = m14 - m14 / period + mdm[k]!;
    }
    const pdi = tr14 === 0 ? 0 : (100 * p14) / tr14;
    const mdi = tr14 === 0 ? 0 : (100 * m14) / tr14;
    plusDI[k] = pdi;
    minusDI[k] = mdi;
    dx[k] = pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
  }
  const first = 2 * period - 1;
  if (n > first) {
    let s = 0;
    for (let k = period; k <= first; k++) s += dx[k]!;
    let prev = s / period;
    adxOut[first] = prev;
    for (let k = first + 1; k < n; k++) {
      prev = (prev * (period - 1) + dx[k]!) / period;
      adxOut[k] = prev;
    }
  }
  return { plusDI, minusDI, dx, adx: adxOut };
}

export interface AdxReading {
  readonly adx: number;
  readonly plusDI: number;
  readonly minusDI: number;
  /** ADX signed by direction: + when +DI >= -DI, - otherwise (M6). */
  readonly signed: number;
}

/** ADX(period) with +DI / -DI at `end`; null during warm-up. */
export function adx(candles: readonly HLC[], period = 14, end?: number): AdxReading | null {
  const last = lastOf(candles.length, end);
  const s = adxSeries(candles.slice(0, last + 1), period);
  const a = s.adx[last];
  const p = s.plusDI[last];
  const m = s.minusDI[last];
  if (a == null || p == null || m == null) return null;
  return { adx: a, plusDI: p, minusDI: m, signed: p >= m ? a : -a };
}

/* ------------------------------------------------------------------ bands and stretch */

/** Population standard deviation of values[end-period+1..end] (Bollinger's definition). */
export function populationStdev(
  values: readonly number[],
  period: number,
  end?: number,
): number | null {
  const last = lastOf(values.length, end);
  const m = sma(values, period, last);
  if (m == null) return null;
  let s = 0;
  for (let j = last - period + 1; j <= last; j++) s += (values[j]! - m) ** 2;
  return Math.sqrt(s / period);
}

/**
 * H4: Bollinger %B(period, k) = (close - lower) / (upper - lower) with bands at SMA +- k x the
 * population standard deviation. 0 = lower band, 1 = upper band; null when the band has no width.
 */
export function bollingerPercentB(
  closes: readonly number[],
  period = 20,
  k = 2,
  end?: number,
): number | null {
  const last = lastOf(closes.length, end);
  const m = sma(closes, period, last);
  const sd = populationStdev(closes, period, last);
  if (m == null || sd == null || sd === 0) return null;
  return (closes[last]! - (m - k * sd)) / (2 * k * sd);
}

/** H3: Mayer multiple = close / 200-bar SMA. */
export function mayerMultiple(
  closes: readonly number[],
  end?: number,
  maPeriod = 200,
): number | null {
  const last = lastOf(closes.length, end);
  const m = sma(closes, maPeriod, last);
  if (m == null || m === 0) return null;
  return closes[last]! / m;
}

export interface DistanceInAtrOptions {
  readonly maPeriod?: number;
  readonly atrPeriod?: number;
  readonly end?: number;
}

/** H2: (close - 20-bar SMA) / ATR(14). */
export function distanceFromMaInAtr(
  candles: readonly HLC[],
  options: DistanceInAtrOptions = {},
): number | null {
  const last = lastOf(candles.length, options.end);
  const closes = candles.slice(0, last + 1).map((c) => c.close);
  const m = sma(closes, options.maPeriod ?? 20, last);
  const a = atr(candles, options.atrPeriod ?? 14, last);
  if (m == null || a == null || a === 0) return null;
  return (closes[last]! - m) / a;
}

/* ------------------------------------------------------------------ returns, risk */

/** Daily returns for bars start..end (each against the bar before), log or simple. */
export function dailyReturns(
  values: readonly number[],
  start: number,
  end: number,
  kind: ReturnKind = 'log',
): number[] {
  const out: number[] = [];
  for (let j = Math.max(1, start); j <= end; j++) {
    const r = values[j]! / values[j - 1]!;
    out.push(kind === 'log' ? Math.log(r) : r - 1);
  }
  return out;
}

/** Sample standard deviation (n - 1); null for fewer than 2 values. */
export function sampleStdev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = values.reduce((s, x) => s + x, 0) / values.length;
  return Math.sqrt(values.reduce((s, x) => s + (x - m) ** 2, 0) / (values.length - 1));
}

export interface WindowOptions {
  /** Number of daily returns in the window. */
  readonly days?: number;
  readonly end?: number;
  readonly returns?: ReturnKind;
}

/**
 * R1: realised volatility = sample standard deviation of the last `days` daily returns
 * (log by default) x sqrt(annualisation). Crypto trades every day, so 365 by default.
 */
export function realisedVolatility(
  closes: readonly number[],
  options: WindowOptions & { readonly annualisation?: number } = {},
): number | null {
  const days = options.days ?? 90;
  const last = lastOf(closes.length, options.end);
  if (last - days < 0 || last >= closes.length) return null;
  const sd = sampleStdev(dailyReturns(closes, last - days + 1, last, options.returns ?? 'log'));
  return sd == null ? null : sd * Math.sqrt(options.annualisation ?? 365);
}

/**
 * R2: largest peak-to-trough fall within the last `window` bars (inclusive of `end`), as a
 * fraction 0..1. Uses whatever history exists when it is shorter than the window.
 */
export function maxDrawdown(values: readonly number[], window = 365, end?: number): number | null {
  const last = lastOf(values.length, end);
  if (last < 0 || last >= values.length) return null;
  let peak = -Infinity;
  let dd = 0;
  for (let j = Math.max(0, last - window + 1); j <= last; j++) {
    peak = Math.max(peak, values[j]!);
    dd = Math.max(dd, 1 - values[j]! / peak);
  }
  return dd;
}

function covariance(
  a: readonly number[],
  b: readonly number[],
): { cov: number; varA: number; varB: number } {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let j = 0; j < n; j++) {
    const da = a[j]! - ma;
    const db = b[j]! - mb;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  return { cov, varA, varB };
}

function alignedReturns(
  a: readonly number[],
  b: readonly number[],
  options: WindowOptions,
  fallbackDays: number,
): [number[], number[]] | null {
  if (a.length !== b.length)
    throw new RangeError('series must be aligned (same length, same dates)');
  const days = options.days ?? fallbackDays;
  const last = lastOf(a.length, options.end);
  if (last - days < 0 || last >= a.length) return null;
  const kind = options.returns ?? 'log';
  return [
    dailyReturns(a, last - days + 1, last, kind),
    dailyReturns(b, last - days + 1, last, kind),
  ];
}

/**
 * Beta of an asset to a benchmark (Bitcoin) = cov(asset, benchmark) / var(benchmark) over the
 * last `days` daily returns (log by default, 90 days). Used by S1 Tide; R3 is retired.
 * Series must be aligned bar for bar.
 */
export function beta(
  asset: readonly number[],
  benchmark: readonly number[],
  options: WindowOptions = {},
): number | null {
  const r = alignedReturns(asset, benchmark, options, 90);
  if (!r) return null;
  const { cov, varB } = covariance(r[0], r[1]);
  return varB === 0 ? null : cov / varB;
}

/** Pearson correlation of two equal-length samples; null when either has no variance. */
export function pearsonCorrelation(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length) throw new RangeError('samples must have the same length');
  if (a.length < 2) return null;
  const { cov, varA, varB } = covariance(a, b);
  return varA === 0 || varB === 0 ? null : cov / Math.sqrt(varA * varB);
}

/**
 * Correlation of daily returns over the last `days` (default 90), e.g. Bitcoin vs Nasdaq for the
 * 5.1 macro scaling. Series must be aligned on the same dates (drop days either market is shut).
 */
export function returnCorrelation(
  a: readonly number[],
  b: readonly number[],
  options: WindowOptions = {},
): number | null {
  const r = alignedReturns(a, b, options, 90);
  return r ? pearsonCorrelation(r[0], r[1]) : null;
}

/* ------------------------------------------------------------------ pivots, volume */

export interface Pivot {
  readonly index: number;
  readonly kind: 'high' | 'low';
  readonly value: number;
}

export interface PivotOptions {
  /** Bars in the pattern, centre included (5 = two bars each side, K1). */
  readonly bars?: number;
  /** First bar index to consider as a pivot centre. */
  readonly from?: number;
  /** Last bar that may be read; a pivot needs (bars - 1) / 2 confirmed bars after it. */
  readonly end?: number;
}

/**
 * K1: N-bar pivot highs and lows. A pivot high is strictly above every other bar's high in the
 * window, a pivot low strictly below every other bar's low. An outside bar (highest high and
 * lowest low of its window) is both, so it is reported twice, high first: it marks a resistance
 * and a support candidate. For close-only data pass the closes as both series (a bar can then
 * never be both).
 */
export function pivotPoints(
  highs: readonly number[],
  lows: readonly number[] = highs,
  options: PivotOptions = {},
): Pivot[] {
  const bars = options.bars ?? 5;
  if (!Number.isInteger(bars) || bars < 3 || bars % 2 === 0)
    throw new RangeError('pivotPoints: bars must be an odd integer >= 3');
  if (highs.length !== lows.length)
    throw new RangeError('highs and lows must have the same length');
  const side = (bars - 1) / 2;
  const last = lastOf(highs.length, options.end);
  const out: Pivot[] = [];
  for (let d = Math.max(side, options.from ?? 0); d <= last - side; d++) {
    let isHigh = true;
    let isLow = true;
    for (let k = d - side; k <= d + side; k++) {
      if (k === d) continue;
      if (!(highs[d]! > highs[k]!)) isHigh = false;
      if (!(lows[d]! < lows[k]!)) isLow = false;
    }
    if (isHigh) out.push({ index: d, kind: 'high', value: highs[d]! });
    if (isLow) out.push({ index: d, kind: 'low', value: lows[d]! });
  }
  return out;
}

export interface UpDownVolumeOptions {
  readonly days?: number;
  readonly end?: number;
  /** Unchanged closes count as up days (the Score Lab's rule) or are ignored. */
  readonly flatDays?: 'up' | 'ignore';
}

/**
 * M7: volume on up days / volume on down days over the last `days` bars (default 30). When
 * there is no down-day volume the up-day volume is divided by 1, as in the Score Lab, so an
 * all-up window still ranks at the top.
 */
export function upDownVolumeRatio(
  closes: readonly number[],
  volumes: readonly number[],
  options: UpDownVolumeOptions = {},
): number | null {
  const days = options.days ?? 30;
  const last = lastOf(closes.length, options.end);
  if (last - days < 0 || last >= closes.length || volumes.length < closes.length) return null;
  let up = 0;
  let down = 0;
  for (let j = last - days + 1; j <= last; j++) {
    const d = closes[j]! - closes[j - 1]!;
    if (d > 0 || (d === 0 && (options.flatDays ?? 'up') === 'up')) up += volumes[j]!;
    else if (d < 0) down += volumes[j]!;
  }
  return up / (down || 1);
}
