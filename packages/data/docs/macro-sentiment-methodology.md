# Macro and sentiment inputs: methodology (CSN-024)

Adapters: `packages/data/src/sources/` (`fred.ts` for A4, A6, A7, A8; `feargreed.ts` for D3; `gpr.ts` for A9; `calendar.ts` for A10). Job and composition root: `apps/worker/src/jobs/fetchMacro.ts` (`runFetchMacroJob`), entry `apps/worker/src/run-fetch-macro.ts`, store `apps/worker/src/store/prismaMacroStore.ts`. Tables: `macro_daily`, `fear_greed_daily`, `gpr_monthly`, `events_calendar` (schema owned by db-engineer; no migration added here).

Educational copy only. Labels describe the data and never say what to do with it.

## Spec status (items A to H)

| Item | Spec | Status |
| --- | --- | --- |
| A | as_of = observation date | **Done.** `asOfRule` defaults to `observation-date`. `publication-lag` is an opt-in flag. **Conflict:** this rule conflicts with the point-in-time note in `design.md` (see A below). `design.md` is not changed. |
| B | Global M2 approximation: US M2SL + EA + JP + CN + UK, USD, flagged approximation | **Done, with caveats.** Label "global M2 approximation", spec series IDs kept, composite stale (last complete 2019-10-02, CSN-024-FOLLOWUP-2). |
| C | Download the monthly XLS and parse the GPR column | **Done.** `xlsx` 0.20.3 is wired as the default reader. Live parse recorded below. |
| D | Calendar in `events_calendar`, visible for the next 30 days; worker wired | **Done.** Worker depends on `@coinsnipe/data` and `@coinsnipe/db`. Prisma store and composition root are in place. End-to-end test runs against a scratch database. 30-day rows shown below. |
| E | Unlocks from CSN-026 | **Missing.** CSN-026 is `todo`; the feed does not exist. The calendar keeps an unlock input, and no feed is faked. The dependency is CSN-026. |
| F | Live FRED smoke with a real key | **Missing.** No `FRED_API_KEY` in this environment. The gated test is kept and has not been run. |
| G | VIXCLS for A4 | **Conflict, awaiting owner sign-off.** The spec lists VIXCLS; CSN-071 records Cboe copyright. VIXCLS stays off by default behind `includeLicensedVix`. It is not flipped. |
| H | Chart comparison of the global M2 approximation | **Missing.** No reference chart is reachable from this environment. No chart is attached. |

## Master-plan map

| ID  | Input | Series or feed | Stored as |
| --- | --- | --- | --- |
| A4  | Nasdaq, S&P 500, VIX (inverted) | NASDAQCOM, SP500; VIXCLS off by default (G) | `macro_daily`, series id = FRED id |
| A6  | Dollar and 10Y (both inverted) | DTWEXBGS (labelled **DXY proxy**; the true DXY is ICE-licensed), DGS10 | `macro_daily` |
| A7  | Oil and gold | DCOILWTICO (WTI); gold = **gold proxy** `A7_GOLD_PROXY_USD` (mean of PAXG and XAUT daily prices from CoinGecko) | `macro_daily` |
| A8  | Global M2 approximation | `A8_GLOBAL_M2_APPROX` (series key), USD billions, source label `A8_APPROXIMATION_SOURCE` | `macro_daily` |
| A9  | News risk, geopolitical half | GPR monthly index (Caldara and Iacoviello), baseline 100 | `gpr_monthly` |
| A10 | Event calendar | FOMC; FRED release dates 10, 50, 54; admin ETF file (path from `COINSNIPE_ETF_DECISIONS_PATH`; unset means not configured, no file is read); CSN-026 unlocks (E, missing) | `events_calendar` |
| D3  | Fear & Greed extremes | alternative.me `fng/?limit=0`; extreme above 80 or below 20 (boundaries do not count) | `fear_greed_daily` |

## Forward fill and as-of (D1)

- Daily series: one row per observed day. Holidays (FRED `.`) are dropped, never filled.
- Monthly series: each calendar day takes the latest observation on or before it. A value stops being used 62 days after its observation date (`monthlyMaxFillDays`), so a stale series cannot pass as current.
- **as_of rule (A).** `asOfRule` defaults to `observation-date`: `as_of` equals the observation date. This is the spec's literal rule. `publication-lag` is opt-in: `as_of` = observation date + the series lag in the table below (monthly: first of the month + 45 days).
- **Conflict with `design.md` (reported, not changed).** The `design.md` point-in-time invariant says the backtest reads only rows with `as_of <= rebuild date`, and the `macro_daily` schema comment defines `as_of` as the publication date. Under `observation-date`, a monthly figure carries an `as_of` before it was published. A backtest that trusts `as_of` would read it early. The owner decided the spec rule stands. Use `publication-lag` in the backtest (CSN-040) or read ALFRED vintages.
- The rule reaches every adapter: FRED series and the composite, the gold proxy, Fear & Greed and GPR all read `asOfRule` and `publicationLagDays` from the config.
- The calendar's `as_of` is the fetch date and is outside this rule.
- Dates must lie in years 0000 to 9999. A timestamp, Excel serial or lagged date outside that range raises a `SourceError`.
- **Open for CSN-040.** Revisions are not versioned. `macro_daily` has the primary key `(series_id, date, as_of)`, so a revised value with the same as_of overwrites the original. A backtest that needs revisions must read ALFRED vintages (`realtime_start`).

Publication lag per series key (`PUBLICATION_LAG_DAYS` in `shared.ts`; used only under `publication-lag`):

| Series key | Used for | Lag |
| --- | --- | --- |
| NASDAQCOM, SP500, VIXCLS, DTWEXBGS, DGS10, DCOILWTICO | A4, A6, A7 (daily) | 1 day |
| DEXUSEU, DEXJPUS, DEXCHUS, DEXUSUK | A8 FX (daily) | 1 day |
| M2SL, MABMM301EZM189S, MABMM301JPM189S, MYAGM2CNM189N, MABMM301GBM189S | A8 monthly levels | 45 days after the first of the month |
| GPR_MONTHLY | A9 GPR (monthly) | 45 days after the first of the month |
| FEAR_GREED | D3 Fear & Greed (daily) | 1 day |
| A7_GOLD_PROXY_USD | A7 gold proxy (daily) | 1 day |

## A8 global M2 approximation (B)

Spec: US M2SL + EA (MABMM301EZM189S) + JP (MABMM301JPM189S) + CN (MYAGM2CNM189N) + UK, converted to USD, flagged `approximation`.

**Definitional facts (FRED, checked 2026-10-24):**

- The euro area, Japan and UK series used by the spec are **M3 (broad money)** on FRED: MABMM301EZM189S ("M3 for Euro Area (19 Countries)"), MABMM301JPM189S ("M3 for Japan") and MABMM301GBM189S ("M3 for United Kingdom").
- M2: M2SL (US, current to 2026-08) and MYAGM2CNM189N (China, ends 2019-08).
- True M2 for the euro area and Japan is not current: MYAGM2EZM196N ends March 2017 and MYAGM2JPM189N ends February 2017.
- No UK M2 series was found on FRED, so the spec's UK input is the M3 series MABMM301GBM189S.
- The label is "global M2 approximation", as the spec says. The caveat travels with the composite as `A8_CAVEAT` and is repeated here: the composite is approximate and mixes M2 and M3.

The approximation is:

1. Convert each area to USD billions (US is already USD billions in M2SL).
   - EA (MABMM301EZM189S, euro units): EUR × DEXUSEU (USD per EUR).
   - JP (MABMM301JPM189S, yen units): JPY ÷ DEXJPUS (yen per USD).
   - CN (MYAGM2CNM189N, yuan units): CNY ÷ DEXCHUS (yuan per USD).
   - GB (MABMM301GBM189S, pound units): GBP × DEXUSUK (USD per GBP).
   - The "189" series are in national-currency units. Checked on real data: the EA level is 1.6e13 euros, about EUR 16 trillion.
2. Sum the five areas on each day where all have a value. FX forward-fills for at most 7 days.
3. Each area's USD value must fall in `a8PlausibleUsdBnRange` (100 to 500,000). A unit mistake withholds the composite (a warning) and no wrong total is written. The raw FRED rows are still written.

**Verified 2026-10-24** (public `fredgraph.csv` downloads, no API key; the FRED API itself was not called):

- All five areas pass the plausibility check on real data, so the unit and FX-direction assumptions are confirmed.
- With the shipped default `startDate` (2000-01-01) the composite runs from 2000-01-01 (about USD 21.7 trillion) to 2019-10-02 (about USD 72.7 trillion): 7,215 rows. The 1999 start is not a default. It is reached only by passing a different `startDate` to `fetchFredMacroRows` (for example 1999-01-01), or an earlier `from` to `buildA8GlobalM2Approximation`. That run starts on 1999-01-04 (about USD 20.7 trillion, the first day DEXUSEU has data) and writes 7,577 rows. Sample values: 2008-09-15 about 40.9 trillion; 2014-06-02 about 59.9 trillion; 2019-08-01 about 73.4 trillion.

**Status: STALE.** The composite stops at 2019-10-02. EA, JP and UK end in 2023-11 and China ends in 2019-08, so the composite cannot reach the present with these IDs. `buildA8GlobalM2Approximation` returns `status = { lastCompleteDate, stale }`, where `stale` is true when `lastCompleteDate` is earlier than `to` minus `monthlyMaxFillDays`. With the real stop dates, `lastCompleteDate` is 2019-10-02 and `stale` is true. The job reports `A8 global M2 approximation is stale: last complete date 2019-10-02; ...` in its warnings. The composite is kept and marked stale, not removed. The composite also warns whenever it ends before `to` or an input is older than its cap.

- The growth-rate series (`MABMM301*657S`) are current but do not reproduce the YoY or MoM change of the levels. They are not used.
- **Current sources and the chart check are tracked as CSN-024-FOLLOWUP-2.** That covers a current source per area (ECB, BoJ, PBoC, BoE or BIS, or a national statistic) and the published-chart comparison (H).
- **H, missing:** the shape match against a published global M2 chart. No reference chart is reachable from this environment, so no match is claimed and no chart is attached.

Excluding an area (`a8ExcludeAreas`) changes what the number means. Do not present a partial composite as global M2.

## A9 GPR (C)

- Source: matteoiacoviello.com, `gpr_files/data_gpr_export.xls` (monthly, CC BY). Citation in `GPR_CITATION`. Cite the download date wherever the index appears.
- The workbook is read by the default XLS reader `readXlsWorkbookRows` (SheetJS `xlsx` 0.20.3). `fetchGprMonthly` downloads the file and parses the `GPR` column. A reader can still be injected for tests.
- **Dependency:** `xlsx` 0.20.3 from the SheetJS CDN (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`), declared in `packages/data/package.json`. Licence Apache-2.0. The version is the newest the CDN serves: 0.20.4 and later return 404. The npm registry only has 0.18.5 (March 2022), which is older and has publicly reported advisories, so it is not used. No advisory audit was run here. Check before launch.
- Fixture test: `SAMPLE_gpr_workbook.xlsx` (created with the same library) parses end to end through the default reader.
- **Live parse, 2026-10-24** (the real `data_gpr_export.xls`, 2,716,160 bytes, through `readXlsWorkbookRows` and `parseGprWorkbookRows`): 501 monthly rows, from 1985-01-01 (102.17) to 2026-09-01 (146.21). 2001-09-01 is 498.65 and 2022-03-01 is 318.95. The GPR column is blank before 1985 and skipped.
- The `month` column is an Excel serial (1900 date system). `GPR` is column 1.

## A10 event calendar (E, and the composition root)

- FOMC: `federalreserve.gov/monetarypolicy/fomccalendars.htm`. The decision date is the last day of each meeting. Meetings with an asterisk are SEP meetings. The fallback is `src/sources/fomc-fallback.json` (2026 and 2027, from the live page on 2026-10-24). It is used when the page cannot be read or parses to fewer than 4 meetings. **Update the fallback each year.** Month labels may be `X/Y` (for example `Apr/May`, date `30-1` = Apr 30 to May 1; a non-wrapping cell such as `28-29` stays in the first month, Apr 28 to Apr 29), and three-letter month names are accepted.
- FOMC rows that cannot be dated are failures, never carried over (R2-1). A row whose month label does not name a month, a cell that is not a day range, or a decision before its start is recorded as a failure, and the page is then rejected as partial: `fomc` is not ok, the calendar fails, and no FOMC rows are replaced. The known August "(notation vote)" row is skipped on purpose. Before any row is read, the page structure is checked: every year heading, month label and date cell must match its exact markup (a label without `<strong>`, a wrapped date cell, or a reworded year heading is a partial page, and no row from it is returned; R8-1). The structure counts select markers by class and tag, so they cannot see a renamed label or date-cell class, or a retagged heading. Five plausibility checks therefore run on the parsed list of a page of 4 or more meetings (R9-1): (a) within one start year the meetings are in increasing order, and no start date repeats; (b) in date order, consecutive meetings start 30 to 100 days apart (the live page: 41 to 56); (c) each start year that appears has 6 to 10 meetings (the live page: 8); (d) each decision is on or after its start and at most 3 days after it; (e) the page has as many hyphenated day-range date cells ("27-28", "30-May 1"), counted as bare text, as meetings parsed; a footnote number is not counted (F2). A violated check is a partial page: no rows, `fomc` not ok, and a warning names the rule. A page of fewer than 4 meetings or an unreadable page uses the fallback.
- FOMC is ok only when at least one meeting falls in the calendar window. When the fallback does not reach the window and the page is down, `fomc` is not ok and its stored rows are left alone (R2-8).
- CPI, payrolls, PCE: `GET /fred/release/dates` for release ids 10, 50 and 54, with `include_release_dates_with_no_data=true`, `order_by=release_date`, `sort_order=asc` and `limit=1000`. A `count` above the rows returned fails that release, so a partial list is never written.
- ETF decisions (spec item 4): admin JSON array of `{date, title, asset_id, source}`. The path comes from `COINSNIPE_ETF_DECISIONS_PATH` (`.env.example`). When unset, there is no admin file: the run reads no file, the etf kind is not replaced, its stored rows are kept, and the warning is `ETF decisions file is not configured: COINSNIPE_ETF_DECISIONS_PATH is not set; no ETF rows written, stored ETF rows left untouched` (F1, F2). There is no shipped default file. A configured file is read as configured; only a file that loads, including a deliberately empty `[]`, replaces the etf kind. The entry loads the file and passes it to the calendar. A missing or invalid file is a **warning**, not a failure: the etf kind is not replaced and its stored rows are left alone. A valid file with a bad entry is rejected whole by the calendar, with a warning.
- **Unlocks (E): missing.** The calendar keeps an unlock input (`unlockEntries`). CSN-026 is `todo` and has no feed yet. The composition root passes no unlock rows, so the unlock kind is not replaced. CSN-026 is the dependency.
- Window: `[today, today + 60]`. The UI shows the next 30 days.
- Store contract: `replaceCalendarWindow` replaces only the kinds that succeeded, in one transaction (F3). Inserts use `ON CONFLICT` on the market-wide partial index `events_calendar_market_wide_key` (`asset_id IS NULL`, migration 0001) and on `events_calendar_asset_id_date_kind_title_key`.

**Calendar for the next 30 days (today 2026-10-24, window 2026-10-24 to 2026-11-23).** These are the five rows `prismaMacroStore.db.test.ts` asserts after the ETF run (the R5-1 test). Read from the scratch database with `psql` on that run. Later tests in the suite change the window (the R6-7 test adds a SAMPLE row and replaces the etf kind), so the table is the state after the R5-1 run, not after the whole suite.

| Date | Kind | Title | Asset | as_of | Source |
| --- | --- | --- | --- | --- | --- |
| 2026-10-28 | fomc | FOMC rate decision | none | 2026-10-24 | federalreserve.gov |
| 2026-11-03 | etf | SAMPLE spot ETF decision date | btc | 2026-10-24 | admin:sample |
| 2026-11-06 | payrolls | US jobs report (Employment Situation) | none | 2026-10-24 | fred:release/dates |
| 2026-11-13 | cpi | US CPI inflation release | none | 2026-10-24 | fred:release/dates |
| 2026-11-20 | etf | SAMPLE second ETF decision date | none | 2026-10-24 | admin:etf-decisions |

The fixture FRED release dates are SAMPLE values. The FOMC dates are the real schedule. The next-30-day view will carry real CPI and payroll dates only after a live run with a FRED key (F).

## D3 Fear & Greed

- `https://api.alternative.me/fng/?limit=0`, one reading per UTC day. Free, API only (no page scraping).
- Attribution: `ALTERNATIVE_ME_ATTRIBUTION`, shown next to the data with a link.

## Worker wiring (D)

- **Failure rule.** The failure rule is stated once, in the FAILURE RULE of the module header of `apps/worker/src/jobs/fetchMacro.ts`. This document does not restate it.
- **Gold proxy (R5-3).** The CoinGecko gold proxy has no FRED dependency. It is fetched whatever happens to FRED. Its no-rows failure is part of the FAILURE RULE in the job header.

- `apps/worker/package.json` depends on `@coinsnipe/data` and `@coinsnipe/db` (`workspace:*`). The worker reads `@coinsnipe/db` for the Prisma client, which needs `prisma generate` and a build of `packages/db`.
- `runFetchMacroJob` (`apps/worker/src/jobs/fetchMacro.ts`) is the composition root. It builds the real adapters and the Prisma store, then runs `runFetchMacro`. It reads only the environment variables in `.env.example`: `FRED_API_KEY`, `COINGECKO_API_KEY`, `COINGECKO_PLAN`, `DATABASE_URL`, `COINSNIPE_ETF_DECISIONS_PATH`. Keys are never logged.
- `apps/worker/src/run-fetch-macro.ts` is the entry. It loads the ETF file (`src/config/etfDecisions.ts`), runs the job, prints the summary (including the `asOfRule` the run used, R5-6), and exits 1 when a source fails.
- Unknown asset ids (R6-7): an ETF or unlock row whose `asset_id` is not in the `assets` table is skipped alone, with a warning that names the id. The other rows are written. The check runs inside the calendar transaction, before any insert.
- Store: `apps/worker/src/store/prismaMacroStore.ts`. Parameterised SQL (`Prisma.sql`). Macro, Fear & Greed and GPR rows upsert on their primary keys in chunks. Calendar kinds are replaced in one transaction. Market-wide rows (asset_id NULL) and asset-scoped rows use their own `ON CONFLICT` targets (R5-5 test).
- **as_of contract (R5-6).** `macro_daily`, `fear_greed_daily`, `gpr_monthly` and `events_calendar` store `as_of` but no column says which rule wrote it. Rows are written under the configured `asOfRule`. The default is `observation-date`. Flipping to `publication-lag` between runs writes a second vintage for the same series and date, and nothing on the row shows which convention made it. Do not flip without a backfill that rewrites the series. A schema column for the rule is a db-engineer change and is not made here.
- Test order: the worker's suite needs the data and db packages built first (turbo runs `^build`).

## Licensing (CSN-071)

- **VIXCLS (G):** Cboe copyright. It is off unless `includeLicensedVix` is true. The spec lists it for A4. This is the one place where the spec and the licence conflict, and the owner's sign-off is awaited.
- FRED needs its attribution sentence next to any use: `FRED_ATTRIBUTION` (`fred.ts`).
- CoinGecko (gold proxy): `COINGECKO_ATTRIBUTION`. Demo is not a commercial licence. A paid plan and written terms are needed before launch.
- SOURCE_TERMS_VERIFIED flags are not set here. CSN-071-FOLLOWUP-2 applies them.
- FRED SP500 returns only about ten years (first observation 2016-10-24 in the live check). Flag it for the CSN-071 check of the S&P series terms.

## Config flags (`MACRO_CONFIG_DEFAULTS` in `fred.ts`)

| Flag | Default | Effect |
| --- | --- | --- |
| `startDate` | `2000-01-01` | First FRED observation date requested and first day written |
| `includeLicensedVix` | `false` | Fetches VIXCLS (G: CSN-071, no licence yet) |
| `asOfRule` | `observation-date` | Spec rule (A). `publication-lag` is the opt-in alternative; it governs FRED, the composite, the gold proxy, Fear & Greed and GPR alike |
| `publicationLagDays` | table above | Lag in days per series key, used only under `publication-lag`. A missing key fails that series with a warning |
| `a7Gold.enabled` | `true` | Gold proxy from CoinGecko |
| `a7Gold.days` | `365` | CoinGecko history window (Demo limit) |
| `monthlyMaxFillDays` | `62` | Forward-fill cap for monthly series; also the stale threshold for A8 |
| `fxMaxFillDays` | `7` | Forward-fill cap for FX in the composite |
| `a8PlausibleUsdBnRange` | `[100, 500000]` | Unit check per A8 area |
| `a8ExcludeAreas` | `[]` | Drops areas from A8 (changes the meaning; see above) |

## Live smoke and missing runs

Offline (CI) runs the fixture tests (`SAMPLE_*` fixtures in `src/__fixtures__/`), and the scratch-database test when `DATABASE_URL` names a scratch database. The live block runs when `COINSNIPE_LIVE_SMOKE=1`.

```
COINSNIPE_LIVE_SMOKE=1 pnpm --filter @coinsnipe/data test -- macro
```

- No key needed: alternative.me, the federalreserve.gov FOMC page, CoinGecko's public route. These passed on 2026-10-24.
- **F, missing:** the FRED leg needs `FRED_API_KEY`, exported in the shell from a secret store (never inline it in a command). It has not been run here. The gated test is kept.
- **H, missing:** the chart comparison (see A8).
- **E, missing:** the unlock feed (CSN-026).

## Scratch-database test

The guard (`src/store/scratchTarget.ts`) is fail closed (R5-7). The suite truncates four tables, so it runs only when `DATABASE_URL` passes every check: scheme postgres; host `127.0.0.1` or `localhost`; port 5432 or 55432; database name `coinsnipe_csn_024_<slug>_<hash8>_test`; and the name equals `CSN024_SCRATCH_DB_NAME`, the database the operator created for this run. Any other target fails the suite, it is not skipped. Unit tests of the guard run without a database.

`apps/worker/src/store/prismaMacroStore.db.test.ts` runs the whole job against Postgres. It runs only when the guard above accepts `DATABASE_URL` together with `CSN024_SCRATCH_DB_NAME`. Create one with `scripts/scratch-test-db.sh create CSN-024-impl --board coinsnipe`, then apply migrations to it and run `DATABASE_URL=<url> CSN024_SCRATCH_DB_NAME=<name> pnpm --filter @coinsnipe/worker test`. The shared test database is never used. The test serves the SAMPLE fixtures for every HTTP call.
