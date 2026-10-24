import { describe, expect, it } from 'vitest';
import { MODEL_CONFIG_V0_3 } from '../../src/config/schema';
import {
  candlesFromCloses,
  maxDrawdown,
  realisedVolatility,
  rsi,
  sampleEvery,
  sma,
  trueRangeSeries,
} from '../../src/indicators';
import * as lab from '../../src/lab/reference';
import { metricNormalizeOptions, normalizeMetric, weightedAverage } from '../../src/normalize';
import { ARCHETYPES, HORIZONS, PROFILES, QUALITY_PILLARS } from '../../src/types';
import { coinSeries, decodeSeries, loadGolden } from './golden';

const golden = loadGolden();
const QUADRANTS = [
  'Solid and in favour',
  'Solid, out of favour',
  'In favour, thin fundamentals',
  'Weak and out of favour',
];
const TEMP_BANDS = ['Cooled off', 'Balanced', 'Heated', 'Overheated'];
const LABELS = MODEL_CONFIG_V0_3.labels.map(([, l]) => l);
const COIN_FIELDS = [
  's',
  'n',
  'sec',
  'tier',
  'chain',
  'nar',
  'price',
  'mcap',
  'rank',
  'users',
  'tvl',
  'tvl30',
  'fees30',
  'dev',
  'usageSize',
  'rev',
  'revGrowth',
  'holderShare',
  'circ',
  'unlock30',
  'unlock90',
  'unlockDays',
  'issue',
  'burn',
  'stake',
  'top10',
  'exA',
  'exB',
  'dex',
  'etp',
  'mica',
  'fiat',
  'listDelta',
  'age',
  'hackDays',
  'audits',
  'admin',
  'funding',
  'buzz',
  'buzzPrev',
  'fundPrev',
];

const isScore = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 100;

describe('golden file shape (SAMPLE_golden.v0.3.json)', () => {
  it('records provenance: Lab sha256, extraction date, format and layout', () => {
    const m = golden.meta;
    expect(m.labSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.extractedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(m.labVersion).toBe('0.3');
    expect(m.format).toBe(1);
    expect(m.horizons).toEqual([...HORIZONS]);
    expect(m.profiles).toEqual([...PROFILES]);
    expect(m.tolerance).toEqual({ points: 1, labels: 'exact' });
    expect([m.days, m.scoredDay, m.prevDay]).toEqual([1500, 1499, 1492]);
    expect(m.series).toMatchObject({
      encoding: 'base64-float64le',
      priceDays: 1500,
      volumeDays: 400,
    });
  });

  it('carries every coin input the Lab model reads, with decodable series', () => {
    const coins = golden.inputs.coins;
    expect(coins).toHaveLength(114);
    expect(new Set(coins.map((c) => c.s)).size).toBe(114);
    for (const c of coins) {
      for (const f of COIN_FIELDS) expect(c, `${c.s}.${f}`).toHaveProperty(f);
      const p = decodeSeries(c.series.p);
      const v = decodeSeries(c.series.v);
      expect(p).toHaveLength(golden.meta.series.priceDays);
      expect(v).toHaveLength(golden.meta.series.volumeDays);
      expect(p.every(Number.isFinite) && v.every(Number.isFinite)).toBe(true);
      expect(p[p.length - 1]).toBe(c.price);
    }
    expect(golden.inputs.macro).toHaveProperty('now');
    expect(golden.inputs.macro).toHaveProperty('prev');
  });

  it.each(HORIZONS)(
    '%s: every coin has Quality, Timing, quadrant, archetype and temperature band',
    (h) => {
      const out = golden.outputs.horizons[h];
      const symbols = golden.inputs.coins.map((c) => c.s);
      expect(out.rows.map((r) => r.s)).toEqual(symbols);
      for (const r of out.rows) {
        expect(isScore(r.quality), `${h} ${r.s} quality`).toBe(true);
        expect(isScore(r.timing), `${h} ${r.s} timing`).toBe(true);
        expect(QUADRANTS).toContain(r.quadrant);
        expect(ARCHETYPES).toContain(r.archetype);
        expect(TEMP_BANDS).toContain(r.temp.band);
        expect(isScore(r.temp.v)).toBe(true);
        expect(r.coverage).toBeGreaterThanOrEqual(0);
        expect(r.coverage).toBeLessThanOrEqual(1);
        // The quadrant follows from Quality and Timing at the fixed threshold 60 (D12).
        const th = MODEL_CONFIG_V0_3.quadrant.threshold;
        const q = r.quality >= th;
        const t = r.timing >= th;
        expect(r.quadrant).toBe(QUADRANTS[q ? (t ? 0 : 1) : t ? 2 : 3]);
      }
      expect(out.prev.rows.map((r) => r.s)).toEqual(symbols);
      for (const r of out.prev.rows) expect(isScore(r.quality) && isScore(r.timing)).toBe(true);
    },
  );

  it.each(HORIZONS.flatMap((h) => PROFILES.map((p) => [h, p] as const)))(
    '%s x %s: every coin has a combined score, label, flags and eligibility',
    (h, p) => {
      const scores = golden.outputs.horizons[h].scores[p];
      const rows = golden.outputs.horizons[h].rows;
      expect(scores.map((s) => s.s)).toEqual(rows.map((r) => r.s));
      const q = MODEL_CONFIG_V0_3.blendQ[h];
      scores.forEach((s, k) => {
        expect(isScore(s.score), `${s.s} score`).toBe(true);
        expect(LABELS).toContain(s.label);
        expect(s.q).toBe(q);
        expect(s.quality).toBe(rows[k]!.quality);
        expect(s.timing).toBe(rows[k]!.timing);
        // Combined = Quality x q + Timing x (1 - q); gates only ever lower it (master plan 8).
        expect(s.base).toBe(rows[k]!.quality * q + rows[k]!.timing * (1 - q));
        expect(s.score).toBeLessThanOrEqual(Math.max(0, Math.min(100, s.base)));
        if (s.cap != null) expect(s.score).toBeLessThanOrEqual(s.cap);
        for (const f of s.flags) expect(['G1', 'G2', 'G3', 'G4']).toContain(f);
        expect(typeof s.eligible).toBe('boolean');
        expect(s.eligible).toBe(s.why.length === 0);
      });
    },
  );

  it('has the market-level outputs (Level A, Level B, Bitcoin outlook)', () => {
    const m = golden.outputs.market;
    expect(['Tailwind', 'Neutral', 'Headwind']).toContain(m.weather.label);
    expect(m.weather.score).toBeGreaterThanOrEqual(-100);
    expect(m.weather.score).toBeLessThanOrEqual(100);
    expect(Object.keys(m.weather.sub).sort()).toEqual([
      'A1',
      'A2',
      'A3',
      'A4',
      'A5',
      'A6',
      'A7',
      'A8',
      'A9',
    ]);
    expect(['Alt season', 'Mixed', 'Bitcoin season']).toContain(m.cycle.phase);
    expect(m.sectors).toHaveLength(11);
    expect(m.narratives).toHaveLength(20);
    for (const g of [...m.sectors, ...m.narratives]) {
      expect(['Heating up', 'Steady', 'Cooling down']).toContain(g.phase);
      expect(isScore(g.heat)).toBe(true);
      expect(g.members.length).toBeGreaterThan(0);
    }
    expect(['Uptrend', 'Range', 'Downtrend']).toContain(m.outlook.regime);
    expect(['Rising', 'Flat', 'Falling']).toContain(m.outlook.fuelLabel);
    expect(['Low', 'Elevated', 'High']).toContain(m.outlook.fragLabel);
    expect(Object.keys(m.archetypeRates).sort()).toEqual([...ARCHETYPES].sort());
  });

  it('has signals with master-plan IDs only', () => {
    for (const h of HORIZONS) {
      for (const s of golden.outputs.horizons[h].signals)
        expect(s.id).toMatch(/^SG(1[0-4]|[1-9])$/);
    }
  });
});

describe('Lab helper ports reproduce the Lab bit for bit (raw metrics in the golden)', () => {
  const L = golden.meta.scoredDay;
  const btc = coinSeries(golden, 'BTC').p;

  it.each(HORIZONS)('%s: M6, H1-H4, R1, R2, M1, M2, M7 and beta', (h) => {
    const step = h === 'long' ? 7 : 1;
    for (const row of golden.outputs.horizons[h].rows) {
      const { p, v } = coinSeries(golden, row.s);
      const raw = row.raw as Record<string, number>;
      const ma = (k: number, i = L) => lab.sma(p, k, i)!;
      const m20 = ma(20);
      const m50 = ma(50);
      const m200 = ma(200);
      const sd = lab.sd(p, 20, L);
      const tag = `${h} ${row.s}`;
      expect(lab.adx(p, L), `${tag} M6`).toBe(raw.M6);
      expect(lab.rsi(p, L, step), `${tag} H1`).toBe(raw.H1);
      expect((p[L]! - m20) / lab.atr(p, L), `${tag} H2`).toBe(raw.H2);
      expect(p[L]! / m200, `${tag} H3`).toBe(raw.H3);
      expect((p[L]! - (m20 - 2 * sd)) / (4 * sd), `${tag} H4`).toBe(raw.H4);
      expect(lab.stdev(lab.rets(p, L, 90)) * Math.sqrt(365), `${tag} R1`).toBe(raw.R1);
      expect(lab.maxDD(p, L, 365), `${tag} R2`).toBe(raw.R2);
      const stack =
        Number(p[L]! > m20) * 20 +
        Number(p[L]! > m50) * 20 +
        Number(p[L]! > m200) * 20 +
        Number(m20 > m50) * 20 +
        Number(m50 > m200) * 20;
      expect(stack, `${tag} M1`).toBe(raw.M1);
      expect(m50 / ma(50, L - 14) - 1, `${tag} M2`).toBe(raw.M2);
      let up = 0;
      let dn = 0;
      for (let j = L - 29; j <= L; j++) {
        if (p[j]! >= p[j - 1]!) up += v[j]!;
        else dn += v[j]!;
      }
      expect(up / (dn || 1), `${tag} M7`).toBe(raw.M7);
      if (row.s !== 'BTC') {
        const rr = lab.rets(p, L, 90);
        const br = lab.rets(btc, L, 90);
        const mb = br.reduce((a, x) => a + x, 0) / 90;
        const mr = rr.reduce((a, x) => a + x, 0) / 90;
        let cov = 0;
        let vb = 0;
        for (let j = 0; j < 90; j++) {
          cov += (rr[j]! - mr) * (br[j]! - mb);
          vb += (br[j]! - mb) ** 2;
        }
        expect(cov / vb, `${tag} beta`).toBe(raw.beta);
      }
    }
  });

  it('lab.wavg and the engine weightedAverage reproduce the Lab pillar scores', () => {
    for (const h of HORIZONS) {
      for (const row of golden.outputs.horizons[h].rows) {
        if (row.hype) continue; // G5 caps Usage and drops Earnings for meme coins
        for (const pillar of QUALITY_PILLARS) {
          const ids = golden.catalogue.metrics.filter((m) => m.p === pillar).map((m) => m.id);
          const pairs = ids.map(
            (id) =>
              [row.pct[id] ?? null, MODEL_CONFIG_V0_3.metrics[id as 'U1']] as [
                number | null,
                number,
              ],
          );
          expect(lab.wavg(pairs), `${h} ${row.s} ${pillar}`).toBe(row.pillar[pillar] ?? null);
          expect(weightedAverage(pairs).value).toBe(row.pillar[pillar] ?? null);
        }
      }
    }
  });

  it('engine indicators agree with the Lab where the definitions coincide', () => {
    for (const c of golden.inputs.coins) {
      const { p } = coinSeries(golden, c.s);
      expect(sma(p, 200)).toBe(lab.sma(p, 200, L));
      expect(maxDrawdown(p, 365)).toBe(lab.maxDD(p, L, 365));
      expect(realisedVolatility(p, { returns: 'simple' })).toBe(
        lab.stdev(lab.rets(p, L, 90)) * Math.sqrt(365),
      );
      // Same Wilder recursion; the Lab keeps only 4 x 14 + 1 changes (DISCREPANCIES D-05).
      expect(rsi(p, { changes: 57 })).toBeCloseTo(lab.rsi(p, L), 9);
      expect(rsi(sampleEvery(p, 7), { changes: 57 })).toBeCloseTo(lab.rsi(p, L, 7), 9);
      // Close-only true range is |close change|; the Lab ATR is its plain mean (D-04).
      const tr = trueRangeSeries(candlesFromCloses(p));
      let s = 0;
      for (let j = L - 13; j <= L; j++) s += tr[j]!;
      expect(s / 14).toBe(lab.atr(p, L));
    }
  });
});

describe('Temperature ranges in metricSpec (H1-H6) reproduce the Lab temperature', () => {
  const H_IDS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'] as const;

  it('every golden temperature part, temp.v and band, with the default config', () => {
    const cfg = MODEL_CONFIG_V0_3;
    let compared = 0;
    for (const h of HORIZONS) {
      const rows = golden.outputs.horizons[h].rows;
      const parts = new Map<string, (number | null)[]>();
      for (const id of H_IDS) {
        const scores = normalizeMetric(
          rows.map((r) => ({ id: r.s, sector: null, value: r.raw[id] as number | null })),
          metricNormalizeOptions(cfg, id),
        );
        rows.forEach((r, k) => {
          expect(scores[k]!.score, `${h} ${r.s} ${id}`).toBe(r.temp.parts[id] ?? null);
          compared++;
        });
        parts.set(
          id,
          scores.map((s) => s.score),
        );
      }
      rows.forEach((r, k) => {
        const v = weightedAverage(
          H_IDS.map((id) => [parts.get(id)![k], cfg.metrics[id]] as const),
        ).value!;
        expect(v, `${h} ${r.s} temp.v`).toBe(r.temp.v);
        const b = cfg.tempBands;
        const band =
          v >= b.over
            ? 'Overheated'
            : v >= b.heated
              ? 'Heated'
              : v < b.cool
                ? 'Cooled off'
                : 'Balanced';
        expect(band, `${h} ${r.s} band`).toBe(r.temp.band);
      });
    }
    expect(compared).toBe(3 * 114 * 6);
  });
});
