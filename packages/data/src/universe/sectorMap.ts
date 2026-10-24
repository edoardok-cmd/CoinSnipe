/**
 * Sector and narrative mapping for the asset universe (CSN-020).
 *
 * Turns CoinGecko categories and the DefiLlama category into the CoinSnipe ids:
 * 11 sectors and 20 narratives. The ids are the contract with `packages/db`
 * (`reference-data.ts`); a test keeps the two lists identical, so this file can only emit ids
 * the database already knows. This file is the "Niche map: DefiLlama category -> CoinSnipe
 * niche" item from the earlier plan.
 *
 * Precedence, highest first (applied in `buildUniverse`, not here):
 *   1. a manual entry in `overrides.json` `coins`,
 *   2. the user's Score Lab assignments in `overrides.json` `sampleSeed`,
 *   3. the automatic mapping in this file,
 *   4. the asset's previous sector (so a transient data gap never wipes a classification).
 *
 * Educational labels only: nothing here describes what to do with a coin.
 */

export const SECTOR_IDS = [
  'gold',
  'platforms',
  'scaling',
  'payments',
  'bank',
  'real',
  'infra',
  'ai',
  'networks',
  'games',
  'culture',
] as const;
export type SectorId = (typeof SECTOR_IDS)[number];

export const NARRATIVE_IDS = [
  'etf',
  'rwa',
  'stable',
  'perps',
  'revenue',
  'restake',
  'agents',
  'compute',
  'depin',
  'btcfi',
  'solana',
  'base',
  'modular',
  'fastl1',
  'interop',
  'oracles',
  'privacy',
  'gaming',
  'memes',
  'cex',
] as const;
export type NarrativeId = (typeof NARRATIVE_IDS)[number];

const SECTOR_SET: ReadonlySet<string> = new Set(SECTOR_IDS);
const NARRATIVE_SET: ReadonlySet<string> = new Set(NARRATIVE_IDS);

export function isSectorId(value: unknown): value is SectorId {
  return typeof value === 'string' && SECTOR_SET.has(value);
}

export function isNarrativeId(value: unknown): value is NarrativeId {
  return typeof value === 'string' && NARRATIVE_SET.has(value);
}

/**
 * Sectors where a coin earns from deposits or fees, so a missing DefiLlama mapping means a
 * missing input for the fundamentals pillars. The unmapped report covers exactly these.
 */
export const DEPOSIT_OR_FEE_SECTORS: readonly SectorId[] = [
  'platforms',
  'scaling',
  'bank',
  'real',
  'payments',
  'ai',
  'networks',
];

/** A category matcher: exact names (case-insensitive) plus optional patterns. */
export interface CategoryMatcher {
  readonly names?: readonly string[];
  readonly patterns?: readonly RegExp[];
}

export function normalizeCategory(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function matchesCategory(matcher: CategoryMatcher | undefined, category: string): boolean {
  if (!matcher) return false;
  const key = normalizeCategory(category);
  if (key === '') return false;
  if (matcher.names?.some((n) => normalizeCategory(n) === key)) return true;
  return matcher.patterns?.some((p) => p.test(category.trim())) ?? false;
}

interface SectorRule {
  readonly sector: SectorId;
  readonly coingecko?: CategoryMatcher;
  readonly defillama?: CategoryMatcher;
}

/**
 * Sector rules in PRIORITY order: the first sector with any matching category wins. More
 * specific sectors come first (a meme token on Solana is culture, not platforms; an AI
 * network that rents out chips is ai, not networks).
 */
export const SECTOR_RULES: readonly SectorRule[] = [
  {
    sector: 'culture',
    coingecko: { names: ['Meme', 'Dog-Themed', 'Cat-Themed', 'AI Meme'], patterns: [/\bmeme\b/i] },
    defillama: { names: ['Meme'] },
  },
  {
    sector: 'gold',
    coingecko: { names: ['Tokenized Gold', 'Gold', 'Bitcoin Fork'] },
  },
  {
    sector: 'ai',
    coingecko: {
      names: [
        'Artificial Intelligence (AI)',
        'AI Agents',
        'AI Applications',
        'AI Framework',
        'AI Agent Launchpad',
        'DeFAI',
      ],
    },
    defillama: { names: ['AI Agents', 'Decentralized AI'] },
  },
  {
    sector: 'networks',
    coingecko: { names: ['DePIN', 'Internet of Things (IOT)', 'Storage', 'Data Storage'] },
    defillama: { names: ['DePIN', 'Video Infrastructure'] },
  },
  {
    sector: 'games',
    coingecko: {
      names: [
        'Gaming (GameFi)',
        'Gaming Blockchains',
        'Gaming Platform',
        'Gaming Utility Token',
        'Gaming Governance Token',
        'Gaming Marketplace',
        'On-chain Gaming',
        'Metaverse',
        'Play To Earn',
        'NFT',
        'NFT Marketplace',
      ],
      patterns: [/\bgames\b/i],
    },
    defillama: { names: ['Gaming', 'NFT Marketplace'] },
  },
  {
    sector: 'real',
    coingecko: {
      names: ['Real World Assets (RWA)', 'RWA Protocol', 'RWAfi', 'Oracle', 'Tokenized Assets'],
      patterns: [/^tokenized /i],
    },
    defillama: { names: ['RWA', 'Oracle'] },
  },
  {
    sector: 'payments',
    coingecko: { names: ['Payment Solutions'], patterns: [/remittance/i] },
    defillama: { names: ['Payments'] },
  },
  {
    sector: 'infra',
    coingecko: {
      names: [
        'Cross-chain Communication',
        'Interoperability',
        'Layer 0 (L0)',
        'Bridge Governance Tokens',
        'Privacy Coins',
        'Privacy',
        'Privacy Blockchain',
        'Privacy Infrastructure',
        'Name Service',
        'Infrastructure',
      ],
    },
    defillama: {
      names: [
        'Bridge',
        'Canonical Bridge',
        'Cross Chain Bridge',
        'Bridge Aggregator',
        'Bridge Aggregators',
        'Privacy',
        'Domains',
        'Identity & Reputation',
      ],
    },
  },
  {
    sector: 'scaling',
    coingecko: {
      names: [
        'Layer 2 (L2)',
        'Layer 3 (L3)',
        'Rollup',
        'Rollups-as-a-Service (RaaS)',
        'Zero Knowledge (ZK)',
        'Data Availability',
        'Modular Blockchain',
        'Bitcoin Sidechains',
      ],
    },
  },
  {
    sector: 'bank',
    coingecko: {
      names: [
        'Decentralized Finance (DeFi)',
        'Decentralized Exchange (DEX)',
        'Dex Aggregator',
        'Lending/Borrowing Protocols',
        'Liquid Staking',
        'Liquid Staking Governance Tokens',
        'Liquid Restaking Governance Tokens',
        'Restaking',
        'Yield Aggregator',
        'Yield Farming',
        'Yield Optimizer',
        'Derivatives',
        'Perpetuals',
        'Prediction Markets',
        'Stablecoin Issuer',
        'Yield Tokenization Protocol',
      ],
    },
    defillama: {
      names: [
        'Dexs',
        'DEX Aggregator',
        'Lending',
        'Uncollateralized Lending',
        'Yield',
        'Yield Aggregator',
        'Farm',
        'Leveraged Farming',
        'Derivatives',
        'Interest Rate Derivatives',
        'Options',
        'Options Vault',
        'Exotic Options',
        'Synthetics',
        'Liquid Staking',
        'Liquid Restaking',
        'Restaking',
        'Staking Pool',
        'CDP',
        'Algo-Stables',
        'Stablecoin Issuer',
        'Dual-Token Stablecoin',
        'Partially Algorithmic Stablecoin',
        'Basis Trading',
        'Liquidity Manager',
        'Prediction Market',
      ],
    },
  },
  {
    sector: 'platforms',
    coingecko: { names: ['Smart Contract Platform', 'Layer 1 (L1)'] },
    defillama: { names: ['Chain'] },
  },
];

interface NarrativeRule {
  readonly narrative: NarrativeId;
  readonly coingecko?: CategoryMatcher;
  readonly defillama?: CategoryMatcher;
}

/**
 * Narrative rules. A coin can carry any number of narratives. `revenue` and `fastl1` have no
 * automatic rule on purpose: `revenue` needs the fees data of CSN-022 and `fastl1` is an
 * editorial label, so both come from `overrides.json` only.
 */
export const NARRATIVE_RULES: readonly NarrativeRule[] = [
  { narrative: 'etf', coingecko: { names: ['ETF'] } },
  {
    narrative: 'rwa',
    coingecko: {
      names: ['Real World Assets (RWA)', 'RWA Protocol', 'RWAfi', 'Tokenized Gold'],
      patterns: [/^tokenized /i],
    },
    defillama: { names: ['RWA'] },
  },
  {
    narrative: 'stable',
    coingecko: { names: ['Stablecoin Issuer'] },
    defillama: {
      names: [
        'Stablecoin Issuer',
        'Algo-Stables',
        'Dual-Token Stablecoin',
        'Partially Algorithmic Stablecoin',
        'CDP',
      ],
    },
  },
  {
    narrative: 'perps',
    coingecko: { names: ['Perpetuals', 'Derivatives'] },
    defillama: { names: ['Derivatives'] },
  },
  {
    narrative: 'restake',
    coingecko: {
      names: [
        'Restaking',
        'Liquid Staking',
        'Liquid Staking Governance Tokens',
        'Liquid Restaking Governance Tokens',
      ],
    },
    defillama: { names: ['Liquid Staking', 'Liquid Restaking', 'Restaking', 'Staking Pool'] },
  },
  {
    narrative: 'agents',
    coingecko: {
      names: ['AI Agents', 'AI Agent Launchpad', 'AI Applications', 'AI Framework', 'DeFAI'],
    },
    defillama: { names: ['AI Agents', 'Decentralized AI'] },
  },
  {
    narrative: 'compute',
    coingecko: { patterns: [/\bgpu\b/i, /distributed computing/i, /decentralized compute/i] },
  },
  {
    narrative: 'depin',
    coingecko: { names: ['DePIN', 'Internet of Things (IOT)'] },
    defillama: { names: ['DePIN'] },
  },
  {
    narrative: 'btcfi',
    coingecko: {
      names: ['BTCfi Protocol', 'Bitcoin Sidechains', 'Bitcoin Ecosystem'],
    },
    defillama: { names: ['Decentralized BTC', 'Restaked BTC', 'Anchor BTC'] },
  },
  { narrative: 'solana', coingecko: { names: ['Solana Ecosystem'] } },
  { narrative: 'base', coingecko: { names: ['Base Ecosystem'] } },
  {
    narrative: 'modular',
    coingecko: {
      names: [
        'Layer 2 (L2)',
        'Layer 3 (L3)',
        'Rollup',
        'Rollups-as-a-Service (RaaS)',
        'Modular Blockchain',
        'Data Availability',
        'Zero Knowledge (ZK)',
      ],
    },
  },
  {
    narrative: 'interop',
    coingecko: { names: ['Cross-chain Communication', 'Interoperability', 'Layer 0 (L0)'] },
    defillama: {
      names: [
        'Bridge',
        'Canonical Bridge',
        'Cross Chain Bridge',
        'Bridge Aggregator',
        'Bridge Aggregators',
      ],
    },
  },
  {
    narrative: 'oracles',
    coingecko: { names: ['Oracle'] },
    defillama: { names: ['Oracle'] },
  },
  {
    narrative: 'privacy',
    coingecko: {
      names: ['Privacy Coins', 'Privacy', 'Privacy Blockchain', 'Privacy Infrastructure'],
    },
    defillama: { names: ['Privacy'] },
  },
  {
    narrative: 'gaming',
    coingecko: {
      names: [
        'Gaming (GameFi)',
        'Gaming Blockchains',
        'Gaming Platform',
        'Gaming Utility Token',
        'On-chain Gaming',
        'Metaverse',
        'Play To Earn',
      ],
      patterns: [/\bgames\b/i],
    },
    defillama: { names: ['Gaming'] },
  },
  {
    narrative: 'memes',
    coingecko: { names: ['Meme', 'Dog-Themed', 'Cat-Themed', 'AI Meme'], patterns: [/\bmeme\b/i] },
    defillama: { names: ['Meme'] },
  },
  {
    narrative: 'cex',
    coingecko: { names: ['Centralized Exchange (CEX) Token', 'Exchange-based Tokens'] },
    defillama: { names: ['CEX'] },
  },
];

export interface SectorEvidence {
  /** CoinGecko category names from /coins/{id} `categories`. */
  readonly coingeckoCategories: readonly string[];
  /** DefiLlama /protocols `category` of the matched protocol, if any. */
  readonly defillamaCategory?: string | null;
  /** True when the coin is the gas token of a chain found in DefiLlama /v2/chains. */
  readonly isDefillamaChain?: boolean;
}

export interface SectorResult {
  readonly sectorId: SectorId | null;
  /** Which evidence decided it, for the review report. */
  readonly basis: 'coingecko' | 'defillama' | 'defillama-chain' | null;
  readonly matchedCategory: string | null;
}

/** Automatic sector for one coin, or `sectorId: null` when no rule matches. */
export function mapSector(evidence: SectorEvidence): SectorResult {
  const llama = evidence.defillamaCategory ?? null;
  for (const rule of SECTOR_RULES) {
    const cg = evidence.coingeckoCategories.find((c) => matchesCategory(rule.coingecko, c));
    if (cg !== undefined) {
      return { sectorId: rule.sector, basis: 'coingecko', matchedCategory: cg };
    }
    if (llama !== null && matchesCategory(rule.defillama, llama)) {
      return { sectorId: rule.sector, basis: 'defillama', matchedCategory: llama };
    }
  }
  if (evidence.isDefillamaChain === true) {
    return { sectorId: 'platforms', basis: 'defillama-chain', matchedCategory: null };
  }
  return { sectorId: null, basis: null, matchedCategory: null };
}

/** Automatic narratives for one coin, in the canonical NARRATIVE_IDS order. */
export function mapNarratives(evidence: SectorEvidence): NarrativeId[] {
  const llama = evidence.defillamaCategory ?? null;
  const found = new Set<NarrativeId>();
  for (const rule of NARRATIVE_RULES) {
    const hit =
      evidence.coingeckoCategories.some((c) => matchesCategory(rule.coingecko, c)) ||
      (llama !== null && matchesCategory(rule.defillama, llama));
    if (hit) found.add(rule.narrative);
  }
  return NARRATIVE_IDS.filter((id) => found.has(id));
}
