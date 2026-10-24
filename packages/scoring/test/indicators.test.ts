import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  adx,
  adxSeries,
  atr,
  atrSeries,
  beta,
  bollingerPercentB,
  candlesFromCloses,
  dailyReturns,
  distanceFromMaInAtr,
  ema,
  emaSeries,
  maSlope,
  maxDrawdown,
  mayerMultiple,
  pearsonCorrelation,
  pivotPoints,
  rateOfChange,
  realisedVolatility,
  resampleCandles,
  returnCorrelation,
  rsi,
  rsiSeries,
  sampleEvery,
  sma,
  smaSeries,
  trueRangeSeries,
  upDownVolumeRatio,
  type HLC,
} from '../src/indicators';
import * as lab from '../src/lab/reference';
import type { Candle } from '../src/types';

// Hand-computed fixtures below were re-derived independently in Python before being written
// here (scratch script, not committed); the published worked examples are loaded from
// test/__fixtures__ with their source cited inside each file.

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')) as T;

interface RsiFixture {
  readonly close: number[];
  readonly rsi: (number | null)[];
  readonly avgGain: (number | null)[];
  readonly avgLoss: (number | null)[];
}
interface AdxTable {
  readonly high: number[];
  readonly low: number[];
  readonly close: number[];
  readonly trueRange: (number | null)[];
  readonly plusDI14: (number | null)[];
  readonly minusDI14: (number | null)[];
  readonly dx: (number | null)[];
  readonly adx: (number | null)[];
}
const toHlc = (t: AdxTable): HLC[] =>
  t.close.map((close, k) => ({ high: t.high[k]!, low: t.low[k]!, close }));

/** Deterministic pseudo-random walk for cross-checks (no Math.random). */
function walk(n: number, seed = 7): number[] {
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out = [100];
  for (let k = 1; k < n; k++) out.push(out[k - 1]! * (1 + (next() - 0.5) * 0.08));
  return out;
}

describe('moving averages (M1, M2, H3, K3)', () => {
  it('sma averages the last `period` values and is null without enough history', () => {
    const v = [1, 2, 3, 4, 5];
    expect(sma(v, 3)).toBe(4);
    expect(sma(v, 3, 2)).toBe(2);
    expect(sma(v, 3, 1)).toBeNull();
    expect(smaSeries(v, 2)).toEqual([null, 1.5, 2.5, 3.5, 4.5]);
  });

  it('ema seeds with the SMA and smooths with 2 / (period + 1)', () => {
    expect(emaSeries([10, 11, 12, 13, 14], 3)).toEqual([null, null, 11, 12, 13]);
    expect(ema([10, 11, 12, 13, 14], 3, 3)).toBe(12);
    expect(ema([10, 11], 3)).toBeNull();
  });

  it('maSlope is the percent change of the MA over N days (M2 = 50D MA over 14D)', () => {
    const linear = Array.from({ length: 30 }, (_, k) => k + 1);
    // SMA5 at the end = mean(26..30) = 28; three bars earlier = mean(23..27) = 25.
    expect(maSlope(linear, 5, 3)).toBeCloseTo(28 / 25 - 1, 15);
    expect(maSlope(linear, 5, 27)).toBeNull();
  });

  it('rateOfChange (M3, M4, M5)', () => {
    expect(rateOfChange([100, 110, 121], 2)).toBeCloseTo(0.21, 15);
    expect(rateOfChange([100, 110, 121], 1)).toBeCloseTo(0.1, 15);
    expect(rateOfChange([100, 110], 2)).toBeNull();
  });

  it('mayerMultiple = close / 200-day SMA (H3)', () => {
    const flat = new Array<number>(200).fill(10);
    expect(mayerMultiple(flat)).toBe(1);
    const up = [...new Array<number>(199).fill(10), 12];
    expect(mayerMultiple(up)).toBeCloseTo(12 / 10.01, 14);
    expect(mayerMultiple(flat.slice(0, 199))).toBeNull();
  });
});

describe('RSI(14) Wilder (H1)', () => {
  const rsiFx = fixture<RsiFixture>('SAMPLE_chartschool-rsi-qqqq.json');

  it('reproduces the StockCharts ChartSchool worked example (QQQQ, cs-rsi.xls) exactly', () => {
    // Source: StockCharts ChartSchool, "Relative Strength Index (RSI)", spreadsheet cs-rsi.xls.
    // All 19 published RSI values (70.53 first, 37.77 last) reproduce to float precision; the
    // same figures were reproduced independently in Python first.
    const ours = rsiSeries(rsiFx.close, 14);
    const published = rsiFx.rsi;
    expect(ours.length).toBe(published.length);
    let compared = 0;
    published.forEach((p, k) => {
      if (p == null) {
        expect(ours[k]).toBeNull();
        return;
      }
      expect(ours[k]).toBeCloseTo(p, 10);
      compared++;
    });
    expect(compared).toBe(19);
    expect(ours[14]).toBeCloseTo(70.53278948369497, 10);
    expect(rsi(rsiFx.close)).toBeCloseTo(37.77295211443486, 10);
  });

  it('first averages are simple means of the first 14 gains and losses', () => {
    // Published first Average Gain 0.2384 and Average Loss 0.0996 (spreadsheet row 15).
    const closes = rsiFx.close.slice(0, 15);
    const changes = closes.slice(1).map((c, k) => c - closes[k]!);
    const gain = changes.reduce((s, d) => s + Math.max(d, 0), 0) / 14;
    const loss = changes.reduce((s, d) => s + Math.max(-d, 0), 0) / 14;
    expect(gain).toBeCloseTo(rsiFx.avgGain[14]!, 12);
    expect(loss).toBeCloseTo(rsiFx.avgLoss[14]!, 12);
  });

  it('is 100 with no losses, 0 with no gains, 50 with no movement, null when too short', () => {
    const up = Array.from({ length: 20 }, (_, k) => 10 + k);
    const down = up.slice().reverse();
    expect(rsi(up)).toBe(100);
    expect(rsi(down)).toBe(0);
    expect(rsi(new Array<number>(20).fill(5))).toBe(50);
    expect(rsi(up.slice(0, 14))).toBeNull();
    expect(rsi(up.slice(0, 15))).toBe(100);
  });

  it('reads only bars up to `end` and supports a limited warm-up window', () => {
    const p = walk(400);
    expect(rsi(p, { end: 200 })).toBe(rsiSeries(p.slice(0, 201))[200]);
    expect(rsi(p, { changes: null })).toBe(rsiSeries(p)[399]);
    // The Lab keeps only the last 4 x 14 + 1 changes; same Wilder recursion otherwise.
    expect(rsi(p, { changes: 57 })).toBeCloseTo(lab.rsi(p, 399), 9);
  });

  it('weekly candles for the Long horizon: every 7th close ending on the scored day', () => {
    const p = walk(800);
    const weekly = sampleEvery(p, 7);
    expect(weekly[weekly.length - 1]).toBe(p[799]);
    expect(weekly[weekly.length - 2]).toBe(p[792]);
    // Lab weekly RSI = Wilder over the same weekly closes with its 57-change window.
    expect(rsi(weekly, { changes: 57 })).toBeCloseTo(lab.rsi(p, 799, 7), 9);
  });
});

describe('true range and ATR(14) Wilder (H2, 5.4 zone merging)', () => {
  const candles: HLC[] = [
    { high: 10, low: 8, close: 9 },
    { high: 11, low: 9, close: 10 },
    { high: 12, low: 9.5, close: 9.6 },
    { high: 10, low: 7, close: 8 },
    { high: 9, low: 8.5, close: 8.8 },
  ];

  it('true range takes the largest of high-low and the gaps to the previous close', () => {
    // Bar 4: high - low = 0.5 but high - previous close = 1, so the gap wins.
    expect(trueRangeSeries(candles)).toEqual([null, 2, 2.5, 3, 1]);
  });

  it('ATR seeds with the mean TR of bars 1..period, then (prev x (n - 1) + TR) / n', () => {
    expect(atrSeries(candles, 2)).toEqual([null, null, 2.25, 2.625, 1.8125]);
    expect(atr(candles, 2)).toBe(1.8125);
    expect(atr(candles, 2, 3)).toBe(2.625);
    expect(atr(candles, 14)).toBeNull();
  });

  it('matches TR14 / 14 of the StockCharts ADX worksheet (Wilder smoothing of true range)', () => {
    // Source: StockCharts ChartSchool, "Average Directional Index (ADX)", cs-adx.xls, sheet adx.
    const t = fixture<{ full: AdxTable }>('SAMPLE_chartschool-adx-qqqq.json').full;
    const ours = trueRangeSeries(toHlc(t));
    t.trueRange.forEach((tr, k) => {
      if (tr == null) expect(ours[k]).toBeNull();
      else expect(ours[k]).toBeCloseTo(tr, 12);
    });
    // TR14 is a Wilder running sum: TR14 = TR14 - TR14/14 + TR, so ATR = TR14 / 14.
    const a = atrSeries(toHlc(t), 14);
    let tr14 = 0;
    for (let k = 1; k <= 14; k++) tr14 += ours[k]!;
    expect(a[14]).toBeCloseTo(tr14 / 14, 12);
    for (let k = 15; k < t.close.length; k++) {
      tr14 = tr14 - tr14 / 14 + ours[k]!;
      expect(a[k]).toBeCloseTo(tr14 / 14, 10);
    }
  });

  it('on close-only data TR is |close change|, so the Lab ATR is its plain 14-bar mean', () => {
    const p = walk(120);
    const tr = trueRangeSeries(candlesFromCloses(p));
    let s = 0;
    for (let j = 119 - 13; j <= 119; j++) s += tr[j]!;
    expect(lab.atr(p, 119)).toBe(s / 14);
    // ...while the engine ATR is Wilder-smoothed over the whole history (DISCREPANCIES D-04).
    expect(atr(candlesFromCloses(p))).not.toBe(lab.atr(p, 119));
  });
});

describe('ADX(14) with +DI / -DI (M6)', () => {
  const fx = fixture<{ full: AdxTable; excerpt: AdxTable }>('SAMPLE_chartschool-adx-qqqq.json');

  it('reproduces the StockCharts ChartSchool ADX worksheet (QQQQ, cs-adx.xls, sheet adx) exactly', () => {
    // Source: StockCharts ChartSchool, "Average Directional Index (ADX)", spreadsheet cs-adx.xls.
    // +DI14, -DI14 and DX from bar 14, ADX from bar 27 (first ADX 33.58) all reproduce to float
    // precision; verified independently in Python over all 504 rows of the sheet first.
    const t = fx.full;
    const s = adxSeries(toHlc(t), 14);
    let compared = 0;
    for (let k = 0; k < t.close.length; k++) {
      for (const [ours, published] of [
        [s.plusDI[k], t.plusDI14[k]],
        [s.minusDI[k], t.minusDI14[k]],
        [s.dx[k], t.dx[k]],
        [s.adx[k], t.adx[k]],
      ] as const) {
        if (published == null) expect(ours).toBeNull();
        else {
          expect(ours).toBeCloseTo(published, 9);
          compared++;
        }
      }
    }
    expect(compared).toBe(34 * 3 + 21);
    expect(s.adx[27]).toBeCloseTo(33.583346060760995, 10);
  });

  it('matches the excerpt shown on the ChartSchool page except its first ADX, which uses 13 DX values', () => {
    // The web page's 30-row table (sheet "image") prints a first ADX of 21.56 one bar early:
    // it is the mean of 13 DX values. Textbook Wilder (and the full sheet above) averages 14,
    // so the engine has no ADX at that bar. Every later value matches, because
    // (13-mean x 13 + DX) / 14 equals the 14-value mean.
    const t = fx.excerpt;
    const s = adxSeries(toHlc(t), 14);
    expect(t.adx[26]).toBeCloseTo(21.5614, 4);
    expect(s.adx[26]).toBeNull();
    const dx13 = t.dx.slice(14, 27).reduce<number>((a, b) => a + b!, 0) / 13;
    expect(dx13).toBeCloseTo(t.adx[26]!, 10);
    for (const k of [27, 28, 29]) expect(s.adx[k]).toBeCloseTo(t.adx[k]!, 9);
    expect(s.adx[29]).toBeCloseTo(20.3888, 4);
  });

  it('adx() reports the sign of the direction for M6', () => {
    const t = fx.full;
    const reading = adx(toHlc(t), 14, 30)!;
    expect(reading.adx).toBeCloseTo(t.adx[30]!, 9);
    // Bar 30 (sheet row 32): +DI 21.97 > -DI 18.74, so the signed value is positive.
    expect(reading.signed).toBe(reading.adx);
    const falling = candlesFromCloses(Array.from({ length: 40 }, (_, k) => 100 - k + (k % 3)));
    const r = adx(falling)!;
    expect(r.minusDI).toBeGreaterThan(r.plusDI);
    expect(r.signed).toBe(-r.adx);
    expect(adx(toHlc(t), 14, 26)).toBeNull();
  });
});

describe('Bollinger %B(20, 2) (H4)', () => {
  it('maps the lower band to 0 and the upper band to 1, population standard deviation', () => {
    // [1..5], mean 3, population sd sqrt(2): (5 - (3 - 2 sqrt 2)) / (4 sqrt 2) = 0.853553...
    expect(bollingerPercentB([1, 2, 3, 4, 5], 5, 2)).toBeCloseTo(0.8535533905932736, 14);
    expect(bollingerPercentB([1, 2, 3, 4, 5], 5, 2, 3)).toBeNull();
    expect(bollingerPercentB([2, 2, 2, 2, 2], 5, 2)).toBeNull();
  });

  it('equals the Lab H4 formula', () => {
    const p = walk(60);
    const m = lab.sma(p, 20, 59)!;
    const sd = lab.sd(p, 20, 59);
    expect(bollingerPercentB(p)).toBe((p[59]! - (m - 2 * sd)) / (4 * sd));
  });
});

describe('distance from the 20D MA in ATR units (H2)', () => {
  it('(close - SMA) / ATR', () => {
    // closes 10, 11, 13, 12, 15: ATR(2) Wilder = 2.125, SMA(3) = 13.333..., distance 0.78431...
    const c = candlesFromCloses([10, 11, 13, 12, 15]);
    expect(distanceFromMaInAtr(c, { maPeriod: 3, atrPeriod: 2 })).toBeCloseTo(
      0.7843137254901958,
      14,
    );
    expect(
      distanceFromMaInAtr(candlesFromCloses([10, 10, 10, 10]), { maPeriod: 3, atrPeriod: 2 }),
    ).toBeNull();
  });
});

describe('returns and risk (R1, R2, S1)', () => {
  it('dailyReturns, log or simple', () => {
    expect(dailyReturns([100, 110, 99], 1, 2, 'simple').map((x) => +x.toFixed(12))).toEqual([
      0.1, -0.1,
    ]);
    expect(dailyReturns([100, 110, 99], 1, 2, 'log')).toEqual([Math.log(1.1), Math.log(99 / 110)]);
  });

  it('realised volatility = sample stdev of daily returns x sqrt(365) (R1)', () => {
    const p = [100, 110, 99, 108.9];
    expect(realisedVolatility(p, { days: 3 })).toBeCloseTo(2.2134502273073706, 13);
    expect(realisedVolatility(p, { days: 3, returns: 'simple' })).toBeCloseTo(
      2.2060522810365737,
      13,
    );
    expect(realisedVolatility(p, { days: 4 })).toBeNull();
  });

  it('simple-return volatility equals the Lab R1 formula bit for bit', () => {
    const p = walk(200);
    expect(realisedVolatility(p, { returns: 'simple' })).toBe(
      lab.stdev(lab.rets(p, 199, 90)) * Math.sqrt(365),
    );
  });

  it('max drawdown over a window (R2)', () => {
    const p = [100, 120, 90, 110, 60, 80];
    expect(maxDrawdown(p, 6)).toBe(0.5);
    expect(maxDrawdown(p, 3)).toBeCloseTo(1 - 60 / 110, 15);
    expect(maxDrawdown(p, 365)).toBe(0.5);
    expect(maxDrawdown([1, 2, 3])).toBe(0);
    const w = walk(500);
    expect(maxDrawdown(w, 365)).toBe(lab.maxDD(w, 499, 365));
  });

  it('beta = cov / var of daily returns (S1 Tide)', () => {
    const btc = [100, 105, 102, 108, 107];
    const asset = btc.map((x) => (x * x) / 100); // log returns exactly twice Bitcoin's
    expect(beta(asset, btc, { days: 4 })).toBeCloseTo(2, 12);
    expect(beta(asset, btc, { days: 4, returns: 'simple' })).toBeCloseTo(2.03259948744435, 12);
    expect(beta(btc, btc, { days: 4 })).toBe(1);
    expect(beta(asset, btc, { days: 5 })).toBeNull();
    expect(() => beta(asset.slice(1), btc)).toThrow(RangeError);
  });

  it('Pearson correlation and 90D return correlation (5.1 macro scaling)', () => {
    expect(pearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 15);
    expect(pearsonCorrelation([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 15);
    expect(pearsonCorrelation([1, 2, 3], [1, 3, 2])).toBeCloseTo(0.5, 15);
    expect(pearsonCorrelation([1, 1, 1], [1, 2, 3])).toBeNull();
    const a = walk(120, 1);
    const b = a.map((x) => x * 3);
    expect(returnCorrelation(a, b)).toBeCloseTo(1, 12);
    expect(returnCorrelation(a, walk(120, 99))).toBeGreaterThan(-1);
  });
});

describe('pivots (K1) and volume (M7)', () => {
  it('5-bar pivot highs and lows are strict and need two confirmed bars after them', () => {
    const v = [1, 2, 5, 2, 1, 0, 1, 3, 1];
    expect(pivotPoints(v)).toEqual([
      { index: 2, kind: 'high', value: 5 },
      { index: 5, kind: 'low', value: 0 },
    ]);
    expect(pivotPoints(v, v, { end: 6 })).toEqual([{ index: 2, kind: 'high', value: 5 }]);
    expect(pivotPoints([1, 3, 3, 1, 0])).toEqual([]);
    expect(() => pivotPoints(v, v, { bars: 4 })).toThrow(RangeError);
  });

  it('uses highs for pivot highs and lows for pivot lows', () => {
    const highs = [5, 6, 9, 6, 5];
    const lows = [4, 5, 3, 5, 4];
    // Bar 2 is an outside bar (highest high and lowest low): both a swing high and a swing low.
    expect(pivotPoints(highs, lows)).toEqual([
      { index: 2, kind: 'high', value: 9 },
      { index: 2, kind: 'low', value: 3 },
    ]);
    // Only the high stands out: a pivot high alone.
    expect(pivotPoints([5, 6, 7, 6, 5], [4, 5, 4.5, 5, 4])).toEqual([
      { index: 2, kind: 'high', value: 7 },
    ]);
    // Only the low stands out: a pivot low alone.
    expect(pivotPoints([5, 6, 5, 6, 5], lows)).toEqual([{ index: 2, kind: 'low', value: 3 }]);
  });

  it('up-day volume / down-day volume over 30 days (M7)', () => {
    const closes = [10, 11, 10.5, 10.5, 12];
    const vols = [0, 100, 50, 30, 70];
    expect(upDownVolumeRatio(closes, vols, { days: 4 })).toBe(200 / 50);
    expect(upDownVolumeRatio(closes, vols, { days: 4, flatDays: 'ignore' })).toBe(170 / 50);
    expect(upDownVolumeRatio([1, 2, 3], [0, 5, 6], { days: 2 })).toBe(11);
    expect(upDownVolumeRatio(closes, vols, { days: 5 })).toBeNull();
  });
});

describe('candles', () => {
  it('resampleCandles builds weekly candles aligned to the last bar and drops a partial first week', () => {
    const daily: Candle[] = Array.from({ length: 15 }, (_, k) => ({
      open: k,
      high: k + 2,
      low: k - 1,
      close: k + 0.5,
      volume: 10,
    }));
    const weekly = resampleCandles(daily, 7);
    expect(weekly).toEqual([
      { open: 1, high: 9, low: 0, close: 7.5, volume: 70 },
      { open: 8, high: 16, low: 7, close: 14.5, volume: 70 },
    ]);
    expect(resampleCandles(daily, 7, 9)).toEqual([
      { open: 3, high: 11, low: 2, close: 9.5, volume: 70 },
    ]);
  });

  it('candlesFromCloses sets open = high = low = close', () => {
    expect(candlesFromCloses([3, 4], [7, 8])).toEqual([
      { open: 3, high: 3, low: 3, close: 3, volume: 7 },
      { open: 4, high: 4, low: 4, close: 4, volume: 8 },
    ]);
  });

  it('rejects a non-positive period', () => {
    expect(() => sma([1, 2], 0)).toThrow(RangeError);
    expect(() => rsiSeries([1, 2], 1.5)).toThrow(RangeError);
  });
});
