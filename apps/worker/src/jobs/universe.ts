/**
 * Weekly asset universe job (CSN-020).
 *
 * Reads the top coins from CoinGecko and the project lists from DefiLlama, builds the universe
 * with `@coinsnipe/data`, upserts `assets`, marks coins that dropped out inactive with
 * `delisted_at`, and records the run in `job_runs`. It never deletes a row: the store has no
 * delete operation, and a coin that leaves the universe stays for survivorship-free backtests.
 *
 * Everything outside the process (HTTP, clock, sleeping, database) is injected, so the job runs
 * in tests with no network and no database. `run()` wires the real ones.
 *
 * Idempotent per slot: `job_runs` is unique on (job, run_key). This is a weekly job, so its slot
 * (`run_key`) is the UTC run date, `YYYY-MM-DD`, and `run_date` is the same day. A slot already
 * recorded with status `success` is skipped; a `running` or `failed` row is reset and re-run.
 * Status vocabulary is `running | success | failed` (CHECK `job_runs_status_check`).
 *
 * The run's payload is stored in `job_runs.details` (jsonb) so a run's diff is queryable from the
 * database: added, removed, remapped and reactivated coins, `delisted` (id, symbol, reason,
 * delisted_at) and the separate `stablecoins` list. A concise JSON line goes to the log as well.
 * The row also keeps status, timings and the number of rows written. A failed run stores `{}`.
 */
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_OVERRIDES,
  UNIVERSE_CANDIDATE_POOL,
  assertCompleteEnough,
  assertPoolSize,
  buildUniverse,
  coingeckoConfigFromEnv,
  createHttpClient,
  defillamaConfig,
  fetchUniverseSources,
  formatSeedMissingLine,
  formatUnclassifiedReport,
  formatUnmappedReport,
  isAssetUnchanged,
} from '@coinsnipe/data';
import type {
  FetchLike,
  HttpClientConfig,
  UniverseAsset,
  UniverseBuildResult,
  UniverseConfig,
  UniverseOverrides,
} from '@coinsnipe/data';
import type { PrismaClient } from '@coinsnipe/db';

export const UNIVERSE_JOB = 'universe' as const;

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** The `job_runs.details` payload: always a JSON object. */
export type JobRunDetails = { [key: string]: JsonValue };

/** The `job_runs.status` values the job writes (the table also allows `running`). */
export type FinishedRunStatus = 'success' | 'failed';

/**
 * What the job needs from the database. There is deliberately no delete operation.
 * `runKey` is the `job_runs.run_key` slot; for this weekly job it is the UTC day, `YYYY-MM-DD`.
 */
export interface UniverseStore {
  /** Every stored asset, active or not. */
  loadAssets(): Promise<UniverseAsset[]>;
  /** The recorded run for this slot, if any. */
  getRun(job: string, runKey: string): Promise<{ status: string } | null>;
  /** Records the run as started (creates the row, or resets a failed or stale one). */
  startRun(job: string, runKey: string, startedAt: Date): Promise<void>;
  finishRun(
    job: string,
    runKey: string,
    outcome: {
      status: FinishedRunStatus;
      finishedAt: Date;
      rows: number;
      error: string | null;
      details: JobRunDetails;
    },
  ): Promise<void>;
  /** Inserts new assets and updates existing ones. Sets active = true and clears delisted_at. */
  upsertAssets(assets: readonly UniverseAsset[]): Promise<void>;
  /** Sets active = false and delisted_at on rows that are still active. Never deletes. */
  markInactive(updates: ReadonlyArray<{ id: string; delistedAt: Date }>): Promise<void>;
}

export interface UniverseJobDeps {
  readonly fetch: FetchLike;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Date;
  readonly store: UniverseStore;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  /** Rate-limit and retry settings; the defaults follow the CoinGecko plan in the environment. */
  readonly coingecko?: Partial<HttpClientConfig>;
  readonly defillama?: Partial<HttpClientConfig>;
  readonly universe?: Partial<UniverseConfig>;
  readonly overrides?: UniverseOverrides;
  /** Candidate pool size; defaults to the top 400. */
  readonly pool?: number;
}

export interface UniverseJobResult {
  readonly status: 'success' | 'skipped';
  /** The UTC day of the run; also the `job_runs.run_key` slot of this weekly job. */
  readonly runDate: string;
  readonly runKey: string;
  /** Rows written: upserts plus rows marked inactive. */
  readonly rows: number;
  readonly counts: {
    readonly added: number;
    readonly removed: number;
    readonly remapped: number;
    readonly reactivated: number;
    readonly stablecoins: number;
    readonly unmapped: number;
    readonly unclassified: number;
  };
}

const ZERO_COUNTS: UniverseJobResult['counts'] = {
  added: 0,
  removed: 0,
  remapped: 0,
  reactivated: 0,
  stablecoins: 0,
  unmapped: 0,
  unclassified: 0,
};

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The payload stored in `job_runs.details` for a successful run. Everything is plain JSON
 * (dates as ISO strings). `delisted` joins the rows marked inactive with the reason they left,
 * so a survivorship-free backtest can read delisted_at and the reason from the run that set it.
 */
export function buildRunDetails(
  runKey: string,
  result: UniverseBuildResult,
  written: number,
): JobRunDetails {
  const { diff } = result;
  const reasonById = new Map(diff.removed.map((r) => [r.id, r]));
  const details = {
    event: 'universe-diff',
    runKey,
    assets: result.assets.length,
    rowsWritten: written,
    added: diff.added.map((a) => ({ id: a.id, symbol: a.symbol, sector: a.sectorId })),
    removed: diff.removed,
    delisted: result.delist.map((d) => ({
      id: d.id,
      symbol: reasonById.get(d.id)?.symbol ?? null,
      reason: reasonById.get(d.id)?.reason ?? null,
      delistedAt: d.delistedAt.toISOString(),
    })),
    remapped: diff.remapped,
    reactivated: diff.reactivated,
    stablecoins: result.stablecoins,
    excluded: result.excluded.length,
    incomplete: result.incomplete,
    unclassified: result.unclassified.map((u) => u.id),
    seedNotInUniverse: result.seedNotInUniverse,
    fuzzyMatches: result.fuzzyMatches,
    unmapped: result.unmappedReport.length,
  };
  // Drop anything that is not JSON (undefined fields, Dates inside a field change).
  return JSON.parse(JSON.stringify(details)) as JobRunDetails;
}

/** The concise log line: the same run, with the long lists reduced to counts or ids. */
function diffLogLine(runDate: string, result: UniverseBuildResult, written: number): string {
  const { diff } = result;
  return JSON.stringify({
    job: UNIVERSE_JOB,
    runDate,
    event: 'universe-diff',
    assets: result.assets.length,
    rowsWritten: written,
    added: diff.added.map((a) => ({ id: a.id, symbol: a.symbol, sector: a.sectorId })),
    removed: diff.removed,
    remapped: diff.remapped,
    reactivated: diff.reactivated.map((a) => a.id),
    stablecoins: result.stablecoins.length,
    excluded: result.excluded.length,
    incomplete: result.incomplete,
    unclassified: result.unclassified.map((u) => u.id),
    seedNotInUniverse: result.seedNotInUniverse,
    fuzzyMatches: result.fuzzyMatches,
    unmapped: result.unmappedReport.length,
  });
}

export async function runUniverseJob(deps: UniverseJobDeps): Promise<UniverseJobResult> {
  const startedAt = deps.now();
  const runDate = utcDay(startedAt);
  // Weekly job: one slot per UTC day it runs, so the slot key is the run date.
  const runKey = runDate;
  const { store, log } = deps;

  const existing = await store.getRun(UNIVERSE_JOB, runKey);
  if (existing?.status === 'success') {
    log(
      JSON.stringify({ job: UNIVERSE_JOB, runDate, event: 'skipped', reason: 'already ran today' }),
    );
    return { status: 'skipped', runDate, runKey, rows: 0, counts: ZERO_COUNTS };
  }
  await store.startRun(UNIVERSE_JOB, runKey, startedAt);

  try {
    const httpDeps = { fetch: deps.fetch, sleep: deps.sleep, now: () => deps.now().getTime() };
    const coingecko = createHttpClient(coingeckoConfigFromEnv(deps.env, deps.coingecko), httpDeps);
    const defillama = createHttpClient(defillamaConfig(deps.defillama), httpDeps);
    const overrides = deps.overrides ?? DEFAULT_OVERRIDES;

    const sources = await fetchUniverseSources({
      coingecko,
      defillama,
      overrides,
      ...(deps.universe ? { config: deps.universe } : {}),
      ...(deps.pool === undefined ? {} : { pool: deps.pool }),
      log,
    });
    if (sources.failures.length > 0) {
      log(
        JSON.stringify({
          job: UNIVERSE_JOB,
          runDate,
          event: 'source-failures',
          calls: sources.failures,
        }),
      );
    }

    // A truncated candidate list must not delist the stored universe.
    assertPoolSize(sources.markets.length, deps.pool ?? UNIVERSE_CANDIDATE_POOL, deps.universe);

    // Read the stored assets after the long fetch, so the diff base is as fresh as possible.
    const previous = await store.loadAssets();
    const result = buildUniverse({
      asOf: startedAt,
      markets: sources.markets,
      details: sources.details,
      volume7dAvg: sources.volume7dAvg,
      volumeFailed: sources.volumeFailed,
      protocols: sources.protocols,
      parentProtocols: sources.parentProtocols,
      chains: sources.chains,
      previous,
      overrides,
      ...(deps.universe ? { config: deps.universe } : {}),
    });
    // A CoinGecko outage must not shrink the universe: refuse before writing anything.
    assertCompleteEnough(result, sources.markets.length, deps.universe);

    const stored = new Map(previous.map((a) => [a.id, a]));
    const changed = result.assets.filter((a) => {
      const before = stored.get(a.id);
      return before === undefined || !isAssetUnchanged(before, a);
    });
    await store.upsertAssets(changed);
    await store.markInactive(result.delist);
    const rows = changed.length + result.delist.length;

    log(diffLogLine(runDate, result, rows));
    log(formatUnmappedReport(result.unmappedReport));
    log(formatUnclassifiedReport(result.unclassified));
    log(formatSeedMissingLine(result.seedNotInUniverse));
    await store.finishRun(UNIVERSE_JOB, runKey, {
      status: 'success',
      finishedAt: deps.now(),
      rows,
      error: null,
      details: buildRunDetails(runKey, result, rows),
    });
    return {
      status: 'success',
      runDate,
      runKey,
      rows,
      counts: {
        added: result.diff.added.length,
        removed: result.diff.removed.length,
        remapped: result.diff.remapped.length,
        reactivated: result.diff.reactivated.length,
        stablecoins: result.stablecoins.length,
        unmapped: result.unmappedReport.length,
        unclassified: result.unclassified.length,
      },
    };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    try {
      await store.finishRun(UNIVERSE_JOB, runKey, {
        status: 'failed',
        finishedAt: deps.now(),
        rows: 0,
        error: message,
        details: {},
      });
    } catch {
      // Keep the original failure; the run row stays 'running' and the next run resets it.
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Prisma-backed store
// ---------------------------------------------------------------------------

function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

const RUN_KEY = /^\d{4}-\d{2}-\d{2}(T\d{2})?$/;

export function createPrismaUniverseStore(db: PrismaClient): UniverseStore {
  /** The unique key (job, run_key). The CHECK ties run_key's first ten characters to run_date. */
  const slot = (job: string, runKey: string) => {
    if (!RUN_KEY.test(runKey)) throw new Error(`Invalid job_runs run_key: ${runKey}`);
    return { job_runKey: { job, runKey } };
  };
  return {
    async loadAssets() {
      const rows = await db.asset.findMany({ orderBy: { id: 'asc' } });
      return rows.map((r): UniverseAsset => ({
        id: r.id,
        symbol: r.symbol,
        name: r.name,
        coingeckoId: r.coingeckoId,
        defillamaSlug: r.defillamaSlug,
        defillamaChain: r.defillamaChain,
        githubRepos: r.githubRepos,
        sectorId: r.sectorId as UniverseAsset['sectorId'],
        narrativeIds: r.narrativeIds as UniverseAsset['narrativeIds'],
        chain: r.chain,
        genesisDate: r.genesisDate ? r.genesisDate.toISOString().slice(0, 10) : null,
        isMeme: r.isMeme,
        isGoldToken: r.isGoldToken,
        logoUrl: r.logoUrl,
        active: r.active,
        delistedAt: r.delistedAt,
      }));
    },

    async getRun(job, runKey) {
      const row = await db.jobRun.findUnique({
        where: slot(job, runKey),
        select: { status: true },
      });
      return row;
    },

    async startRun(job, runKey, startedAt) {
      await db.jobRun.upsert({
        where: slot(job, runKey),
        create: {
          job,
          runKey,
          runDate: dayToDate(runKey.slice(0, 10)),
          status: 'running',
          startedAt,
        },
        update: {
          status: 'running',
          startedAt,
          finishedAt: null,
          rows: null,
          error: null,
          details: {},
        },
      });
    },

    async finishRun(job, runKey, outcome) {
      await db.jobRun.update({
        where: slot(job, runKey),
        data: {
          status: outcome.status,
          finishedAt: outcome.finishedAt,
          rows: outcome.rows,
          error: outcome.error,
          details: outcome.details,
        },
      });
    },

    async upsertAssets(assets) {
      const BATCH = 100;
      for (let i = 0; i < assets.length; i += BATCH) {
        await db.$transaction(
          assets.slice(i, i + BATCH).map((a) => {
            const data = {
              symbol: a.symbol,
              name: a.name,
              coingeckoId: a.coingeckoId,
              defillamaSlug: a.defillamaSlug,
              defillamaChain: a.defillamaChain,
              githubRepos: [...a.githubRepos],
              sectorId: a.sectorId,
              narrativeIds: [...a.narrativeIds],
              chain: a.chain,
              genesisDate: a.genesisDate === null ? null : dayToDate(a.genesisDate),
              isMeme: a.isMeme,
              isGoldToken: a.isGoldToken,
              logoUrl: a.logoUrl,
              active: true,
              delistedAt: null,
            };
            return db.asset.upsert({
              where: { id: a.id },
              create: { id: a.id, ...data },
              update: data,
            });
          }),
        );
      }
    },

    async markInactive(updates) {
      const byTime = new Map<number, string[]>();
      for (const u of updates) {
        const key = u.delistedAt.getTime();
        byTime.set(key, [...(byTime.get(key) ?? []), u.id]);
      }
      for (const [time, ids] of byTime) {
        await db.asset.updateMany({
          where: { id: { in: ids }, active: true },
          data: { active: false, delistedAt: new Date(time) },
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Runs the job with the real network, clock and database. */
export async function run(): Promise<void> {
  const { prisma } = await import('@coinsnipe/db');
  try {
    await runUniverseJob({
      fetch: (url, init) => globalThis.fetch(url, init),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => new Date(),
      store: createPrismaUniverseStore(prisma),
      env: process.env,
      log: (line) => console.log(line),
    });
  } finally {
    await prisma.$disconnect();
  }
}

// `node dist/jobs/universe.js` runs the job; importing this module (tests, the scheduler) does not.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
