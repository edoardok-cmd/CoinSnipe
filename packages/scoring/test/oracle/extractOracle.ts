/**
 * Golden-oracle extractor for @coinsnipe/scoring (CSN-030). Test tooling, run by hand.
 *
 * Loads the Score Lab v0.3 reference script in a Node vm sandbox with DOM stubs, calls its
 * deterministic genData(), runModel() (scored day and 7 days earlier), scoreRow() and
 * signalsFor() for every horizon x profile (3 x 3), and writes the Lab's generated SAMPLE inputs
 * plus its outputs to test/oracle/__fixtures__/SAMPLE_golden.v0.3.json. Those goldens are the
 * acceptance check for CSN-031 to CSN-038 (+-1 point, labels exact). Tests read only the
 * committed golden and never need the Lab file.
 *
 * The Lab file is private (it comes from the CoinSnipe hub) and must NEVER be copied into this
 * repo. Point the extractor at it instead:
 *
 *   SCORE_LAB_REFERENCE_PATH=/abs/path/score-lab-v0.3.reference.js \
 *     pnpm --filter @coinsnipe/scoring oracle:extract
 *
 *   # or directly (Node 22.18+ / 24 runs TypeScript by stripping types):
 *   node packages/scoring/test/oracle/extractOracle.ts --lab /abs/path/score-lab-v0.3.reference.js
 *
 * Options:
 *   --lab <path>        Lab script (overrides SCORE_LAB_REFERENCE_PATH)
 *   --out <path>        output file (default: the committed golden)
 *   --date YYYY-MM-DD   extraction date recorded in meta (default: today, UTC)
 *   --check             regenerate in memory with the committed file's date and node version and
 *                       exit 1 unless the result is byte-identical to the committed golden
 *
 * Determinism: the Lab seeds its own generator. The sandbox (labSandbox.ts) makes every clock
 * and randomness source it exposes throw when read: Math.random, Date.now, `new Date()` with no
 * argument, `Date()` as a function, performance.now and crypto randomness, while
 * `new Date(<value>)` keeps working. genData() is run twice and compared. Non-determinism outside
 * those sources would not throw, but `--check` would still catch it as a byte difference. The
 * output is formatted with the repo's prettier config so `pnpm format:check` passes; running twice
 * yields byte-identical files.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Golden, GoldenMeta } from './golden';
import {
  MISSING_LAB_MESSAGE,
  createLabContext,
  labApi,
  type LabApi,
  type LabCoin,
  type LabGroup,
  type LabRow,
  type LabRun,
  type Obj,
} from './labSandbox.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(HERE, '__fixtures__/SAMPLE_golden.v0.3.json');
const HORIZONS = ['short', 'medium', 'long'] as const;
const PROFILES = ['safe', 'moderate', 'risky'] as const;
/** Bump when the golden's layout changes. */
const FORMAT = 1;
/**
 * Volume is stored for the last VOLUME_DAYS days only (prices are stored in full). Every
 * volume read in the Lab model looks back at most 366 days from the scored day (K2 volume
 * profile at day i - 1), and signals at most 31; 400 leaves headroom. See meta.series.note.
 */
const VOLUME_DAYS = 400;

interface Args {
  lab: string | undefined;
  out: string;
  date: string | undefined;
  check: boolean;
}

function fail(message: string): never {
  process.stderr.write(`extractOracle: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    lab: process.env.SCORE_LAB_REFERENCE_PATH || undefined,
    out: DEFAULT_OUT,
    date: undefined,
    check: false,
  };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    const value = () => argv[++k] ?? fail(`${a} needs a value`);
    if (a === '--') continue;
    else if (a === '--lab') args.lab = value();
    else if (a === '--out') args.out = resolve(value());
    else if (a === '--date') args.date = value();
    else if (a === '--check') args.check = true;
    else fail(`unknown argument ${a}`);
  }
  if (args.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(args.date))
    fail(`--date must be YYYY-MM-DD, got ${args.date}`);
  return args;
}

/** Deep copy into plain JSON values; throws on anything JSON would silently change. */
function plain(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}: ${value}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((v, k) => plain(v, `${path}[${k}]`));
  if (typeof value === 'object') {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value as Obj)) {
      if (v === undefined) continue;
      out[k] = plain(v, `${path}.${k}`);
    }
    return out;
  }
  throw new Error(`unsupported ${typeof value} at ${path}`);
}

function pick(o: Obj, keys: readonly string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

function encodeSeries(values: readonly number[], path: string): string {
  const buf = Buffer.alloc(values.length * 8);
  values.forEach((x, k) => {
    if (!Number.isFinite(x)) throw new Error(`non-finite series value at ${path}[${k}]`);
    buf.writeDoubleLE(x, k * 8);
  });
  return buf.toString('base64');
}

/** Coin fields the Lab model reads (UI-only fields such as `note` and the generator's `beta` are left out). */
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
] as const;

function projectInputs(lab: LabApi, data: LabCoin[]) {
  const days = data[0]!.p.length;
  return {
    macro: lab.MACRO,
    coins: data.map((c) => {
      // Every input field must be present (null when missing), so a later task can tell
      // "missing" from "not extracted".
      const fields: Obj = {};
      for (const k of COIN_FIELDS) fields[k] = c[k] === undefined ? null : c[k];
      return {
        ...fields,
        series: {
          p: encodeSeries(c.p, `${c.s}.p`),
          v: encodeSeries(c.v.slice(days - VOLUME_DAYS), `${c.s}.v`),
        },
      };
    }),
  };
}

const groupOut = (g: LabGroup) => ({
  ...pick(g, ['id', 'name']),
  members: g.members.map((c) => c.s),
  ...pick(g, ['heat', 'heatPrev', 'delta', 'parts', 'raw', 'phase', 'phaseWeekAgo']),
});

function projectMarket(run: LabRun) {
  return {
    weather: pick(run.market, ['score', 'label', 'sub', 'eff', 'k', 'raw']),
    cycle: run.cycle,
    sectors: run.sectors.map(groupOut),
    narratives: run.narratives.map(groupOut),
    outlook: run.outlook ?? null,
    archetypeRates: run.archetypeRates ?? null,
  };
}

const rowOut = (r: LabRow) => ({
  s: r.c.s,
  raw: r.raw,
  pct: r.pct,
  pillar: r.pillar,
  hype: r.hype === true,
  temp: r.temp,
  coverage: r.coverage,
  quality: r.quality,
  timingBase: r.timingBase,
  tempAdj: r.tempAdj,
  timing: r.timing,
  quadrant: r.quadrant,
  archetype: r.archetype,
  upside: r.upside,
});

function extract(lab: LabApi) {
  const cfgVersion = lab.DEFAULT_CONFIG.version;
  if (cfgVersion !== '0.3')
    throw new Error(`expected Lab DEFAULT_CONFIG.version 0.3, got ${cfgVersion}`);
  const data = lab.genData();
  const again = JSON.stringify(plain(projectInputs(lab, lab.genData()), 'inputs'));
  const inputs = plain(projectInputs(lab, data), 'inputs');
  if (JSON.stringify(inputs) !== again) throw new Error('genData() is not deterministic');
  const days = data[0]!.p.length;
  const L = days - 1;
  const P = L - 7;

  let market: unknown;
  let marketJson = '';
  const horizons: Obj = {};
  for (const h of HORIZONS) {
    const cfg = JSON.parse(JSON.stringify(lab.DEFAULT_CONFIG)) as Obj;
    const now = lab.runModel(data, L, h, cfg);
    const prev = lab.runModel(data, P, h, cfg);
    // Level A and B outputs do not depend on the horizon: store them once, but prove it.
    const m = plain(projectMarket(now), `${h}.market`);
    const mJson = JSON.stringify(m);
    if (market === undefined) {
      market = m;
      marketJson = mJson;
    } else if (mJson !== marketJson) {
      throw new Error(`market-level outputs differ between horizons (${h})`);
    }
    const scores: Obj = {};
    for (const pf of PROFILES) {
      scores[pf] = now.rows.map((row) => {
        const sc = lab.scoreRow(row, h, pf, cfg);
        return {
          s: row.c.s,
          ...pick(sc, ['score', 'base', 'q']),
          cap: sc.cap ?? null,
          ...pick(sc, [
            'label',
            'quality',
            'timing',
            'quadrant',
            'archetype',
            'qWeights',
            'tWeights',
          ]),
          flags: sc.flags.map((f) => f.id),
          ...pick(sc, ['eligible', 'why']),
        };
      });
    }
    const signals: Obj[] = [];
    now.rows.forEach((row, j) => {
      for (const sg of lab.signalsFor(row, prev.rows[j]!, now, prev, cfg))
        signals.push({ s: row.c.s, id: sg.id, pri: sg.pri, ...pick(sg, ['extra']) });
    });
    // Market-wide signals, exactly as the Lab's renderSignals() derives them.
    if (now.market.label !== prev.market.label)
      signals.push({ s: null, id: 'SG9', extra: `${prev.market.label} → ${now.market.label}` });
    if (now.cycle.phase !== prev.cycle.phase)
      signals.push({ s: null, id: 'SG11', extra: `${prev.cycle.phase} → ${now.cycle.phase}` });
    horizons[h] = plain(
      {
        rows: now.rows.map(rowOut),
        scores,
        prev: {
          market: pick(prev.market, ['score', 'label']),
          cycle: pick(prev.cycle, ['score', 'phase']),
          rows: prev.rows.map((r) => ({
            s: r.c.s,
            quality: r.quality,
            timing: r.timing,
            quadrant: r.quadrant,
            archetype: r.archetype,
            tempBand: r.temp.band,
            pillar: r.pillar,
          })),
        },
        signals,
      },
      h,
    );
  }

  const catalogue = plain(
    {
      sectors: lab.SECTORS.map((s) => pick(s, ['id', 'name'])),
      narratives: lab.NARR.map((s) => pick(s, ['id', 'name'])),
      depositSectors: lab.DEPOSIT_SECS,
      feeSectors: lab.FEE_SECS,
      archetypes: lab.ARCHETYPES,
      pillars: lab.PILLARS.map((p) => pick(p, ['k', 'g'])),
      metrics: lab.METRICS.map((m) => pick(m, ['id', 'p', 'better', 'peer'])),
      retired: lab.RETIRED.map((r) => r.id),
      marketInputs: lab.MARKET_INPUTS.map((m) => pick(m, ['id', 'macro'])),
      sectorInputs: lab.SECTOR_INPUTS.map((m) => pick(m, ['id'])),
    },
    'catalogue',
  );
  return {
    days,
    L,
    P,
    labConfig: plain(lab.DEFAULT_CONFIG, 'config'),
    catalogue,
    inputs,
    market,
    horizons,
  };
}

/** Format with the repo's prettier config (resolved from the committed golden's location, so a
 * different --out path still produces the same bytes). */
async function formatJson(json: string): Promise<string> {
  const prettier = await import('prettier');
  const options = await prettier.resolveConfig(DEFAULT_OUT);
  if (!options) throw new Error(`no prettier config found for ${DEFAULT_OUT}`);
  return prettier.format(json, { ...options, filepath: DEFAULT_OUT, parser: 'json' });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.lab) fail(MISSING_LAB_MESSAGE);
  const labPath = resolve(args.lab);
  if (!existsSync(labPath)) fail(`Score Lab reference file not found: ${labPath}`);
  const source = readFileSync(labPath);
  const sha256 = createHash('sha256').update(source).digest('hex');

  let committed: Golden | undefined;
  if (args.check) {
    if (!existsSync(args.out)) fail(`--check: no golden at ${args.out}`);
    committed = JSON.parse(readFileSync(args.out, 'utf8')) as Golden;
  }
  const extractedOn =
    committed?.meta.extractedOn ?? args.date ?? new Date().toISOString().slice(0, 10);
  const nodeVersion = committed?.meta.node ?? process.version;

  const lab = labApi(createLabContext(source.toString('utf8'), basename(labPath)));
  const x = extract(lab);
  const meta: GoldenMeta = {
    description:
      'Score Lab v0.3 golden outputs and the SAMPLE inputs that produced them. Every number is invented ' +
      'sample data: test fixture only, never production. Acceptance check for CSN-031 to CSN-038: ' +
      'feed inputs through the engine and match outputs within tolerance.points (labels exactly).',
    format: FORMAT,
    labFile: basename(labPath),
    labSha256: sha256,
    labBytes: source.length,
    labVersion: lab.DEFAULT_CONFIG.version,
    extractedOn,
    extractor: 'packages/scoring/test/oracle/extractOracle.ts',
    node: nodeVersion,
    days: x.days,
    scoredDay: x.L,
    prevDay: x.P,
    horizons: HORIZONS,
    profiles: PROFILES,
    tolerance: { points: 1, labels: 'exact' },
    series: {
      encoding: 'base64-float64le',
      priceDays: x.days,
      volumeDays: VOLUME_DAYS,
      note:
        'p = daily closes for all days (oldest first); v = daily volume for the last volumeDays days only ' +
        '(index 0 = day days - volumeDays). Full prices are needed by the 200-week MA (1400 days), the ' +
        'archetype base rates and the Bitcoin outlook base rates; no volume read in the Lab reaches further ' +
        'back than 366 days from the scored day.',
    },
  };
  const golden = {
    meta,
    labConfig: x.labConfig,
    catalogue: x.catalogue,
    inputs: x.inputs,
    outputs: { market: x.market, horizons: x.horizons },
  };
  const text = await formatJson(JSON.stringify(golden));

  if (args.check) {
    const onDisk = readFileSync(args.out, 'utf8');
    if (onDisk === text) {
      process.stdout.write(`golden is reproducible: ${args.out} (sha256 of Lab ${sha256})\n`);
      return;
    }
    const a = onDisk.split('\n');
    const b = text.split('\n');
    let line = 0;
    while (line < a.length && a[line] === b[line]) line++;
    process.stderr.write(
      `extractOracle --check: regenerated golden differs from ${args.out} at line ${line + 1}\n` +
        `  committed:   ${(a[line] ?? '<eof>').slice(0, 160)}\n  regenerated: ${(b[line] ?? '<eof>').slice(0, 160)}\n`,
    );
    process.exit(1);
  }
  writeFileSync(args.out, text);
  const bytes = Buffer.byteLength(text);
  process.stdout.write(
    `wrote ${args.out}\n  lab sha256 ${sha256}\n  ${bytes} bytes (${(bytes / 1048576).toFixed(2)} MiB), ` +
      `golden sha256 ${createHash('sha256').update(text).digest('hex')}\n`,
  );
}

await main();
