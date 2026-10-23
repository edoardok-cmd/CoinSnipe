/**
 * Reference rows seeded into every database: the 11 sectors and 20 narratives.
 *
 * Ids match the Score Lab and the sample universe header (sector_id, narrative_ids).
 * Names and sector descriptions come from the Score Lab v0.3; narrative descriptions are
 * written for this seed in the same plain, educational voice. Descriptions describe what a
 * group is, never what to do about it, and carry no numbers.
 *
 * This file holds no price, score or sample market data.
 */

export interface ReferenceRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export const SECTORS: readonly ReferenceRow[] = [
  {
    id: 'gold',
    name: 'Digital gold',
    description: 'Coins built to keep their value over time, like Bitcoin.',
  },
  {
    id: 'platforms',
    name: 'App platforms',
    description: 'Blockchains that other apps are built on, like Ethereum and Solana.',
  },
  {
    id: 'scaling',
    name: 'Speed-up layers',
    description: 'Networks that make Ethereum faster and cheaper to use.',
  },
  {
    id: 'payments',
    name: 'Payments and digital dollars',
    description: 'Sending money around the world fast and cheaply.',
  },
  {
    id: 'bank',
    name: 'Banking without banks',
    description: 'Lending, borrowing and trading with no bank in the middle.',
  },
  {
    id: 'real',
    name: 'Real-world stuff on chain',
    description: 'Bonds, funds and real-world data brought onto blockchains.',
  },
  {
    id: 'infra',
    name: 'Connecting chains and privacy',
    description: 'Bridges between blockchains, and coins that keep payments private.',
  },
  {
    id: 'ai',
    name: 'AI and computing',
    description: 'Networks that share computing power and models for AI.',
  },
  {
    id: 'networks',
    name: 'Community-built networks',
    description: 'People earn tokens for running real equipment, like hotspots or storage.',
  },
  {
    id: 'games',
    name: 'Games and collectibles',
    description: 'Game items and collectibles you actually own.',
  },
  {
    id: 'culture',
    name: 'Internet culture',
    description: 'Meme coins. Fun, mostly driven by hype, very high risk.',
  },
];

export const NARRATIVES: readonly ReferenceRow[] = [
  {
    id: 'etf',
    name: 'ETF spotlight',
    description:
      'Coins that have a regulated exchange-traded fund, or a similar fund, in at least one market.',
  },
  {
    id: 'rwa',
    name: 'Tokenization',
    description:
      'Real-world assets such as bonds, funds and gold represented as tokens on a blockchain.',
  },
  {
    id: 'stable',
    name: 'Stablecoin rails',
    description: 'Projects that move and settle digital dollars and other stablecoins.',
  },
  {
    id: 'perps',
    name: 'Perp trading',
    description:
      'Exchanges and protocols for perpetual futures, trading contracts that have no expiry date.',
  },
  {
    id: 'revenue',
    name: 'Revenue sharing',
    description:
      'Tokens linked to the fees or revenue their project earns, for example through payouts or token burns.',
  },
  {
    id: 'restake',
    name: 'Staking and restaking',
    description:
      'Locking tokens to help secure a network, and reusing that stake to secure other services.',
  },
  {
    id: 'agents',
    name: 'AI agents',
    description:
      'Software agents that use AI to act on blockchains, and the tokens built around them.',
  },
  {
    id: 'compute',
    name: 'Decentralized compute',
    description:
      'Networks that rent out spare computing power, such as graphics chips, without a central cloud company.',
  },
  {
    id: 'depin',
    name: 'Physical networks',
    description:
      'Networks built from real equipment run by people, such as wireless hotspots, sensors and storage drives.',
  },
  {
    id: 'btcfi',
    name: 'Bitcoin DeFi',
    description: 'Lending and trading apps built around Bitcoin instead of Ethereum-style tokens.',
  },
  {
    id: 'solana',
    name: 'Solana ecosystem',
    description: 'Apps and tokens built on the Solana blockchain.',
  },
  {
    id: 'base',
    name: 'Base ecosystem',
    description: 'Apps and tokens built on Base, a network that runs on top of Ethereum.',
  },
  {
    id: 'modular',
    name: 'Layer 2s and modular',
    description:
      'Networks that run on top of a main chain, and chains that split jobs such as data storage across specialist layers.',
  },
  {
    id: 'fastl1',
    name: 'New fast chains',
    description: 'Newer base-layer blockchains designed for high speed and low fees.',
  },
  {
    id: 'interop',
    name: 'Cross-chain',
    description: 'Bridges and messaging networks that move tokens and data between blockchains.',
  },
  {
    id: 'oracles',
    name: 'Oracles and data',
    description:
      'Services that bring outside data, such as market prices, onto blockchains for apps to use.',
  },
  {
    id: 'privacy',
    name: 'Privacy',
    description: 'Coins and tools that hide who sends or receives a payment.',
  },
  {
    id: 'gaming',
    name: 'Web3 gaming',
    description: 'Blockchain games, and the tokens and items used inside them.',
  },
  {
    id: 'memes',
    name: 'Memes',
    description:
      'Coins built around jokes, characters or online communities rather than a product. Prices follow attention closely.',
  },
  {
    id: 'cex',
    name: 'Exchange tokens',
    description:
      'Tokens issued by large trading platforms, often used for fee discounts or on the platform’s own chain.',
  },
];
