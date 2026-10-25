import { describe, expect, it } from 'vitest';
import {
  type CalendarRecord,
  type CalendarSourceResult,
  type FearGreedRecord,
  type GprRecord,
  type MacroDailyRecord,
  type MacroSources,
  type MacroStore,
  runFetchMacro,
} from './fetchMacro';

const TODAY = '2026-10-24';
const WINDOW_END = '2026-12-23';

const macroRow: MacroDailyRecord = {
  seriesId: 'A8_GLOBAL_M2_APPROX',
  date: TODAY,
  value: 92650,
  asOf: TODAY,
  source: 'approximation:fred',
};
const fngRow: FearGreedRecord = {
  date: TODAY,
  value: 33,
  classification: 'Fear',
  asOf: TODAY,
  source: 'alternative.me',
};
const gprRow: GprRecord = {
  month: '2026-09-01',
  gpr: 120,
  asOf: '2026-09-01',
  source: 'matteoiacoviello.com',
};
const fomcRow: CalendarRecord = {
  date: '2026-10-28',
  kind: 'fomc',
  title: 'FOMC rate decision',
  assetId: null,
  asOf: TODAY,
  source: 'federalreserve.gov',
};
const cpiRow: CalendarRecord = {
  date: '2026-11-13',
  kind: 'cpi',
  title: 'US CPI inflation release',
  assetId: null,
  asOf: TODAY,
  source: 'fred:release/dates',
};
const pceRow: CalendarRecord = {
  date: '2026-11-26',
  kind: 'pce',
  title: 'US PCE inflation release (Personal Income and Outlays)',
  assetId: null,
  asOf: TODAY,
  source: 'fred:release/dates',
};

function calendarResult(overrides: Partial<CalendarSourceResult> = {}): CalendarSourceResult {
  return {
    from: TODAY,
    to: WINDOW_END,
    rows: [fomcRow],
    warnings: [],
    kindsOk: ['fomc'],
    ...overrides,
  };
}

interface StoreCall {
  method: string;
  args: unknown[];
}

/** In-memory store double. Records every call and returns the number of rows it was given. */
function recordingStore(failOn?: keyof MacroStore): { store: MacroStore; calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  const countOf = (arg: unknown): number => {
    if (Array.isArray(arg)) return arg.length;
    if (arg && typeof arg === 'object' && 'rows' in arg && Array.isArray(arg.rows)) {
      return arg.rows.length;
    }
    return 0;
  };
  const record =
    (method: keyof MacroStore) =>
    async (...args: unknown[]): Promise<number> => {
      calls.push({ method, args });
      if (failOn === method) throw new Error('store unavailable');
      return countOf(args[0]);
    };
  const store: MacroStore = {
    upsertMacroDaily: record('upsertMacroDaily') as MacroStore['upsertMacroDaily'],
    upsertFearGreed: record('upsertFearGreed') as MacroStore['upsertFearGreed'],
    upsertGpr: record('upsertGpr') as MacroStore['upsertGpr'],
    replaceCalendarWindow: async (...args: unknown[]) => ({
      written: await record('replaceCalendarWindow')(...args),
      warnings: [],
    }),
  };
  return { store, calls };
}

function sources(overrides: Partial<MacroSources> = {}): MacroSources {
  return {
    macroDaily: async () => ({
      rows: [macroRow],
      warnings: ['VIXCLS: not fetched, licensed series'],
    }),
    fearGreed: async () => [fngRow],
    gpr: async () => [gprRow],
    calendar: async () => calendarResult(),
    ...overrides,
  };
}

function replacementCall(calls: StoreCall[]): unknown {
  return calls.find((c) => c.method === 'replaceCalendarWindow')?.args[0];
}

describe('fetchMacro job (CSN-024)', () => {
  it('writes every source once, with the rows it returned, and reports ok', async () => {
    const { store, calls } = recordingStore();
    const report = await runFetchMacro({ today: TODAY, sources: sources(), store });

    expect(report.ok).toBe(true);
    expect(report.sources.map((s) => [s.name, s.status, s.written])).toEqual([
      ['macro', 'ok', 1],
      ['feargreed', 'ok', 1],
      ['gpr', 'ok', 1],
      ['calendar', 'ok', 1],
    ]);
    expect(calls.map((c) => c.method)).toEqual([
      'upsertMacroDaily',
      'upsertFearGreed',
      'upsertGpr',
      'replaceCalendarWindow',
    ]);
    expect(calls[0]?.args[0]).toEqual([macroRow]);
  });

  it('passes the adapter window and the kinds that succeeded to the store', async () => {
    const { store, calls } = recordingStore();
    await runFetchMacro({ today: TODAY, sources: sources(), store });
    expect(replacementCall(calls)).toEqual({
      from: '2026-10-24',
      to: '2026-12-23',
      kinds: ['fomc'],
      rows: [fomcRow],
    });
  });

  it('F3: a failed PCE release leaves PCE rows untouched (pce is not replaced)', async () => {
    const { store, calls } = recordingStore();
    const report = await runFetchMacro({
      today: TODAY,
      sources: sources({
        // FRED release 54 failed: the adapter reports no pce kind and no pce rows.
        calendar: async () =>
          calendarResult({
            rows: [fomcRow, cpiRow],
            warnings: ['fred:release/dates:54: HTTP 503'],
            kindsOk: ['fomc', 'cpi', 'payrolls'],
          }),
      }),
      store,
    });

    const call = replacementCall(calls) as { kinds: string[]; rows: CalendarRecord[] };
    expect(call.kinds).not.toContain('pce');
    expect(call.kinds).toEqual(['fomc', 'cpi', 'payrolls']);
    expect(call.rows.some((r) => r.kind === 'pce')).toBe(false);
    expect(report.sources.find((s) => s.name === 'calendar')?.warnings).toEqual([
      'fred:release/dates:54: HTTP 503',
    ]);
  });

  it('F3: a row whose kind did not succeed is refused, and the store is not called', async () => {
    const { store, calls } = recordingStore();
    const report = await runFetchMacro({
      today: TODAY,
      sources: sources({
        calendar: async () => calendarResult({ rows: [fomcRow, pceRow], kindsOk: ['fomc'] }),
      }),
      store,
    });
    expect(calls.map((c) => c.method)).not.toContain('replaceCalendarWindow');
    const calendar = report.sources.find((s) => s.name === 'calendar');
    expect(calendar?.status).toBe('failed');
    expect(calendar?.error).toContain('pce');
  });

  it('F3: when no kind succeeded, nothing is replaced and the job says so', async () => {
    const { store, calls } = recordingStore();
    const report = await runFetchMacro({
      today: TODAY,
      sources: sources({
        calendar: async () => calendarResult({ rows: [], kindsOk: [] }),
      }),
      store,
    });
    expect(calls.map((c) => c.method)).not.toContain('replaceCalendarWindow');
    expect(report.sources.find((s) => s.name === 'calendar')?.warnings.join(' ')).toContain(
      'stored rows left untouched',
    );
  });

  it('one failing source does not stop the others, and the report names it', async () => {
    const { store, calls } = recordingStore();
    const report = await runFetchMacro({
      today: TODAY,
      sources: sources({
        fearGreed: async () => {
          throw new Error('alternative.me: HTTP 503');
        },
      }),
      store,
    });

    expect(report.ok).toBe(false);
    const fng = report.sources.find((s) => s.name === 'feargreed');
    expect(fng?.status).toBe('failed');
    expect(fng?.error).toBe('alternative.me: HTTP 503');
    expect(calls.map((c) => c.method)).not.toContain('upsertFearGreed');
    expect(calls.map((c) => c.method)).toContain('replaceCalendarWindow');
    expect(report.sources.filter((s) => s.status === 'ok')).toHaveLength(3);
  });

  it('a store failure is reported as that source failing, not as a crash', async () => {
    const { store } = recordingStore('upsertGpr');
    const report = await runFetchMacro({ today: TODAY, sources: sources(), store });
    expect(report.ok).toBe(false);
    expect(report.sources.find((s) => s.name === 'gpr')?.error).toBe('store unavailable');
    expect(report.sources.find((s) => s.name === 'calendar')?.status).toBe('ok');
  });

  it('warnings from the adapters reach the report and the log, with no secrets in them', async () => {
    const { store } = recordingStore();
    const lines: string[] = [];
    const report = await runFetchMacro({
      today: TODAY,
      sources: sources({
        calendar: async () =>
          calendarResult({
            rows: [],
            kindsOk: [],
            warnings: ['A10 CPI, payrolls and PCE skipped: FRED_API_KEY is not set'],
          }),
      }),
      store,
      log: (line) => lines.push(line),
    });
    expect(report.sources.find((s) => s.name === 'calendar')?.warnings).toContain(
      'A10 CPI, payrolls and PCE skipped: FRED_API_KEY is not set',
    );
    expect(lines.some((l) => l.includes('calendar warning'))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/api_key|SAMPLE-KEY/);
  });

  it('F1: a stale A8 composite is reported with its last complete date in the warnings', async () => {
    const { store } = recordingStore();
    const report = await runFetchMacro({
      today: TODAY,
      sources: sources({
        macroDaily: async () => ({
          rows: [macroRow],
          warnings: [],
          a8: { lastCompleteDate: '2019-10-02', stale: true },
        }),
      }),
      store,
    });
    const macro = report.sources.find((s) => s.name === 'macro');
    expect(macro?.status).toBe('ok');
    const stale = macro?.warnings.find((w) => w.startsWith('A8 global M2 approximation is stale'));
    expect(stale).toContain('last complete date 2019-10-02');
    expect(stale).toContain('CSN-024-FOLLOWUP-2');
  });

  it('F1: a current A8 composite adds no stale warning', async () => {
    const { store } = recordingStore();
    const report = await runFetchMacro({
      today: TODAY,
      sources: sources({
        macroDaily: async () => ({
          rows: [macroRow],
          warnings: [],
          a8: { lastCompleteDate: TODAY, stale: false },
        }),
      }),
      store,
    });
    expect(report.sources.find((s) => s.name === 'macro')?.warnings).toEqual([]);
  });

  it('R7-1: a warning the calendar store returns (an unknown asset id) reaches the calendar source in the report', async () => {
    const base = recordingStore();
    const store: MacroStore = {
      ...base.store,
      replaceCalendarWindow: async () => ({
        written: 1,
        warnings: [
          'calendar: asset id "btc-typo" is not in the assets table; 1 row(s) skipped, the other rows written',
        ],
      }),
    };
    const report = await runFetchMacro({ today: TODAY, sources: sources(), store });
    const calendar = report.sources.find((s) => s.name === 'calendar');
    expect(calendar?.status).toBe('ok');
    expect(calendar?.warnings.join(' ')).toContain('btc-typo');
  });

  it('re-running the same day issues the same writes (idempotent by table key)', async () => {
    const first = recordingStore();
    const second = recordingStore();
    await runFetchMacro({ today: TODAY, sources: sources(), store: first.store });
    await runFetchMacro({ today: TODAY, sources: sources(), store: second.store });
    expect(second.calls).toEqual(first.calls);
  });
});
