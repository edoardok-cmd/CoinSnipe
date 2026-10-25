/**
 * fetchMacro (CSN-024): daily job for the macro and sentiment inputs. Writes macro_daily,
 * fear_greed_daily, gpr_monthly and events_calendar (A4, A6, A7, A8, A9, A10, D3).
 *
 * Two layers:
 * - runFetchMacro: the job logic. Sources and store are injected, so tests run it with fakes.
 * - runFetchMacroJob: the real composition root. It builds the real adapters from @coinsnipe/data
 *   and the Prisma store from ../store/prismaMacroStore. The entry in ../run-fetch-macro.ts calls it.
 *
 * Each source runs on its own: a failure in one is reported and does not stop the others.
 *
 * FAILURE RULE (the single statement; the methodology and the JSDoc below point here):
 *   - macro fails when: FRED_API_KEY is unset; or no FRED series answered (every series request failed);
 *     or the FRED fetch itself throws; or the gold proxy (enabled in config) returns no rows, or its
 *     fetch throws; or no macro row was fetched at all (FRED and gold both empty, which needs the gold
 *     proxy disabled in config). R8-2.
 *   - any source (macro, feargreed, gpr, calendar) also fails when its fetch or its store write throws
 *     with an error the source did not handle.
 *   - calendar fails when FRED_API_KEY is unset, when every FRED release-date request failed, or when
 *     FOMC is not ok (a partial page, or no FOMC meeting in the window; R2-1, R2-8). The FOMC rows are
 *     still written when the key is unset, because they do not need it. A FOMC that is not ok is not
 *     replaced: its stored rows are left alone.
 *   - a partial FRED series failure (some series answered) is only a warning that names the failed
 *     series. The source stays ok (R6-3, R7-3).
 *   - a failed source still writes the rows it fetched. The job is ok only when every source is ok, and
 *     the entry exits 1 otherwise (R5-2, R6-1, R7-2).
 *
 * Not configured or invalid inputs are warnings, not failures: a missing ETF file leaves the etf kind
 * not replaced, and its stored rows untouched.
 *
 * Write semantics: macro_daily, fear_greed_daily and gpr_monthly upsert on their primary keys, so a
 * re-run for the same day is safe. events_calendar is replaced per kind over the window: only the
 * kinds whose source succeeded are deleted and re-inserted, in one transaction. Rows of a failed or
 * unconfigured kind are never touched (CSN-024 F3).
 */
import {
  type A10CalendarResult,
  type CalendarKind,
  type CalendarRow,
  type CoinGeckoPlan,
  fetchA10Calendar,
  fetchA7GoldProxy,
  fetchD3FearGreed,
  fetchFredMacroRows,
  fetchGprMonthly,
  type FearGreedRow,
  type GprMonthlyRow,
  type MacroDailyRow,
  MACRO_CONFIG_DEFAULTS,
  type A8Status,
  type MacroSourceConfig,
} from '@coinsnipe/data';
import type { PrismaClient } from '@coinsnipe/db';
import { createPrismaMacroStore } from '../store/prismaMacroStore';
import type { EtfDecisionsInput } from '../config/etfDecisions';

export const FETCH_MACRO_JOB = 'fetchMacro' as const;

/** Record shapes come from the data package, so the job and the adapters cannot drift apart. */
export type { CalendarKind };
export type MacroDailyRecord = MacroDailyRow;
export type FearGreedRecord = FearGreedRow;
export type GprRecord = GprMonthlyRow;
export type CalendarRecord = CalendarRow;

export interface WarnedRows<T> {
  readonly rows: T[];
  readonly warnings: string[];
}

/** A8 composite status from the adapter (F1). The job reports a stale composite as a warning. */
export type A8StatusRecord = A8Status;

/** macroDaily result: rows, warnings, the A8 status and, when the source failed, why (R5-2). */
export interface MacroDailyFetch extends WarnedRows<MacroDailyRecord> {
  readonly a8?: A8StatusRecord | undefined;
  /** Set when the source failed. Rows that were fetched are still written. */
  readonly failed?: string | undefined;
}

/** What the calendar source returns: its window, its rows and the kinds it succeeded for. */
export interface CalendarSourceResult {
  /** Window start, YYYY-MM-DD (UTC). */
  readonly from: string;
  /** Window end, inclusive. */
  readonly to: string;
  readonly rows: CalendarRecord[];
  readonly warnings: string[];
  /** Kinds whose source succeeded this run. Only these may be replaced in the store. */
  readonly kindsOk: readonly CalendarKind[];
  /** Set when the source failed (for example every FRED release-date request failed). */
  readonly failed?: string | undefined;
}

export interface MacroSources {
  /** A4, A6, A7 and A8 (FRED series, the A8 composite and the A7 gold proxy). */
  macroDaily(today: string): Promise<MacroDailyFetch>;
  /** D3 (alternative.me). */
  fearGreed(): Promise<FearGreedRecord[]>;
  /** A9 (GPR monthly workbook). */
  gpr(): Promise<GprRecord[]>;
  /** A10 (FOMC, FRED release dates, the admin ETF file and CSN-026 unlocks). */
  calendar(today: string): Promise<CalendarSourceResult>;
}

export interface CalendarReplacement {
  readonly from: string;
  readonly to: string;
  /** Only rows of these kinds are deleted in [from, to] and then inserted. */
  readonly kinds: readonly CalendarKind[];
  /** Every row here must have a kind listed in `kinds`. */
  readonly rows: readonly CalendarRecord[];
}

export interface MacroStore {
  upsertMacroDaily(rows: readonly MacroDailyRecord[]): Promise<number>;
  upsertFearGreed(rows: readonly FearGreedRecord[]): Promise<number>;
  upsertGpr(rows: readonly GprRecord[]): Promise<number>;
  /**
   * Within ONE transaction: delete events_calendar rows with date in [from, to] and kind in `kinds`
   * (any asset_id), then insert `rows`. Other kinds are never touched. Replacement is used instead
   * of plain upsert so that withdrawn events disappear. The inserts respect the two unique indexes:
   * events_calendar_market_wide_key (asset_id IS NULL) and the (asset_id, date, kind, title) key.
   */
  replaceCalendarWindow(input: CalendarReplacement): Promise<CalendarWriteResult>;
}

/** What the calendar write did: rows written, and warnings for rows it had to skip (R6-7). */
export interface CalendarWriteResult {
  readonly written: number;
  readonly warnings: string[];
}

export interface SourceReport {
  readonly name: 'macro' | 'feargreed' | 'gpr' | 'calendar';
  readonly status: 'ok' | 'failed';
  readonly written: number;
  readonly warnings: string[];
  /** Error message only (never a URL or a key). */
  readonly error?: string | undefined;
}

export interface FetchMacroReport {
  readonly job: typeof FETCH_MACRO_JOB;
  readonly today: string;
  readonly ok: boolean;
  readonly sources: SourceReport[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/**
 * Run every macro source and write what it returns. `today` is a UTC date, YYYY-MM-DD.
 * The report says what each source wrote. `ok` is false if any source failed.
 */
export async function runFetchMacro(input: {
  readonly today: string;
  readonly sources: MacroSources;
  readonly store: MacroStore;
  readonly log?: ((line: string) => void) | undefined;
}): Promise<FetchMacroReport> {
  const log = input.log ?? (() => undefined);
  const reports: SourceReport[] = [];

  const attempt = async (
    name: SourceReport['name'],
    run: () => Promise<{ written: number; warnings: string[]; failed?: string | undefined }>,
  ): Promise<void> => {
    try {
      const outcome = await run();
      for (const warning of outcome.warnings) log(`${FETCH_MACRO_JOB} ${name} warning: ${warning}`);
      if (outcome.failed) {
        log(`${FETCH_MACRO_JOB} ${name} failed: ${outcome.failed} (written=${outcome.written})`);
        reports.push({
          name,
          status: 'failed',
          written: outcome.written,
          warnings: outcome.warnings,
          error: outcome.failed,
        });
        return;
      }
      log(`${FETCH_MACRO_JOB} ${name} ok written=${outcome.written}`);
      reports.push({ name, status: 'ok', written: outcome.written, warnings: outcome.warnings });
    } catch (error) {
      const message = messageOf(error);
      log(`${FETCH_MACRO_JOB} ${name} failed: ${message}`);
      reports.push({ name, status: 'failed', written: 0, warnings: [], error: message });
    }
  };

  await attempt('macro', async () => {
    const fetched = await input.sources.macroDaily(input.today);
    const written = await input.store.upsertMacroDaily(fetched.rows);
    const warnings = [...fetched.warnings];
    // F1: a stale composite is reported with its last complete date, never reported as current.
    if (fetched.a8?.stale) {
      const last = fetched.a8.lastCompleteDate ?? 'none';
      warnings.push(
        `A8 global M2 approximation is stale: last complete date ${last}; the composite has no current source (CSN-024-FOLLOWUP-2)`,
      );
    }
    return { written, warnings, failed: fetched.failed };
  });

  await attempt('feargreed', async () => {
    const rows = await input.sources.fearGreed();
    const written = await input.store.upsertFearGreed(rows);
    return { written, warnings: [] };
  });

  await attempt('gpr', async () => {
    const rows = await input.sources.gpr();
    const written = await input.store.upsertGpr(rows);
    return { written, warnings: [] };
  });

  await attempt('calendar', async () => {
    const fetched = await input.sources.calendar(input.today);
    const allowed = new Set<CalendarKind>(fetched.kindsOk);
    // Refuse rows of a kind whose source did not succeed: they could not be replaced safely.
    const stray = fetched.rows.find((row) => !allowed.has(row.kind));
    if (stray) {
      throw new Error(`calendar row of kind ${stray.kind} is not in kindsOk; nothing written`);
    }
    if (fetched.kindsOk.length === 0) {
      return {
        written: 0,
        warnings: [...fetched.warnings, 'no calendar kind succeeded; stored rows left untouched'],
        failed: fetched.failed,
      };
    }
    const outcome = await input.store.replaceCalendarWindow({
      from: fetched.from,
      to: fetched.to,
      kinds: fetched.kindsOk,
      rows: fetched.rows,
    });
    return {
      written: outcome.written,
      warnings: [...fetched.warnings, ...outcome.warnings],
      failed: fetched.failed,
    };
  });

  return {
    job: FETCH_MACRO_JOB,
    today: input.today,
    ok: reports.every((r) => r.status === 'ok'),
    sources: reports,
  };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

function coinGeckoPlanFrom(value: string | undefined): CoinGeckoPlan | undefined {
  return value === 'demo' || value === 'basic' || value === 'analyst' ? value : undefined;
}

/**
 * The real adapters, wired to environment variables from .env.example. Keys are read here and passed
 * to the adapters; they are never logged.
 *
 * - The failure rule for FRED, the calendar and the gold proxy is stated once, in the FAILURE RULE of
 *   the module header. This function does not restate it.
 * - ETF (spec item 4): passed to the calendar only when the admin file loaded. Otherwise a warning
 *   is emitted and the etf kind stays out of kindsOk, so its stored rows are left alone (R5-1).
 * - Unlocks (CSN-026): not configured; the unlock kind stays out of kindsOk.
 */
export function realMacroSources(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: Fetch,
  config: MacroSourceConfig = MACRO_CONFIG_DEFAULTS,
  etf: EtfDecisionsInput | undefined = undefined,
): MacroSources {
  const plan = coinGeckoPlanFrom(env['COINGECKO_PLAN']);
  const fredKey = env['FRED_API_KEY'];
  return {
    async macroDaily(today): Promise<MacroDailyFetch> {
      const warnings: string[] = [];
      let failed: string | undefined;
      let fredRows: MacroDailyRow[] = [];
      let a8: A8Status | undefined;
      if (!fredKey) {
        failed = 'FRED_API_KEY is not set';
        warnings.push('FRED_API_KEY is not set: no FRED series fetched');
      } else {
        try {
          const fred = await fetchFredMacroRows({ apiKey: fredKey, to: today, config, fetchImpl });
          fredRows = [...fred.rows];
          warnings.push(...fred.warnings);
          a8 = fred.a8;
          if (fred.seriesOk === 0) failed = 'every FRED series request failed';
        } catch (error) {
          failed = messageOf(error);
          warnings.push(failed);
        }
      }
      // R5-3: the gold proxy is independent of the FRED key.
      let goldRows: MacroDailyRow[] = [];
      try {
        const gold = await fetchA7GoldProxy({
          config,
          from: config.startDate,
          to: today,
          plan,
          apiKey: env['COINGECKO_API_KEY'],
          fetchImpl,
        });
        goldRows = [...gold.rows];
        warnings.push(...gold.warnings);
      } catch (error) {
        warnings.push(`A7 gold proxy failed: ${messageOf(error)}`);
      }
      // R6-1: a gold proxy that returns no rows (both coins failed) is a failed source, named in its warning.
      if (config.a7Gold.enabled && goldRows.length === 0) {
        warnings.push(
          `A7 gold proxy (CoinGecko ${config.a7Gold.coinIds.join(', ')}): no rows fetched; gold stops updating`,
        );
        failed = failed ?? 'no gold proxy rows were fetched';
      }
      if (failed === undefined && fredRows.length === 0 && goldRows.length === 0) {
        failed = 'no macro rows were fetched';
      }
      return { rows: [...fredRows, ...goldRows], warnings, a8, failed };
    },
    fearGreed: () => fetchD3FearGreed({ fetchImpl, config }),
    gpr: () => fetchGprMonthly({ fetchImpl, config }),
    async calendar(today): Promise<CalendarSourceResult> {
      const warnings: string[] = [];
      let failed: string | undefined;
      if (!fredKey) failed = 'FRED_API_KEY is not set';
      const etfJson = etf?.status === 'loaded' ? etf.json : undefined;
      if (etf?.status !== 'loaded') {
        warnings.push(
          etf?.status === 'unavailable'
            ? etf.warning
            : 'ETF decisions input not supplied: no ETF rows written, stored ETF rows left untouched',
        );
      }
      const result: A10CalendarResult = await fetchA10Calendar({
        today,
        fetchImpl,
        fredApiKey: fredKey,
        etfDecisionsJson: etfJson,
      });
      // R5-2: every FRED release-date request failing is a failed source.
      if (result.releasesRequested > 0 && result.releasesOk === 0) {
        failed = failed ?? 'every FRED release-date request failed';
      }
      // R2-1, R2-8: FOMC not ok (partial page, or no FOMC meeting in the window) fails the calendar.
      if (result.fomcFailure) {
        failed = failed ?? `FOMC not ok: ${result.fomcFailure}`;
      }
      return {
        from: result.from,
        to: result.to,
        rows: [...result.rows],
        warnings: [...warnings, ...result.warnings],
        kindsOk: result.kindsOk,
        failed,
      };
    },
  };
}

export interface FetchMacroJobOptions {
  /** A connected or lazily connecting Prisma client from @coinsnipe/db. */
  readonly prisma: PrismaClient;
  /** Environment (process.env in production). Only the variables named in .env.example are read. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** UTC day to fetch for, YYYY-MM-DD. Defaults to today. */
  readonly today?: string | undefined;
  /** Injected HTTP for tests. Defaults to the global fetch. */
  readonly fetchImpl?: Fetch | undefined;
  /** The ETF admin file, loaded by the entry (config/etfDecisions). Absent means not configured. */
  readonly etfDecisions?: EtfDecisionsInput | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

/**
 * Composition root for the daily job: real adapters, the Prisma store, and runFetchMacro.
 * The caller decides what to do with report.ok (the entry exits non-zero when it is false).
 */
export async function runFetchMacroJob(options: FetchMacroJobOptions): Promise<FetchMacroReport> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const fetchImpl: Fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  return runFetchMacro({
    today,
    sources: realMacroSources(options.env, fetchImpl, MACRO_CONFIG_DEFAULTS, options.etfDecisions),
    store: createPrismaMacroStore(options.prisma),
    log: options.log,
  });
}
