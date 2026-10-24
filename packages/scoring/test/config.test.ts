import { describe, expect, it } from 'vitest';
import rawConfig from '../src/config/model-config.v0.3.json';
import {
  MODEL_CONFIG_V0_3,
  ModelConfigError,
  PENDING_CONFIG_KEYS,
  cloneModelConfig,
  parseModelConfig,
  safeParseModelConfig,
  statusOf,
} from '../src/config/schema';
import { MODEL_IDS, type MetricId } from '../src/types';
import { loadGolden } from './oracle/golden';
import { labCompatConfig } from './oracle/labCompat';

type Json = Record<string, unknown>;
const raw = (): Json => JSON.parse(JSON.stringify(rawConfig)) as Json;
const at = (o: Json, path: string): Json => path.split('.').reduce<Json>((x, k) => x[k] as Json, o);

/** Expect the mutated config to be rejected with a message mentioning `pattern`. */
function rejects(mutate: (c: Json) => void, pattern: RegExp): void {
  const c = raw();
  mutate(c);
  const r = safeParseModelConfig(c);
  expect(r.success).toBe(false);
  expect(() => parseModelConfig(c)).toThrow(ModelConfigError);
  expect(() => parseModelConfig(c)).toThrow(pattern);
}

describe('model-config.v0.3.json', () => {
  it('parses, carries a model_version and is frozen', () => {
    expect(MODEL_CONFIG_V0_3.model_version).toBe('0.3');
    expect(Object.isFrozen(MODEL_CONFIG_V0_3)).toBe(true);
    expect(Object.isFrozen(MODEL_CONFIG_V0_3.quality)).toBe(true);
    expect(() => {
      (MODEL_CONFIG_V0_3.quality as { U: number }).U = 99;
    }).toThrow(TypeError);
  });

  it('holds the master-plan defaults named in CSN-030', () => {
    const c = MODEL_CONFIG_V0_3;
    expect(c.quality).toEqual({ U: 30, E: 20, T: 20, L: 10, R: 20 });
    expect(c.timing).toEqual({
      short: { M: 60, S: 40 },
      medium: { M: 50, S: 50 },
      long: { M: 40, S: 60 },
    });
    expect(c.blendQ).toEqual({ short: 0.3, medium: 0.55, long: 0.8 });
    expect(c.tempAdj).toEqual({ over: -15, heated: -8, cool: 5 });
    expect(c.tempBands).toEqual({ cool: 30, heated: 65, over: 80 });
    expect(c.rocBlend.short).toEqual([0.6, 0.3, 0.1]);
    expect(c.absBlend).toEqual({ share: 0.3, span: 30, ids: ['U1', 'U2', 'U3', 'E3'] });
    expect(c.market.corrFloor).toBe(0.3);
    expect([c.market.tailwind, c.market.headwind]).toEqual([25, -25]);
    expect(c.cycle).toMatchObject({
      altIndex: 50,
      dominance: 25,
      ethBtc: 25,
      altSeason: 65,
      btcSeason: 35,
    });
    expect(c.cycle.dex).toEqual(['PAXG', 'XAUT']);
    expect(c.quadrant.threshold).toBe(60); // decision D12
    expect(c.normalization).toMatchObject({ winsorPct: [5, 95], peerMin: 8 }); // decision D16
    expect(c.sector.hysteresis).toBe(3); // decision D20
  });

  it('equals the Score Lab DEFAULT_CONFIG for every Lab key (golden labConfig)', () => {
    const labCfg = loadGolden().labConfig as Json;
    expect(MODEL_CONFIG_V0_3.model_version).toBe(labCfg.version);
    const ours = MODEL_CONFIG_V0_3 as unknown as Json;
    for (const key of Object.keys(labCfg)) {
      if (key === 'version') continue;
      if (key === 'metrics') {
        const { R3, S4, ...rest } = MODEL_CONFIG_V0_3.metrics;
        expect([R3, S4]).toEqual([0, 0]);
        expect(rest).toEqual(labCfg.metrics);
        continue;
      }
      expect(ours[key], key).toEqual(labCfg[key]);
    }
  });

  it('metric directions match the Lab catalogue except the two recorded in DISCREPANCIES D-02', () => {
    const better: Record<string, string> = { up: 'higher', down: 'lower', rule: 'fixed' };
    const differing: string[] = [];
    for (const m of loadGolden().catalogue.metrics) {
      const spec = MODEL_CONFIG_V0_3.metricSpec[m.id as MetricId]!;
      expect(spec.pillar).toBe(m.p);
      if (spec.better !== better[m.better]) differing.push(m.id);
      if (m.peer && spec.pillar !== 'S') {
        const scope = MODEL_CONFIG_V0_3.normalization.peerScope[spec.pillar as 'U'];
        expect(scope, m.id).toBe(m.peer);
      }
    }
    expect(differing.sort()).toEqual(['M1', 'R6']);
  });

  it('has a status for every master-plan ID; retired IDs are present with weight 0', () => {
    const c = MODEL_CONFIG_V0_3;
    expect(Object.keys(c.status).sort()).toEqual([...MODEL_IDS].sort());
    expect(statusOf(c, 'R3')).toBe('retired');
    expect(statusOf(c, 'S4')).toBe('retired');
    expect(c.metrics.R3).toBe(0);
    expect(c.metrics.S4).toBe(0);
    expect(statusOf(c, 'D5')).toBe('open');
    expect(statusOf(c, 'K7')).toBe('open');
    const others = Object.entries(c.status).filter(
      ([id]) => !['R3', 'S4', 'D5', 'K7'].includes(id),
    );
    expect(others.every(([, s]) => s === 'proposed')).toBe(true);
    expect(statusOf(c, 'Z9')).toBeUndefined();
    expect(loadGolden().catalogue.retired).toEqual(['R3', 'S4']);
  });

  it('cloneModelConfig gives an editable copy that still validates', () => {
    const c = cloneModelConfig();
    c.metrics.M3 = 25;
    expect(parseModelConfig(c).metrics.M3).toBe(25);
    expect(MODEL_CONFIG_V0_3.metrics.M3).toBe(20);
    expect(() => parseModelConfig(labCompatConfig())).not.toThrow();
  });
});

describe('config schema rejects bad input', () => {
  it('a negative weight', () => {
    rejects((c) => (at(c, 'quality').U = -5), /quality\.U/);
    rejects((c) => (at(c, 'metrics').U1 = -1), /metrics\.U1/);
    rejects((c) => (at(c, 'timing.short').M = -60), /timing\.short\.M/);
    rejects((c) => (at(c, 'market').A4 = -12), /market\.A4/);
    rejects((c) => (at(c, 'sector').B2 = -0.5), /sector\.B2/);
  });

  it('a weight that is not a finite number', () => {
    rejects((c) => (at(c, 'metrics').E1 = '35'), /metrics\.E1/);
    rejects((c) => (at(c, 'metrics').E1 = null), /metrics\.E1/);
  });

  it('a group whose weights are all zero', () => {
    rejects((c) => {
      for (const k of ['U', 'E', 'T', 'L', 'R']) at(c, 'quality')[k] = 0;
    }, /at least one weight/);
    rejects((c) => {
      for (const k of ['T1', 'T2', 'T3', 'T4', 'T5']) at(c, 'metrics')[k] = 0;
    }, /pillar T/);
  });

  it('unknown or missing keys, at any depth', () => {
    rejects((c) => (c.extra = 1), /Unrecognized key/);
    rejects((c) => (at(c, 'quality').X = 1), /quality/);
    rejects((c) => (at(c, 'gates.G1').hidden = 1), /Unrecognized key/);
    rejects((c) => (at(c, 'metrics').U9 = 1), /metrics/);
    rejects((c) => delete at(c, 'quality').R, /quality\.R/);
    rejects((c) => delete c.status, /status/);
    rejects((c) => delete at(c, 'status').SG14, /status\.SG14/);
  });

  it('a retired ID with a weight, or used as an input', () => {
    rejects((c) => (at(c, 'metrics').R3 = 5), /R3 is retired/);
    rejects((c) => (at(c, 'absBlend').ids = ['U1', 'S4']), /S4 is retired/);
  });

  it('an active metric without a metricSpec, or a spec in the wrong pillar', () => {
    rejects((c) => delete at(c, 'metricSpec').U2, /U2 is not retired/);
    rejects(
      (c) => (at(c, 'metricSpec').U2 = { pillar: 'E', better: 'higher' }),
      /belongs to pillar U/,
    );
    rejects((c) => (at(c, 'metricSpec').L2 = { pillar: 'L', better: 'fixed' }), /needs a range/);
    rejects(
      (c) => (at(c, 'metricSpec').U2 = { pillar: 'U', better: 'up' }),
      /metricSpec\.U2\.better/,
    );
  });

  it('inconsistent thresholds and bad enums', () => {
    rejects((c) => (at(c, 'tempBands').heated = 90), /cool <= heated <= over/);
    rejects((c) => (at(c, 'normalization').winsorPct = [95, 5]), /lower < upper/);
    rejects((c) => (at(c, 'blendQ').long = 1.2), /blendQ\.long/);
    rejects((c) => (at(c, 'status').U1 = 'maybe'), /status\.U1/);
    rejects((c) => (at(c, 'absBlend').ids = ['L2']), /must be a ranked metric/);
    rejects(
      (c) =>
        (c.labels = [
          [50, 'Mixed'],
          [80, 'Strong'],
          [0, 'Poor'],
        ]),
      /descending/,
    );
    rejects((c) => (at(c, 'profiles.safe').archetypes = ['Moonshot']), /archetypes/);
    rejects((c) => (c.model_version = 'v0.3'), /model_version/);
    rejects((c) => (at(c, 'indicators').pivotBars = 4), /pivotBars must be odd/);
  });

  it('accepts winsorPct null (no winsorising) and the lab indicator variant', () => {
    const c = raw();
    at(c, 'normalization').winsorPct = null;
    at(c, 'indicators').variant = 'lab';
    expect(parseModelConfig(c).normalization.winsorPct).toBeNull();
  });

  it('inverted thresholds: upside, outlook fuel and fragility, sector heat, levels', () => {
    rejects(
      (c) => Object.assign(at(c, 'upside'), { high: 30, low: 60 }),
      /upside low must be below high/,
    );
    rejects(
      (c) => Object.assign(at(c, 'outlook'), { fuelUp: -20, fuelDown: 20 }),
      /fuelDown must be below fuelUp/,
    );
    rejects(
      (c) => Object.assign(at(c, 'outlook'), { fragHigh: 33, fragElev: 66 }),
      /fragElev must be below fragHigh/,
    );
    rejects(
      (c) => Object.assign(at(c, 'sector'), { minHeat: 75, highHeat: 70 }),
      /minHeat must be below highHeat/,
    );
    rejects(
      (c) => Object.assign(at(c, 'levels'), { medium: 8, strong: 7 }),
      /medium must be below strong/,
    );
  });

  it('an archetype market-cap ladder out of order', () => {
    rejects(
      (c) => (at(c, 'archetypes').emergingMc = 1e11),
      /emergingMc < establishedMc < blueChipMc/,
    );
    rejects(
      (c) => (at(c, 'archetypes').establishedMc = 6e10),
      /emergingMc < establishedMc < blueChipMc/,
    );
  });

  it('an exchange listed twice', () => {
    rejects(
      (c) => (at(c, 'exchanges').tierB = ['Kraken', 'Bitget']),
      /Kraken is in both tierA and tierB/,
    );
    rejects(
      (c) => (at(c, 'exchanges').tierA = ['Binance', 'Binance']),
      /duplicate exchange Binance/,
    );
  });

  it('duplicate metric IDs in absBlend, logIds or horizonCandleIds', () => {
    rejects((c) => (at(c, 'absBlend').ids = ['U1', 'U1', 'U2']), /duplicate metric U1/);
    rejects((c) => (at(c, 'normalization').logIds = ['U5', 'U5']), /duplicate metric U5/);
    rejects((c) => (at(c, 'candles').horizonCandleIds = ['H1', 'H1']), /duplicate metric H1/);
  });

  it('a growth metric in logIds (negative growth would silently become missing)', () => {
    for (const id of ['U1', 'U2', 'U3', 'E3'])
      rejects(
        (c) => (at(c, 'normalization').logIds = ['U5', id]),
        new RegExp(`${id} is a growth metric`),
      );
    // Still rejected when the metric is taken out of the absolute blend.
    rejects((c) => {
      at(c, 'absBlend').ids = ['U2'];
      at(c, 'normalization').logIds = ['U1'];
    }, /U1 is a growth metric/);
  });
});

describe('indicators and candles: contract until a consumer wires them (PENDING_CONFIG_KEYS)', () => {
  it('lists every indicators and candles key with the task that will read it', () => {
    const keys = [
      ...Object.keys(MODEL_CONFIG_V0_3.indicators).map((k) => `indicators.${k}`),
      ...Object.keys(MODEL_CONFIG_V0_3.candles).map((k) => `candles.${k}`),
    ].sort();
    expect(Object.keys(PENDING_CONFIG_KEYS).sort()).toEqual(keys);
    for (const task of Object.values(PENDING_CONFIG_KEYS)) expect(task).toMatch(/CSN-03[1-8]/);
  });

  it('variant "lab" with a non-null rsiWarmupBars is ambiguous and rejected', () => {
    rejects((c) => {
      at(c, 'indicators').variant = 'lab';
      at(c, 'indicators').rsiWarmupBars = 57;
    }, /rsiWarmupBars applies only to variant "textbook"/);
    const ok = raw();
    at(ok, 'indicators').rsiWarmupBars = 57;
    expect(parseModelConfig(ok).indicators.rsiWarmupBars).toBe(57);
  });
});
