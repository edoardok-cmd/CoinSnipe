import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  collectFiles,
  lintSource,
  type Allowlist,
  type Rule,
} from '../../../tools/copy-lint/index.ts';
import { cloneModelConfig, MODEL_CONFIG_V0_3, type ModelConfig } from '../src/config/schema';
import {
  FRAGILITIES,
  FUELS,
  OUTLOOK_FIELD_TIERS,
  OUTLOOK_TEMPLATES,
  REGIMES,
  buildScenarios,
  computeBitcoinOutlook,
  computeKeyLevels,
  fillTemplate,
  formatZone,
  fragilityReading,
  fuelReading,
  halvingMonthsSince,
  historyLine,
  levelsClause,
  marketWeather,
  outlookSentence,
  regimeReading,
  type BitcoinOutlookInput,
  type Fragility,
  type Fuel,
  type KeyZone,
  type LevelsView,
  type Regime,
} from '../src/index';
import { SAMPLE_flat, SAMPLE_rising } from './__fixtures__/SAMPLE_levels';
import { coinSeries, loadGolden } from './oracle/golden';
import { goldenMarketInputs, labLevelACompatConfig } from './oracle/labLevelACompat';

const CFG = MODEL_CONFIG_V0_3;

/* ----------------------------------------------------------------------------- helpers */

type Market = NonNullable<BitcoinOutlookInput['market']>;

/**
 * A market-weather stand-in: only the fields the outlook reads (id, subScore, raw). Test code,
 * so the cast to the full result type stays here.
 */
function mkt(
  sub: Partial<Record<'A2' | 'A6' | 'A8', number | null>>,
  a3: { funding?: number | null; oi30?: number | null; fng?: number | null } | null = null,
): Market {
  const inputs = [
    ...(['A2', 'A6', 'A8'] as const).map((id) => ({
      id,
      subScore: sub[id] ?? null,
      raw: {},
    })),
    {
      id: 'A3',
      subScore: null,
      raw: {
        fundingRate: a3?.funding ?? null,
        openInterestChange30d: a3?.oi30 ?? null,
        fearGreed: a3?.fng ?? null,
      },
    },
  ];
  return { inputs } as unknown as Market;
}

const zone = (
  side: 'support' | 'resistance',
  low: number,
  high: number,
  strength: KeyZone['strength'] = 'Strong',
): KeyZone => ({
  low,
  high,
  side,
  points: 5,
  strength,
  label: `${strength} ${side} zone`,
  methods: ['K1'],
  reactions: 1,
  touchedRecently: false,
  lastTouch: null,
});

const levels = (
  supports: KeyZone[],
  resistances: KeyZone[],
  resistanceNote: LevelsView['resistanceNote'] = null,
): LevelsView => ({ supports, resistances, resistanceNote });

const SAMPLE_LEVELS = levels(
  [zone('support', 82_000, 84_000, 'Strong'), zone('support', 76_000, 77_000, 'Medium')],
  [zone('resistance', 92_000, 92_000, 'Medium'), zone('resistance', 100_000, 100_000, 'Weak')],
);

/** `n` closes: `early` for the first n - tail, `tail` for the last `tail` bars. */
const stepSeries = (n: number, tail: number, early: number, late: number): number[] =>
  Array.from({ length: n }, (_, k) => (k < n - tail ? early : late));

const rules: Rule[] = JSON.parse(
  readFileSync(new URL('../../../tools/copy-lint/rules.json', import.meta.url), 'utf8'),
);
const allow: Allowlist = JSON.parse(
  readFileSync(new URL('../../../tools/copy-lint/allowlist.json', import.meta.url), 'utf8'),
);
const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const TEMPLATE_FILE = 'packages/scoring/src/levelA/templates/outlook.templates.json';
const lintErrors = (text: string, file = 'apps/web/content/outlook.md') =>
  lintSource(file, text, rules, allow).filter((f) => f.severity === 'error');
/** Words the copy rules and the task forbid in any outlook text. */
const FORBIDDEN = /\b(will|targets?|buy|buying|sell|selling|hold|recommend\w*|guaranteed)\b/i;

const withOutlook = (patch: Partial<ModelConfig['outlook']>): ModelConfig => {
  const c = cloneModelConfig();
  Object.assign(c.outlook, patch);
  return c;
};

/* ----------------------------------------------------------------------------- regime */

describe('regime (Lab regimeAt: 200-day average and the 50-day slope)', () => {
  it('Uptrend above the 200-day average with a rising 50-day average', () => {
    const r = regimeReading(stepSeries(300, 1, 100, 101));
    expect(r.label).toBe('Uptrend');
    expect(r.slope50!).toBeGreaterThan(0);
  });

  it('Downtrend below the 200-day average with a falling 50-day average', () => {
    expect(regimeReading(stepSeries(300, 1, 100, 99)).label).toBe('Downtrend');
  });

  it('price exactly on the 200-day average is Range (strict comparisons)', () => {
    const r = regimeReading(stepSeries(300, 0, 100, 100));
    expect(r.price).toBe(r.ma200);
    expect(r.label).toBe('Range');
  });

  it('a flat 50-day average (slope exactly 0) is Range on either side of the 200-day average', () => {
    // The last 64 bars are all 100, so the 50-day average is 100 now and 14 bars ago.
    const above = regimeReading(stepSeries(300, 64, 50, 100));
    expect(above.price!).toBeGreaterThan(above.ma200!);
    expect(above.slope50).toBe(0);
    expect(above.label).toBe('Range');
    const below = regimeReading(stepSeries(300, 64, 150, 100));
    expect(below.price!).toBeLessThan(below.ma200!);
    expect(below.slope50).toBe(0);
    expect(below.label).toBe('Range');
  });

  it('price above the 200-day average but a falling 50-day average is Range, and the mirror', () => {
    // Rally then pullback: still above the 200-day average, 50-day average now falling.
    const up = [...stepSeries(200, 0, 50, 50), ...Array.from({ length: 100 }, (_, k) => 300 - k)];
    const r = regimeReading(up);
    expect(r.price!).toBeGreaterThan(r.ma200!);
    expect(r.slope50!).toBeLessThan(0);
    expect(r.label).toBe('Range');
    const down = [
      ...stepSeries(200, 0, 400, 400),
      ...Array.from({ length: 100 }, (_, k) => 100 + k),
    ];
    const d = regimeReading(down);
    expect(d.price!).toBeLessThan(d.ma200!);
    expect(d.slope50!).toBeGreaterThan(0);
    expect(d.label).toBe('Range');
  });

  it('has no label with too little history or no closes, rather than guessing Range', () => {
    expect(regimeReading(stepSeries(150, 1, 100, 101)).label).toBeNull();
    expect(regimeReading([]).label).toBeNull();
    expect(regimeReading(null).label).toBeNull();
    // One bar fewer than the 200-day window has no average at all; 200 bars is enough.
    expect(regimeReading(stepSeries(199, 1, 100, 101)).label).toBeNull();
    expect(regimeReading(stepSeries(200, 1, 100, 101)).label).toBe('Uptrend');
  });

  it('reads the windows from config (market.trend), not from constants', () => {
    const c = cloneModelConfig();
    c.levelA.market.trend = { shortMa: 5, midMa: 10, longMa: 20, slopeDays: 3 };
    expect(regimeReading(stepSeries(30, 1, 100, 101), c).label).toBe('Uptrend');
  });

  it('reports the price vs the 200-week (1400-day) average without letting it move the label', () => {
    expect(regimeReading(stepSeries(300, 1, 100, 101)).vs200w).toBeNull();
    const long = [...stepSeries(1400, 0, 1000, 1000)];
    long[1399] = 1100;
    const r = regimeReading(long);
    expect(r.vs200w!).toBeCloseTo(1100 / ((1000 * 1399 + 1100) / 1400) - 1, 12);
    // Price far below the 200-week average, still Uptrend by the Lab rule.
    const below = [
      ...Array.from({ length: 1100 }, () => 10_000),
      ...Array.from({ length: 300 }, (_, k) => 100 + k * 0.01),
    ];
    const b = regimeReading(below);
    expect(b.vs200w!).toBeLessThan(-0.5);
    expect(b.label).toBe('Uptrend');
  });
});

/* ----------------------------------------------------------------------------- fuel */

describe('fuel (mean of A2, A8, D1 and A6 sub-scores)', () => {
  it('thresholds are the Lab values, in config', () => {
    expect(CFG.outlook.fuelUp).toBe(20);
    expect(CFG.outlook.fuelDown).toBe(-20);
  });

  it.each([
    [19.999, 'Flat'],
    [20, 'Flat'],
    [20.001, 'Rising'],
    [-19.999, 'Flat'],
    [-20, 'Flat'],
    [-20.001, 'Falling'],
    [0, 'Flat'],
    [100, 'Rising'],
    [-100, 'Falling'],
  ] as const)(
    'a mean of %s is %s (Rising only above +20, Falling only below -20)',
    (score, label) => {
      const f = fuelReading(mkt({ A2: score }), null);
      expect(f.score).toBe(score);
      expect(f.label).toBe(label);
    },
  );

  it('boundary holds at whatever value the config sets (strict > and <)', () => {
    const f = fuelReading(mkt({ A2: 37.5 }), null);
    expect(fuelReading(mkt({ A2: 37.5 }), null, withOutlook({ fuelUp: 37.5 })).label).toBe('Flat');
    expect(fuelReading(mkt({ A2: 37.5 }), null, withOutlook({ fuelUp: 37.4999 })).label).toBe(
      'Rising',
    );
    expect(f.label).toBe('Rising');
    expect(fuelReading(mkt({ A2: -37.5 }), null, withOutlook({ fuelDown: -37.5 })).label).toBe(
      'Flat',
    );
    expect(fuelReading(mkt({ A2: -37.5 }), null, withOutlook({ fuelDown: -37.4999 })).label).toBe(
      'Falling',
    );
  });

  it('averages the four parts; D1 is the ETF flow scaled so 3 bn = 100', () => {
    const f = fuelReading(mkt({ A2: 60, A8: 40, A6: -20 }), 1.5);
    expect(f.parts.map((p) => [p.id, p.score])).toEqual([
      ['A2', 60],
      ['A8', 40],
      ['D1', 50],
      ['A6', -20],
    ]);
    expect(f.score).toBe(32.5);
    expect(f.label).toBe('Rising');
    expect(f.missing).toEqual([]);
  });

  it('clamps D1 to +-100', () => {
    expect(fuelReading(mkt({}), 30).parts.find((p) => p.id === 'D1')!.score).toBe(100);
    expect(fuelReading(mkt({}), -30).parts.find((p) => p.id === 'D1')!.score).toBe(-100);
  });

  it('D1 absent: dropped and the mean is over the rest', () => {
    const without = fuelReading(mkt({ A2: 60, A8: 30, A6: 0 }), null);
    expect(without.score).toBe(30);
    expect(without.missing).toEqual(['D1']);
    // Same inputs with D1 = 0 would dilute to 22.5: dropping is not the same as scoring 0.
    expect(fuelReading(mkt({ A2: 60, A8: 30, A6: 0 }), 0).score).toBe(22.5);
    expect(without.label).toBe('Rising');
  });

  it('missing A-inputs are dropped too, and NaN or undefined flow counts as absent', () => {
    expect(fuelReading(mkt({ A2: 10 }), undefined).score).toBe(10);
    expect(fuelReading(mkt({ A2: 10 }), Number.NaN).missing).toEqual(['A8', 'D1', 'A6']);
  });

  it('no part at all gives no label and no score', () => {
    const f = fuelReading(null, null);
    expect(f.label).toBeNull();
    expect(f.score).toBeNull();
    expect(f.missing).toEqual(['A2', 'A8', 'D1', 'A6']);
  });

  it('the D1 full-scale flow is config', () => {
    const c = cloneModelConfig();
    c.levelA.outlook.etfFullFlowBn = 6;
    expect(fuelReading(mkt({}), 3, c).parts.find((p) => p.id === 'D1')!.score).toBe(50);
  });
});

/* ----------------------------------------------------------------------------- fragility */

describe('fragility (funding, open interest, D4 clusters, D3 sentiment; weights .4/.3/.15/.15)', () => {
  const PRICE = 100_000;
  const full = { funding: 0.05, oi30: 30, fng: 100 };

  it('thresholds are the Lab values, in config', () => {
    expect(CFG.outlook.fragHigh).toBe(66);
    expect(CFG.outlook.fragElev).toBe(33);
    expect(CFG.levelA.outlook.fragWeights).toEqual({
      funding: 0.4,
      openInterest: 0.3,
      liquidation: 0.15,
      sentiment: 0.15,
    });
  });

  it('every part at its maximum scores 100, none scores 0', () => {
    const hi = fragilityReading(mkt({}, full), PRICE, [{ price: PRICE }]);
    expect(hi.score).toBeCloseTo(100, 9);
    expect(hi.label).toBe('High');
    const lo = fragilityReading(mkt({}, { funding: 0, oi30: 0, fng: 50 }), PRICE, []);
    expect(lo.score).toBe(0);
    expect(lo.label).toBe('Low');
  });

  it('negative funding and shrinking open interest score 0, not negative', () => {
    const r = fragilityReading(mkt({}, { funding: -0.2, oi30: -40, fng: 50 }), PRICE, []);
    expect(r.parts.map((p) => p.value)).toEqual([0, 0, 0, 0]);
  });

  it('scales funding, open interest and sentiment as the Lab does', () => {
    const r = fragilityReading(mkt({}, { funding: 0.0125, oi30: 15, fng: 75 }), PRICE, [
      { price: PRICE * 1.04 },
    ]);
    const v = Object.fromEntries(r.parts.map((p) => [p.id, p.value]));
    expect(v['funding']).toBeCloseTo(25, 9);
    expect(v['openInterest']).toBeCloseTo(50, 9);
    expect(v['liquidation']).toBeCloseTo(50, 9); // 4% away of an 8% band
    expect(v['sentiment']).toBeCloseTo(50, 9);
    expect(r.nearestClusterPct!).toBeCloseTo(4, 9);
    expect(r.score!).toBeCloseTo(25 * 0.4 + 50 * 0.3 + 50 * 0.15 + 50 * 0.15, 9);
  });

  it('a cluster beyond the 8% band scores 0 and the nearest of several is used, above or below', () => {
    const far = fragilityReading(mkt({}, { funding: 0, oi30: 0, fng: 50 }), PRICE, [
      { price: PRICE * 1.2 },
    ]);
    expect(far.parts.find((p) => p.id === 'liquidation')!.value).toBe(0);
    const many = fragilityReading(mkt({}, { funding: 0, oi30: 0, fng: 50 }), PRICE, [
      { price: PRICE * 1.07 },
      { price: PRICE * 0.98 },
      { price: PRICE * 1.5 },
    ]);
    expect(many.nearestClusterPct!).toBeCloseTo(2, 9);
    expect(many.parts.find((p) => p.id === 'liquidation')!.value!).toBeCloseTo(75, 9);
  });

  it.each([
    [82.99, 'Elevated'],
    [83, 'High'],
    [83.01, 'High'],
    [66.4, 'Low'],
    [66.5, 'Elevated'],
  ] as const)('sentiment-only score: Fear & Greed %s reads %s', (fng, label) => {
    // With only D3 present the score is |fng - 50| / 50 x 100: 83 -> 66 (High from 66), 66.5 -> 33 (Elevated from 33).
    const r = fragilityReading(mkt({}, { fng }), null, null);
    expect(r.label).toBe(label);
  });

  it('High from exactly 66 and Elevated from exactly 33, at the score the engine computes', () => {
    const r = fragilityReading(mkt({}, { funding: 0.033, oi30: null, fng: null }), null, null);
    const score = r.score!;
    const at = (patch: Partial<ModelConfig['outlook']>) =>
      fragilityReading(
        mkt({}, { funding: 0.033, oi30: null, fng: null }),
        null,
        null,
        withOutlook(patch),
      ).label;
    expect(at({ fragHigh: score, fragElev: score / 2 })).toBe('High');
    expect(at({ fragHigh: score + 1e-9, fragElev: score })).toBe('Elevated');
    expect(at({ fragHigh: score + 1e-9, fragElev: score + 1e-9 / 2 })).toBe('Low');
  });

  it('D4 absent: dropped and the other parts reweighted (not scored 0)', () => {
    const m = mkt({}, { funding: 0.05, oi30: 0, fng: 50 });
    const without = fragilityReading(m, PRICE, null);
    expect(without.missing).toEqual(['liquidation']);
    expect(without.score!).toBeCloseTo((100 * 0.4) / 0.85, 9);
    expect(without.parts.map((p) => p.effectiveWeight).reduce((a, b) => a + b, 0)).toBeCloseTo(
      1,
      12,
    );
    const withEmpty = fragilityReading(m, PRICE, []);
    expect(withEmpty.missing).toEqual([]);
    expect(withEmpty.score!).toBeCloseTo(40, 9);
  });

  it('D3 absent and A3 absent: dropped; nothing present gives no label', () => {
    const noFng = fragilityReading(mkt({}, { funding: 0.05, oi30: 30, fng: null }), PRICE, []);
    expect(noFng.missing).toEqual(['sentiment']);
    expect(noFng.score!).toBeCloseTo((100 * 0.4 + 100 * 0.3) / 0.85, 9);
    const none = fragilityReading(null, null, null);
    expect(none.label).toBeNull();
    expect(none.score).toBeNull();
    expect(none.missing).toEqual(['funding', 'openInterest', 'liquidation', 'sentiment']);
  });

  it('clusters without a usable price count as no data', () => {
    expect(fragilityReading(mkt({}, full), null, [{ price: 1 }]).missing).toEqual(['liquidation']);
  });

  it('weights and scales are config', () => {
    const c = cloneModelConfig();
    c.levelA.outlook.fragWeights = { funding: 1, openInterest: 0, liquidation: 0, sentiment: 0 };
    c.levelA.outlook.fundingFull = 0.1;
    expect(
      fragilityReading(mkt({}, { funding: 0.05, oi30: 30, fng: 100 }), PRICE, [], c).score,
    ).toBe(50);
  });
});

/* ----------------------------------------------------------------------------- halving, D2 */

describe('D2 halving-cycle position', () => {
  it('months since 2024-04-20 at 30.44 days a month', () => {
    expect(halvingMonthsSince('2024-04-20')).toBe(0);
    expect(halvingMonthsSince('2026-10-10')!).toBeCloseTo(29.66491458607096, 12);
    expect(halvingMonthsSince('not a date')).toBeNull();
  });

  const state = (asOf: string) =>
    computeBitcoinOutlook({ asOf }).drivers.find((d) => d.id === 'D2')!.state;

  it('12 and 18 month edges: early before 12, in the window from 12 to 18, late after', () => {
    expect(state('2025-04-20')).toBe('early'); // 365 days = 11.99 months
    expect(state('2025-04-21')).toBe('inWindow'); // 366 days = 12.02
    expect(state('2025-10-19')).toBe('inWindow'); // 547 days = 17.97
    expect(state('2025-10-20')).toBe('late'); // 548 days = 18.003
  });

  it('an invalid asOf makes D2 unavailable instead of throwing', () => {
    const d2 = computeBitcoinOutlook({ asOf: 'x' }).drivers.find((d) => d.id === 'D2')!;
    expect(d2.available).toBe(false);
    expect(d2.value).toBeNull();
  });
});

/* ----------------------------------------------------------------------------- drivers */

describe('drivers D1-D5', () => {
  const full = (extra: Partial<BitcoinOutlookInput> = {}): BitcoinOutlookInput => ({
    asOf: '2026-10-10',
    btcCloses: stepSeries(300, 1, 100, 101),
    market: mkt({ A2: 10, A8: 10, A6: 10 }, { funding: 0.02, oi30: 10, fng: 61 }),
    etfFlow20dBn: 2.4,
    liquidationClusters: [{ price: 104 }],
    ...extra,
  });

  it('lists D1-D4 with value, plain meaning, source, leads-price text and status; D5 is skipped by default', () => {
    const o = computeBitcoinOutlook(full());
    expect(o.drivers.map((d) => d.id)).toEqual(['D1', 'D2', 'D3', 'D4']);
    for (const d of o.drivers) {
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.meaning.length).toBeGreaterThan(0);
      expect(d.source.length).toBeGreaterThan(0);
      expect(d.leads.length).toBeGreaterThan(0);
      expect(d.available).toBe(true);
      expect(d.status).toBe('proposed');
      expect(d.tier).toBe('free');
    }
    const by = Object.fromEntries(o.drivers.map((d) => [d.id, d]));
    expect(by['D1']).toMatchObject({
      value: 2.4,
      state: 'inflow',
      leads: 'Same time, with momentum',
    });
    expect(by['D2']!.leads).toBe('Slow background');
    expect(by['D3']).toMatchObject({ value: 61, state: 'neutral', leads: 'Contrarian' });
    expect(by['D4']).toMatchObject({ state: 'near', leads: 'Warns before sharp moves' });
    expect(by['D4']!.value!).toBeCloseTo(3.0, 0);
    expect(by['D2']!.meaning).toContain('18');
  });

  it('D1 absent: listed as unavailable, with a plain note, and Fuel is read without it', () => {
    const o = computeBitcoinOutlook(full({ etfFlow20dBn: null }));
    const d1 = o.drivers.find((d) => d.id === 'D1')!;
    expect(d1).toMatchObject({ available: false, value: null, state: 'unavailable' });
    expect(d1.meaning).toMatch(/not connected/i);
    expect(o.fuel.missing).toEqual(['D1']);
    expect(o.fuel.label).not.toBeNull();
  });

  it('D1 states by the sign of the 20-day flow', () => {
    const st = (x: number) =>
      computeBitcoinOutlook(full({ etfFlow20dBn: x })).drivers.find((d) => d.id === 'D1')!.state;
    expect([st(0.01), st(-0.01), st(0)]).toEqual(['inflow', 'outflow', 'flat']);
  });

  it('D3 extremes are Fear & Greed above 80 or below 20 (80 and 20 are not extremes)', () => {
    const st = (fng: number) =>
      computeBitcoinOutlook(full({ market: mkt({}, { fng }) })).drivers.find((d) => d.id === 'D3')!
        .state;
    expect([st(80), st(81), st(20), st(19)]).toEqual([
      'neutral',
      'extremeGreed',
      'neutral',
      'extremeFear',
    ]);
    const missing = computeBitcoinOutlook(full({ market: mkt({}) })).drivers.find(
      (d) => d.id === 'D3',
    )!;
    expect(missing).toMatchObject({ available: false, state: 'unavailable', value: null });
  });

  it('D4 absent: unavailable and dropped from Fragility; present but far from the price: far', () => {
    const none = computeBitcoinOutlook(full({ liquidationClusters: null }));
    const d4 = none.drivers.find((d) => d.id === 'D4')!;
    expect(d4).toMatchObject({ available: false, state: 'unavailable', value: null });
    expect(none.fragility.missing).toEqual(['liquidation']);
    const far = computeBitcoinOutlook(full({ liquidationClusters: [{ price: 150 }] }));
    expect(far.drivers.find((d) => d.id === 'D4')!.state).toBe('far');
    const empty = computeBitcoinOutlook(full({ liquidationClusters: [] }));
    expect(empty.drivers.find((d) => d.id === 'D4')).toMatchObject({
      state: 'far',
      available: true,
      value: null,
    });
  });

  it('D5 is skipped unless supplied, then listed with status open', () => {
    expect(computeBitcoinOutlook(full()).drivers.some((d) => d.id === 'D5')).toBe(false);
    const o = computeBitcoinOutlook(
      full({ longTermHolder: { state: 'accumulating', value: 0.4 } }),
    );
    const d5 = o.drivers.find((d) => d.id === 'D5')!;
    expect(d5).toMatchObject({
      state: 'accumulating',
      value: 0.4,
      status: 'open',
      available: true,
    });
    expect(o.drivers.map((d) => d.id)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5']);
    // D5 does not feed Fuel or Fragility.
    expect(o.fuel).toEqual(computeBitcoinOutlook(full()).fuel);
    expect(o.fragility).toEqual(computeBitcoinOutlook(full()).fragility);
  });

  it('with every optional driver absent the outlook still has all three labels', () => {
    const o = computeBitcoinOutlook({
      asOf: '2026-10-10',
      btcCloses: stepSeries(300, 1, 100, 101),
      market: mkt({ A2: 50 }, { funding: 0.01, oi30: 5, fng: 55 }),
    });
    expect(o.regime.label).toBe('Uptrend');
    expect(o.fuel.label).toBe('Rising');
    expect(o.fragility.label).not.toBeNull();
    expect(o.drivers.filter((d) => !d.available).map((d) => d.id)).toEqual(['D1', 'D4']);
  });
});

/* ----------------------------------------------------------------------------- sentence */

describe('outlook sentence: templates, never free text', () => {
  const COMBOS = REGIMES.flatMap((r) =>
    FUELS.flatMap((f) => FRAGILITIES.map((g) => [r, f, g] as [Regime, Fuel, Fragility])),
  );

  it('there are 27 combinations and every one is produced, distinct, and passes the copy lint', () => {
    expect(COMBOS).toHaveLength(27);
    const texts = new Set<string>();
    for (const [regime, fuel, fragility] of COMBOS) {
      const s = outlookSentence({ regime, fuel, fragility, levels: SAMPLE_LEVELS });
      expect(s, `${regime} ${fuel} ${fragility}`).not.toBeNull();
      const text = s!.text;
      texts.add(text);
      expect(
        text.startsWith(
          `${regime}, fuel ${fuel.toLowerCase()}, fragility ${fragility.toLowerCase()}.`,
        ),
      ).toBe(true);
      expect(lintErrors(text), text).toEqual([]);
      expect(text).not.toMatch(FORBIDDEN);
      expect(text).not.toMatch(/[{}]/);
      expect(s!.tier).toBe('free');
    }
    expect(texts.size).toBe(27);
  });

  it('matches the master-plan shape: headline, regime, fuel, fragility, then levels', () => {
    const s = outlookSentence({
      regime: 'Uptrend',
      fuel: 'Rising',
      fragility: 'High',
      levels: SAMPLE_LEVELS,
    })!;
    expect(s.text).toBe(
      [
        'Uptrend, fuel rising, fragility high.',
        OUTLOOK_TEMPLATES.regime.Uptrend,
        OUTLOOK_TEMPLATES.fuel.Rising,
        OUTLOOK_TEMPLATES.fragility.High,
        'Levels to watch: support $82,000 to $84,000 (strong). Resistance $92,000, then $100,000.',
      ].join(' '),
    );
  });

  it('is built from the template file: editing a template changes the output, nothing else does', () => {
    expect(OUTLOOK_TEMPLATES.fragility.High).toContain('sharp drops are more likely than usual');
    expect(fillTemplate('a {x} b', { x: 1 })).toBe('a 1 b');
    expect(() => fillTemplate('a {x}', {})).toThrow(/needs \{x\}/);
    expect(() => fillTemplate('a', { y: 1 })).toThrow(/does not use \{y\}/);
  });

  it('no sentence when a label is missing (never a partial sentence)', () => {
    expect(outlookSentence({ regime: null, fuel: 'Rising', fragility: 'Low' })).toBeNull();
    expect(outlookSentence({ regime: 'Range', fuel: null, fragility: 'Low' })).toBeNull();
    expect(outlookSentence({ regime: 'Range', fuel: 'Flat', fragility: null })).toBeNull();
  });

  it('the template file itself is scanned by the copy lint and has no errors', () => {
    const files = collectFiles(REPO_ROOT).map((f) => relative(REPO_ROOT, f).split(sep).join('/'));
    expect(files).toContain(TEMPLATE_FILE);
    const src = readFileSync(resolve(REPO_ROOT, TEMPLATE_FILE), 'utf8');
    expect(lintSource(TEMPLATE_FILE, src, rules, allow)).toEqual([]);
    // The two words the task rules out, in any template.
    expect(src).not.toMatch(/\bwill\b/i);
    expect(src).not.toMatch(/\btargets?\b/i);
    expect(src).not.toMatch(/\bbuy at\b/i);
  });

  it('every template string passes the copy lint, with its placeholders filled', () => {
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') strings.push(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(OUTLOOK_TEMPLATES);
    expect(strings.length).toBeGreaterThan(60);
    for (const s of strings) {
      const filled = s.replace(/\{(\w+)\}/g, '5');
      expect(lintErrors(filled), s).toEqual([]);
      expect(filled).not.toMatch(FORBIDDEN);
    }
  });
});

describe('levels clause', () => {
  it('support zone with strength, then the next two resistances', () => {
    expect(levelsClause(SAMPLE_LEVELS)).toBe(
      'Levels to watch: support $82,000 to $84,000 (strong). Resistance $92,000, then $100,000.',
    );
  });

  it('formats zones as one price when both ends round to the same dollar', () => {
    expect(formatZone({ low: 65_000, high: 65_000 })).toBe('$65,000');
    expect(formatZone({ low: 64_999.6, high: 65_000.4 })).toBe('$65,000');
    expect(formatZone({ low: 999, high: 1_000_001 })).toBe('$999 to $1,000,001');
  });

  it('one resistance only', () => {
    const l = levels(
      [zone('support', 80_000, 81_000, 'Medium')],
      [zone('resistance', 90_000, 90_000)],
    );
    expect(levelsClause(l)).toBe(
      'Levels to watch: support $80,000 to $81,000 (medium). Resistance $90,000.',
    );
  });

  it('no support below: says so, resistances still shown', () => {
    const l = levels([], [zone('resistance', 90_000, 91_000), zone('resistance', 95_000, 95_000)]);
    expect(levelsClause(l)).toBe(
      'Levels to watch: no support zone found below the price. Resistance $90,000 to $91,000, then $95,000.',
    );
  });

  it('no resistance and no all-time-high note: says no resistance found', () => {
    expect(levelsClause(levels([zone('support', 80_000, 81_000)], []))).toBe(
      'Levels to watch: support $80,000 to $81,000 (strong). No resistance zone found above the price.',
    );
  });

  it('all-time high with no resistance: the no-earlier-price note replaces the resistance', () => {
    const l = levels([zone('support', 80_000, 81_000)], [], 'No earlier price above this');
    expect(levelsClause(l)).toBe(
      'Levels to watch: support $80,000 to $81,000 (strong). No earlier price above this.',
    );
  });

  it('all-time high with round-number resistances above: both are shown', () => {
    const l = levels(
      [zone('support', 80_000, 81_000)],
      [zone('resistance', 105_000, 105_000, 'Weak')],
      'No earlier price above this',
    );
    expect(levelsClause(l)).toBe(
      'Levels to watch: support $80,000 to $81,000 (strong). Resistance $105,000. No earlier price above this.',
    );
  });

  it('no levels at all, or none computed', () => {
    expect(levelsClause(levels([], []))).toBe(
      'Levels to watch: no support zone found below the price. No resistance zone found above the price.',
    );
    expect(levelsClause(null)).toBe('Levels to watch: not available yet.');
    expect(levelsClause(undefined)).toBe('Levels to watch: not available yet.');
    for (const l of [levels([], []), null]) {
      expect(lintErrors(levelsClause(l))).toEqual([]);
    }
  });

  it('every one of the 27 sentences stays clean with every missing-levels variant', () => {
    const variants: (LevelsView | null)[] = [
      null,
      levels([], []),
      levels([], [], 'No earlier price above this'),
      levels([zone('support', 1, 2)], []),
    ];
    for (const lv of variants)
      for (const r of REGIMES)
        for (const f of FUELS)
          for (const g of FRAGILITIES) {
            const t = outlookSentence({ regime: r, fuel: f, fragility: g, levels: lv })!.text;
            expect(lintErrors(t), t).toEqual([]);
            expect(t).not.toMatch(FORBIDDEN);
          }
  });
});

/* ----------------------------------------------------------------------------- scenarios */

describe('scenarios: base, upside, downside with triggers, not dates', () => {
  const by = (s: ReturnType<typeof buildScenarios>) =>
    Object.fromEntries(s.map((x) => [x.kind, x]));

  it('builds the three from the regime and the nearest levels', () => {
    const s = by(buildScenarios('Uptrend', SAMPLE_LEVELS));
    expect(Object.keys(s)).toEqual(['base', 'upside', 'downside']);
    expect(s['base']!.summary).toBe(
      'The uptrend continues between support $82,000 to $84,000 and resistance $92,000.',
    );
    expect(s['base']!.trigger).toBe('Daily closes stay between $82,000 to $84,000 and $92,000.');
    // Nearest Medium-or-Strong resistance is 92,000 (medium); the next resistance is 100,000.
    expect(s['upside']!.trigger).toBe(
      'A daily close above $92,000 (medium) opens the next resistance, $100,000.',
    );
    expect(s['downside']!.trigger).toBe(
      'A daily close below $82,000 to $84,000 (strong) opens the next support, $76,000 to $77,000.',
    );
    for (const x of Object.values(s)) {
      expect(x.tier).toBe('pro');
      expect(x.trigger).not.toMatch(
        /\b(20\d\d|january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
      );
    }
  });

  it('the regime wording follows the label', () => {
    expect(buildScenarios('Range', SAMPLE_LEVELS)[0]!.summary.startsWith('The range holds')).toBe(
      true,
    );
    expect(
      buildScenarios('Downtrend', SAMPLE_LEVELS)[0]!.summary.startsWith('The downtrend continues'),
    ).toBe(true);
    expect(
      buildScenarios(null, SAMPLE_LEVELS)[0]!.summary.startsWith('Current conditions continue'),
    ).toBe(true);
  });

  it('upside skips a Weak nearest resistance: the nearest Medium-or-Strong one opens the next', () => {
    const l = levels(
      [zone('support', 80_000, 81_000)],
      [
        zone('resistance', 90_000, 90_000, 'Weak'),
        zone('resistance', 95_000, 96_000, 'Strong'),
        zone('resistance', 110_000, 110_000, 'Medium'),
      ],
    );
    const up = by(buildScenarios('Range', l))['upside']!;
    expect(up.trigger).toBe(
      'A daily close above $95,000 to $96,000 (strong) opens the next resistance, $110,000.',
    );
    expect(up.zones.map((z) => z.low)).toEqual([95_000, 110_000]);
    // The base case still uses the nearest resistance of any strength.
    expect(by(buildScenarios('Range', l))['base']!.summary).toContain('resistance $90,000.');
  });

  it('only the first resistance is Medium or Strong and there is no zone after it', () => {
    const l = levels(
      [zone('support', 80_000, 81_000)],
      [zone('resistance', 90_000, 90_000, 'Medium')],
    );
    expect(by(buildScenarios('Range', l))['upside']!.trigger).toBe(
      'A daily close above $90,000 (medium) leaves no further resistance zone mapped.',
    );
  });

  it('only Weak resistances above: no Medium-or-Strong trigger is invented', () => {
    const l = levels(
      [zone('support', 80_000, 81_000)],
      [zone('resistance', 90_000, 90_000, 'Weak')],
    );
    expect(by(buildScenarios('Range', l))['upside']!.trigger).toBe(
      'No Medium or Strong resistance zone above; the nearest zone is $90,000 (weak).',
    );
  });

  it('no resistance above (all-time high): handled, with the no-earlier-price note', () => {
    const l = levels(
      [zone('support', 80_000, 81_000), zone('support', 70_000, 71_000, 'Medium')],
      [],
      'No earlier price above this',
    );
    const s = by(buildScenarios('Uptrend', l));
    expect(s['upside']!.trigger).toBe(
      'No earlier price above this. No resistance zone found above the price.',
    );
    expect(s['upside']!.zones).toEqual([]);
    expect(s['base']!.summary).toBe('The uptrend continues above support $80,000 to $81,000.');
    expect(s['base']!.trigger).toBe('Daily closes stay above $80,000 to $81,000.');
    expect(s['downside']!.trigger).toContain('opens the next support, $70,000 to $71,000');
  });

  it('all-time high with round-number resistances: the note is kept and the zones used', () => {
    const l = levels(
      [zone('support', 80_000, 81_000)],
      [
        zone('resistance', 105_000, 105_000, 'Medium'),
        zone('resistance', 110_000, 110_000, 'Weak'),
      ],
      'No earlier price above this',
    );
    expect(by(buildScenarios('Uptrend', l))['upside']!.trigger).toBe(
      'No earlier price above this. A daily close above $105,000 (medium) opens the next resistance, $110,000.',
    );
  });

  it('no support below: downside and base say so', () => {
    const l = levels([], [zone('resistance', 90_000, 91_000)]);
    const s = by(buildScenarios('Downtrend', l));
    expect(s['downside']!.trigger).toBe('No support zone found below the price.');
    expect(s['base']!.summary).toBe('The downtrend continues below resistance $90,000 to $91,000.');
    expect(s['base']!.trigger).toBe('Daily closes stay below $90,000 to $91,000.');
  });

  it('one support only: no next support is invented', () => {
    const l = levels(
      [zone('support', 80_000, 81_000, 'Weak')],
      [zone('resistance', 90_000, 90_000)],
    );
    expect(by(buildScenarios('Range', l))['downside']!.trigger).toBe(
      'A daily close below $80,000 to $81,000 (weak) leaves no further support zone mapped.',
    );
  });

  it('no levels on either side, and levels not computed', () => {
    const none = by(buildScenarios('Range', levels([], [])));
    expect(none['base']!.summary).toBe(
      'The range holds, but no nearby levels are available to bound it.',
    );
    expect(none['base']!.trigger).toBe('No trigger: key levels are not available.');
    const missing = buildScenarios('Range', null);
    expect(missing).toHaveLength(3);
    for (const x of missing) expect(x.trigger).toBe(OUTLOOK_TEMPLATES.scenarios.unavailable);
  });

  it('does not depend on the order the zones are passed in, and does not mutate them', () => {
    const l = levels(
      [zone('support', 76_000, 77_000, 'Medium'), zone('support', 82_000, 84_000)],
      [zone('resistance', 100_000, 100_000, 'Weak'), zone('resistance', 92_000, 92_000, 'Medium')],
    );
    const before = JSON.stringify(l);
    expect(buildScenarios('Uptrend', l)).toEqual(buildScenarios('Uptrend', SAMPLE_LEVELS));
    expect(JSON.stringify(l)).toBe(before);
  });

  it('all scenario text across the cases passes the copy lint and the forbidden-word check', () => {
    const cases: (LevelsView | null)[] = [
      SAMPLE_LEVELS,
      null,
      levels([], []),
      levels([], [], 'No earlier price above this'),
      levels([zone('support', 1, 2)], [zone('resistance', 3, 4, 'Weak')]),
    ];
    for (const lv of cases)
      for (const r of [...REGIMES, null])
        for (const sc of buildScenarios(r, lv)) {
          const t = `${sc.title}. ${sc.summary} ${sc.trigger}`;
          expect(lintErrors(t), t).toEqual([]);
          expect(t).not.toMatch(FORBIDDEN);
          expect(t).not.toMatch(/[{}]/);
        }
  });
});

/* ----------------------------------------------------------------------------- history */

describe('history line: base rates (CSN-040) are an input, never invented', () => {
  const state = { regime: 'Uptrend', fuel: 'Rising' } as const;

  it('no base rates yet: History not yet computed, no numbers', () => {
    for (const none of [null, undefined]) {
      const h = historyLine(none, state);
      expect(h).toMatchObject({
        state: 'pending',
        text: 'History not yet computed.',
        n: null,
        higher90Pct: null,
        fell20Pct: null,
        tier: 'pro',
      });
    }
  });

  it('fills the sentence from the supplied rates, with the sample size', () => {
    const h = historyLine({ n: 48, higher90: 0.625, fell20: 0.21 }, state);
    expect(h.state).toBe('ready');
    expect(h.text).toBe(
      'In similar conditions Bitcoin was higher 90 days later in 63% of cases, but fell more than 20% along the way in 21%. Based on 48 independent periods.',
    );
    expect(h.text).not.toMatch(/thin history/i);
    expect(lintErrors(h.text)).toEqual([]);
  });

  it('thin history when n is below 30; exactly 30 is not thin', () => {
    const thin = historyLine({ n: 29, higher90: 0.5, fell20: 0.1 }, state);
    expect(thin.state).toBe('thin');
    expect(thin.text).toMatch(/Thin history: fewer than 30 independent periods/);
    expect(thin.text).toMatch(/Based on 29 independent periods/);
    expect(historyLine({ n: 30, higher90: 0.5, fell20: 0.1 }, state).state).toBe('ready');
    const c = cloneModelConfig();
    c.levelA.outlook.thinHistoryPeriods = 50;
    expect(historyLine({ n: 40, higher90: 0.5, fell20: 0.1 }, state, c).state).toBe('thin');
    expect(lintErrors(thin.text)).toEqual([]);
  });

  it('a zero or invalid sample reads as not computed, not as 0%', () => {
    for (const bad of [
      { n: 0, higher90: 0, fell20: 0 },
      { n: 12.5, higher90: 0.5, fell20: 0.1 },
      { n: -3, higher90: 0.5, fell20: 0.1 },
      { n: 40, higher90: 1.2, fell20: 0.1 },
      { n: 40, higher90: 0.5, fell20: -0.1 },
      { n: 40, higher90: Number.NaN, fell20: 0.1 },
    ])
      expect(historyLine(bad, state).state).toBe('pending');
  });

  it('rates for a different Regime x Fuel state than today are not shown', () => {
    expect(historyLine({ regime: 'Range', n: 60, higher90: 0.5, fell20: 0.1 }, state).state).toBe(
      'pending',
    );
    expect(historyLine({ fuel: 'Flat', n: 60, higher90: 0.5, fell20: 0.1 }, state).state).toBe(
      'pending',
    );
    expect(
      historyLine({ regime: 'Uptrend', fuel: 'Rising', n: 60, higher90: 0.5, fell20: 0.1 }, state)
        .state,
    ).toBe('ready');
    expect(
      historyLine(
        { regime: 'Uptrend', n: 60, higher90: 0.5, fell20: 0.1 },
        { regime: null, fuel: null },
      ).state,
    ).toBe('pending');
  });

  it('goes through the outlook: pending until base rates are supplied', () => {
    const base: BitcoinOutlookInput = {
      asOf: '2026-10-10',
      btcCloses: stepSeries(300, 1, 100, 101),
      market: mkt({ A2: 50 }),
    };
    expect(computeBitcoinOutlook(base).history.text).toBe('History not yet computed.');
    const o = computeBitcoinOutlook({
      ...base,
      baseRates: { regime: 'Uptrend', fuel: 'Rising', n: 31, higher90: 0.7, fell20: 0.2 },
    });
    expect(o.history).toMatchObject({ state: 'ready', higher90Pct: 70, fell20Pct: 20, n: 31 });
  });
});

/* ----------------------------------------------------------------------------- whole outlook */

describe('computeBitcoinOutlook', () => {
  it('tags every output field free or pro (regime, fuel, fragility, levels free; history, scenarios pro)', () => {
    expect(OUTLOOK_FIELD_TIERS).toMatchObject({
      regime: 'free',
      fuel: 'free',
      fragility: 'free',
      levels: 'free',
      sentence: 'free',
      drivers: 'free',
      history: 'pro',
      scenarios: 'pro',
    });
    const o = computeBitcoinOutlook({
      asOf: '2026-10-10',
      btcCloses: stepSeries(300, 1, 100, 101),
      market: mkt({ A2: 50 }, { funding: 0.01, oi30: 5, fng: 55 }),
    });
    expect(o.tiers).toBe(OUTLOOK_FIELD_TIERS);
    expect([o.regime.tier, o.fuel.tier, o.fragility.tier, o.sentence!.tier]).toEqual([
      'free',
      'free',
      'free',
      'free',
    ]);
    expect([o.history.tier, ...o.scenarios.map((s) => s.tier)]).toEqual([
      'pro',
      'pro',
      'pro',
      'pro',
    ]);
  });

  it('is deterministic and does not mutate its input', () => {
    const input: BitcoinOutlookInput = {
      asOf: '2026-10-10',
      btcCloses: Object.freeze(stepSeries(300, 1, 100, 101)),
      market: mkt({ A2: 50, A8: 20, A6: -10 }, { funding: 0.02, oi30: 12, fng: 72 }),
      etfFlow20dBn: 1.1,
      liquidationClusters: Object.freeze([Object.freeze({ price: 103 })]),
      levels: null,
    };
    const a = computeBitcoinOutlook(input);
    const b = computeBitcoinOutlook(input);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('with nothing supplied returns nulls and a pending history, and does not throw', () => {
    const o = computeBitcoinOutlook({ asOf: '2026-10-10' });
    expect([o.regime.label, o.fuel.label, o.fragility.label, o.sentence]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(o.history.state).toBe('pending');
    expect(o.scenarios).toHaveLength(3);
    expect(o.drivers.map((d) => d.id)).toEqual(['D1', 'D2', 'D3', 'D4']);
  });

  it('uses the key-levels price for D4 when no closes are given', () => {
    const lv = { ...levels([], []), price: 100, atr: 1, walls: [], zones: [] } as LevelsView & {
      price: number;
      atr: number;
      walls: never[];
      zones: never[];
    };
    const o = computeBitcoinOutlook({
      asOf: '2026-10-10',
      market: mkt({}, { funding: 0, oi30: 0, fng: 50 }),
      liquidationClusters: [{ price: 104 }],
      levels: lv as never,
    });
    expect(o.fragility.nearestClusterPct!).toBeCloseTo(4, 9);
  });

  it('works on real key levels: a rising series at an all-time high, and a flat one', () => {
    const rising = SAMPLE_rising(400, 50_000);
    const lvRise = computeKeyLevels({ asset: 'BTC', ...rising });
    const closes = rising.daily.map((c) => c.close);
    const o = computeBitcoinOutlook({
      asOf: '2026-10-10',
      btcCloses: closes,
      market: mkt({ A2: 30 }, { funding: 0.01, oi30: 5, fng: 60 }),
      levels: lvRise,
    });
    expect(lvRise.resistanceNote).toBe('No earlier price above this');
    expect(o.regime.label).toBe('Uptrend');
    expect(o.sentence!.text).toContain('No earlier price above this.');
    expect(o.scenarios[1]!.trigger.startsWith('No earlier price above this.')).toBe(true);
    for (const t of [o.sentence!.text, ...o.scenarios.map((s) => s.trigger)])
      expect(lintErrors(t), t).toEqual([]);

    const flat = SAMPLE_flat(400, 100_000, 500);
    const lvFlat = computeKeyLevels({ asset: 'BTC', ...flat, price: 100_200 });
    const f = computeBitcoinOutlook({
      asOf: '2026-10-10',
      btcCloses: flat.daily.map((c) => c.close),
      market: mkt({ A2: 0 }, { funding: 0, oi30: 0, fng: 50 }),
      levels: lvFlat,
    });
    expect(f.regime.label).toBe('Range');
    expect(f.sentence!.text).toMatch(/Levels to watch: .*\$/);
    expect(f.levels).toBe(lvFlat);
  });
});

/* ----------------------------------------------------------------------------- golden pin */

describe('pin against the Score Lab bitcoinOutlook() on the golden fixture (SAMPLE data)', () => {
  const golden = loadGolden();
  const lab = golden.outputs.market.outlook as unknown as {
    regime: string;
    fuel: number;
    fuelLabel: string;
    fuelParts: Record<string, number>;
    etf: number;
    frag: number;
    fragLabel: string;
    fragParts: { lev: number; liq: number; sent: number };
    liqNear: number;
    halvingMonths: number;
    fng: number;
  };
  const macro = golden.inputs.macro as unknown as {
    etf20: { now: number };
    extraLevels: { BTC: { m: string; px: number }[] };
    asOf: string;
  };
  const cfg = labLevelACompatConfig();
  const closes = coinSeries(golden, 'BTC').p.slice(0, golden.meta.scoredDay + 1);
  const clusters = macro.extraLevels.BTC.filter((e) => e.m === 'K6').map((e) => ({ price: e.px }));
  const input = (): BitcoinOutlookInput => ({
    asOf: macro.asOf,
    btcCloses: closes,
    market: marketWeather(goldenMarketInputs(golden, 'now'), cfg),
    etfFlow20dBn: macro.etf20.now,
    liquidationClusters: clusters,
  });
  const o = computeBitcoinOutlook(input(), cfg);

  it('Regime, Fuel and Fragility labels match exactly', () => {
    expect(o.regime.label).toBe(lab.regime);
    expect(o.fuel.label).toBe(lab.fuelLabel);
    expect(o.fragility.label).toBe(lab.fragLabel);
  });

  it('Fuel parts and score match the Lab within the golden tolerance', () => {
    const tol = golden.meta.tolerance.points;
    for (const p of o.fuel.parts)
      expect(Math.abs(p.score! - lab.fuelParts[p.id]!)).toBeLessThanOrEqual(tol);
    expect(Math.abs(o.fuel.score! - lab.fuel)).toBeLessThanOrEqual(tol);
    expect(o.fuel.missing).toEqual([]);
  });

  it('Fragility parts and score match the Lab (all four parts present, so weights are the Lab weights)', () => {
    const tol = golden.meta.tolerance.points;
    const w = (id: string) => o.fragility.parts.find((p) => p.id === id)!;
    const lev = w('funding').value! * 0.4 + w('openInterest').value! * 0.3;
    expect(Math.abs(lev - lab.fragParts.lev)).toBeLessThanOrEqual(tol);
    expect(Math.abs(w('liquidation').value! * 0.15 - lab.fragParts.liq)).toBeLessThanOrEqual(tol);
    expect(Math.abs(w('sentiment').value! * 0.15 - lab.fragParts.sent)).toBeLessThanOrEqual(tol);
    expect(Math.abs(o.fragility.score! - lab.frag)).toBeLessThanOrEqual(tol);
    expect(o.fragility.nearestClusterPct!).toBeCloseTo(lab.liqNear, 9);
    expect(o.fragility.missing).toEqual([]);
  });

  it('halving months and the D1 and D3 values match', () => {
    expect(o.halvingMonths!).toBeCloseTo(lab.halvingMonths, 9);
    expect(o.drivers.find((d) => d.id === 'D1')!.value).toBe(lab.etf);
    expect(o.drivers.find((d) => d.id === 'D3')!.value).toBe(lab.fng);
  });

  it('the golden outlook yields a sentence that passes the copy lint', () => {
    expect(o.sentence).not.toBeNull();
    expect(lintErrors(o.sentence!.text)).toEqual([]);
    expect(o.history.state).toBe('pending');
  });
});
