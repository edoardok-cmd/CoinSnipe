/**
 * Behavioural checks against a real Postgres. Each run builds its own throwaway schema
 * inside the database named by DATABASE_URL, applies prisma/migrations/0001_init, runs the
 * assertions and drops the schema, so it never touches tables another run created and
 * needs no prior `prisma migrate`.
 *
 * Skipped (with a warning) when DATABASE_URL is unset. Refuses non-local hosts unless
 * CSN_DB_TEST_ALLOW_REMOTE=1, so a pointed-at-Neon URL is never used by accident.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

async function createScratchSchema(url: string): Promise<ScratchSchema> {
  const name = `csn_db_test_${randomBytes(5).toString('hex')}`;
  const scoped = new URL(url);
  scoped.searchParams.set('schema', name);
  const prisma = new PrismaClient({ datasourceUrl: scoped.toString() });
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${name}"`);
  const dirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const dir of dirs) {
    const sql = readFileSync(`${migrationsDir}${dir}/migration.sql`, 'utf8');
    for (const statement of statementsOf(sql)) {
      await prisma.$executeRawUnsafe(statement);
    }
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

  it('rejects a second job_runs row for the same (job, run_date)', async () => {
    const { prisma } = scratch;
    const row = (job: string, runDate: Date) => ({
      job,
      runDate,
      status: 'running',
      startedAt: new Date(),
    });
    await prisma.jobRun.create({ data: row('prices', day('2026-01-05')) });
    expect(
      await rejectsWithUniqueViolation(
        prisma.jobRun.create({ data: row('prices', day('2026-01-05')) }),
      ),
    ).toBe(true);
    // A different job or a different day is allowed.
    await prisma.jobRun.create({ data: row('scoring', day('2026-01-05')) });
    await prisma.jobRun.create({ data: row('prices', day('2026-01-06')) });
    expect(await prisma.jobRun.count()).toBe(3);
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

  it('covers every CHECK constraint in the migration', () => {
    const sql = readFileSync(`${migrationsDir}0001_init/migration.sql`, 'utf8');
    const declared = [...sql.matchAll(/ADD CONSTRAINT "(\w+)" CHECK/g)].map((match) => match[1]);
    expect(declared).toHaveLength(13);
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
