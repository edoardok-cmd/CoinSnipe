/**
 * Static checks on the committed schema, migration and seed data. No database needed,
 * so these run everywhere, including CI without Postgres. The behavioural checks that
 * need a real database live in database.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NARRATIVES, SECTORS } from './reference-data';

const prismaDir = fileURLToPath(new URL('../prisma/', import.meta.url));
const migrationsDir = `${prismaDir}migrations/`;
const migrationSql = readFileSync(`${migrationsDir}0001_init/migration.sql`, 'utf8');
const schemaPrisma = readFileSync(`${prismaDir}schema.prisma`, 'utf8');
const seedSource = readFileSync(fileURLToPath(new URL('./seed.ts', import.meta.url)), 'utf8');

const SECTOR_IDS = [
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
];
const NARRATIVE_IDS = [
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
];

describe('migration layout', () => {
  it('starts with 0001_init and a postgresql lock file', () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs[0]).toBe('0001_init');
    const lock = readFileSync(`${migrationsDir}migration_lock.toml`, 'utf8');
    expect(lock).toMatch(/provider\s*=\s*"postgresql"/);
  });

  it('documents safety and rollback in the migration header', () => {
    const header = migrationSql.split('\n').slice(0, 25).join('\n');
    expect(header).toMatch(/Safety/);
    expect(header).toMatch(/Rollback/);
  });
});

describe('uniqueness constraints in the migration', () => {
  it('makes (job, run_date) unique on job_runs', () => {
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX "job_runs_job_run_date_key" ON "job_runs"\("job", "run_date"\)/,
    );
  });

  it('makes event_id the primary key (unique) of stripe_events', () => {
    const table = /CREATE TABLE "stripe_events" \(([\s\S]*?)\n\);/.exec(migrationSql);
    expect(table).not.toBeNull();
    expect(table?.[1]).toMatch(/CONSTRAINT "stripe_events_pkey" PRIMARY KEY \("event_id"\)/);
  });

  it('deduplicates events_calendar per coin and for market-wide rows', () => {
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX "events_calendar_asset_id_date_kind_title_key" ON "events_calendar"\("asset_id", "date", "kind", "title"\)/,
    );
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX "events_calendar_market_wide_key" ON "events_calendar"\("date", "kind", "title"\) WHERE "asset_id" IS NULL/,
    );
  });

  it('keys macro_daily on (series_id, date, as_of) so every vintage is kept', () => {
    expect(migrationSql).toMatch(
      /CONSTRAINT "macro_daily_pkey" PRIMARY KEY \("series_id","date","as_of"\)/,
    );
  });

  it('makes signals.dedupe_key and assets.coingecko_id unique', () => {
    expect(migrationSql).toMatch(/CREATE UNIQUE INDEX "signals_dedupe_key_key"/);
    expect(migrationSql).toMatch(/CREATE UNIQUE INDEX "assets_coingecko_id_key"/);
  });
});

describe('Auth.js adapter models', () => {
  it.each(['User', 'Account', 'Session', 'VerificationToken'])('defines model %s', (name) => {
    expect(schemaPrisma).toMatch(new RegExp(`^model ${name} \\{`, 'm'));
  });
});

describe('reference seed data', () => {
  it('has exactly the 11 sectors from the Score Lab, in order', () => {
    expect(SECTORS.map((row) => row.id)).toEqual(SECTOR_IDS);
  });

  it('has exactly the 20 narratives from the Score Lab, in order', () => {
    expect(NARRATIVES.map((row) => row.id)).toEqual(NARRATIVE_IDS);
  });

  it('gives every row a name and a plain description', () => {
    for (const row of [...SECTORS, ...NARRATIVES]) {
      expect(row.name.trim().length).toBeGreaterThan(0);
      expect(row.description.trim().length).toBeGreaterThan(10);
    }
  });

  it('keeps seeded text educational: no advisory words and no numbers in descriptions', () => {
    // Prefix match on "hold" also rejects holder/holding wording, which the copy lint flags.
    const advisory =
      /\b(buy\w*|sell\w*|hold\w*|target\w*|pump\w*|guarantee\w*|recommend\w*|10x|100x)\b|will reach/i;
    for (const row of [...SECTORS, ...NARRATIVES]) {
      const text = `${row.name} ${row.description}`;
      expect(text, row.id).not.toMatch(advisory);
      expect(row.description, row.id).not.toMatch(/\d/);
    }
  });

  it('seed.ts writes only the sector and narrative tables', () => {
    expect(seedSource).toMatch(/prisma\.sector\.upsert/);
    expect(seedSource).toMatch(/prisma\.narrative\.upsert/);
    const touched = [...seedSource.matchAll(/prisma\.(\w+)\./g)].map((match) => match[1]);
    expect([...new Set(touched)].filter((name) => name !== '$transaction').sort()).toEqual([
      'narrative',
      'sector',
    ]);
    expect(seedSource).not.toMatch(/priceDaily|scoreDaily|createMany|asset\./);
  });
});
