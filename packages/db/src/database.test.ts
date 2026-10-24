/**
 * Behavioural checks against a real Postgres. Each run builds its own throwaway schema
 * inside the database named by DATABASE_URL, applies prisma/migrations (all of them, or the
 * first few for the upgrade and rollback checks), runs the assertions and drops the schema,
 * so it never touches tables another run created and needs no prior `prisma migrate`.
 *
 * Skipped (with a warning) when DATABASE_URL is unset. Refuses non-local hosts unless
 * CSN_DB_TEST_ALLOW_REMOTE=1, so a pointed-at-Neon URL is never used by accident.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { indexRuleViolations, replayMigrations, type SchemaModel } from './migration-model';
import { seedReferenceData } from './seed';

const baseUrl = process.env['DATABASE_URL'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isUsable(url: string | undefined): url is string {
  if (url === undefined || url === '') return false;
  if (process.env['CSN_DB_TEST_ALLOW_REMOTE'] === '1') return true;
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

const usable = isUsable(baseUrl);
if (!usable) {
  console.warn(
    'database.test.ts skipped: set DATABASE_URL to a LOCAL Postgres to run the database checks.',
  );
}

const migrationsDir = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));

/** Split a Prisma migration into statements. Prisma output has no dollar-quoted bodies. */
function statementsOf(sql: string): string[] {
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  expect(withoutComments).not.toContain('$$');
  return withoutComments
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

interface ScratchSchema {
  readonly name: string;
  readonly prisma: PrismaClient;
  drop(): Promise<void>;
}

const migrationDirs = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

async function applyMigration(prisma: PrismaClient, dir: string): Promise<void> {
  const sql = readFileSync(`${migrationsDir}${dir}/migration.sql`, 'utf8');
  for (const statement of statementsOf(sql)) {
    await prisma.$executeRawUnsafe(statement);
  }
}

/** Build a throwaway schema; `upTo` limits how many migrations are applied (default all). */
async function createScratchSchema(url: string, upTo?: number): Promise<ScratchSchema> {
  const name = `csn_db_test_${randomBytes(5).toString('hex')}`;
  const scoped = new URL(url);
  scoped.searchParams.set('schema', name);
  const prisma = new PrismaClient({ datasourceUrl: scoped.toString() });
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${name}"`);
  for (const dir of migrationDirs.slice(0, upTo)) {
    await applyMigration(prisma, dir);
  }
  return {
    name,
    prisma,
    drop: async () => {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
      await prisma.$disconnect();
    },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function rejectsWithUniqueViolation(action: Promise<unknown>): Promise<boolean> {
  try {
    await action;
    return false;
  } catch (error) {
    return isUniqueViolation(error);
  }
}

/** Run one statement; return the database error text, or null when it succeeded. */
async function failureOf(prisma: PrismaClient, sql: string): Promise<string | null> {
  try {
    await prisma.$executeRawUnsafe(sql);
    return null;
  } catch (error) {
    return String(error);
  }
}

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe.skipIf(!usable)('constraints and data rules (real Postgres)', () => {
  let scratch: ScratchSchema;

  beforeAll(async () => {
    scratch = await createScratchSchema(baseUrl as string);
  }, 120_000);

  afterAll(async () => {
    await scratch.drop();
  }, 60_000);

  it('keeps one job_runs row per (job, run_key): daily slot = date, hourly slot = UTC hour', async () => {
    const { prisma } = scratch;
    const row = (job: string, runDate: Date, runKey: string) => ({
      job,
      runDate,
      runKey,
      status: 'running',
      startedAt: new Date(),
    });
    await prisma.jobRun.create({ data: row('prices', day('2026-01-05'), '2026-01-05') });
    // The same daily slot again is rejected.
    expect(
      await rejectsWithUniqueViolation(
        prisma.jobRun.create({ data: row('prices', day('2026-01-05'), '2026-01-05') }),
      ),
    ).toBe(true);
    // A different job or a different day is allowed.
    await prisma.jobRun.create({ data: row('scoring', day('2026-01-05'), '2026-01-05') });
    await prisma.jobRun.create({ data: row('prices', day('2026-01-06'), '2026-01-06') });
    // Hourly jobs: several slots on one date, one row per hour.
    for (const hour of ['00', '01', '23']) {
      await prisma.jobRun.create({
        data: row('funding', day('2026-01-05'), `2026-01-05T${hour}`),
      });
    }
    expect(
      await rejectsWithUniqueViolation(
        prisma.jobRun.create({ data: row('funding', day('2026-01-05'), '2026-01-05T01') }),
      ),
    ).toBe(true);
    expect(await prisma.jobRun.count()).toBe(6);
    // details defaults to an empty JSON object.
    const stored = await prisma.jobRun.findFirst({ where: { job: 'funding' } });
    expect(stored?.details).toEqual({});
  });

  it('claims a job_runs slot idempotently: skip when a success row exists, retry after failure', async () => {
    const { prisma } = scratch;
    // The claim CSN-027 documents in the README: zero rows returned means skip the slot.
    const claim = async (runKey: string) =>
      prisma.$queryRaw<{ id: bigint }[]>`
        INSERT INTO job_runs (job, run_date, run_key, status, started_at)
        VALUES ('claim-job', ${day(runKey.slice(0, 10))}, ${runKey}, 'running', now())
        ON CONFLICT (job, run_key) DO UPDATE
          SET status = 'running', started_at = now(), finished_at = NULL, error = NULL
          WHERE job_runs.status <> 'success'
        RETURNING id`;
    expect(await claim('2026-03-01T05')).toHaveLength(1); // first run claims the slot
    expect(await claim('2026-03-01T05')).toHaveLength(1); // still running or crashed: re-claim
    await prisma.$executeRaw`UPDATE job_runs SET status = 'failed', error = 'boom' WHERE job = 'claim-job'`;
    expect(await claim('2026-03-01T05')).toHaveLength(1); // retry after failure
    await prisma.$executeRaw`UPDATE job_runs SET status = 'success', finished_at = now(), details = '{"warnings":["drift"]}' WHERE job = 'claim-job'`;
    expect(await claim('2026-03-01T05')).toHaveLength(0); // success: skip
    expect(await claim('2026-03-01T06')).toHaveLength(1); // the next hourly slot is free
    expect(await prisma.jobRun.count({ where: { job: 'claim-job' } })).toBe(2);
  });

  it('rejects a second stripe_events row with the same event_id', async () => {
    const { prisma } = scratch;
    await prisma.stripeEvent.create({ data: { eventId: 'evt_test_1', type: 'invoice.paid' } });
    expect(
      await rejectsWithUniqueViolation(
        prisma.stripeEvent.create({ data: { eventId: 'evt_test_1', type: 'invoice.paid' } }),
      ),
    ).toBe(true);
    // The webhook idempotency pattern: the second insert is a no-op, not an error.
    const inserted = await prisma.$executeRaw`
      INSERT INTO stripe_events (event_id, type) VALUES ('evt_test_1', 'invoice.paid')
      ON CONFLICT (event_id) DO NOTHING`;
    expect(inserted).toBe(0);
    expect(await prisma.stripeEvent.count()).toBe(1);
  });

  it('keeps one signal per dedupe_key and one asset per coingecko_id', async () => {
    const { prisma } = scratch;
    await prisma.sector.create({
      data: { id: 'gold', name: 'Digital gold', description: 'Test.' },
    });
    await prisma.asset.create({
      data: {
        id: 'asset-a',
        symbol: 'AAA',
        name: 'Asset A',
        coingeckoId: 'asset-a',
        sectorId: 'gold',
      },
    });
    expect(
      await rejectsWithUniqueViolation(
        prisma.asset.create({
          data: {
            id: 'asset-b',
            symbol: 'BBB',
            name: 'Asset B',
            coingeckoId: 'asset-a',
            sectorId: 'gold',
          },
        }),
      ),
    ).toBe(true);
    const signal = {
      code: 'SG1',
      assetId: 'asset-a',
      firedAt: new Date(),
      what: 'Test what',
      why: 'Test why',
      checkText: 'Test check',
      dedupeKey: 'SG1:asset-a:2026-01-05',
    };
    await prisma.signal.create({ data: signal });
    expect(await rejectsWithUniqueViolation(prisma.signal.create({ data: signal }))).toBe(true);
  });

  it('keys daily tables on (asset_id, date)', async () => {
    const { prisma } = scratch;
    const row = {
      assetId: 'asset-a',
      date: day('2026-01-05'),
      close: new Prisma.Decimal('1.5'),
      asOf: day('2026-01-05'),
      source: 'test',
    };
    await prisma.priceDaily.create({ data: row });
    expect(await rejectsWithUniqueViolation(prisma.priceDaily.create({ data: row }))).toBe(true);
    await prisma.priceDaily.create({ data: { ...row, date: day('2026-01-06') } });
  });

  it('keeps calendar entries per coin, and deduplicates market-wide ones', async () => {
    const { prisma } = scratch;
    await prisma.sector.upsert({
      where: { id: 'gold' },
      create: { id: 'gold', name: 'Digital gold', description: 'Test.' },
      update: {},
    });
    for (const id of ['cal-a', 'cal-b']) {
      await prisma.asset.create({
        data: { id, symbol: id, name: id, coingeckoId: id, sectorId: 'gold' },
      });
    }
    const entry = (assetId: string | null) => ({
      assetId,
      date: day('2026-02-01'),
      kind: 'unlock' as const,
      title: 'Token unlock',
      asOf: day('2026-01-20'),
      source: 'test',
    });
    // Two coins, same date, kind and title: both stored.
    await prisma.eventCalendarEntry.create({ data: entry('cal-a') });
    await prisma.eventCalendarEntry.create({ data: entry('cal-b') });
    // The same coin twice: rejected.
    expect(
      await rejectsWithUniqueViolation(prisma.eventCalendarEntry.create({ data: entry('cal-a') })),
    ).toBe(true);
    // A market-wide row does not collide with coin rows, but two market-wide duplicates do.
    await prisma.eventCalendarEntry.create({ data: entry(null) });
    expect(
      await rejectsWithUniqueViolation(prisma.eventCalendarEntry.create({ data: entry(null) })),
    ).toBe(true);
    // The documented raw-SQL upsert for market-wide rows is a no-op on the duplicate.
    const inserted = await prisma.$executeRaw`
      INSERT INTO events_calendar (date, kind, title, as_of, source)
      VALUES ('2026-02-01', 'unlock', 'Token unlock', '2026-01-20', 'test')
      ON CONFLICT (date, kind, title) WHERE asset_id IS NULL DO NOTHING`;
    expect(inserted).toBe(0);
    expect(await prisma.eventCalendarEntry.count()).toBe(3);
  });

  it('keeps every published vintage of a macro series observation', async () => {
    const { prisma } = scratch;
    const vintage = (asOf: string, value: string) => ({
      seriesId: 'M2SL',
      date: day('2026-01-01'),
      value: new Prisma.Decimal(value),
      asOf: day(asOf),
      source: 'test',
    });
    await prisma.macroDaily.create({ data: vintage('2026-02-01', '100') });
    await prisma.macroDaily.create({ data: vintage('2026-03-01', '101') }); // a revision
    // The same vintage twice is still rejected.
    expect(
      await rejectsWithUniqueViolation(
        prisma.macroDaily.create({ data: vintage('2026-03-01', '102') }),
      ),
    ).toBe(true);
    // Point-in-time read: before the revision the original value is what was known.
    const known = await prisma.macroDaily.findFirst({
      where: { seriesId: 'M2SL', date: day('2026-01-01'), asOf: { lte: day('2026-02-15') } },
      orderBy: { asOf: 'desc' },
    });
    expect(known?.value.toString()).toBe('100');
    const latest = await prisma.macroDaily.findFirst({
      where: { seriesId: 'M2SL', date: day('2026-01-01') },
      orderBy: { asOf: 'desc' },
    });
    expect(latest?.value.toString()).toBe('101');
    expect(await prisma.macroDaily.count()).toBe(2);
  });

  it('supports the calls @auth/prisma-adapter makes', async () => {
    const { prisma } = scratch;
    const user = await prisma.user.create({
      data: { name: 'Test User', email: 'test@example.invalid', image: null },
    });
    await prisma.account.create({
      data: {
        userId: user.id,
        type: 'oauth',
        provider: 'google',
        providerAccountId: 'g-1',
        access_token: 'a',
        expires_at: 1,
        token_type: 'bearer',
        scope: 'openid',
        id_token: 'i',
        session_state: null,
      },
    });
    const byAccount = await prisma.account.findUnique({
      where: { provider_providerAccountId: { provider: 'google', providerAccountId: 'g-1' } },
      select: { user: true },
    });
    expect(byAccount?.user.id).toBe(user.id);
    await prisma.session.create({
      data: { sessionToken: 'tok', userId: user.id, expires: new Date(Date.now() + 60_000) },
    });
    await prisma.verificationToken.create({
      data: {
        identifier: 'test@example.invalid',
        token: 'vt',
        expires: new Date(Date.now() + 60_000),
      },
    });
    await prisma.verificationToken.delete({
      where: { identifier_token: { identifier: 'test@example.invalid', token: 'vt' } },
    });
    // Deleting the user removes its sessions and accounts.
    await prisma.user.delete({ where: { id: user.id } });
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.account.count({ where: { userId: user.id } })).toBe(0);
  });
});

interface CheckCase {
  readonly constraint: string;
  /** Statements that each violate this constraint and nothing else. */
  readonly bad: readonly string[];
  /** A statement that is valid, proving the bad ones fail only because of the constraint. */
  readonly good: string;
}

function scoreRow(date: string, quality: number, usage: string, extra = ''): string {
  return `INSERT INTO scores_daily
    (asset_id, date, horizon, quality, usage, timing, temperature_band, combined, combined_label,
     quadrant, archetype, coverage_pct, breakdown, model_version${extra === '' ? '' : ', gates_fired'})
    VALUES ('asset-a', '${date}', 'short', ${quality}, ${usage}, 50, 'balanced', 50, 'mixed',
     'q', 'a', 90, '{}', 'v'${extra === '' ? '' : `, ${extra}`})`;
}

const CHECK_CASES: readonly CheckCase[] = [
  {
    constraint: 'news_items_tone_check',
    bad: [
      `INSERT INTO news_items (url_hash, url, published_at, title, tone, as_of, source) VALUES ('n1', 'u', now(), 't', 101, '2026-01-05', 's')`,
      `INSERT INTO news_items (url_hash, url, published_at, title, tone, as_of, source) VALUES ('n2', 'u', now(), 't', -101, '2026-01-05', 's')`,
    ],
    good: `INSERT INTO news_items (url_hash, url, published_at, title, tone, as_of, source) VALUES ('n3', 'u', now(), 't', 100, '2026-01-05', 's')`,
  },
  {
    constraint: 'fear_greed_daily_value_check',
    bad: [
      `INSERT INTO fear_greed_daily (date, value, as_of, source) VALUES ('2026-01-05', 101, '2026-01-05', 's')`,
    ],
    good: `INSERT INTO fear_greed_daily (date, value, as_of, source) VALUES ('2026-01-05', 100, '2026-01-05', 's')`,
  },
  {
    constraint: 'profiles_knowledge_check',
    bad: [
      `INSERT INTO profiles (user_id, knowledge) VALUES ('u-1', 5)`,
      `INSERT INTO profiles (user_id, knowledge) VALUES ('u-1', 0)`,
    ],
    good: `INSERT INTO profiles (user_id, knowledge) VALUES ('u-1', 4)`,
  },
  {
    constraint: 'signals_code_check',
    bad: [
      `INSERT INTO signals (code, fired_at, what, why, check_text, dedupe_key) VALUES ('SG15', now(), 'w', 'y', 'c', 'k1')`,
      `INSERT INTO signals (code, fired_at, what, why, check_text, dedupe_key) VALUES ('SG0', now(), 'w', 'y', 'c', 'k2')`,
    ],
    good: `INSERT INTO signals (code, fired_at, what, why, check_text, dedupe_key) VALUES ('SG14', now(), 'w', 'y', 'c', 'k3')`,
  },
  {
    constraint: 'key_levels_zone_check',
    bad: [
      `INSERT INTO key_levels (asset_id, date, kind, low, high, strength_points, strength_label, model_version) VALUES ('asset-a', '2026-01-05', 'support', 2, 1, 1, 'weak', 'v')`,
    ],
    good: `INSERT INTO key_levels (asset_id, date, kind, low, high, strength_points, strength_label, model_version) VALUES ('asset-a', '2026-01-05', 'support', 1, 2, 1, 'weak', 'v')`,
  },
  {
    constraint: 'scores_daily_range_check',
    bad: [
      scoreRow('2026-01-05', 101, '50'),
      scoreRow('2026-01-06', -1, '50'),
      scoreRow('2026-01-07', 50, '101'),
    ],
    good: scoreRow('2026-01-08', 100, '100'),
  },
  {
    constraint: 'sector_heat_daily_range_check',
    bad: [
      `INSERT INTO sector_heat_daily (sector_id, date, heat, phase, model_version) VALUES ('gold', '2026-01-05', 101, 'steady', 'v')`,
      `INSERT INTO sector_heat_daily (sector_id, date, heat, phase, pending_days, model_version) VALUES ('gold', '2026-01-06', 50, 'steady', -1, 'v')`,
    ],
    good: `INSERT INTO sector_heat_daily (sector_id, date, heat, phase, model_version) VALUES ('gold', '2026-01-07', 100, 'steady', 'v')`,
  },
  {
    constraint: 'narrative_heat_daily_range_check',
    bad: [
      `INSERT INTO narrative_heat_daily (narrative_id, date, heat, phase, model_version) VALUES ('etf', '2026-01-05', -1, 'steady', 'v')`,
      `INSERT INTO narrative_heat_daily (narrative_id, date, heat, phase, pending_days, model_version) VALUES ('etf', '2026-01-06', 50, 'steady', -1, 'v')`,
    ],
    good: `INSERT INTO narrative_heat_daily (narrative_id, date, heat, phase, model_version) VALUES ('etf', '2026-01-07', 0, 'steady', 'v')`,
  },
  {
    constraint: 'market_weather_daily_score_check',
    bad: [
      `INSERT INTO market_weather_daily (date, score, label, inputs, model_version) VALUES ('2026-01-05', 101, 'l', '{}', 'v')`,
      `INSERT INTO market_weather_daily (date, score, label, inputs, model_version) VALUES ('2026-01-06', -101, 'l', '{}', 'v')`,
    ],
    good: `INSERT INTO market_weather_daily (date, score, label, inputs, model_version) VALUES ('2026-01-07', -100, 'l', '{}', 'v')`,
  },
  {
    constraint: 'alt_season_daily_score_check',
    bad: [
      `INSERT INTO alt_season_daily (date, score, phase, model_version) VALUES ('2026-01-05', -1, 'p', 'v')`,
      `INSERT INTO alt_season_daily (date, score, phase, model_version) VALUES ('2026-01-06', 101, 'p', 'v')`,
    ],
    good: `INSERT INTO alt_season_daily (date, score, phase, model_version) VALUES ('2026-01-07', 0, 'p', 'v')`,
  },
  {
    constraint: 'base_rates_n_check',
    bad: [
      `INSERT INTO base_rates (kind, key, horizon_days, n, model_version) VALUES ('k', 'a', 30, -1, 'v')`,
    ],
    good: `INSERT INTO base_rates (kind, key, horizon_days, n, model_version) VALUES ('k', 'a', 30, 0, 'v')`,
  },
  {
    constraint: 'holdings_amount_check',
    bad: [`INSERT INTO holdings (user_id, asset_id, amount) VALUES ('u-1', 'asset-a', -1)`],
    good: `INSERT INTO holdings (user_id, asset_id, amount) VALUES ('u-1', 'asset-a', 0)`,
  },
  {
    constraint: 'quick_checks_correct_index_check',
    bad: [
      `INSERT INTO quick_checks (lesson_id, position, question, options, correct_index) VALUES ('l-1', 1, 'q', '["a","b"]', 2)`,
      `INSERT INTO quick_checks (lesson_id, position, question, options, correct_index) VALUES ('l-1', 2, 'q', '["a","b"]', -1)`,
      `INSERT INTO quick_checks (lesson_id, position, question, options, correct_index) VALUES ('l-1', 3, 'q', '{}', 0)`,
    ],
    good: `INSERT INTO quick_checks (lesson_id, position, question, options, correct_index) VALUES ('l-1', 4, 'q', '["a","b"]', 1)`,
  },
  // Added by 0002_schema_v1_1.
  {
    constraint: 'job_runs_status_check',
    bad: [
      `INSERT INTO job_runs (job, run_date, run_key, status, started_at) VALUES ('j-status', '2026-01-05', '2026-01-05', 'succeeded', now())`,
      `INSERT INTO job_runs (job, run_date, run_key, status, started_at) VALUES ('j-status', '2026-01-05', '2026-01-05', '', now())`,
    ],
    good: `INSERT INTO job_runs (job, run_date, run_key, status, started_at) VALUES ('j-status', '2026-01-05', '2026-01-05', 'success', now())`,
  },
  {
    constraint: 'job_runs_run_key_check',
    bad: [
      // the key must start with run_date
      `INSERT INTO job_runs (job, run_date, run_key, status, started_at) VALUES ('j-key', '2026-01-06', '2026-01-05', 'running', now())`,
      // hour out of range, bad shape
      `INSERT INTO job_runs (job, run_date, run_key, status, started_at) VALUES ('j-key', '2026-01-05', '2026-01-05T24', 'running', now())`,
      `INSERT INTO job_runs (job, run_date, run_key, status, started_at) VALUES ('j-key', '2026-01-05', '2026-01-05T7', 'running', now())`,
      `INSERT INTO job_runs (job, run_date, run_key, status, started_at) VALUES ('j-key', '2026-01-05', 'daily', 'running', now())`,
    ],
    good: `INSERT INTO job_runs (job, run_date, run_key, status, started_at) VALUES ('j-key', '2026-01-05', '2026-01-05T23', 'running', now())`,
  },
  {
    constraint: 'job_runs_details_check',
    bad: [
      `INSERT INTO job_runs (job, run_date, run_key, status, started_at, details) VALUES ('j-details', '2026-01-05', '2026-01-05', 'running', now(), '[]')`,
      `INSERT INTO job_runs (job, run_date, run_key, status, started_at, details) VALUES ('j-details', '2026-01-05', '2026-01-05', 'running', now(), '"text"')`,
    ],
    good: `INSERT INTO job_runs (job, run_date, run_key, status, started_at, details) VALUES ('j-details', '2026-01-05', '2026-01-05', 'running', now(), '{"added":["a"]}')`,
  },
  {
    constraint: 'notification_prefs_quiet_hours_check',
    bad: [
      `INSERT INTO notification_prefs (user_id, quiet_hours_start) VALUES ('u-1', 24)`,
      `INSERT INTO notification_prefs (user_id, quiet_hours_end) VALUES ('u-1', -1)`,
    ],
    good: `INSERT INTO notification_prefs (user_id, quiet_hours_start, quiet_hours_end) VALUES ('u-1', 23, 0)`,
  },
  {
    constraint: 'notification_prefs_daily_cap_check',
    bad: [
      `INSERT INTO notification_prefs (user_id, daily_cap) VALUES ('u-2', 101)`,
      `INSERT INTO notification_prefs (user_id, daily_cap) VALUES ('u-2', -1)`,
    ],
    good: `INSERT INTO notification_prefs (user_id, daily_cap) VALUES ('u-2', 100)`,
  },
  {
    constraint: 'notification_deliveries_kind_check',
    bad: [
      `INSERT INTO notification_deliveries (user_id, channel, kind, dedupe_key, status) VALUES ('u-1', 'push', 'advice', 'k-kind-1', 'pending')`,
    ],
    good: `INSERT INTO notification_deliveries (user_id, channel, kind, dedupe_key, status) VALUES ('u-1', 'push', 'briefing', 'k-kind-2', 'pending')`,
  },
  {
    constraint: 'notification_deliveries_status_check',
    bad: [
      `INSERT INTO notification_deliveries (user_id, channel, kind, dedupe_key, status) VALUES ('u-1', 'push', 'signal', 'k-status-1', 'delivered')`,
    ],
    good: `INSERT INTO notification_deliveries (user_id, channel, kind, dedupe_key, status) VALUES ('u-1', 'push', 'signal', 'k-status-2', 'batched')`,
  },
  {
    constraint: 'notification_deliveries_sent_at_check',
    bad: [
      // sent without a time, and a time without being sent
      `INSERT INTO notification_deliveries (user_id, channel, kind, dedupe_key, status) VALUES ('u-1', 'email', 'signal', 'k-sent-1', 'sent')`,
      `INSERT INTO notification_deliveries (user_id, channel, kind, dedupe_key, status, sent_at) VALUES ('u-1', 'email', 'signal', 'k-sent-2', 'pending', now())`,
    ],
    good: `INSERT INTO notification_deliveries (user_id, channel, kind, dedupe_key, status, sent_at) VALUES ('u-1', 'email', 'signal', 'k-sent-3', 'sent', now())`,
  },
  {
    constraint: 'quick_checks_option_explanations_check',
    bad: [
      // one entry short, not an array
      `INSERT INTO quick_checks (lesson_id, position, question, options, correct_index, option_explanations) VALUES ('l-1', 5, 'q', '["a","b"]', 0, '["only one"]')`,
      `INSERT INTO quick_checks (lesson_id, position, question, options, correct_index, option_explanations) VALUES ('l-1', 6, 'q', '["a","b"]', 0, '{"0":"x","1":"y"}')`,
      `INSERT INTO quick_checks (lesson_id, position, question, options, correct_index, option_explanations) VALUES ('l-1', 7, 'q', '["a","b"]', 0, '["x","y","z"]')`,
    ],
    good: `INSERT INTO quick_checks (lesson_id, position, question, options, correct_index, option_explanations) VALUES ('l-1', 8, 'q', '["a","b"]', 0, '["why a","why b"]')`,
  },
];

interface ArrayCase {
  readonly column: string;
  readonly bad: string;
  /** Same insert without the column: the empty-array default applies. */
  readonly good: string;
}

const ARRAY_CASES: readonly ArrayCase[] = [
  {
    column: 'assets.github_repos',
    bad: `INSERT INTO assets (id, symbol, name, coingecko_id, sector_id, github_repos) VALUES ('x1', 'X', 'X', 'x1', 'gold', NULL)`,
    good: `INSERT INTO assets (id, symbol, name, coingecko_id, sector_id) VALUES ('x2', 'X', 'X', 'x2', 'gold')`,
  },
  {
    column: 'assets.narrative_ids',
    bad: `INSERT INTO assets (id, symbol, name, coingecko_id, sector_id, narrative_ids) VALUES ('x3', 'X', 'X', 'x3', 'gold', NULL)`,
    good: `INSERT INTO assets (id, symbol, name, coingecko_id, sector_id) VALUES ('x4', 'X', 'X', 'x4', 'gold')`,
  },
  {
    column: 'news_items.asset_ids',
    bad: `INSERT INTO news_items (url_hash, url, published_at, title, asset_ids, as_of, source) VALUES ('a1', 'u', now(), 't', NULL, '2026-01-05', 's')`,
    good: `INSERT INTO news_items (url_hash, url, published_at, title, as_of, source) VALUES ('a2', 'u', now(), 't', '2026-01-05', 's')`,
  },
  {
    column: 'scores_daily.gates_fired',
    bad: scoreRow('2026-02-01', 50, '50', 'NULL'),
    good: scoreRow('2026-02-02', 50, '50'),
  },
  {
    column: 'key_levels.methods',
    bad: `INSERT INTO key_levels (asset_id, date, kind, low, high, strength_points, strength_label, methods, model_version) VALUES ('asset-a', '2026-02-01', 'support', 1, 2, 1, 'weak', NULL, 'v')`,
    good: `INSERT INTO key_levels (asset_id, date, kind, low, high, strength_points, strength_label, model_version) VALUES ('asset-a', '2026-02-02', 'support', 1, 2, 1, 'weak', 'v')`,
  },
  {
    column: 'profiles.sectors',
    bad: `INSERT INTO profiles (user_id, sectors) VALUES ('u-2', NULL)`,
    good: `INSERT INTO profiles (user_id) VALUES ('u-2')`,
  },
];

describe.skipIf(!usable)('hand-written migration constraints (real Postgres)', () => {
  let scratch: ScratchSchema;

  beforeAll(async () => {
    scratch = await createScratchSchema(baseUrl as string);
    const { prisma } = scratch;
    await seedReferenceData(prisma); // sectors 'gold' and narratives 'etf' for the foreign keys
    await prisma.asset.create({
      data: {
        id: 'asset-a',
        symbol: 'AAA',
        name: 'Asset A',
        coingeckoId: 'asset-a',
        sectorId: 'gold',
      },
    });
    await prisma.user.createMany({ data: [{ id: 'u-1' }, { id: 'u-2' }] });
    await prisma.lesson.create({
      data: { id: 'l-1', position: 1, title: 'Lesson', body: {} },
    });
  }, 120_000);

  afterAll(async () => {
    await scratch.drop();
  }, 60_000);

  it('covers every CHECK constraint in every migration', () => {
    const declared = migrationDirs.flatMap((dir) => {
      const sql = readFileSync(`${migrationsDir}${dir}/migration.sql`, 'utf8');
      return [...sql.matchAll(/ADD CONSTRAINT "(\w+)" CHECK/g)].map((match) => match[1]);
    });
    expect(declared).toHaveLength(13 + 9); // 0001_init has 13, 0002_schema_v1_1 adds 9
    expect(CHECK_CASES.map((c) => c.constraint).sort()).toEqual([...declared].sort());
  });

  it.each(CHECK_CASES.map((c) => [c.constraint, c] as const))('enforces %s', async (_name, c) => {
    for (const bad of c.bad) {
      const failure = await failureOf(scratch.prisma, bad);
      expect(failure, bad).not.toBeNull();
      expect(failure).toContain(`violates check constraint "${c.constraint}"`);
    }
    expect(await failureOf(scratch.prisma, c.good), c.good).toBeNull();
  });

  it('covers every array column made NOT NULL in the migration', () => {
    const sql = readFileSync(`${migrationsDir}0001_init/migration.sql`, 'utf8');
    const declared = [
      ...sql.matchAll(/ALTER TABLE "(\w+)" ALTER COLUMN "(\w+)" SET NOT NULL/g),
    ].map((match) => `${match[1]}.${match[2]}`);
    expect(declared).toHaveLength(6);
    expect(ARRAY_CASES.map((c) => c.column).sort()).toEqual([...declared].sort());
  });

  it.each(ARRAY_CASES.map((c) => [c.column, c] as const))(
    'rejects NULL in %s',
    async (_name, c) => {
      const failure = await failureOf(scratch.prisma, c.bad);
      expect(failure, c.bad).not.toBeNull();
      // 23502 = not_null_violation; the good insert below differs only by omitting the column.
      expect(failure).toContain('Code: `23502`');
      expect(await failureOf(scratch.prisma, c.good), c.good).toBeNull();
    },
  );
});

describe.skipIf(!usable)('reference seed (real Postgres)', () => {
  let scratch: ScratchSchema;

  beforeAll(async () => {
    scratch = await createScratchSchema(baseUrl as string);
  }, 120_000);

  afterAll(async () => {
    await scratch.drop();
  }, 60_000);

  it('inserts 11 sectors and 20 narratives', async () => {
    const result = await seedReferenceData(scratch.prisma);
    expect(result).toEqual({ sectors: 11, narratives: 20 });
    expect(await scratch.prisma.sector.count()).toBe(11);
    expect(await scratch.prisma.narrative.count()).toBe(20);
  });

  it('is idempotent: a second run leaves the same rows', async () => {
    const { prisma } = scratch;
    const before = await prisma.sector.findMany({ orderBy: { id: 'asc' } });
    await seedReferenceData(prisma);
    expect(await prisma.sector.count()).toBe(11);
    expect(await prisma.narrative.count()).toBe(20);
    expect(await prisma.sector.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });

  it('inserts no price, score or other data: every other table is empty', async () => {
    const tables = await scratch.prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${scratch.name} AND table_type = 'BASE TABLE'
        AND table_name NOT IN ('sectors', 'narratives')`;
    expect(tables.length).toBeGreaterThan(40);
    const names = tables.map((row) => row.table_name);
    expect(names).toEqual(expect.arrayContaining(['price_daily', 'scores_daily', 'assets']));
    for (const table of names) {
      const rows = await scratch.prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM "${table}"`,
      );
      expect(Number(rows[0]?.n), table).toBe(0);
    }
  });
});

interface CatalogueIndexRow {
  table_name: string;
  index_name: string;
  is_unique: boolean;
  partial: boolean;
  method: string;
  columns: string[];
}

/** Read the tables, indexes and foreign keys of one schema from the live catalogue. */
async function catalogueModel(prisma: PrismaClient, schema: string): Promise<SchemaModel> {
  const columns = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT table_name::text AS table_name, column_name::text AS column_name
    FROM information_schema.columns WHERE table_schema = ${schema}`;
  const indexes = await prisma.$queryRaw<CatalogueIndexRow[]>`
    SELECT t.relname::text AS table_name, i.relname::text AS index_name,
           ix.indisunique AS is_unique, (ix.indpred IS NOT NULL) AS partial,
           am.amname::text AS method, array_agg(a.attname::text ORDER BY k.ord) AS columns
    FROM pg_index ix
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_am am ON am.oid = i.relam
    CROSS JOIN LATERAL unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE n.nspname = ${schema}
    GROUP BY t.relname, i.relname, ix.indisunique, (ix.indpred IS NOT NULL), am.amname`;
  const foreignKeys = await prisma.$queryRaw<
    { name: string; table_name: string; columns: string[] }[]
  >`
    SELECT c.conname::text AS name, t.relname::text AS table_name,
           array_agg(a.attname::text ORDER BY k.ord) AS columns
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE c.contype = 'f' AND n.nspname = ${schema}
    GROUP BY c.conname, t.relname`;
  const tables = new Map<string, Set<string>>();
  for (const row of columns) {
    const set = tables.get(row.table_name) ?? new Set<string>();
    set.add(row.column_name);
    tables.set(row.table_name, set);
  }
  return {
    tables,
    indexes: indexes.map((row) => ({
      name: row.index_name,
      table: row.table_name,
      columns: row.columns,
      unique: row.is_unique,
      partial: row.partial,
      method: row.method,
    })),
    foreignKeys: foreignKeys.map((row) => ({
      name: row.name,
      table: row.table_name,
      columns: row.columns,
    })),
  };
}

/** A schema-name-independent text description of columns, indexes and constraints. */
async function describeSchema(prisma: PrismaClient, schema: string): Promise<string[]> {
  const strip = (text: string) => text.split(`"${schema}".`).join('').split(`${schema}.`).join('');
  const columns = await prisma.$queryRaw<
    {
      table_name: string;
      column_name: string;
      data_type: string;
      udt: string;
      nullable: string;
      dflt: string | null;
    }[]
  >`SELECT table_name::text, column_name::text, data_type::text, udt_name::text AS udt,
           is_nullable::text AS nullable, column_default::text AS dflt
    FROM information_schema.columns WHERE table_schema = ${schema}`;
  const indexes = await prisma.$queryRaw<{ indexdef: string }[]>`
    SELECT indexdef::text FROM pg_indexes WHERE schemaname = ${schema}`;
  const constraints = await prisma.$queryRaw<{ def: string; conname: string; relname: string }[]>`
    SELECT c.conname::text, t.relname::text, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = ${schema}`;
  return [
    ...columns.map(
      (c) =>
        `column ${c.table_name}.${c.column_name} ${c.data_type}/${c.udt} null=${c.nullable} default=${strip(c.dflt ?? '')}`,
    ),
    ...indexes.map((i) => `index ${strip(i.indexdef)}`),
    ...constraints.map((c) => `constraint ${c.relname}.${c.conname} ${strip(c.def)}`),
  ].sort();
}

describe.skipIf(!usable)('schema v1.1 behaviour (real Postgres)', () => {
  let scratch: ScratchSchema;

  beforeAll(async () => {
    scratch = await createScratchSchema(baseUrl as string);
    const { prisma } = scratch;
    await seedReferenceData(prisma);
    await prisma.asset.create({
      data: {
        id: 'asset-v11',
        symbol: 'V11',
        name: 'V11',
        coingeckoId: 'asset-v11',
        sectorId: 'gold',
      },
    });
    await prisma.user.createMany({ data: [{ id: 'nu-1' }, { id: 'nu-2' }] });
  }, 120_000);

  afterAll(async () => {
    await scratch.drop();
  }, 60_000);

  it('the live catalogue satisfies the index rules and matches the replayed migrations', async () => {
    const live = await catalogueModel(scratch.prisma, scratch.name);
    expect(indexRuleViolations(live)).toEqual([]);
    const names = live.indexes.map((index) => index.name);
    expect(names).toContain('scores_daily_date_idx');
    expect(names).not.toContain('events_calendar_asset_id_date_idx');
    expect(names).not.toContain('key_levels_asset_id_date_idx');
    expect(names).not.toContain('job_runs_job_run_date_key');
    // The static parser used by schema.test.ts must see exactly what Postgres built.
    const replayed = replayMigrations(
      migrationDirs.map((dir) => readFileSync(`${migrationsDir}${dir}/migration.sql`, 'utf8')),
    );
    expect(names.sort()).toEqual(replayed.indexes.map((index) => index.name).sort());
    expect([...live.tables.keys()].sort()).toEqual([...replayed.tables.keys()].sort());
    expect(live.foreignKeys.map((fk) => fk.name).sort()).toEqual(
      replayed.foreignKeys.map((fk) => fk.name).sort(),
    );
    for (const [table, columns] of replayed.tables) {
      expect([...(live.tables.get(table) ?? [])].sort(), table).toEqual([...columns].sort());
    }
  });

  it('serves (asset_id, date) reads on events_calendar and key_levels from the unique index', async () => {
    const { prisma } = scratch;
    // 30 coins x 60 days, so (date) alone matches 30 rows and (asset_id, date) matches one.
    await prisma.$executeRawUnsafe(`
      INSERT INTO assets (id, symbol, name, coingecko_id, sector_id)
      SELECT 'v11-' || g, 'S' || g, 'N' || g, 'v11-' || g, 'gold' FROM generate_series(1, 30) g`);
    await prisma.$executeRawUnsafe(`
      INSERT INTO events_calendar (date, kind, title, asset_id, as_of, source)
      SELECT DATE '2026-01-01' + d, 'unlock', 'e', 'v11-' || a, DATE '2026-01-01', 't'
      FROM generate_series(1, 30) a, generate_series(0, 59) d`);
    await prisma.$executeRawUnsafe(`
      INSERT INTO key_levels (asset_id, date, kind, low, high, strength_points, strength_label, model_version)
      SELECT 'v11-' || a, DATE '2026-01-01' + d, 'support', 1, 2, 1, 'weak', 'v'
      FROM generate_series(1, 30) a, generate_series(0, 59) d`);
    await prisma.$executeRawUnsafe('ANALYZE events_calendar');
    await prisma.$executeRawUnsafe('ANALYZE key_levels');
    const plan = async (sql: string) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        const rows = await tx.$queryRawUnsafe<Record<string, string>[]>(`EXPLAIN ${sql}`);
        return rows.map((row) => Object.values(row)[0]).join('\n');
      });
    expect(
      await plan(`SELECT * FROM events_calendar WHERE asset_id = 'v11-7' AND date = '2026-02-10'`),
    ).toContain('events_calendar_asset_id_date_kind_title_key');
    expect(
      await plan(`SELECT * FROM key_levels WHERE asset_id = 'v11-7' AND date = '2026-02-10'`),
    ).toContain('key_levels_asset_id_date_kind_low_high_key');
  });

  it('rejects NULL in the 3-step columns and applies the defaults', async () => {
    const { prisma } = scratch;
    const cases: [string, string][] = [
      [
        'job_runs.run_key',
        `INSERT INTO job_runs (job, run_date, run_key, status, started_at) VALUES ('nn', '2026-01-05', NULL, 'running', now())`,
      ],
      [
        'job_runs.details',
        `INSERT INTO job_runs (job, run_date, run_key, status, started_at, details) VALUES ('nn', '2026-01-05', '2026-01-05', 'running', now(), NULL)`,
      ],
      [
        'notification_prefs.quiet_hours_start',
        `INSERT INTO notification_prefs (user_id, quiet_hours_start) VALUES ('nu-1', NULL)`,
      ],
      [
        'notification_prefs.quiet_hours_end',
        `INSERT INTO notification_prefs (user_id, quiet_hours_end) VALUES ('nu-1', NULL)`,
      ],
      [
        'notification_prefs.daily_cap',
        `INSERT INTO notification_prefs (user_id, daily_cap) VALUES ('nu-1', NULL)`,
      ],
    ];
    for (const [column, sql] of cases) {
      const failure = await failureOf(prisma, sql);
      expect(failure, column).not.toBeNull();
      expect(failure, column).toContain('Code: `23502`');
    }
    // Defaults, by raw SQL because the Prisma client fills defaults itself: quiet hours 22
    // to 8, cap 5, no timezone.
    await prisma.$executeRawUnsafe(`INSERT INTO notification_prefs (user_id) VALUES ('nu-1')`);
    const prefs = await prisma.$queryRaw<
      {
        quiet_hours_start: number;
        quiet_hours_end: number;
        daily_cap: number;
        timezone: string | null;
      }[]
    >`SELECT quiet_hours_start, quiet_hours_end, daily_cap, timezone FROM notification_prefs WHERE user_id = 'nu-1'`;
    expect(prefs).toEqual([
      { quiet_hours_start: 22, quiet_hours_end: 8, daily_cap: 5, timezone: null },
    ]);
    // A new alert has never fired.
    const alert = await prisma.alert.create({
      data: { userId: 'nu-1', kind: 'test', channel: 'push' },
    });
    expect(alert.lastFiredAt).toBeNull();
    const fired = await prisma.alert.update({
      where: { id: alert.id },
      data: { lastFiredAt: new Date('2026-01-05T10:00:00Z') },
    });
    expect(fired.lastFiredAt?.toISOString()).toBe('2026-01-05T10:00:00.000Z');
  });

  it('records deliveries once per (user, channel, dedupe_key): hourly re-runs cannot double-send', async () => {
    const { prisma } = scratch;
    const send = async (userId: string, channel: 'push' | 'email', key: string) =>
      prisma.$executeRaw`
        INSERT INTO notification_deliveries (user_id, channel, kind, dedupe_key, status)
        VALUES (${userId}, ${channel}::alert_channel, 'alert', ${key}, 'pending')
        ON CONFLICT (user_id, channel, dedupe_key) DO NOTHING`;
    expect(await send('nu-1', 'push', 'alert:7:2026-10-24T13')).toBe(1); // first run of the hour
    expect(await send('nu-1', 'push', 'alert:7:2026-10-24T13')).toBe(0); // re-run of the same hour
    expect(await send('nu-1', 'push', 'alert:7:2026-10-24T14')).toBe(1); // next hour fires again
    expect(await send('nu-1', 'email', 'alert:7:2026-10-24T13')).toBe(1); // other channel
    expect(await send('nu-2', 'push', 'alert:7:2026-10-24T13')).toBe(1); // other user
    expect(
      await prisma.notificationDelivery.count({ where: { dedupeKey: { startsWith: 'alert:7:' } } }),
    ).toBe(4);
    expect(
      await rejectsWithUniqueViolation(
        prisma.notificationDelivery.create({
          data: {
            userId: 'nu-1',
            channel: 'push',
            kind: 'alert',
            dedupeKey: 'alert:7:2026-10-24T13',
            status: 'pending',
          },
        }),
      ),
    ).toBe(true);
  });

  it('counts the per-user daily cap from sent rows and keeps links on delete', async () => {
    const { prisma } = scratch;
    const signal = await prisma.signal.create({
      data: {
        code: 'SG1',
        assetId: 'asset-v11',
        firedAt: new Date('2026-02-01T09:00:00Z'),
        what: 'w',
        why: 'y',
        checkText: 'c',
        dedupeKey: 'SG1:asset-v11:2026-02-01',
      },
    });
    const sentAt = (hour: number) => new Date(Date.UTC(2026, 1, 1, hour));
    for (const [index, status] of ['sent', 'sent', 'sent', 'batched', 'pending'].entries()) {
      await prisma.notificationDelivery.create({
        data: {
          userId: 'nu-2',
          channel: 'push',
          kind: 'signal',
          dedupeKey: `cap:${index}`,
          signalId: index === 0 ? signal.id : null,
          status,
          sentAt: status === 'sent' ? sentAt(8 + index) : null,
        },
      });
    }
    // A digest on the same day does not count towards the realtime cap.
    await prisma.notificationDelivery.create({
      data: {
        userId: 'nu-2',
        channel: 'email',
        kind: 'digest',
        dedupeKey: 'digest:2026-W06',
        status: 'sent',
        sentAt: sentAt(7),
      },
    });
    const sentToday = await prisma.notificationDelivery.count({
      where: {
        userId: 'nu-2',
        kind: { in: ['signal', 'alert'] },
        status: 'sent',
        sentAt: { gte: sentAt(0), lt: new Date(Date.UTC(2026, 1, 2)) },
      },
    });
    expect(sentToday).toBe(3);
    // Deleting a signal keeps the delivery row and clears the link; deleting the user removes its rows.
    await prisma.$executeRaw`DELETE FROM signals WHERE id = ${signal.id}`;
    const kept = await prisma.notificationDelivery.findUnique({
      where: { userId_channel_dedupeKey: { userId: 'nu-2', channel: 'push', dedupeKey: 'cap:0' } },
    });
    expect(kept?.signalId).toBeNull();
    await prisma.user.delete({ where: { id: 'nu-2' } });
    expect(await prisma.notificationDelivery.count({ where: { userId: 'nu-2' } })).toBe(0);
  });

  it('stores per-answer explanations beside the existing options column', async () => {
    const { prisma } = scratch;
    await prisma.lesson.create({
      data: {
        id: 'v11-lesson',
        position: 91,
        title: 'T',
        body: {},
        unit: 'basics',
        reviewedBy: 'Reviewer',
        reviewedAt: new Date('2026-02-01T00:00:00Z'),
      },
    });
    const legacy = await prisma.quickCheck.create({
      data: {
        lessonId: 'v11-lesson',
        position: 1,
        question: 'q',
        options: ['a', 'b'],
        correctIndex: 0,
        explanation: 'overall',
      },
    });
    expect(legacy.optionExplanations).toBeNull(); // existing shape stays valid
    const rich = await prisma.quickCheck.create({
      data: {
        lessonId: 'v11-lesson',
        position: 2,
        question: 'q',
        options: ['a', 'b'],
        correctIndex: 1,
        optionExplanations: ['why a', 'why b'],
      },
    });
    expect(rich.optionExplanations).toEqual(['why a', 'why b']);
    expect((await prisma.lesson.findUnique({ where: { id: 'v11-lesson' } }))?.unit).toBe('basics');
  });

  it('as-of rule: an in-place restatement keeps the row visible; advancing as_of would drop it', async () => {
    const { prisma } = scratch;
    const upsertRestatement = async (close: string, asOf: string) =>
      prisma.$executeRawUnsafe(`
        INSERT INTO price_daily (asset_id, date, close, as_of, source)
        VALUES ('asset-v11', '2026-02-02', ${close}, '${asOf}', 't')
        ON CONFLICT (asset_id, date) DO UPDATE SET close = EXCLUDED.close, fetched_at = now()`);
    const known = async (readDate: string) =>
      prisma.$queryRawUnsafe<{ close: string }[]>(
        `SELECT close::text FROM price_daily WHERE asset_id = 'asset-v11' AND date <= '${readDate}' AND as_of <= '${readDate}'`,
      );
    await upsertRestatement('10', '2026-02-02');
    await upsertRestatement('11', '2026-02-09'); // restated a week later; the rule leaves as_of alone
    const row = await prisma.priceDaily.findFirstOrThrow({ where: { assetId: 'asset-v11' } });
    expect(row.asOf.toISOString().slice(0, 10)).toBe('2026-02-02');
    expect(await known('2026-02-01')).toEqual([]); // not known yet
    // From its first as_of on, the row is visible: no hole. The value is the revised one: the bounded leak.
    expect((await known('2026-02-02'))[0]?.close).toBe('11.000000000000000000');
    expect((await known('2026-03-01'))[0]?.close).toBe('11.000000000000000000');
    // The rejected alternative: advancing as_of on the restatement creates a hole at the original date.
    await prisma.$executeRawUnsafe(
      `UPDATE price_daily SET as_of = '2026-02-09' WHERE asset_id = 'asset-v11'`,
    );
    expect(await known('2026-02-02')).toEqual([]);
  });
});

describe.skipIf(!usable)('upgrade 0001 to 0002 over existing rows (real Postgres)', () => {
  let scratch: ScratchSchema;

  beforeAll(async () => {
    scratch = await createScratchSchema(baseUrl as string, 1);
  }, 120_000);

  afterAll(async () => {
    await scratch.drop();
  }, 60_000);

  it('preserves rows, normalises job_runs and fills the new columns', async () => {
    const { prisma } = scratch;
    const jobs: [string, string, string][] = [
      ['prices', '2026-01-05', 'succeeded'],
      ['prices', '2026-01-06', 'running'],
      ['scoring', '2026-01-05', 'failed'],
      ['universe', '2026-01-05', 'weird-state'],
      ['macro', '2026-01-05', ' Completed '],
      ['news', '2026-01-07', 'started'],
    ];
    for (const [job, date, status] of jobs) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO job_runs (job, run_date, status, started_at, rows, error) VALUES ('${job}', '${date}', '${status}', now(), 7, NULL)`,
      );
    }
    await prisma.$executeRawUnsafe(`INSERT INTO users (id) VALUES ('old-1'), ('old-2')`);
    await prisma.$executeRawUnsafe(
      `INSERT INTO notification_prefs (user_id, weekly_digest_email, realtime_push, timezone) VALUES ('old-1', false, true, 'Europe/Sofia'), ('old-2', true, false, NULL)`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO alerts (user_id, kind, params, channel) VALUES ('old-1', 'price', '{"level":1}', 'email')`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO lessons (id, position, title, body, published) VALUES ('old-lesson', 1, 'Old', '{"a":1}', true)`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO quick_checks (lesson_id, position, question, options, correct_index, explanation) VALUES ('old-lesson', 1, 'q', '["x","y"]', 1, 'because')`,
    );

    await applyMigration(prisma, '0002_schema_v1_1');

    const runs = await prisma.$queryRaw<
      {
        job: string;
        run_date: string;
        status: string;
        run_key: string;
        details: unknown;
        rows: number;
      }[]
    >`SELECT job, to_char(run_date, 'YYYY-MM-DD') AS run_date, status, run_key, details, rows FROM job_runs ORDER BY id`;
    expect(runs).toHaveLength(6);
    expect(runs.map((r) => r.status)).toEqual([
      'success',
      'running',
      'failed',
      'failed',
      'success',
      'running',
    ]);
    expect(runs.every((r) => r.run_key === r.run_date && r.rows === 7)).toBe(true);
    expect(runs.map((r) => r.details)).toEqual([
      { legacy_status: 'succeeded' },
      {},
      {},
      { legacy_status: 'weird-state' },
      { legacy_status: ' Completed ' },
      { legacy_status: 'started' },
    ]);
    const prefs = await prisma.notificationPref.findMany({ orderBy: { userId: 'asc' } });
    expect(
      prefs.map((p) => [
        p.userId,
        p.weeklyDigestEmail,
        p.realtimePush,
        p.timezone,
        p.quietHoursStart,
        p.quietHoursEnd,
        p.dailyCap,
      ]),
    ).toEqual([
      ['old-1', false, true, 'Europe/Sofia', 22, 8, 5],
      ['old-2', true, false, null, 22, 8, 5],
    ]);
    const alert = await prisma.alert.findFirstOrThrow();
    expect([alert.kind, alert.params, alert.channel, alert.lastFiredAt]).toEqual([
      'price',
      { level: 1 },
      'email',
      null,
    ]);
    const lesson = await prisma.lesson.findUniqueOrThrow({ where: { id: 'old-lesson' } });
    expect([
      lesson.title,
      lesson.published,
      lesson.unit,
      lesson.reviewedBy,
      lesson.reviewedAt,
    ]).toEqual(['Old', true, null, null, null]);
    const check = await prisma.quickCheck.findFirstOrThrow();
    expect([
      check.options,
      check.correctIndex,
      check.explanation,
      check.optionExplanations,
    ]).toEqual([['x', 'y'], 1, 'because', null]);
    // The new slot key works on the upgraded table.
    expect(
      await rejectsWithUniqueViolation(
        prisma.jobRun.create({
          data: {
            job: 'prices',
            runDate: day('2026-01-05'),
            runKey: '2026-01-05',
            status: 'running',
            startedAt: new Date(),
          },
        }),
      ),
    ).toBe(true);
    await prisma.jobRun.create({
      data: {
        job: 'prices',
        runDate: day('2026-01-05'),
        runKey: '2026-01-05T09',
        status: 'running',
        startedAt: new Date(),
      },
    });
  });
});

describe.skipIf(!usable)('documented rollback of 0002 (real Postgres)', () => {
  let migrated: ScratchSchema;
  let baseline: ScratchSchema;

  beforeAll(async () => {
    migrated = await createScratchSchema(baseUrl as string, 2);
    baseline = await createScratchSchema(baseUrl as string, 1);
  }, 120_000);

  afterAll(async () => {
    await migrated.drop();
    await baseline.drop();
  }, 60_000);

  it('reverts a populated 0002 schema to exactly the 0001 schema and keeps older data', async () => {
    const { prisma } = migrated;
    await seedReferenceData(prisma);
    await prisma.user.create({ data: { id: 'rb-1' } });
    await prisma.notificationPref.create({
      data: { userId: 'rb-1', dailyCap: 9, quietHoursStart: 20 },
    });
    await prisma.alert.create({
      data: { userId: 'rb-1', kind: 'k', channel: 'push', lastFiredAt: new Date() },
    });
    for (const key of ['2026-04-01', '2026-04-01T00', '2026-04-01T01']) {
      await prisma.jobRun.create({
        data: {
          job: 'rb-hourly',
          runDate: day('2026-04-01'),
          runKey: key,
          status: 'success',
          startedAt: new Date(),
          details: { w: 1 },
        },
      });
    }
    await prisma.jobRun.create({
      data: {
        job: 'rb-daily',
        runDate: day('2026-04-01'),
        runKey: '2026-04-01',
        status: 'failed',
        startedAt: new Date(),
      },
    });
    await prisma.notificationDelivery.create({
      data: {
        userId: 'rb-1',
        channel: 'push',
        kind: 'digest',
        dedupeKey: 'digest:x',
        status: 'pending',
      },
    });
    await prisma.lesson.create({
      data: { id: 'rb-l', position: 1, title: 'T', body: {}, unit: 'basics' },
    });
    await prisma.quickCheck.create({
      data: {
        lessonId: 'rb-l',
        position: 1,
        question: 'q',
        options: ['a', 'b'],
        correctIndex: 0,
        optionExplanations: ['x', 'y'],
      },
    });

    const sql = readFileSync(`${migrationsDir}0002_schema_v1_1/migration.sql`, 'utf8');
    const block = /-- >>> ROLLBACK-SQL\n([\s\S]*?)-- <<< ROLLBACK-SQL/.exec(sql)?.[1] ?? '';
    const statements = block
      .split('\n')
      .filter((line) => line.startsWith('-- | '))
      .map((line) => line.slice(5).trim().replace(/;$/, ''));
    expect(statements.length).toBeGreaterThan(10);
    for (const statement of statements) {
      await prisma.$executeRawUnsafe(statement);
    }

    expect(await describeSchema(prisma, migrated.name)).toEqual(
      await describeSchema(baseline.prisma, baseline.name),
    );
    // What the header says it keeps: daily rows, users, reference data, content, prefs and alerts.
    const runs = await prisma.$queryRaw<{ job: string }[]>`SELECT job FROM job_runs ORDER BY job`;
    expect(runs.map((r) => r.job)).toEqual(['rb-daily', 'rb-hourly']);
    expect(await prisma.sector.count()).toBe(11);
    expect(await prisma.narrative.count()).toBe(20);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.lesson.count()).toBe(1);
    expect(await prisma.quickCheck.count()).toBe(1);
    expect(await prisma.alert.count()).toBe(1);
    expect(await prisma.notificationPref.count()).toBe(1);
  });
});
