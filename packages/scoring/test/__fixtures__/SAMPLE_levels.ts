/** Synthetic candles for the key-levels tests (CSN-033). Not market data. */
import type { Candle } from '../../src/types';

export interface SampleSeries {
  readonly daily: Candle[];
  readonly dates: string[];
}

/** ISO date `i` days after 2025-01-01 (UTC). */
export const sampleDate = (i: number): string =>
  new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);

/** Candle around `close` with a symmetric `half` range and a flat volume of 100. */
export const sampleCandle = (close: number, half: number): Candle => ({
  open: close,
  high: close + half,
  low: close - half,
  close,
  volume: 100,
});

const sampleDates = (n: number): string[] => Array.from({ length: n }, (_, i) => sampleDate(i));

/** `n` days at a flat close with +-`half` ranges. */
export function SAMPLE_flat(n: number, close: number, half: number): SampleSeries {
  return {
    daily: Array.from({ length: n }, () => sampleCandle(close, half)),
    dates: sampleDates(n),
  };
}

/** Replace fields of the candle at `i` (a probe into a zone). */
export function SAMPLE_withCandle(s: SampleSeries, i: number, c: Partial<Candle>): SampleSeries {
  const daily = [...s.daily];
  daily[i] = { ...daily[i]!, ...c };
  return { daily, dates: s.dates };
}

/** Rising closes (+1 per day from `start`), the last candle's high equal to its close. */
export function SAMPLE_rising(n: number, start: number): SampleSeries {
  const daily = Array.from({ length: n }, (_, i) => sampleCandle(start + i, 0.5));
  const last = daily[n - 1]!;
  daily[n - 1] = { ...last, high: last.close };
  return { daily, dates: sampleDates(n) };
}

/** Hourly candles (high = low = close): a volume-1 sweep, then `heavy` bars at `at` with volume 100. */
export function SAMPLE_hourlyProfile(
  sweepLow: number,
  sweepHigh: number,
  at: number,
  heavy = 300,
): Candle[] {
  const out: Candle[] = [];
  const steps = 1500;
  for (let i = 0; i < steps; i++) {
    const p = sweepLow + ((sweepHigh - sweepLow) * i) / (steps - 1);
    out.push({ open: p, high: p, low: p, close: p, volume: 1 });
  }
  for (let i = 0; i < heavy; i++) out.push({ open: at, high: at, low: at, close: at, volume: 100 });
  return out;
}
