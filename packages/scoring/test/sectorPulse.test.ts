import { describe, expect, it } from 'vitest';
import { MODEL_CONFIG_V0_3, parseModelConfig } from '../src/config/schema';
import {
  INITIAL_PHASE_STATE,
  advancePhase,
  rawPhase,
  replayPhases,
  windowPhase,
  type Phase,
  type PhaseState,
} from '../src/levelB/phase';
import {
  narrativeSeasonHeat,
  sectorPulse,
  sectorSeasonHeat,
  type PulseCoin,
  type PulseInputs,
} from '../src/levelB/sectorPulse';
import { coinSeries, loadGolden } from './oracle/golden';

const CFG = MODEL_CONFIG_V0_3;
const RULES = CFG.sector;
const HEATING: Phase = 'Heating up';
const COOLING: Phase = 'Cooling down';
const STEADY: Phase = 'Steady';

/* ----------------------------------------------------------------------------- phase.ts */

describe('rawPhase: boundaries are strict (exactly 5, 45, 70 do not trip a rule)', () => {
  it('Heating up needs a rise of MORE than 5 and Heat ABOVE 45', () => {
    expect(rawPhase(60, 54.9, RULES)).toBe(HEATING);
    expect(rawPhase(60, 55, RULES)).toBe(STEADY); // rise of exactly 5
    expect(rawPhase(46, 40, RULES)).toBe(HEATING);
    expect(rawPhase(45, 30, RULES)).toBe(STEADY); // Heat exactly 45
    expect(rawPhase(45.01, 30, RULES)).toBe(HEATING);
    expect(rawPhase(40, 30, RULES)).toBe(STEADY); // rising fast but below 45
  });

  it('Cooling down: a fall of MORE than 5, or any fall from ABOVE 70', () => {
    expect(rawPhase(50, 55.1, RULES)).toBe(COOLING);
    expect(rawPhase(50, 55, RULES)).toBe(STEADY); // fall of exactly 5
    expect(rawPhase(69, 70.5, RULES)).toBe(COOLING); // prev above 70, small fall
    expect(rawPhase(69, 70, RULES)).toBe(STEADY); // prev exactly 70
    expect(rawPhase(71, 70.5, RULES)).toBe(STEADY); // prev above 70 but rising
    expect(rawPhase(70.5, 70.5, RULES)).toBe(STEADY); // prev above 70, flat
  });

  it('a missing Heat on either day is Steady', () => {
    expect(rawPhase(null, 50, RULES)).toBe(STEADY);
    expect(rawPhase(50, undefined, RULES)).toBe(STEADY);
    expect(rawPhase(Number.NaN, 50, RULES)).toBe(STEADY);
  });

  it('follows the config values', () => {
    const r = { phaseDelta: 10, minHeat: 20, highHeat: 90 };
    expect(rawPhase(55, 46, r)).toBe(STEADY);
    expect(rawPhase(56, 45, r)).toBe(HEATING);
  });
});

describe('advancePhase: hysteresis (3 days by default, decision D20)', () => {
  const h = RULES.hysteresis;
  const steady = INITIAL_PHASE_STATE;

  it('the default is 3 days', () => expect(h).toBe(3));

  it('2 days of a new raw phase do not flip, the 3rd does', () => {
    const d1 = advancePhase(steady, HEATING, h);
    expect(d1).toEqual({ phase: STEADY, pendingPhase: HEATING, pendingDays: 1 });
    const d2 = advancePhase(d1, HEATING, h);
    expect(d2).toEqual({ phase: STEADY, pendingPhase: HEATING, pendingDays: 2 });
    const d3 = advancePhase(d2, HEATING, h);
    expect(d3).toEqual({ phase: HEATING, pendingPhase: null, pendingDays: 0 });
  });

  it('a reversal resets the counter', () => {
    const d2 = replayPhases([HEATING, HEATING], h);
    expect(d2.pendingDays).toBe(2);
    const back = advancePhase(d2, STEADY, h);
    expect(back).toEqual({ phase: STEADY, pendingPhase: null, pendingDays: 0 });
    // starting again needs three fresh days
    expect(replayPhases([HEATING, HEATING, STEADY, HEATING, HEATING], h).phase).toBe(STEADY);
    expect(replayPhases([HEATING, HEATING, STEADY, HEATING, HEATING, HEATING], h).phase).toBe(
      HEATING,
    );
  });

  it('a different pending phase restarts the count at 1', () => {
    const s = replayPhases([HEATING, HEATING, COOLING], h);
    expect(s).toEqual({ phase: STEADY, pendingPhase: COOLING, pendingDays: 1 });
  });

  it('a published phase changes back only after 3 days too', () => {
    const heating: PhaseState = { phase: HEATING, pendingPhase: null, pendingDays: 0 };
    expect(replayPhases([HEATING, HEATING, HEATING], h)).toEqual(heating);
    const two = [STEADY, STEADY].reduce<PhaseState>((st, r) => advancePhase(st, r, h), heating);
    expect(two.phase).toBe(HEATING);
    expect(advancePhase(two, STEADY, h).phase).toBe(STEADY);
  });

  it('hysteresis 5 (the D20 alternative) and 1', () => {
    expect(replayPhases(Array<Phase>(4).fill(COOLING), 5).phase).toBe(STEADY);
    expect(replayPhases(Array<Phase>(5).fill(COOLING), 5).phase).toBe(COOLING);
    expect(advancePhase(steady, HEATING, 1).phase).toBe(HEATING);
  });

  it('is pure: the input state is not changed, null starts Steady', () => {
    const before = { ...steady };
    advancePhase(steady, HEATING, h);
    expect(steady).toEqual(before);
    expect(advancePhase(null, STEADY, h)).toEqual(steady);
    expect(advancePhase(undefined, HEATING, h).pendingDays).toBe(1);
  });

  it('rejects a bad hysteresis', () => {
    expect(() => advancePhase(steady, HEATING, 0)).toThrow(RangeError);
    expect(() => advancePhase(steady, HEATING, 2.5)).toThrow(RangeError);
  });
});

describe('windowPhase (the Lab snapshot rule)', () => {
  it('all days agree -> that phase, otherwise Steady', () => {
    expect(windowPhase([HEATING, HEATING, HEATING])).toBe(HEATING);
    expect(windowPhase([HEATING, HEATING, STEADY])).toBe(STEADY);
    expect(windowPhase([COOLING, HEATING, COOLING])).toBe(STEADY);
    expect(windowPhase([])).toBe(STEADY);
  });
});

/* ------------------------------------------------------------------------ sectorPulse.ts */

const N = 120;
/** A closes series that grows by `g` per day from `start`. */
const grow = (start: number, g: number, n = N): number[] =>
  Array.from({ length: n }, (_, k) => start * (1 + g) ** k);
const flat = (v: number, n = N): number[] => Array<number>(n).fill(v);

const BTC = grow(100, 0.001);
const coin = (symbol: string, over: Partial<PulseCoin>): PulseCoin => ({
  symbol,
  sector: 'a',
  narratives: [],
  marketCap: 1e9,
  closes: grow(10, 0.001),
  volumes: flat(1e6),
  ...over,
});
const inputs = (coins: PulseCoin[], over: Partial<PulseInputs> = {}): PulseInputs => ({
  asOf: '2026-01-01',
  coins,
  btcCloses: BTC,
  sectors: [
    { id: 'a', name: 'Alpha' },
    { id: 'b', name: 'Beta' },
    { id: 'c', name: 'Gamma' },
  ],
  narratives: [{ id: 'n1', name: 'Narrative one' }],
  ...over,
});
const sec = (r: ReturnType<typeof sectorPulse>, id: string) => r.sectors.find((g) => g.id === id)!;

describe('inputs B1-B5, each ranked across the groups', () => {
  // Group a: strong, broad, rising volume, positive flow, high attention. c: the opposite.
  const strong = [1, 2, 3].map((k) =>
    coin(`A${k}`, {
      sector: 'a',
      closes: grow(10, 0.01),
      volumes: grow(1e6, 0.02),
      tvlChange30d: 40,
      feesChange30d: 20,
      attention: 30,
    }),
  );
  const mid = [1, 2, 3].map((k) =>
    coin(`B${k}`, { sector: 'b', closes: grow(10, 0.001), tvlChange30d: 5, attention: 10 }),
  );
  const weak = [1, 2, 3].map((k) =>
    coin(`C${k}`, {
      sector: 'c',
      closes: grow(10, -0.01),
      volumes: grow(1e6, -0.01),
      tvlChange30d: -30,
      feesChange30d: -10,
      attention: -5,
    }),
  );
  const r = sectorPulse(inputs([...strong, ...mid, ...weak]));
  const a = sec(r, 'a');
  const b = sec(r, 'b');
  const c = sec(r, 'c');

  it('B1 relative strength: 0.4 x 7D + 0.6 x 30D, against Bitcoin', () => {
    const ret = (g: number, k: number) => (1 + g) ** k - 1;
    const expected = (g: number) =>
      0.4 * (ret(g, 7) - ret(0.001, 7)) + 0.6 * (ret(g, 30) - ret(0.001, 30));
    expect(a.raw.B1).toBeCloseTo(expected(0.01), 12);
    expect(c.raw.B1).toBeCloseTo(expected(-0.01), 12);
    expect([a.parts.B1, b.parts.B1, c.parts.B1]).toEqual([
      (2.5 / 3) * 100,
      (1.5 / 3) * 100,
      (0.5 / 3) * 100,
    ]);
  });

  it('B1 is market-cap weighted', () => {
    const big = coin('BIG', { sector: 'a', marketCap: 9e9, closes: grow(10, 0.01) });
    const small = coin('SML', { sector: 'a', marketCap: 1e9, closes: grow(10, -0.01) });
    const g = sec(sectorPulse(inputs([big, small])), 'a');
    const eq = sec(sectorPulse(inputs([{ ...big, marketCap: 1e9 }, small])), 'a');
    expect(g.raw.r30!).toBeGreaterThan(eq.raw.r30!);
  });

  it('B2 breadth: share of coins above their 50-day average', () => {
    const up = coin('U', { sector: 'a', closes: grow(10, 0.01) });
    const down = coin('D', { sector: 'a', closes: grow(10, -0.01) });
    const g = sec(sectorPulse(inputs([up, up, up, down])), 'a');
    expect(g.raw.B2).toBe(0.75);
    // exactly at the average is not above it
    const level = coin('L', { sector: 'b', closes: flat(10) });
    expect(sec(sectorPulse(inputs([up, level])), 'b').raw.B2).toBe(0);
    expect(a.raw.B2).toBe(1);
    expect(c.raw.B2).toBe(0);
    expect(a.parts.B2).toBeGreaterThan(c.parts.B2!);
  });

  it('B3 money flow: group share of total volume, 7D average over 30D average', () => {
    const v7 = (vs: number[]) => vs.slice(-7).reduce((x, y) => x + y, 0) / 7;
    const v30 = (vs: number[]) => vs.slice(-30).reduce((x, y) => x + y, 0) / 30;
    const all = [...strong, ...mid, ...weak];
    const tv7 = all.reduce((s, x) => s + v7(x.volumes as number[]), 0);
    const tv30 = all.reduce((s, x) => s + v30(x.volumes as number[]), 0);
    const gv7 = strong.reduce((s, x) => s + v7(x.volumes as number[]), 0);
    const gv30 = strong.reduce((s, x) => s + v30(x.volumes as number[]), 0);
    expect(a.raw.B3).toBeCloseTo(gv7 / tv7 / (gv30 / tv30), 12);
    expect(a.raw.B3!).toBeGreaterThan(c.raw.B3!);
    expect(a.parts.B3).toBeGreaterThan(c.parts.B3!);
  });

  it('B4 fundamental flow: mean of the members TVL and fee changes; groups without data dropped', () => {
    expect(a.raw.B4).toBe(30); // mean(40, 20)
    expect(b.raw.B4).toBe(5); // fees missing: TVL alone
    expect(c.raw.B4).toBe(-20);
    const none = sectorPulse(
      inputs([...strong, ...mid, coin('X', { sector: 'c', closes: grow(10, -0.01) })]),
    );
    const g = sec(none, 'c');
    expect(g.raw.B4).toBeNull();
    expect(g.parts.B4).toBeNull();
  });

  it('B4 and B5 dropped from a group are reweighted, not counted as zero', () => {
    const lone = sec(
      sectorPulse(
        inputs([
          coin('X', { sector: 'c', closes: grow(10, 0.002) }),
          coin('Y', { sector: 'a', tvlChange30d: 10, attention: 5 }),
          coin('Z', { sector: 'b', tvlChange30d: -10, attention: 1 }),
        ]),
      ),
      'c',
    );
    const w = CFG.sector;
    const p = lone.parts;
    const expected = (p.B1! * w.B1 + p.B2! * w.B2 + p.B3! * w.B3) / (w.B1 + w.B2 + w.B3);
    expect(p.B4).toBeNull();
    expect(p.B5).toBeNull();
    expect(lone.heat).toBeCloseTo(expected, 12);
  });

  it('B5 attention: mean 14-day mention change', () => {
    expect(a.raw.B5).toBe(30);
    expect(c.raw.B5).toBe(-5);
    expect(a.parts.B5).toBeGreaterThan(c.parts.B5!);
  });

  it('Heat is the weighted mean of the ranks (30/20/20/20/10)', () => {
    const w = CFG.sector;
    const p = a.parts;
    const exp =
      (p.B1! * w.B1 + p.B2! * w.B2 + p.B3! * w.B3 + p.B4! * w.B4 + p.B5! * w.B5) /
      (w.B1 + w.B2 + w.B3 + w.B4 + w.B5);
    expect(a.heat).toBeCloseTo(exp, 12);
    expect(a.heat!).toBeGreaterThan(b.heat!);
    expect(b.heat!).toBeGreaterThan(c.heat!);
    for (const g of r.sectors) {
      expect(g.heat!).toBeGreaterThanOrEqual(0);
      expect(g.heat!).toBeLessThanOrEqual(100);
    }
  });

  it('is deterministic and does not change its inputs', () => {
    const coins = [...strong, ...mid, ...weak];
    const snapshot = JSON.stringify(coins);
    expect(sectorPulse(inputs(coins))).toEqual(sectorPulse(inputs(coins)));
    expect(JSON.stringify(coins)).toBe(snapshot);
  });
});

describe('groups', () => {
  it('fewer than 3 coins is flagged low confidence; 3 is not', () => {
    const coins = [
      coin('A1', { sector: 'a' }),
      coin('A2', { sector: 'a' }),
      coin('B1', { sector: 'b' }),
      coin('B2', { sector: 'b' }),
      coin('B3', { sector: 'b' }),
    ];
    const r = sectorPulse(inputs(coins));
    expect(sec(r, 'a').lowConfidence).toBe(true);
    expect(sec(r, 'b').lowConfidence).toBe(false);
    const cfg2 = parseModelConfig({
      ...structuredClone(CFG),
      levelB: { ...CFG.levelB, minMembers: 2 },
    });
    expect(sec(sectorPulse(inputs(coins), cfg2), 'a').lowConfidence).toBe(false);
  });

  it('a group with no member coin is left out', () => {
    const r = sectorPulse(inputs([coin('A1', { sector: 'a' })]));
    expect(r.sectors.map((g) => g.id)).toEqual(['a']);
    expect(r.narratives).toEqual([]);
  });

  it('a coin can sit in several narratives and counts in each', () => {
    const coins = [
      coin('A1', { sector: 'a', narratives: ['n1', 'n2'] }),
      coin('B1', { sector: 'b', narratives: ['n2'] }),
    ];
    const r = sectorPulse(
      inputs(coins, {
        narratives: [
          { id: 'n1', name: 'One' },
          { id: 'n2', name: 'Two' },
        ],
      }),
    );
    expect(r.narratives.map((g) => [g.id, g.members])).toEqual([
      ['n1', ['A1']],
      ['n2', ['A1', 'B1']],
    ]);
  });

  it('leading projects: top 3 by 30D strength among Quality >= 50 (inclusive)', () => {
    const mk = (s: string, g: number, q: number | null) =>
      coin(s, { sector: 'a', closes: grow(10, g), quality: q });
    const coins = [
      mk('Q1', 0.01, 80),
      mk('Q2', 0.02, 50), // exactly 50 qualifies
      mk('Q3', 0.005, 90),
      mk('Q4', 0.03, 49.9), // strongest but Quality below 50
      mk('Q5', 0.0001, 60),
      mk('Q6', 0.04, null), // no Quality
    ];
    const g = sec(sectorPulse(inputs(coins)), 'a');
    expect(g.leadingProjects.map((p) => p.symbol)).toEqual(['Q2', 'Q1', 'Q3']);
    const first = g.leadingProjects[0]!;
    expect(first.relativeStrength30d).toBeCloseTo(1.02 ** 30 - 1 - (1.001 ** 30 - 1), 12);
    expect(first.quality).toBe(50);
  });

  it('leading projects: fewer qualifying coins gives a shorter list; ties break by symbol', () => {
    const t = [coin('ZZ', { quality: 70 }), coin('AA', { quality: 70 })];
    expect(sec(sectorPulse(inputs(t)), 'a').leadingProjects.map((p) => p.symbol)).toEqual([
      'AA',
      'ZZ',
    ]);
    expect(sec(sectorPulse(inputs([coin('LOW', { quality: 10 })])), 'a').leadingProjects).toEqual(
      [],
    );
  });

  it('short history gives null raw values and a Steady phase, not an error', () => {
    const short = coin('S', { closes: grow(10, 0.01, 20), volumes: flat(1, 20) });
    const r = sectorPulse(inputs([short], { btcCloses: grow(100, 0.001, 20) }));
    const g = r.sectors[0]!;
    expect(g.raw.B1).toBeNull();
    expect(g.raw.B2).toBeNull();
    expect(g.heat).toBeNull();
    expect(g.phase).toBe(STEADY);
    expect(g.delta).toBeNull();
  });
});

describe('phase on a group: state machine vs snapshot', () => {
  // Group a surges over the last days while b and c stay flat: Heat rises, raw phase flips.
  const surge = (n: number, g = 0.02) => [...flat(10, N - n), ...grow(10, g, n)];
  const mkCoins = (): PulseCoin[] => [
    ...[1, 2, 3].map((k) =>
      coin(`A${k}`, {
        sector: 'a',
        closes: surge(30),
        tvlChange30d: 50,
        attention: 20,
        fundamentalPrev: -20,
        attentionPrev: 0,
      }),
    ),
    ...[1, 2, 3].map((k) =>
      coin(`B${k}`, {
        sector: 'b',
        closes: flat(10),
        tvlChange30d: 0,
        attention: 0,
        fundamentalPrev: 0,
        attentionPrev: 0,
      }),
    ),
    ...[1, 2, 3].map((k) =>
      coin(`C${k}`, {
        sector: 'c',
        closes: grow(10, -0.003),
        tvlChange30d: -5,
        attention: -3,
        fundamentalPrev: 5,
        attentionPrev: 3,
      }),
    ),
  ];

  it('without stored state the Lab window rule is used and a state is returned', () => {
    const g = sec(sectorPulse(inputs(mkCoins())), 'a');
    expect(g.phaseSource).toBe('window');
    expect(g.rawPhase).toBe(HEATING);
    expect(g.phase).toBe(HEATING);
    expect(g.delta!).toBeGreaterThan(5);
    expect(g.heat!).toBeGreaterThan(45);
    expect(g.state.phase).toBe(g.phase);
  });

  it('with stored state the machine needs 3 days', () => {
    const day1 = sectorPulse(
      inputs(mkCoins(), { previousSectorStates: { a: INITIAL_PHASE_STATE } }),
    );
    expect(sec(day1, 'a').phaseSource).toBe('state');
    expect(sec(day1, 'a').phase).toBe(STEADY);
    expect(sec(day1, 'a').state).toEqual({ phase: STEADY, pendingPhase: HEATING, pendingDays: 1 });
    const day3 = sectorPulse(
      inputs(mkCoins(), {
        previousSectorStates: { a: { phase: STEADY, pendingPhase: HEATING, pendingDays: 2 } },
      }),
    );
    expect(sec(day3, 'a').phase).toBe(HEATING);
    // a group with no stored state in the map falls back to the window rule
    expect(sec(day3, 'b').phaseSource).toBe('window');
  });

  it('phaseWeekAgo is the window phase 7 days earlier', () => {
    // 30 days of surge: a week ago it was already surging, so both agree.
    expect(sec(sectorPulse(inputs(mkCoins())), 'a').phaseWeekAgo).toBe(HEATING);
    // a surge that began 4 days ago: Heating up now, Steady a week ago.
    const neutral = { tvlChange30d: 0, attention: 0, fundamentalPrev: 0, attentionPrev: 0 };
    const late = mkCoins().map((c) => ({
      ...c,
      ...neutral,
      closes: c.sector === 'a' ? surge(4, 0.05) : c.sector === 'b' ? flat(10) : grow(10, -0.003),
    }));
    const g = sec(sectorPulse(inputs(late)), 'a');
    expect(g.rawPhase).toBe(HEATING);
    expect(g.phaseWeekAgo).toBe(STEADY);
  });
});

describe('Season exports (S2, S3)', () => {
  it('S2: Heat +10 Heating up, -10 Cooling down, kept in 0-100', () => {
    expect(sectorSeasonHeat({ heat: 50, phase: HEATING })).toBe(60);
    expect(sectorSeasonHeat({ heat: 50, phase: COOLING })).toBe(40);
    expect(sectorSeasonHeat({ heat: 50, phase: STEADY })).toBe(50);
    expect(sectorSeasonHeat({ heat: 95, phase: HEATING })).toBe(100);
    expect(sectorSeasonHeat({ heat: 4, phase: COOLING })).toBe(0);
    expect(sectorSeasonHeat({ heat: null, phase: HEATING })).toBeNull();
  });

  it('S3: average narrative Heat; the sector Heat when there is none', () => {
    expect(narrativeSeasonHeat([60, 40, null], 10)).toBe(50);
    expect(narrativeSeasonHeat([], 42)).toBe(42);
    expect(narrativeSeasonHeat([null, undefined], 42)).toBe(42);
    expect(narrativeSeasonHeat([], null)).toBeNull();
  });
});

/* ------------------------------------------------------------------------------ golden */

describe('matches the Score Lab golden (SAMPLE data, tolerance 1 point, phases exact)', () => {
  const golden = loadGolden();
  const days = golden.meta.days;
  const cat = golden.catalogue as unknown as {
    sectors: { id: string; name: string }[];
    narratives: { id: string; name: string }[];
  };
  const coins: PulseCoin[] = golden.inputs.coins.map((c) => {
    const { p, v } = coinSeries(golden, c.s);
    const vols = Array.from({ length: days }, (_, d) => v[d] ?? Number.NaN);
    return {
      symbol: c.s,
      sector: c.sec,
      narratives: c.nar,
      marketCap: c.mcap,
      closes: p,
      volumes: vols,
      tvlChange30d: c['tvl30'] as number | null,
      feesChange30d: c['fees30'] as number | null,
      fundamentalPrev: c['fundPrev'] as number | null,
      attention: c['buzz'] as number | null,
      attentionPrev: c['buzzPrev'] as number | null,
    };
  });
  const btc = coinSeries(golden, 'BTC').p;
  const result = sectorPulse({
    asOf: '2026-01-01',
    coins,
    btcCloses: btc,
    sectors: cat.sectors,
    narratives: cat.narratives,
  });

  for (const kind of ['sectors', 'narratives'] as const) {
    it(`${kind}: heat, heatPrev, delta, ranks, raw inputs and phases`, () => {
      const want = golden.outputs.market[kind];
      expect(result[kind].map((g) => g.id)).toEqual(want.map((g) => g.id));
      for (const [j, w] of want.entries()) {
        const g = result[kind][j]!;
        expect(g.members, w.id).toEqual(w.members);
        expect(g.heat!, `${w.id} heat`).toBeCloseTo(w.heat as number, 6);
        expect(g.heatPrev!, `${w.id} heatPrev`).toBeCloseTo(w.heatPrev as number, 6);
        expect(g.delta!, `${w.id} delta`).toBeCloseTo(w.delta as number, 6);
        for (const id of ['B1', 'B2', 'B3', 'B4', 'B5'] as const) {
          const wantPart = w.parts[id] as number | null;
          if (wantPart === null) expect(g.parts[id], `${w.id} ${id}`).toBeNull();
          else expect(g.parts[id]!, `${w.id} ${id}`).toBeCloseTo(wantPart, 6);
          const wantRaw = (w.raw as Record<string, number | null>)[id]!;
          if (wantRaw === null) expect(g.raw[id]).toBeNull();
          else expect(g.raw[id]!, `${w.id} raw ${id}`).toBeCloseTo(wantRaw, 9);
        }
        expect(g.phase, `${w.id} phase`).toBe(w.phase);
        expect(g.phaseWeekAgo, `${w.id} phaseWeekAgo`).toBe(w.phaseWeekAgo);
      }
    });
  }
});
