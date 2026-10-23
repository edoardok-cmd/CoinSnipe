/**
 * Marketing site content (CSN-010). One object per section so the copy lint (CSN-011) can scan it.
 *
 * Source of truth for layout and copy: the CoinSnipe design canvas (Main.dc.html).
 * Educational, never advisory: describe data and history only (MiCA). Do not add words such as
 * buy, sell, hold, target, pump or guaranteed here (the hero headline is the one brief-mandated
 * exception, see PR_NOTES.md).
 *
 * SAMPLE data. Every number in the SAMPLE_* exports is invented illustration data. Until CSN-043
 * wires live data, the page renders it with a visible "Sample data" badge in non-production
 * builds, and a production build fails if sample content is rendered without that badge
 * (see components/marketing/SampleBadge.tsx and app/(marketing)/page.tsx).
 */

/* ------------------------------------------------------------------ config */

/**
 * CSN-001 D01 (2026-10-23): both signal sets are shown on the card unless the designs show
 * otherwise. The canvas shows the Temperature read (Season / Health / Temperature set), so that
 * is rendered by default. The v0.3 set (Quality, Timing, quadrant label) is primary in the app and
 * sits behind this flag: set NEXT_PUBLIC_SIGNALS_V03=1 to add the quadrant column to the coin table.
 */
export const signalConfig = {
  showV03Signals: process.env.NEXT_PUBLIC_SIGNALS_V03 === '1',
} as const;

/** Environment label read at build time. Anything other than 'production' shows the sample badge. */
export const APP_ENV = process.env.NEXT_PUBLIC_APP_ENV ?? 'development';

/* ------------------------------------------------------------------ shared types */

export type CoinSymbol =
  | 'BTC'
  | 'ETH'
  | 'SOL'
  | 'XRP'
  | 'BNB'
  | 'LINK'
  | 'AAVE'
  | 'MORPHO'
  | 'ENA'
  | 'RNDR'
  | 'NEAR'
  | 'ONDO'
  | 'JUP'
  | 'INJ'
  | 'AVAX'
  | 'LDO'
  | 'UNI'
  | 'AERO'
  | 'RAY'
  | 'ORCA'
  | 'SUI';

export type Temperature = 'Heated' | 'Balanced' | 'Cooled off';
export type Momentum = 'Heating up' | 'Steady' | 'Cooling down';

export type SectionLink = { label: string; href: string };

/** Page metadata copy (title and description), kept here so the copy lint and tests scan it. */
export const siteMeta = {
  title: 'CoinSnipe: invest in crypto and understand what you own',
  description:
    'CoinSnipe turns market data, on-chain activity and narratives into simple signals you can understand at a glance. Educational information only, not financial advice.',
} as const;

/* ------------------------------------------------------------------ nav */

export const nav = {
  homeLabel: 'CoinSnipe home',
  menuLabel: 'Mobile menu',
  openMenuLabel: 'Open menu',
  closeMenuLabel: 'Close menu',
  links: [
    { label: 'Coin signals', href: '#signals' },
    { label: 'Trends', href: '#trends' },
    { label: 'Portfolio', href: '#portfolio' },
    { label: 'Pricing', href: '#pricing' },
  ] satisfies SectionLink[],
  /** App routes arrive with CSN-050; '#' keeps the link inert until then. */
  login: { label: 'Log in', href: '#' },
  cta: { label: 'Start for free', href: '#quiz' },
} as const;

/* ------------------------------------------------------------------ hero */

export const hero = {
  titleLead: 'Invest in crypto?',
  titleAccent: 'Know what you buy.',
  subline:
    'CoinSnipe turns market data, on-chain activity, and narratives into simple signals you can understand at a glance.',
  primaryCta: { label: 'Start for free', href: '#quiz' },
  secondaryCta: { label: 'See top coins', href: '#signals' },
  backedBy: 'Built on open data from',
  partners: [
    {
      name: 'DefiLlama',
      href: 'https://defillama.com',
      src: '/brand/partners/logo-defillama.png',
      width: 596,
      height: 161,
    },
    {
      name: 'CoinGecko',
      href: 'https://www.coingecko.com',
      src: '/brand/partners/logo-coingecko.png',
      width: 586,
      height: 128,
    },
  ],
} as const;

/* ------------------------------------------------------------------ coin tabs */

export const coinTabs = {
  ariaLabel: 'Browse',
  tabs: [
    { id: 'coins', label: 'Top coins' },
    { id: 'niches', label: 'Top niches' },
    { id: 'gems', label: 'Hidden gems' },
    { id: 'portfolio', label: 'Portfolio', tag: 'Smart signals' },
  ],
  coinsHead: {
    name: 'Name',
    price: 'Price',
    change: '24h',
    signal: 'Smart signal',
    week: 'Last 7 days',
  },
  coinsQuadrantHead: 'State',
  nichesHead: {
    name: 'Niche',
    leaders: 'Leaders',
    change: '7d',
    signal: 'Momentum',
    week: 'Last 7 days',
  },
  gemsHead: {
    name: 'Name',
    price: 'Price',
    change: '24h',
    why: 'Why it’s here',
    week: 'Last 7 days',
  },
  favoriteLabel: 'Add to favorites',
  moreLabels: {
    coins: 'See top coins',
    niches: 'See all 20 niches',
    gems: 'See every hidden gem',
  },
  /** App routes arrive with CSN-050. */
  moreHref: '#',
  gemsLock: {
    text: '23 more hidden gems found this week',
    cta: 'Unlock with Pro',
    href: '#pricing',
  },
  radar: {
    tag: 'Smart signals',
    title: 'Put your portfolio on radar',
    body: 'Add your coins and CoinSnipe watches them for you. Get a heads-up the moment one heats up, cools off, loses users or faces a big unlock.',
    checks: [
      'Smart signals on every coin you own',
      'Alerts on your favorites and your portfolio',
      'Plain-words explanation with every alert',
    ],
    primaryCta: { label: 'Add my coins', href: '#portfolio' },
    secondaryCta: { label: 'How alerts work', href: '#how' },
    note: 'Free to start. No wallet connection needed.',
    alerts: [
      { kind: 'hot', lead: 'Solana', tail: 'turned heated' },
      { kind: 'cool', lead: 'Chainlink', tail: 'cooled off' },
      { kind: 'mid', lead: 'Unlock ahead in', tail: '9 days', leadFirst: true },
    ],
  },
} as const;

/* ------------------------------------------------------------------ signal to decision */

export const signalFlow = {
  titleLead: 'Everything from',
  titleAccent: 'signal to decision',
  subline:
    'See what is heating up, understand why, and keep an eye on what you own. All in one place.',
  sliderLabel: 'Product features',
  slides: [
    { id: 'gems', title: 'Discover gems', body: 'Explore which coins show growing activity.' },
    {
      id: 'signals',
      title: 'Get smart signals',
      body: 'Know instantly if a coin is hot, healthy or fading.',
    },
    {
      id: 'track',
      title: 'Track what matters',
      body: 'Get a heads-up the moment your coins change.',
    },
    { id: 'learn', title: 'Learn the basics', body: 'Understand crypto in bite-sized lessons.' },
  ],
  slideDotLabel: 'Show slide',
  /** Labels for the four counting stats. The numbers live in SAMPLE_STATS. */
  statLabels: [
    'sectors in plain words',
    'top projects tracked',
    'insights per project',
    'scams listed',
  ],
} as const;

/* ------------------------------------------------------------------ pillars */

export const pillars = {
  titleLead: 'We read the data.',
  titleAccent: 'You get the answer.',
  items: [
    {
      id: 'adoption',
      title: 'Adoption',
      body: 'Are people using this tech',
      src: '/brand/pillars/pillar-adoption.png',
      width: 447,
      height: 450,
    },
    {
      id: 'liquidity',
      title: 'Liquidity',
      body: 'Is it making real money',
      src: '/brand/pillars/pillar-liquidity.png',
      width: 400,
      height: 400,
    },
    {
      id: 'momentum',
      title: 'Momentum',
      body: 'How has its price been moving',
      src: '/brand/pillars/pillar-momentum.png',
      width: 454,
      height: 400,
    },
  ],
  cta: { label: 'Check your coins free', href: '#quiz' },
} as const;

/* ------------------------------------------------------------------ scroll story */

/**
 * Compliance (R-CM / brief "Flagged copy"): the canvas heading "Find winners early" hints at
 * returns and is NOT shipped. `story.gems.title` is a neutral placeholder pending the user's
 * decision. Alternatives are listed in PR_NOTES.md.
 */
export const story = {
  markets: {
    id: 'trends',
    title: 'See which markets are moving',
    body: 'Tokenization, AI agents, perp trading. See which narratives money is rotating into, and which projects ride each one.',
    cta: { label: 'Explore narratives', href: '#' },
    cardTabsLabel: 'Niches',
    cardCta: { label: 'Explore niches', href: '#' },
    window: 'Last 30 days',
    leading: 'Leading projects',
    projectsSuffix: 'projects',
  },
  gems: {
    id: 'gems',
    title: 'See what is quietly growing',
    body: 'Projects quietly growing while prices cool. Each one explained in a line.',
    cta: { label: 'Browse hidden gems', href: '#' },
    cardTitle: 'Today’s hidden gems',
    cardSub: 'Picked by the data, explained in one line',
    found: '7 found',
  },
  portfolio: {
    id: 'portfolio',
    title: 'Your coins, finally explained',
    body: 'Add what you own by hand, no wallet connection required. CoinSnipe shows the temperature and season of every coin you own and tells you in plain words when something changes.',
    checks: [
      'Alerts when one of your coins turns heated or cooled off',
      'See how much of your portfolio is in season',
      'Spot unlocks and fading usage before they surprise you',
    ],
    cta: { label: 'Add my coins', href: '#' },
    cardValueLabel: 'Portfolio value',
    seasonLabels: ['in season', 'next up', 'later'],
  },
} as const;

/* ------------------------------------------------------------------ pricing */

export const pricing = {
  id: 'pricing',
  titleLead: 'Start free.',
  titleAccent: 'Upgrade when you want more.',
  free: {
    name: 'Free',
    price: '$0',
    period: 'Forever',
    features: [
      'Three signals on the top 50 projects',
      'Market phase and sector overview',
      '5 narratives and 2 screens',
      'Full learning path with quizzes',
      'Watchlist of up to 10 projects',
    ],
    cta: { label: 'Get started free', href: '#quiz' },
  },
  pro: {
    name: 'Pro',
    badge: 'Most popular',
    price: '$12.99/mo',
    period: 'per month, billed yearly',
    /** CSN-001 D06: 7-day trial, yearly billing only, no monthly price. */
    trial: '7-day free trial',
    features: [
      'Every project, every stat and all 9 screens',
      'All 20 narratives with rotation alerts',
      'Portfolio signals and custom alerts',
      'Hidden-gem screens refreshed daily',
      'Weekly plain-language market briefing',
      'Unlimited watchlists',
    ],
    cta: { label: 'Start your free trial', href: '#' },
  },
} as const;

/* ------------------------------------------------------------------ FAQ */

export const faq = {
  id: 'faq',
  titleLead: 'Questions?',
  titleAccent: 'Straight answers',
  items: [
    {
      q: 'Is CoinSnipe financial advice?',
      a: 'No. CoinSnipe explains what the data shows. It never tells you what to do with your money, and every decision stays yours.',
    },
    {
      q: 'Where does the data come from?',
      a: 'From open, public sources like DefiLlama and CoinGecko. We turn them into plain-language signals and show where each one comes from.',
    },
    {
      q: 'What do the signals mean?',
      a: 'Each coin gets three short verdicts: how its market season looks, whether people really use it, and how fast its price has run lately. No scores to decode.',
    },
    {
      q: 'Do I need to connect my wallet?',
      a: 'No. You add the coins you own by hand. CoinSnipe never asks for wallet access or keys.',
    },
    {
      q: 'I’m new to crypto. Is this for me?',
      a: 'Yes. Every signal comes with a plain explanation, and short lessons cover the basics before you put money into anything.',
    },
    {
      q: 'What do I get for free?',
      a: 'Free covers the top 50 projects, 5 narratives and all lessons. Pro adds every project, alerts and a weekly briefing.',
    },
  ],
} as const;

/* ------------------------------------------------------------------ final CTA */

export const finale = {
  id: 'quiz',
  titleLead: 'Stop guessing.',
  titleAccent: 'Start knowing.',
  primaryCta: { label: 'Start for free now', href: '#' },
  secondaryCta: { label: 'Take 2 min quiz', href: '#signals' },
} as const;

/* ------------------------------------------------------------------ footer */

export const footer = {
  tagline:
    'Signals, narratives and lessons for people who want to understand what the crypto data shows.',
  columns: [
    {
      title: 'Product',
      links: [
        { label: 'Discover', href: '#signals' },
        { label: 'Signals', href: '#how' },
        { label: 'Hidden gems', href: '#gems' },
        { label: 'Portfolio', href: '#portfolio' },
        { label: 'Learn', href: '#' },
      ],
    },
    {
      title: 'Company',
      links: [
        { label: 'About', href: '#' },
        { label: 'Pricing', href: '#pricing' },
        { label: 'Blog', href: '#' },
        { label: 'Careers', href: '#' },
        { label: 'Contact', href: '#' },
      ],
    },
    {
      title: 'Resources',
      links: [
        { label: 'How signals work', href: '#how' },
        { label: 'Data sources', href: '#' },
        { label: 'Glossary', href: '#' },
        { label: 'Help center', href: '#' },
      ],
    },
    {
      title: 'Legal',
      links: [
        { label: 'Terms of use', href: '#' },
        { label: 'Privacy policy', href: '#' },
        { label: 'Not financial advice', href: '#' },
        { label: 'Cookie policy', href: '#' },
      ],
    },
  ],
  disclaimer:
    'CoinSnipe provides educational information only and is not financial advice. Crypto is risky and you can lose money.',
  /** CSN-001 D07: company legal name and year stay placeholders until supplied. */
  company: '[COMPANY NAME], [YEAR]',
} as const;

/* ------------------------------------------------------------------ SAMPLE data */

export const SAMPLE_CONTENT = true as const;

export type SampleCoinRow = {
  rank: number;
  symbol: CoinSymbol;
  name: string;
  price: string;
  change: number;
  temperature: Temperature;
  /** Temperature gauge fill, 0 to 100. */
  gauge: number;
  /** v0.3 quadrant label, shown only when signalConfig.showV03Signals is on. */
  quadrant: string;
  spark: number[];
};

export const SAMPLE_COINS: SampleCoinRow[] = [
  {
    rank: 1,
    symbol: 'BTC',
    name: 'Bitcoin',
    price: '$86,012.40',
    change: 0.8,
    temperature: 'Balanced',
    gauge: 58,
    quadrant: 'Solid and in favour',
    spark: [14, 13, 10, 7, 5, 5, 3, 3, 4, 6, 3, 3, 4, 3, 5, 4, 7, 8, 7, 4, 3],
  },
  {
    rank: 2,
    symbol: 'ETH',
    name: 'Ethereum',
    price: '$3,204.15',
    change: -0.4,
    temperature: 'Balanced',
    gauge: 52,
    quadrant: 'Solid and in favour',
    spark: [6, 7, 5, 8, 10, 9, 12, 10, 11, 9, 12, 13, 11, 14, 12, 13, 12, 14, 13, 15, 14],
  },
  {
    rank: 3,
    symbol: 'SOL',
    name: 'Solana',
    price: '$190.40',
    change: 3.1,
    temperature: 'Heated',
    gauge: 72,
    quadrant: 'In favour, thin fundamentals',
    spark: [20, 19, 18, 18, 15, 14, 12, 12, 10, 9, 8, 9, 7, 6, 7, 5, 5, 4, 3, 3, 2],
  },
  {
    rank: 4,
    symbol: 'XRP',
    name: 'XRP',
    price: '$2.81',
    change: -1.2,
    temperature: 'Balanced',
    gauge: 49,
    quadrant: 'Solid, out of favour',
    spark: [8, 9, 8, 10, 9, 11, 10, 12, 11, 12, 13, 12, 14, 13, 14, 15, 14, 16, 15, 16, 17],
  },
  {
    rank: 5,
    symbol: 'BNB',
    name: 'BNB',
    price: '$881.20',
    change: 0.3,
    temperature: 'Balanced',
    gauge: 55,
    quadrant: 'Solid and in favour',
    spark: [12, 11, 12, 10, 11, 9, 10, 9, 8, 9, 7, 8, 7, 6, 7, 6, 5, 6, 5, 4, 4],
  },
  {
    rank: 6,
    symbol: 'LINK',
    name: 'Chainlink',
    price: '$22.10',
    change: -4.6,
    temperature: 'Cooled off',
    gauge: 29,
    quadrant: 'Solid, out of favour',
    spark: [4, 5, 5, 7, 6, 8, 9, 11, 10, 12, 13, 12, 14, 15, 14, 16, 17, 16, 18, 19, 20],
  },
];

export type SampleNicheRow = {
  rank: number;
  name: string;
  projects: number;
  leaders: CoinSymbol[];
  change: number;
  momentum: Momentum;
  spark: number[];
};

export const SAMPLE_NICHES: SampleNicheRow[] = [
  {
    rank: 1,
    name: 'Tokenization',
    projects: 16,
    leaders: ['ONDO', 'LINK', 'AVAX'],
    change: 12.4,
    momentum: 'Heating up',
    spark: [20, 19, 17, 18, 15, 14, 12, 10, 11, 8, 7, 5, 4, 3, 2],
  },
  {
    rank: 2,
    name: 'AI agents',
    projects: 6,
    leaders: ['NEAR', 'RNDR'],
    change: 9.8,
    momentum: 'Heating up',
    spark: [18, 17, 18, 15, 14, 14, 11, 12, 9, 8, 7, 6, 5, 4, 3],
  },
  {
    rank: 3,
    name: 'Perp trading',
    projects: 6,
    leaders: ['JUP', 'INJ'],
    change: 7.1,
    momentum: 'Heating up',
    spark: [16, 17, 15, 14, 15, 12, 11, 10, 9, 9, 7, 6, 6, 5, 4],
  },
  {
    rank: 4,
    name: 'Solana ecosystem',
    projects: 14,
    leaders: ['SOL', 'JUP', 'RAY', 'ORCA'],
    change: 5.6,
    momentum: 'Steady',
    spark: [12, 13, 11, 12, 10, 11, 9, 10, 8, 9, 8, 7, 8, 6, 6],
  },
  {
    rank: 5,
    name: 'DeFi lending',
    projects: 7,
    leaders: ['AAVE', 'MORPHO', 'LDO', 'ENA'],
    change: -2.3,
    momentum: 'Cooling down',
    spark: [5, 6, 5, 7, 8, 7, 9, 10, 9, 11, 12, 12, 13, 14, 15],
  },
  {
    rank: 6,
    name: 'DEX trading',
    projects: 10,
    leaders: ['UNI', 'AERO', 'RAY'],
    change: -9.7,
    momentum: 'Cooling down',
    spark: [4, 5, 6, 6, 8, 9, 9, 11, 12, 13, 13, 15, 16, 17, 18],
  },
];

export type SampleGemRow = {
  rank: number;
  symbol: CoinSymbol;
  name: string;
  ticker: string;
  price: string;
  change: number;
  why: string;
  spark: number[];
};

export const SAMPLE_GEMS: SampleGemRow[] = [
  {
    rank: 1,
    symbol: 'AAVE',
    name: 'Aave',
    ticker: 'AAVE',
    price: '$290.10',
    change: 1.3,
    why: 'Earns a lot for its size',
    spark: [10, 11, 9, 10, 8, 9, 7, 8, 7, 6, 7, 5, 6, 5, 4],
  },
  {
    rank: 2,
    symbol: 'MORPHO',
    name: 'Morpho',
    ticker: 'MORPHO',
    price: '$3.20',
    change: -2.1,
    why: 'Used more, price cooled',
    spark: [4, 5, 6, 6, 8, 7, 9, 10, 9, 11, 12, 11, 13, 14, 14],
  },
  {
    rank: 3,
    symbol: 'ENA',
    name: 'Ethena',
    ticker: 'ENA',
    price: '$4.60',
    change: 2.2,
    why: 'Beaten down, still used',
    spark: [14, 13, 14, 12, 12, 11, 12, 10, 11, 9, 9, 8, 8, 7, 6],
  },
  {
    rank: 4,
    symbol: 'RNDR',
    name: 'Render',
    ticker: 'RNDR',
    price: '$3.60',
    change: 0.9,
    why: 'Long-term uptrend',
    spark: [16, 15, 14, 14, 13, 12, 12, 10, 10, 9, 8, 8, 6, 6, 5],
  },
  {
    rank: 5,
    symbol: 'NEAR',
    name: 'Near',
    ticker: 'NEAR',
    price: '$1.20',
    change: 4.4,
    why: 'Developers busy',
    spark: [12, 13, 11, 12, 10, 10, 9, 8, 9, 7, 6, 6, 5, 4, 3],
  },
];

export type SampleFeedRow = {
  symbol: CoinSymbol;
  name: string;
  why: string;
  a: { label: string; value: string };
  b: { label: string; value: string };
};

export const SAMPLE_GEM_FEED: SampleFeedRow[] = [
  {
    symbol: 'MORPHO',
    name: 'Morpho',
    why: 'Used more, price cooled',
    a: { label: 'Activity 30d', value: '+18%' },
    b: { label: 'From high', value: '-44%' },
  },
  {
    symbol: 'AAVE',
    name: 'Aave',
    why: 'Earns a lot for its size',
    a: { label: 'Fee yield', value: '6.1%' },
    b: { label: 'Deposits 30d', value: '+12%' },
  },
  {
    symbol: 'LINK',
    name: 'Chainlink',
    why: 'Developers busy',
    a: { label: 'Code updates', value: '412' },
    b: { label: 'Trend', value: 'Uptrend' },
  },
  {
    symbol: 'ENA',
    name: 'Ethena',
    why: 'Beaten down, still used',
    a: { label: 'Usage 30d', value: '+9%' },
    b: { label: 'From high', value: '-52%' },
  },
  {
    symbol: 'RNDR',
    name: 'Render',
    why: 'Long-term uptrend',
    a: { label: 'vs 200d avg', value: '+14%' },
    b: { label: 'Trend', value: 'Uptrend' },
  },
  {
    symbol: 'ONDO',
    name: 'Ondo',
    why: 'Deposits climbing fast',
    a: { label: 'Deposits 30d', value: '+21%' },
    b: { label: 'Trend', value: 'Uptrend' },
  },
  {
    symbol: 'JUP',
    name: 'Jupiter',
    why: 'Earns a lot for its size',
    a: { label: 'Fee yield', value: '7.4%' },
    b: { label: 'Volume 30d', value: '+16%' },
  },
];

export type SampleStoryNiche = {
  tab: string;
  name: string;
  projects: number;
  change: number;
  leaders: { symbol: CoinSymbol; name: string }[];
  spark: number[];
};

export const SAMPLE_STORY_NICHES: SampleStoryNiche[] = [
  {
    tab: 'Tokenization',
    name: 'Tokenization',
    projects: 16,
    change: 12.4,
    leaders: [
      { symbol: 'ONDO', name: 'Ondo' },
      { symbol: 'LINK', name: 'Chainlink' },
      { symbol: 'AVAX', name: 'Avalanche' },
    ],
    spark: [38, 36, 37, 33, 31, 32, 27, 25, 26, 20, 18, 14, 12, 9, 6],
  },
  {
    tab: 'AI',
    name: 'AI',
    projects: 6,
    change: 9.8,
    leaders: [
      { symbol: 'NEAR', name: 'Near' },
      { symbol: 'RNDR', name: 'Render' },
    ],
    spark: [36, 37, 33, 34, 30, 28, 29, 24, 22, 21, 17, 15, 13, 10, 8],
  },
  {
    tab: 'Perps',
    name: 'Perps',
    projects: 6,
    change: 7.1,
    leaders: [
      { symbol: 'JUP', name: 'Jupiter' },
      { symbol: 'INJ', name: 'Injective' },
    ],
    spark: [34, 35, 31, 32, 29, 27, 28, 24, 23, 20, 19, 16, 14, 12, 10],
  },
  {
    tab: 'DeFi',
    name: 'DeFi',
    projects: 7,
    change: -2.3,
    leaders: [
      { symbol: 'AAVE', name: 'Aave' },
      { symbol: 'MORPHO', name: 'Morpho' },
      { symbol: 'LDO', name: 'Lido' },
      { symbol: 'ENA', name: 'Ethena' },
    ],
    spark: [10, 12, 11, 14, 16, 15, 19, 21, 20, 24, 26, 25, 28, 30, 31],
  },
];

export type SampleHolding = {
  symbol: CoinSymbol | null;
  name: string;
  amount: string;
  value: string;
  temperature: Temperature;
  gauge: number;
};

export const SAMPLE_PORTFOLIO = {
  value: '$14,480',
  change: '+6.2% this month',
  /** Share of the portfolio in each season: in season, next up, later. Adds to 100. */
  seasonShares: [71, 18, 11] as const,
  spark: [18, 17, 19, 16, 15, 16, 13, 12, 13, 10, 9, 8, 6, 5, 3],
  holdings: [
    {
      symbol: 'BTC',
      name: 'Bitcoin',
      amount: '0.12 BTC',
      value: '$10,320',
      temperature: 'Balanced',
      gauge: 58,
    },
    {
      symbol: 'SOL',
      name: 'Solana',
      amount: '14 SOL',
      value: '$2,660',
      temperature: 'Heated',
      gauge: 72,
    },
    {
      symbol: 'RNDR',
      name: 'Render',
      amount: '300 RNDR',
      value: '$1,080',
      temperature: 'Balanced',
      gauge: 44,
    },
    {
      symbol: null,
      name: 'Pepe',
      amount: '40M PEPE',
      value: '$420',
      temperature: 'Heated',
      gauge: 77,
    },
  ] satisfies SampleHolding[],
} as const;

/** Counting stats beside the feature slider. Numbers are SAMPLE until CSN-043. */
export const SAMPLE_STATS: { value: number; suffix: string }[] = [
  { value: 11, suffix: '+' },
  { value: 1000, suffix: '+' },
  { value: 24, suffix: '' },
  { value: 0, suffix: '' },
];

/** Coin id to logo path. Files come from the marketing site export (see PR_NOTES.md). */
export const COIN_LOGOS: Record<CoinSymbol, string> = {
  BTC: '/brand/coins/coin-btc.png',
  ETH: '/brand/coins/coin-eth.png',
  SOL: '/brand/coins/coin-sol.png',
  XRP: '/brand/coins/coin-xrp.png',
  BNB: '/brand/coins/coin-bnb.png',
  LINK: '/brand/coins/coin-link.png',
  AAVE: '/brand/coins/coin-aave.png',
  MORPHO: '/brand/coins/coin-morpho.png',
  ENA: '/brand/coins/coin-ena.png',
  RNDR: '/brand/coins/coin-rndr.png',
  NEAR: '/brand/coins/coin-near.png',
  ONDO: '/brand/coins/coin-ondo.png',
  JUP: '/brand/coins/coin-jup.png',
  INJ: '/brand/coins/coin-inj.png',
  AVAX: '/brand/coins/coin-avax.png',
  LDO: '/brand/coins/coin-ldo.png',
  UNI: '/brand/coins/coin-uni.png',
  AERO: '/brand/coins/coin-aero.png',
  RAY: '/brand/coins/coin-ray.png',
  ORCA: '/brand/coins/coin-orca.png',
  SUI: '/brand/coins/coin-sui.png',
};

/** Every section object, for the copy lint and the content tests. */
export const marketingSections = {
  siteMeta,
  nav,
  hero,
  coinTabs,
  signalFlow,
  pillars,
  story,
  pricing,
  faq,
  finale,
  footer,
} as const;
