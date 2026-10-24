/**
 * Reference ports of the Score Lab v0.3 math helpers. NOT the engine.
 *
 * Source: score-lab-v0.3.reference.js, "math helpers" (lines 396-417 of the 2026-10-23 extract;
 * identical to the script in the hub's score-lab/coinsnipe-score-lab.html). Each function is a
 * line-by-line port that keeps the Lab's floating-point operation order, so it reproduces the
 * Lab bit for bit (pinned in test/oracle/golden.test.ts against the committed golden).
 *
 * Why they ship in src/ and not only in test/: CSN-031 to CSN-038 must reproduce the Lab goldens
 * within +-1 point, and where the Lab and the master plan disagree (packages/scoring/DISCREPANCIES.md)
 * the choice sits behind the config flag `indicators.variant` ('textbook' | 'lab', common rule 7).
 * The 'lab' branch needs a runtime implementation, and keeping one copy here avoids a second,
 * drifting copy in test code. They are pure functions over arrays and contain no sample data.
 *
 * The engine's own indicators (master-plan / textbook definitions) are in ../indicators.ts.
 * Known differences between the two are listed in DISCREPANCIES.md.
 */

/** Lab `clamp(x, a, b)`. */
export const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));

/** Lab `c100(x)`: clamp to -100..100. */
export const c100 = (x: number): number => clamp(x, -100, 100);

/** Lab `sma(p, k, i)`: simple mean of p[i-k+1..i]; null when there is not enough history. */
export function sma(p: readonly number[], k: number, i: number): number | null {
  if (i - k + 1 < 0) return null;
  let s = 0;
  for (let j = i - k + 1; j <= i; j++) s += p[j]!;
  return s / k;
}

/** Lab `sd(p, k, i)`: population standard deviation of p[i-k+1..i]. */
export function sd(p: readonly number[], k: number, i: number): number {
  const m = sma(p, k, i) ?? Number.NaN;
  let s = 0;
  for (let j = i - k + 1; j <= i; j++) s += (p[j]! - m) ** 2;
  return Math.sqrt(s / k);
}

/**
 * Lab `rsi(p, i, step = 1, n = 14)`: Wilder RSI over close-to-close moves, sampled every `step`
 * bars (step 7 = the Lab's weekly candles for the Long horizon). Only the last 4 x n moves are
 * used, seeded with a simple average of the first n; returns 50 when history is too short.
 */
export function rsi(p: readonly number[], i: number, step = 1, n = 14): number {
  const start = i - step * n * 4;
  if (start < step) return 50;
  let ag = 0;
  let al = 0;
  let cnt = 0;
  for (let j = start; j <= i; j += step) {
    const d = p[j]! - p[j - step]!;
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);
    if (cnt < n) {
      ag += g / n;
      al += l / n;
    } else {
      ag = (ag * (n - 1) + g) / n;
      al = (al * (n - 1) + l) / n;
    }
    cnt++;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

/** Lab `atr(p, i, n = 14)`: simple mean of |close - previous close| over the last n bars. */
export function atr(p: readonly number[], i: number, n = 14): number {
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += Math.abs(p[j]! - p[j - 1]!);
  return s / n;
}

/**
 * Lab `adx(p, i, n = 14)`: directional movement from closes only, Wilder-style running sums
 * started at zero 3 x n bars back, ADX = simple mean of the last n DX values, signed + when
 * +DI >= -DI.
 */
export function adx(p: readonly number[], i: number, n = 14): number {
  let pdm = 0;
  let mdm = 0;
  let tr = 0;
  const dxs: { dx: number; pdi: number; mdi: number }[] = [];
  for (let j = i - n * 3; j <= i; j++) {
    const up = p[j]! - p[j - 1]!;
    const dn = -up;
    const pd = up > 0 ? up : 0;
    const md = dn > 0 ? dn : 0;
    const t = Math.abs(up) || 1e-12;
    pdm = pdm - pdm / n + pd;
    mdm = mdm - mdm / n + md;
    tr = tr - tr / n + t;
    const pdi = pdm / tr;
    const mdi = mdm / tr;
    dxs.push({ dx: (Math.abs(pdi - mdi) / (pdi + mdi || 1)) * 100, pdi, mdi });
  }
  const last = dxs.slice(-n);
  const a = last.reduce((s, x) => s + x.dx, 0) / n;
  const L = dxs[dxs.length - 1]!;
  return (L.pdi >= L.mdi ? 1 : -1) * a;
}

/** Lab `ret(p, i, k)`: simple return over k bars. */
export const ret = (p: readonly number[], i: number, k: number): number => p[i]! / p[i - k]! - 1;

/** Lab `rets(p, i, k)`: the last k simple daily returns ending at i. */
export function rets(p: readonly number[], i: number, k: number): number[] {
  const o: number[] = [];
  for (let j = i - k + 1; j <= i; j++) o.push(p[j]! / p[j - 1]! - 1);
  return o;
}

/** Lab `stdev(a)`: sample standard deviation (n - 1). */
export function stdev(a: readonly number[]): number {
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

/** Lab `maxDD(p, i, k)`: largest peak-to-trough fall (0..1) within the last k bars. */
export function maxDD(p: readonly number[], i: number, k: number): number {
  let peak = -Infinity;
  let dd = 0;
  for (let j = Math.max(0, i - k + 1); j <= i; j++) {
    peak = Math.max(peak, p[j]!);
    dd = Math.max(dd, 1 - p[j]! / peak);
  }
  return dd;
}

/** Lab `pctRank(vals, x)`: (count below + half the count equal) / n x 100. */
export function pctRank(vals: readonly number[], x: number): number {
  let lo = 0;
  let eq = 0;
  for (const v of vals) {
    if (v < x) lo++;
    else if (v === x) eq++;
  }
  return ((lo + 0.5 * eq) / vals.length) * 100;
}

/** Lab `wavg(pairs)`: weighted mean ignoring null/NaN values and zero weights; null if none. */
export function wavg(
  pairs: readonly (readonly [number | null | undefined, number | null | undefined])[],
): number | null {
  let s = 0;
  let w = 0;
  for (const [v, wt] of pairs) {
    if (v == null || Number.isNaN(v) || !wt) continue;
    s += v * wt;
    w += wt;
  }
  return w ? s / w : null;
}

/** Lab `median(a)`: the upper middle element for even lengths; null for an empty list. */
export function median(a: readonly number[]): number | null {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)]! : null;
}

/** Lab `labelOf(score, cfg)`: first label whose threshold the score reaches. */
export function labelOf(score: number, labels: readonly (readonly [number, string])[]): string {
  for (const [t, l] of labels) if (score >= t) return l;
  return 'Poor';
}
