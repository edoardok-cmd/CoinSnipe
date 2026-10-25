/**
 * End-to-end test of the daily macro job against a real Postgres scratch database (CSN-024 item D).
 *
 * Real adapters, the ETF loader and the real Prisma store run. Only HTTP is replaced (testing/
 * fixtureRouter serves the SAMPLE_ fixtures). No live vendor is called.
 *
 * DESTRUCTIVE: the suite truncates four tables. It runs only when checkScratchTarget (scratchTarget.ts)
 * accepts DATABASE_URL: an allow-listed local host and port, the coinsnipe_csn_024_* scratch name, and
 * a name equal to CSN024_SCRATCH_DB_NAME. Any other target fails the suite closed; it never runs
 * against the shared test database.
 *
 * Create the database with
 *   scripts/scratch-test-db.sh create CSN-024-impl --board coinsnipe
 * apply migrations to it, then run:
 *   DATABASE_URL=<scratch url> CSN024_SCRATCH_DB_NAME=<its name> pnpm --filter @coinsnipe/worker test
 */
import { PrismaClient } from '@coinsnipe/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ETF_DECISIONS_ENV, loadEtfDecisions } from '../config/etfDecisions';
import { type FetchMacroReport, runFetchMacroJob } from '../jobs/fetchMacro';
import { FIXTURES, fixtureRouter } from '../testing/fixtureRouter';
import { createPrismaMacroStore } from './prismaMacroStore';
import { checkScratchTarget, SCRATCH_NAME_ENV } from './scratchTarget';

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const TARGET = DATABASE_URL
  ? checkScratchTarget(DATABASE_URL, process.env[SCRATCH_NAME_ENV])
  : null;

const TODAY = '2026-10-24';
const ENV = { FRED_API_KEY: 'SAMPLE-FRED-KEY-NOT-REAL' } as const;
const ETF_FIXTURE = loadEtfDecisions({
  [ETF_DECISIONS_ENV]: `${FIXTURES}SAMPLE_etf_decisions.json`,
});
const ETF_ABSENT = loadEtfDecisions({
  [ETF_DECISIONS_ENV]: `${FIXTURES}SAMPLE_etf_decisions_missing.json`,
});
// F1: the variable unset. No admin file is configured, so no file is read.
const ETF_UNSET = loadEtfDecisions({});
const ETF_EMPTY = loadEtfDecisions({
  [ETF_DECISIONS_ENV]: `${FIXTURES}SAMPLE_etf_decisions_empty.json`,
});

// Fail closed: a refused target is a failing test, never a silent skip.
if (TARGET && !TARGET.ok) {
  describe('scratch database guard (fail closed)', () => {
    it('refuses to run the destructive test against this DATABASE_URL', () => {
      throw new Error(TARGET.reason);
    });
  });
}

const describeScratch = TARGET?.ok ? describe : describe.skip;

async function count(
  prisma: PrismaClient,
  sql: 'calendar' | 'etf' | 'pce' | 'fomc' | 'macro' | 'fng' | 'gpr',
): Promise<number> {
  const rows = await (async () => {
    switch (sql) {
      case 'calendar':
        return prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM events_calendar`;
      case 'etf':
        return prisma.$queryRaw<
          Array<{ n: bigint }>
        >`SELECT count(*) AS n FROM events_calendar WHERE kind = 'etf'`;
      case 'pce':
        return prisma.$queryRaw<
          Array<{ n: bigint }>
        >`SELECT count(*) AS n FROM events_calendar WHERE kind = 'pce'`;
      case 'fomc':
        return prisma.$queryRaw<
          Array<{ n: bigint }>
        >`SELECT count(*) AS n FROM events_calendar WHERE kind = 'fomc'`;
      case 'macro':
        return prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM macro_daily`;
      case 'fng':
        return prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM fear_greed_daily`;
      case 'gpr':
        return prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM gpr_monthly`;
    }
  })();
  return Number(rows[0]?.n ?? 0);
}

describeScratch('fetchMacro end to end against the scratch database (CSN-024)', () => {
  let prisma: PrismaClient;

  /** The 30-day window the UI shows: TODAY through TODAY + 30 days. */
  async function thirtyDayCalendar(): Promise<
    Array<{ date: string; kind: string; title: string; assetId: string | null }>
  > {
    return prisma.$queryRaw<
      Array<{ date: string; kind: string; title: string; assetId: string | null }>
    >`
      SELECT date::text AS date, kind::text AS kind, title, asset_id AS "assetId"
      FROM events_calendar
      WHERE date >= ${TODAY}::date AND date <= (${TODAY}::date + 30)
      ORDER BY date, kind, title`;
  }

  async function run(options: {
    etf: typeof ETF_FIXTURE;
    failFredRelease54?: boolean;
  }): Promise<FetchMacroReport> {
    return runFetchMacroJob({
      prisma,
      env: ENV,
      today: TODAY,
      etfDecisions: options.etf,
      fetchImpl: fixtureRouter({ failFredRelease54: options.failFredRelease54 ?? false }),
    });
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    // Scratch database only (guarded above). Start from empty tables so the counts are exact.
    await prisma.$executeRawUnsafe(
      'TRUNCATE events_calendar, macro_daily, fear_greed_daily, gpr_monthly RESTART IDENTITY',
    );
    // SAMPLE reference rows for the asset-scoped calendar rows (events_calendar.asset_id has a FK).
    await prisma.sector.upsert({
      where: { id: 'sample-sector' },
      create: {
        id: 'sample-sector',
        name: 'SAMPLE sector',
        description: 'SAMPLE sector for tests',
      },
      update: {},
    });
    await prisma.asset.upsert({
      where: { id: 'btc' },
      create: {
        id: 'btc',
        symbol: 'SAMPLE',
        name: 'SAMPLE asset',
        coingeckoId: 'sample-btc',
        sectorId: 'sample-sector',
      },
      update: {},
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('R5-1: with the ETF file absent, no etf rows are written and the run warns', async () => {
    const report = await run({ etf: ETF_ABSENT });
    expect(report.ok, JSON.stringify(report.sources)).toBe(true);
    const calendar = report.sources.find((s) => s.name === 'calendar');
    expect(calendar?.warnings.join(' ')).toContain('ETF decisions file not readable');
    expect(await count(prisma, 'etf')).toBe(0);
  });

  it('F1: with COINSNIPE_ETF_DECISIONS_PATH unset, the two stored etf rows survive the run and the run warns', async () => {
    await run({ etf: ETF_FIXTURE });
    expect(await count(prisma, 'etf')).toBe(2);
    const report = await run({ etf: ETF_UNSET });
    expect(report.ok, JSON.stringify(report.sources)).toBe(true);
    const calendar = report.sources.find((s) => s.name === 'calendar');
    expect(calendar?.warnings.join(' ')).toContain('COINSNIPE_ETF_DECISIONS_PATH is not set');
    expect(await count(prisma, 'etf')).toBe(2);
  });

  it('F1: a configured file that holds a deliberately empty list clears the etf rows inside the calendar window being replaced (older rows are outside it)', async () => {
    await run({ etf: ETF_FIXTURE });
    expect(await count(prisma, 'etf')).toBe(2);
    const report = await run({ etf: ETF_EMPTY });
    expect(report.ok, JSON.stringify(report.sources)).toBe(true);
    expect(await count(prisma, 'etf')).toBe(0);
  });

  it('R5-1: with the SAMPLE ETF file, etf rows are written (one asset-scoped) and shown in the 30-day calendar', async () => {
    const report = await run({ etf: ETF_FIXTURE });
    expect(report.ok, JSON.stringify(report.sources)).toBe(true);
    expect(await count(prisma, 'etf')).toBe(2);

    const calendar = await thirtyDayCalendar();
    expect(calendar).toEqual([
      { date: '2026-10-28', kind: 'fomc', title: 'FOMC rate decision', assetId: null },
      { date: '2026-11-03', kind: 'etf', title: 'SAMPLE spot ETF decision date', assetId: 'btc' },
      {
        date: '2026-11-06',
        kind: 'payrolls',
        title: 'US jobs report (Employment Situation)',
        assetId: null,
      },
      { date: '2026-11-13', kind: 'cpi', title: 'US CPI inflation release', assetId: null },
      { date: '2026-11-20', kind: 'etf', title: 'SAMPLE second ETF decision date', assetId: null },
    ]);
  });

  it('the daily job writes every source and reports the stale A8 composite as a warning', async () => {
    const report = await run({ etf: ETF_FIXTURE });
    expect(report.ok).toBe(true);
    expect(report.sources.map((s) => [s.name, s.status])).toEqual([
      ['macro', 'ok'],
      ['feargreed', 'ok'],
      ['gpr', 'ok'],
      ['calendar', 'ok'],
    ]);
    const macro = report.sources.find((s) => s.name === 'macro');
    expect(macro?.warnings.some((w) => w.startsWith('A8 global M2 approximation is stale'))).toBe(
      true,
    );
    expect(await count(prisma, 'macro')).toBeGreaterThan(0);
    expect(await count(prisma, 'fng')).toBe(3);
    expect(await count(prisma, 'gpr')).toBe(4);
  });

  it('a second run for the same day is an upsert: no duplicate rows', async () => {
    const calendarBefore = await count(prisma, 'calendar');
    const macroBefore = await count(prisma, 'macro');
    const report = await run({ etf: ETF_FIXTURE });
    expect(report.ok).toBe(true);
    expect(await count(prisma, 'calendar')).toBe(calendarBefore);
    expect(await count(prisma, 'macro')).toBe(macroBefore);
  });

  it('F3 end to end: a FRED 503 on release 54 leaves the stored PCE row untouched', async () => {
    expect(await count(prisma, 'pce')).toBe(1);
    const report = await run({ etf: ETF_FIXTURE, failFredRelease54: true });
    // A failed release is a calendar warning: the kinds that succeeded are replaced, PCE is not.
    expect(report.ok).toBe(true);
    const calendarWarnings = report.sources.find((s) => s.name === 'calendar')?.warnings ?? [];
    expect(calendarWarnings.join(' ')).toContain('release/dates:54: HTTP 503');
    expect(await count(prisma, 'pce')).toBe(1);
    expect(await count(prisma, 'etf')).toBe(2);
    expect(await count(prisma, 'fomc')).toBe(2);
  });

  it('R5-5: asset-scoped rows use the (asset_id, date, kind, title) key: insert, re-run, remove by kind', async () => {
    const store = createPrismaMacroStore(prisma);
    const window = { from: TODAY, to: '2026-12-23', kinds: ['unlock'] as const };
    const row = {
      date: '2026-11-10',
      kind: 'unlock' as const,
      title: 'SAMPLE token unlock',
      assetId: 'btc',
      asOf: TODAY,
      source: 'sample:asset-scoped-test',
    };

    expect((await store.replaceCalendarWindow({ ...window, rows: [row] })).written).toBe(1);
    const afterInsert = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM events_calendar WHERE asset_id = 'btc' AND kind = 'unlock'`;
    expect(Number(afterInsert[0]?.n)).toBe(1);

    // Re-running the same window replaces the row, it does not duplicate it.
    expect((await store.replaceCalendarWindow({ ...window, rows: [row] })).written).toBe(1);
    const afterRerun = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM events_calendar WHERE asset_id = 'btc' AND kind = 'unlock'`;
    expect(Number(afterRerun[0]?.n)).toBe(1);

    // Replacing the kind with no rows removes the asset-scoped row and touches no other kind.
    const etfBefore = await count(prisma, 'etf');
    expect((await store.replaceCalendarWindow({ ...window, rows: [] })).written).toBe(0);
    const afterRemove = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM events_calendar WHERE asset_id = 'btc' AND kind = 'unlock'`;
    expect(Number(afterRemove[0]?.n)).toBe(0);
    expect(await count(prisma, 'etf')).toBe(etfBefore);
  });
  it('R6-7: an unknown asset id skips only its own row, with a warning naming the id; the good row is written', async () => {
    const store = createPrismaMacroStore(prisma);
    const base = { kind: 'etf' as const, asOf: TODAY, source: 'sample:unknown-asset-test' };
    const outcome = await store.replaceCalendarWindow({
      from: TODAY,
      to: '2026-12-23',
      kinds: ['etf'],
      rows: [
        { ...base, date: '2026-11-12', title: 'SAMPLE bad asset row', assetId: 'btc-typo' },
        { ...base, date: '2026-11-13', title: 'SAMPLE good asset row', assetId: 'btc' },
      ],
    });
    expect(outcome.written).toBe(1);
    expect(outcome.warnings.join(' ')).toContain('btc-typo');
    const good = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM events_calendar WHERE title = 'SAMPLE good asset row'`;
    expect(Number(good[0]?.n)).toBe(1);
    const bad = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM events_calendar WHERE title = 'SAMPLE bad asset row'`;
    expect(Number(bad[0]?.n)).toBe(0);
  });
});
