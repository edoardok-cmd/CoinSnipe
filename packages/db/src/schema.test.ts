/**
 * Static checks on the committed schema, migration and seed data. No database needed,
 * so these run everywhere, including CI without Postgres. The behavioural checks that
 * need a real database live in database.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { indexRuleViolations, replayMigrations, tablesWithColumn } from './migration-model';
import { NARRATIVES, SECTORS } from './reference-data';

const prismaDir = fileURLToPath(new URL('../prisma/', import.meta.url));
const migrationsDir = `${prismaDir}migrations/`;
const migrationSql = readFileSync(`${migrationsDir}0001_init/migration.sql`, 'utf8');
const migration0002 = readFileSync(`${migrationsDir}0002_schema_v1_1/migration.sql`, 'utf8');
const schemaPrisma = readFileSync(`${prismaDir}schema.prisma`, 'utf8');
const prismaConfig = readFileSync(
  fileURLToPath(new URL('../prisma.config.ts', import.meta.url)),
  'utf8',
);
const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
/** Every migration in apply order, replayed into a schema model. */
const migrationDirs = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const finalSchema = replayMigrations(
  migrationDirs.map((dir) => readFileSync(`${migrationsDir}${dir}/migration.sql`, 'utf8')),
);
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
  it('starts with 0001_init, then 0002_schema_v1_1, and a postgresql lock file', () => {
    expect(migrationDirs.slice(0, 2)).toEqual(['0001_init', '0002_schema_v1_1']);
    const lock = readFileSync(`${migrationsDir}migration_lock.toml`, 'utf8');
    expect(lock).toMatch(/provider\s*=\s*"postgresql"/);
  });

  it('documents safety and rollback in the migration header', () => {
    const header = migrationSql.split('\n').slice(0, 25).join('\n');
    expect(header).toMatch(/Safety/);
    expect(header).toMatch(/Rollback/);
  });

  it('documents purpose, lock window, rollback and the per-environment seed in the 0002 header', () => {
    const raw = migration0002.slice(0, migration0002.indexOf('\nDROP INDEX'));
    expect(raw).toMatch(/^-- Purpose/m);
    expect(raw).toMatch(/^-- Safety/m);
    expect(raw).toMatch(/^-- Rollback/m);
    // Prose checks run on the header with line wraps and comment markers collapsed.
    const header = raw.replace(/\n--\s*/g, ' ');
    expect(header).toMatch(/Lock window/);
    expect(header).toMatch(/3-step pattern/);
    // F3: the seed is a per-environment deploy step and CSN-073 must run it.
    expect(header).toMatch(/db:seed/);
    expect(header).toMatch(/every environment/);
    expect(header).toMatch(/CSN-073/);
    // Rollback beyond day 0: after data exists, a failed apply, and the seed caveat.
    expect(header).toMatch(/data exists in the new objects/);
    expect(header).toMatch(/migrate resolve --rolled-back 0002_schema_v1_1/);
    expect(header).toMatch(/Reference data caveat/);
    expect(header).toMatch(/>>> ROLLBACK-SQL[\s\S]*<<< ROLLBACK-SQL/);
  });

  it('never edits 0001: it still carries the original job_runs unique index and indexes', () => {
    expect(migrationSql).toMatch(/CREATE UNIQUE INDEX "job_runs_job_run_date_key"/);
    expect(migrationSql).toMatch(/CREATE INDEX "events_calendar_asset_id_date_idx"/);
    expect(migrationSql).toMatch(/CREATE INDEX "key_levels_asset_id_date_idx"/);
  });
});

describe('uniqueness constraints in the migration', () => {
  it('makes (job, run_key) unique on job_runs and no longer (job, run_date)', () => {
    expect(migration0002).toMatch(
      /CREATE UNIQUE INDEX "job_runs_job_run_key_key" ON "job_runs"\("job", "run_key"\)/,
    );
    const jobRunsIndexes = finalSchema.indexes.filter((index) => index.table === 'job_runs');
    const uniques = jobRunsIndexes
      .filter((index) => index.unique && index.name !== 'job_runs_pkey')
      .map((index) => index.columns.join(','));
    expect(uniques).toEqual(['job,run_key']);
    expect(jobRunsIndexes.map((index) => index.name)).not.toContain('job_runs_job_run_date_key');
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

describe('job_runs shape (F1)', () => {
  it('adds run_key and details and normalises status in 0002 using the 3-step pattern', () => {
    expect(finalSchema.tables.get('job_runs')).toEqual(
      new Set([
        'id',
        'job',
        'run_date',
        'status',
        'started_at',
        'finished_at',
        'rows',
        'error',
        'run_key',
        'details',
      ]),
    );
    // Nullable add, then backfill, then NOT NULL, in that order.
    const add = migration0002.indexOf('ADD COLUMN "run_key" TEXT,');
    const fill = migration0002.indexOf('UPDATE "job_runs" SET');
    const notNull = migration0002.indexOf('ALTER COLUMN "run_key" SET NOT NULL');
    expect(add).toBeGreaterThan(-1);
    expect(fill).toBeGreaterThan(add);
    expect(notNull).toBeGreaterThan(fill);
  });

  it('constrains status to running, success and failed', () => {
    expect(migration0002).toMatch(
      /ADD CONSTRAINT "job_runs_status_check" CHECK \("status" IN \('running', 'success', 'failed'\)\)/,
    );
  });

  it('uses one status vocabulary everywhere: no succeeded in the schema or README', () => {
    expect(schemaPrisma).not.toMatch(/succeeded/i);
    expect(readme).not.toMatch(/succeeded/i);
    expect(schemaPrisma).toMatch(/'running' \| 'success' \| 'failed'/);
    // 0002 mentions the old word only to normalise it.
    const mentions = migration0002.split('\n').filter((line) => /succeeded/i.test(line));
    expect(mentions.every((line) => line.startsWith('--') || /WHEN 'succeeded'/.test(line))).toBe(
      true,
    );
  });
});

describe('index rules (F5) and dropped duplicates (S3)', () => {
  it('has no violations: date, (asset_id, date), (user_id) and foreign-key indexes', () => {
    expect(indexRuleViolations(finalSchema)).toEqual([]);
  });

  it('keeps scores_daily_date_idx, the other named (date) indexes and the cap-count index', () => {
    const names = finalSchema.indexes.map((index) => index.name);
    for (const name of [
      'scores_daily_date_idx',
      'price_daily_date_idx',
      'protocol_metrics_daily_date_idx',
      'derivatives_daily_date_idx',
      'etf_flows_daily_date_idx',
      'key_levels_date_idx',
      'events_calendar_date_idx',
      'sector_heat_daily_date_idx',
      'narrative_heat_daily_date_idx',
      // Serves the per-user daily cap count (user, sent_at range) in CSN-060.
      'notification_deliveries_user_id_sent_at_idx',
    ]) {
      expect(names, name).toContain(name);
    }
  });

  it('keeps an index leading with user_id on every user table', () => {
    const userTables = tablesWithColumn(finalSchema, 'user_id');
    expect(userTables.length).toBeGreaterThanOrEqual(12);
    expect(userTables).toContain('notification_deliveries');
    for (const table of userTables) {
      expect(
        finalSchema.indexes.some(
          (index) => index.table === table && !index.partial && index.columns[0] === 'user_id',
        ),
        table,
      ).toBe(true);
    }
  });

  it('drops the two duplicate (asset_id, date) indexes and the unique index still serves them', () => {
    const names = finalSchema.indexes.map((index) => index.name);
    expect(names).not.toContain('events_calendar_asset_id_date_idx');
    expect(names).not.toContain('key_levels_asset_id_date_idx');
    expect(migration0002).toMatch(/^DROP INDEX "events_calendar_asset_id_date_idx";/m);
    expect(migration0002).toMatch(/^DROP INDEX "key_levels_asset_id_date_idx";/m);
    for (const [table, unique] of [
      ['events_calendar', 'events_calendar_asset_id_date_kind_title_key'],
      ['key_levels', 'key_levels_asset_id_date_kind_low_high_key'],
    ] as const) {
      const index = finalSchema.indexes.find((candidate) => candidate.name === unique);
      expect(index?.table).toBe(table);
      expect(index?.columns.slice(0, 2)).toEqual(['asset_id', 'date']);
    }
  });

  it('keeps schema.prisma in step: no @@index([assetId, date]) on those two models', () => {
    for (const model of ['EventCalendarEntry', 'KeyLevel']) {
      const body = new RegExp(`^model ${model} \\{([\\s\\S]*?)\\n\\}`, 'm').exec(schemaPrisma);
      expect(body?.[1], model).toBeDefined();
      expect(body?.[1]).not.toMatch(/@@index\(\[assetId, date\]\)/);
    }
  });

  it('reports a dropped index (the rule is sensitive)', () => {
    const without = (name: string) => ({
      ...finalSchema,
      indexes: finalSchema.indexes.filter((index) => index.name !== name),
    });
    expect(indexRuleViolations(without('scores_daily_date_idx'))).toEqual([
      'scores_daily: no index leads with (date)',
    ]);
    expect(indexRuleViolations(without('security_events_asset_id_date_idx'))).toContain(
      'security_events: no index leads with (asset_id, date)',
    );
    expect(indexRuleViolations(without('alerts_user_id_idx'))).toContain(
      'alerts: no index leads with (user_id)',
    );
    // A partial index does not count as the (date) index.
    expect(indexRuleViolations(without('events_calendar_date_idx'))).toEqual([
      'events_calendar: no index leads with (date)',
    ]);
  });
});

describe('as-of rule (F6)', () => {
  const models = [...schemaPrisma.matchAll(/((?:^\/\/.*\n)*)^model (\w+) \{([\s\S]*?)\n\}/gm)].map(
    (match) => ({
      comment: match[1] as string,
      name: match[2] as string,
      body: match[3] as string,
    }),
  );
  const rawModels = models.filter((model) => /@map\("as_of"\)/.test(model.body));

  it('finds the 19 raw-fact models', () => {
    expect(rawModels).toHaveLength(19);
  });

  it('states the rule once in the schema header and once on every latest-only model', () => {
    const header = schemaPrisma.slice(0, schemaPrisma.indexOf('generator client'));
    expect(header).toMatch(/As-of rule/);
    expect(header).toMatch(/NEVER touches as_of/);
    for (const model of rawModels.filter((candidate) => candidate.name !== 'MacroDaily')) {
      expect(model.comment, model.name).toMatch(/As-of rule: latest-only/);
    }
    const macro = rawModels.find((model) => model.name === 'MacroDaily');
    expect(macro?.comment).toMatch(/every published vintage/);
  });

  it('keeps as_of out of every key except macro_daily, so an upsert cannot fork a row', () => {
    const withAsOf = tablesWithColumn(finalSchema, 'as_of');
    expect(withAsOf).toHaveLength(19);
    const keyed = finalSchema.indexes
      .filter((index) => index.unique && index.columns.includes('as_of'))
      .map((index) => index.table);
    expect(keyed).toEqual(['macro_daily']);
    expect(finalSchema.indexes.filter((index) => index.columns.includes('as_of'))).toHaveLength(1);
  });

  it('records the rule and its accepted leak in the README', () => {
    expect(readme).toMatch(/^## As-of rule/m);
    expect(readme).toMatch(/never advances? `as_of`|never touches `as_of`/i);
    expect(readme).toMatch(/bounded leak/i);
  });
});

describe('notification delivery state (F2) and content columns (S4)', () => {
  it('adds the delivery table, quiet hours, daily cap and alert last-fired in 0002', () => {
    expect(finalSchema.tables.get('notification_deliveries')).toEqual(
      new Set([
        'id',
        'user_id',
        'channel',
        'kind',
        'dedupe_key',
        'signal_id',
        'alert_id',
        'status',
        'sent_at',
        'created_at',
      ]),
    );
    const prefs = finalSchema.tables.get('notification_prefs');
    for (const column of ['quiet_hours_start', 'quiet_hours_end', 'daily_cap']) {
      expect(prefs?.has(column), column).toBe(true);
    }
    expect(finalSchema.tables.get('alerts')?.has('last_fired_at')).toBe(true);
  });

  it('makes (user_id, channel, dedupe_key) unique: the idempotency key', () => {
    expect(migration0002).toMatch(
      /CREATE UNIQUE INDEX "notification_deliveries_user_id_channel_dedupe_key_key" ON "notification_deliveries"\("user_id", "channel", "dedupe_key"\)/,
    );
  });

  it('adds only nullable content columns for CSN-058', () => {
    for (const column of ['unit', 'reviewed_by', 'reviewed_at']) {
      expect(finalSchema.tables.get('lessons')?.has(column), column).toBe(true);
    }
    expect(finalSchema.tables.get('quick_checks')?.has('option_explanations')).toBe(true);
    expect(migration0002).toMatch(/ALTER TABLE "lessons" ADD COLUMN "unit" TEXT,/);
    expect(migration0002).not.toMatch(
      /"(unit|reviewed_by|reviewed_at|option_explanations)"[^\n]*NOT NULL/,
    );
  });

  it('uses the 3-step pattern for the new NOT NULL columns on notification_prefs', () => {
    const add = migration0002.indexOf(
      'ALTER TABLE "notification_prefs" ADD COLUMN "quiet_hours_start" SMALLINT,',
    );
    const fill = migration0002.indexOf('UPDATE "notification_prefs" SET');
    const notNull = migration0002.indexOf('ALTER COLUMN "daily_cap" SET NOT NULL');
    expect(add).toBeGreaterThan(-1);
    expect(fill).toBeGreaterThan(add);
    expect(notNull).toBeGreaterThan(fill);
  });
});

describe('documentation (F3, S4, S5)', () => {
  it('has a Deploying section that makes db:seed a per-environment step and names CSN-073', () => {
    const section = /^## Deploying\n([\s\S]*?)(?=^## )/m.exec(readme)?.[1] ?? '';
    // The ordered steps: deploy first, then the seed in every environment.
    expect(section).toMatch(/^1\. `pnpm -F @coinsnipe\/db db:deploy`/m);
    expect(section).toMatch(/^2\. `pnpm -F @coinsnipe\/db db:seed`, in \*\*every environment\*\*/m);
    expect(section).toMatch(/db:deploy` and then `db:seed`/);
    expect(section).toMatch(/every environment/);
    expect(section).toMatch(/CSN-073/);
    expect(section).toMatch(/assets\.sector_id/);
    expect(section).toMatch(/point-in-time restore/i);
    expect(section).toMatch(/migrate resolve --rolled-back/);
  });

  it('tells CSN-058 which columns exist and CSN-050 to drop provider tokens', () => {
    expect(readme).toMatch(/For CSN-058/);
    expect(readme).toMatch(/option_explanations/);
    expect(readme).toMatch(/For CSN-050/);
    expect(readme).toMatch(/linkAccount/);
    expect(schemaPrisma).toMatch(/drop all three in its linkAccount wrapper/);
  });

  it('documents env loading for the db scripts', () => {
    expect(readme).toMatch(/\.env\.local/);
  });
});

describe('lock safety, seed wording and rollback honesty in 0002 (review fixes)', () => {
  const code = migration0002
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .join('\n');
  const flat = migration0002
    .slice(0, migration0002.indexOf('\nSET LOCAL'))
    .replace(/\n--\s*/g, ' ');

  it('starts with SET LOCAL lock_timeout = 5s, the first statement of the file', () => {
    expect(code.trimStart().startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
    expect(migration0002.match(/lock_timeout/g)?.length).toBeGreaterThanOrEqual(2); // header + statement
  });

  it('states the deadlock risk, quiet writers and the resolve-then-deploy recovery in the Safety section', () => {
    expect(flat).toMatch(/Apply 0002 while writers are quiet or stopped/);
    expect(flat).toMatch(/can deadlock with this file/);
    expect(flat).toMatch(/lock_timeout or deadlock failure is safe, nothing is applied/);
    // Recovery after a failed apply: Prisma records 0002 as failed, so resolve before deploying again.
    expect(flat).toMatch(/P3009/);
    expect(flat).toMatch(
      /after a failed apply run `prisma migrate resolve --rolled-back 0002_schema_v1_1` and then deploy again/,
    );
    expect(flat).toMatch(/pipeline that retries the deploy needs that resolve step/);
    expect(flat).not.toMatch(/concurrent writers wait for the commit\./);
  });

  it('says the reverse SQL does not undo the status normalisation and loses the original text', () => {
    expect(flat).toMatch(/does NOT undo the job_runs status normalisation/);
    expect(flat).toMatch(/original status text is lost/);
  });

  it('ends the reverse SQL with the migration-history delete', () => {
    const block =
      /-- >>> ROLLBACK-SQL\n([\s\S]*?)-- <<< ROLLBACK-SQL/.exec(migration0002)?.[1] ?? '';
    const lines = block.split('\n').filter((line) => line.startsWith('-- | '));
    expect(lines.at(-1)).toBe(
      `-- | DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0002_schema_v1_1';`,
    );
  });

  it('states the seed behaviour accurately everywhere and never the old claim', () => {
    for (const [name, text] of [
      ['migration 0002', migration0002],
      ['README', readme],
      ['prisma.config.ts', prismaConfig],
      ['schema.prisma', schemaPrisma],
    ] as const) {
      // The retired wording: that migrate dev never seeds.
      expect(text, name).not.toMatch(
        /(migrate dev|db:migrate)[^.\n]*(do not|does not|never) run[^.\n]*seed/i,
      );
      expect(text, name).not.toMatch(/only `?db:reset`? does/i);
    }
    expect(readme).toMatch(/`migrate deploy` never runs the seed/);
    expect(readme).toMatch(
      /`migrate dev` and `migrate reset` run it only when they create or reset the database/,
    );
    expect(migration0002).toMatch(
      /`prisma migrate deploy` never runs the seed; `prisma migrate dev` and/,
    );
    expect(prismaConfig).toMatch(
      /`migrate deploy` never runs it, and `migrate dev` runs it only when it creates/,
    );
  });

  it('documents the lock-timeout and quiet-writer rule in the README', () => {
    expect(readme).toMatch(/SET LOCAL lock_timeout = '5s'/);
    expect(readme).toMatch(/while writers are quiet or stopped/);
    expect(readme).toMatch(/can deadlock with the migration/);
    expect(readme).toMatch(/fails with P3009/);
    expect(readme).toMatch(
      /after a failed apply run `prisma migrate resolve --rolled-back <name>` \(for 0002: `prisma migrate resolve --rolled-back 0002_schema_v1_1`\) and then deploy again/,
    );
    expect(readme).toMatch(/Any pipeline that retries the deploy needs that resolve step/);
    expect(readme).toMatch(/original `job_runs` status text, which is lost after a revert/);
  });

  it('documents the CSN-060 delivery protocol: claim statement, retry, per-user lock', () => {
    expect(readme).toMatch(
      /ON CONFLICT \(user_id, channel, dedupe_key\) DO UPDATE SET [^`]*WHERE notification_deliveries\.status IN \('pending', 'failed'\) RETURNING id/,
    );
    expect(readme).toMatch(
      /pg_advisory_xact_lock\(hashtextextended\('notify:' \|\| <user_id>, 0\)\)/,
    );
    // One recipe: the advisory lock. FOR UPDATE on the optional prefs row is warned against.
    expect(readme).toMatch(/Take a per-user advisory lock first/);
    expect(readme).toMatch(
      /Do not use `SELECT \.\.\. FOR UPDATE` on the user's `notification_prefs` row instead/,
    );
    expect(readme).not.toMatch(
      /, or `SELECT 1 FROM notification_prefs WHERE user_id = <user_id> FOR UPDATE`/,
    );
    expect(schemaPrisma).toMatch(/FOR UPDATE on\n\/\/ notification_prefs is not a substitute/);
    expect(readme).toMatch(/at least once/);
    expect(readme).not.toMatch(/DO NOTHING` and send only when a row was inserted/);
    expect(schemaPrisma).toMatch(/WHERE status IN \('pending', 'failed'\) RETURNING id/);
    expect(schemaPrisma).toMatch(/per-user advisory lock/);
  });

  it('sweep: no bare retry or rerun claim after a lock timeout or deadlock, it must name the resolve step', () => {
    const sentences = (text: string) => text.split(/(?<=[.:])\s+/);
    for (const [name, text] of [
      ['migration 0002 header', flat],
      ['README', readme],
      ['schema.prisma', schemaPrisma.replace(/\n\/\/\s*/g, ' ')],
    ] as const) {
      for (const sentence of sentences(text)) {
        const aboutFailure = /lock_timeout|lock timeout|deadlock|lock is not available/i.test(
          sentence,
        );
        const claimsRetry = /\b(simply retried|rerun|re-run|retried|retry|retries)\b/i.test(
          sentence,
        );
        if (aboutFailure && claimsRetry) {
          expect(sentence, `${name}: ${sentence}`).toMatch(/resolve --rolled-back/);
        }
      }
    }
    expect(flat).not.toMatch(/deploy is simply retried|rerun when quiet/);
    expect(readme).not.toMatch(/and you rerun it/);
  });
});
