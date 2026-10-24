# @coinsnipe/db

Prisma schema, migrations, seed and client for CoinSnipe (Postgres 16 locally, Neon in production).
This package stores facts and computed reads about data; nothing in it gives advice.

## Commands

Set `DATABASE_URL` (pooled, runtime) and `DIRECT_URL` (non-pooled, migrations); the names are in `.env.example`. Put them in the environment, or copy `.env.example` to `.env.local` (repo root or `packages/db`): `prisma.config.ts` and the seed load `.env.local` and `.env` themselves (`src/load-env.ts`). Priority, highest first: variables already in the environment (never overridden), `packages/db/.env.local`, root `.env.local`, `packages/db/.env`, root `.env`. Values are never printed. Both files are git-ignored.

| Command                             | What it does                                                    |
| ----------------------------------- | --------------------------------------------------------------- |
| `pnpm -F @coinsnipe/db db:generate` | Generate the Prisma client (also run by build, typecheck, test) |
| `pnpm -F @coinsnipe/db db:migrate`  | `prisma migrate dev`: create and apply a migration locally      |
| `pnpm -F @coinsnipe/db db:deploy`   | `prisma migrate deploy`: apply committed migrations (CI, prod)  |
| `pnpm -F @coinsnipe/db db:reset`    | `prisma migrate reset` then seed. Local databases only          |
| `pnpm -F @coinsnipe/db db:seed`     | Upsert the 11 sectors and 20 narratives. Idempotent             |

`db:deploy` (`migrate deploy`) never runs the seed. `db:migrate` and `db:reset` run it only when they create or reset the database, so always run `db:seed` explicitly. See [Deploying](#deploying).

Rules: every schema change is a new migration (`0003_...`, the next number); never edit an applied one. The current migrations are `0001_init` (schema v1) and `0002_schema_v1_1`. The seed writes reference data only: no price, score or sample data ever goes into a real database.

Tests: `schema.test.ts` and `load-env.test.ts` always run. `database.test.ts` needs `DATABASE_URL` pointing at a local Postgres; it builds and drops its own throwaway schemas (applying every migration, and for the upgrade and rollback checks 0001 then 0002 over sample rows) and is skipped otherwise.

## Deploying

Per environment (local, preview, production), in this order:

1. `pnpm -F @coinsnipe/db db:deploy` (`prisma migrate deploy`, using `DIRECT_URL`).
2. `pnpm -F @coinsnipe/db db:seed`, in **every environment**, once after the first deploy and safe to repeat. The sector and narrative rows are not created by any migration, and `assets.sector_id` is a NOT NULL foreign key to `sectors`, so the first asset insert (CSN-020) fails on an unseeded database. `migrate deploy` never runs the seed, and `migrate dev` and `migrate reset` run it only when they create or reset the database; do not rely on that.
3. Check: `prisma migrate status` reports up to date; `sectors` has 11 rows and `narratives` 20.

**For CSN-073**: the deploy pipeline and the restore drill run `db:deploy` and then `db:seed`, in that order, in every environment. A database restored from a backup taken before the first seed, and a fresh Neon branch, come back without sectors until `db:seed` runs.

Recovering from a bad migration (Prisma has no down migrations):

- A migration that fails to apply changes nothing (each file runs as one transaction). Fix the cause, run `prisma migrate resolve --rolled-back <name>`, deploy again.
- Apply a migration that alters existing tables while writers are quiet or stopped (worker paused, no app traffic). Start such a migration with `SET LOCAL lock_timeout = '5s';` (0002 does): it then fails cleanly and applies nothing if a lock is not available in time. Prisma still records the migration as failed, so a plain rerun of `prisma migrate deploy` fails with P3009: after a failed apply run `prisma migrate resolve --rolled-back <name>` (for 0002: `prisma migrate resolve --rolled-back 0002_schema_v1_1`) and then deploy again. Any pipeline that retries the deploy needs that resolve step in its retry. Waiting is not the only risk: an application transaction that touches `users` and then an altered table can deadlock with the migration; Postgres aborts one side, and if it picks the migration the file rolls back whole.
- A migration that applied but must be undone: prefer rolling forward with the next numbered migration. For `0002_schema_v1_1` the exact reverse SQL is in its header (its last statement removes the migration from `_prisma_migrations`), is tested against a populated schema and followed by a re-deploy, and lists what it discards. It does not restore the original `job_runs` status text, which is lost after a revert: take a dump of the affected tables first.
- On Neon, point-in-time restore to a branch taken before the deploy is the alternative; deploy the app version that matches the restored schema, and run `db:seed` if the restore point predates the first seed.
- Expand then contract: add the new nullable column, backfill, switch the code, and only then make it NOT NULL or drop the old one, each as its own migration when the table is large or an old app version is still running. Backfills on non-empty tables must be safe under concurrent writes; say how in the migration header.
- Never run `migrate reset` against a database that holds real user or billing rows.

## As-of rule

`as_of` is the date a value first became known to us. A point-in-time read at date `D` filters `date <= D AND as_of <= D`.

- **Latest-only tables** (every raw table except `macro_daily`): the key never contains `as_of`. The first write sets `as_of`. An upsert of a restated value overwrites the value and `fetched_at` and never advances `as_of`: leave it out of the Prisma `update` clause and out of `ON CONFLICT ... DO UPDATE SET`. Reason: advancing it would drop the row from every read at an earlier date, a hole where production had a value. Keeping it has a bounded leak instead: an earlier read sees the revised number, not the original. CSN-040 accepts the bounded leak and states it in its report.
- **`macro_daily`** keeps every published vintage (`as_of` is in the key) because macro revisions are material: the backtest reads the latest vintage with `as_of <= D`.
- **Backfills** have no real first-known date: they set `as_of` to the observation date (a weekly or monthly series: the last day of the period).
- The rule is written in the `schema.prisma` header and in one comment line on each of the 18 latest-only models. Structural pin: no key other than `macro_daily`'s contains `as_of` (`schema.test.ts`).

## Notes for downstream tasks

- **For CSN-020 (universe load)**: write the universe diff (added, removed, remapped) into `job_runs.details` of the weekly universe run. Run `db:seed` first (see Deploying).
- **For CSN-027 (runner)**: `job_runs` has one row per `(job, run_key)`. `run_key` is `YYYY-MM-DD` for a daily job and `YYYY-MM-DDTHH` (UTC hour) for an hourly job; it must start with `run_date`. Take an advisory lock on `(job, run_key)`: a transaction-level lock (`pg_advisory_xact_lock`) only for short claims; for jobs that run for minutes use a session-level lock (`pg_advisory_lock` / `pg_advisory_unlock`) on a dedicated connection, because a transaction-level lock would keep one interactive Prisma transaction open past its default timeout for the whole run. Skip the slot when its row has status `success`, otherwise claim it with `INSERT ... ON CONFLICT (job, run_key) DO UPDATE SET status = 'running', ... WHERE job_runs.status <> 'success'` (zero rows returned means skip). Status is `running`, `success` or `failed`. A run that ends with a warning is still `success`; put the warning in `details`.
- **For CSN-040 (backtest and drift)**: follow the [As-of rule](#as-of-rule). The drift warning goes into `job_runs.details.warnings` of a `success` row.
- **For CSN-050 (accounts)**: `accounts` has `access_token`, `refresh_token` and `id_token` columns only because `@auth/prisma-adapter` writes them. CoinSnipe signs users in and never calls the provider afterwards, so drop all three in your `linkAccount` wrapper and store none. The columns stay (the adapter expects them).
- **For CSN-058 (learn content)**: `lessons` has nullable `unit` (always the unit slug, for example `basics`; never the display title), `reviewed_by` and `reviewed_at`; `estimated_minutes` holds the minutes, and the glossary terms a lesson uses stay in `body`. A glossary term's "related lessons" are derived, not stored: the lessons whose `body` contains that term's slug, so `glossary_terms` needs no column. `quick_checks.options` stays an array of answer texts; `option_explanations` is a nullable array of the same length with one explanation per answer (the existing `explanation` is the overall one). Nothing else in `packages/db` needs a migration for content.
- **For CSN-060 (notifications)**: delivery state lives in `notification_deliveries`; quiet hours and the daily cap in `notification_prefs`; the last fire time in `alerts.last_fired_at`.
  - Keys: `signal:<signals.id>`, `alert:<alerts.id>:<UTC hour, YYYY-MM-DDTHH>` (so the hourly SG12 job fires an alert at most once an hour), `digest:<ISO week>`, `briefing:<ISO week>`.
  - Delivery protocol, one database transaction per user and delivery (`database.test.ts` runs this recipe against real Postgres):
    1. Take a per-user advisory lock first: `SELECT pg_advisory_xact_lock(hashtextextended('notify:' || <user_id>, 0))` (with Prisma use `$executeRaw`; `$queryRaw` cannot read its void result). It needs no row to exist. Do not use `SELECT ... FOR UPDATE` on the user's `notification_prefs` row instead: that row is optional, and when it is missing nothing is locked (it is only safe if the row is created first in the same transaction with `INSERT ... ON CONFLICT DO NOTHING`). Without it two jobs running at once (realtime after signals, and the hourly SG12 run) can each count 4 sent rows and each send, ending above the cap.
    2. Claim the row: `INSERT INTO notification_deliveries (...) VALUES (..., 'pending') ON CONFLICT (user_id, channel, dedupe_key) DO UPDATE SET signal_id = COALESCE(EXCLUDED.signal_id, notification_deliveries.signal_id) WHERE notification_deliveries.status IN ('pending', 'failed') RETURNING id`. No row returned means the delivery is already sent or batched: skip. A new key inserts as `pending`; a `pending` row held for quiet hours and a `failed` row are claimed by the same statement, so a retry or the quiet-hours release works. The claimed row stays locked until commit, so a concurrent claimer waits and then gets no row.
    3. Daily cap, counted per distinct notification, not per delivery row: one notification is one `dedupe_key`, so a send on push and on email counts once. Read `SELECT count(DISTINCT dedupe_key) AS distinct_sent, COALESCE(bool_or(dedupe_key = <key>), false) AS key_already_sent FROM notification_deliveries WHERE user_id = <user_id> AND kind IN ('signal', 'alert') AND status = 'sent' AND sent_at >= <start of the user's local day>` (`notification_prefs.timezone`, null means UTC). Send when `key_already_sent` (the other channel of a notification that is already counted) or `distinct_sent < daily_cap`; otherwise set the claimed row to `batched`. Sending: set `sent` with `sent_at = now()` (or `failed`) and commit.
    4. A crash before commit rolls the transaction back: the row is absent or still `pending` or `failed`, so the next run claims it again. A crash after the provider accepted the message but before commit can send it again, so delivery is at least once.
    5. Quiet hours (default 22 to 8, local hours, wraps midnight, equal start and end means none): commit the row as `pending` instead of sending; the release job claims it with the statement above.
  - **Users without a `notification_prefs` row** are treated as having the column defaults, stated here once: `weekly_digest_email` true, `realtime_push` true, `realtime_email` true, `timezone` null (UTC), `quiet_hours_start` 22, `quiet_hours_end` 8, `daily_cap` 5. The CSN-060 jobs (`notifyRealtime`, `weeklyDigest`, `weeklyBriefing`) read prefs through one shared function that LEFT JOINs from `users` and COALESCEs to these values, so a missing row never means "send nothing" or "no cap". The row is created on the first preference save (`INSERT ... ON CONFLICT (user_id) DO NOTHING`, then update); signup does not need to create it.
  - **`batched` rows** (withheld by the cap) are terminal. Nothing sends them individually and the claim statement never takes them, so a re-run cannot push them later and their dedupe key stays taken. They reach the user through the weekly digest, which lists the week's signals on the user's coins minus those with a `sent` row (the digest is not capped; a Pro user who opted out of it simply never sees them). No status transition and no batch message kind exist.
  - **Release and retention** (CSN-060 and the CSN-027 maintenance job): the release job finds open rows with `WHERE status IN ('pending', 'failed')`, served by the partial index `notification_deliveries_open_idx`, and claims them with the statement above. Retention: delete `sent`, `batched` and `failed` rows older than 35 days (past the one-day cap window, the weekly digest keys and the hourly alert keys; a signal is only notified within a day of firing); never delete `pending` rows.
  - The weekly digest leaves out signals already pushed by joining on `signal_id`.

## Tables

Raw-fact tables carry `as_of` (date the value was known), `fetched_at` and `source`. Asset-keyed daily tables (`price_daily`, `protocol_metrics_daily`, `etf_flows_daily`, and `scores_daily` with `horizon`) are keyed on `(asset_id, date)`; `derivatives_daily` adds `exchange`, and `macro_daily` is keyed on `(series_id, date, as_of)`. Series-level and market-level daily tables (stablecoin supply, DVOL, Fear & Greed, global market, sector and narrative heat, market weather, alt season, Bitcoin outlook) are keyed on their own series or entity plus `date`. Every daily table has an index leading with `date`, every asset-and-date table one leading with `(asset_id, date)` and every user table one leading with `user_id` (`events_calendar` and `key_levels` use their unique index for `(asset_id, date)`); `schema.test.ts` and `database.test.ts` fail when one is dropped. Raw tables keep the latest value per key and never advance `as_of`, except `macro_daily`, which keeps every published vintage (see [As-of rule](#as-of-rule)).

### Reference

- `sectors`: the 11 sectors (id, plain name, plain description).
- `narratives`: the 20 narratives that cut across sectors.
- `assets`: one row per tracked coin (CoinGecko id, DefiLlama slug and chain, GitHub repos, sector, narrative ids, flags, delisting date).

### Raw facts

- `price_daily`: daily open, high, low, close, volume, market cap, circulating and total supply per coin.
- `price_hourly`: hourly candles for Bitcoin, Ethereum and top coins (volume profile).
- `protocol_metrics_daily`: TVL, fees, revenue, DEX volume and active users per protocol coin.
- `stablecoin_supply_daily`: stablecoin supply per day, global (`chain = 'all'`) and per chain.
- `derivatives_daily`: funding rate (8h) and open interest per coin, day and exchange.
- `options_oi`: daily snapshot of options open interest per currency, expiry and strike.
- `dvol_daily`: Deribit implied-volatility index per currency and day.
- `macro_daily`: macro series (M2, dollar index, 10-year yield, oil, VIX, Nasdaq, S&P 500, gold) by series id and day; holds every published vintage of an observation (key includes `as_of`), so a revision adds a row and point-in-time reads see what was known then.
- `fear_greed_daily`: Fear & Greed index value per day.
- `gpr_monthly`: geopolitical risk index per month.
- `news_items`: news headlines with tone (-100 to 100), topic and the coins they mention; unique per URL hash.
- `dev_activity_weekly`: commits and active developers per coin and week.
- `exchange_listings`: which exchange and quote pair lists a coin, first and last seen, fiat-pair flag.
- `unlock_events`: scheduled token unlocks (amount, share of circulating supply).
- `security_events`: hacks, exploits and audits per coin with USD lost.
- `etf_flows_daily`: net spot-ETF flows and assets per underlying coin and day.
- `liquidation_clusters`: price levels where leveraged positions would be force-closed, per snapshot day.
- `global_market_daily`: Bitcoin dominance and total market cap per day.
- `events_calendar`: dated events (FOMC, CPI, payrolls, PCE, ETF decisions, unlocks), optionally tied to a coin; unique per coin, date, kind and title, and per date, kind and title for market-wide rows.

### Computed (daily scoring run)

- `scores_daily`: per coin, day and horizon: Quality and its five pillars, Timing parts, temperature, combined score, quadrant, archetype, headroom, obstacles, gates, confidence, full per-metric breakdown.
- `sector_heat_daily`: sector heat, 14-day slope and phase with the 3-day hysteresis state.
- `narrative_heat_daily`: the same for narratives.
- `market_weather_daily`: market weather score, label and inputs.
- `alt_season_daily`: alt-season score, phase and inputs.
- `btc_outlook_daily`: Bitcoin regime, fuel, fragility, inputs and the plain sentence.
- `key_levels`: support and resistance zones per coin and day with strength and methods.
- `scenarios`: base, upside and downside paths with the trigger that would confirm each.
- `signals`: append-only smart signals (SG1 to SG14) with before/after state, plain text and a unique dedupe key.
- `base_rates`: historical base rates per kind and key with sample size and a thin-history flag, by model version.
- `job_runs`: one row per job and run slot (unique `(job, run_key)`; a daily job's slot is the date, an hourly job's the UTC hour), the idempotency record for scheduled jobs. Status `running`, `success` or `failed`; `details` holds structured output such as the universe diff or warnings.

### Users and billing

- `users`, `accounts`, `sessions`, `verification_tokens`: the Auth.js Prisma adapter tables (model names and Prisma field names must not change).
- `profiles`: quiz answers (knowledge 1 to 4, goal, horizon, risk, sectors) and onboarding completion.
- `holdings`: hand-entered coins a user owns; the amount is optional.
- `watchlist_items`: coins a user follows.
- `alerts`: per-user alert rules (kind, JSON params, channel, active, last fired time).
- `notification_prefs`: weekly digest, push and email preferences, timezone, quiet hours and the daily cap.
- `notification_deliveries`: delivery log and idempotency record per user, channel and dedupe key; the per-user daily cap (distinct notifications) is counted from it.
- `push_subscriptions`: web push endpoints per user.
- `lesson_progress`: completed lessons and quiz scores per user.
- `streaks`: current and longest learning streak per user.
- `subscriptions`: the user's Stripe customer and subscription state; entitlement is status `trialing` or `active`.
- `stripe_events`: processed Stripe webhook event ids (primary key), for idempotent handling.

### Content

- `lessons`: authored lessons in path order, with unit and reviewer.
- `quick_checks`: short quiz questions attached to a lesson, with an optional explanation per answer.
- `glossary_terms`: glossary entries (slug, term, one line, body).
- `asset_explainers`: the four "In plain words" texts per coin, with reviewer and review date.
