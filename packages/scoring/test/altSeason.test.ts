import { describe, expect, it, vi } from 'vitest';
import { cloneModelConfig } from '../src/config/schema';
import {
  altSeason,
  altSeasonPhase,
  scoreC1,
  scoreC2,
  scoreC3,
  type AltCandidate,
  type AltSeasonInputs,
  type Measure,
} from '../src/index';
import { loadGolden } from './oracle/golden';
import { goldenAltInputs, labLevelACompatConfig } from './oracle/labLevelACompat';

const ASOF = '2026-10-10';
const CFG = cloneModelConfig();

const near = (x: number | null, y: number, digits = 9) => {
  expect(x).not.toBeNull();
  expect(x as number).toBeCloseTo(y, digits);
};

/** Measure history whose mean is `centre` and whose z-score unit (2 x sd) is exactly `unit`. */
function history(centre: number, unit: number, n = 10): number[] {
  const a = unit / 2 / Math.sqrt(n / (n - 1));
  return Array.from({ length: n }, (_, k) => centre + (k % 2 === 0 ? -a : a));
}
const meas = (value: number, centre: number, unit: number): Measure => ({
  value,
  history: history(centre, unit),
});

/** 91 closes (enough for a 90-day return) that end `pct` percent above where they were 90 days ago. */
const returning = (pct: number): number[] =>
  Array.from({ length: 91 }, (_, k) => (k === 90 ? 100 * (1 + pct / 100) : 100));

/** `count` alts with market caps count..1 (in millions), each returning `pct(k)` over 90 days. */
function alts(count: number, pct: (k: number) => number, prefix = 'ALT'): AltCandidate[] {
  return Array.from({ length: count }, (_, k) => ({
    symbol: `${prefix}${k}`,
    marketCap: (count - k) * 1e6,
    closes: returning(pct(k)),
  }));
}

describe('C1 Alt season index: share of the top 50 alts whose 90D return beats Bitcoin', () => {
  const btc = returning(10);

  it('counts the alts that beat Bitcoin, strictly', () => {
    // 20 alts: 13 above Bitcoin's 10%, one exactly equal, the rest below.
    const list = alts(20, (k) => (k < 13 ? 20 : k === 13 ? 10 : 0));
    const r = scoreC1({ asOf: ASOF, btcCloses: btc, alts: list });
    expect(r.raw).toBe(65);
    expect(r.subScore).toBe(65);
    expect(r.detail).toMatchObject({ topN: 50, returnDays: 90, counted: 20, beat: 13 });
    near(r.detail!.btcReturn, 10);
    expect(r.configuredWeight).toBe(50);
    expect(r.source).toBe('CoinGecko');
    expect(r.status).toBe('ok');
  });

  it('only the 50 largest alts by market cap count', () => {
    // 60 alts: the 50 largest all trail Bitcoin; the 10 smallest all beat it by a lot.
    const list = alts(60, (k) => (k < 50 ? 0 : 500));
    const r = scoreC1({ asOf: ASOF, btcCloses: btc, alts: list });
    expect(r.raw).toBe(0);
    expect(r.detail).toMatchObject({ counted: 50, beat: 0 });
    // The order of the input list does not matter.
    const shuffled = [...list].reverse();
    expect(scoreC1({ asOf: ASOF, btcCloses: btc, alts: shuffled }).raw).toBe(0);
  });

  it('leaves out PAXG, XAUT, stablecoins and Bitcoin, and they do not use up top-50 places', () => {
    const real = alts(50, () => 0); // 50 alts that all trail Bitcoin
    const out: AltCandidate[] = [
      { symbol: 'PAXG', marketCap: 9e12, closes: returning(900) },
      { symbol: 'xaut', marketCap: 8e12, closes: returning(900) },
      { symbol: 'USDT', marketCap: 7e12, closes: returning(900) },
      { symbol: 'USDC', marketCap: 6e12, closes: returning(900) },
      { symbol: 'NEWSTABLE', marketCap: 5e12, closes: returning(900), isStablecoin: true },
      { symbol: 'BTC', marketCap: 4e13, closes: returning(900) },
    ];
    const r = scoreC1({ asOf: ASOF, btcCloses: btc, alts: [...out, ...real] });
    expect(r.raw).toBe(0);
    expect(r.detail!.counted).toBe(50);
    expect(r.detail!.excluded).toEqual(['PAXG', 'xaut', 'USDT', 'USDC', 'NEWSTABLE', 'BTC']);
  });

  it('the gold-token and stablecoin lists are config values', () => {
    const cfg = cloneModelConfig();
    cfg.cycle.dex = ['PAXG'];
    cfg.levelA.cycle.stablecoins = [];
    const list = [
      { symbol: 'XAUT', marketCap: 9e9, closes: returning(900) },
      { symbol: 'USDT', marketCap: 8e9, closes: returning(900) },
      ...alts(2, () => 0),
    ];
    const r = scoreC1({ asOf: ASOF, btcCloses: btc, alts: list }, cfg);
    expect(r.detail).toMatchObject({ counted: 4, beat: 2, excluded: [] });
    expect(r.raw).toBe(50);
  });

  it('breaks market-cap ties by symbol so the 50th place is deterministic', () => {
    const list: AltCandidate[] = [
      ...alts(49, () => 0),
      { symbol: 'ZZZ', marketCap: 1e6, closes: returning(500) },
      { symbol: 'AAA', marketCap: 1e6, closes: returning(0) },
    ];
    // Both tie at 1e6 (the smallest); only AAA takes the 50th place.
    const r = scoreC1({ asOf: ASOF, btcCloses: btc, alts: list });
    expect(r.detail).toMatchObject({ counted: 50, beat: 0 });
  });

  it('topN and the return window are config values', () => {
    const list = alts(10, (k) => (k < 3 ? 50 : 0));
    const cfg = cloneModelConfig();
    cfg.levelA.cycle.topN = 5;
    expect(scoreC1({ asOf: ASOF, btcCloses: btc, alts: list }, cfg).detail).toMatchObject({
      counted: 5,
      beat: 3,
    });
    const short = cloneModelConfig();
    short.levelA.cycle.returnDays = 30;
    const r = scoreC1({ asOf: ASOF, btcCloses: btc, alts: list }, short);
    // Over 30 days every close is flat (the move happens on the last day only): same ranking.
    expect(r.detail!.returnDays).toBe(30);
  });

  it('alts without enough price history are not counted either way', () => {
    const list: AltCandidate[] = [
      ...alts(4, () => 50),
      { symbol: 'YOUNG', marketCap: 9e9, closes: [100, 101, 102] },
      { symbol: 'NOHIST', marketCap: 8e9, closes: null },
    ];
    const r = scoreC1({ asOf: ASOF, btcCloses: btc, alts: list });
    expect(r.detail).toMatchObject({ counted: 4, beat: 4, unrated: ['YOUNG', 'NOHIST'] });
    expect(r.raw).toBe(100);
  });

  it('coins without a market cap cannot be ranked', () => {
    const list: AltCandidate[] = [
      ...alts(2, () => 50),
      { symbol: 'NOCAP', marketCap: null, closes: returning(50) },
    ];
    expect(scoreC1({ asOf: ASOF, btcCloses: btc, alts: list }).detail!.counted).toBe(2);
  });

  it('is missing without Bitcoin history, without alts, or when no alt has a return', () => {
    expect(scoreC1({ asOf: ASOF, alts: alts(3, () => 0) }).status).toBe('missing');
    expect(scoreC1({ asOf: ASOF, btcCloses: btc }).status).toBe('missing');
    expect(scoreC1({ asOf: ASOF, btcCloses: btc, alts: [] }).status).toBe('missing');
    expect(scoreC1({ asOf: ASOF, btcCloses: [1, 2, 3], alts: alts(3, () => 0) }).missing).toBe(
      'noValue',
    );
    expect(
      scoreC1({ asOf: ASOF, btcCloses: btc, alts: [{ symbol: 'A', marketCap: 1, closes: [1] }] })
        .status,
    ).toBe('missing');
  });
});

describe('C2 Bitcoin dominance: 30D change, falling dominance scores higher', () => {
  const at = (v: number, cfg = CFG) =>
    scoreC2({ asOf: ASOF, btcDominanceChange30d: meas(v, 0, 2) }, cfg);

  it('maps the signed sub-score to 0-100 around 50', () => {
    near(at(0).subScore, 50);
    near(at(1).subScore, 25); // rising dominance: signed -50
    near(at(-1).subScore, 75); // falling dominance: signed +50
    expect(at(5).subScore).toBe(0);
    expect(at(-5).subScore).toBe(100);
    near(at(1).signedSubScore, -50);
  });

  it('reports raw value, weight and source', () => {
    const r = scoreC2({
      asOf: ASOF,
      btcDominanceChange30d: { ...meas(0.6, 0, 2), source: 'CoinGecko (sample)' },
    });
    expect(r).toMatchObject({
      id: 'C2',
      raw: 0.6,
      configuredWeight: 25,
      source: 'CoinGecko (sample)',
    });
  });

  it('is missing without a value or without history', () => {
    expect(scoreC2({ asOf: ASOF }).status).toBe('missing');
    const r = scoreC2({ asOf: ASOF, btcDominanceChange30d: { value: 1 } });
    expect(r).toMatchObject({ status: 'missing', missing: 'noHistory', subScore: null });
  });
});

describe('C3 ETH vs BTC: 30D change in the ETH/BTC ratio', () => {
  const lab = labLevelACompatConfig();
  /** Bitcoin flat at 100; ETH flat at 100 then `pct` percent higher on the last day. */
  const flatThenMove = (pct: number, n = 40) => ({
    btcCloses: Array<number>(n).fill(100),
    ethCloses: Array.from({ length: n }, (_, k) => (k === n - 1 ? 100 * (1 + pct / 100) : 100)),
  });

  it('measures the ratio change over 30 days (fixed Lab scale: +-15% is a full 100)', () => {
    near(scoreC3({ asOf: ASOF, ...flatThenMove(15) }, lab).subScore, 100);
    near(scoreC3({ asOf: ASOF, ...flatThenMove(7.5) }, lab).subScore, 75);
    near(scoreC3({ asOf: ASOF, ...flatThenMove(0) }, lab).subScore, 50);
    near(scoreC3({ asOf: ASOF, ...flatThenMove(-7.5) }, lab).subScore, 25);
    expect(scoreC3({ asOf: ASOF, ...flatThenMove(-40) }, lab).subScore).toBe(0);
    near(scoreC3({ asOf: ASOF, ...flatThenMove(7.5) }, lab).raw, 7.5);
  });

  it('a bitcoin move lowers the ratio the same way an ETH move raises it', () => {
    const btc = Array.from({ length: 40 }, (_, k) => (k === 39 ? 110 : 100));
    const eth = Array<number>(40).fill(100);
    near(scoreC3({ asOf: ASOF, btcCloses: btc, ethCloses: eth }, lab).raw, (100 / 110 - 1) * 100);
  });

  it('under the default method it is scaled against the ratio 1-year history', () => {
    // 500 days of a wandering ETH/BTC ratio.
    const btc = Array.from({ length: 500 }, (_, k) => 100 + 20 * Math.sin(k / 15));
    const eth = Array.from({ length: 500 }, (_, k) => 50 + 10 * Math.sin(k / 9 + 1));
    const r = scoreC3({ asOf: ASOF, btcCloses: btc, ethCloses: eth });
    const ratio = eth.map((e, k) => e / btc[k]!);
    const change = (j: number) => (ratio[j]! / ratio[j - 30]! - 1) * 100;
    const last = 499;
    const past = Array.from({ length: 365 }, (_, k) => change(last - 365 + k));
    const m = past.reduce((s, x) => s + x, 0) / past.length;
    const sd = Math.sqrt(past.reduce((s, x) => s + (x - m) ** 2, 0) / (past.length - 1));
    const signed = Math.max(-100, Math.min(100, ((change(last) - m) / (2 * sd)) * 100));
    near(r.raw, change(last), 10);
    near(r.signedSubScore, signed, 8);
    near(r.subScore, (signed + 100) / 2, 8);
  });

  it('is missing without a long enough history, or without either series', () => {
    expect(scoreC3({ asOf: ASOF, ...flatThenMove(5, 20) }, lab).status).toBe('missing');
    expect(scoreC3({ asOf: ASOF, ...flatThenMove(5) }).missing).toBe('noHistory');
    expect(scoreC3({ asOf: ASOF }).status).toBe('missing');
    expect(() => scoreC3({ asOf: ASOF, btcCloses: [1, 2, 3], ethCloses: [1, 2] }, lab)).toThrow(
      RangeError,
    );
  });

  it('the ratio window is a config value', () => {
    // ETH climbs 1 per day against a flat Bitcoin: the 10-day and 30-day changes differ.
    const eth = Array.from({ length: 40 }, (_, k) => 100 + k);
    const btc = Array<number>(40).fill(100);
    const cfg = labLevelACompatConfig();
    cfg.levelA.cycle.ethBtcDays = 10;
    near(scoreC3({ asOf: ASOF, btcCloses: btc, ethCloses: eth }, cfg).raw, (139 / 129 - 1) * 100);
    near(scoreC3({ asOf: ASOF, btcCloses: btc, ethCloses: eth }, lab).raw, (139 / 109 - 1) * 100);
  });
});

describe('alt season score: C1 50, C2 25, C3 25', () => {
  const lab = labLevelACompatConfig();
  const full = (): AltSeasonInputs => ({
    asOf: ASOF,
    btcCloses: Array<number>(91)
      .fill(100)
      .map((x, k) => (k === 90 ? 110 : x)),
    ethCloses: Array<number>(91)
      .fill(100)
      .map((x, k) => (k === 90 ? 107.5 : x)),
    alts: alts(20, (k) => (k < 10 ? 20 : 0)),
    btcDominanceChange30d: { value: -1 },
  });

  it('weights the three inputs 50/25/25 and the weights add up to 100', () => {
    const r = altSeason(full(), lab);
    // C1 = 50 (10 of 20), C2 = 75 (dominance -1 on the unit-2 scale), C3: ETH/BTC (1.075/1.1 - 1).
    const c3 = (107.5 / 110 / 1 - 1) * 100;
    expect(r.inputs.map((i) => i.effectiveWeight)).toEqual([50, 25, 25]);
    near(r.inputs[0]!.subScore, 50);
    near(r.inputs[1]!.subScore, 75);
    near(r.inputs[2]!.raw, c3, 9);
    near(r.score, 50 * 0.5 + 75 * 0.25 + r.inputs[2]!.subScore! * 0.25);
    expect(r.weightSum).toBe(100);
    expect(r.missingInputs).toEqual([]);
    expect(r.modelVersion).toBe('0.3');
  });

  it('drops a missing input, lists it and rescales the others to 100', () => {
    const r = altSeason({ ...full(), ethCloses: null }, lab);
    expect(r.missingInputs).toEqual(['C3']);
    near(r.inputs[0]!.effectiveWeight, (50 / 75) * 100);
    near(r.inputs[1]!.effectiveWeight, (25 / 75) * 100);
    expect(r.inputs[2]).toMatchObject({
      status: 'missing',
      effectiveWeight: 0,
      contribution: null,
    });
    near(r.score, (50 * 50 + 75 * 25) / 75);
    expect(Math.abs(r.weightSum - 100)).toBeLessThan(1e-9);
  });

  it('has no score or phase when nothing can be scored', () => {
    const r = altSeason({ asOf: ASOF }, CFG);
    expect(r).toMatchObject({ score: null, phase: null, weightSum: 0 });
    expect(r.missingInputs).toEqual(['C1', 'C2', 'C3']);
  });

  it('every input carries raw value, sub-score, effective weight and source', () => {
    const r = altSeason(full(), lab);
    for (const i of r.inputs) {
      expect(i.raw).not.toBeNull();
      expect(i.subScore).not.toBeNull();
      expect(i.effectiveWeight).toBeGreaterThan(0);
      expect(i.source.length).toBeGreaterThan(0);
      expect(i.unit.length).toBeGreaterThan(0);
      expect(i.contribution).toBeCloseTo((i.subScore! * i.effectiveWeight) / 100, 12);
    }
    expect(r.score).toBeCloseTo(
      r.inputs.reduce((s, i) => s + (i.contribution ?? 0), 0),
      12,
    );
  });

  it('weights are config values', () => {
    const cfg = labLevelACompatConfig();
    cfg.cycle.altIndex = 20;
    cfg.cycle.dominance = 40;
    cfg.cycle.ethBtc = 40;
    const r = altSeason(full(), cfg);
    expect(r.inputs.map((i) => i.effectiveWeight)).toEqual([20, 40, 40]);
    expect(r.score).not.toBe(altSeason(full(), lab).score);
  });
});

describe('phase at the exact boundaries: 65 or above Alt season, 35 or below Bitcoin season', () => {
  it('altSeasonPhase', () => {
    expect(altSeasonPhase(65)).toBe('Alt season');
    expect(altSeasonPhase(64.999999)).toBe('Mixed');
    expect(altSeasonPhase(35)).toBe('Bitcoin season');
    expect(altSeasonPhase(35.000001)).toBe('Mixed');
    expect(altSeasonPhase(50)).toBe('Mixed');
    expect(altSeasonPhase(100)).toBe('Alt season');
    expect(altSeasonPhase(0)).toBe('Bitcoin season');
  });

  it('end to end: C1 alone at exactly 65 and 35 gives the boundary phases', () => {
    const run = (beating: number) =>
      altSeason({
        asOf: ASOF,
        btcCloses: returning(10),
        alts: alts(20, (k) => (k < beating ? 20 : 0)),
      });
    expect(run(13)).toMatchObject({ score: 65, phase: 'Alt season' });
    expect(run(12)).toMatchObject({ score: 60, phase: 'Mixed' });
    expect(run(7)).toMatchObject({ score: 35, phase: 'Bitcoin season' });
    expect(run(8)).toMatchObject({ score: 40, phase: 'Mixed' });
  });

  it('the thresholds are config values', () => {
    const cfg = cloneModelConfig();
    cfg.cycle.altSeason = 80;
    cfg.cycle.btcSeason = 20;
    expect(altSeasonPhase(70, cfg)).toBe('Mixed');
    expect(altSeasonPhase(20, cfg)).toBe('Bitcoin season');
  });
});

describe('purity', () => {
  it('is deterministic, does not mutate its inputs and reads no clock or randomness', () => {
    const now = vi.spyOn(Date, 'now');
    const random = vi.spyOn(Math, 'random');
    const list = alts(20, (k) => k);
    const inputs: AltSeasonInputs = {
      asOf: ASOF,
      btcCloses: Object.freeze(returning(10)) as number[],
      alts: Object.freeze(list.map((a) => Object.freeze(a))) as AltCandidate[],
      btcDominanceChange30d: Object.freeze(meas(0.5, 0, 2)),
    };
    const before = JSON.stringify(inputs);
    const a = altSeason(inputs);
    expect(altSeason(inputs)).toEqual(a);
    expect(JSON.stringify(inputs)).toBe(before);
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    now.mockRestore();
    random.mockRestore();
  });
});

describe('golden: the Score Lab sample alt-season outputs (SAMPLE_golden.v0.3.json)', () => {
  // As for market weather: reachable only with the Lab's fixed scales (DISCREPANCIES.md D-08).
  const golden = loadGolden();
  const cfg = labLevelACompatConfig();
  const lab = golden.outputs.market.cycle as Record<string, number | string>;
  const TOL = 1e-9;

  it('today: score, phase, C1 share and count, and the C2 and C3 sub-scores', () => {
    const r = altSeason(goldenAltInputs(golden, 'now'), cfg);
    expect(r.phase).toBe(lab.phase);
    expect(Math.abs(r.score! - (lab.score as number))).toBeLessThan(TOL);
    const [c1, c2, c3] = r.inputs;
    expect(Math.abs(c1!.raw! - (lab.altIndex as number))).toBeLessThan(TOL);
    expect(c1!.detail).toMatchObject({ beat: lab.beat, counted: lab.n });
    expect([...c1!.detail!.excluded].sort()).toEqual(['BTC', 'PAXG', 'XAUT']);
    expect(Math.abs(c2!.subScore! - (lab.domScore as number))).toBeLessThan(TOL);
    expect(Math.abs(c3!.subScore! - (lab.ethScore as number))).toBeLessThan(TOL);
    expect(Math.abs(c3!.raw! / 100 - (lab.ethBtc30 as number))).toBeLessThan(TOL);
    expect(c2!.raw).toBe(lab.dom30);
    expect(r.inputs.map((i) => i.effectiveWeight)).toEqual([50, 25, 25]);
  });

  it('a week earlier: score and phase match the golden previous-week cycle', () => {
    const prev = golden.outputs.horizons.short.prev.cycle;
    const r = altSeason(goldenAltInputs(golden, 'prev'), cfg);
    expect(r.phase).toBe(prev.phase);
    expect(Math.abs(r.score! - prev.score)).toBeLessThan(TOL);
  });

  it('the default config is the master-plan method, not the Lab one', () => {
    expect(cfg.levelA.subScore.method).toBe('fixedScale');
    expect(CFG.levelA.subScore.method).toBe('zscore');
    expect(CFG.levelA.subScore.fixedScale).toBeNull();
  });
});
