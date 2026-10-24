/**
 * Tests for the weekly universe job (CSN-020). No network, no database: fetch, clock and store
 * are injected. All market numbers below are invented (SAMPLE data).
 */
import type { UniverseAsset } from '@coinsnipe/data';
import type { PrismaClient } from '@coinsnipe/db';
import { describe, expect, it } from 'vitest';
import { UNIVERSE_JOB, createPrismaUniverseStore, runUniverseJob } from './universe';
import type { UniverseJobDeps, UniverseStore } from './universe';

// ---------------------------------------------------------------------------
// SAMPLE responses, shaped like the real APIs
// ---------------------------------------------------------------------------

const SAMPLE_MARKETS = [
  { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', rank: 1 },
  { id: 'ethereum', symbol: 'eth', name: 'Ethereum', rank: 2 },
  { id: 'tether', symbol: 'usdt', name: 'Tether', rank: 3 },
  { id: 'dogecoin', symbol: 'doge', name: 'Dogecoin', rank: 4 },
  { id: 'sample-exchange-token', symbol: 'sxt', name: 'Sample Exchange Token', rank: 5 },
].map(({ id, symbol, name, rank }) => ({
  id,
  symbol,
  name,
  image: `https://example.invalid/sample/${id}.png`,
  current_price: 1,
  market_cap: 1_000_000_000 - rank * 1_000_000,
  market_cap_rank: rank,
  total_volume: 50_000_000,
}));

const SAMPLE_DETAILS: Record<string, unknown> = {
  bitcoin: {
    id: 'bitcoin',
    categories: ['Layer 1 (L1)'],
    genesis_date: '2009-01-03',
    links: { repos_url: { github: ['https://github.com/bitcoin/bitcoin'] } },
  },
  ethereum: { id: 'ethereum', categories: ['Smart Contract Platform'], genesis_date: null },
  tether: { id: 'tether', categories: ['Stablecoins'] },
  dogecoin: { id: 'dogecoin', categories: ['Meme'] },
  // No sector rule matches an exchange token and it is not in the Score Lab list.
  'sample-exchange-token': {
    id: 'sample-exchange-token',
    categories: ['Exchange-based Tokens'],
  },
};

const SAMPLE_CHAINS = [
  {
    gecko_id: 'ethereum',
    tvl: 1000,
    tokenSymbol: 'ETH',
    name: 'Ethereum',
  },
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  deps: UniverseJobDeps;
  store: MemoryStore;
  logs: string[];
  fetched: string[];
  setNow(iso: string): void;
  failMarkets(): void;
  breakDetails(): void;
  breakVolumes(): void;
  removeChains(): void;
  dropFromMarkets(id: string): void;
}

class MemoryStore implements UniverseStore {
  assets = new Map<string, UniverseAsset>();
  runs = new Map<string, { status: string; rows: number; error: string | null }>();
  upsertCalls: string[][] = [];
  inactiveCalls: Array<Array<{ id: string; delistedAt: Date }>> = [];

  async loadAssets() {
    return [...this.assets.values()];
  }
  async getRun(job: string, runDate: string) {
    const run = this.runs.get(`${job}:${runDate}`);
    return run ? { status: run.status } : null;
  }
  async startRun(job: string, runDate: string) {
    this.runs.set(`${job}:${runDate}`, { status: 'running', rows: 0, error: null });
  }
  async finishRun(
    job: string,
    runDate: string,
    outcome: { status: 'ok' | 'failed'; rows: number; error: string | null },
  ) {
    this.runs.set(`${job}:${runDate}`, {
      status: outcome.status,
      rows: outcome.rows,
      error: outcome.error,
    });
  }
  async upsertAssets(assets: readonly UniverseAsset[]) {
    this.upsertCalls.push(assets.map((a) => a.id));
    for (const a of assets) this.assets.set(a.id, { ...a, active: true, delistedAt: null });
  }
  async markInactive(updates: ReadonlyArray<{ id: string; delistedAt: Date }>) {
    this.inactiveCalls.push([...updates]);
    for (const u of updates) {
      const row = this.assets.get(u.id);
      if (row?.active) this.assets.set(u.id, { ...row, active: false, delistedAt: u.delistedAt });
    }
  }
}

function harness(startIso = '2026-01-05T03:00:00.000Z'): Harness {
  let now = new Date(startIso);
  let marketsFail = false;
  let detailsBroken = false;
  let volumesBroken = false;
  let noChains = false;
  const dropped = new Set<string>();
  const fetched: string[] = [];
  const logs: string[] = [];
  const store = new MemoryStore();

  const route = (path: string): unknown => {
    if (path.startsWith('/coins/markets')) {
      return SAMPLE_MARKETS.filter((m) => !dropped.has(m.id));
    }
    if (path === '/protocols') return [];
    if (path === '/lite/protocols2') return { parentProtocols: [] };
    if (path === '/v2/chains') return noChains ? [] : SAMPLE_CHAINS;
    if (/\/market_chart/.test(path)) {
      return {
        total_volumes: [
          [0, 50_000_000],
          [1, 50_000_000],
        ],
      };
    }
    const id = /^\/coins\/([^/?]+)\?/.exec(path)?.[1] ?? '';
    return SAMPLE_DETAILS[id];
  };

  const deps: UniverseJobDeps = {
    fetch: async (url) => {
      const path = url
        .replace('https://api.coingecko.com/api/v3', '')
        .replace('https://api.llama.fi', '');
      fetched.push(path);
      const isMarkets = path.startsWith('/coins/markets');
      const isDetail = !isMarkets && /^\/coins\/[^/?]+\?/.test(path);
      const fail =
        (isMarkets && marketsFail) ||
        (isDetail && detailsBroken) ||
        (/\/market_chart/.test(path) && volumesBroken);
      return {
        ok: !fail,
        status: fail ? 500 : 200,
        headers: { get: () => null },
        json: async () => route(path),
      };
    },
    sleep: async (ms) => {
      now = new Date(now.getTime() + ms);
    },
    now: () => now,
    store,
    env: {},
    log: (line) => logs.push(line),
    pool: SAMPLE_MARKETS.length,
    coingecko: { maxRetries: 1, baseBackoffMs: 1, minIntervalMs: 1 },
    defillama: { maxRetries: 1, baseBackoffMs: 1, minIntervalMs: 1 },
  };
  return {
    deps,
    store,
    logs,
    fetched,
    setNow: (iso) => {
      now = new Date(iso);
    },
    failMarkets: () => {
      marketsFail = true;
    },
    breakDetails: () => {
      detailsBroken = true;
    },
    breakVolumes: () => {
      volumesBroken = true;
    },
    removeChains: () => {
      noChains = true;
    },
    dropFromMarkets: (id) => {
      dropped.add(id);
    },
  };
}

const diffLine = (logs: string[]) =>
  JSON.parse([...logs].reverse().find((l) => l.includes('"event":"universe-diff"')) ?? '{}') as {
    added: Array<{ id: string }>;
    removed: Array<{ id: string; reason: string }>;
    remapped: unknown[];
    rowsWritten: number;
    stablecoins: number;
  };

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

describe('universe job', () => {
  it('upserts the universe, keeps stablecoins out, and records the run', async () => {
    const h = harness();
    const result = await runUniverseJob(h.deps);

    expect(result.status).toBe('ok');
    expect(result.runDate).toBe('2026-01-05');
    expect([...h.store.assets.keys()].sort()).toEqual(['bitcoin', 'dogecoin', 'ethereum']);
    expect(h.store.assets.get('bitcoin')).toMatchObject({
      coingeckoId: 'bitcoin',
      sectorId: 'gold',
      narrativeIds: ['etf', 'btcfi'],
      githubRepos: ['bitcoin/bitcoin'],
      genesisDate: '2009-01-03',
      active: true,
    });
    expect(h.store.assets.get('ethereum')?.defillamaChain).toBe('Ethereum');
    expect(h.store.assets.get('dogecoin')).toMatchObject({ sectorId: 'culture', isMeme: true });

    expect(h.store.runs.get(`${UNIVERSE_JOB}:2026-01-05`)).toEqual({
      status: 'ok',
      rows: 3,
      error: null,
    });
    expect(result.rows).toBe(3);
    expect(result.counts).toMatchObject({ added: 3, removed: 0, remapped: 0, stablecoins: 1 });
  });

  it('logs the diff (added, removed, remapped) and the unmapped report', async () => {
    const h = harness();
    await runUniverseJob(h.deps);
    const diff = diffLine(h.logs);
    expect(diff.added.map((a) => a.id).sort()).toEqual(['bitcoin', 'dogecoin', 'ethereum']);
    expect(diff.removed).toEqual([]);
    expect(diff.remapped).toEqual([]);
    expect(diff.stablecoins).toBe(1);
    expect(diff.rowsWritten).toBe(3);
    // The unmapped-in-deposit-or-fee-sector report is printed for a human. Ethereum's chain is
    // mapped in this run, so nothing is listed.
    expect(h.logs).toContain('Unmapped assets in deposit-or-fee sectors: none');
  });

  it('lists a deposit-or-fee asset with no DefiLlama mapping in the logged report', async () => {
    const h = harness();
    h.removeChains();
    const result = await runUniverseJob(h.deps);
    expect(result.counts.unmapped).toBe(1);
    const report = h.logs.find((l) =>
      l.startsWith('Unmapped assets in deposit-or-fee sectors (1)'),
    );
    expect(report).toContain('platforms');
    expect(report).toContain('ethereum');
  });

  it('does nothing when the day is already recorded as ok', async () => {
    const h = harness();
    await runUniverseJob(h.deps);
    const calls = h.fetched.length;
    const again = await runUniverseJob(h.deps);
    expect(again).toMatchObject({ status: 'skipped', rows: 0 });
    expect(h.fetched).toHaveLength(calls);
    expect(h.store.upsertCalls).toHaveLength(1);
  });

  it('writes nothing on a later run when nothing changed', async () => {
    const h = harness();
    await runUniverseJob(h.deps);
    h.setNow('2026-01-12T03:00:00.000Z');
    const second = await runUniverseJob(h.deps);
    expect(second).toMatchObject({ status: 'ok', rows: 0 });
    expect(h.store.upsertCalls.at(-1)).toEqual([]);
    expect(h.store.inactiveCalls.at(-1)).toEqual([]);
    expect(diffLine(h.logs)).toMatchObject({ rowsWritten: 0, added: [], removed: [] });
  });

  it('never deletes: a coin that drops out stays, inactive, with delisted_at', async () => {
    const h = harness();
    await runUniverseJob(h.deps);
    h.setNow('2026-01-12T03:00:00.000Z');
    h.dropFromMarkets('dogecoin');
    const second = await runUniverseJob(h.deps);

    expect(h.store.assets.size).toBe(3); // nothing was removed from the table
    const doge = h.store.assets.get('dogecoin');
    expect(doge?.active).toBe(false);
    expect(doge?.delistedAt?.toISOString().slice(0, 10)).toBe('2026-01-12');
    expect(second.counts.removed).toBe(1);
    expect(second.rows).toBe(1);
    expect(diffLine(h.logs).removed).toEqual([
      { id: 'dogecoin', symbol: 'DOGE', reason: 'out-of-candidate-pool' },
    ]);
  });

  it('reactivates a coin that returns', async () => {
    const h = harness();
    await runUniverseJob(h.deps);
    h.setNow('2026-01-12T03:00:00.000Z');
    h.dropFromMarkets('dogecoin');
    await runUniverseJob(h.deps);

    const back = harness('2026-01-19T03:00:00.000Z');
    // Same store, coin present again.
    const deps = { ...back.deps, store: h.store };
    await runUniverseJob(deps);
    expect(h.store.assets.get('dogecoin')).toMatchObject({ active: true, delistedAt: null });
  });

  it('logs a remapped coin when its mapping changes', async () => {
    const h = harness();
    await runUniverseJob(h.deps);
    const eth = h.store.assets.get('ethereum');
    if (!eth) throw new Error('ethereum missing');
    h.store.assets.set('ethereum', { ...eth, defillamaChain: 'Old Name' });
    h.setNow('2026-01-12T03:00:00.000Z');
    const second = await runUniverseJob(h.deps);
    expect(second.counts.remapped).toBe(1);
    expect(h.store.assets.get('ethereum')?.defillamaChain).toBe('Ethereum');
    expect(JSON.stringify(diffLine(h.logs).remapped)).toContain('Old Name');
  });

  it('records a failed run, writes nothing, and can run again the next day', async () => {
    const h = harness();
    h.failMarkets();
    await expect(runUniverseJob(h.deps)).rejects.toThrow(/HTTP 500/);
    expect(h.store.assets.size).toBe(0);
    expect(h.store.runs.get(`${UNIVERSE_JOB}:2026-01-05`)).toMatchObject({
      status: 'failed',
      rows: 0,
    });
    expect(h.store.runs.get(`${UNIVERSE_JOB}:2026-01-05`)?.error).toContain('/coins/markets');

    // The same day can be retried because the row is not 'ok'.
    const retry = harness();
    const result = await runUniverseJob({ ...retry.deps, store: h.store });
    expect(result.status).toBe('ok');
    expect(h.store.assets.size).toBe(3);
  });

  it('refuses to apply a run when too many coins lack data, and keeps the stored universe', async () => {
    const h = harness();
    await runUniverseJob(h.deps);
    const before = JSON.stringify([...h.store.assets.values()]);

    h.setNow('2026-01-12T03:00:00.000Z');
    h.breakDetails();
    await expect(runUniverseJob(h.deps)).rejects.toThrow(/Universe run refused/);
    expect(JSON.stringify([...h.store.assets.values()])).toBe(before);
    expect(h.store.inactiveCalls.every((c) => c.length === 0)).toBe(true);
    expect(h.store.runs.get(`${UNIVERSE_JOB}:2026-01-12`)).toMatchObject({ status: 'failed' });
  });

  it('F1: failed 7-day volume calls make the run refuse, not fall back to 24h volume', async () => {
    const h = harness();
    await runUniverseJob(h.deps);
    const before = JSON.stringify([...h.store.assets.values()]);

    h.setNow('2026-01-12T03:00:00.000Z');
    h.breakVolumes();
    await expect(runUniverseJob(h.deps)).rejects.toThrow(/Universe run refused/);
    expect(JSON.stringify([...h.store.assets.values()])).toBe(before);
    expect(h.store.inactiveCalls.every((c) => c.length === 0)).toBe(true);
    const run = h.store.runs.get(`${UNIVERSE_JOB}:2026-01-12`);
    expect(run?.status).toBe('failed');
    expect(run?.status).not.toBe('ok');
    expect(
      h.logs.some((l) => l.includes('"event":"source-failures"') && l.includes('volume:bitcoin')),
    ).toBe(true);
  });

  it('F2: prints the unclassified coins with their categories and does not store them', async () => {
    const h = harness();
    const result = await runUniverseJob(h.deps);
    expect(h.store.assets.has('sample-exchange-token')).toBe(false);
    expect(result.counts.unclassified).toBe(1);
    const section = h.logs.find((l) => l.startsWith('Unclassified coins skipped (1)'));
    expect(section).toContain('sample-exchange-token');
    expect(section).toContain('"Sample Exchange Token"');
    expect(section).toContain('categories: Exchange-based Tokens');
    expect(diffLine(h.logs)).toMatchObject({ unclassified: ['sample-exchange-token'] });
  });

  it('F4: prints one line naming the sample coins that are not in the universe', async () => {
    const h = harness();
    await runUniverseJob(h.deps);
    const line = h.logs.find((l) => l.startsWith('Seed coins not in the universe ('));
    expect(line).toBeDefined();
    expect(line).not.toContain('\n');
    expect(line).toContain('kaspa (outside-candidate-pool)');
    expect(line).not.toContain('bitcoin (');
    expect(line).not.toContain('dogecoin (');
  });

  it('F5: refuses a truncated markets response and does not delist the stored universe', async () => {
    const h = harness();
    await runUniverseJob(h.deps);
    h.setNow('2026-01-12T03:00:00.000Z');
    // The job asked for 400 candidates and got 5.
    await expect(runUniverseJob({ ...h.deps, pool: 400 })).rejects.toThrow(
      /CoinGecko returned 5 market rows/,
    );
    expect([...h.store.assets.values()].every((a) => a.active)).toBe(true);
    expect(h.store.inactiveCalls.every((c) => c.length === 0)).toBe(true);
    expect(h.store.runs.get(`${UNIVERSE_JOB}:2026-01-12`)).toMatchObject({ status: 'failed' });
  });

  it('S2: reads the stored assets once, after the long fetch, not before', async () => {
    const h = harness();
    const fetchedWhenLoaded: number[] = [];
    const original = h.store.loadAssets.bind(h.store);
    h.store.loadAssets = async () => {
      fetchedWhenLoaded.push(h.fetched.length);
      return original();
    };
    await runUniverseJob(h.deps);
    expect(fetchedWhenLoaded).toEqual([h.fetched.length]);
    expect(h.fetched.length).toBeGreaterThan(0);
  });

  it('keeps the original error if recording the failure also fails', async () => {
    const h = harness();
    h.failMarkets();
    h.store.finishRun = async () => {
      throw new Error('database down');
    };
    await expect(runUniverseJob(h.deps)).rejects.toThrow(/HTTP 500/);
  });

  it('puts no secret into the log or the run row', async () => {
    const h = harness();
    const deps: UniverseJobDeps = {
      ...h.deps,
      env: { COINGECKO_API_KEY: 'SAMPLE_KEY_NOT_REAL', COINGECKO_PLAN: 'demo' },
    };
    h.failMarkets();
    await expect(runUniverseJob(deps)).rejects.toThrow();
    const everything = JSON.stringify([...h.store.runs.values()]) + h.logs.join('\n');
    expect(everything).not.toContain('SAMPLE_KEY_NOT_REAL');
  });

  it('sends the key as a header with the demo plan', async () => {
    const h = harness();
    const headers: Array<Record<string, string> | undefined> = [];
    const deps: UniverseJobDeps = {
      ...h.deps,
      env: { COINGECKO_API_KEY: 'SAMPLE_KEY_NOT_REAL', COINGECKO_PLAN: 'demo' },
      fetch: async (url, init) => {
        headers.push(init?.headers);
        return h.deps.fetch(url, init);
      },
    };
    await runUniverseJob(deps);
    const cg = headers.filter((x) => x !== undefined);
    expect(cg.length).toBeGreaterThan(0);
    expect(cg[0]).toEqual({ 'x-cg-demo-api-key': 'SAMPLE_KEY_NOT_REAL' });
  });
});

// ---------------------------------------------------------------------------
// Prisma adapter, against a recording fake client
// ---------------------------------------------------------------------------

describe('createPrismaUniverseStore', () => {
  function fakeDb() {
    const calls: Array<{ op: string; args: unknown }> = [];
    const record =
      (op: string, result: unknown = undefined) =>
      async (args?: unknown) => {
        calls.push({ op, args });
        return result;
      };
    const rows = [
      {
        id: 'bitcoin',
        symbol: 'BTC',
        name: 'Bitcoin',
        coingeckoId: 'bitcoin',
        defillamaSlug: null,
        defillamaChain: 'Bitcoin',
        githubRepos: ['bitcoin/bitcoin'],
        sectorId: 'gold',
        narrativeIds: ['etf'],
        chain: 'Own chain',
        genesisDate: new Date('2009-01-03T00:00:00.000Z'),
        isMeme: false,
        isGoldToken: false,
        logoUrl: null,
        active: true,
        delistedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const db = {
      asset: {
        findMany: record('asset.findMany', rows),
        upsert: (args: unknown) => {
          calls.push({ op: 'asset.upsert', args });
          return { op: 'asset.upsert', args };
        },
        updateMany: record('asset.updateMany', { count: 1 }),
      },
      jobRun: {
        findUnique: record('jobRun.findUnique', { status: 'ok' }),
        upsert: record('jobRun.upsert'),
        update: record('jobRun.update'),
      },
      $transaction: async (ops: unknown[]) => {
        calls.push({ op: '$transaction', args: ops.length });
        return ops;
      },
    };
    // Any delete call is a failure, wherever it is made.
    const guarded = new Proxy(db, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /delete/i.test(prop)) throw new Error(`forbidden: ${prop}`);
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (value && typeof value === 'object') {
          return new Proxy(value, {
            get(inner, key, r) {
              if (typeof key === 'string' && /delete/i.test(key))
                throw new Error(`forbidden: ${key}`);
              return Reflect.get(inner, key, r) as unknown;
            },
          });
        }
        return value;
      },
    });
    return { db: guarded as unknown as PrismaClient, calls };
  }

  const asset: UniverseAsset = {
    id: 'bitcoin',
    symbol: 'BTC',
    name: 'Bitcoin',
    coingeckoId: 'bitcoin',
    defillamaSlug: null,
    defillamaChain: null,
    githubRepos: ['bitcoin/bitcoin'],
    sectorId: 'gold',
    narrativeIds: ['etf', 'btcfi'],
    chain: 'Own chain',
    genesisDate: '2009-01-03',
    isMeme: false,
    isGoldToken: false,
    logoUrl: null,
    active: true,
    delistedAt: null,
  };

  it('reads assets back in the builder shape, with the genesis date as a day string', async () => {
    const { db } = fakeDb();
    const loaded = await createPrismaUniverseStore(db).loadAssets();
    expect(loaded).toEqual([
      expect.objectContaining({
        id: 'bitcoin',
        genesisDate: '2009-01-03',
        defillamaChain: 'Bitcoin',
      }),
    ]);
  });

  it('upserts by id, reactivating the row, in one transaction per batch', async () => {
    const { db, calls } = fakeDb();
    await createPrismaUniverseStore(db).upsertAssets([asset]);
    const upsert = calls.find((c) => c.op === 'asset.upsert')?.args as {
      where: unknown;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(upsert.where).toEqual({ id: 'bitcoin' });
    expect(upsert.create).toMatchObject({ id: 'bitcoin', coingeckoId: 'bitcoin', active: true });
    expect(upsert.update).toMatchObject({ active: true, delistedAt: null, sectorId: 'gold' });
    expect(upsert.update).not.toHaveProperty('id');
    expect(upsert.create['genesisDate']).toEqual(new Date('2009-01-03T00:00:00.000Z'));
    expect(calls.filter((c) => c.op === '$transaction')).toHaveLength(1);
  });

  it('marks rows inactive with updateMany and never calls a delete', async () => {
    const { db, calls } = fakeDb();
    const when = new Date('2026-01-12T03:00:00.000Z');
    await createPrismaUniverseStore(db).markInactive([
      { id: 'a', delistedAt: when },
      { id: 'b', delistedAt: when },
    ]);
    expect(calls).toEqual([
      {
        op: 'asset.updateMany',
        args: {
          where: { id: { in: ['a', 'b'] }, active: true },
          data: { active: false, delistedAt: when },
        },
      },
    ]);
    await createPrismaUniverseStore(db).markInactive([]);
    expect(calls).toHaveLength(1);
  });

  it('records job runs against the (job, run_date) unique key', async () => {
    const { db, calls } = fakeDb();
    const store = createPrismaUniverseStore(db);
    const day = new Date('2026-01-05T00:00:00.000Z');
    expect(await store.getRun('universe', '2026-01-05')).toEqual({ status: 'ok' });
    await store.startRun('universe', '2026-01-05', new Date('2026-01-05T03:00:00.000Z'));
    await store.finishRun('universe', '2026-01-05', {
      status: 'failed',
      finishedAt: new Date('2026-01-05T04:00:00.000Z'),
      rows: 0,
      error: 'boom',
    });
    const key = { job_runDate: { job: 'universe', runDate: day } };
    expect(calls[0]?.args).toMatchObject({ where: key });
    expect(calls[1]?.args).toMatchObject({
      where: key,
      create: { status: 'running' },
      update: { status: 'running', finishedAt: null, error: null },
    });
    expect(calls[2]?.args).toMatchObject({
      where: key,
      data: { status: 'failed', rows: 0, error: 'boom' },
    });
  });
});
