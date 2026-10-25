/**
 * Composition-level tests of the daily job (CSN-024 R5-1, R5-2, R5-3). They run the real adapters
 * and the real realMacroSources wiring against the SAMPLE fixture router, with a recording store.
 * No database and no vendor. The DB end-to-end test is in store/prismaMacroStore.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { ETF_DECISIONS_ENV, loadEtfDecisions } from '../config/etfDecisions';
import { FIXTURES, fixtureBytes, fixtureRouter } from '../testing/fixtureRouter';
import {
  type CalendarReplacement,
  type FetchMacroReport,
  type MacroStore,
  realMacroSources,
  runFetchMacro,
} from './fetchMacro';
import { MACRO_CONFIG_DEFAULTS } from '@coinsnipe/data';

const TODAY = '2026-10-24';

function recordingStore(): {
  store: MacroStore;
  macroSeries: string[];
  calendar: CalendarReplacement[];
} {
  const macroSeries: string[] = [];
  const calendar: CalendarReplacement[] = [];
  const store: MacroStore = {
    async upsertMacroDaily(rows) {
      for (const row of rows) macroSeries.push(row.seriesId);
      return rows.length;
    },
    async upsertFearGreed(rows) {
      return rows.length;
    },
    async upsertGpr(rows) {
      return rows.length;
    },
    async replaceCalendarWindow(input) {
      calendar.push(input);
      return { written: input.rows.length, warnings: [] };
    },
  };
  return { store, macroSeries, calendar };
}

async function runWith(options: {
  today?: string | undefined;
  env: Record<string, string | undefined>;
  router: ReturnType<typeof fixtureRouter>;
  etf?: ReturnType<typeof loadEtfDecisions>;
  store: MacroStore;
  log?: (line: string) => void;
}): Promise<FetchMacroReport> {
  return runFetchMacro({
    today: options.today ?? TODAY,
    sources: realMacroSources(options.env, options.router, MACRO_CONFIG_DEFAULTS, options.etf),
    store: options.store,
    log: options.log,
  });
}

const ETF_LOADED = loadEtfDecisions({
  [ETF_DECISIONS_ENV]: `${FIXTURES}SAMPLE_etf_decisions.json`,
});
const ETF_MISSING = loadEtfDecisions({
  [ETF_DECISIONS_ENV]: `${FIXTURES}SAMPLE_etf_decisions_missing.json`,
});
const KEY = { FRED_API_KEY: 'SAMPLE-FRED-KEY-NOT-REAL' };

describe('fetchMacro composition (R5-1, R5-2, R5-3)', () => {
  it('a healthy run is ok, and the ETF file (loaded) is replaced in the calendar with its kind', async () => {
    const { store, calendar } = recordingStore();
    const report = await runWith({ env: KEY, router: fixtureRouter(), etf: ETF_LOADED, store });
    expect(report.ok, JSON.stringify(report.sources)).toBe(true);
    const replacement = calendar[0];
    expect(replacement?.kinds).toContain('etf');
    const etfRows = replacement?.rows.filter((r) => r.kind === 'etf') ?? [];
    expect(etfRows.map((r) => r.date)).toEqual(['2026-11-03', '2026-11-20']);
    expect(etfRows.map((r) => r.assetId)).toEqual(['btc', null]);
  });

  it('R5-1: with the ETF file absent, a warning is emitted and the etf kind is not replaced', async () => {
    const { store, calendar } = recordingStore();
    const report = await runWith({ env: KEY, router: fixtureRouter(), etf: ETF_MISSING, store });
    expect(report.ok).toBe(true);
    const calendarSource = report.sources.find((s) => s.name === 'calendar');
    expect(calendarSource?.warnings.join(' ')).toContain('ETF decisions file not readable');
    expect(calendar[0]?.kinds).not.toContain('etf');
    expect(calendar[0]?.rows.some((r) => r.kind === 'etf')).toBe(false);
  });

  it('R5-1: with no ETF input supplied at all, the same warning and the same skip apply', async () => {
    const { store, calendar } = recordingStore();
    const report = await runWith({ env: KEY, router: fixtureRouter(), store });
    expect(report.sources.find((s) => s.name === 'calendar')?.warnings.join(' ')).toContain(
      'ETF decisions input not supplied',
    );
    expect(calendar[0]?.kinds).not.toContain('etf');
  });

  it('F1: with COINSNIPE_ETF_DECISIONS_PATH unset, the etf kind is not replaced and the warning names the unset config', async () => {
    const { store, calendar } = recordingStore();
    const report = await runWith({ env: KEY, router: fixtureRouter(), etf: loadEtfDecisions({}), store });
    expect(report.ok).toBe(true);
    const calendarSource = report.sources.find((s) => s.name === 'calendar');
    expect(calendarSource?.warnings.join(' ')).toContain('COINSNIPE_ETF_DECISIONS_PATH is not set');
    expect(calendar[0]?.kinds).not.toContain('etf');
    expect(calendar[0]?.rows.some((r) => r.kind === 'etf')).toBe(false);
  });

  it('F1 control: a configured file that holds a deliberately empty list replaces the etf kind with zero etf rows', async () => {
    const { store, calendar } = recordingStore();
    const empty = loadEtfDecisions({
      [ETF_DECISIONS_ENV]: `${FIXTURES}SAMPLE_etf_decisions_empty.json`,
    });
    await runWith({ env: KEY, router: fixtureRouter(), etf: empty, store });
    expect(calendar[0]?.kinds).toContain('etf');
    expect(calendar[0]?.rows.filter((r) => r.kind === 'etf')).toEqual([]);
  });

  it('R5-2: every FRED series and every FRED release-date request rejected: the job is not ok, with a warning per failed source', async () => {
    const { store, macroSeries, calendar } = recordingStore();
    const report = await runWith({
      env: KEY,
      router: fixtureRouter({ rejectAllFredSeries: true, rejectAllFredReleases: true }),
      etf: ETF_LOADED,
      store,
    });
    expect(report.ok).toBe(false);
    const macro = report.sources.find((s) => s.name === 'macro');
    expect(macro?.status).toBe('failed');
    expect(macro?.error).toBe('every FRED series request failed');
    // One warning per failed FRED series request (VIXCLS is skipped by config, not requested).
    expect(macro?.warnings.filter((w) => w.includes('HTTP 400')).length).toBeGreaterThanOrEqual(13);
    // The gold proxy still arrived, and the rows fetched before the failure are written.
    expect(macroSeries.length).toBeGreaterThan(0);
    expect(macroSeries.every((id) => id === 'A7_GOLD_PROXY_USD')).toBe(true);
    const calendarSource = report.sources.find((s) => s.name === 'calendar');
    expect(calendarSource?.status).toBe('failed');
    expect(calendarSource?.error).toBe('every FRED release-date request failed');
    // FOMC does not depend on the FRED key and is still written.
    expect(calendar[0]?.kinds).toContain('fomc');
    expect(report.sources.find((s) => s.name === 'feargreed')?.status).toBe('ok');
    expect(report.sources.find((s) => s.name === 'gpr')?.status).toBe('ok');
  });

  it('R8-1 end to end: a 2027 January label without <strong> makes the job not ok and stores no FOMC row', async () => {
    const { store, calendar } = recordingStore();
    const excerpt = fixtureBytes('SAMPLE_fomc_calendar_excerpt.html').toString();
    const first = excerpt.indexOf('<strong>January</strong>');
    const second = excerpt.indexOf('<strong>January</strong>', first + 1);
    const changed =
      excerpt.slice(0, second) +
      '<span>January</span>' +
      excerpt.slice(second + '<strong>January</strong>'.length);
    const report = await runWith({
      today: '2027-01-20',
      env: KEY,
      router: fixtureRouter({ fomcHtml: changed }),
      etf: ETF_LOADED,
      store,
    });
    expect(report.ok).toBe(false);
    const calendarSource = report.sources.find((s) => s.name === 'calendar');
    expect(calendarSource?.status).toBe('failed');
    expect(calendarSource?.error).toContain('FOMC not ok');
    expect(calendar[0]?.kinds).not.toContain('fomc');
    expect(calendar[0]?.rows.some((r) => r.kind === 'fomc')).toBe(false);
  });

  it('R2-8: the FOMC page is down and the fallback no longer reaches the window: calendar is failed, fomc is not replaced', async () => {
    const { store, calendar } = recordingStore();
    const report = await runWith({
      today: '2027-12-15',
      env: KEY,
      router: fixtureRouter({ failFomcPage: true }),
      etf: ETF_LOADED,
      store,
    });
    expect(report.ok).toBe(false);
    const calendarSource = report.sources.find((s) => s.name === 'calendar');
    expect(calendarSource?.status).toBe('failed');
    expect(calendarSource?.error).toContain('FOMC not ok');
    expect(calendar[0]?.kinds).not.toContain('fomc');
    expect(calendar[0]?.rows.some((r) => r.kind === 'fomc')).toBe(false);
  });

  it('R2-1: a partial FOMC page (an unmatched label) fails the calendar; fomc is not replaced', async () => {
    const { store, calendar } = recordingStore();
    const excerpt = fixtureBytes('SAMPLE_fomc_calendar_excerpt.html').toString();
    const report = await runWith({
      env: KEY,
      router: fixtureRouter({
        fomcHtml: excerpt.replace('<strong>October</strong>', '<strong>Octobr</strong>'),
      }),
      etf: ETF_LOADED,
      store,
    });
    expect(report.ok).toBe(false);
    const calendarSource = report.sources.find((s) => s.name === 'calendar');
    expect(calendarSource?.status).toBe('failed');
    expect(calendarSource?.error).toContain('partial');
    expect(calendar[0]?.kinds).not.toContain('fomc');
    expect(calendarSource?.warnings.join(' ')).toContain('Octobr');
  });

  it('R7-3: one failing FRED series: the macro source stays ok, the job is ok, and the warning names the failed series', async () => {
    const { store, macroSeries } = recordingStore();
    const report = await runWith({
      env: KEY,
      router: fixtureRouter({ failFredSeries: ['DGS10'] }),
      etf: ETF_LOADED,
      store,
    });
    expect(report.ok, JSON.stringify(report.sources)).toBe(true);
    const macro = report.sources.find((s) => s.name === 'macro');
    expect(macro?.status).toBe('ok');
    expect(macro?.warnings.join(' ')).toContain('fred:DGS10: HTTP 400');
    // The failed series writes nothing; the healthy series are written.
    expect(macroSeries.includes('DGS10')).toBe(false);
    expect(macroSeries.includes('NASDAQCOM')).toBe(true);
  });

  it('R6-1: both gold coins rejected with FRED healthy: the macro source fails, the job is not ok, the warning names the gold source', async () => {
    const { store, macroSeries } = recordingStore();
    const report = await runWith({
      env: KEY,
      router: fixtureRouter({ rejectAllCoinGecko: true }),
      etf: ETF_LOADED,
      store,
    });
    expect(report.ok).toBe(false);
    const macro = report.sources.find((s) => s.name === 'macro');
    expect(macro?.status).toBe('failed');
    expect(macro?.error).toBe('no gold proxy rows were fetched');
    expect(macro?.warnings.join(' ')).toContain('A7 gold proxy (CoinGecko pax-gold, tether-gold)');
    // FRED rows are still written; no gold rows are.
    expect(macroSeries.length).toBeGreaterThan(0);
    expect(macroSeries.some((id) => id === 'A7_GOLD_PROXY_USD')).toBe(false);
  });

  it('R5-3: with no FRED_API_KEY, FRED is never called, the gold proxy is still fetched and written, and the job is not ok', async () => {
    const { store, macroSeries } = recordingStore();
    const calls: string[] = [];
    const report = await runWith({
      env: {},
      router: fixtureRouter({ calls }),
      etf: ETF_LOADED,
      store,
    });
    expect(calls.some((u) => new URL(u).hostname === 'api.stlouisfed.org')).toBe(false);
    expect(calls.some((u) => new URL(u).hostname === 'api.coingecko.com')).toBe(true);
    expect(macroSeries.length).toBeGreaterThan(0);
    expect(macroSeries.every((id) => id === 'A7_GOLD_PROXY_USD')).toBe(true);
    const macro = report.sources.find((s) => s.name === 'macro');
    expect(macro?.error).toBe('FRED_API_KEY is not set');
    expect(macro?.warnings.join(' ')).toContain('FRED_API_KEY is not set');
    expect(report.ok).toBe(false);
  });
});
