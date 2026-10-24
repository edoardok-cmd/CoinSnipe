-- 0002_schema_v1_1: CoinSnipe schema v1.1 (CSN-003-FOLLOWUP-3).
--
-- Purpose
--   Fix the gaps CSN-003 task-r1 found before CSN-020, CSN-027, CSN-040, CSN-058 and
--   CSN-060 build on the tables. 0001_init is applied and is not edited.
--   * job_runs (F1): new run_key slot column (daily 'YYYY-MM-DD', hourly 'YYYY-MM-DDTHH'),
--     details jsonb, status vocabulary running | success | failed (CHECK). Unique key moves
--     from (job, run_date) to (job, run_key) so hourly jobs get one row per hour.
--   * Notification delivery state (F2): notification_deliveries (delivery log and
--     idempotency record, also the source of the per-user daily cap count),
--     notification_prefs.quiet_hours_start / quiet_hours_end / daily_cap,
--     alerts.last_fired_at.
--   * S3: drop the duplicate (asset_id, date) indexes on events_calendar and key_levels; the
--     unique indexes on the same tables lead with (asset_id, date) and serve those reads.
--   * S4: additive nullable columns lessons.unit / reviewed_by / reviewed_at and
--     quick_checks.option_explanations (one text per answer) for CSN-058.
--   * No data-shape change for F3, F4, F5, F6, S5: they are documentation, tooling and
--     tests (packages/db/README.md, prisma.config.ts, src/*.test.ts).
--
-- Safety (lock and backfill strategy)
--   * Prisma runs this file as one multi-statement query, that is one transaction: it
--     applies completely or not at all. ALTER TABLE takes ACCESS EXCLUSIVE on its table
--     and holds it until commit, so no writer can interleave between the nullable add, the
--     backfill and the SET NOT NULL below: concurrent writers wait for the commit. That is
--     what makes the single set-based UPDATEs safe under concurrent writes; they are not
--     batched because the tables are small (job_runs: tens of rows per day;
--     notification_prefs: one row per user) and batching inside one transaction would not
--     shorten the lock.
--   * New NOT NULL columns on existing tables (job_runs.run_key, job_runs.details,
--     notification_prefs.quiet_hours_start / quiet_hours_end / daily_cap) use the 3-step
--     pattern: nullable add, backfill, SET DEFAULT and SET NOT NULL.
--   * job_runs.status is normalised in the backfill, before the CHECK is added: succeeded,
--     completed, complete, ok and done become success; started, in_progress and pending
--     become running; any other value, including failure and error, becomes failed (so
--     the idempotent skip re-runs it, never skips it). The original text of every status
--     outside the exact vocabulary running | success | failed is kept in
--     details.legacy_status. Nothing is deleted.
--   * Lock window: ACCESS EXCLUSIVE on job_runs, notification_prefs, alerts, lessons,
--     quick_checks, events_calendar and key_levels for the duration of the file, plus
--     the SHARE ROW EXCLUSIVE lock the new foreign keys take on users and signals. On an
--     empty database this is milliseconds. On a populated database the cost is one pass
--     over job_runs and notification_prefs for the backfill and the CHECK validation.
--     Measured on local Postgres 16 with 100,000 notification_prefs rows, 50,000 job_runs
--     rows, 20,000 alerts and 20 lessons: the whole file applied in 2.0 s. Writers to those
--     tables (the worker, preference saves) wait that long at worst, which is acceptable;
--     the estimate grows roughly linearly with rows.
--   * Old writers: nothing writes job_runs yet (CSN-027 is the first writer and ships with
--     run_key), so there is no deployed writer to break on the new NOT NULL run_key.
--   * Run with DIRECT_URL (non-pooled connection), not the pooled DATABASE_URL.
--
-- Per-environment seed (F3). The sector and narrative reference rows are NOT created by
-- any migration, and `prisma migrate dev` / `prisma migrate deploy` do not run the seed.
-- assets.sector_id is a NOT NULL foreign key to sectors, so an environment whose sectors
-- table is empty cannot accept the first asset (CSN-020 universe load). Run
-- `pnpm -F @coinsnipe/db db:seed` once in every environment (local, preview, production)
-- after `prisma migrate deploy`; it is idempotent. CSN-073 (production operations) must
-- run db:seed right after migrate deploy in the deploy pipeline and in the restore drill.
--
-- Rollback (Prisma has no down migrations)
--   * 0002 failed to apply: it is one transaction, so nothing changed. Fix the cause, run
--     `prisma migrate resolve --rolled-back 0002_schema_v1_1`, then deploy again.
--   * 0002 applied, new tables and columns still empty or unused: run the reverse SQL
--     below, then delete the migration's row from the migration history table
--     (DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0002_schema_v1_1').
--   * 0002 applied and data exists in the new objects (job_runs hourly slots,
--     notification_deliveries, quiet hours and caps users chose, lesson and quick-check
--     content): prefer rolling forward with a new 0003 migration. If a revert is
--     unavoidable, first take a dump of the affected tables
--     (pg_dump -t job_runs -t notification_deliveries -t notification_prefs -t lessons
--     -t quick_checks), because the reverse SQL discards: all hourly job_runs rows, every
--     notification_deliveries row, the three notification_prefs columns, alerts.last_fired_at,
--     lessons.unit / reviewed_by / reviewed_at and quick_checks.option_explanations. Lesson
--     content is recoverable by re-running seedContent (CSN-058) from the files in git. On
--     Neon the alternative is point-in-time restore to a branch taken before the deploy;
--     the app version that matches the restored schema must be deployed with it.
--   * Reference data caveat: 0002 neither writes nor deletes sectors and narratives, so
--     the reverse SQL leaves them in place. Anything that recreates the database instead
--     (migrate reset on a dev database, a fresh Neon branch, a restore taken before the
--     first seed) loses them: run db:seed again afterwards. Never run migrate reset on a
--     database that holds real user or billing rows.
--   The reverse SQL (run in one transaction; executed by database.test.ts against a
--   populated scratch schema, so it is checked, not just written):
-- >>> ROLLBACK-SQL
-- | DROP TABLE "notification_deliveries";
-- | ALTER TABLE "quick_checks" DROP CONSTRAINT "quick_checks_option_explanations_check";
-- | ALTER TABLE "quick_checks" DROP COLUMN "option_explanations";
-- | ALTER TABLE "lessons" DROP COLUMN "unit", DROP COLUMN "reviewed_by", DROP COLUMN "reviewed_at";
-- | ALTER TABLE "notification_prefs" DROP CONSTRAINT "notification_prefs_quiet_hours_check", DROP CONSTRAINT "notification_prefs_daily_cap_check";
-- | ALTER TABLE "notification_prefs" DROP COLUMN "quiet_hours_start", DROP COLUMN "quiet_hours_end", DROP COLUMN "daily_cap";
-- | ALTER TABLE "alerts" DROP COLUMN "last_fired_at";
-- | DELETE FROM "job_runs" WHERE "run_key" LIKE '%T%';
-- | ALTER TABLE "job_runs" DROP CONSTRAINT "job_runs_status_check", DROP CONSTRAINT "job_runs_run_key_check", DROP CONSTRAINT "job_runs_details_check";
-- | CREATE UNIQUE INDEX "job_runs_job_run_date_key" ON "job_runs"("job", "run_date");
-- | ALTER TABLE "job_runs" DROP COLUMN "run_key", DROP COLUMN "details";
-- | CREATE INDEX "events_calendar_asset_id_date_idx" ON "events_calendar"("asset_id", "date");
-- | CREATE INDEX "key_levels_asset_id_date_idx" ON "key_levels"("asset_id", "date");
-- <<< ROLLBACK-SQL
--
-- S3: duplicate indexes. The unique indexes events_calendar_asset_id_date_kind_title_key
-- and key_levels_asset_id_date_kind_low_high_key lead with (asset_id, date).
-- DropIndex
DROP INDEX "events_calendar_asset_id_date_idx";

-- DropIndex
DROP INDEX "key_levels_asset_id_date_idx";

-- F1: job_runs. Step 1, nullable add.
ALTER TABLE "job_runs" ADD COLUMN "run_key" TEXT,
ADD COLUMN "details" JSONB;

-- Step 2, backfill, one pass over the table. details keeps the original text of any status
-- outside the new vocabulary (the right-hand sides read the old row, so this runs before the
-- status is rewritten); status is normalised; run_key is the date (a daily slot).
UPDATE "job_runs" SET
  "details" = CASE
    WHEN "status" NOT IN ('running', 'success', 'failed') THEN jsonb_build_object('legacy_status', "status")
    ELSE '{}'::jsonb
  END,
  "status" = CASE lower(btrim("status"))
    WHEN 'running' THEN 'running'
    WHEN 'success' THEN 'success'
    WHEN 'failed' THEN 'failed'
    WHEN 'succeeded' THEN 'success'
    WHEN 'completed' THEN 'success'
    WHEN 'complete' THEN 'success'
    WHEN 'ok' THEN 'success'
    WHEN 'done' THEN 'success'
    WHEN 'started' THEN 'running'
    WHEN 'in_progress' THEN 'running'
    WHEN 'pending' THEN 'running'
    ELSE 'failed'
  END,
  "run_key" = to_char("run_date", 'YYYY-MM-DD')
WHERE "run_key" IS NULL;

-- Step 3, default and NOT NULL.
ALTER TABLE "job_runs" ALTER COLUMN "run_key" SET NOT NULL,
ALTER COLUMN "details" SET DEFAULT '{}',
ALTER COLUMN "details" SET NOT NULL;

-- Vocabulary and shape checks (Prisma cannot express them). run_key is 'YYYY-MM-DD' or
-- 'YYYY-MM-DDTHH' (UTC hour 00 to 23) and must start with run_date.
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_status_check" CHECK ("status" IN ('running', 'success', 'failed'));
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_run_key_check" CHECK ("run_key" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T([01][0-9]|2[0-3]))?$' AND left("run_key", 10) = to_char("run_date", 'YYYY-MM-DD'));
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_details_check" CHECK (jsonb_typeof("details") = 'object');

-- One row per job and slot: replaces unique (job, run_date), which allowed one row per job
-- per day and so could not record hourly jobs.
-- DropIndex
DROP INDEX "job_runs_job_run_date_key";

-- CreateIndex
CREATE UNIQUE INDEX "job_runs_job_run_key_key" ON "job_runs"("job", "run_key");

-- F2: alerts.last_fired_at (nullable, no backfill needed).
ALTER TABLE "alerts" ADD COLUMN "last_fired_at" TIMESTAMPTZ(3);

-- F2: notification_prefs quiet hours and daily cap. Step 1, nullable add.
ALTER TABLE "notification_prefs" ADD COLUMN "quiet_hours_start" SMALLINT,
ADD COLUMN "quiet_hours_end" SMALLINT,
ADD COLUMN "daily_cap" SMALLINT;

-- Step 2, backfill with the product defaults (22:00 to 08:00 local, at most 5 a day).
UPDATE "notification_prefs" SET
  "quiet_hours_start" = COALESCE("quiet_hours_start", 22),
  "quiet_hours_end" = COALESCE("quiet_hours_end", 8),
  "daily_cap" = COALESCE("daily_cap", 5)
WHERE "quiet_hours_start" IS NULL OR "quiet_hours_end" IS NULL OR "daily_cap" IS NULL;

-- Step 3, default and NOT NULL.
ALTER TABLE "notification_prefs" ALTER COLUMN "quiet_hours_start" SET DEFAULT 22,
ALTER COLUMN "quiet_hours_start" SET NOT NULL,
ALTER COLUMN "quiet_hours_end" SET DEFAULT 8,
ALTER COLUMN "quiet_hours_end" SET NOT NULL,
ALTER COLUMN "daily_cap" SET DEFAULT 5,
ALTER COLUMN "daily_cap" SET NOT NULL;

ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_quiet_hours_check" CHECK ("quiet_hours_start" BETWEEN 0 AND 23 AND "quiet_hours_end" BETWEEN 0 AND 23);
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_daily_cap_check" CHECK ("daily_cap" BETWEEN 0 AND 100);

-- F2: delivery log and idempotency record. CreateTable
CREATE TABLE "notification_deliveries" (
    "id" BIGSERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "channel" "alert_channel" NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "signal_id" BIGINT,
    "alert_id" BIGINT,
    "status" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_deliveries_user_id_sent_at_idx" ON "notification_deliveries"("user_id", "sent_at");

-- CreateIndex
CREATE INDEX "notification_deliveries_signal_id_idx" ON "notification_deliveries"("signal_id");

-- CreateIndex
CREATE INDEX "notification_deliveries_alert_id_idx" ON "notification_deliveries"("alert_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_user_id_channel_dedupe_key_key" ON "notification_deliveries"("user_id", "channel", "dedupe_key");

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Vocabulary checks. sent_at is set exactly when the status is sent.
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_kind_check" CHECK ("kind" IN ('signal', 'alert', 'digest', 'briefing'));
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_status_check" CHECK ("status" IN ('pending', 'sent', 'batched', 'failed'));
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_sent_at_check" CHECK (("status" = 'sent') = ("sent_at" IS NOT NULL));

-- S4: CSN-058 content columns. All nullable, so existing rows stay valid.
ALTER TABLE "lessons" ADD COLUMN "unit" TEXT,
ADD COLUMN "reviewed_by" TEXT,
ADD COLUMN "reviewed_at" TIMESTAMPTZ(3);

ALTER TABLE "quick_checks" ADD COLUMN "option_explanations" JSONB;

-- When present, option_explanations is an array with one entry per answer in options.
ALTER TABLE "quick_checks" ADD CONSTRAINT "quick_checks_option_explanations_check" CHECK (CASE WHEN "option_explanations" IS NULL THEN true WHEN jsonb_typeof("options") = 'array' AND jsonb_typeof("option_explanations") = 'array' THEN jsonb_array_length("option_explanations") = jsonb_array_length("options") ELSE false END);
