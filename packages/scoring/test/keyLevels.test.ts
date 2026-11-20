import { describe, expect, it } from 'vitest';
import { MODEL_CONFIG_V0_3 } from '../src/config/schema';
import type { Candle } from '../src/types';
import {
  NO_EARLIER_PRICE_ABOVE,
  computeKeyLevels,
  detectKeyLevelBreaksSG12,
  k1SwingPivots,
  k2VolumeNodes,
  k3MovingAverages,
  k4RoundNumbers,
  k4RoundStep,
  k5OptionsStrikes,
  k6LiquidationClusters,
  k7ShortTermHolderPrice,
  k8OrderBookWalls,
  type KeyLevelsInput,
} from '../src/index';
import {
  SAMPLE_flat,
  SAMPLE_hourlyProfile,
  SAMPLE_rising,
  SAMPLE_withCandle,
  sampleCandle,
  sampleDate,
} from './__fixtures__/SAMPLE_levels';

const cfg = MODEL_CONFIG_V0_3;
const BAN = /\b(buy|sell|hold|targets?|will reach)\b/i;

/** BTC flat at 100000 (+-500 daily range, so ATR 1000 and a merge gap of 500). */
const btcFlat = () => SAMPLE_flat(400, 100_000, 500);
const btc = (extra: Partial<KeyLevelsInput> = {}, s = btcFlat()): KeyLevelsInput => ({
  asset: 'BTC',
  ...s,
  price: 100_200,
  ...extra,
});
const zoneAt = (r: ReturnType<typeof computeKeyLevels>, price: number) =>
  r.zones.find((z) => z.low <= price && z.high >= price);
const strike = (s: number) => ({ strike: s, openInterest: 1 });

describe('K1 swing highs and lows (5-bar pivots)', () => {
  it('finds a daily swing high and low from a peak-and-trough series', () => {
    const closes = [10, 11, 12, 11, 10, 9, 8, 9, 10, 11, 12];
    const daily = closes.map((c) => sampleCandle(c, 0.5));
    const k1 = k1SwingPivots(daily, cfg);
    expect(k1.every((c) => c.method === 'K1')).toBe(true);
    expect(k1).toContainEqual({ method: 'K1', price: 12.5, note: 'Daily swing high' });
    expect(k1).toContainEqual({ method: 'K1', price: 7.5, note: 'Daily swing low' });
  });

  it('also scans weekly candles (config candles.weeklyBars)', () => {
    // 11 weeks: a weekly peak in week 6, flat elsewhere.
    const daily = Array.from({ length: 77 }, (_, i) =>
      sampleCandle(Math.floor(i / 7) === 5 ? 200 : 100, 1),
    );
    const weekly = k1SwingPivots(daily, cfg).filter((c) => c.note.startsWith('Weekly'));
    expect(weekly).toContainEqual({ method: 'K1', price: 201, note: 'Weekly swing high' });
  });
});

describe('K2 volume-profile nodes', () => {
  it('returns the heavy-volume bin as a node in both windows and skips a zero ATR', () => {
    const hourly = SAMPLE_hourlyProfile(99_000, 101_000, 100_000);
    const nodes = k2VolumeNodes(hourly, 1000, cfg);
    expect(nodes.every((n) => n.method === 'K2')).toBe(true);
    expect(nodes.some((n) => Math.abs(n.price - 100_000) <= 0.25 * 1000)).toBe(true);
    expect(nodes.map((n) => n.note)).toEqual(
      expect.arrayContaining(['High-volume node, 90D', 'High-volume node, 365D']),
    );
    expect(k2VolumeNodes(hourly, 0, cfg)).toEqual([]);
  });

  it('a window only reads the last days x 24 hourly bars', () => {
    const heavyOld = SAMPLE_hourlyProfile(99_000, 101_000, 100_000).reverse();
    // The heavy bars are now the oldest; 90D = 2160 bars covers all 1800, so shrink the window.
    const small = { ...cfg, levels: { ...cfg.levels, profileDays: [1] } };
    const nodes = k2VolumeNodes(heavyOld, 1000, small);
    expect(nodes.every((n) => n.note === 'High-volume node, 1D')).toBe(true);
    expect(nodes.some((n) => Math.abs(n.price - 100_000) <= 250)).toBe(false);
  });
});

describe('K3 moving averages', () => {
  it('gives the 50D and 200D averages, and the 200W only with 1400 days', () => {
    const short = k3MovingAverages(SAMPLE_flat(250, 100, 1).daily, cfg);
    expect(short.map((c) => c.note)).toEqual(['50-day average', '200-day average']);
    expect(short.every((c) => c.price === 100)).toBe(true);
    const long = k3MovingAverages(SAMPLE_flat(1400, 100, 1).daily, cfg);
    expect(long.map((c) => c.note)).toContain('200-week average');
  });
});

describe('K4 round numbers', () => {
  it('picks a step from 1, 2.5, 5 x 10^n giving about 10 steps within +-30%', () => {
    expect(k4RoundStep(100, cfg)).toBe(5);
    expect(k4RoundStep(0.5, cfg)).toBe(0.025);
    expect(k4RoundStep(3000, cfg)).toBe(250);
    expect(k4RoundStep(-1, cfg)).toBeNull();
  });

  it('Bitcoin: every 5K (so every 10K too) within the range', () => {
    const prices = k4RoundNumbers(100_000, true, cfg).map((c) => c.price);
    expect(prices[0]).toBe(70_000); // -30%, per roundBand
    expect(prices[prices.length - 1]).toBe(130_000); // +30%
    expect(prices).toContain(100_000);
    expect(prices).toContain(105_000);
    expect(prices.every((p) => p % 5000 === 0)).toBe(true);
    expect(new Set(prices).size).toBe(prices.length);
  });

  it('other coins: multiples of the chosen step within the range', () => {
    const prices = k4RoundNumbers(100, false, cfg).map((c) => c.price);
    expect(prices[0]).toBe(70);
    expect(prices[prices.length - 1]).toBe(130);
    expect(prices.every((p) => p % 5 === 0)).toBe(true);
    expect(k4RoundNumbers(0, false, cfg)).toEqual([]);
  });
});

describe('K5-K8 inputs', () => {
  it('K5 keeps the top 5 strikes by open interest', () => {
    const strikes = [1, 2, 3, 4, 5, 6, 7].map((k) => ({ strike: k * 1000, openInterest: k }));
    expect(k5OptionsStrikes(strikes, cfg).map((c) => c.price)).toEqual([
      7000, 6000, 5000, 4000, 3000,
    ]);
  });

  it('K6 and K7 skip invalid or absent input', () => {
    expect(k6LiquidationClusters([{ price: 5 }, { price: -1 }]).map((c) => c.price)).toEqual([5]);
    expect(k7ShortTermHolderPrice(null)).toEqual([]);
    expect(k7ShortTermHolderPrice(undefined)).toEqual([]);
    expect(k7ShortTermHolderPrice(90_000)).toHaveLength(1);
  });

  it('K8 walls are sorted by distance and tagged above or below', () => {
    const w = k8OrderBookWalls(
      [
        { price: 110, size: 5 },
        { price: 99, size: 7 },
      ],
      100,
    );
    expect(w).toEqual([
      { price: 99, size: 7, side: 'below' },
      { price: 110, size: 5, side: 'above' },
    ]);
  });
});

describe('zone merging', () => {
  it('merges candidates within 0.5 x ATR into one zone and keeps others apart', () => {
    const r = computeKeyLevels(
      btc({
        optionsStrikes: [
          { strike: 90_000, openInterest: 9 },
          { strike: 90_400, openInterest: 8 },
          { strike: 81_000, openInterest: 7 },
        ],
      }),
      cfg,
    );
    expect(r.atr).toBeCloseTo(1000, 0);
    const merged = zoneAt(r, 90_000)!;
    expect([merged.low, merged.high]).toEqual([90_000, 90_400]);
    expect(merged.methods).toEqual(['K4', 'K5']);
    // 81000 is 1000 from the 80000 round number: more than 0.5 x ATR, so separate zones.
    expect(zoneAt(r, 81_000)!.methods).toEqual(['K5']);
    expect(zoneAt(r, 80_000)!.methods).toEqual(['K4']);
  });
});

describe('strength points', () => {
  it('2 per distinct method, +1 when touched in the last 90 days, label by thresholds', () => {
    const r = computeKeyLevels(btc(), cfg);
    const z = zoneAt(r, 100_000)!; // K3 (50D and 200D count as one method) + K4
    expect(z.methods).toEqual(['K3', 'K4']);
    expect(z.points).toBe(5);
    expect(z.strength).toBe('Medium');
    expect(z.label).toBe('Medium support zone');
    expect(z.touchedRecently).toBe(true);
    expect(z.lastTouch).toBe(sampleDate(399));
    const far = zoneAt(r, 105_000)!;
    expect(far.points).toBe(2);
    expect(far.strength).toBe('Weak');
    expect(far.lastTouch).toBeNull();
  });

  it('4 distinct methods + a recent touch is Strong', () => {
    const r = computeKeyLevels(
      btc({ optionsStrikes: [strike(100_000)], liquidationClusters: [{ price: 100_000 }] }),
      cfg,
    );
    const z = zoneAt(r, 100_000)!;
    expect(z.methods).toEqual(['K3', 'K4', 'K5', 'K6']);
    expect(z.points).toBe(9);
    expect(z.strength).toBe('Strong');
  });

  it('counts reactions (enter the zone, close back out on the same side), max 4', () => {
    const make = (days: number[]) => {
      let s = btcFlat();
      for (const d of days) s = SAMPLE_withCandle(s, d, { high: 103_100, close: 100_000 });
      return computeKeyLevels(btc({ optionsStrikes: [strike(103_000)] }, s), cfg);
    };
    // The probe highs also form a weekly swing high (K1), so the zone has K1 and K5.
    const three = zoneAt(make([320, 321, 322]), 103_000)!;
    expect(three.methods).toEqual(['K1', 'K5']);
    expect(three.reactions).toBe(3);
    expect(three.points).toBe(2 * 2 + 3 + 1);
    expect(three.strength).toBe('Strong');
    expect(three.lastTouch).toBe(sampleDate(322));
    const six = zoneAt(make([320, 321, 322, 323, 324, 325]), 103_000)!;
    expect(six.reactions).toBe(4);
    expect(six.points).toBe(2 * six.methods.length + 4 + 1);
  });

  it('a candle opening inside the zone and closing through it is not a reaction', () => {
    const zoneOf = (candle: Partial<Candle>, strikePx: number) =>
      zoneAt(
        computeKeyLevels(
          btc({ optionsStrikes: [strike(strikePx)] }, SAMPLE_withCandle(btcFlat(), 320, candle)),
          cfg,
        ),
        strikePx,
      )!;
    // Breakdown through a support zone at 95000: opens inside it (zone 95000 to 95000), closes below.
    expect(
      zoneOf({ open: 95_000, high: 95_500, low: 94_000, close: 94_200 }, 95_000).reactions,
    ).toBe(0);
    // Breakout through a resistance zone at 103000: opens at it, closes above.
    expect(
      zoneOf({ open: 103_000, high: 103_600, low: 102_900, close: 103_500 }, 103_000).reactions,
    ).toBe(0);
    // Control: opens below, wicks in, closes below on the same side: counts.
    expect(
      zoneOf({ open: 102_000, high: 103_100, low: 101_900, close: 102_200 }, 103_000).reactions,
    ).toBe(1);
    // Control: opens above a support zone, wicks in, closes above: counts.
    expect(
      zoneOf({ open: 96_000, high: 96_200, low: 94_900, close: 95_800 }, 95_000).reactions,
    ).toBe(1);
  });

  it('a close beyond the zone is not a reaction', () => {
    const s = SAMPLE_withCandle(btcFlat(), 320, { high: 103_600, close: 103_500 });
    const z = zoneAt(
      computeKeyLevels(btc({ optionsStrikes: [strike(103_000)] }, s), cfg),
      103_000,
    )!;
    expect(z.reactions).toBe(0);
  });

  it('reactions older than 365 days and touches older than 90 days do not count', () => {
    let s = SAMPLE_flat(500, 100_000, 500);
    for (const d of [10, 11]) s = SAMPLE_withCandle(s, d, { high: 103_100, close: 100_000 });
    const z = zoneAt(
      computeKeyLevels(btc({ optionsStrikes: [strike(103_000)] }, s), cfg),
      103_000,
    )!;
    expect(z.reactions).toBe(0);
    expect(z.touchedRecently).toBe(false);
    expect(z.points).toBe(2);
    expect(z.lastTouch).toBe(sampleDate(11));
  });
});

describe('K8 exclusion', () => {
  it('walls are reported apart and never change zone strength', () => {
    const base = computeKeyLevels(btc(), cfg);
    const withWalls = computeKeyLevels(
      btc({
        orderBookWalls: [
          { price: 100_000, size: 500 },
          { price: 105_000, size: 300 },
        ],
      }),
      cfg,
    );
    expect(withWalls.walls.map((w) => w.price)).toEqual([100_000, 105_000]);
    expect(base.walls).toEqual([]);
    expect(withWalls.zones).toEqual(base.zones);
    for (const z of withWalls.zones) expect(z.methods as readonly string[]).not.toContain('K8');
  });

  it('K5, K6, K7 and K8 inputs are ignored for coins they do not apply to', () => {
    const s = SAMPLE_flat(400, 100, 1);
    const r = computeKeyLevels(
      {
        asset: 'SOL',
        ...s,
        optionsStrikes: [strike(100)],
        liquidationClusters: [{ price: 100 }],
        sthRealisedPrice: 100,
        orderBookWalls: [{ price: 100, size: 1 }],
      },
      cfg,
    );
    expect(r.walls).toEqual([]);
    for (const z of r.zones)
      for (const m of ['K5', 'K6', 'K7'] as const) expect(z.methods).not.toContain(m);
    const eth = computeKeyLevels({ asset: 'ETH', ...s, sthRealisedPrice: 100 }, cfg);
    for (const z of eth.zones) expect(z.methods).not.toContain('K7');
    const b = computeKeyLevels(btc({ sthRealisedPrice: 99_900 }), cfg);
    expect(zoneAt(b, 99_900)!.methods).toContain('K7');
  });
});

describe('K4 span in zones', () => {
  it('round numbers reach -30% and +30% even though other candidates stop at +-25%', () => {
    const r = computeKeyLevels(btc({ price: 100_000 }), cfg);
    expect(zoneAt(r, 70_000)!.methods).toEqual(['K4']);
    expect(zoneAt(r, 130_000)!.methods).toEqual(['K4']);
  });
});

describe('nearest supports and resistances', () => {
  it('returns two of each, nearest first', () => {
    const r = computeKeyLevels(btc(), cfg);
    expect(r.supports.map((z) => z.high)).toEqual([100_000, 95_000]);
    expect(r.resistances.map((z) => z.low)).toEqual([105_000, 110_000]);
    expect(r.resistanceNote).toBeNull();
  });
});

describe('all-time-high case', () => {
  it("returns 'No earlier price above this' and K4-only levels above", () => {
    const r = computeKeyLevels({ asset: 'ABC', ...SAMPLE_rising(400, 100) }, cfg);
    expect(r.price).toBe(499);
    expect(r.resistanceNote).toBe(NO_EARLIER_PRICE_ABOVE);
    expect(r.resistanceNote).toBe('No earlier price above this');
    expect(r.resistances).toHaveLength(2);
    for (const z of r.resistances) {
      expect(z.methods).toEqual(['K4']);
      expect(z.low).toBeGreaterThan(499);
    }
    expect(r.resistances.map((z) => z.low)).toEqual([500, 525]);
    expect(r.supports.length).toBeGreaterThan(0);
  });

  it('is not triggered when an earlier high sits above the price', () => {
    const s = SAMPLE_withCandle(SAMPLE_rising(400, 100), 300, { high: 900, close: 400 });
    const r = computeKeyLevels({ asset: 'ABC', ...s }, cfg);
    expect(r.resistanceNote).toBeNull();
  });
});

describe('SG12 break detection', () => {
  const strikes = [strike(105_000), strike(95_000)];
  // Flat at 100200 so the 100000 zone sits below the prior close (a support zone).
  const withLast = (close: number) =>
    SAMPLE_withCandle(SAMPLE_flat(400, 100_200, 500), 399, {
      close,
      high: close + 500,
      low: close - 500,
    });
  const run = (close: number, asset = 'BTC') =>
    detectKeyLevelBreaksSG12({ asset, ...withLast(close), optionsStrikes: strikes }, cfg);

  it('flags a close above a Medium resistance zone, market-wide for BTC', () => {
    const b = run(105_600);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({
      direction: 'close-above-resistance',
      marketWide: true,
      close: 105_600,
      date: sampleDate(399),
    });
    expect(b[0]!.zone.strength).toBe('Medium');
    expect(b[0]!.zone.methods).toEqual(['K4', 'K5']);
    expect(b[0]!.description).toContain('market-wide');
  });

  it('flags a close below a support zone', () => {
    const b = run(94_400);
    expect(b.every((x) => x.direction === 'close-below-support' && x.marketWide)).toBe(true);
    expect(b.map((x) => x.zone.low)).toEqual(expect.arrayContaining([95_000, 100_000]));
  });

  it('no break while the close stays inside or short of the zone', () => {
    expect(run(100_200)).toEqual([]);
    expect(run(105_000)).toEqual([]); // equal to the zone high is not beyond it
  });

  it('ignores Weak zones', () => {
    // 110000 is a K4-only (Weak) zone: closing above it is not a break.
    const b = detectKeyLevelBreaksSG12({ asset: 'BTC', ...withLast(110_600) }, cfg);
    expect(b.every((x) => x.zone.strength !== 'Weak')).toBe(true);
    expect(b.some((x) => x.zone.high === 110_000)).toBe(false);
  });

  it('is not market-wide for other coins', () => {
    const last = SAMPLE_withCandle(SAMPLE_flat(400, 3010, 15), 399, {
      close: 3300,
      high: 3315,
      low: 3285,
    });
    const b = detectKeyLevelBreaksSG12(
      { asset: 'ETH', ...last, optionsStrikes: [strike(3250)] },
      cfg,
    );
    expect(b).toHaveLength(1);
    expect(b[0]!.marketWide).toBe(false);
    expect(b[0]!.description).not.toContain('market-wide');
  });
});

describe('input validation and wording', () => {
  it('rejects missing history, mismatched dates and too-short ATR history', () => {
    expect(() => computeKeyLevels({ asset: 'BTC', daily: [], dates: [] }, cfg)).toThrow(RangeError);
    const s = SAMPLE_flat(50, 100, 1);
    expect(() => computeKeyLevels({ asset: 'BTC', daily: s.daily, dates: [] }, cfg)).toThrow(
      /parallel/,
    );
    expect(() => computeKeyLevels({ asset: 'BTC', ...SAMPLE_flat(5, 100, 1) }, cfg)).toThrow(/ATR/);
    expect(() =>
      detectKeyLevelBreaksSG12({ asset: 'BTC', ...SAMPLE_flat(1, 100, 1) }, cfg),
    ).toThrow(RangeError);
  });

  it('is educational: no advisory wording in any label or text', () => {
    const r = computeKeyLevels(btc(), cfg);
    const ath = computeKeyLevels({ asset: 'ABC', ...SAMPLE_rising(400, 100) }, cfg);
    const breaks = detectKeyLevelBreaksSG12(
      {
        asset: 'BTC',
        ...SAMPLE_withCandle(btcFlat(), 399, { close: 105_600, high: 106_100 }),
        optionsStrikes: [strike(105_000)],
      },
      cfg,
    );
    const texts = [
      ...r.zones.map((z) => z.label),
      ...ath.zones.map((z) => z.label),
      ath.resistanceNote ?? '',
      ...breaks.map((b) => b.description),
    ];
    expect(texts.length).toBeGreaterThan(5);
    expect(breaks.length).toBeGreaterThan(0);
    for (const t of texts) expect(t).not.toMatch(BAN);
  });
});
