import { describe, expect, it } from 'vitest';
import { MODEL_CONFIG_V0_3, cloneModelConfig, parseModelConfig } from '../src/config/schema';
import {
  absoluteGrowthScore,
  fixedScaleScore,
  log10Size,
  metricNormalizeOptions,
  normalizeMetric,
  normalizeMetricFromConfig,
  percentile,
  percentRank,
  renormalisedWeights,
  weightedAverage,
  winsorBounds,
  winsorize,
  type PeerCandidate,
} from '../src/normalize';
import * as lab from '../src/lab/reference';
import type { MetricId } from '../src/types';
import { loadGolden } from './oracle/golden';
import { labCompatConfig } from './oracle/labCompat';

const coins = (sector: string, values: (number | null)[], prefix = sector): PeerCandidate[] =>
  values.map((value, k) => ({ id: `${prefix}${k}`, sector, value }));

describe('percentile and winsorising (7.1: 5th and 95th percentile)', () => {
  it('percentile interpolates linearly between closest ranks (type 7, numpy default)', () => {
    expect(percentile([4, 1, 3, 2], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 5)).toBeCloseTo(1.15, 15);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 100)).toBe(3);
    expect(() => percentile([], 50)).toThrow(RangeError);
  });

  it('winsorises at the 5th and 95th percentile', () => {
    const v = Array.from({ length: 20 }, (_, k) => k + 1);
    const b = winsorBounds(v);
    expect(b.low).toBeCloseTo(1.95, 12);
    expect(b.high).toBeCloseTo(19.05, 12);
    const w = winsorize([...v, 1000]);
    expect(Math.max(...w)).toBeLessThan(1000);
    expect(w.slice(1, 19)).toEqual(v.slice(1, 19));
  });

  it('values beyond the bounds tie with the bound value, so their ranks are averaged', () => {
    // 41 values 0..39 and 10000: the 5th percentile is exactly the 3rd value (2) and the 95th
    // exactly the 39th (38), so 0, 1, 2 tie at the bottom and 38, 39, 10000 tie at the top.
    const values = [...Array.from({ length: 40 }, (_, k) => k), 10_000];
    const c = coins('x', values);
    const plain = normalizeMetric(c, { better: 'higher', winsorPct: null });
    const wins = normalizeMetric(c, { better: 'higher' });
    expect(plain[40]!.score).toBeCloseTo((40.5 / 41) * 100, 12);
    expect(wins[40]!.score).toBeCloseTo((39.5 / 41) * 100, 12);
    expect(wins[39]!.score).toBe(wins[40]!.score);
    expect(wins[38]!.score).toBe(wins[40]!.score);
    expect(wins[37]!.score).toBe(plain[37]!.score);
    expect(wins[0]!.score).toBeCloseTo((1.5 / 41) * 100, 12);
    expect(wins[2]!.score).toBe(wins[0]!.score);
    expect(wins[10]!.score).toBe(plain[10]!.score);
  });

  it('with 20 or fewer peers winsorising changes no rank (type 7)', () => {
    // The 5th-percentile position is (n - 1) x 0.05, which stays below 1 for n <= 20: the bound
    // falls strictly between the two lowest values (and symmetrically at the top), so the
    // clipped value stays the extreme on its own and no tie forms.
    const values = [...Array.from({ length: 19 }, (_, k) => k), 10_000];
    const c = coins('x', values);
    expect(normalizeMetric(c, { better: 'higher' })).toEqual(
      normalizeMetric(c, { better: 'higher', winsorPct: null }),
    );
  });

  it('from 21 peers winsorising ties the extremes with their neighbours, so ranks change', () => {
    // n = 21: the positions are exactly 1 and 19, so the bounds are the 2nd-lowest and
    // 2nd-highest values; 0 ties with 1 and 10000 ties with 19 (4 scores change).
    const values = [...Array.from({ length: 20 }, (_, k) => k), 10_000];
    const c = coins('x', values);
    const plain = normalizeMetric(c, { better: 'higher', winsorPct: null });
    const wins = normalizeMetric(c, { better: 'higher' });
    expect(plain[20]!.score).toBeCloseTo((20.5 / 21) * 100, 12);
    expect(wins[20]!.score).toBeCloseTo((20 / 21) * 100, 12);
    expect(wins[19]!.score).toBe(wins[20]!.score);
    expect(wins[0]!.score).toBeCloseTo((1 / 21) * 100, 12);
    expect(wins[1]!.score).toBe(wins[0]!.score);
    const changed = wins.filter((s, k) => s.score !== plain[k]!.score).map((s) => s.id);
    expect(changed).toEqual(['x0', 'x1', 'x19', 'x20']);
  });
});

describe('percentile rank 0-100 with ties averaged', () => {
  it('(below + half of equal) / n x 100', () => {
    const v = [1, 2, 2, 3];
    expect(percentRank(v, 1)).toBe(12.5);
    expect(percentRank(v, 2)).toBe(50);
    expect(percentRank(v, 3)).toBe(87.5);
    expect(percentRank([5, 5, 5], 5)).toBe(50);
    expect(() => percentRank([], 1)).toThrow(RangeError);
  });

  it('equals the Lab pctRank', () => {
    const v = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5];
    for (const x of v) expect(percentRank(v, x)).toBe(lab.pctRank(v, x));
  });

  it('flips direction for lower-is-better metrics', () => {
    const c = coins('x', [10, 20, 30, 40]);
    const higher = normalizeMetric(c, { better: 'higher', winsorPct: null }).map((s) => s.score);
    const lower = normalizeMetric(c, { better: 'lower', winsorPct: null }).map((s) => s.score);
    expect(higher).toEqual([12.5, 37.5, 62.5, 87.5]);
    expect(lower).toEqual([87.5, 62.5, 37.5, 12.5]);
  });
});

describe('peer groups (7.1, decision D16)', () => {
  const others = coins('other', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  it('ranks within the sector when 8 coins there have data', () => {
    const c = [...coins('games', [100, 200, 300, 400, 500, 600, 700, 800]), ...others];
    const s = normalizeMetric(c, { better: 'higher', peerScope: 'sector', winsorPct: null });
    expect(s[0]).toMatchObject({ peerGroup: 'sector', peerCount: 8, fellBack: false, score: 6.25 });
    expect(s[7]!.score).toBe(93.75);
  });

  it('falls back to all coins when only 7 coins there have data', () => {
    const c = [...coins('games', [100, 200, 300, 400, 500, 600, 700]), ...others];
    const s = normalizeMetric(c, { better: 'higher', peerScope: 'sector', winsorPct: null });
    expect(s[0]).toMatchObject({ peerGroup: 'all', peerCount: 17, fellBack: true });
    expect(s[0]!.score).toBeCloseTo((10.5 / 17) * 100, 12);
    // The other sector has 10 coins with data and still ranks within itself.
    expect(s[7]).toMatchObject({ peerGroup: 'sector', peerCount: 10, score: 5 });
  });

  it('counts only coins with data: 8 members but one missing value means fall back', () => {
    const c = [...coins('games', [100, 200, 300, 400, 500, 600, 700, null]), ...others];
    const s = normalizeMetric(c, { better: 'higher', peerScope: 'sector', winsorPct: null });
    expect(s[0]!.fellBack).toBe(true);
    expect(s[7]).toMatchObject({ score: null, peerGroup: null });
  });

  it('peerCountIncludesSelf = false needs 8 other coins', () => {
    const c = [...coins('games', [100, 200, 300, 400, 500, 600, 700, 800]), ...others];
    const s = normalizeMetric(c, {
      better: 'higher',
      peerScope: 'sector',
      winsorPct: null,
      peerCountIncludesSelf: false,
    });
    expect(s[0]!.fellBack).toBe(true);
  });

  it('winsorises within the peer group actually used, not across all coins', () => {
    // Sector of 41: its own 95th percentile clamps the outlier into a 3-way tie. An upper bound
    // taken across all 51 coins would sit among the huge "other" values and leave it untied.
    const sector = coins('games', [...Array.from({ length: 40 }, (_, k) => k), 1_000_000]);
    const huge = coins(
      'other',
      Array.from({ length: 10 }, (_, k) => 1e7 + k),
    );
    const s = normalizeMetric([...sector, ...huge], { better: 'higher', peerScope: 'sector' });
    expect(s[40]!.score).toBeCloseTo((39.5 / 41) * 100, 12);
    expect(s[40]!.score).toBe(s[38]!.score);
  });
});

describe('absolute blend for growth metrics (U1, U2, U3, E3)', () => {
  it('maps -30% -> 0, 0 -> 50, +30% -> 100 and clamps', () => {
    expect(absoluteGrowthScore(-30)).toBe(0);
    expect(absoluteGrowthScore(0)).toBe(50);
    expect(absoluteGrowthScore(30)).toBe(100);
    expect(absoluteGrowthScore(15)).toBe(75);
    expect(absoluteGrowthScore(-45)).toBe(0);
    expect(absoluteGrowthScore(90)).toBe(100);
  });

  it('blends 70% rank with 30% absolute', () => {
    const c = coins('x', [-30, 0, 30, 60]);
    const s = normalizeMetric(c, {
      better: 'higher',
      winsorPct: null,
      absolute: { share: 0.3, span: 30 },
    }).map((x) => x.score);
    expect(s[0]).toBeCloseTo(0.7 * 12.5 + 0.3 * 0, 12);
    expect(s[1]).toBeCloseTo(0.7 * 37.5 + 0.3 * 50, 12);
    expect(s[2]).toBeCloseTo(0.7 * 62.5 + 0.3 * 100, 12);
    expect(s[3]).toBeCloseTo(0.7 * 87.5 + 0.3 * 100, 12);
  });

  it('a growing coin in a shrinking sector no longer scores as if it were growing', () => {
    const dying = normalizeMetric(coins('x', [-40, -30, -20, -10]), {
      better: 'higher',
      winsorPct: null,
      absolute: { share: 0.3, span: 30 },
    });
    expect(dying[3]!.score).toBeCloseTo(0.7 * 87.5 + 0.3 * (50 - (10 / 30) * 50), 12);
  });
});

describe('size metrics and fixed scales', () => {
  it('log10Size logs positive sizes and treats non-positive ones as missing', () => {
    expect(log10Size(1e9)).toBe(9);
    expect(log10Size(0)).toBeNull();
    expect(log10Size(-5)).toBeNull();
    expect(log10Size(null)).toBeNull();
  });

  it('log transform changes winsorising bounds but keeps rank order (U5, R4)', () => {
    const c = coins('x', [1e6, 1e7, 1e8, 1e9, 1e12]);
    const logged = normalizeMetric(c, { better: 'higher', log: true });
    const raw = normalizeMetric(c, { better: 'higher' });
    expect(logged.map((s) => s.score)).toEqual(raw.map((s) => s.score));
    const withZero = normalizeMetric(coins('x', [0, 10, 100]), { better: 'higher', log: true });
    expect(withZero[0]!.score).toBeNull();
  });

  it('fixed-scale metrics map their range to 0-100 without ranking (L2, L4, S1-S3, H2)', () => {
    expect(fixedScaleScore(70)).toBe(70);
    expect(fixedScaleScore(130)).toBe(100);
    expect(fixedScaleScore(0, [-3, 3])).toBe(50);
    expect(fixedScaleScore(-4, [-3, 3])).toBe(0);
    const s = normalizeMetric(coins('x', [35, 70, null]), { better: 'fixed' });
    expect(s.map((x) => x.score)).toEqual([35, 70, null]);
    expect(s[0]!.peerGroup).toBe('fixed');
  });
});

describe('missing metrics: drop and reweight, report coverage (G4)', () => {
  it('weightedAverage ignores nulls, renormalises and reports coverage', () => {
    const r = weightedAverage([
      [80, 25],
      [null, 20],
      [60, 20],
      [Number.NaN, 15],
      [40, 0], // weight 0 (retired): not counted at all
    ]);
    expect(r.value).toBeCloseTo((80 * 25 + 60 * 20) / 45, 12);
    expect(r.used).toBe(2);
    expect(r.expected).toBe(4);
    expect(r.coverage).toBe(0.5);
    expect(r.weightCoverage).toBeCloseTo(45 / 80, 12);
  });

  it('is null with zero coverage when nothing is available', () => {
    expect(weightedAverage([[null, 10]])).toMatchObject({ value: null, coverage: 0, used: 0 });
    expect(weightedAverage([])).toMatchObject({ value: null, coverage: 0, expected: 0 });
  });

  it('equals the Lab wavg', () => {
    const pairs: [number | null, number][] = [
      [71.2, 25],
      [null, 20],
      [33.3, 20],
      [90.1, 15],
    ];
    expect(weightedAverage(pairs).value).toBe(lab.wavg(pairs));
  });

  it('renormalisedWeights rescales what is left to 100', () => {
    const w = renormalisedWeights({ U: 30, E: 20, T: 20, L: 10, R: 20 }, (k) => k !== 'E');
    expect(w).toEqual({ U: 37.5, T: 25, L: 12.5, R: 25 });
  });
});

describe('config-driven normalisation', () => {
  it('reads peer scope, absolute blend, log and winsorising from the model config', () => {
    expect(metricNormalizeOptions(MODEL_CONFIG_V0_3, 'U1')).toEqual({
      better: 'higher',
      peerScope: 'sector',
      log: false,
      absolute: { share: 0.3, span: 30 },
      winsorPct: [5, 95],
      peerMin: 8,
      peerCountIncludesSelf: true,
    });
    expect(metricNormalizeOptions(MODEL_CONFIG_V0_3, 'R4')).toMatchObject({
      peerScope: 'all',
      log: true,
      absolute: null,
    });
    expect(metricNormalizeOptions(MODEL_CONFIG_V0_3, 'E4').better).toBe('lower');
    expect(metricNormalizeOptions(MODEL_CONFIG_V0_3, 'H2')).toMatchObject({
      better: 'fixed',
      range: [-3, 3],
    });
    expect(() => metricNormalizeOptions(MODEL_CONFIG_V0_3, 'R3')).toThrow(/R3/);
  });

  it('reproduces every Lab metric score in the golden with the Lab-compatible config', () => {
    // The Lab ranks raw values without winsorising and scores M1/R6 on their point scale
    // (DISCREPANCIES D-01, D-02); labCompatConfig undoes exactly those two choices. U5 and R4
    // are already logged in the Lab's raw values, so the log step is skipped here.
    const golden = loadGolden();
    const cfg = labCompatConfig();
    const sectorOf = new Map(golden.inputs.coins.map((c) => [c.s, c.sec]));
    const ids = golden.catalogue.metrics
      .map((m) => m.id as MetricId)
      .filter((id) => !id.startsWith('H'));
    expect(ids).toHaveLength(33);
    let compared = 0;
    for (const h of golden.meta.horizons) {
      const rows = golden.outputs.horizons[h].rows;
      for (const id of ids) {
        const candidates = rows.map((r) => ({
          id: r.s,
          sector: sectorOf.get(r.s) ?? null,
          value: r.raw[id] as number | null,
        }));
        const opts = { ...metricNormalizeOptions(cfg, id), log: false };
        const scores = normalizeMetric(candidates, opts);
        rows.forEach((r, k) => {
          expect(scores[k]!.score, `${h} ${r.s} ${id}`).toBe(r.pct[id] ?? null);
          compared++;
        });
      }
    }
    expect(compared).toBe(3 * 33 * 114);
  });

  it('in the golden sample, winsorising moves 4 coins of the 21-coin bank sector on 9 metrics (DISCREPANCIES D-01)', () => {
    const golden = loadGolden();
    const sectorOf = new Map(golden.inputs.coins.map((c) => [c.s, c.sec]));
    const rows = golden.outputs.horizons.medium.rows;
    const lc = labCompatConfig();
    const moved: Record<string, number> = {};
    for (const id of [
      'U1',
      'U2',
      'U3',
      'U4',
      'U5',
      'E1',
      'E2',
      'E3',
      'E4',
      'T1',
      'T2',
      'T3',
      'T5',
    ] as const) {
      const candidates = rows.map((r) => ({
        id: r.s,
        sector: sectorOf.get(r.s) ?? null,
        value: r.raw[id] as number | null,
      }));
      const w = normalizeMetric(candidates, {
        ...metricNormalizeOptions(MODEL_CONFIG_V0_3, id),
        log: false,
      });
      const p = normalizeMetric(candidates, { ...metricNormalizeOptions(lc, id), log: false });
      moved[id] = rows.filter(
        (r, k) =>
          sectorOf.get(r.s) === 'bank' &&
          w[k]!.peerGroup === 'sector' &&
          w[k]!.score !== p[k]!.score,
      ).length;
    }
    // Bank metrics with 21 coins with data move; those with 17-20 (U1, U2, U3, T5) do not.
    expect(moved).toEqual({
      U1: 0,
      U2: 0,
      U3: 0,
      U4: 4,
      U5: 4,
      E1: 4,
      E2: 4,
      E3: 4,
      E4: 4,
      T1: 4,
      T2: 4,
      T3: 4,
      T5: 0,
    });
  });

  it('normalizeMetricFromConfig uses the default (winsorised) config', () => {
    const sector = coins('games', [...Array.from({ length: 40 }, (_, k) => k), 1_000_000]);
    const s = normalizeMetricFromConfig(MODEL_CONFIG_V0_3, 'U4', [
      ...sector,
      ...coins('b', [1, 2]),
    ]);
    expect(s[40]!.peerGroup).toBe('sector');
    expect(s[40]!.score).toBe(s[38]!.score);
    const unwinsorised = normalizeMetric([...sector, ...coins('b', [1, 2])], {
      ...metricNormalizeOptions(MODEL_CONFIG_V0_3, 'U4'),
      winsorPct: null,
    });
    expect(unwinsorised[40]!.score).not.toBe(unwinsorised[38]!.score);
  });

  it('changing a number in the config changes the output with no code edit (R-F5)', () => {
    const c = coins('x', [-20, 0, 10, 25]);
    const before = normalizeMetricFromConfig(MODEL_CONFIG_V0_3, 'U1', c).map((s) => s.score);
    const edited = cloneModelConfig();
    edited.absBlend.share = 0.5;
    const after = normalizeMetricFromConfig(parseModelConfig(edited), 'U1', c).map((s) => s.score);
    expect(after).not.toEqual(before);
    expect(after[3]).toBeCloseTo(0.5 * 87.5 + 0.5 * absoluteGrowthScore(25), 12);
    edited.metricSpec.U1 = { pillar: 'U', better: 'lower' };
    const flipped = normalizeMetricFromConfig(parseModelConfig(edited), 'U1', c);
    expect(flipped[0]!.score).toBeGreaterThan(flipped[3]!.score!);
  });
});
