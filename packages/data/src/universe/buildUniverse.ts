/**
 * Asset universe builder (CSN-020).
 *
 * Pure and injectable: no network, no clock, no database. The caller fetches the source data
 * (see `sources.ts`), loads the previous assets, and passes the run time in. The result says
 * which assets to upsert, which to mark inactive (never delete), the diff, and the reports.
 *
 * Rules implemented here:
 * - Universe filter: no stablecoins (kept in a separate list), no wrapped / bridged duplicates,
 *   no exchange IOUs, and 7-day average volume / market cap of at least 0.1%. This is a
 *   universe filter only; the G2 "thin trading" gate (0.3%) still applies in scoring.
 * - Gold tokens (PAXG, XAUT) are kept and flagged `isGoldToken` (alt season C1 excludes them).
 * - Mapping: DefiLlama /protocols and /v2/chains by `gecko_id` first, then symbol + name fuzzy
 *   match, then `overrides.json`; GitHub repos from CoinGecko `links.repos_url.github` plus
 *   overrides; genesis date from CoinGecko.
 * - Gate G5: `isMeme` is true exactly when the sector is `culture`.
 * - Survivorship: a coin that drops out stays in the table with `active = false` and
 *   `delistedAt`; a coin that returns is reactivated.
 */
import overridesJson from './overrides.json';
import {
  DEPOSIT_OR_FEE_SECTORS,
  SECTOR_IDS,
  isNarrativeId,
  isSectorId,
  mapNarratives,
  mapSector,
} from './sectorMap';
import type { NarrativeId, SectorId } from './sectorMap';

// ---------------------------------------------------------------------------
// Source shapes (the subset of each API response this task reads)
// ---------------------------------------------------------------------------

/** One row of CoinGecko /coins/markets?vs_currency=usd. */
export interface CoinGeckoMarketRow {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly image?: string | null;
  readonly market_cap: number | null;
  readonly market_cap_rank: number | null;
  readonly total_volume?: number | null;
}

/** The subset of CoinGecko /coins/{id} this task reads. */
export interface CoinGeckoCoinDetail {
  readonly id: string;
  readonly symbol?: string;
  readonly name?: string;
  readonly asset_platform_id?: string | null;
  readonly platforms?: Readonly<Record<string, string | null>> | null;
  readonly categories?: ReadonlyArray<string | null> | null;
  readonly genesis_date?: string | null;
  readonly links?: {
    readonly repos_url?: { readonly github?: ReadonlyArray<string | null> | null } | null;
  } | null;
}

/** The subset of one DefiLlama /protocols entry this task reads. */
export interface DefiLlamaProtocol {
  readonly name: string;
  readonly slug: string;
  readonly symbol?: string | null;
  readonly gecko_id?: string | null;
  readonly category?: string | null;
  readonly tvl?: number | null;
  readonly parentProtocol?: string | null;
}

/**
 * One parent project from DefiLlama `/lite/protocols2` `parentProtocols`. /protocols lists only
 * the versions (Uniswap V2, V3, ...); the project-level `gecko_id` lives on the parent.
 */
export interface DefiLlamaParentProtocol {
  readonly id: string;
  readonly name: string;
  readonly symbol?: string | null;
  readonly gecko_id?: string | null;
}

/** The subset of one DefiLlama /v2/chains entry this task reads. */
export interface DefiLlamaChain {
  readonly name: string;
  readonly gecko_id?: string | null;
  readonly tokenSymbol?: string | null;
  readonly tvl?: number | null;
}

// ---------------------------------------------------------------------------
// Overrides (overrides.json)
// ---------------------------------------------------------------------------

/** The user's Score Lab assignment for one coin (from the 114-coin sample universe). */
export interface SampleSeedEntry {
  readonly symbol: string;
  readonly name: string;
  readonly sectorId: SectorId;
  readonly chain: string | null;
  readonly narrativeIds: readonly NarrativeId[];
}

/**
 * A manual override for one coin, keyed by CoinGecko id. Every field is optional. For the
 * DefiLlama fields `null` means "deliberately no mapping" (it blocks the fuzzy match), while
 * leaving the field out means "map automatically".
 */
export interface CoinOverride {
  readonly include?: boolean;
  readonly exclude?: boolean;
  readonly isGoldToken?: boolean;
  readonly sectorId?: SectorId;
  readonly narrativeIds?: readonly NarrativeId[];
  readonly chain?: string | null;
  readonly defillamaSlug?: string | null;
  readonly defillamaChain?: string | null;
  readonly githubRepos?: readonly string[];
  readonly genesisDate?: string | null;
  readonly note?: string;
}

export interface UniverseOverrides {
  /** Score Lab assignments; they win over the automatic sector and narrative mapping. */
  readonly sampleSeed: Readonly<Record<string, SampleSeedEntry>>;
  /** Manual overrides; they win over everything else. */
  readonly coins: Readonly<Record<string, CoinOverride>>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(path: string, message: string): never {
  throw new Error(`overrides.json ${path}: ${message}`);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(path, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') return fail(path, 'expected a string');
  return value;
}

function asNullableString(value: unknown, path: string): string | null {
  return value === null ? null : asString(value, path);
}

function asNarratives(value: unknown, path: string): NarrativeId[] {
  if (!Array.isArray(value)) return fail(path, 'expected an array of narrative ids');
  const out: NarrativeId[] = [];
  for (const [i, item] of value.entries()) {
    if (!isNarrativeId(item)) return fail(`${path}[${i}]`, `unknown narrative id ${String(item)}`);
    if (out.includes(item)) return fail(`${path}[${i}]`, `duplicate narrative id ${item}`);
    out.push(item);
  }
  return out;
}

function asSector(value: unknown, path: string): SectorId {
  if (!isSectorId(value)) return fail(path, `unknown sector id ${String(value)}`);
  return value;
}

/** Validates the raw overrides file. Throws with the offending path on any bad value. */
export function parseOverrides(raw: unknown): UniverseOverrides {
  const root = asRecord(raw, '$');
  const seedRaw = asRecord(root['sampleSeed'], 'sampleSeed');
  const coinsRaw = asRecord(root['coins'], 'coins');

  const sampleSeed: Record<string, SampleSeedEntry> = {};
  for (const [id, value] of Object.entries(seedRaw)) {
    const path = `sampleSeed.${id}`;
    const entry = asRecord(value, path);
    sampleSeed[id] = {
      symbol: asString(entry['symbol'], `${path}.symbol`),
      name: asString(entry['name'], `${path}.name`),
      sectorId: asSector(entry['sectorId'], `${path}.sectorId`),
      chain: asNullableString(entry['chain'], `${path}.chain`),
      narrativeIds: asNarratives(entry['narrativeIds'], `${path}.narrativeIds`),
    };
  }

  const coins: Record<string, CoinOverride> = {};
  for (const [id, value] of Object.entries(coinsRaw)) {
    const path = `coins.${id}`;
    const entry = asRecord(value, path);
    const out: {
      -readonly [K in keyof CoinOverride]: CoinOverride[K];
    } = {};
    for (const key of ['include', 'exclude', 'isGoldToken'] as const) {
      const v = entry[key];
      if (v === undefined) continue;
      if (typeof v !== 'boolean') return fail(`${path}.${key}`, 'expected a boolean');
      out[key] = v;
    }
    if (out.include === true && out.exclude === true) {
      return fail(path, 'include and exclude cannot both be true');
    }
    if (entry['sectorId'] !== undefined)
      out.sectorId = asSector(entry['sectorId'], `${path}.sectorId`);
    if (entry['narrativeIds'] !== undefined) {
      out.narrativeIds = asNarratives(entry['narrativeIds'], `${path}.narrativeIds`);
    }
    for (const key of ['chain', 'defillamaSlug', 'defillamaChain'] as const) {
      if (entry[key] !== undefined) out[key] = asNullableString(entry[key], `${path}.${key}`);
    }
    if (entry['genesisDate'] !== undefined) {
      const d = asNullableString(entry['genesisDate'], `${path}.genesisDate`);
      if (d !== null && normalizeDate(d) !== d)
        return fail(`${path}.genesisDate`, 'expected YYYY-MM-DD');
      out.genesisDate = d;
    }
    if (entry['githubRepos'] !== undefined) {
      const list = entry['githubRepos'];
      if (!Array.isArray(list)) return fail(`${path}.githubRepos`, 'expected an array');
      const repos: string[] = [];
      for (const [i, item] of list.entries()) {
        const repo = parseGithubRepo(asString(item, `${path}.githubRepos[${i}]`));
        if (repo === null) return fail(`${path}.githubRepos[${i}]`, 'not a GitHub owner/repo');
        repos.push(repo);
      }
      out.githubRepos = repos;
    }
    if (entry['note'] !== undefined) out.note = asString(entry['note'], `${path}.note`);
    coins[id] = out;
  }
  return { sampleSeed, coins };
}

/** The bundled overrides, validated once at import time. */
export const DEFAULT_OVERRIDES: UniverseOverrides = parseOverrides(overridesJson);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** How many coins the universe contains (top by market cap, after the filters). */
export const UNIVERSE_SIZE = 300;
/** How many CoinGecko /coins/markets rows are read as candidates before filtering. */
export const UNIVERSE_CANDIDATE_POOL = 400;
/**
 * Universe volume floor: 7-day average volume / market cap. Deliberately below the G2 gate
 * (0.3%), which still caps the score of thinly traded coins that stay in the universe.
 */
export const UNIVERSE_VOLUME_FLOOR_RATIO = 0.001;
/** CoinGecko ids of the gold tokens that are kept and flagged (alt season C1 excludes them). */
export const GOLD_TOKEN_IDS: readonly string[] = ['pax-gold', 'tether-gold'];

export interface UniverseConfig {
  readonly universeSize: number;
  readonly volumeFloorRatio: number;
  readonly goldTokenIds: readonly string[];
  /** CoinGecko category names that mark a stablecoin. */
  readonly stablecoinCategoryPatterns: readonly RegExp[];
  /** Wrapped, bridged and liquid-staking receipt tokens. */
  readonly wrappedCategoryPatterns: readonly RegExp[];
  /** Exchange IOU / peg tokens. */
  readonly exchangeIouCategoryPatterns: readonly RegExp[];
  /**
   * If more than this share of the candidates lack the data to be judged (a failed detail or
   * volume call), `assertCompleteEnough` refuses the run instead of applying a partial one.
   */
  readonly maxIncompleteRatio: number;
  /**
   * `assertPoolSize` refuses a run when CoinGecko returned fewer than this share of the
   * requested candidate pool, so a truncated 200 response cannot delist the stored universe.
   */
  readonly minPoolRatio: number;
}

export const DEFAULT_UNIVERSE_CONFIG: UniverseConfig = {
  universeSize: UNIVERSE_SIZE,
  volumeFloorRatio: UNIVERSE_VOLUME_FLOOR_RATIO,
  goldTokenIds: GOLD_TOKEN_IDS,
  // "Stablecoins", "USD Stablecoin", "Fiat-backed Stablecoin", ... but not "Stablecoin Issuer",
  // so the governance tokens of stablecoin projects stay.
  stablecoinCategoryPatterns: [/^stablecoins?$/i, /\bstablecoin$/i],
  // Not "Liquid Staking Governance Tokens": those are a project's own token.
  wrappedCategoryPatterns: [
    /^wrapped-tokens$/i,
    /^bridged[- ]/i,
    /^tokenized btc$/i,
    /^liquid (re)?staked /i,
    /^liquid (re)?staking tokens$/i,
  ],
  exchangeIouCategoryPatterns: [/\biou( tokens?)?$/i, /^binance-peg tokens$/i],
  maxIncompleteRatio: 0.2,
  minPoolRatio: 0.75,
};

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/** The persisted fields of an asset (Prisma `Asset` without the row timestamps). */
export interface UniverseAsset {
  /** Internal slug: the CoinGecko id. */
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly coingeckoId: string;
  readonly defillamaSlug: string | null;
  readonly defillamaChain: string | null;
  readonly githubRepos: readonly string[];
  readonly sectorId: SectorId;
  readonly narrativeIds: readonly NarrativeId[];
  readonly chain: string | null;
  /** Calendar day, YYYY-MM-DD. */
  readonly genesisDate: string | null;
  readonly isMeme: boolean;
  readonly isGoldToken: boolean;
  readonly logoUrl: string | null;
  readonly active: boolean;
  readonly delistedAt: Date | null;
}

export type ExclusionReason =
  | 'stablecoin'
  | 'wrapped-or-bridged'
  | 'exchange-iou'
  | 'low-volume'
  | 'no-market-cap'
  | 'override-exclude'
  | 'beyond-universe-size';

export interface ExcludedCoin {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly marketCapRank: number | null;
  readonly reason: ExclusionReason;
}

/** The separate stablecoin list (stablecoin supply is a market input, not a scored asset). */
export interface StablecoinEntry {
  readonly coingeckoId: string;
  readonly symbol: string;
  readonly name: string;
  readonly marketCapRank: number | null;
}

export interface FieldChange {
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
}

export interface UniverseDiff {
  readonly added: ReadonlyArray<{ id: string; symbol: string; sectorId: SectorId }>;
  readonly removed: ReadonlyArray<{
    id: string;
    symbol: string;
    reason: ExclusionReason | 'out-of-candidate-pool';
  }>;
  readonly remapped: ReadonlyArray<{ id: string; symbol: string; changes: readonly FieldChange[] }>;
  /** Coins that were inactive and are back in the universe. */
  readonly reactivated: ReadonlyArray<{ id: string; symbol: string }>;
}

export interface UnmappedEntry {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly sectorId: SectorId;
  readonly marketCapRank: number | null;
}

export interface UnclassifiedEntry {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly marketCapRank: number | null;
  readonly categories: readonly string[];
}

export type SeedMissingReason =
  ExclusionReason | 'outside-candidate-pool' | 'incomplete-data' | 'unclassified';

export interface SeedMissingEntry {
  readonly id: string;
  readonly symbol: string;
  readonly reason: SeedMissingReason;
}

export type DefillamaMatchKind = 'gecko_id' | 'fuzzy' | 'override' | 'none';

export interface AssetBuildNote {
  readonly id: string;
  readonly marketCapRank: number | null;
  readonly sectorSource: 'override' | 'sample-seed' | 'auto' | 'previous';
  readonly protocolMatch: DefillamaMatchKind;
  readonly chainMatch: DefillamaMatchKind;
  readonly volumeBasis: '7d' | '24h-fallback' | 'not-applied';
}

export interface UniverseBuildResult {
  /** Active assets to upsert, ordered by market cap rank. */
  readonly assets: readonly UniverseAsset[];
  /** Previously active assets that dropped out: mark inactive with `delistedAt`, never delete. */
  readonly delist: ReadonlyArray<{ id: string; delistedAt: Date }>;
  readonly diff: UniverseDiff;
  readonly stablecoins: readonly StablecoinEntry[];
  readonly excluded: readonly ExcludedCoin[];
  /** Assets in a deposit-or-fee sector with neither a DefiLlama protocol nor a chain. */
  readonly unmappedReport: readonly UnmappedEntry[];
  /** DefiLlama matches made by symbol + name only; a human should confirm them. */
  readonly fuzzyMatches: ReadonlyArray<{ id: string; slug: string | null; chain: string | null }>;
  /**
   * Candidates with no override, no seed, no rule hit and no previous sector. Not upserted, and
   * they do not use up universe slots: the rank cut counts only classified coins.
   */
  readonly unclassified: readonly UnclassifiedEntry[];
  /** Score Lab sample coins that are not in the universe this run, with the reason. */
  readonly seedNotInUniverse: readonly SeedMissingEntry[];
  /** Candidates that lacked detail or volume data this run. Existing rows are left as they are. */
  readonly incomplete: readonly string[];
  readonly notes: readonly AssetBuildNote[];
}

export interface BuildUniverseInput {
  /** Run time. Used for `delistedAt`; the builder never reads the clock. */
  readonly asOf: Date;
  /** CoinGecko /coins/markets rows (any order; the builder sorts by rank). */
  readonly markets: readonly CoinGeckoMarketRow[];
  /** CoinGecko /coins/{id} responses by id. */
  readonly details: Readonly<Record<string, CoinGeckoCoinDetail>>;
  /**
   * 7-day average daily volume in USD by id. An id missing here, with no failed call, means the
   * series came back empty and the 24h volume is used instead.
   */
  readonly volume7dAvg: Readonly<Record<string, number>>;
  /** Ids whose volume call FAILED. They are `incomplete`: never judged on 24h volume. */
  readonly volumeFailed?: readonly string[];
  readonly protocols: readonly DefiLlamaProtocol[];
  /** Parent projects; optional, but without them multi-version projects match less often. */
  readonly parentProtocols?: readonly DefiLlamaParentProtocol[];
  readonly chains: readonly DefiLlamaChain[];
  /** Every asset row already stored, active or not. */
  readonly previous: readonly UniverseAsset[];
  readonly overrides?: UniverseOverrides;
  readonly config?: Partial<UniverseConfig>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** YYYY-MM-DD if the input starts with a valid calendar day, else null. */
export function normalizeDate(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const day = value.trim().slice(0, 10);
  if (!DATE_RE.test(day)) return null;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day ? null : day;
}

const GITHUB_URL_RE =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/i;
const GITHUB_SHORT_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

/** `owner/repo` from a GitHub URL or short form. Organisation-only URLs give null. */
export function parseGithubRepo(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  const match = GITHUB_URL_RE.exec(text) ?? GITHUB_SHORT_RE.exec(text);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  if (owner === undefined || repo === undefined || repo === '' || repo === '.' || repo === '..') {
    return null;
  }
  return `${owner}/${repo}`;
}

function uniqueRepos(lists: ReadonlyArray<readonly (string | null | undefined)[]>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const item of list) {
      const repo = parseGithubRepo(item);
      if (repo === null || seen.has(repo.toLowerCase())) continue;
      seen.add(repo.toLowerCase());
      out.push(repo);
    }
  }
  return out;
}

const NAME_NOISE: ReadonlySet<string> = new Set([
  'v1',
  'v2',
  'v3',
  'v4',
  'v5',
  'dao',
  'protocol',
  'network',
  'finance',
  'labs',
  'exchange',
  'dex',
  'swap',
  'token',
  'coin',
  'chain',
  'foundation',
  'the',
]);

/** Lower-case alphanumerics with version and generic words removed, for fuzzy name matching. */
export function normalizeName(name: string): string {
  const tokens = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t !== '');
  const kept = tokens.filter((t) => !NAME_NOISE.has(t));
  return (kept.length > 0 ? kept : tokens).join('');
}

function namesSimilar(a: string, b: string): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (x === '' || y === '') return false;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x));
}

function byTvlThenKey<T>(tvl: (t: T) => number | null | undefined, key: (t: T) => string) {
  return (a: T, b: T): number => {
    const d = (tvl(b) ?? -1) - (tvl(a) ?? -1);
    return d !== 0 ? d : key(a).localeCompare(key(b));
  };
}

const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  ethereum: 'Ethereum',
  solana: 'Solana',
  base: 'Base',
  'binance-smart-chain': 'BNB Chain',
  'arbitrum-one': 'Arbitrum',
  'optimistic-ethereum': 'Optimism',
  'polygon-pos': 'Polygon',
  avalanche: 'Avalanche',
  tron: 'Tron',
  ronin: 'Ronin',
  'the-open-network': 'TON',
};

function titleCase(id: string): string {
  return id
    .split('-')
    .filter((p) => p !== '')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

/** The chain label for the Asset.chain column when no override or seed gives one. */
export function deriveChain(detail: CoinGeckoCoinDetail): string {
  const deployed = Object.entries(detail.platforms ?? {}).filter(
    ([key, address]) => key !== '' && typeof address === 'string' && address !== '',
  );
  if (deployed.length >= 3) return 'Multi-chain';
  const platform = detail.asset_platform_id;
  if (typeof platform === 'string' && platform !== '') {
    return PLATFORM_LABELS[platform] ?? titleCase(platform);
  }
  return 'Own chain';
}

// ---------------------------------------------------------------------------
// Candidate classification (G2-adjacent universe filter)
// ---------------------------------------------------------------------------

export interface CandidateClass {
  readonly reason: 'stablecoin' | 'wrapped-or-bridged' | 'exchange-iou' | 'override-exclude' | null;
  readonly isGoldToken: boolean;
  /** Included whatever the rank cut says: a manual `include`. */
  readonly pinned: boolean;
}

function categoriesOf(detail: CoinGeckoCoinDetail | undefined): string[] {
  return (detail?.categories ?? []).filter((c): c is string => typeof c === 'string' && c !== '');
}

/**
 * Classifies one candidate from its CoinGecko categories. Gold tokens, coins in the Score Lab
 * seed and coins with a manual `include` are never excluded as stablecoin / wrapped / IOU:
 * the user's own list and a human override outrank a category label. `exclude` outranks all.
 */
export function classifyCandidate(
  id: string,
  detail: CoinGeckoCoinDetail | undefined,
  overrides: UniverseOverrides,
  config: UniverseConfig = DEFAULT_UNIVERSE_CONFIG,
): CandidateClass {
  const override = overrides.coins[id];
  const categories = categoriesOf(detail);
  const isGoldToken =
    override?.isGoldToken ??
    (config.goldTokenIds.includes(id) || categories.some((c) => /^tokenized gold$/i.test(c)));
  const pinned = override?.include === true;
  if (override?.exclude === true) return { reason: 'override-exclude', isGoldToken, pinned };
  if (isGoldToken || pinned || overrides.sampleSeed[id] !== undefined) {
    return { reason: null, isGoldToken, pinned };
  }
  const any = (patterns: readonly RegExp[]): boolean =>
    categories.some((c) => patterns.some((p) => p.test(c.trim())));
  if (any(config.stablecoinCategoryPatterns)) return { reason: 'stablecoin', isGoldToken, pinned };
  if (any(config.wrappedCategoryPatterns)) {
    return { reason: 'wrapped-or-bridged', isGoldToken, pinned };
  }
  if (any(config.exchangeIouCategoryPatterns)) {
    return { reason: 'exchange-iou', isGoldToken, pinned };
  }
  return { reason: null, isGoldToken, pinned };
}

/** 7-day average daily volume / market cap, or null if either is unusable. */
export function volumeToMarketCapRatio(
  avgVolume: number | null | undefined,
  marketCap: number | null | undefined,
): number | null {
  if (typeof avgVolume !== 'number' || !Number.isFinite(avgVolume) || avgVolume < 0) return null;
  if (typeof marketCap !== 'number' || !Number.isFinite(marketCap) || marketCap <= 0) return null;
  return avgVolume / marketCap;
}

// ---------------------------------------------------------------------------
// DefiLlama matching
// ---------------------------------------------------------------------------

export interface DefillamaIndex {
  readonly protocols: readonly DefiLlamaProtocol[];
  readonly chains: readonly DefiLlamaChain[];
  readonly protocolsByGecko: ReadonlyMap<string, readonly DefiLlamaProtocol[]>;
  readonly chainsByGecko: ReadonlyMap<string, readonly DefiLlamaChain[]>;
  readonly parentsById: ReadonlyMap<string, DefiLlamaParentProtocol>;
  readonly parentsByGecko: ReadonlyMap<string, readonly DefiLlamaParentProtocol[]>;
}

export function indexDefillama(
  protocols: readonly DefiLlamaProtocol[],
  chains: readonly DefiLlamaChain[],
  parentProtocols: readonly DefiLlamaParentProtocol[] = [],
): DefillamaIndex {
  const group = <T>(items: readonly T[], key: (t: T) => string | null | undefined) => {
    const map = new Map<string, T[]>();
    for (const item of items) {
      const k = key(item);
      if (typeof k !== 'string' || k === '') continue;
      const list = map.get(k) ?? [];
      list.push(item);
      map.set(k, list);
    }
    return map;
  };
  return {
    protocols,
    chains,
    protocolsByGecko: group(protocols, (p) => p.gecko_id),
    chainsByGecko: group(chains, (c) => c.gecko_id),
    parentsById: new Map(parentProtocols.map((p) => [p.id, p])),
    parentsByGecko: group(parentProtocols, (p) => p.gecko_id),
  };
}

export interface ProtocolMatch {
  readonly slug: string;
  readonly category: string | null;
  readonly kind: Exclude<DefillamaMatchKind, 'none'>;
}

export interface ChainMatch {
  readonly name: string;
  readonly kind: Exclude<DefillamaMatchKind, 'none'>;
}

const tvlOrder = byTvlThenKey<DefiLlamaProtocol>(
  (p) => p.tvl,
  (p) => p.slug,
);

/**
 * DefiLlama /protocols entries that are not a coin's own project even when they carry its
 * `gecko_id` (a foundation's treasury, an exchange's reserves, a chain's canonical bridge):
 * ignored when mapping.
 */
export const NON_PROJECT_PROTOCOL_CATEGORIES: ReadonlySet<string> = new Set([
  'Foundation',
  'CEX',
  'Canonical Bridge',
]);

/** Parent projects named like a foundation or treasury are not a coin's own project. */
const NON_PROJECT_PARENT_NAME = /\b(foundation|treasury)\b/i;

/** DefiLlama's own slug rule: lower case, spaces to dashes, apostrophes dropped. */
export function slugifyName(name: string): string {
  return name.trim().toLowerCase().split(' ').join('-').split("'").join('');
}

/**
 * One slug for a group of protocol versions: the parent project's slug when every version
 * belongs to the same known parent (Uniswap V2, V3, V4 -> "uniswap"), otherwise the version
 * with the most TVL.
 */
function pickProtocol(
  candidates: readonly DefiLlamaProtocol[],
  index: DefillamaIndex,
): { slug: string; category: string | null } | null {
  const sorted = candidates
    .filter((p) => !NON_PROJECT_PROTOCOL_CATEGORIES.has(p.category ?? ''))
    .sort(tvlOrder);
  const top = sorted[0];
  if (top === undefined) return null;
  const parents = new Set(sorted.map((p) => p.parentProtocol ?? ''));
  const [onlyParent] = [...parents];
  const parent = onlyParent === undefined ? undefined : index.parentsById.get(onlyParent);
  if (parents.size === 1 && parent !== undefined) {
    return { slug: slugifyName(parent.name), category: top.category ?? null };
  }
  return { slug: top.slug, category: top.category ?? null };
}

function categoryOfSlug(slug: string, index: DefillamaIndex): string | null {
  const direct = index.protocols.find((p) => p.slug === slug);
  if (direct) return direct.category ?? null;
  const parent = [...index.parentsById.values()].find((p) => slugifyName(p.name) === slug);
  if (parent === undefined) return null;
  const children = index.protocols.filter((p) => p.parentProtocol === parent.id);
  return [...children].sort(tvlOrder)[0]?.category ?? null;
}

/**
 * DefiLlama protocol match: override, then the version or parent project carrying the coin's
 * `gecko_id`, then a symbol + name fuzzy match over the versions.
 */
export function matchProtocol(
  coin: { id: string; symbol: string; name: string },
  index: DefillamaIndex,
  override: CoinOverride | undefined,
): ProtocolMatch | null {
  if (override?.defillamaSlug !== undefined) {
    if (override.defillamaSlug === null) return null;
    return {
      slug: override.defillamaSlug,
      category: categoryOfSlug(override.defillamaSlug, index),
      kind: 'override',
    };
  }
  const byId = index.protocolsByGecko.get(coin.id);
  if (byId !== undefined) {
    const picked = pickProtocol(byId, index);
    if (picked) return { ...picked, kind: 'gecko_id' };
  }
  const parent = [...(index.parentsByGecko.get(coin.id) ?? [])]
    .filter((p) => !NON_PROJECT_PARENT_NAME.test(p.name))
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  if (parent !== undefined) {
    const children = index.protocols.filter((p) => p.parentProtocol === parent.id);
    const projectChildren = children.filter(
      (p) => !NON_PROJECT_PROTOCOL_CATEGORIES.has(p.category ?? ''),
    );
    // A parent whose every version is a foundation, exchange or canonical bridge is not the project.
    if (children.length === 0 || projectChildren.length > 0) {
      return {
        slug: slugifyName(parent.name),
        category: [...projectChildren].sort(tvlOrder)[0]?.category ?? null,
        kind: 'gecko_id',
      };
    }
  }
  const symbol = coin.symbol.toLowerCase();
  const fuzzy = index.protocols.filter(
    (p) =>
      typeof p.symbol === 'string' &&
      p.symbol !== '-' &&
      p.symbol.toLowerCase() === symbol &&
      (p.gecko_id === undefined || p.gecko_id === null || p.gecko_id === '') &&
      namesSimilar(p.name, coin.name),
  );
  const picked = pickProtocol(fuzzy, index);
  return picked ? { ...picked, kind: 'fuzzy' } : null;
}

const chainOrder = byTvlThenKey<DefiLlamaChain>(
  (c) => c.tvl,
  (c) => c.name,
);

/** DefiLlama /v2/chains match: override, then `gecko_id`, then token symbol + name fuzzy. */
export function matchChain(
  coin: { id: string; symbol: string; name: string },
  index: DefillamaIndex,
  override: CoinOverride | undefined,
): ChainMatch | null {
  if (override?.defillamaChain !== undefined) {
    return override.defillamaChain === null
      ? null
      : { name: override.defillamaChain, kind: 'override' };
  }
  const byId = [...(index.chainsByGecko.get(coin.id) ?? [])].sort(chainOrder)[0];
  if (byId) return { name: byId.name, kind: 'gecko_id' };
  const symbol = coin.symbol.toLowerCase();
  const fuzzy = index.chains
    .filter(
      (c) =>
        typeof c.tokenSymbol === 'string' &&
        c.tokenSymbol.toLowerCase() === symbol &&
        (c.gecko_id === undefined || c.gecko_id === null || c.gecko_id === '') &&
        namesSimilar(c.name, coin.name),
    )
    .sort(chainOrder)[0];
  return fuzzy ? { name: fuzzy.name, kind: 'fuzzy' } : null;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

const REMAP_FIELDS = [
  'defillamaSlug',
  'defillamaChain',
  'githubRepos',
  'sectorId',
  'narrativeIds',
  'chain',
  'genesisDate',
  'isMeme',
  'isGoldToken',
] as const;

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/** The mapping fields that differ between a stored asset and a freshly built one. */
export function mappingChanges(prev: UniverseAsset, next: UniverseAsset): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of REMAP_FIELDS) {
    const from: unknown = prev[field];
    const to: unknown = next[field];
    if (!sameValue(from, to)) changes.push({ field, from, to });
  }
  return changes;
}

/** True when writing `next` over `prev` would change nothing. Lets the job skip no-op upserts. */
export function isAssetUnchanged(prev: UniverseAsset, next: UniverseAsset): boolean {
  return (
    prev.active &&
    prev.delistedAt === null &&
    prev.symbol === next.symbol &&
    prev.name === next.name &&
    prev.logoUrl === next.logoUrl &&
    mappingChanges(prev, next).length === 0
  );
}

// ---------------------------------------------------------------------------
// The report of unmapped assets
// ---------------------------------------------------------------------------

/**
 * Every asset in a deposit-or-fee sector that has no DefiLlama protocol and no DefiLlama
 * chain, so a human can fill `overrides.json`. Ordered by sector, then rank, then id.
 */
export function buildUnmappedReport(
  assets: readonly UniverseAsset[],
  ranks: ReadonlyMap<string, number | null> = new Map(),
): UnmappedEntry[] {
  const sectorOrder = (s: SectorId): number => SECTOR_IDS.indexOf(s);
  return assets
    .filter(
      (a) =>
        DEPOSIT_OR_FEE_SECTORS.includes(a.sectorId) &&
        a.defillamaSlug === null &&
        a.defillamaChain === null,
    )
    .map((a) => ({
      id: a.id,
      symbol: a.symbol,
      name: a.name,
      sectorId: a.sectorId,
      marketCapRank: ranks.get(a.id) ?? null,
    }))
    .sort(
      (a, b) =>
        sectorOrder(a.sectorId) - sectorOrder(b.sectorId) ||
        (a.marketCapRank ?? Number.MAX_SAFE_INTEGER) -
          (b.marketCapRank ?? Number.MAX_SAFE_INTEGER) ||
        a.id.localeCompare(b.id),
    );
}

/** Plain-text form of the unmapped report, one line per asset. */
export function formatUnmappedReport(entries: readonly UnmappedEntry[]): string {
  if (entries.length === 0) return 'Unmapped assets in deposit-or-fee sectors: none';
  const lines = entries.map(
    (e) =>
      `${e.sectorId.padEnd(9)} ${e.symbol.padEnd(8)} ${e.id}  (rank ${e.marketCapRank ?? 'n/a'})`,
  );
  return [
    `Unmapped assets in deposit-or-fee sectors (${entries.length}): add defillamaSlug or defillamaChain to overrides.json`,
    ...lines,
  ].join('\n');
}

/** Plain-text section for coins no sector rule, seed or override placed. */
export function formatUnclassifiedReport(entries: readonly UnclassifiedEntry[]): string {
  if (entries.length === 0) return 'Unclassified coins skipped: none';
  const lines = entries.map(
    (e) =>
      `${e.symbol.padEnd(8)} ${e.id}  "${e.name}"  (rank ${e.marketCapRank ?? 'n/a'})  categories: ${e.categories.length > 0 ? e.categories.join(', ') : 'none'}`,
  );
  return [
    `Unclassified coins skipped (${entries.length}): not in the universe and not counted against its size; add sectorId to overrides.json`,
    ...lines,
  ].join('\n');
}

/** One line naming the Score Lab sample coins that are not in the universe, and why. */
export function formatSeedMissingLine(entries: readonly SeedMissingEntry[]): string {
  if (entries.length === 0) return 'Seed coins not in the universe (0): none';
  return `Seed coins not in the universe (${entries.length}): ${entries
    .map((e) => `${e.id} (${e.reason})`)
    .join(', ')}`;
}

/**
 * Throws if CoinGecko returned far fewer candidates than were requested. Call it before
 * `buildUniverse`: a short list would otherwise delist every stored coin missing from it.
 */
export function assertPoolSize(
  received: number,
  requested: number,
  config: Partial<UniverseConfig> = {},
): void {
  const min = config.minPoolRatio ?? DEFAULT_UNIVERSE_CONFIG.minPoolRatio;
  if (requested > 0 && received < requested * min) {
    throw new Error(
      `Universe run refused: CoinGecko returned ${received} market rows, fewer than ${Math.round(min * 100)}% of the ${requested} requested`,
    );
  }
}

/**
 * Throws if too many candidates lacked data to be judged. The job calls this before writing,
 * so a CoinGecko outage cannot silently shrink the universe.
 */
export function assertCompleteEnough(
  result: Pick<UniverseBuildResult, 'incomplete'>,
  candidateCount: number,
  config: Partial<UniverseConfig> = {},
): void {
  const max = config.maxIncompleteRatio ?? DEFAULT_UNIVERSE_CONFIG.maxIncompleteRatio;
  if (candidateCount > 0 && result.incomplete.length / candidateCount > max) {
    throw new Error(
      `Universe run refused: ${result.incomplete.length} of ${candidateCount} candidates lack detail or volume data (limit ${max * 100}%)`,
    );
  }
}

// ---------------------------------------------------------------------------
// buildUniverse
// ---------------------------------------------------------------------------

function rankKey(row: CoinGeckoMarketRow): number {
  return row.market_cap_rank ?? Number.MAX_SAFE_INTEGER;
}

/** Builds the universe. Deterministic: the same input always gives the same result. */
export function buildUniverse(input: BuildUniverseInput): UniverseBuildResult {
  const config: UniverseConfig = { ...DEFAULT_UNIVERSE_CONFIG, ...input.config };
  const overrides = input.overrides ?? DEFAULT_OVERRIDES;
  const index = indexDefillama(input.protocols, input.chains, input.parentProtocols);
  const previousById = new Map(input.previous.map((a) => [a.id, a]));

  // Candidates in rank order, one row per id.
  const seenIds = new Set<string>();
  const pool = [...input.markets]
    .sort((a, b) => rankKey(a) - rankKey(b) || a.id.localeCompare(b.id))
    .filter((row) => (seenIds.has(row.id) ? false : (seenIds.add(row.id), true)));

  const excluded: ExcludedCoin[] = [];
  const stablecoins: StablecoinEntry[] = [];
  const incomplete: string[] = [];
  const volumeFailed = new Set(input.volumeFailed ?? []);
  const kept: Array<{
    row: CoinGeckoMarketRow;
    detail: CoinGeckoCoinDetail;
    cls: CandidateClass;
    volumeBasis: AssetBuildNote['volumeBasis'];
  }> = [];

  const exclude = (row: CoinGeckoMarketRow, reason: ExclusionReason): void => {
    excluded.push({
      id: row.id,
      symbol: row.symbol.toUpperCase(),
      name: row.name,
      marketCapRank: row.market_cap_rank,
      reason,
    });
  };

  for (const row of pool) {
    const detail = input.details[row.id];
    const cls = classifyCandidate(row.id, detail, overrides, config);
    if (cls.reason === 'override-exclude') {
      exclude(row, cls.reason);
      continue;
    }
    if (detail === undefined) {
      incomplete.push(row.id);
      continue;
    }
    if (cls.reason !== null) {
      exclude(row, cls.reason);
      if (cls.reason === 'stablecoin') {
        stablecoins.push({
          coingeckoId: row.id,
          symbol: row.symbol.toUpperCase(),
          name: row.name,
          marketCapRank: row.market_cap_rank,
        });
      }
      continue;
    }
    // Gold tokens are kept whatever their volume; everything else must clear the floor.
    let volumeBasis: AssetBuildNote['volumeBasis'] = 'not-applied';
    if (!cls.isGoldToken) {
      if (typeof row.market_cap !== 'number' || row.market_cap <= 0) {
        exclude(row, 'no-market-cap');
        continue;
      }
      if (volumeFailed.has(row.id)) {
        incomplete.push(row.id);
        continue;
      }
      const avg = input.volume7dAvg[row.id];
      const volume = typeof avg === 'number' ? avg : row.total_volume;
      volumeBasis = typeof avg === 'number' ? '7d' : '24h-fallback';
      const ratio = volumeToMarketCapRatio(volume, row.market_cap);
      if (ratio === null) {
        incomplete.push(row.id);
        continue;
      }
      if (ratio < config.volumeFloorRatio) {
        exclude(row, 'low-volume');
        continue;
      }
    }
    kept.push({ row, detail, cls, volumeBasis });
  }

  // Build the assets.
  const assets: UniverseAsset[] = [];
  const notes: AssetBuildNote[] = [];
  const fuzzyMatches: Array<{ id: string; slug: string | null; chain: string | null }> = [];
  const unclassified: UnclassifiedEntry[] = [];
  // Rank cut: the first `universeSize` classified coins; pinned coins are always kept.
  let counted = 0;
  const ranks = new Map<string, number | null>();

  for (const { row, detail, cls, volumeBasis } of kept) {
    const id = row.id;
    const symbol = row.symbol.toUpperCase();
    const override = overrides.coins[id];
    const seed = overrides.sampleSeed[id];
    const previous = previousById.get(id);
    const coin = { id, symbol, name: row.name };

    const protocol = matchProtocol(coin, index, override);
    const chainMatch = matchChain(coin, index, override);
    const evidence = {
      coingeckoCategories: categoriesOf(detail),
      defillamaCategory: protocol?.category ?? null,
      isDefillamaChain: chainMatch !== null,
    };
    const auto = mapSector(evidence);

    let sectorId: SectorId | null = null;
    let sectorSource: AssetBuildNote['sectorSource'] = 'auto';
    if (override?.sectorId !== undefined) {
      sectorId = override.sectorId;
      sectorSource = 'override';
    } else if (seed !== undefined) {
      sectorId = seed.sectorId;
      sectorSource = 'sample-seed';
    } else if (auto.sectorId !== null) {
      sectorId = auto.sectorId;
    } else if (previous !== undefined) {
      sectorId = previous.sectorId;
      sectorSource = 'previous';
    }
    if (sectorId === null) {
      unclassified.push({
        id,
        symbol,
        name: row.name,
        marketCapRank: row.market_cap_rank,
        categories: categoriesOf(detail),
      });
      continue;
    }
    if (!cls.pinned) {
      counted += 1;
      if (counted > config.universeSize) {
        exclude(row, 'beyond-universe-size');
        continue;
      }
    }

    const narrativeIds: readonly NarrativeId[] =
      override?.narrativeIds ?? seed?.narrativeIds ?? mapNarratives(evidence);
    const chain =
      override?.chain !== undefined
        ? override.chain
        : seed !== undefined
          ? seed.chain
          : deriveChain(detail);
    const genesisDate =
      override?.genesisDate !== undefined
        ? override.genesisDate
        : normalizeDate(detail.genesis_date);
    const githubRepos = uniqueRepos([
      override?.githubRepos ?? [],
      detail.links?.repos_url?.github ?? [],
    ]);

    const asset: UniverseAsset = {
      id,
      symbol,
      name: row.name,
      coingeckoId: id,
      defillamaSlug: protocol?.slug ?? null,
      defillamaChain: chainMatch?.name ?? null,
      githubRepos,
      sectorId,
      narrativeIds: [...narrativeIds],
      chain,
      genesisDate,
      isMeme: sectorId === 'culture',
      isGoldToken: cls.isGoldToken,
      logoUrl: typeof row.image === 'string' && row.image !== '' ? row.image : null,
      active: true,
      delistedAt: null,
    };
    assets.push(asset);
    ranks.set(id, row.market_cap_rank);
    if (protocol?.kind === 'fuzzy' || chainMatch?.kind === 'fuzzy') {
      fuzzyMatches.push({
        id,
        slug: protocol?.kind === 'fuzzy' ? protocol.slug : null,
        chain: chainMatch?.kind === 'fuzzy' ? chainMatch.name : null,
      });
    }
    notes.push({
      id,
      marketCapRank: row.market_cap_rank,
      sectorSource,
      protocolMatch: protocol?.kind ?? 'none',
      chainMatch: chainMatch?.kind ?? 'none',
      volumeBasis,
    });
  }

  // Diff against what is stored.
  const added: Array<{ id: string; symbol: string; sectorId: SectorId }> = [];
  const remapped: Array<{ id: string; symbol: string; changes: FieldChange[] }> = [];
  const reactivated: Array<{ id: string; symbol: string }> = [];
  for (const asset of assets) {
    const previous = previousById.get(asset.id);
    if (previous === undefined) {
      added.push({ id: asset.id, symbol: asset.symbol, sectorId: asset.sectorId });
      continue;
    }
    if (!previous.active) reactivated.push({ id: asset.id, symbol: asset.symbol });
    const changes = mappingChanges(previous, asset);
    if (changes.length > 0) remapped.push({ id: asset.id, symbol: asset.symbol, changes });
  }

  const nextIds = new Set(assets.map((a) => a.id));
  const incompleteIds = new Set(incomplete);
  const unclassifiedIds = new Set(unclassified.map((u) => u.id));
  const excludedById = new Map(excluded.map((e) => [e.id, e.reason]));
  const removed: Array<{
    id: string;
    symbol: string;
    reason: ExclusionReason | 'out-of-candidate-pool';
  }> = [];
  const delist: Array<{ id: string; delistedAt: Date }> = [];
  for (const previous of input.previous) {
    if (!previous.active || nextIds.has(previous.id)) continue;
    // No data this run, or no classification: leave the row alone rather than delist on a gap.
    if (incompleteIds.has(previous.id) || unclassifiedIds.has(previous.id)) continue;
    removed.push({
      id: previous.id,
      symbol: previous.symbol,
      reason: excludedById.get(previous.id) ?? 'out-of-candidate-pool',
    });
    delist.push({ id: previous.id, delistedAt: input.asOf });
  }

  const unclassifiedSeed = new Set(unclassified.map((u) => u.id));
  const seedNotInUniverse: SeedMissingEntry[] = [];
  for (const [id, entry] of Object.entries(overrides.sampleSeed)) {
    if (nextIds.has(id)) continue;
    const reason: SeedMissingReason = excludedById.get(id)
      ? (excludedById.get(id) as ExclusionReason)
      : incompleteIds.has(id)
        ? 'incomplete-data'
        : unclassifiedSeed.has(id)
          ? 'unclassified'
          : 'outside-candidate-pool';
    seedNotInUniverse.push({ id, symbol: entry.symbol, reason });
  }

  const byId = <T extends { id: string }>(a: T, b: T): number => a.id.localeCompare(b.id);
  return {
    assets,
    delist: delist.sort(byId),
    diff: {
      added: added.sort(byId),
      removed: removed.sort(byId),
      remapped: remapped.sort(byId),
      reactivated: reactivated.sort(byId),
    },
    stablecoins,
    excluded,
    unmappedReport: buildUnmappedReport(assets, ranks),
    fuzzyMatches,
    unclassified,
    seedNotInUniverse,
    incomplete,
    notes,
  };
}
