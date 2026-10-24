/**
 * Node vm sandbox for the private Score Lab v0.3 reference script (test tooling only; shared by
 * extractOracle.ts and measureImpact.ts). Never imported by src/ or by the test suite.
 *
 * The Lab's script ends with its UI code, which runs at load time, so the sandbox supplies
 * do-nothing DOM stubs. To keep the Lab honest about determinism, every clock and randomness
 * source the sandbox exposes throws when read:
 * - Math.random, and crypto.getRandomValues / crypto.randomUUID;
 * - Date.now, the no-argument `new Date()`, and `Date()` called as a function (all read the
 *   clock). `new Date(<value>)` still works, because the Lab parses fixed sample dates;
 * - performance.now.
 * The sandbox has no `process`, `require` or timers that fire, so those cannot be reached
 * either. Beyond these traps, extractOracle.ts also runs genData() twice and compares, and
 * `--check` compares a full regeneration with the committed golden byte for byte.
 */
import vm from 'node:vm';

export type Obj = Record<string, unknown>;

export interface LabCoin extends Obj {
  s: string;
  p: number[];
  v: number[];
}
export interface LabRow extends Obj {
  c: LabCoin;
  raw: Obj;
  pct: Obj;
  pillar: Obj;
  hype?: boolean;
  temp: { v: number; band: string; parts: Obj };
  coverage: number;
  quality: number;
  timingBase: number;
  tempAdj: number;
  timing: number;
  quadrant: string;
  archetype: string;
  upside: Obj;
}
export interface LabGroup extends Obj {
  id: string;
  name: string;
  members: LabCoin[];
}
export interface LabRun {
  i: number;
  horizon: string;
  market: Obj & { score: number; label: string };
  cycle: Obj & { score: number; phase: string };
  sectors: LabGroup[];
  narratives: LabGroup[];
  rows: LabRow[];
  outlook?: Obj;
  archetypeRates?: Obj;
}
export interface LabScore extends Obj {
  flags: { id: string }[];
}
export interface LabSignal extends Obj {
  id: string;
  pri: number;
  extra?: string;
}
export interface LabApi {
  genData(): LabCoin[];
  runModel(data: LabCoin[], i: number, horizon: string, cfg: Obj): LabRun;
  scoreRow(row: LabRow, horizon: string, profile: string, cfg: Obj): LabScore;
  signalsFor(row: LabRow, prevRow: LabRow, now: LabRun, prev: LabRun, cfg: Obj): LabSignal[];
  DEFAULT_CONFIG: Obj & { version: string };
  MACRO: Obj;
  SECTORS: Obj[];
  NARR: Obj[];
  DEPOSIT_SECS: string[];
  FEE_SECS: string[];
  ARCHETYPES: string[];
  PILLARS: Obj[];
  METRICS: Obj[];
  RETIRED: Obj[];
  MARKET_INPUTS: Obj[];
  SECTOR_INPUTS: Obj[];
}

/** A do-nothing DOM object: every property is another stub, calls return stubs. */
function domStub(): unknown {
  const target = function () {};
  const proxy: unknown = new Proxy(target, {
    get(_t, key) {
      if (key === Symbol.iterator) return function* () {};
      if (key === Symbol.toPrimitive) return () => '';
      if (key === 'then') return undefined;
      if (key === 'length') return 0;
      return proxy;
    },
    set: () => true,
    apply: () => proxy,
    construct: () => proxy as object,
  });
  return proxy;
}

/** Installed inside the sandbox realm before the Lab runs (see the header for the list). */
const DETERMINISM_TRAPS = `
(() => {
  const nope = (what) => () => {
    throw new Error(what + ' called: the Score Lab must be deterministic');
  };
  Math.random = nope('Math.random');
  const RealDate = Date;
  function TrappedDate(...args) {
    if (!new.target) throw new Error('Date() called: the Score Lab must be deterministic');
    if (args.length === 0) throw new Error('new Date() called: the Score Lab must be deterministic');
    return Reflect.construct(RealDate, args, new.target);
  }
  TrappedDate.prototype = RealDate.prototype;
  TrappedDate.parse = RealDate.parse;
  TrappedDate.UTC = RealDate.UTC;
  TrappedDate.now = nope('Date.now');
  globalThis.Date = TrappedDate;
  globalThis.performance = { now: nope('performance.now') };
  globalThis.crypto = { getRandomValues: nope('crypto.getRandomValues'), randomUUID: nope('crypto.randomUUID') };
})();
`;

/** Create the sandbox, install the traps and run the Lab script (including its UI bootstrap). */
export function createLabContext(source: string, filename: string): vm.Context {
  const sandbox: Obj = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    document: domStub(),
    navigator: domStub(),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: () => 0,
    addEventListener() {},
    removeEventListener() {},
    setTimeout: () => 0,
    clearTimeout() {},
    innerHeight: 800,
    innerWidth: 1280,
  };
  sandbox.window = sandbox;
  sandbox.parent = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(DETERMINISM_TRAPS, ctx, { filename: 'determinism-traps.js' });
  vm.runInContext(source, ctx, { filename });
  return ctx;
}

/** The Lab's top-level functions and constants (script-scope `const`s are reachable this way). */
export function labApi(ctx: vm.Context): LabApi {
  return vm.runInContext(
    '({ genData, runModel, scoreRow, signalsFor, DEFAULT_CONFIG, MACRO, SECTORS, NARR,' +
      ' DEPOSIT_SECS, FEE_SECS, ARCHETYPES, PILLARS, METRICS, RETIRED, MARKET_INPUTS, SECTOR_INPUTS })',
    ctx,
  ) as LabApi;
}

/** Path of the private Lab file from `--lab <path>` or SCORE_LAB_REFERENCE_PATH, if given. */
export function labPathFrom(argv: readonly string[]): string | undefined {
  const k = argv.indexOf('--lab');
  return (k >= 0 ? argv[k + 1] : undefined) ?? (process.env.SCORE_LAB_REFERENCE_PATH || undefined);
}

export const MISSING_LAB_MESSAGE =
  'no Score Lab reference file. Set SCORE_LAB_REFERENCE_PATH (or pass --lab <path>) to the ' +
  'private score-lab-v0.3.reference.js from the CoinSnipe hub mirror. Do not copy it into this repo.';
