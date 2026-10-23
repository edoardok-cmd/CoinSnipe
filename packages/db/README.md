# @coinsnipe/db

Prisma schema, migrations, seed and client for CoinSnipe (Postgres 16 locally, Neon in production).
This package stores facts and computed reads about data; nothing in it gives advice.

## Commands

Set `DATABASE_URL` (pooled, runtime) and `DIRECT_URL` (non-pooled, migrations); the names are in `.env.example`.

| Command                             | What it does                                                    |
| ----------------------------------- | --------------------------------------------------------------- |
| `pnpm -F @coinsnipe/db db:generate` | Generate the Prisma client (also run by build, typecheck, test) |
| `pnpm -F @coinsnipe/db db:migrate`  | `prisma migrate dev`: create and apply a migration locally      |
| `pnpm -F @coinsnipe/db db:deploy`   | `prisma migrate deploy`: apply committed migrations (CI, prod)  |
| `pnpm -F @coinsnipe/db db:reset`    | `prisma migrate reset` then seed. Local databases only          |
| `pnpm -F @coinsnipe/db db:seed`     | Upsert the 11 sectors and 20 narratives. Idempotent             |

Rules: every schema change is a new migration (`0002_...`); never edit an applied one. The seed writes reference data only: no price, score or sample data ever goes into a real database.

Tests: `schema.test.ts` always runs. `database.test.ts` needs `DATABASE_URL` pointing at a local Postgres; it builds and drops its own throwaway schema and is skipped otherwise.

## Tables

Raw-fact tables carry `as_of` (date the value was known), `fetched_at` and `source`. Asset-keyed daily tables (`price_daily`, `protocol_metrics_daily`, `etf_flows_daily`, and `scores_daily` with `horizon`) are keyed on `(asset_id, date)`; `derivatives_daily` adds `exchange`, and `macro_daily` is keyed on `(series_id, date, as_of)`. Series-level and market-level daily tables (stablecoin supply, DVOL, Fear & Greed, global market, sector and narrative heat, market weather, alt season, Bitcoin outlook) are keyed on their own series or entity plus `date`. Every daily table has an index on `date`. Raw tables keep the latest value per key, except `macro_daily`, which keeps every published vintage.

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
- `job_runs`: one row per job and run date (unique), the idempotency record for scheduled jobs.

### Users and billing

- `users`, `accounts`, `sessions`, `verification_tokens`: the Auth.js Prisma adapter tables (model names and Prisma field names must not change).
- `profiles`: quiz answers (knowledge 1 to 4, goal, horizon, risk, sectors) and onboarding completion.
- `holdings`: hand-entered coins a user owns; the amount is optional.
- `watchlist_items`: coins a user follows.
- `alerts`: per-user alert rules (kind, JSON params, channel, active).
- `notification_prefs`: weekly digest, push and email preferences.
- `push_subscriptions`: web push endpoints per user.
- `lesson_progress`: completed lessons and quiz scores per user.
- `streaks`: current and longest learning streak per user.
- `subscriptions`: the user's Stripe customer and subscription state; entitlement is status `trialing` or `active`.
- `stripe_events`: processed Stripe webhook event ids (primary key), for idempotent handling.

### Content

- `lessons`: authored lessons in path order.
- `quick_checks`: short quiz questions attached to a lesson.
- `glossary_terms`: glossary entries (slug, term, one line, body).
- `asset_explainers`: the four "In plain words" texts per coin, with reviewer and review date.
