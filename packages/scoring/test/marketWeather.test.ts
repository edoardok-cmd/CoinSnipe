import { describe, expect, it, vi } from 'vitest';
import { cloneModelConfig, type ModelConfig } from '../src/config/schema';
import {
  CRYPTO_NATIVE_IDS,
  eventCalendarA10,
  marketWeather,
  marketWeatherLabel,
  regulationToneFromNews,
  scoreA1,
  scoreA2,
  scoreA3,
  scoreA4,
  scoreA5,
  scoreA6,
  scoreA7,
  scoreA8,
  scoreA9,
  type CalendarEvent,
  type Measure,
  type MarketWeatherInputs,
} from '../src/index';
import { MARKET_WEIGHT_IDS } from '../src/types';
import { loadGolden } from './oracle/golden';
import { goldenMarketInputs, labLevelACompatConfig } from './oracle/labLevelACompat';

const ASOF = '2026-10-10';
const CFG = cloneModelConfig();

/** Measure history whose mean is `centre` and whose z-score unit (2 x sd) is exactly `unit`. */
function history(centre: number, unit: number, n = 10): number[] {
  const a = unit / 2 / Math.sqrt(n / (n - 1));
  return Array.from({ length: n }, (_, k) => centre + (k % 2 === 0 ? -a : a));
}
/** A measure whose sub-score is (value - centre) / unit x 100 under the default z-score method. */
const meas = (value: number, centre: number, unit: number, source?: string): Measure => ({
  value,
  history: history(centre, unit),
  ...(source ? { source } : {}),
});

const near = (x: number | null, y: number, digits = 9) => {
  expect(x).not.toBeNull();
  expect(x as number).toBeCloseTo(y, digits);
};

/** Daily closes: `n` values from f(0) to f(n-1). */
const closesOf = (n: number, f: (k: number) => number): number[] =>
  Array.from({ length: n }, (_, k) => f(k));
const mean = (a: readonly number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const sampleSd = (a: readonly number[]) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

/** The inputs without the named fields. */
function without(
  inputs: MarketWeatherInputs,
  keys: readonly (keyof MarketWeatherInputs)[],
): MarketWeatherInputs {
  return Object.fromEntries(
    Object.entries(inputs).filter(([k]) => !(keys as readonly string[]).includes(k)),
  ) as unknown as MarketWeatherInputs;
}

/** Every input present; all but A1 sit at their own 1-year average (sub-score 0). */
function neutralInputs(extra: Partial<MarketWeatherInputs> = {}): MarketWeatherInputs {
  return {
    asOf: ASOF,
    btcCloses: closesOf(600, (k) => 100 + k),
    stablecoinSupplyChange30d: meas(0, 0, 4),
    fundingRate: meas(0, 0, 0.04),
    openInterestChange30d: meas(0, 0, 20),
    fearGreed: meas(50, 50, 50),
    nasdaqVs50dma: meas(0, 0, 5),
    spxVs50dma: meas(0, 0, 5),
    vix: meas(20, 20, 10),
    btcDominanceChange30d: meas(0, 0, 2),
    dollarIndexChange30d: meas(0, 0, 3),
    us10yChange30d: meas(0, 0, 0.4),
    wtiChange30d: meas(0, 0, 15),
    goldChange30d: meas(0, 0, 5),
    globalM2: { threeMonthChange: meas(0, 0, 3), yearlyChange: meas(0, 0, 8) },
    regulationTone: { value: 0 },
    geopoliticalRisk: meas(100, 100, 50),
    btcNasdaqCorrelation: 1,
    ...extra,
  };
}

describe('A1 Bitcoin trend: BTC vs 200D MA 40%, 50D MA slope over 14D 30%, MA stack 30%', () => {
  const rising = closesOf(260, (k) => 100 + k);

  it('computes the raw values and sub-scores against the BTC series own 1-year history', () => {
    const r = scoreA1({ asOf: ASOF, btcCloses: rising });
    expect(r.measures.map((m) => m.key)).toEqual(['btcVs200dma', 'btcSlope50dma', 'btcMaStack']);
    expect(r.measures.map((m) => m.configuredWeight)).toEqual([40, 30, 30]);

    // Independent reading of the plan: close / SMA200 - 1, in percent, scaled by z-score x50.
    const vs = (j: number) => (rising[j]! / mean(rising.slice(j - 199, j + 1)) - 1) * 100;
    const last = rising.length - 1;
    expect(r.raw.btcVs200dma).toBeCloseTo(vs(last), 10);
    const past = Array.from({ length: last - 199 }, (_, k) => vs(199 + k)); // 199..last-1
    const unit = 2 * sampleSd(past);
    const expected = Math.max(-100, Math.min(100, ((vs(last) - mean(past)) / unit) * 100));
    expect(r.measures[0]!.subScore).toBeCloseTo(expected, 9);

    // 50D MA slope over 14D: SMA50(now) / SMA50(14 days ago) - 1.
    const sma50 = (j: number) => mean(rising.slice(j - 49, j + 1));
    expect(r.raw.btcSlope50dma).toBeCloseTo((sma50(last) / sma50(last - 14) - 1) * 100, 10);

    const subs = r.measures.map((m) => m.subScore as number);
    expect(r.subScore).toBeCloseTo(subs[0]! * 0.4 + subs[1]! * 0.3 + subs[2]! * 0.3, 9);
    expect(r.status).toBe('ok');
    expect(r.source).toBe('CoinGecko');
  });

  it('MA stack: one quarter each for above the 20D, 50D, 200D and 50D above 200D', () => {
    const stack = (closes: number[]) => {
      const m = scoreA1({ asOf: ASOF, btcCloses: closes }).measures[2]!;
      return [m.raw, m.subScore];
    };
    expect(stack(rising)).toEqual([4, 100]);
    expect(stack(closesOf(260, (k) => 1000 - k))).toEqual([0, -100]);
    // 200 flat days, 40 days at 200, then 10 days at 110: below all three, but 50D > 200D.
    const one = [...Array(200).fill(100), ...Array(40).fill(200), ...Array(10).fill(110)];
    expect(stack(one)).toEqual([1, -50]);
    // Same, ending at 150: above the 200D only, 50D still above the 200D.
    const two = [...Array(200).fill(100), ...Array(40).fill(200), ...Array(10).fill(150)];
    expect(stack(two)).toEqual([2, 0]);
    // A rising line with a last close under its 20D average but above the 50D and 200D.
    const three = closesOf(250, (k) => 100 + k)
      .slice(0, 249)
      .concat([335]);
    expect(stack(three)).toEqual([3, 50]);
  });

  it('a NaN or infinite close makes the MA stack missing, never "0 of 4" (-100)', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const at of [259, 255, 100]) {
        // 259 = today's close; 255 and 100 sit inside the 20D/50D/200D windows.
        const closes = closesOf(260, (k) => 100 + k);
        closes[at] = bad;
        const stack = scoreA1({ asOf: ASOF, btcCloses: closes }).measures[2]!;
        expect(stack.raw, `${bad} at ${at}`).toBeNull();
        expect(stack.subScore).toBeNull();
        expect(stack.missing).toBe('noValue');
      }
    }
    const r = scoreA1({
      asOf: ASOF,
      btcCloses: Object.assign(
        closesOf(260, (k) => 100 + k),
        { 259: Number.NaN },
      ),
    });
    expect(r.status).not.toBe('ok');
    expect(r.measures[2]!.weight).toBe(0);
    expect(r.subScore === null || r.subScore > -100).toBe(true);
  });

  it('scales against the last 365 days only: an older regime does not change the sub-score', () => {
    // 300 wild days, then 600 calm ones (a drifting line with a small wave). The 1-year history
    // for the last day is days 534-898, all calm; the wild days must not widen the scale.
    const n = 900;
    const closes = closesOf(n, (k) =>
      k < 300 ? 300 + 140 * Math.sin(k / 2) : 300 + 0.5 * (k - 300) + 15 * Math.sin(k / 20),
    );
    const vs = (j: number) => (closes[j]! / mean(closes.slice(j - 199, j + 1)) - 1) * 100;
    const last = n - 1;
    const zsub = (from: number) => {
      const h: number[] = [];
      for (let j = Math.max(from, 199); j < last; j++) h.push(vs(j));
      return Math.max(-100, Math.min(100, ((vs(last) - mean(h)) / (2 * sampleSd(h))) * 100));
    };
    const expected = zsub(last - 365);
    const unbounded = zsub(0);
    expect(Math.abs(expected)).toBeLessThan(99);
    expect(Math.abs(expected - unbounded)).toBeGreaterThan(5); // the test can tell them apart
    const r = scoreA1({ asOf: ASOF, btcCloses: closes });
    expect(r.measures[0]!.subScore).toBeCloseTo(expected, 9);
    expect(r.measures[0]!.subScore).toBeCloseTo(14.664820856, 6);
  });

  it('drops a measure without history and reweights the rest of the input', () => {
    // 205 closes: the 200D average exists on only the last 6 days, so the 5 days of its history
    // are below minHistory (10); the 50D slope has 140 days of history and the stack needs none.
    const r = scoreA1({ asOf: ASOF, btcCloses: closesOf(205, (k) => 100 + k) });
    expect(r.status).toBe('partial');
    expect(r.missingMeasures).toEqual(['btcVs200dma']);
    expect(r.measures.map((m) => m.missing)).toEqual(['noHistory', null, null]);
    expect(r.measures.map((m) => m.weight)).toEqual([0, 50, 50]);
    expect(r.measures[0]!.raw).not.toBeNull(); // the raw value is still reported
    const [, slope, stack] = r.measures.map((m) => m.subScore as number);
    expect(r.subScore).toBeCloseTo(slope! * 0.5 + stack! * 0.5, 9);
    // Under 64 closes there is no 50D average 14 days back: nothing can be computed.
    const none = scoreA1({ asOf: ASOF, btcCloses: closesOf(60, (k) => 100 + k) });
    expect(none.status).toBe('missing');
    expect(none.subScore).toBeNull();
    expect(none.measures.map((m) => m.missing)).toEqual(['noValue', 'noValue', 'noValue']);
    expect(scoreA1({ asOf: ASOF }).status).toBe('missing');
  });
});

describe('A2 Crypto liquidity: stablecoin supply change over 30D', () => {
  it('scores the change against its 1-year history and clamps at +-100', () => {
    const at = (v: number) =>
      scoreA2({ asOf: ASOF, stablecoinSupplyChange30d: meas(v, 0, 4) }).subScore;
    near(at(1), 25);
    near(at(-2), -50);
    near(at(0), 0);
    expect(at(10)).toBe(100);
    expect(at(-10)).toBe(-100);
  });

  it('reports the raw value and the source', () => {
    const r = scoreA2({
      asOf: ASOF,
      stablecoinSupplyChange30d: meas(2.6, 0, 4, 'DefiLlama stablecoins'),
    });
    expect(r.raw).toEqual({ stablecoinSupplyChange30d: 2.6 });
    expect(r.source).toBe('DefiLlama stablecoins');
    expect(r.measures[0]).toMatchObject({ raw: 2.6, weight: 100, configuredWeight: 100 });
  });
});

describe('A3 Leverage and mood: funding (inverted above 0.03% per 8h), open interest 30D, Fear & Greed', () => {
  const thr = 0.03;
  const funding = (v: number) =>
    scoreA3({ asOf: ASOF, fundingRate: meas(v, 0.01, 0.04) }).measures[0]!.subScore as number;

  it('a higher funding rate scores higher up to the threshold', () => {
    near(funding(0.01), 0);
    near(funding(0.02), 25);
    near(funding(0.03), 50); // exactly 0.03 is not "above" it
  });

  it('above the threshold the distance over it scores negative', () => {
    // History unit 0.04: 0.01 over the threshold is -25, 0.04 over is -100.
    near(funding(0.04), -25);
    near(funding(thr + 0.0001), -0.25);
    expect(funding(0.2)).toBe(-100);
    expect(funding(0.02)).toBeGreaterThan(0);
    expect(funding(0.031)).toBeLessThan(0);
  });

  it('combines funding 30%, open interest 30% and Fear & Greed 40%', () => {
    const r = scoreA3({
      asOf: ASOF,
      fundingRate: meas(0.02, 0.01, 0.04), // 25
      openInterestChange30d: meas(10, 0, 20), // 50
      fearGreed: meas(25, 50, 50), // -50
    });
    expect(r.measures.map((m) => m.configuredWeight)).toEqual([30, 30, 40]);
    near(r.subScore, 25 * 0.3 + 50 * 0.3 - 50 * 0.4);
    expect(r.source).toBe('Exchange public APIs, alternative.me');
  });

  it('reweights when Fear & Greed is missing', () => {
    const r = scoreA3({
      asOf: ASOF,
      fundingRate: meas(0.02, 0.01, 0.04),
      openInterestChange30d: meas(10, 0, 20),
    });
    expect(r.status).toBe('partial');
    expect(r.missingMeasures).toEqual(['fearGreed']);
    expect(r.measures.map((m) => m.weight)).toEqual([50, 50, 0]);
    near(r.subScore, 37.5);
  });
});

describe('A4 Stocks and risk appetite: Nasdaq and S&P vs 50D MA, VIX inverted', () => {
  it('scores Nasdaq 35%, S&P 35% and the inverted VIX 30%', () => {
    const r = scoreA4({
      asOf: ASOF,
      nasdaqVs50dma: meas(2.5, 0, 5), // 50
      spxVs50dma: meas(-5, 0, 5), // -100
      vix: meas(15, 20, 10), // calmer than usual: +50 once inverted
    });
    near(r.measures[2]!.subScore, 50);
    near(r.subScore, 0.35 * 50 + 0.35 * -100 + 0.3 * 50);
    expect(r.source).toBe('FRED');
  });

  it('a higher VIX lowers the score', () => {
    const at = (vix: number) =>
      scoreA4({ asOf: ASOF, vix: meas(vix, 20, 10) }).measures[2]!.subScore as number;
    expect(at(30)).toBeLessThan(at(20));
    near(at(30), -100);
    near(at(20), 0);
  });
});

describe('A5 Bitcoin dominance: 30D change, rising is a headwind for alts', () => {
  it('rising dominance scores negative and falling dominance positive', () => {
    const at = (v: number) =>
      scoreA5({ asOf: ASOF, btcDominanceChange30d: meas(v, 0, 2) }).subScore as number;
    near(at(1), -50);
    near(at(-1), 50);
    near(at(0), 0);
    expect(at(5)).toBe(-100);
    expect(at(-5)).toBe(100);
  });
});

describe('A6 Dollar and rates: dollar index 30D change and US 10Y change, both inverted', () => {
  it('scores a stronger dollar and rising yields negative; dollar 60%, yield 40%', () => {
    const r = scoreA6({
      asOf: ASOF,
      dollarIndexChange30d: meas(-1.5, 0, 3), // weaker dollar: +50
      us10yChange30d: meas(0.2, 0, 0.4), // rising yield: -50
    });
    near(r.measures[0]!.subScore, 50);
    near(r.measures[1]!.subScore, -50);
    near(r.subScore, 0.6 * 50 + 0.4 * -50);
  });
});

describe('A7 Oil and gold: WTI 30D change (a spike is inflation risk), gold', () => {
  it('scores an oil spike negative and a gold rise positive; oil 70%, gold 30%', () => {
    const r = scoreA7({
      asOf: ASOF,
      wtiChange30d: meas(15, 0, 15), // spike: -100
      goldChange30d: meas(2.5, 0, 5), // +50
    });
    near(r.measures[0]!.subScore, -100);
    near(r.measures[1]!.subScore, 50);
    near(r.subScore, 0.7 * -100 + 0.3 * 50);
  });

  it('falling oil scores positive', () => {
    near(scoreA7({ asOf: ASOF, wtiChange30d: meas(-7.5, 0, 15) }).subScore, 50);
  });
});

describe('A8 Global M2: 3-month change 60% and yearly change 40%, lagged 70 days', () => {
  /** Monthly M2 levels from 2024-01-01 to 2026-10-01; month k grows by 0.2% x (1 + k mod 5). */
  const months = Array.from({ length: 34 }, (_, k) => k);
  const levels: number[] = [];
  months.reduce((level, k) => {
    levels.push(level);
    return level * (1 + 0.002 * (1 + (k % 5)));
  }, 100);
  const dateOf = (k: number) => {
    const y = 2024 + Math.floor(k / 12);
    const m = (k % 12) + 1;
    return `${y}-${String(m).padStart(2, '0')}-01`;
  };
  const series = months.map((k) => ({ date: dateOf(k), value: levels[k]! }));
  const idx = (date: string) => series.findIndex((p) => p.date === date);

  it('uses the observation from 70 days before asOf (2026-08-01 for 2026-10-10)', () => {
    const r = scoreA8({ asOf: ASOF, globalM2: { series } });
    const m3 = r.measures[0]!;
    expect(m3.observedOn).toBe('2026-08-01');
    expect(r.measures[1]!.observedOn).toBe('2026-08-01');
    const k = idx('2026-08-01');
    near(m3.raw, (levels[k]! / levels[k - 3]! - 1) * 100, 10);
    near(r.measures[1]!.raw, (levels[k]! / levels[k - 12]! - 1) * 100, 10);
    expect(r.measures.map((m) => m.configuredWeight)).toEqual([60, 40]);
    expect(r.status).toBe('ok');
    expect(r.subScore).not.toBeNull();
  });

  it('scales against the 12 observations before the used one: window limit and no look-ahead', () => {
    // Monthly M2 from 2019-01 to 2026-10 (indexes 0..93). The older years are volatile, the last
    // ones calm. Used observation: 2026-08 (index 91). Its history is 2025-08..2026-07 (79..90):
    // not the volatile older years, and not the used observation itself.
    const idxDate = (k: number) =>
      `${2019 + Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}-01`;
    const lv: number[] = [100];
    for (let k = 1; k < 94; k++)
      lv.push(
        lv[k - 1]! * (1 + (k < 60 ? 0.012 * Math.sin(k) : 0.004 + 0.003 * Math.sin(k * 1.7))),
      );
    const ser = lv.map((value, k) => ({ date: idxDate(k), value }));
    const used = 91;
    expect(idxDate(used)).toBe('2026-08-01');
    const change = (k: number, months: number) => (lv[k]! / lv[k - months]! - 1) * 100;
    const z = (value: number, hist: number[]) =>
      Math.max(-100, Math.min(100, ((value - mean(hist)) / (2 * sampleSd(hist))) * 100));
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, k) => from + k);
    const expectFor = (months: number) => {
      const value = change(used, months);
      return {
        good: z(
          value,
          range(79, 90).map((k) => change(k, months)),
        ),
        unbounded: z(
          value,
          range(months, 90).map((k) => change(k, months)),
        ),
        withCurrent: z(
          value,
          range(79, 91).map((k) => change(k, months)),
        ),
      };
    };
    const r = scoreA8({ asOf: ASOF, globalM2: { series: ser } });
    expect(r.measures[0]!.observedOn).toBe('2026-08-01');
    for (const [m, months] of [
      [0, 3],
      [1, 12],
    ] as const) {
      const e = expectFor(months);
      expect(Math.abs(e.good)).toBeLessThan(99);
      expect(Math.abs(e.good - e.unbounded)).toBeGreaterThan(3); // distinguishable from a longer window
      expect(Math.abs(e.good - e.withCurrent)).toBeGreaterThan(1); // ... and from including today's value
      expect(r.measures[m]!.subScore, `${months}m`).toBeCloseTo(e.good, 8);
    }
    const [a, b] = [expectFor(3).good, expectFor(12).good];
    expect(r.subScore).toBeCloseTo(0.6 * a + 0.4 * b, 8);
  });

  it('never reads an observation newer than the lag date', () => {
    const withFuture = [...series, { date: '2026-10-05', value: 1e9 }];
    const a = scoreA8({ asOf: ASOF, globalM2: { series: withFuture } });
    const b = scoreA8({ asOf: ASOF, globalM2: { series } });
    expect(a).toEqual(b);
  });

  it('the lag is a config value: 39 days moves the observation to 2026-09-01', () => {
    const cfg = cloneModelConfig();
    cfg.levelA.market.m2LagDays = 39;
    const r = scoreA8({ asOf: ASOF, globalM2: { series } }, cfg);
    expect(r.measures[0]!.observedOn).toBe('2026-09-01');
    const k = idx('2026-09-01');
    near(r.measures[0]!.raw, (levels[k]! / levels[k - 3]! - 1) * 100, 10);
    // A different lag gives a different reading.
    expect(r.measures[0]!.raw).not.toBe(
      scoreA8({ asOf: ASOF, globalM2: { series } }).measures[0]!.raw,
    );
  });

  it('takes pre-computed changes as given (no lag applied) and drops stale series', () => {
    const given = scoreA8({
      asOf: ASOF,
      globalM2: { threeMonthChange: meas(1.5, 0.5, 1.5), yearlyChange: meas(5, 3, 4) },
    });
    near(given.measures[0]!.subScore, 66.6666666667, 8);
    near(given.measures[1]!.subScore, 50);
    expect(given.measures[0]!.observedOn).toBeUndefined();
    const stale = scoreA8({ asOf: ASOF, globalM2: { series: series.slice(0, 10) } });
    expect(stale.status).toBe('missing');
  });
});

describe('A9 News risk: regulation tone 50% minus geopolitical risk vs baseline 100, 50%', () => {
  it('passes the -100..+100 tone through and scores GPR above 100 negative', () => {
    const r = scoreA9({
      asOf: ASOF,
      regulationTone: { value: 40 },
      // The history mean is 80, but the baseline is the configured 100: 125 is 25 above it.
      geopoliticalRisk: meas(125, 80, 50),
    });
    near(r.measures[0]!.subScore, 40);
    near(r.measures[1]!.subScore, -50);
    near(r.subScore, 0.5 * 40 + 0.5 * -50);
    expect(r.source).toBe('GDELT, CryptoPanic, GPR index (Caldara and Iacoviello)');
  });

  it('GPR below the baseline scores positive', () => {
    near(scoreA9({ asOf: ASOF, geopoliticalRisk: meas(75, 100, 50) }).measures[1]!.subScore, 50);
  });

  it('unconfirmed speculation scores 0', () => {
    const tone = regulationToneFromNews([
      { tone: 100, confirmed: true },
      { tone: 100, confirmed: false },
      { tone: -50, confirmed: true },
    ]);
    near(tone, (100 + 0 - 50) / 3);
    expect(regulationToneFromNews([{ tone: 100, confirmed: false }])).toBe(0);
    expect(regulationToneFromNews([])).toBeNull();
    const r = scoreA9({
      asOf: ASOF,
      regulationNews: [
        { tone: 100, confirmed: false },
        { tone: 100, confirmed: false },
      ],
      geopoliticalRisk: meas(100, 100, 50),
    });
    expect(r.measures[0]).toMatchObject({ raw: 0, subScore: 0, missing: null });
    expect(r.status).toBe('ok');
  });

  it('an explicit tone wins over headlines', () => {
    const r = scoreA9({
      asOf: ASOF,
      regulationTone: { value: 10 },
      regulationNews: [{ tone: 100, confirmed: true }],
    });
    expect(r.raw.regulationTone).toBe(10);
  });
});

describe('A10 Event calendar: flag only, within 7 days', () => {
  const ev = (date: string, kind: CalendarEvent['kind'], extra: Partial<CalendarEvent> = {}) =>
    ({ date, kind, title: `Sample ${kind} ${date}`, ...extra }) as CalendarEvent;

  it('lists FOMC, CPI, ETF decisions and large unlocks from asOf to asOf + 7 days inclusive', () => {
    const r = eventCalendarA10({
      asOf: ASOF,
      events: [
        ev('2026-10-17', 'CPI'), // day 7: in
        ev('2026-10-18', 'FOMC'), // day 8: out
        ev('2026-10-10', 'ETF_DECISION'), // day 0: in
        ev('2026-10-09', 'FOMC'), // yesterday: out
        ev('2026-10-12', 'TOKEN_UNLOCK', { unlockPctSupply: 1 }), // exactly the large threshold: in
        ev('2026-10-12', 'TOKEN_UNLOCK', { unlockPctSupply: 0.99 }), // small: out
        ev('2026-10-13', 'TOKEN_UNLOCK'), // size unknown: out
        ev('2026-10-11', 'FOMC'),
      ],
    });
    expect(r.id).toBe('A10');
    expect(r.weight).toBe(0);
    expect(r.flagged).toBe(true);
    expect(r.events.map((e) => [e.date, e.kind, e.daysAway])).toEqual([
      ['2026-10-10', 'ETF_DECISION', 0],
      ['2026-10-11', 'FOMC', 1],
      ['2026-10-12', 'TOKEN_UNLOCK', 2],
      ['2026-10-17', 'CPI', 7],
    ]);
    expect(r.events[2]!.unlockPctSupply).toBe(1);
    expect(r.events[0]!.unlockPctSupply).toBeNull();
  });

  it('is not flagged when nothing is near, and the window is a config value', () => {
    expect(eventCalendarA10({ asOf: ASOF, events: [ev('2026-10-25', 'FOMC')] }).flagged).toBe(
      false,
    );
    expect(eventCalendarA10({ asOf: ASOF }).events).toEqual([]);
    const cfg = cloneModelConfig();
    cfg.levelA.market.events.windowDays = 20;
    expect(eventCalendarA10({ asOf: ASOF, events: [ev('2026-10-25', 'FOMC')] }, cfg).flagged).toBe(
      true,
    );
  });

  it('has no weight: events change the flags but never the score or the weights', () => {
    const base = marketWeather(neutralInputs());
    const flagged = marketWeather(neutralInputs({ events: [ev('2026-10-11', 'FOMC')] }));
    expect(flagged.eventCalendar.flagged).toBe(true);
    expect(flagged.score).toBe(base.score);
    expect(flagged.inputs).toEqual(base.inputs);
    expect(MARKET_WEIGHT_IDS).not.toContain('A10');
    expect(CFG.market).not.toHaveProperty('A10');
  });

  it('rejects an impossible date', () => {
    expect(() => eventCalendarA10({ asOf: '2026-02-30' })).toThrow(RangeError);
    expect(() => eventCalendarA10({ asOf: ASOF, events: [ev('11 Oct', 'FOMC')] })).toThrow(
      RangeError,
    );
  });
});

describe('sub-score method (DISCREPANCIES D-08)', () => {
  const sub = (cfg: ModelConfig, m: Measure) =>
    scoreA2({ asOf: ASOF, stablecoinSupplyChange30d: m }, cfg);
  const ten = Array.from({ length: 10 }, (_, k) => k + 1); // 1..10: mean 5.5, sd 3.0276503541

  it('zscore (default): z clipped to +-2 and scaled x50', () => {
    const sd = sampleSd(ten);
    near(sub(CFG, { value: 5.5 + sd, history: ten }).subScore, 50);
    near(sub(CFG, { value: 5.5 - sd, history: ten }).subScore, -50);
    near(sub(CFG, { value: 5.5 + 2 * sd, history: ten }).subScore, 100);
    expect(sub(CFG, { value: 5.5 + 3 * sd, history: ten }).subScore).toBe(100);
    expect(sub(CFG, { value: 5.5, history: ten }).subScore).toBe(0);
    expect(CFG.levelA.subScore.method).toBe('zscore');
  });

  it('minmax: the position between the 1-year minimum and maximum', () => {
    const cfg = cloneModelConfig();
    cfg.levelA.subScore.method = 'minmax';
    near(sub(cfg, { value: 10, history: ten }).subScore, 100);
    near(sub(cfg, { value: 1, history: ten }).subScore, -100);
    near(sub(cfg, { value: 5.5, history: ten }).subScore, 0);
    near(sub(cfg, { value: 7.75, history: ten }).subScore, 50);
    near(sub(cfg, { value: 3.25, history: ten }).subScore, -50);
    expect(sub(cfg, { value: 99, history: ten }).subScore).toBe(100); // clamped
  });

  it('fixedScale needs no history and reads the configured table', () => {
    const cfg = labLevelACompatConfig();
    near(sub(cfg, { value: 1 }).subScore, 25); // 1 / 4 x 100
    near(sub(cfg, { value: -4 }).subScore, -100);
  });

  it('a measure without enough history is dropped, not guessed', () => {
    const none = sub(CFG, { value: 1 });
    expect(none.status).toBe('missing');
    expect(none.measures[0]!.missing).toBe('noHistory');
    expect(sub(CFG, { value: 1, history: ten.slice(0, 9) }).status).toBe('missing'); // minHistory 10
    expect(sub(CFG, { value: 1, history: ten }).status).toBe('ok');
    const lax = cloneModelConfig();
    lax.levelA.subScore.minHistory = 5;
    expect(sub(lax, { value: 1, history: ten.slice(0, 5) }).status).toBe('ok');
    expect(sub(CFG, { value: null, history: ten }).measures[0]!.missing).toBe('noValue');
    expect(sub(CFG, { value: Number.NaN, history: ten }).status).toBe('missing');
  });

  it('a flat history cannot set a scale: equal scores 0, anything else is a full move', () => {
    const flat = Array(10).fill(2) as number[];
    expect(sub(CFG, { value: 2, history: flat }).subScore).toBe(0);
    expect(sub(CFG, { value: 2.1, history: flat }).subScore).toBe(100);
    expect(sub(CFG, { value: 1.9, history: flat }).subScore).toBe(-100);
  });

  it('a flat history of a non-exact constant (0.1, 1/3, ...) still scores 0, not rounding noise', () => {
    const minmax = cloneModelConfig();
    minmax.levelA.subScore.method = 'minmax';
    for (const c of [0.1, 0.3, 1 / 3, 61.7, 0.012, -0.7, 1e-7]) {
      const flat = Array<number>(365).fill(c);
      for (const cfg of [CFG, minmax]) {
        expect(
          sub(cfg, { value: c, history: flat }).subScore,
          `${c} ${cfg.levelA.subScore.method}`,
        ).toBe(0);
        expect(sub(cfg, { value: c + Math.abs(c) * 0.01 + 1e-3, history: flat }).subScore).toBe(
          100,
        );
        expect(sub(cfg, { value: c - Math.abs(c) * 0.01 - 1e-3, history: flat }).subScore).toBe(
          -100,
        );
      }
    }
    // A history that really moves, even by a little, is not flat.
    const tiny = Array.from({ length: 10 }, (_, k) => 0.1 + (k % 2) * 1e-6);
    expect(
      Math.abs(sub(CFG, { value: 0.1 + 1e-6, history: tiny }).subScore as number),
    ).toBeGreaterThan(30);
  });

  it('never returns negative zero', () => {
    const r = scoreA5({ asOf: ASOF, btcDominanceChange30d: { value: 5.5, history: ten } });
    expect(Object.is(r.subScore, 0)).toBe(true);
  });
});

describe('macro scaling: A4, A6, A7 x BTC-Nasdaq correlation (floor 0.3, cap 1)', () => {
  const eff = (r: ReturnType<typeof marketWeather>) =>
    Object.fromEntries(r.inputs.map((i) => [i.id, i.effectiveWeight]));

  it('with correlation 0.5 the freed 13.5 goes to A1-A3 pro rata; the weights still add up to 100', () => {
    const r = marketWeather(neutralInputs({ btcNasdaqCorrelation: 0.5 }));
    const w = eff(r);
    expect(r.macroScaling).toMatchObject({
      correlation: 0.5,
      factor: 0.5,
      correlationSource: 'input',
    });
    near(r.macroScaling.freedWeight, 13.5);
    near(r.macroScaling.redistributedWeight, 13.5);
    expect(r.macroScaling.redistributedTo).toEqual([...CRYPTO_NATIVE_IDS]);
    near(w.A4!, 6);
    near(w.A6!, 5);
    near(w.A7!, 2.5);
    near(w.A1!, 20 + (13.5 * 20) / 45);
    near(w.A2!, 15 + (13.5 * 15) / 45);
    near(w.A3!, 10 + (13.5 * 10) / 45);
    expect(w.A5).toBe(8);
    expect(w.A8).toBe(10);
    expect(w.A9).toBe(10);
    expect(Math.abs(r.weightSum - 100)).toBeLessThan(1e-9);
    expect(r.inputs.map((i) => i.configuredWeight)).toEqual([20, 15, 10, 12, 8, 10, 5, 10, 10]);
  });

  it('the plan weights are untouched at correlation 1 and above', () => {
    for (const corr of [1, 1.7]) {
      const r = marketWeather(neutralInputs({ btcNasdaqCorrelation: corr }));
      expect(r.macroScaling.factor).toBe(1);
      expect(r.macroScaling.freedWeight).toBe(0);
      expect(r.macroScaling.redistributedTo).toEqual([]);
      expect(r.inputs.map((i) => i.effectiveWeight)).toEqual([20, 15, 10, 12, 8, 10, 5, 10, 10]);
    }
  });

  it('floors the factor at 0.3 for a low or negative correlation', () => {
    for (const corr of [0.3, 0.1, 0, -0.9]) {
      const r = marketWeather(neutralInputs({ btcNasdaqCorrelation: corr }));
      expect(r.macroScaling.factor).toBe(0.3);
      near(r.inputs.find((i) => i.id === 'A4')!.effectiveWeight, 12 * 0.3);
      near(r.macroScaling.freedWeight, 27 * 0.7);
      expect(Math.abs(r.weightSum - 100)).toBeLessThan(1e-9);
    }
    expect(marketWeather(neutralInputs({ btcNasdaqCorrelation: 0.31 })).macroScaling.factor).toBe(
      0.31,
    );
  });

  it('the floor is a config value', () => {
    const cfg = cloneModelConfig();
    cfg.market.corrFloor = 0.5;
    const r = marketWeather(neutralInputs({ btcNasdaqCorrelation: 0.1 }), cfg);
    expect(r.macroScaling.factor).toBe(0.5);
  });

  it('computes the 90-day correlation of returns from aligned BTC and Nasdaq closes', () => {
    const btc = closesOf(300, (k) => 100 * Math.exp(0.01 * k + 0.2 * Math.sin(k)));
    const same = marketWeather(
      neutralInputs({
        btcNasdaqCorrelation: null,
        btcCloses: btc,
        nasdaqCloses: btc.map((x) => x * 2),
      }),
    );
    expect(same.macroScaling.correlationSource).toBe('computed');
    near(same.macroScaling.correlation, 1, 9);
    expect(same.macroScaling.factor).toBe(1);
    const inverse = marketWeather(
      neutralInputs({
        btcNasdaqCorrelation: null,
        btcCloses: btc,
        nasdaqCloses: btc.map((x) => 1e6 / x),
      }),
    );
    near(inverse.macroScaling.correlation, -1, 9);
    expect(inverse.macroScaling.factor).toBe(0.3);
    expect(() =>
      marketWeather(
        neutralInputs({ btcNasdaqCorrelation: null, btcCloses: btc, nasdaqCloses: btc.slice(1) }),
      ),
    ).toThrow(RangeError);
  });

  it('the correlation window is the config value indicators.correlationDays', () => {
    // Nasdaq mirrors Bitcoin's daily moves for the last 30 days and moves opposite before that.
    const btc = closesOf(200, (k) => 100 * Math.exp(0.003 * k + 0.05 * Math.sin(k * 1.3)));
    const ndx: number[] = [100];
    for (let k = 1; k < btc.length; k++) {
      const r = Math.log(btc[k]! / btc[k - 1]!);
      ndx.push(ndx[k - 1]! * Math.exp(k > 169 ? r : -r));
    }
    const at = (days: number) => {
      const cfg = cloneModelConfig();
      cfg.indicators.correlationDays = days;
      return marketWeather(
        neutralInputs({ btcNasdaqCorrelation: null, btcCloses: btc, nasdaqCloses: ndx }),
        cfg,
      ).macroScaling.correlation as number;
    };
    near(at(30), 1, 9);
    expect(at(90)).toBeLessThan(0.5);
    expect(at(90)).not.toBeCloseTo(at(30), 3);
  });

  it('a missing correlation keeps the plan weights by default, or uses the floor when configured', () => {
    const keep = marketWeather(neutralInputs({ btcNasdaqCorrelation: null }));
    expect(keep.macroScaling).toMatchObject({
      correlation: null,
      correlationSource: 'missing',
      factor: 1,
    });
    const cfg = cloneModelConfig();
    cfg.levelA.market.corrMissing = 'floor';
    expect(
      marketWeather(neutralInputs({ btcNasdaqCorrelation: null }), cfg).macroScaling.factor,
    ).toBe(0.3);
  });

  it('freed weight with no A1-A3 to receive it is dropped and the rest rescaled to 100', () => {
    const i = neutralInputs({ btcNasdaqCorrelation: 0.5 });
    const r = marketWeather(
      without(i, [
        'btcCloses',
        'stablecoinSupplyChange30d',
        'fundingRate',
        'openInterestChange30d',
        'fearGreed',
      ]),
    );
    expect(r.missingInputs).toEqual(['A1', 'A2', 'A3']);
    expect(r.macroScaling.redistributedWeight).toBe(0);
    expect(r.macroScaling.redistributedTo).toEqual([]);
    // 6 + 8 + 5 + 2.5 + 10 + 10 = 41.5
    near(eff(r).A4!, (6 / 41.5) * 100);
    near(eff(r).A5!, (8 / 41.5) * 100);
    expect(Math.abs(r.weightSum - 100)).toBeLessThan(1e-9);
  });
});

describe('missing inputs are dropped, listed and the rest reweighted to 100', () => {
  it('drops A8 and A9 and rescales the other 80 points', () => {
    const r = marketWeather(
      without(neutralInputs(), ['globalM2', 'regulationTone', 'geopoliticalRisk']),
    );
    expect(r.missingInputs).toEqual(['A8', 'A9']);
    expect(r.partialInputs).toEqual([]);
    expect(r.inputs.find((i) => i.id === 'A8')).toMatchObject({
      status: 'missing',
      subScore: null,
      effectiveWeight: 0,
      contribution: null,
      configuredWeight: 10,
    });
    near(r.inputs.find((i) => i.id === 'A1')!.effectiveWeight, 25);
    near(r.inputs.find((i) => i.id === 'A5')!.effectiveWeight, 10);
    expect(Math.abs(r.weightSum - 100)).toBeLessThan(1e-9);
  });

  it('the score is the weighted mean of the inputs that are present', () => {
    const r = marketWeather({
      asOf: ASOF,
      btcNasdaqCorrelation: 1,
      stablecoinSupplyChange30d: meas(4, 0, 4), // +100
      btcDominanceChange30d: meas(2, 0, 2), // -100
    });
    expect(r.missingInputs).toEqual(['A1', 'A3', 'A4', 'A6', 'A7', 'A8', 'A9']);
    near(r.score, (100 * 15 + -100 * 8) / 23);
    near(r.inputs[1]!.effectiveWeight, (15 / 23) * 100);
  });

  it('reports a partly-missing input as partial with its measures listed', () => {
    const r = marketWeather(neutralInputs({ fearGreed: null }));
    expect(r.partialInputs).toEqual(['A3']);
    expect(r.inputs[2]!.missingMeasures).toEqual(['fearGreed']);
    expect(r.missingInputs).toEqual([]);
  });

  it('returns no score and no label when nothing can be scored', () => {
    const r = marketWeather({ asOf: ASOF });
    expect(r.score).toBeNull();
    expect(r.label).toBeNull();
    expect(r.weightSum).toBe(0);
    expect(r.missingInputs).toEqual([...MARKET_WEIGHT_IDS]);
    expect(r.eventCalendar.flagged).toBe(false);
  });
});

describe('labels at the exact boundaries: above +25 Tailwind, -25..+25 Neutral, below -25 Headwind', () => {
  it('marketWeatherLabel', () => {
    expect(marketWeatherLabel(25)).toBe('Neutral');
    expect(marketWeatherLabel(25.000000001)).toBe('Tailwind');
    expect(marketWeatherLabel(-25)).toBe('Neutral');
    expect(marketWeatherLabel(-25.000000001)).toBe('Headwind');
    expect(marketWeatherLabel(0)).toBe('Neutral');
    expect(marketWeatherLabel(100)).toBe('Tailwind');
    expect(marketWeatherLabel(-100)).toBe('Headwind');
  });

  it('end to end: a score of exactly +25 and -25 is Neutral, a hair beyond is not', () => {
    const cfg = labLevelACompatConfig(); // fixed scales make +-25 exact
    const run = (v: number) =>
      marketWeather({ asOf: ASOF, stablecoinSupplyChange30d: { value: v } }, cfg);
    expect(run(1)).toMatchObject({ score: 25, label: 'Neutral' });
    expect(run(-1)).toMatchObject({ score: -25, label: 'Neutral' });
    expect(run(1.0004).label).toBe('Tailwind');
    expect(run(-1.0004).label).toBe('Headwind');
  });

  it('the thresholds are config values', () => {
    const cfg = cloneModelConfig();
    cfg.market.tailwind = 40;
    cfg.market.headwind = -10;
    expect(marketWeatherLabel(30, cfg)).toBe('Neutral');
    expect(marketWeatherLabel(-11, cfg)).toBe('Headwind');
    expect(marketWeatherLabel(40.1, cfg)).toBe('Tailwind');
  });
});

describe('every input and measure carries raw value, sub-score, effective weight and source', () => {
  it('for the UI "How we scored it" and the Pro "every input" view', () => {
    const r = marketWeather(neutralInputs({ btcCloses: closesOf(300, (k) => 100 + k) }));
    expect(r.inputs.map((i) => i.id)).toEqual([...MARKET_WEIGHT_IDS]);
    for (const i of r.inputs) {
      expect(typeof i.name).toBe('string');
      expect(i.subScore).not.toBeNull();
      expect(i.effectiveWeight).toBeGreaterThan(0);
      expect(i.source.length).toBeGreaterThan(0);
      expect(Object.keys(i.raw).sort()).toEqual(i.measures.map((m) => m.key).sort());
      expect(i.measures.reduce((s, m) => s + m.weight, 0)).toBeCloseTo(100, 9);
      for (const m of i.measures) {
        expect(m.raw).not.toBeNull();
        expect(typeof m.subScore).toBe('number');
        expect(m.source.length).toBeGreaterThan(0);
        expect(m.unit.length).toBeGreaterThan(0);
        expect(m.label.length).toBeGreaterThan(0);
      }
      expect(i.contribution).toBeCloseTo((i.subScore! * i.effectiveWeight) / 100, 12);
    }
    expect(r.modelVersion).toBe('0.3');
    expect(r.subScoreMethod).toBe('zscore');
    expect(r.asOf).toBe(ASOF);
  });

  it('the score equals the sum of contributions; a caller-supplied source is passed through', () => {
    const r = marketWeather(
      neutralInputs({ stablecoinSupplyChange30d: meas(2, 0, 4, 'DefiLlama (sample)') }),
    );
    expect(r.inputs[1]!.source).toBe('DefiLlama (sample)');
    expect(r.score).toBeCloseTo(
      r.inputs.reduce((s, i) => s + (i.contribution ?? 0), 0),
      12,
    );
  });
});

describe('config drives the output (R-F5)', () => {
  it('changing a weight in the config changes the result without a code edit', () => {
    const inputs = neutralInputs({
      stablecoinSupplyChange30d: meas(4, 0, 4), // A2 = +100
      btcDominanceChange30d: meas(2, 0, 2), // A5 = -100
    });
    const a = marketWeather(inputs);
    const cfg = cloneModelConfig();
    cfg.market.A2 = 25;
    cfg.market.A1 = 10; // still adds up to 100
    const b = marketWeather(inputs, cfg);
    expect(b.score).not.toBe(a.score);
    near(b.inputs[1]!.effectiveWeight, 25);
    expect(a.inputs[1]!.effectiveWeight).toBe(15);
  });

  it('measure weights inside an input come from the config too', () => {
    const inputs: MarketWeatherInputs = {
      asOf: ASOF,
      dollarIndexChange30d: meas(-1.5, 0, 3), // +50
      us10yChange30d: meas(0.2, 0, 0.4), // -50
    };
    const cfg = cloneModelConfig();
    cfg.levelA.market.parts.A6 = { dollarIndexChange30d: 50, us10yChange30d: 50 };
    near(scoreA6(inputs, cfg).subScore, 0);
    near(scoreA6(inputs).subScore, 10);
  });

  it('the A1 windows and the funding threshold are config values', () => {
    const cfg = cloneModelConfig();
    cfg.levelA.market.fundingInvertAbove = 0.05;
    near(scoreA3({ asOf: ASOF, fundingRate: meas(0.04, 0.01, 0.04) }, cfg).subScore, 75);
    cfg.levelA.market.trend.longMa = 100;
    const r = scoreA1({ asOf: ASOF, btcCloses: closesOf(260, (k) => 100 + k) }, cfg);
    near(
      r.raw.btcVs200dma ?? null,
      (359 / mean(closesOf(100, (k) => 100 + 160 + k)) - 1) * 100,
      10,
    );
    expect(r.measures[0]!.label).toBe('Bitcoin vs its 100-day average');
  });
});

describe('purity', () => {
  it('is deterministic, does not mutate its inputs and reads no clock or randomness', () => {
    const now = vi.spyOn(Date, 'now');
    const random = vi.spyOn(Math, 'random');
    const inputs = neutralInputs({
      btcCloses: Object.freeze(closesOf(300, (k) => 100 + k)) as number[],
      events: Object.freeze([
        { date: '2026-10-11', kind: 'CPI', title: 'Sample CPI' },
      ]) as CalendarEvent[],
    });
    const a = marketWeather(inputs);
    const b = marketWeather(inputs);
    expect(b).toEqual(a);
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    now.mockRestore();
    random.mockRestore();
  });
});

describe('golden: the Score Lab sample market outputs (SAMPLE_golden.v0.3.json)', () => {
  // The golden cannot be reached with the engine defaults: the Lab scales each input by a fixed
  // constant while the plan (and the default) scale against a 1-year history the golden does not
  // carry (DISCREPANCIES.md D-08). With labLevelACompatConfig() the engine reproduces the Lab to
  // floating-point noise, far inside the golden's own +-1 point / exact-label tolerance.
  const golden = loadGolden();
  const cfg = labLevelACompatConfig();
  const TOL = 1e-9;

  it('states the tolerance the golden asks for', () => {
    expect(golden.meta.tolerance).toEqual({ points: 1, labels: 'exact' });
  });

  it('today: score, label, every sub-score, every effective weight and the correlation factor', () => {
    const lab = golden.outputs.market.weather;
    const r = marketWeather(goldenMarketInputs(golden, 'now'), cfg);
    expect(r.label).toBe(lab.label);
    expect(Math.abs(r.score! - lab.score)).toBeLessThan(TOL);
    expect(r.macroScaling.factor).toBe(lab.k);
    for (const i of r.inputs) {
      expect(Math.abs(i.subScore! - lab.sub[i.id]!), `${i.id} sub-score`).toBeLessThan(TOL);
      expect(Math.abs(i.effectiveWeight - lab.eff[i.id]!), `${i.id} weight`).toBeLessThan(TOL);
    }
    // Raw readings of A1: the golden stores them as fractions, the engine as percent.
    const a1 = r.inputs[0]!.raw;
    expect(Math.abs(a1.btcVs200dma! / 100 - lab.raw.btcVs200!)).toBeLessThan(TOL);
    expect(Math.abs(a1.btcSlope50dma! / 100 - lab.raw.slope50!)).toBeLessThan(TOL);
    expect(r.missingInputs).toEqual([]);
    expect(Math.abs(r.weightSum - 100)).toBeLessThan(TOL);
  });

  it('a week earlier: score and label match the golden previous-week market', () => {
    const prev = golden.outputs.horizons.short.prev.market;
    const r = marketWeather(goldenMarketInputs(golden, 'prev'), cfg);
    expect(r.label).toBe(prev.label);
    expect(Math.abs(r.score! - prev.score)).toBeLessThan(TOL);
  });

  it('the default (master-plan) config is not the Lab config, and says so', () => {
    expect(marketWeather(goldenMarketInputs(golden, 'now')).subScoreMethod).toBe('zscore');
    expect(cfg.levelA.subScore.method).toBe('fixedScale');
    // Without history the default method cannot score the macro inputs of the golden.
    const dflt = marketWeather(goldenMarketInputs(golden, 'now'));
    expect(dflt.missingInputs).toContain('A2');
  });
});
