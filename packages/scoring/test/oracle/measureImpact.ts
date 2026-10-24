/**
 * Re-measures the impact figures in packages/scoring/DISCREPANCIES.md (test tooling, run by hand;
 * not part of `pnpm test`).
 *
 * For each Lab-vs-engine difference it patches that one Lab function inside the vm sandbox with
 * the engine's definition (textbook formula on the Lab's close-only data), re-runs the Lab model
 * for all 3 horizons x 3 profiles, and prints how far Quality, Timing and the combined score move
 * against the unpatched Lab, plus label, quadrant and Temperature-band changes. It needs only the
 * private Lab file, and writes nothing:
 *
 *   SCORE_LAB_REFERENCE_PATH=/abs/path/score-lab-v0.3.reference.js \
 *     pnpm --filter @coinsnipe/scoring oracle:impact
 *
 * The patches are small JavaScript re-statements of the engine's rules, so they run inside the
 * Lab's own pipeline (the engine has no Level C pipeline yet). If they drift from src/, the
 * figures drift too: update both together.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import vm from 'node:vm';
import { MISSING_LAB_MESSAGE, createLabContext, labPathFrom } from './labSandbox.ts';

const HORIZONS = ['short', 'medium', 'long'] as const;
const PROFILES = ['safe', 'moderate', 'risky'] as const;

/** Each patch reassigns one Lab helper (or catalogue entry) inside the sandbox. */
const PATCHES: Record<string, { id: string; code: string }> = {
  winsor: {
    id: 'D-01 winsorising at 5th/95th percentile (type 7), Level C ranking only',
    code: `{ const orig = pctRank;
      const pct = (s, q) => { const h = (s.length - 1) * q / 100, lo = Math.floor(h), f = h - lo;
        return f === 0 ? s[lo] : s[lo] + f * (s[lo + 1] - s[lo]); };
      pctRank = function (vals, x) {
        if (new Error().stack.includes('heatSet')) return orig(vals, x); // Level B: not winsorised
        const s = vals.slice().sort((a, b) => a - b), lo = pct(s, 5), hi = pct(s, 95);
        const c = (v) => Math.max(lo, Math.min(hi, v));
        return orig(vals.map(c), c(x)); }; }`,
  },
  rankM1R6: {
    id: 'D-02 M1 and R6 ranked across all coins',
    code: `METRICS.find((m) => m.id === 'M1').better = 'up'; METRICS.find((m) => m.id === 'R6').better = 'up';`,
  },
  adxWilder: {
    id: 'D-03 textbook Wilder ADX, full history',
    code: `adx = function (p, i, n = 14) { let t = 0, pp = 0, mm = 0, pdi = 0, mdi = 0; const dx = [];
      for (let k = 1; k <= i; k++) { const d = p[k] - p[k - 1], tr = Math.abs(d), pd = d > 0 ? d : 0, md = d < 0 ? -d : 0;
        if (k <= n) { t += tr; pp += pd; mm += md; if (k < n) continue; }
        else { t = t - t / n + tr; pp = pp - pp / n + pd; mm = mm - mm / n + md; }
        pdi = t ? 100 * pp / t : 0; mdi = t ? 100 * mm / t : 0;
        dx.push(pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0); }
      let a = dx.slice(0, n).reduce((s, x) => s + x, 0) / n;
      for (let k = n; k < dx.length; k++) a = (a * (n - 1) + dx[k]) / n;
      return (pdi >= mdi ? 1 : -1) * a; };`,
  },
  atrWilder: {
    id: 'D-04 Wilder ATR (true range = |close change| on close-only data), full history',
    code: `atr = function (p, i, n = 14) { let s = 0; for (let k = 1; k <= n; k++) s += Math.abs(p[k] - p[k - 1]);
      let a = s / n; for (let k = n + 1; k <= i; k++) a = (a * (n - 1) + Math.abs(p[k] - p[k - 1])) / n; return a; };`,
  },
  rsiFull: {
    id: 'D-05 Wilder RSI over the full history',
    code: `rsi = function (p, i, step = 1, n = 14) { const c = []; for (let j = i; j >= 0; j -= step) c.unshift(p[j]);
      if (c.length <= n) return 50; let g = 0, l = 0;
      for (let k = 1; k <= n; k++) { const d = c[k] - c[k - 1]; if (d > 0) g += d; else l -= d; }
      let ag = g / n, al = l / n;
      for (let k = n + 1; k < c.length; k++) { const d = c[k] - c[k - 1]; ag = (ag * (n - 1) + Math.max(d, 0)) / n; al = (al * (n - 1) + Math.max(-d, 0)) / n; }
      return al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al); };`,
  },
  logReturns: {
    id: 'D-06 log returns for R1 and beta',
    code: `rets = function (p, i, k) { const o = []; for (let j = i - k + 1; j <= i; j++) o.push(Math.log(p[j] / p[j - 1])); return o; };`,
  },
};

interface RowOut {
  q: number;
  t: number;
  quad: string;
  band: string;
  arch: string;
  raw: Record<string, number>;
}
interface HorizonOut {
  rows: RowOut[];
  levels: string;
  scores: Record<string, { score: number; label: string }[]>;
}

const RUN = `(() => {
  const d = genData(), L = d[0].p.length - 1, out = {};
  for (const h of ${JSON.stringify(HORIZONS)}) {
    const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    const now = runModel(d, L, h, cfg);
    const lv = now.outlook.levels;
    out[h] = {
      rows: now.rows.map((r) => ({ q: r.quality, t: r.timing, quad: r.quadrant, band: r.temp.band, arch: r.archetype,
        raw: { M6: r.raw.M6, H1: r.raw.H1, H2: r.raw.H2, R1: r.raw.R1, beta: r.raw.beta } })),
      levels: JSON.stringify([lv.supports, lv.resist].map((zs) => zs.map((z) => [z.lo, z.hi, z.strength]))),
      scores: {} };
    for (const pf of ${JSON.stringify(PROFILES)})
      out[h].scores[pf] = now.rows.map((r) => { const s = scoreRow(r, h, pf, cfg); return { score: s.score, label: s.label }; });
  }
  return JSON.stringify(out); })()`;

function run(source: string, filename: string, patch?: string): Record<string, HorizonOut> {
  const ctx = createLabContext(source, filename);
  if (patch) vm.runInContext(patch, ctx);
  return JSON.parse(vm.runInContext(RUN, ctx) as string) as Record<string, HorizonOut>;
}

const f2 = (x: number) => x.toFixed(2);

function main(): void {
  const labArg = labPathFrom(process.argv.slice(2));
  if (!labArg) {
    process.stderr.write(`measureImpact: ${MISSING_LAB_MESSAGE}\n`);
    process.exit(2);
  }
  const labPath = resolve(labArg);
  if (!existsSync(labPath)) {
    process.stderr.write(`measureImpact: Score Lab reference file not found: ${labPath}\n`);
    process.exit(2);
  }
  const source = readFileSync(labPath, 'utf8');
  const name = basename(labPath);
  const base = run(source, name);
  const patched: Record<string, Record<string, HorizonOut>> = {};
  for (const [key, p] of Object.entries(PATCHES)) patched[key] = run(source, name, p.code);
  patched.all = run(
    source,
    name,
    Object.values(PATCHES)
      .map((p) => p.code)
      .join('\n'),
  );

  for (const [key, r] of Object.entries(patched)) {
    process.stdout.write(`== ${key}: ${PATCHES[key]?.id ?? 'all of the above together'}\n`);
    for (const h of HORIZONS) {
      const B = base[h]!;
      const R = r[h]!;
      let mq = 0, mt = 0, nq = 0, nt = 0, quad = 0, band = 0, arch = 0; // prettier-ignore
      B.rows.forEach((b, k) => {
        const x = R.rows[k]!;
        const dq = Math.abs(x.q - b.q);
        const dt = Math.abs(x.t - b.t);
        mq = Math.max(mq, dq);
        mt = Math.max(mt, dt);
        if (dq > 1) nq++;
        if (dt > 1) nt++;
        if (x.quad !== b.quad) quad++;
        if (x.band !== b.band) band++;
        if (x.arch !== b.arch) arch++;
      });
      const pf = PROFILES.map((p) => {
        let ms = 0, ns = 0, lab = 0; // prettier-ignore
        B.scores[p]!.forEach((b, k) => {
          const x = R.scores[p]![k]!;
          const d = Math.abs(x.score - b.score);
          ms = Math.max(ms, d);
          if (d > 1) ns++;
          if (x.label !== b.label) lab++;
        });
        return `${p}: max|dScore| ${f2(ms)}, >1pt ${ns}, label flips ${lab}`;
      });
      process.stdout.write(
        `  ${h}: Quality max|d| ${f2(mq)} (>1pt ${nq}); Timing max|d| ${f2(mt)} (>1pt ${nt}); ` +
          `quadrant flips ${quad}; temp band flips ${band}; archetype flips ${arch}; ` +
          `BTC levels changed ${B.levels !== R.levels}\n    ${pf.join('; ')}\n`,
      );
    }
  }
  process.stdout.write('== raw indicator differences (medium and long horizon)\n');
  for (const [key, field] of [
    ['atrWilder', 'H2'],
    ['adxWilder', 'M6'],
    ['rsiFull', 'H1'],
    ['logReturns', 'R1'],
    ['logReturns', 'beta'],
  ] as const) {
    for (const h of ['medium', 'long'] as const) {
      const B = base[h]!.rows;
      const R = patched[key]![h]!.rows;
      const d = B.map((b, k) => Math.abs(R[k]!.raw[field]! - b.raw[field]!)).sort((a, b) => a - b);
      const rel = B.map(
        (b, k) =>
          Math.abs(R[k]!.raw[field]! - b.raw[field]!) / Math.max(1e-12, Math.abs(b.raw[field]!)),
      ).sort((a, b) => a - b);
      const mid = d.length >> 1;
      process.stdout.write(
        `  ${field} under ${key} (${h}): median |d| ${d[mid]!.toPrecision(3)}, max |d| ${d[d.length - 1]!.toPrecision(3)}, ` +
          `median rel ${(rel[mid]! * 100).toFixed(1)}%, max rel ${(rel[rel.length - 1]! * 100).toFixed(1)}%\n`,
      );
    }
  }
}

main();
