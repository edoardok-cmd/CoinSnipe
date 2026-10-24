/**
 * Asset universe tests (CSN-020).
 *
 * Fixtures under ./__fixtures__ are named SAMPLE_*, shaped like the real CoinGecko
 * /coins/markets and /coins/{id} and DefiLlama /protocols, /lite/protocols2 and /v2/chains
 * responses. Every number in them is invented. Ids are public identifiers.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NARRATIVES, SECTORS } from '../../../db/src/reference-data';
import {
  DEFAULT_OVERRIDES,
  DEFAULT_UNIVERSE_CONFIG,
  UNIVERSE_VOLUME_FLOOR_RATIO,
  assertCompleteEnough,
  assertPoolSize,
  buildUniverse,
  buildUnmappedReport,
  classifyCandidate,
  formatSeedMissingLine,
  formatUnclassifiedReport,
  formatUnmappedReport,
  isAssetUnchanged,
  mappingChanges,
  normalizeDate,
  normalizeName,
  parseGithubRepo,
  parseOverrides,
  volumeToMarketCapRatio,
} from './buildUniverse';
import type {
  BuildUniverseInput,
  CoinGeckoCoinDetail,
  CoinGeckoMarketRow,
  DefiLlamaChain,
  DefiLlamaParentProtocol,
  DefiLlamaProtocol,
  UniverseAsset,
  UniverseOverrides,
} from './buildUniverse';
import coinDetails from './__fixtures__/SAMPLE_coin_details.json';
import coinsMarkets from './__fixtures__/SAMPLE_coins_markets.json';
import defillamaChains from './__fixtures__/SAMPLE_defillama_chains.json';
import defillamaParents from './__fixtures__/SAMPLE_defillama_parents.json';
import defillamaProtocols from './__fixtures__/SAMPLE_defillama_protocols.json';
import volume7dAvg from './__fixtures__/SAMPLE_volume_7d_avg.json';
import {
  DEPOSIT_OR_FEE_SECTORS,
  NARRATIVE_IDS,
  NARRATIVE_RULES,
  SECTOR_IDS,
  SECTOR_RULES,
  mapNarratives,
  mapSector,
} from './sectorMap';
import {
  HttpError,
  averageDailyVolume,
  coingeckoConfigFromEnv,
  createHttpClient,
  defillamaConfig,
  fetchMarkets,
  fetchUniverseSources,
  fetchVolume7dAvg,
} from './sources';
import type { FetchLike, FetchResponseLike, HttpClient, HttpClientConfig } from './sources';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const MARKETS = coinsMarkets as unknown as CoinGeckoMarketRow[];
const DETAILS = Object.fromEntries(
  (coinDetails as unknown as CoinGeckoCoinDetail[]).map((d) => [d.id, d]),
) as Record<string, CoinGeckoCoinDetail>;
const PROTOCOLS = defillamaProtocols as unknown as DefiLlamaProtocol[];
const PARENTS = defillamaParents as unknown as DefiLlamaParentProtocol[];
const CHAINS = defillamaChains as unknown as DefiLlamaChain[];
const VOLUMES = volume7dAvg as Record<string, number>;
const ASOF = new Date('2026-01-05T00:00:00.000Z');
const NO_SEED: UniverseOverrides = { sampleSeed: {}, coins: {} };

interface SeedRow {
  symbol: string;
  name: string;
  sector_id: string;
  chain: string;
  narrative_ids: string[];
}

/** The 5-column copy of the Score Lab sample universe (no prices, no market caps). */
function readAssignments(): SeedRow[] {
  const text = readFileSync(
    new URL('./__fixtures__/SAMPLE_universe_assignments.psv', import.meta.url),
    'utf8',
  );
  const [header, ...lines] = text.trim().split('\n');
  expect(header).toBe('symbol|name|sector_id|chain|narrative_ids');
  return lines.map((line) => {
    const [symbol = '', name = '', sector_id = '', chain = '', narratives = ''] = line.split('|');
    return {
      symbol,
      name,
      sector_id,
      chain,
      narrative_ids: narratives === '' ? [] : narratives.split(','),
    };
  });
}

function input(over: Partial<BuildUniverseInput> = {}): BuildUniverseInput {
  return {
    asOf: ASOF,
    markets: MARKETS,
    details: DETAILS,
    volume7dAvg: VOLUMES,
    protocols: PROTOCOLS,
    parentProtocols: PARENTS,
    chains: CHAINS,
    previous: [],
    ...over,
  };
}

function assetOf(result: { assets: readonly UniverseAsset[] }, id: string): UniverseAsset {
  const asset = result.assets.find((a) => a.id === id);
  if (!asset) throw new Error(`asset ${id} not in result`);
  return asset;
}

function market(id: string, rank: number, cap: number | null, volume: number): CoinGeckoMarketRow {
  return {
    id,
    symbol: id.slice(0, 4),
    name: id,
    market_cap: cap,
    market_cap_rank: rank,
    total_volume: volume,
  };
}

function detail(id: string, categories: string[] = []): CoinGeckoCoinDetail {
  return { id, categories };
}

// ---------------------------------------------------------------------------
// Contract with packages/db
// ---------------------------------------------------------------------------

describe('sector and narrative ids (contract with packages/db)', () => {
  it('lists exactly the 11 sector ids and 20 narrative ids the database seeds', () => {
    expect([...SECTOR_IDS]).toEqual(SECTORS.map((s) => s.id));
    expect([...NARRATIVE_IDS]).toEqual(NARRATIVES.map((n) => n.id));
    expect(SECTOR_IDS).toHaveLength(11);
    expect(NARRATIVE_IDS).toHaveLength(20);
  });

  it('only ever emits those ids from the rule tables', () => {
    for (const rule of SECTOR_RULES) expect(SECTOR_IDS).toContain(rule.sector);
    for (const rule of NARRATIVE_RULES) expect(NARRATIVE_IDS).toContain(rule.narrative);
    expect(new Set(SECTOR_RULES.map((r) => r.sector)).size).toBe(SECTOR_RULES.length);
  });

  it('keeps the deposit-or-fee sectors the unmapped report covers', () => {
    expect([...DEPOSIT_OR_FEE_SECTORS].sort()).toEqual(
      ['ai', 'bank', 'networks', 'payments', 'platforms', 'real', 'scaling'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// sectorMap
// ---------------------------------------------------------------------------

describe('sectorMap: CoinGecko and DefiLlama category -> sector', () => {
  it('maps CoinGecko categories to sectors', () => {
    const sector = (c: string[]) => mapSector({ coingeckoCategories: c }).sectorId;
    expect(sector(['Layer 2 (L2)'])).toBe('scaling');
    expect(sector(['Smart Contract Platform', 'Layer 1 (L1)'])).toBe('platforms');
    expect(sector(['Oracle'])).toBe('real');
    expect(sector(['Payment Solutions'])).toBe('payments');
    expect(sector(['Decentralized Exchange (DEX)'])).toBe('bank');
    expect(sector(['Privacy Coins'])).toBe('infra');
    expect(sector(['DePIN'])).toBe('networks');
    expect(sector(['Gaming (GameFi)'])).toBe('games');
    expect(sector(['Tokenized Gold'])).toBe('gold');
    expect(sector(['Meme'])).toBe('culture');
    expect(sector(['Artificial Intelligence (AI)'])).toBe('ai');
  });

  it('matches names case-insensitively and ignores blanks', () => {
    expect(mapSector({ coingeckoCategories: ['  layer 2 (l2) '] }).sectorId).toBe('scaling');
    expect(mapSector({ coingeckoCategories: ['', '   '] }).sectorId).toBeNull();
  });

  it('applies the specific-sector-first priority', () => {
    // An AI token that is also DePIN is ai; a meme token that is also a platform is culture.
    expect(
      mapSector({ coingeckoCategories: ['DePIN', 'Artificial Intelligence (AI)'] }).sectorId,
    ).toBe('ai');
    expect(mapSector({ coingeckoCategories: ['Smart Contract Platform', 'Meme'] }).sectorId).toBe(
      'culture',
    );
    expect(mapSector({ coingeckoCategories: ['AI Meme'] }).sectorId).toBe('culture');
    expect(
      mapSector({ coingeckoCategories: ['Layer 2 (L2)', 'Smart Contract Platform'] }).sectorId,
    ).toBe('scaling');
  });

  it('maps the DefiLlama category when CoinGecko gives nothing', () => {
    const r = mapSector({ coingeckoCategories: [], defillamaCategory: 'Lending' });
    expect(r).toEqual({ sectorId: 'bank', basis: 'defillama', matchedCategory: 'Lending' });
    expect(mapSector({ coingeckoCategories: [], defillamaCategory: 'Bridge' }).sectorId).toBe(
      'infra',
    );
    expect(mapSector({ coingeckoCategories: [], defillamaCategory: 'Chain' }).sectorId).toBe(
      'platforms',
    );
  });

  it('treats a DefiLlama chain as a platform only as the last resort', () => {
    expect(mapSector({ coingeckoCategories: [], isDefillamaChain: true })).toEqual({
      sectorId: 'platforms',
      basis: 'defillama-chain',
      matchedCategory: null,
    });
    expect(
      mapSector({ coingeckoCategories: ['Layer 2 (L2)'], isDefillamaChain: true }).sectorId,
    ).toBe('scaling');
  });

  it('returns null when nothing matches', () => {
    expect(mapSector({ coingeckoCategories: ['Fan Token'] })).toEqual({
      sectorId: null,
      basis: null,
      matchedCategory: null,
    });
  });

  it('gives narratives many-to-many, in canonical order', () => {
    const narratives = mapNarratives({
      coingeckoCategories: ['Real World Assets (RWA)', 'Oracle', 'Solana Ecosystem', 'Perpetuals'],
    });
    expect(narratives).toEqual(['rwa', 'perps', 'solana', 'oracles']);
    expect(NARRATIVE_IDS.indexOf('rwa')).toBeLessThan(NARRATIVE_IDS.indexOf('oracles'));
    expect(
      mapNarratives({ coingeckoCategories: [], defillamaCategory: 'Liquid Restaking' }),
    ).toEqual(['restake']);
  });

  it('never invents revenue or fastl1 automatically', () => {
    for (const rule of NARRATIVE_RULES) {
      expect(['revenue', 'fastl1']).not.toContain(rule.narrative);
    }
  });
});

// ---------------------------------------------------------------------------
// overrides.json
// ---------------------------------------------------------------------------

describe('overrides.json and the 114-coin Score Lab seed', () => {
  const seed = Object.entries(DEFAULT_OVERRIDES.sampleSeed);

  it('has all 114 sample coins, each with a distinct CoinGecko id', () => {
    expect(seed).toHaveLength(114);
    expect(new Set(seed.map(([id]) => id)).size).toBe(114);
    for (const [id] of seed) expect(id).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
  });

  it('carries the user assignments exactly as in the sample universe (sector, chain, narratives)', () => {
    const rows = readAssignments();
    expect(rows).toHaveLength(114);
    expect(seed.map(([, e]) => e.symbol)).toEqual(rows.map((r) => r.symbol));
    seed.forEach(([id, entry], i) => {
      const row = rows[i];
      expect(row, id).toBeDefined();
      expect(entry.name, id).toBe(row?.name);
      expect(entry.sectorId, id).toBe(row?.sector_id);
      expect(entry.chain, id).toBe(row?.chain);
      expect([...entry.narrativeIds], id).toEqual(row?.narrative_ids);
    });
  });

  it('resolves PAXG and XAUT to the gold-token ids', () => {
    const bySymbol = Object.fromEntries(seed.map(([id, e]) => [e.symbol, id]));
    expect(bySymbol['PAXG']).toBe('pax-gold');
    expect(bySymbol['XAUT']).toBe('tether-gold');
  });

  it('rejects invalid files with the offending path', () => {
    const good = {
      sampleSeed: {
        bitcoin: {
          symbol: 'BTC',
          name: 'Bitcoin',
          sectorId: 'gold',
          chain: null,
          narrativeIds: [],
        },
      },
      coins: {},
    };
    expect(() => parseOverrides(good)).not.toThrow();
    const withCoin = (coin: unknown) => ({ ...good, coins: { bitcoin: coin } });
    expect(() =>
      parseOverrides({
        ...good,
        sampleSeed: { x: { ...good.sampleSeed.bitcoin, sectorId: 'defi' } },
      }),
    ).toThrow(/sampleSeed\.x\.sectorId/);
    expect(() => parseOverrides(withCoin({ narrativeIds: ['memes', 'nope'] }))).toThrow(
      /coins\.bitcoin\.narrativeIds\[1\]/,
    );
    expect(() => parseOverrides(withCoin({ narrativeIds: ['memes', 'memes'] }))).toThrow(
      /duplicate/,
    );
    expect(() => parseOverrides(withCoin({ include: true, exclude: true }))).toThrow(/cannot both/);
    expect(() => parseOverrides(withCoin({ genesisDate: '2009-13-45' }))).toThrow(/genesisDate/);
    expect(() => parseOverrides(withCoin({ githubRepos: ['https://github.com/bitcoin'] }))).toThrow(
      /githubRepos/,
    );
    expect(() => parseOverrides(withCoin({ defillamaSlug: 3 }))).toThrow(/defillamaSlug/);
    expect(() => parseOverrides({ sampleSeed: {} })).toThrow(/coins/);
  });
});

// ---------------------------------------------------------------------------
// Acceptance: all 114 sample coins resolve
// ---------------------------------------------------------------------------

describe('acceptance: all 114 sample coins resolve to a coingecko_id and to their assignments', () => {
  const result = buildUniverse(input());
  const rows = readAssignments();

  it('builds an asset for every sample coin, keyed by its coingecko_id', () => {
    const ids = Object.keys(DEFAULT_OVERRIDES.sampleSeed);
    expect(ids).toHaveLength(114);
    for (const id of ids) {
      const asset = assetOf(result, id);
      expect(asset.coingeckoId).toBe(id);
      expect(asset.id).toBe(id);
      expect(asset.active).toBe(true);
      expect(asset.delistedAt).toBeNull();
    }
  });

  it('gives each one the sector, chain and narratives from the sample file', () => {
    Object.keys(DEFAULT_OVERRIDES.sampleSeed).forEach((id, i) => {
      const asset = assetOf(result, id);
      expect(asset.sectorId, id).toBe(rows[i]?.sector_id);
      expect(asset.chain, id).toBe(rows[i]?.chain);
      expect([...asset.narrativeIds], id).toEqual(rows[i]?.narrative_ids);
    });
  });

  it('only uses ids the database knows', () => {
    for (const asset of result.assets) {
      expect(SECTOR_IDS).toContain(asset.sectorId);
      for (const n of asset.narrativeIds) expect(NARRATIVE_IDS).toContain(n);
    }
  });

  it('lets the sample assignment win over the automatic mapping', () => {
    // CoinGecko calls this one a meme and an NFT project; the user put it in games.
    expect(
      mapSector({ coingeckoCategories: DETAILS['pudgy-penguins']?.categories as string[] })
        .sectorId,
    ).toBe('culture');
    const penguin = assetOf(result, 'pudgy-penguins');
    expect(penguin.sectorId).toBe('games');
    expect([...penguin.narrativeIds]).toEqual(['solana', 'memes']);
    expect(penguin.isMeme).toBe(false);
    // An empty narrative list in the sample is the user's choice too.
    expect(assetOf(result, 'bitcoin-cash').narrativeIds).toEqual([]);
  });

  it('takes symbol and name from CoinGecko, so a rename shows up', () => {
    const ton = assetOf(result, 'the-open-network');
    expect(DEFAULT_OVERRIDES.sampleSeed['the-open-network']?.symbol).toBe('TON');
    expect(ton.symbol).toBe(MARKETS.find((m) => m.id === 'the-open-network')?.symbol.toUpperCase());
  });
});

// ---------------------------------------------------------------------------
// Universe filter: exclusions, floor, gold tokens
// ---------------------------------------------------------------------------

describe('universe filter', () => {
  const result = buildUniverse(input());
  const ids = new Set(result.assets.map((a) => a.id));
  const reason = (id: string) => result.excluded.find((e) => e.id === id)?.reason;

  it('excludes stablecoins and lists them separately', () => {
    expect(reason('tether')).toBe('stablecoin');
    expect(reason('usd-coin')).toBe('stablecoin');
    expect(ids.has('tether')).toBe(false);
    expect(result.stablecoins.map((s) => s.coingeckoId)).toEqual(['tether', 'usd-coin']);
    expect(result.stablecoins[0]).toMatchObject({ symbol: 'USDT', name: 'Tether' });
  });

  it('excludes wrapped, bridged and liquid-staking receipt tokens', () => {
    expect(reason('wrapped-bitcoin')).toBe('wrapped-or-bridged');
    expect(reason('staked-ether')).toBe('wrapped-or-bridged');
    expect(reason('sample-bridged-token')).toBe('wrapped-or-bridged');
    for (const id of ['wrapped-bitcoin', 'staked-ether', 'sample-bridged-token']) {
      expect(ids.has(id)).toBe(false);
    }
  });

  it('excludes exchange IOU and peg tokens', () => {
    expect(reason('binance-peg-ethereum')).toBe('exchange-iou');
    expect(reason('sample-iou-token')).toBe('exchange-iou');
  });

  it('keeps a project own token even when its category mentions staking or stablecoins', () => {
    const cfg = DEFAULT_UNIVERSE_CONFIG;
    const cls = (categories: string[]) =>
      classifyCandidate('x', detail('x', categories), NO_SEED, cfg).reason;
    expect(cls(['Liquid Staking Governance Tokens'])).toBeNull();
    expect(cls(['Stablecoin Issuer'])).toBeNull();
    expect(cls(['Liquid Staked ETH'])).toBe('wrapped-or-bridged');
    expect(cls(['Algorithmic Stablecoin'])).toBe('stablecoin');
    expect(cls(['Stablecoins', 'Bridged-Tokens'])).toBe('stablecoin');
  });

  it('never excludes a Score Lab sample coin as a stablecoin or wrapped token', () => {
    // The Ethena token carries a stablecoin category in the fixture; it is in the user list.
    expect(DETAILS['ethena']?.categories).toContain('Yield-Bearing Stablecoin');
    expect(ids.has('ethena')).toBe(true);
    const without = buildUniverse(input({ overrides: NO_SEED }));
    expect(without.excluded.find((e) => e.id === 'ethena')?.reason).toBe('stablecoin');
  });

  it('applies the 0.1% floor on 7-day average volume / market cap (G2 gates at 0.3% later)', () => {
    expect(UNIVERSE_VOLUME_FLOOR_RATIO).toBe(0.001);
    expect(UNIVERSE_VOLUME_FLOOR_RATIO).toBeLessThan(0.003);
    expect(reason('sample-thin-coin')).toBe('low-volume');
    expect(ids.has('sample-thin-coin')).toBe(false);
    const cap = 1_000_000;
    const run = (volume: number) =>
      buildUniverse(
        input({
          markets: [market('edge', 1, cap, 0)],
          details: { edge: detail('edge', ['Smart Contract Platform']) },
          volume7dAvg: { edge: volume },
          overrides: NO_SEED,
        }),
      );
    expect(run(1000).assets.map((a) => a.id)).toEqual(['edge']); // exactly 0.1%: kept
    expect(run(999.9).excluded.map((e) => e.reason)).toEqual(['low-volume']);
  });

  it('judges volume on the 7-day average, not on 24h volume', () => {
    // 24h volume is high, the 7-day average is low: excluded.
    const r = buildUniverse(
      input({
        markets: [market('spiky', 1, 1_000_000, 500_000)],
        details: { spiky: detail('spiky', ['Layer 1 (L1)']) },
        volume7dAvg: { spiky: 100 },
        overrides: NO_SEED,
      }),
    );
    expect(r.excluded[0]?.reason).toBe('low-volume');
  });

  it('falls back to 24h volume when there is no 7-day series, and says so', () => {
    const asset = assetOf(result, 'sample-fallback-volume');
    expect(asset.sectorId).toBe('platforms');
    expect(result.notes.find((n) => n.id === 'sample-fallback-volume')?.volumeBasis).toBe(
      '24h-fallback',
    );
    expect(result.notes.find((n) => n.id === 'bitcoin')?.volumeBasis).toBe('7d');
  });

  it('excludes a coin with no market cap', () => {
    expect(reason('sample-no-cap')).toBe('no-market-cap');
  });

  it('keeps gold tokens, flags them, and does not apply the stablecoin or volume filters', () => {
    // CoinGecko files PAXG and XAUT under a stablecoin category in the fixture.
    expect(DETAILS['pax-gold']?.categories).toContain('Commodity-backed Stablecoin');
    for (const id of ['pax-gold', 'tether-gold']) {
      const asset = assetOf(result, id);
      expect(asset.isGoldToken, id).toBe(true);
      expect(asset.sectorId, id).toBe('gold');
    }
    // Zero volume does not remove them.
    const thin = buildUniverse(
      input({ volume7dAvg: { ...VOLUMES, 'pax-gold': 0, 'tether-gold': 0 } }),
    );
    expect(assetOf(thin, 'pax-gold').isGoldToken).toBe(true);
    expect(thin.notes.find((n) => n.id === 'pax-gold')?.volumeBasis).toBe('not-applied');
    // Detected from the category too, not only from the id list.
    expect(assetOf(result, 'sample-gold-token').isGoldToken).toBe(true);
    // Nothing else is flagged.
    const flagged = result.assets.filter((a) => a.isGoldToken).map((a) => a.id);
    expect(flagged.sort()).toEqual(['pax-gold', 'sample-gold-token', 'tether-gold']);
  });

  it('lets a manual exclude win over everything, and a manual include pin past the rank cut', () => {
    const excluded = buildUniverse(
      input({ overrides: { ...DEFAULT_OVERRIDES, coins: { 'pax-gold': { exclude: true } } } }),
    );
    expect(excluded.excluded.find((e) => e.id === 'pax-gold')?.reason).toBe('override-exclude');
    expect(excluded.assets.some((a) => a.id === 'pax-gold')).toBe(false);

    const markets = ['a', 'b', 'c', 'd'].map((id, i) => market(id, i + 1, 1_000_000, 50_000));
    const details = Object.fromEntries(markets.map((m) => [m.id, detail(m.id, ['Layer 1 (L1)'])]));
    const cut = buildUniverse(
      input({
        markets,
        details,
        volume7dAvg: {},
        overrides: { sampleSeed: {}, coins: { d: { include: true } } },
        config: { universeSize: 2 },
      }),
    );
    expect(cut.assets.map((a) => a.id)).toEqual(['a', 'b', 'd']);
    expect(cut.excluded).toEqual([
      expect.objectContaining({ id: 'c', reason: 'beyond-universe-size' }),
    ]);
  });

  it('keeps the top 300 by default and drops the rest by rank', () => {
    expect(DEFAULT_UNIVERSE_CONFIG.universeSize).toBe(300);
    const markets = Array.from({ length: 320 }, (_, i) =>
      market(`c${i + 1}`, i + 1, 1_000_000, 50_000),
    );
    const details = Object.fromEntries(markets.map((m) => [m.id, detail(m.id, ['Layer 1 (L1)'])]));
    const r = buildUniverse(input({ markets, details, volume7dAvg: {}, overrides: NO_SEED }));
    expect(r.assets).toHaveLength(300);
    expect(r.excluded.filter((e) => e.reason === 'beyond-universe-size')).toHaveLength(20);
    expect(r.assets[299]?.id).toBe('c300');
  });

  it('computes the ratio defensively', () => {
    expect(volumeToMarketCapRatio(10, 1000)).toBe(0.01);
    expect(volumeToMarketCapRatio(10, 0)).toBeNull();
    expect(volumeToMarketCapRatio(10, null)).toBeNull();
    expect(volumeToMarketCapRatio(null, 100)).toBeNull();
    expect(volumeToMarketCapRatio(-1, 100)).toBeNull();
    expect(volumeToMarketCapRatio(Number.NaN, 100)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gate G5
// ---------------------------------------------------------------------------

describe('G5: is_meme follows the culture sector', () => {
  const result = buildUniverse(input());

  it('is true exactly when the sector is culture', () => {
    for (const asset of result.assets) {
      expect(asset.isMeme, asset.id).toBe(asset.sectorId === 'culture');
    }
    expect(assetOf(result, 'dogecoin').isMeme).toBe(true);
    expect(assetOf(result, 'bitcoin').isMeme).toBe(false);
  });

  it('flags an automatically classified meme token and leaves a user override in charge', () => {
    const auto = buildUniverse(input({ overrides: NO_SEED }));
    expect(assetOf(auto, 'sample-meme-token')).toMatchObject({
      sectorId: 'culture',
      isMeme: true,
      narrativeIds: ['memes'],
    });
    const forced = buildUniverse(
      input({
        overrides: { sampleSeed: {}, coins: { 'sample-meme-token': { sectorId: 'games' } } },
      }),
    );
    expect(assetOf(forced, 'sample-meme-token').isMeme).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mapping: DefiLlama, GitHub, genesis
// ---------------------------------------------------------------------------

describe('mapping to DefiLlama protocol and chain', () => {
  const result = buildUniverse(input({ overrides: NO_SEED }));
  const note = (id: string) => result.notes.find((n) => n.id === id);

  it('matches by gecko_id first', () => {
    expect(assetOf(result, 'lido-dao').defillamaSlug).toBe('lido');
    expect(note('lido-dao')?.protocolMatch).toBe('gecko_id');
    expect(assetOf(result, 'hyperliquid')).toMatchObject({
      defillamaSlug: 'hyperliquid-perps',
      defillamaChain: 'Hyperliquid L1',
    });
    expect(assetOf(result, 'ethereum').defillamaChain).toBe('Ethereum');
    expect(note('ethereum')?.chainMatch).toBe('gecko_id');
  });

  it('uses the parent project when versions share one, and when only a version has the gecko_id', () => {
    // Uniswap V2 and V3 carry no gecko_id; the parent project does.
    expect(assetOf(result, 'uniswap').defillamaSlug).toBe('uniswap');
    expect(note('uniswap')?.protocolMatch).toBe('gecko_id');
    // Only Aave V2 carries the gecko_id; the project slug is still the parent.
    expect(assetOf(result, 'aave').defillamaSlug).toBe('aave');
  });

  it('prefers the chain with the most TVL when several share a gas token', () => {
    expect(assetOf(result, 'binancecoin').defillamaChain).toBe('BSC');
  });

  it('does not map a coin to a foundation, an exchange or a canonical bridge', () => {
    expect(assetOf(result, 'ethereum').defillamaSlug).toBeNull(); // Ethereum Foundation
    expect(assetOf(buildUniverse(input()), 'okb').defillamaSlug).toBeNull(); // OKX (exchange)
    expect(assetOf(result, 'arbitrum').defillamaSlug).toBeNull(); // canonical bridge
  });

  it('falls back to symbol + name fuzzy matching, and reports those matches for review', () => {
    expect(assetOf(result, 'raydium').defillamaSlug).toBe('raydium');
    expect(note('raydium')?.protocolMatch).toBe('fuzzy');
    // Two versions of one parent: the parent slug.
    expect(assetOf(result, 'sample-fuzzy-protocol').defillamaSlug).toBe('sample-fuzz');
    // Fuzzy chain match on token symbol + name.
    expect(assetOf(result, 'sample-fuzzy-chain').defillamaChain).toBe('Sample Fuzzy');
    expect(note('sample-fuzzy-chain')?.chainMatch).toBe('fuzzy');
    const fuzzyIds = result.fuzzyMatches.map((m) => m.id);
    expect(fuzzyIds).toEqual(
      expect.arrayContaining(['raydium', 'sample-fuzzy-protocol', 'sample-fuzzy-chain']),
    );
    expect(fuzzyIds).not.toContain('lido-dao');
  });

  it('does not fuzzy-match an entry that already belongs to another coin', () => {
    const r = buildUniverse(
      input({
        overrides: NO_SEED,
        markets: [market('other-coin', 1, 1_000_000, 50_000)],
        details: { 'other-coin': detail('other-coin', ['Layer 1 (L1)']) },
        protocols: [
          {
            name: 'Other Coin',
            slug: 'other-coin',
            symbol: 'OTHE',
            gecko_id: 'some-different-coin',
            category: 'Dexs',
            tvl: 1,
          },
        ],
        parentProtocols: [],
        chains: [],
      }),
    );
    expect(assetOf(r, 'other-coin').defillamaSlug).toBeNull();
  });

  it('lets overrides win over every automatic match', () => {
    // Automatic: the fuzzy match finds an unrelated small DEX named like Solana.
    expect(assetOf(result, 'solana').defillamaSlug).toBe('solana-farm');
    // The bundled override blocks it.
    const bundled = buildUniverse(input());
    expect(assetOf(bundled, 'solana').defillamaSlug).toBeNull();
    expect(assetOf(bundled, 'solana').defillamaChain).toBe('Solana');
    // An explicit slug and chain replace the automatic ones.
    const custom = buildUniverse(
      input({
        overrides: {
          sampleSeed: {},
          coins: {
            'lido-dao': { defillamaSlug: 'lido-custom', defillamaChain: 'Custom Chain' },
            ethereum: { defillamaChain: null },
          },
        },
      }),
    );
    expect(assetOf(custom, 'lido-dao')).toMatchObject({
      defillamaSlug: 'lido-custom',
      defillamaChain: 'Custom Chain',
    });
    expect(custom.notes.find((n) => n.id === 'lido-dao')?.protocolMatch).toBe('override');
    expect(assetOf(custom, 'ethereum').defillamaChain).toBeNull();
  });

  it('normalises names for fuzzy matching', () => {
    expect(normalizeName('Uniswap V3')).toBe('uniswap');
    expect(normalizeName('Curve DAO')).toBe('curve');
    expect(normalizeName('ether.fi')).toBe('etherfi');
    expect(normalizeName('Network')).toBe('network');
  });
});

describe('GitHub repos and genesis date', () => {
  const result = buildUniverse(input());

  it('reads repos from CoinGecko links.repos_url.github as owner/repo', () => {
    expect([...assetOf(result, 'bitcoin').githubRepos]).toEqual([
      'bitcoin/bitcoin',
      'bitcoin/bips',
    ]);
    // The organisation-only URL and the empty string are dropped; a trailing slash is fine.
    expect([...assetOf(result, 'ethereum').githubRepos]).toEqual([
      'ethereum/go-ethereum',
      'ethereum/solidity',
    ]);
    expect(assetOf(result, 'dogecoin').githubRepos).toEqual([]);
  });

  it('adds override repos first and removes duplicates regardless of case', () => {
    const r = buildUniverse(
      input({
        overrides: {
          ...DEFAULT_OVERRIDES,
          coins: {
            bitcoin: { githubRepos: ['Bitcoin/Bitcoin', 'bitcoin-core/gui'] },
          },
        },
      }),
    );
    expect([...assetOf(r, 'bitcoin').githubRepos]).toEqual([
      'Bitcoin/Bitcoin',
      'bitcoin-core/gui',
      'bitcoin/bips',
    ]);
  });

  it('parses GitHub URLs', () => {
    expect(parseGithubRepo('https://github.com/a/b')).toBe('a/b');
    expect(parseGithubRepo('http://www.github.com/a/b.git')).toBe('a/b');
    expect(parseGithubRepo('https://github.com/a/b/tree/main/x')).toBe('a/b');
    expect(parseGithubRepo('a/b')).toBe('a/b');
    expect(parseGithubRepo('https://github.com/a')).toBeNull();
    expect(parseGithubRepo('https://gitlab.com/a/b')).toBeNull();
    expect(parseGithubRepo('')).toBeNull();
    expect(parseGithubRepo(null)).toBeNull();
  });

  it('takes the genesis date from CoinGecko, an override wins, bad values give null', () => {
    expect(assetOf(result, 'bitcoin').genesisDate).toBe('2009-01-03');
    expect(assetOf(result, 'ethereum').genesisDate).toBe('2015-07-30');
    expect(assetOf(result, 'dogecoin').genesisDate).toBeNull();
    const r = buildUniverse(
      input({
        overrides: { ...DEFAULT_OVERRIDES, coins: { dogecoin: { genesisDate: '2013-12-06' } } },
      }),
    );
    expect(assetOf(r, 'dogecoin').genesisDate).toBe('2013-12-06');
    expect(normalizeDate('2009-01-03T00:00:00.000Z')).toBe('2009-01-03');
    expect(normalizeDate('2009-02-30')).toBeNull();
    expect(normalizeDate('soon')).toBeNull();
    expect(normalizeDate(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sector precedence
// ---------------------------------------------------------------------------

describe('sector precedence: override > sample seed > automatic > previous > unclassified', () => {
  const auto = buildUniverse(input({ overrides: NO_SEED }));

  it('maps automatically from CoinGecko and DefiLlama categories', () => {
    expect(assetOf(auto, 'sample-dex-token')).toMatchObject({ sectorId: 'bank' });
    expect(assetOf(auto, 'sample-l2-token')).toMatchObject({
      sectorId: 'scaling',
      narrativeIds: ['modular'],
    });
    // No CoinGecko category: the DefiLlama category decides.
    expect(assetOf(auto, 'sample-fuzzy-protocol').sectorId).toBe('bank');
    // No category at all, but a DefiLlama chain: platform.
    expect(assetOf(auto, 'sample-chain-token').sectorId).toBe('platforms');
    expect(assetOf(auto, 'sample-fuzzy-chain').sectorId).toBe('platforms');
    expect(auto.notes.find((n) => n.id === 'sample-dex-token')?.sectorSource).toBe('auto');
  });

  it('does not store a coin it cannot classify, and lists it', () => {
    expect(auto.assets.some((a) => a.id === 'sample-unclassified')).toBe(false);
    expect(auto.unclassified.map((u) => u.id)).toContain('sample-unclassified');
  });

  it('keeps the previous sector when the rules find nothing', () => {
    const previous: UniverseAsset = {
      ...assetOf(auto, 'sample-dex-token'),
      id: 'sample-unclassified',
      coingeckoId: 'sample-unclassified',
      sectorId: 'real',
    };
    const r = buildUniverse(input({ overrides: NO_SEED, previous: [previous] }));
    expect(assetOf(r, 'sample-unclassified').sectorId).toBe('real');
    expect(r.notes.find((n) => n.id === 'sample-unclassified')?.sectorSource).toBe('previous');
    expect(r.unclassified.map((u) => u.id)).not.toContain('sample-unclassified');
  });

  it('puts a manual override above the sample seed and the automatic mapping', () => {
    const r = buildUniverse(
      input({
        overrides: {
          ...DEFAULT_OVERRIDES,
          coins: {
            'sample-dex-token': { sectorId: 'real', narrativeIds: ['rwa', 'oracles'] },
            dogecoin: { sectorId: 'payments', narrativeIds: [] },
          },
        },
      }),
    );
    expect(assetOf(r, 'sample-dex-token')).toMatchObject({
      sectorId: 'real',
      narrativeIds: ['rwa', 'oracles'],
    });
    expect(assetOf(r, 'dogecoin')).toMatchObject({
      sectorId: 'payments',
      narrativeIds: [],
      isMeme: false,
    });
    expect(r.notes.find((n) => n.id === 'dogecoin')?.sectorSource).toBe('override');
    expect(buildUniverse(input()).notes.find((n) => n.id === 'dogecoin')?.sectorSource).toBe(
      'sample-seed',
    );
  });

  it('derives the chain label when neither override nor seed gives one', () => {
    expect(assetOf(auto, 'chainlink').chain).toBe('Ethereum');
    expect(assetOf(auto, 'render-token').chain).toBe('Solana');
    expect(assetOf(auto, 'bitcoin').chain).toBe('Own chain');
  });
});

// ---------------------------------------------------------------------------
// Never delete, delisted, diff
// ---------------------------------------------------------------------------

describe('never delete: dropped coins become inactive with delisted_at', () => {
  const first = buildUniverse(input());
  const stored = first.assets;

  it('marks a coin that left the candidate pool inactive, with the run time', () => {
    const markets = MARKETS.filter((m) => m.id !== 'kaspa');
    const r = buildUniverse(input({ markets, previous: stored }));
    expect(r.delist).toEqual([{ id: 'kaspa', delistedAt: ASOF }]);
    expect(r.assets.some((a) => a.id === 'kaspa')).toBe(false);
    expect(r.diff.removed).toEqual([
      { id: 'kaspa', symbol: 'KAS', reason: 'out-of-candidate-pool' },
    ]);
  });

  it('records why a coin dropped out when a filter removed it', () => {
    const thin = { ...VOLUMES, litecoin: 1 };
    const r = buildUniverse(input({ volume7dAvg: thin, previous: stored }));
    expect(r.diff.removed).toEqual([{ id: 'litecoin', symbol: 'LTC', reason: 'low-volume' }]);
    expect(r.delist.map((d) => d.id)).toEqual(['litecoin']);
  });

  it('accounts for every stored row: kept, delisted, or left alone. Nothing is dropped', () => {
    const markets = MARKETS.filter((m) => !['kaspa', 'monero'].includes(m.id));
    const details = { ...DETAILS };
    delete details['zcash'];
    const inactive: UniverseAsset = {
      ...assetOf(first, 'dash'),
      active: false,
      delistedAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    const previous = [...stored.filter((a) => a.id !== 'dash'), inactive];
    const r = buildUniverse(input({ markets, details, previous }));
    const kept = new Set(r.assets.map((a) => a.id));
    const delisted = new Set(r.delist.map((d) => d.id));
    const untouched = new Set([...r.incomplete]);
    for (const row of previous) {
      const accounted = kept.has(row.id) || delisted.has(row.id) || untouched.has(row.id);
      expect(accounted, row.id).toBe(true);
    }
    expect([...delisted].sort()).toEqual(['kaspa', 'monero']);
    // The result has no operation that deletes a row.
    expect(Object.keys(r).sort()).toEqual(
      [
        'assets',
        'delist',
        'diff',
        'excluded',
        'fuzzyMatches',
        'incomplete',
        'notes',
        'seedNotInUniverse',
        'stablecoins',
        'unclassified',
        'unmappedReport',
      ].sort(),
    );
  });

  it('leaves a row alone when this run lacked the data to judge it', () => {
    const details = { ...DETAILS };
    delete details['zcash'];
    const r = buildUniverse(input({ details, previous: stored }));
    expect(r.incomplete).toContain('zcash');
    expect(r.delist.map((d) => d.id)).not.toContain('zcash');
    expect(r.assets.some((a) => a.id === 'zcash')).toBe(false);
  });

  it('does not touch a coin that is already inactive and still out', () => {
    const inactive: UniverseAsset = {
      ...assetOf(first, 'dash'),
      active: false,
      delistedAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    const markets = MARKETS.filter((m) => m.id !== 'dash');
    const r = buildUniverse(
      input({ markets, previous: [...stored.filter((a) => a.id !== 'dash'), inactive] }),
    );
    expect(r.delist.map((d) => d.id)).not.toContain('dash');
    expect(r.diff.removed.map((d) => d.id)).not.toContain('dash');
  });

  it('reactivates a coin that returns, clearing delisted_at', () => {
    const inactive: UniverseAsset = {
      ...assetOf(first, 'dash'),
      active: false,
      delistedAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    const r = buildUniverse(
      input({ previous: [...stored.filter((a) => a.id !== 'dash'), inactive] }),
    );
    expect(assetOf(r, 'dash')).toMatchObject({ active: true, delistedAt: null });
    expect(r.diff.reactivated).toEqual([{ id: 'dash', symbol: 'DASH' }]);
    expect(r.diff.added).toEqual([]);
  });

  it('refuses a run when too many candidates lack data', () => {
    const details: Record<string, CoinGeckoCoinDetail> = {};
    const r = buildUniverse(input({ details, previous: stored }));
    expect(r.incomplete.length).toBeGreaterThan(MARKETS.length * 0.2);
    expect(() => assertCompleteEnough(r, MARKETS.length)).toThrow(/Universe run refused/);
    const ok = buildUniverse(input());
    expect(() => assertCompleteEnough(ok, MARKETS.length)).not.toThrow();
    expect(() =>
      assertCompleteEnough({ incomplete: ['a'] }, 10, { maxIncompleteRatio: 0.1 }),
    ).not.toThrow();
    expect(() =>
      assertCompleteEnough({ incomplete: ['a', 'b'] }, 10, { maxIncompleteRatio: 0.1 }),
    ).toThrow();
  });
});

describe('diff: added, removed, remapped', () => {
  const first = buildUniverse(input());

  it('lists every coin as added on an empty database', () => {
    expect(first.diff.added).toHaveLength(first.assets.length);
    expect(first.diff.removed).toEqual([]);
    expect(first.diff.remapped).toEqual([]);
    expect(first.diff.added[0]).toHaveProperty('sectorId');
  });

  it('reports nothing on an identical second run', () => {
    const again = buildUniverse(input({ previous: first.assets }));
    expect(again.diff).toEqual({ added: [], removed: [], remapped: [], reactivated: [] });
    expect(again.delist).toEqual([]);
    for (const asset of again.assets) {
      const prev = first.assets.find((a) => a.id === asset.id);
      expect(prev && isAssetUnchanged(prev, asset), asset.id).toBe(true);
    }
  });

  it('reports a changed mapping as remapped, with before and after', () => {
    const tampered = first.assets.map((a) =>
      a.id === 'lido-dao' ? { ...a, defillamaSlug: 'old-slug', sectorId: 'infra' as const } : a,
    );
    const r = buildUniverse(input({ previous: tampered }));
    expect(r.diff.remapped).toEqual([
      {
        id: 'lido-dao',
        symbol: 'LDO',
        changes: [
          { field: 'defillamaSlug', from: 'old-slug', to: 'lido' },
          { field: 'sectorId', from: 'infra', to: 'bank' },
        ],
      },
    ]);
  });

  it('treats a reordered-equal list as unchanged and a different list as changed', () => {
    const a = assetOf(first, 'bitcoin');
    expect(mappingChanges(a, { ...a, narrativeIds: [...a.narrativeIds] })).toEqual([]);
    expect(mappingChanges(a, { ...a, narrativeIds: ['etf'] })).toEqual([
      { field: 'narrativeIds', from: ['etf', 'btcfi'], to: ['etf'] },
    ]);
  });

  it('adds a newly listed coin', () => {
    const without = first.assets.filter((a) => a.id !== 'popcat');
    const r = buildUniverse(input({ previous: without }));
    expect(r.diff.added).toEqual([{ id: 'popcat', symbol: 'POPCAT', sectorId: 'culture' }]);
  });
});

// ---------------------------------------------------------------------------
// Unmapped report
// ---------------------------------------------------------------------------

describe('report: assets in deposit-or-fee sectors lacking a DefiLlama mapping', () => {
  const result = buildUniverse(input());
  const ids = result.unmappedReport.map((e) => e.id);

  it('lists exactly the deposit-or-fee assets with neither a protocol nor a chain', () => {
    const expected = result.assets
      .filter(
        (a) =>
          DEPOSIT_OR_FEE_SECTORS.includes(a.sectorId) &&
          a.defillamaSlug === null &&
          a.defillamaChain === null,
      )
      .map((a) => a.id);
    expect([...ids].sort()).toEqual([...expected].sort());
    expect(ids.length).toBeGreaterThan(0);
  });

  it('includes a bank coin with no mapping and leaves out mapped ones', () => {
    expect(ids).toContain('polymesh'); // real sector, not in the fixture DefiLlama data
    expect(ids).not.toContain('uniswap'); // protocol mapped
    expect(ids).not.toContain('ethereum'); // chain mapped
    expect(ids).not.toContain('solana'); // chain mapped, protocol deliberately blocked
  });

  it('skips sectors that do not earn from deposits or fees', () => {
    for (const entry of result.unmappedReport) {
      expect(DEPOSIT_OR_FEE_SECTORS).toContain(entry.sectorId);
    }
    expect(ids).not.toContain('kaspa'); // gold
    expect(ids).not.toContain('monero'); // infra
    expect(ids).not.toContain('dogecoin'); // culture
    expect(ids).not.toContain('immutable-x'); // games
  });

  it('orders by sector, then rank, and carries what a human needs to fill an override', () => {
    const sectorIndex = result.unmappedReport.map((e) => SECTOR_IDS.indexOf(e.sectorId));
    expect([...sectorIndex]).toEqual([...sectorIndex].sort((a, b) => a - b));
    const bank = result.unmappedReport.filter((e) => e.sectorId === 'bank');
    const ranks = bank.map((e) => e.marketCapRank ?? Infinity);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(result.unmappedReport[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        symbol: expect.any(String),
        name: expect.any(String),
      }),
    );
  });

  it('formats a readable text report and says so when empty', () => {
    const text = formatUnmappedReport(result.unmappedReport);
    expect(text.split('\n')[0]).toContain(`(${result.unmappedReport.length})`);
    expect(text).toContain('polymesh');
    expect(formatUnmappedReport([])).toMatch(/none$/);
    expect(buildUnmappedReport([])).toEqual([]);
  });

  it('shrinks once a human fills the override', () => {
    const filled = buildUniverse(
      input({
        overrides: {
          ...DEFAULT_OVERRIDES,
          coins: { ...DEFAULT_OVERRIDES.coins, polymesh: { defillamaSlug: 'polymesh' } },
        },
      }),
    );
    expect(filled.unmappedReport.map((e) => e.id)).not.toContain('polymesh');
    expect(filled.unmappedReport).toHaveLength(result.unmappedReport.length - 1);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('gives the same result for the same input, whatever the input order', () => {
    const a = buildUniverse(input());
    const reversed = buildUniverse(
      input({
        markets: [...MARKETS].reverse(),
        protocols: [...PROTOCOLS].reverse(),
        parentProtocols: [...PARENTS].reverse(),
        chains: [...CHAINS].reverse(),
      }),
    );
    expect(reversed).toEqual(a);
    expect(JSON.stringify(buildUniverse(input()))).toBe(JSON.stringify(a));
  });

  it('never reads the clock: delistedAt is the injected time', () => {
    const first = buildUniverse(input());
    const at = new Date('2030-02-03T04:05:06.000Z');
    const r = buildUniverse(
      input({ asOf: at, markets: MARKETS.filter((m) => m.id !== 'kaspa'), previous: first.assets }),
    );
    expect(r.delist[0]?.delistedAt).toBe(at);
  });
});

// ---------------------------------------------------------------------------
// Sources: rate limit and retry with a fake clock
// ---------------------------------------------------------------------------

/**
 * A fake clock with real ordering: `sleep` parks the caller until the test advances time, and
 * `run` advances time to the next timer whenever everything is waiting. No real time passes.
 */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  const timers: Array<{ at: number; wake: () => void }> = [];
  return {
    now: () => t,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleeps.push(ms);
        timers.push({ at: t + ms, wake: resolve });
      }),
    sleeps,
    /** Settles `promise`, jumping the clock forward each time all work is waiting on a timer. */
    async run<T>(promise: Promise<T>): Promise<T> {
      let settled = false;
      const watched = promise.finally(() => {
        settled = true;
      });
      watched.catch(() => undefined);
      while (!settled) {
        await new Promise((resolve) => setImmediate(resolve));
        if (settled) break;
        timers.sort((x, y) => x.at - y.at);
        const next = timers.shift();
        if (!next) throw new Error('fake clock: nothing is waiting but the promise is pending');
        t = Math.max(t, next.at);
        next.wake();
      }
      return promise;
    },
  };
}

type Step =
  { status: number; body?: unknown; headers?: Record<string, string> } | { error: string };

function scriptedFetch(clock: ReturnType<typeof fakeClock>, steps: Step[]) {
  const calls: Array<{ url: string; headers: Record<string, string> | undefined; at: number }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers, at: clock.now() });
    const step = steps.shift();
    if (!step) throw new Error('script exhausted');
    if ('error' in step) throw new Error(step.error);
    const response: FetchResponseLike = {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: { get: (name) => step.headers?.[name.toLowerCase()] ?? null },
      json: async () => step.body,
    };
    return response;
  };
  return { fetch, calls };
}

function clientFor(
  clock: ReturnType<typeof fakeClock>,
  steps: Step[],
  config: Partial<HttpClientConfig> = {},
) {
  const scripted = scriptedFetch(clock, steps);
  const client = createHttpClient(
    { ...TEST_CONFIG, ...config },
    { fetch: scripted.fetch, now: clock.now, sleep: clock.sleep },
  );
  return { client, calls: scripted.calls };
}

const TEST_CONFIG: HttpClientConfig = {
  baseUrl: 'https://api.example.test',
  minIntervalMs: 1000,
  maxRetries: 3,
  baseBackoffMs: 500,
  maxBackoffMs: 4000,
  retryStatuses: [429, 500, 503],
};

describe('sources: rate limit and retry (fake clock)', () => {
  it('spaces requests by the minimum interval', async () => {
    const clock = fakeClock();
    const { client, calls } = clientFor(clock, [
      { status: 200, body: 1 },
      { status: 200, body: 2 },
      { status: 200, body: 3 },
    ]);
    expect(await clock.run(client.getJson('/a'))).toBe(1);
    expect(await clock.run(client.getJson('/b'))).toBe(2);
    expect(await clock.run(client.getJson('/c'))).toBe(3);
    expect(calls.map((c) => c.at)).toEqual([0, 1000, 2000]);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.example.test/a',
      'https://api.example.test/b',
      'https://api.example.test/c',
    ]);
  });

  it('keeps concurrent callers inside the limit too', async () => {
    const clock = fakeClock();
    const { client, calls } = clientFor(clock, [
      { status: 200, body: 'a' },
      { status: 200, body: 'b' },
      { status: 200, body: 'c' },
    ]);
    const out = await clock.run(
      Promise.all([client.getJson('/1'), client.getJson('/2'), client.getJson('/3')]),
    );
    expect(out).toEqual(['a', 'b', 'c']);
    expect(calls.map((c) => c.at)).toEqual([0, 1000, 2000]);
    expect(calls.map((c) => c.url.slice(-2))).toEqual(['/1', '/2', '/3']);
  });

  it('waits for Retry-After on a 429, then succeeds', async () => {
    const clock = fakeClock();
    const { client, calls } = clientFor(clock, [
      { status: 429, headers: { 'retry-after': '3' } },
      { status: 200, body: 'ok' },
    ]);
    expect(await clock.run(client.getJson('/x'))).toBe('ok');
    expect(calls.map((c) => c.at)).toEqual([0, 3000]);
    expect(clock.sleeps).toContain(3000);
  });

  it('caps an oversized Retry-After at the maximum backoff', async () => {
    const clock = fakeClock();
    const { client, calls } = clientFor(clock, [
      { status: 429, headers: { 'retry-after': '600' } },
      { status: 200, body: 'ok' },
    ]);
    await clock.run(client.getJson('/x'));
    expect(calls[1]?.at).toBe(4000);
  });

  it('backs off exponentially on server errors', async () => {
    const clock = fakeClock();
    const { client, calls } = clientFor(
      clock,
      [{ status: 500 }, { status: 503 }, { status: 200, body: 'ok' }],
      { minIntervalMs: 0 },
    );
    expect(await clock.run(client.getJson('/x'))).toBe('ok');
    expect(calls.map((c) => c.at)).toEqual([0, 500, 1500]); // waits 500, then 1000
  });

  it('stops after maxRetries and throws an error without headers or keys', async () => {
    const clock = fakeClock();
    const { client, calls } = clientFor(
      clock,
      [
        { status: 503 },
        { status: 503 },
        { status: 503 },
        { status: 503 },
        { status: 200, body: 'never reached' },
      ],
      { maxBackoffMs: 1500, headers: { 'x-cg-demo-api-key': 'SAMPLE_KEY_NOT_REAL' } },
    );
    const error = await clock.run(client.getJson('/x?q=1').catch((e: unknown) => e));
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(503);
    expect((error as HttpError).message).toBe('GET /x?q=1 failed with HTTP 503 after 4 attempt(s)');
    expect(calls).toHaveLength(4);
    expect(Math.max(...clock.sleeps)).toBeLessThanOrEqual(1500);
  });

  it('does not retry a client error', async () => {
    const clock = fakeClock();
    const { client, calls } = clientFor(clock, [{ status: 404 }, { status: 200, body: 'no' }]);
    await expect(clock.run(client.getJson('/missing'))).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(1);
  });

  it('retries a network failure without leaking its cause', async () => {
    const clock = fakeClock();
    const { client, calls } = clientFor(clock, [
      { error: 'socket hang up x-cg-demo-api-key=SAMPLE_KEY_NOT_REAL' },
      { status: 200, body: 'ok' },
    ]);
    expect(await clock.run(client.getJson('/x'))).toBe('ok');
    expect(calls).toHaveLength(2);

    const clock2 = fakeClock();
    const failing = clientFor(
      clock2,
      Array.from({ length: 4 }, () => ({ error: 'SAMPLE_KEY_NOT_REAL' })),
    );
    const error = await clock2.run(failing.client.getJson('/x').catch((e: unknown) => e));
    expect(String((error as Error).message)).toMatch(/network error after 4 attempt/);
    expect(String((error as Error).message)).not.toContain('SAMPLE_KEY_NOT_REAL');
  });

  it('sends the key only in a header, never in the URL', async () => {
    const clock = fakeClock();
    const scripted = scriptedFetch(clock, [{ status: 200, body: [] }]);
    const config = coingeckoConfigFromEnv({
      COINGECKO_API_KEY: 'SAMPLE_KEY_NOT_REAL',
      COINGECKO_PLAN: 'demo',
    });
    const client = createHttpClient(config, {
      fetch: scripted.fetch,
      now: clock.now,
      sleep: clock.sleep,
    });
    await clock.run(client.getJson('/coins/markets?vs_currency=usd'));
    expect(scripted.calls[0]?.headers).toEqual({ 'x-cg-demo-api-key': 'SAMPLE_KEY_NOT_REAL' });
    expect(scripted.calls[0]?.url).not.toContain('SAMPLE_KEY_NOT_REAL');
  });
});

describe('sources: configuration from the environment', () => {
  it('uses the public endpoint at its low limit without a key', () => {
    const c = coingeckoConfigFromEnv({});
    expect(c.baseUrl).toBe('https://api.coingecko.com/api/v3');
    expect(c.headers).toBeUndefined();
    expect(c.minIntervalMs).toBe(6500);
  });

  it('uses the demo header for the demo plan (and when the plan is unset)', () => {
    for (const env of [
      { COINGECKO_API_KEY: 'k', COINGECKO_PLAN: 'demo' },
      { COINGECKO_API_KEY: 'k' },
      { COINGECKO_API_KEY: 'k', COINGECKO_PLAN: 'unknown' },
    ]) {
      const c = coingeckoConfigFromEnv(env);
      expect(c.baseUrl).toBe('https://api.coingecko.com/api/v3');
      expect(c.headers).toEqual({ 'x-cg-demo-api-key': 'k' });
      expect(c.minIntervalMs).toBe(2100);
    }
  });

  it('uses the pro host and header for the paid plans, with a shorter interval', () => {
    const basic = coingeckoConfigFromEnv({ COINGECKO_API_KEY: 'k', COINGECKO_PLAN: 'Basic' });
    expect(basic.baseUrl).toBe('https://pro-api.coingecko.com/api/v3');
    expect(basic.headers).toEqual({ 'x-cg-pro-api-key': 'k' });
    expect(basic.minIntervalMs).toBe(300);
    expect(
      coingeckoConfigFromEnv({ COINGECKO_API_KEY: 'k', COINGECKO_PLAN: 'analyst' }).minIntervalMs,
    ).toBe(150);
    // A paid plan without a key falls back to the public endpoint.
    expect(coingeckoConfigFromEnv({ COINGECKO_PLAN: 'analyst' }).baseUrl).toBe(
      'https://api.coingecko.com/api/v3',
    );
  });

  it('lets the caller override the limits', () => {
    const c = coingeckoConfigFromEnv(
      { COINGECKO_API_KEY: 'k' },
      { minIntervalMs: 50, maxRetries: 1 },
    );
    expect(c).toMatchObject({ minIntervalMs: 50, maxRetries: 1 });
    expect(defillamaConfig({ minIntervalMs: 0 }).minIntervalMs).toBe(0);
    expect(defillamaConfig().baseUrl).toBe('https://api.llama.fi');
    expect(defillamaConfig().headers).toBeUndefined();
  });
});

function fakeClient(routes: (path: string) => unknown): HttpClient & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    async getJson<T>(path: string): Promise<T> {
      paths.push(path);
      return routes(path) as T;
    },
  };
}

describe('sources: fetchers', () => {
  it('computes a 7-day average from whole days', () => {
    // 8 daily points: the last is today and partial, so the mean covers the first 7.
    const series = Array.from({ length: 8 }, (_, i): [number, number] => [i, (i + 1) * 100]);
    expect(averageDailyVolume(series)).toBe(400);
    expect(averageDailyVolume(series.slice(0, 3))).toBe(200);
    expect(averageDailyVolume([])).toBeNull();
    expect(averageDailyVolume([[0, Number.NaN]])).toBeNull();
  });

  it('reads the volume series of one coin', async () => {
    const client = fakeClient(() => ({
      total_volumes: [
        [0, 10],
        [1, 30],
      ],
    }));
    expect(await fetchVolume7dAvg(client, 'a/b')).toBe(20);
    expect(client.paths[0]).toBe('/coins/a%2Fb/market_chart?vs_currency=usd&days=7&interval=daily');
    expect(
      await fetchVolume7dAvg(
        fakeClient(() => ({})),
        'x',
      ),
    ).toBeNull();
  });

  it('pages /coins/markets until the pool is full', async () => {
    const client = fakeClient((path) => {
      const page = Number(/&page=(\d+)/.exec(path)?.[1]);
      return page === 1 ? [{ id: 'a' }, { id: 'b' }] : [{ id: 'c' }, { id: 'd' }];
    });
    const rows = await fetchMarkets(client, { pool: 3, perPage: 2 });
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(client.paths).toHaveLength(2);
    expect(client.paths[0]).toContain('vs_currency=usd&order=market_cap_desc&per_page=2&page=1');
  });

  it('stops paging on a short page and rejects a non-array', async () => {
    const short = fakeClient(() => [{ id: 'a' }]);
    expect(await fetchMarkets(short, { pool: 10, perPage: 5 })).toHaveLength(1);
    expect(short.paths).toHaveLength(1);
    await expect(fetchMarkets(fakeClient(() => ({ status: 'error' })))).rejects.toThrow(
      /expected a JSON array/,
    );
  });

  it('gathers everything for buildUniverse: DefiLlama first, then per-coin calls, tolerating failures', async () => {
    const ids = ['bitcoin', 'tether', 'pax-gold', 'sample-thin-coin', 'ethereum'];
    const rows = MARKETS.filter((m) => ids.includes(m.id));
    const client = fakeClient((path) => {
      if (path.startsWith('/coins/markets')) return rows;
      if (path === '/protocols') return PROTOCOLS;
      if (path === '/lite/protocols2') return { parentProtocols: PARENTS, protocols: [] };
      if (path === '/v2/chains') return CHAINS;
      const chart = /^\/coins\/([^/?]+)\/market_chart/.exec(path);
      if (chart) {
        // Invented volumes: a normal series, and a very thin one for the thin-coin fixture.
        const thin = chart[1] === 'sample-thin-coin';
        return {
          total_volumes: [
            [0, thin ? 1 : 40_000_000],
            [1, thin ? 3 : 80_000_000],
          ],
        };
      }
      const id = /^\/coins\/([^/?]+)\?/.exec(path)?.[1] ?? '';
      if (id === 'ethereum') throw new Error('rate limited');
      return DETAILS[id];
    });
    const sources = await fetchUniverseSources({ coingecko: client, defillama: client });
    expect(client.paths[0]).toBe('/protocols');
    expect(client.paths.slice(0, 3)).toEqual(['/protocols', '/lite/protocols2', '/v2/chains']);
    expect(sources.failures).toEqual(['detail:ethereum']);
    expect(Object.keys(sources.details).sort()).toEqual([
      'bitcoin',
      'pax-gold',
      'sample-thin-coin',
      'tether',
    ]);
    // Volume is fetched only where the floor applies: not for a stablecoin, a gold token or a failed detail.
    expect(Object.keys(sources.volume7dAvg).sort()).toEqual(['bitcoin', 'sample-thin-coin']);
    expect(sources.volume7dAvg['bitcoin']).toBe(60_000_000);
    expect(sources.parentProtocols).toHaveLength(PARENTS.length);

    const result = buildUniverse({
      asOf: ASOF,
      markets: sources.markets,
      details: sources.details,
      volume7dAvg: sources.volume7dAvg,
      protocols: sources.protocols,
      parentProtocols: sources.parentProtocols,
      chains: sources.chains,
      previous: [],
    });
    expect(result.assets.map((a) => a.id).sort()).toEqual(['bitcoin', 'pax-gold']);
    expect(result.stablecoins.map((s) => s.coingeckoId)).toEqual(['tether']);
    expect(result.excluded.find((e) => e.id === 'sample-thin-coin')?.reason).toBe('low-volume');
    expect(result.incomplete).toEqual(['ethereum']);
  });

  it('skips the detail call for a manually excluded coin', async () => {
    const client = fakeClient((path) => {
      if (path.startsWith('/coins/markets')) return MARKETS.filter((m) => m.id === 'bitcoin');
      if (path === '/protocols') return [];
      if (path === '/lite/protocols2') return { parentProtocols: [] };
      if (path === '/v2/chains') return [];
      return {};
    });
    await fetchUniverseSources({
      coingecko: client,
      defillama: client,
      overrides: { sampleSeed: {}, coins: { bitcoin: { exclude: true } } },
    });
    expect(client.paths.some((p) => p.startsWith('/coins/bitcoin'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Review round 1 fixes (F1, F2, F4, F5, S1)
// ---------------------------------------------------------------------------

describe('F1: a failed 7-day volume call is incomplete, never a 24h fallback', () => {
  // 24h volume is far below the floor; a judgement on it would delist the coin.
  const lowSpot = market('thin24h', 1, 1_000_000, 10);
  const base = (over: Partial<BuildUniverseInput>) =>
    input({
      markets: [lowSpot],
      details: { thin24h: detail('thin24h', ['Layer 1 (L1)']) },
      volume7dAvg: {},
      overrides: NO_SEED,
      ...over,
    });
  const stored: UniverseAsset = {
    ...assetOf(buildUniverse(input()), 'bitcoin'),
    id: 'thin24h',
    coingeckoId: 'thin24h',
    sectorId: 'platforms',
  };

  it('leaves the stored row alone and counts the coin as incomplete', () => {
    const r = buildUniverse(base({ volumeFailed: ['thin24h'], previous: [stored] }));
    expect(r.incomplete).toEqual(['thin24h']);
    expect(r.delist).toEqual([]);
    expect(r.diff.removed).toEqual([]);
    expect(r.excluded).toEqual([]);
    expect(r.assets).toEqual([]);
  });

  it('still uses the 24h figure when the call succeeded but the series was empty', () => {
    const r = buildUniverse(base({ previous: [stored] }));
    expect(r.incomplete).toEqual([]);
    expect(r.excluded.map((e) => e.reason)).toEqual(['low-volume']);
    expect(r.delist.map((d) => d.id)).toEqual(['thin24h']);
  });

  it('counts failed calls towards the refusal limit', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const markets = ids.map((id, i) => market(id, i + 1, 1_000_000, 50_000));
    const details = Object.fromEntries(ids.map((id) => [id, detail(id, ['Layer 1 (L1)'])]));
    const r = buildUniverse(
      input({
        markets,
        details,
        volume7dAvg: {},
        volumeFailed: ids.slice(0, 3),
        overrides: NO_SEED,
      }),
    );
    expect(r.incomplete).toEqual(['c0', 'c1', 'c2']);
    expect(() => assertCompleteEnough(r, markets.length)).toThrow(/Universe run refused/);
  });

  it('does not apply to gold tokens, which skip the volume floor', () => {
    const r = buildUniverse(input({ volumeFailed: ['pax-gold'] }));
    expect(assetOf(r, 'pax-gold').isGoldToken).toBe(true);
    expect(r.incomplete).not.toContain('pax-gold');
  });

  it('is recorded by the fetcher: a failed call is listed, an empty series is not', async () => {
    const client = fakeClient((path) => {
      if (path.startsWith('/coins/markets')) {
        return MARKETS.filter((m) => ['bitcoin', 'litecoin', 'dogecoin'].includes(m.id));
      }
      if (path === '/protocols') return [];
      if (path === '/lite/protocols2') return { parentProtocols: [] };
      if (path === '/v2/chains') return [];
      const chart = /^\/coins\/([^/?]+)\/market_chart/.exec(path);
      if (chart?.[1] === 'bitcoin') throw new Error('rate limited');
      if (chart?.[1] === 'litecoin') return { total_volumes: [] };
      if (chart) return { total_volumes: [[0, 5]] };
      return DETAILS[/^\/coins\/([^/?]+)\?/.exec(path)?.[1] ?? ''];
    });
    const sources = await fetchUniverseSources({ coingecko: client, defillama: client });
    expect(sources.volumeFailed).toEqual(['bitcoin']);
    expect(sources.failures).toEqual(['volume:bitcoin']);
    expect(Object.keys(sources.volume7dAvg)).toEqual(['dogecoin']);
  });
});

describe('F2: unclassified coins are surfaced and do not use universe slots', () => {
  const exchangeToken = (id: string, rank: number) => ({
    row: market(id, rank, 1_000_000, 50_000),
    detail: detail(id, ['Exchange-based Tokens', 'Centralized Exchange (CEX) Token']),
  });
  const a = exchangeToken('cex-token', 1);
  const rest = ['b', 'c', 'd'].map((id, i) => ({
    row: market(id, i + 2, 1_000_000, 50_000),
    detail: detail(id, ['Layer 1 (L1)']),
  }));
  const all = [a, ...rest];
  const run = (size: number) =>
    buildUniverse(
      input({
        markets: all.map((x) => x.row),
        details: Object.fromEntries(all.map((x) => [x.row.id, x.detail])),
        volume7dAvg: {},
        overrides: NO_SEED,
        config: { universeSize: size },
      }),
    );

  it('records id, symbol, name, rank and categories, and invents no fallback sector', () => {
    const r = run(300);
    expect(r.assets.map((x) => x.id)).toEqual(['b', 'c', 'd']);
    expect(r.unclassified).toEqual([
      {
        id: 'cex-token',
        symbol: 'CEX-',
        name: 'cex-token',
        marketCapRank: 1,
        categories: ['Exchange-based Tokens', 'Centralized Exchange (CEX) Token'],
      },
    ]);
  });

  it('does not let a skipped coin take one of the universe slots', () => {
    const r = run(2);
    // The unclassified coin ranks first but the two slots go to the first two classified coins.
    expect(r.assets.map((x) => x.id)).toEqual(['b', 'c']);
    expect(r.excluded).toEqual([
      expect.objectContaining({ id: 'd', reason: 'beyond-universe-size' }),
    ]);
  });

  it('formats a human-readable section with the skipped count', () => {
    const text = formatUnclassifiedReport(run(300).unclassified);
    const [head, line] = text.split('\n');
    expect(head).toContain('Unclassified coins skipped (1)');
    expect(head).toContain('not counted against its size');
    expect(line).toContain('cex-token');
    expect(line).toContain('"cex-token"');
    expect(line).toContain('Exchange-based Tokens, Centralized Exchange (CEX) Token');
    expect(formatUnclassifiedReport([])).toBe('Unclassified coins skipped: none');
  });

  it('shows "none" for categories when CoinGecko gave none', () => {
    const r = buildUniverse(
      input({
        markets: [market('bare', 1, 1_000_000, 50_000)],
        details: { bare: detail('bare') },
        volume7dAvg: {},
        overrides: NO_SEED,
      }),
    );
    expect(formatUnclassifiedReport(r.unclassified)).toContain('categories: none');
  });
});

describe('F4: seed coins that are not in the universe are reported with a reason', () => {
  it('names the reason for each way a sample coin can be missing', () => {
    const markets = MARKETS.filter((m) => m.id !== 'kaspa');
    const details = { ...DETAILS };
    delete details['zcash'];
    const r = buildUniverse(
      input({
        markets,
        details,
        volume7dAvg: { ...VOLUMES, litecoin: 1 },
        config: { universeSize: 100 },
      }),
    );
    const reason = (id: string) => r.seedNotInUniverse.find((s) => s.id === id)?.reason;
    expect(reason('kaspa')).toBe('outside-candidate-pool');
    expect(reason('litecoin')).toBe('low-volume');
    expect(reason('zcash')).toBe('incomplete-data');
    expect(reason('popcat')).toBe('beyond-universe-size');
    expect(reason('bitcoin')).toBeUndefined();
    expect(r.seedNotInUniverse.every((s) => s.symbol !== '')).toBe(true);
  });

  it('formats one line and says none when every sample coin is in', () => {
    const full = buildUniverse(input());
    expect(full.seedNotInUniverse).toEqual([]);
    expect(formatSeedMissingLine(full.seedNotInUniverse)).toBe(
      'Seed coins not in the universe (0): none',
    );
    const line = formatSeedMissingLine([
      { id: 'kaspa', symbol: 'KAS', reason: 'outside-candidate-pool' },
      { id: 'litecoin', symbol: 'LTC', reason: 'low-volume' },
    ]);
    expect(line).toBe(
      'Seed coins not in the universe (2): kaspa (outside-candidate-pool), litecoin (low-volume)',
    );
    expect(line.includes('\n')).toBe(false);
  });

  it('reports a sample coin that is excluded as a manual exclude', () => {
    const r = buildUniverse(
      input({ overrides: { ...DEFAULT_OVERRIDES, coins: { kaspa: { exclude: true } } } }),
    );
    expect(r.seedNotInUniverse).toEqual([
      { id: 'kaspa', symbol: 'KAS', reason: 'override-exclude' },
    ]);
  });
});

describe('F5: a truncated markets pool is refused', () => {
  it('refuses a pool far below the requested size', () => {
    expect(() => assertPoolSize(40, 400)).toThrow(/Universe run refused: CoinGecko returned 40/);
    expect(() => assertPoolSize(299, 400)).toThrow(/fewer than 75%/);
  });

  it('accepts a pool at or above the minimum share', () => {
    expect(() => assertPoolSize(300, 400)).not.toThrow();
    expect(() => assertPoolSize(400, 400)).not.toThrow();
  });

  it('is configurable', () => {
    expect(DEFAULT_UNIVERSE_CONFIG.minPoolRatio).toBe(0.75);
    expect(() => assertPoolSize(40, 400, { minPoolRatio: 0.1 })).not.toThrow();
    expect(() => assertPoolSize(350, 400, { minPoolRatio: 0.95 })).toThrow();
  });
});

describe('S1: the category rules only list categories that can match', () => {
  it('lists no category that the universe filter already excludes', () => {
    const c = DEFAULT_UNIVERSE_CONFIG;
    const excludes = [
      ...c.stablecoinCategoryPatterns,
      ...c.wrappedCategoryPatterns,
      ...c.exchangeIouCategoryPatterns,
    ];
    const names = [
      ...SECTOR_RULES.flatMap((r) => r.coingecko?.names ?? []),
      ...NARRATIVE_RULES.flatMap((r) => r.coingecko?.names ?? []),
    ];
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(
        excludes.some((p) => p.test(name)),
        `${name} is excluded before it can be mapped`,
      ).toBe(false);
    }
  });
});
