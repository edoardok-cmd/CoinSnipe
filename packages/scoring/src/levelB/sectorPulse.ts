/**
 * Level B: sector pulse and narrative heat, 0-100 (master plan section 6, inputs B1-B5).
 *
 * The same method scores the 11 sectors and the 20 narratives (a narrative uses its member
 * coins; a coin can be in several). Each input is ranked across the groups 0-100 (percentile
 * rank, ties averaged) and the ranks are weighted by config `sector` into Heat:
 *
 *   B1 Relative strength (30): market-cap-weighted group return minus Bitcoin's, 7D x 40% + 30D x 60%.
 *   B2 Breadth (20): share of the group's coins above their 50-day average.
 *   B3 Money flow (20): the group's share of all crypto volume, 7D average over 30D average.
 *   B4 Fundamental flow (20): mean of the members' TVL and fee 30D changes; a group with none
 *      is dropped from this input and the weights rescale.
 *   B5 Attention (10): mean news and social mention change over 14 days (CSN-025).
 *
 * Phase: Heat today against Heat 14 days earlier, see ./phase.ts. A group with fewer than
 * `levelB.minMembers` coins is flagged `lowConfidence`. Every group lists its leading projects
 * (top 3 by 30D strength against Bitcoin among coins with Quality >= 50).
 *
 * Pure and deterministic: no clock, no network, no I/O. All series are aligned bar for bar and
 * end on the scoring day. B4 and B5 are snapshots, as in the Lab: `fundamentalPrev` and
 * `attentionPrev` carry the same measures as they stood 14 days earlier. The names and numbers
 * it returns describe data only; they never advise.
 */
import { MODEL_CONFIG_V0_3, type ModelConfig } from '../config/schema';
import { percentRank } from '../normalize';
import type { SectorInputId } from '../types';
import { SECTOR_IDS } from '../types';
import { advancePhase, rawPhase, windowPhase, type Phase, type PhaseState } from './phase';

/* ------------------------------------------------------------------------------- inputs */

/** One tracked coin as Level B sees it. */
export interface PulseCoin {
  readonly symbol: string;
  /** Sector id (11 sectors); one per coin. */
  readonly sector?: string | null;
  /** Narrative ids (20 narratives); a coin can be in several, or none. */
  readonly narratives?: readonly string[] | null;
  /** Market cap on the scoring day (the last close), in any one currency. */
  readonly marketCap?: number | null;
  /** Daily closes, oldest first, the last being the scoring day. Aligned with `btcCloses`. */
  readonly closes?: readonly number[] | null;
  /** Daily volumes in one currency, same length and alignment as `closes`. */
  readonly volumes?: readonly number[] | null;
  /** TVL and fee 30-day changes, in percent, as of today (B4). Null when the coin has none. */
  readonly tvlChange30d?: number | null;
  readonly feesChange30d?: number | null;
  /** The B4 measure as it stood 14 days earlier. */
  readonly fundamentalPrev?: number | null;
  /** News and social mention change over 14 days, today and 14 days earlier (B5). */
  readonly attention?: number | null;
  readonly attentionPrev?: number | null;
  /** Level C Quality, 0-100, for the leading-projects rule. */
  readonly quality?: number | null;
}

/** A sector or narrative definition. */
export interface GroupDef {
  readonly id: string;
  readonly name: string;
}

export interface PulseInputs {
  /** The scoring day, 'YYYY-MM-DD'. Passed through; nothing is read from a clock. */
  readonly asOf: string;
  readonly coins: readonly PulseCoin[];
  /** Bitcoin daily closes, aligned with every coin's `closes`. */
  readonly btcCloses: readonly number[];
  readonly sectors: readonly GroupDef[];
  readonly narratives: readonly GroupDef[];
  /** Stored phase state per group id from the previous day (CSN-039); omit on the first run. */
  readonly previousSectorStates?: Readonly<Record<string, PhaseState>> | null;
  readonly previousNarrativeStates?: Readonly<Record<string, PhaseState>> | null;
}

/* ------------------------------------------------------------------------------- outputs */

export const SECTOR_INPUT_NAMES: Readonly<Record<SectorInputId, string>> = {
  B1: 'Relative strength',
  B2: 'Breadth',
  B3: 'Money flow',
  B4: 'Fundamental flow',
  B5: 'Attention',
};

/** The raw numbers behind a group's input ranks on one day (null = not measurable). */
export interface GroupRaw {
  /** B1 raw: 0.4 x r7 + 0.6 x r30 (fractions, against Bitcoin). */
  readonly B1: number | null;
  readonly B2: number | null;
  readonly B3: number | null;
  readonly B4: number | null;
  readonly B5: number | null;
  readonly r7: number | null;
  readonly r30: number | null;
  readonly v7: number | null;
  readonly v30: number | null;
}

export interface GroupDay {
  readonly raw: GroupRaw;
  /** Each input ranked 0-100 across the groups; null when the group has no value for it. */
  readonly parts: Readonly<Record<SectorInputId, number | null>>;
  /** Weighted Heat 0-100; null when no input could be ranked. */
  readonly heat: number | null;
}

export interface LeadingProject {
  readonly symbol: string;
  /** 30-day return minus Bitcoin's, as a fraction. */
  readonly relativeStrength30d: number;
  readonly quality: number;
}

export interface GroupPulse {
  readonly id: string;
  readonly name: string;
  readonly members: readonly string[];
  /** Fewer than `levelB.minMembers` coins: read it with care. */
  readonly lowConfidence: boolean;
  readonly heat: number | null;
  /** Heat 14 days earlier. */
  readonly heatPrev: number | null;
  readonly delta: number | null;
  readonly parts: Readonly<Record<SectorInputId, number | null>>;
  readonly raw: GroupRaw;
  /** Today's same-day phase, before hysteresis. */
  readonly rawPhase: Phase;
  /**
   * The published phase. With a stored previous state it is the hysteresis state machine's
   * result (`phaseSource` 'state'); without one it is the Lab's snapshot rule, the last
   * `hysteresis` raw phases agreeing (`phaseSource` 'window').
   */
  readonly phase: Phase;
  readonly phaseSource: 'state' | 'window';
  /** The state to persist for tomorrow. */
  readonly state: PhaseState;
  /** The published phase 7 days earlier (window rule). */
  readonly phaseWeekAgo: Phase;
  readonly leadingProjects: readonly LeadingProject[];
}

export interface PulseResult {
  readonly asOf: string;
  readonly sectors: readonly GroupPulse[];
  readonly narratives: readonly GroupPulse[];
}

/* ------------------------------------------------------------------------------- helpers */

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Weighted mean ignoring null values and zero weights; null when nothing is left. */
function wavg(pairs: readonly (readonly [number | null | undefined, number])[]): number | null {
  let s = 0;
  let w = 0;
  for (const [v, wt] of pairs) {
    if (!fin(v) || !wt) continue;
    s += v * wt;
    w += wt;
  }
  return w ? s / w : null;
}

/** Return over k bars ending at i: p[i] / p[i-k] - 1; null when not computable. */
function ret(p: readonly number[], i: number, k: number): number | null {
  if (i - k < 0 || i >= p.length) return null;
  const a = p[i];
  const b = p[i - k];
  if (!fin(a) || !fin(b) || b <= 0) return null;
  return a / b - 1;
}

/** Mean of p[i-k+1..i]; null when the history is too short or has a gap. */
function mean(p: readonly number[], k: number, i: number): number | null {
  if (i - k + 1 < 0 || i >= p.length) return null;
  let s = 0;
  for (let j = i - k + 1; j <= i; j++) {
    const x = p[j];
    if (!fin(x)) return null;
    s += x;
  }
  return s / k;
}

/** Market cap on day i, scaled from the last day's cap by the price path (the Lab's mcapAt). */
function mcapAt(c: PulseCoin, i: number): number {
  const p = c.closes;
  if (!p || !fin(c.marketCap) || c.marketCap <= 0) return 0;
  const last = p[p.length - 1];
  const at = p[i];
  if (!fin(last) || last <= 0 || !fin(at)) return 0;
  return (c.marketCap * at) / last;
}

/** Average daily volume over k bars ending at i; null when there is no complete window. */
const avgVolume = (c: PulseCoin, k: number, i: number): number | null =>
  c.volumes ? mean(c.volumes, k, i) : null;

const emptyRaw: GroupRaw = {
  B1: null,
  B2: null,
  B3: null,
  B4: null,
  B5: null,
  r7: null,
  r30: null,
  v7: null,
  v30: null,
};

/* ------------------------------------------------------------------------------- engine */

type LevelB = ModelConfig['levelB'];

/** Raw B1-B5 numbers for one group on day `i`. `useNow` picks today's or the 14-day-old B4/B5. */
function groupRaw(
  members: readonly PulseCoin[],
  btc: readonly number[],
  i: number,
  useNow: boolean,
  totals: { readonly v7: number | null; readonly v30: number | null },
  lb: LevelB,
): GroupRaw {
  const { short, long } = lb.returnDays;
  const btcShort = ret(btc, i, short);
  const btcLong = ret(btc, i, long);

  const weighted = (k: number, btcRet: number | null): number | null => {
    if (btcRet === null) return null;
    const rows: { r: number; w: number }[] = [];
    for (const c of members) {
      const r = c.closes ? ret(c.closes, i, k) : null;
      if (r !== null) rows.push({ r, w: mcapAt(c, i) });
    }
    if (rows.length === 0) return null;
    let W = rows.reduce((a, x) => a + x.w, 0);
    // No usable caps: fall back to an equal-weighted mean rather than inventing a weight.
    if (W <= 0) {
      for (const x of rows) x.w = 1;
      W = rows.length;
    }
    return rows.reduce((s, x) => s + x.r * x.w, 0) / W - btcRet;
  };
  const r7 = weighted(short, btcShort);
  const r30 = weighted(long, btcLong);
  // Both windows are needed: dropping one would silently change what B1 measures.
  const B1 =
    r7 === null || r30 === null
      ? null
      : (r7 * lb.returnWeights.short + r30 * lb.returnWeights.long) /
        (lb.returnWeights.short + lb.returnWeights.long);

  const above: boolean[] = [];
  for (const c of members) {
    const ma = c.closes ? mean(c.closes, lb.breadthMaDays, i) : null;
    const px = c.closes?.[i];
    if (ma !== null && fin(px)) above.push(px > ma);
  }
  const B2 = above.length ? above.filter(Boolean).length / above.length : null;

  let v7: number | null = null;
  let v30: number | null = null;
  for (const c of members) {
    const a = avgVolume(c, lb.volumeDays.short, i);
    const b = avgVolume(c, lb.volumeDays.long, i);
    if (a !== null) v7 = (v7 ?? 0) + a;
    if (b !== null) v30 = (v30 ?? 0) + b;
  }
  const B3 =
    v7 !== null &&
    v30 !== null &&
    v30 > 0 &&
    fin(totals.v7) &&
    fin(totals.v30) &&
    totals.v7 > 0 &&
    totals.v30 > 0
      ? v7 / totals.v7 / (v30 / totals.v30)
      : null;

  const flows = members
    .map((c) =>
      useNow
        ? wavg([
            [c.tvlChange30d, 1],
            [c.feesChange30d, 1],
          ])
        : fin(c.fundamentalPrev)
          ? c.fundamentalPrev
          : null,
    )
    .filter(fin);
  const B4 = flows.length ? flows.reduce((a, b) => a + b, 0) / flows.length : null;

  const buzz = members.map((c) => (useNow ? c.attention : c.attentionPrev)).filter(fin);
  const B5 = buzz.length ? buzz.reduce((a, b) => a + b, 0) / buzz.length : null;

  return { B1, B2, B3, B4, B5, r7, r30, v7, v30 };
}

/** Rank every group's inputs across the groups and weight them into Heat (the Lab's heatSet). */
function heatSet(
  groups: readonly (readonly PulseCoin[])[],
  all: readonly PulseCoin[],
  btc: readonly number[],
  i: number,
  useNow: boolean,
  cfg: ModelConfig,
): GroupDay[] {
  const lb = cfg.levelB;
  let tv7: number | null = null;
  let tv30: number | null = null;
  for (const c of all) {
    const a = avgVolume(c, lb.volumeDays.short, i);
    const b = avgVolume(c, lb.volumeDays.long, i);
    if (a !== null) tv7 = (tv7 ?? 0) + a;
    if (b !== null) tv30 = (tv30 ?? 0) + b;
  }
  const raws = groups.map((m) => groupRaw(m, btc, i, useNow, { v7: tv7, v30: tv30 }, lb));
  const ranks = {} as Record<SectorInputId, (number | null)[]>;
  for (const id of SECTOR_IDS) {
    const vals = raws.map((r) => r[id]).filter(fin);
    ranks[id] = raws.map((r) => (fin(r[id]) ? percentRank(vals, r[id]) : null));
  }
  return raws.map((raw, j) => {
    const parts = {} as Record<SectorInputId, number | null>;
    for (const id of SECTOR_IDS) parts[id] = ranks[id][j]!;
    return { raw, parts, heat: wavg(SECTOR_IDS.map((id) => [parts[id], cfg.sector[id]] as const)) };
  });
}

/** Top `count` members by 30D strength against Bitcoin among those with Quality >= minQuality. */
function leadingProjects(
  members: readonly PulseCoin[],
  btc: readonly number[],
  i: number,
  lb: LevelB,
): LeadingProject[] {
  const btc30 = ret(btc, i, lb.returnDays.long);
  if (btc30 === null) return [];
  const out: LeadingProject[] = [];
  for (const c of members) {
    if (!fin(c.quality) || c.quality < lb.leaders.minQuality) continue;
    const r = c.closes ? ret(c.closes, i, lb.returnDays.long) : null;
    if (r === null) continue;
    out.push({ symbol: c.symbol, relativeStrength30d: r - btc30, quality: c.quality });
  }
  out.sort(
    (a, b) =>
      b.relativeStrength30d - a.relativeStrength30d ||
      (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
  );
  return out.slice(0, lb.leaders.count);
}

function runGroups(
  defs: readonly GroupDef[],
  keyOf: (c: PulseCoin, id: string) => boolean,
  coins: readonly PulseCoin[],
  btc: readonly number[],
  states: Readonly<Record<string, PhaseState>> | null | undefined,
  cfg: ModelConfig,
): GroupPulse[] {
  const i = btc.length - 1;
  const h = cfg.sector.hysteresis;
  const slope = cfg.levelB.slopeDays;
  const kept = defs
    .map((d) => ({ def: d, members: coins.filter((c) => keyOf(c, d.id)) }))
    .filter((g) => g.members.length > 0);
  const sets = kept.map((g) => g.members);

  // Today's set and the set `slope` days earlier, for the last h days (hysteresis window) and
  // for the same window a week earlier (phaseWeekAgo).
  const at = (d: number, useNow: boolean) => heatSet(sets, coins, btc, i - d, useNow, cfg);
  const nowSets: GroupDay[][] = [];
  const prevSets: GroupDay[][] = [];
  for (let d = 0; d < h; d++) {
    nowSets.push(at(d, true));
    prevSets.push(at(d + slope, false));
  }
  const oldNow: GroupDay[][] = [];
  const oldPrev: GroupDay[][] = [];
  for (let d = 7; d < 7 + h; d++) {
    oldNow.push(at(d, true));
    oldPrev.push(at(d + slope, false));
  }

  return kept.map((g, j) => {
    const raws = nowSets.map((s, d) => rawPhase(s[j]!.heat, prevSets[d]![j]!.heat, cfg.sector));
    const oraw = oldNow.map((s, d) => rawPhase(s[j]!.heat, oldPrev[d]![j]!.heat, cfg.sector));
    const today = raws[0]!;
    const prior = states?.[g.def.id] ?? null;
    const state = prior
      ? advancePhase(prior, today, h)
      : { phase: windowPhase(raws), pendingPhase: null, pendingDays: 0 };
    const heat = nowSets[0]![j]!.heat;
    const heatPrev = prevSets[0]![j]!.heat;
    return {
      id: g.def.id,
      name: g.def.name,
      members: g.members.map((c) => c.symbol),
      lowConfidence: g.members.length < cfg.levelB.minMembers,
      heat,
      heatPrev,
      delta: heat !== null && heatPrev !== null ? heat - heatPrev : null,
      parts: nowSets[0]![j]!.parts,
      raw: nowSets[0]![j]!.raw ?? emptyRaw,
      rawPhase: today,
      phase: state.phase,
      phaseSource: prior ? ('state' as const) : ('window' as const),
      state,
      phaseWeekAgo: windowPhase(oraw),
      leadingProjects: leadingProjects(g.members, btc, i, cfg.levelB),
    };
  });
}

/**
 * Sector pulse and narrative heat for one scoring day. Groups with no member coin are left
 * out. `cfg` defaults to the shipped v0.3 model config.
 */
export function sectorPulse(
  inputs: PulseInputs,
  cfg: ModelConfig = MODEL_CONFIG_V0_3,
): PulseResult {
  const { coins, btcCloses } = inputs;
  return {
    asOf: inputs.asOf,
    sectors: runGroups(
      inputs.sectors,
      (c, id) => c.sector === id,
      coins,
      btcCloses,
      inputs.previousSectorStates,
      cfg,
    ),
    narratives: runGroups(
      inputs.narratives,
      (c, id) => (c.narratives ?? []).includes(id),
      coins,
      btcCloses,
      inputs.previousNarrativeStates,
      cfg,
    ),
  };
}

/* ------------------------------------------------------------------------ Season exports */

/**
 * Season S2: the sector's Heat, plus `levelB.seasonAdjust` (10) when Heating up and minus it
 * when Cooling down, kept within 0-100. Null when the sector has no Heat.
 */
export function sectorSeasonHeat(
  sector: { readonly heat: number | null; readonly phase: Phase },
  cfg: ModelConfig = MODEL_CONFIG_V0_3,
): number | null {
  if (!fin(sector.heat)) return null;
  const adj =
    sector.phase === 'Heating up'
      ? cfg.levelB.seasonAdjust
      : sector.phase === 'Cooling down'
        ? -cfg.levelB.seasonAdjust
        : 0;
  return Math.max(0, Math.min(100, sector.heat + adj));
}

/**
 * Season S3: the average Heat of the coin's narratives; the sector's Heat when the coin has
 * no narrative with a Heat. `narrativeHeats` are the Heat values of the coin's narratives.
 */
export function narrativeSeasonHeat(
  narrativeHeats: readonly (number | null | undefined)[],
  sectorHeat: number | null,
): number | null {
  const h = narrativeHeats.filter(fin);
  return h.length ? h.reduce((a, b) => a + b, 0) / h.length : sectorHeat;
}
