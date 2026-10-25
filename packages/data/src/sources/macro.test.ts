import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  A7_GOLD_PROXY_SERIES_ID,
  A8_APPROXIMATION_SERIES_ID,
  A8_APPROXIMATION_SOURCE,
  A8_CAVEAT,
  A8_COMPONENTS,
  buildA8GlobalM2Approximation,
  coingeckoAccess,
  expandToDaily,
  FRED_CORE_SERIES,
  fetchA7GoldProxy,
  fetchFredMacroRows,
  MACRO_CONFIG_DEFAULTS,
  parseFredObservations,
  type FredObservation,
  type MacroSourceConfig,
} from './fred';
import {
  ALTERNATIVE_ME_ATTRIBUTION,
  d3SentimentExtreme,
  fetchD3FearGreed,
  FNG_URL,
  parseFearGreedResponse,
} from './feargreed';
import {
  excelSerialToIsoDate,
  fetchGprMonthly,
  GPR_BASELINE,
  GPR_CITATION,
  gprVsBaseline,
  parseGprWorkbookRows,
} from './gpr';
import {
  type CalendarRow,
  fetchA10Calendar,
  fetchFomcMeetings,
  fetchFredReleaseDates,
  fomcPlausibilityFailures,
  parseFomcCalendarPage,
  FOMC_CALENDAR_URL,
  FRED_RELEASE_DATES_LIMIT,
  parseEtfDecisionEntries,
  parseFomcCalendarHtml,
  parseFomcFallback,
  parseFredReleaseDates,
} from './calendar';
import { asOfFor, type FetchLike, PUBLICATION_LAG_DAYS, SourceError } from './shared';

// R3-4: pin the zone so the F10 GPR test always discriminates a local-getter revert, whatever TZ
// the shell has. Node re-reads TZ when it is assigned. F10 asserts the zone took effect, so a
// silent failure to apply it turns that test red rather than passing vacuously.
process.env['TZ'] = 'Europe/Berlin';

// Fixtures are SAMPLE_ data (invented numbers) except the FOMC excerpt, which is real public markup.
const FIXTURES = new URL('../__fixtures__/', import.meta.url);
const SOURCES = new URL('./', import.meta.url);

function fixtureText(name: string): string {
  return readFileSync(new URL(name, FIXTURES), 'utf8');
}

function fixture<T = unknown>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
}

/** Fake fetch that records each call. The handler decides the response from the request URL. */
function fakeFetch(handler: (url: URL) => Response): {
  fetchImpl: FetchLike;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    return handler(new URL(url));
  };
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}

/** FRED handler that answers from the SAMPLE_fred_series fixture and rejects unknown ids. */
function fredHandler(seriesOverride?: Record<string, unknown>): (url: URL) => Response {
  const series = {
    ...fixture<Record<string, unknown>>('SAMPLE_fred_series.json'),
    ...seriesOverride,
  };
  return (url) => {
    const id = url.searchParams.get('series_id') ?? '';
    const payload = series[id];
    return payload === undefined ? json({ error_message: 'bad series' }, 400) : json(payload);
  };
}

/** Fixture config: start the window at the fixture data so the expansion stays small. */
const FIXTURE_CONFIG: MacroSourceConfig = { ...MACRO_CONFIG_DEFAULTS, startDate: '2025-01-01' };

function observationsFromFixture(): Map<string, FredObservation[]> {
  const series = fixture<Record<string, unknown>>('SAMPLE_fred_series.json');
  const out = new Map<string, FredObservation[]>();
  for (const [id, payload] of Object.entries(series)) {
    out.set(id, parseFredObservations(payload, id));
  }
  return out;
}

describe('A4 Nasdaq and S&P 500 (daily FRED series)', () => {
  it('drops FRED "." holidays and keeps the observed days', () => {
    const obs = parseFredObservations(
      fixture<Record<string, unknown>>('SAMPLE_fred_series.json')['NASDAQCOM'],
      'NASDAQCOM',
    );
    expect(obs).toEqual([
      { date: '2025-01-02', value: 19000.5 },
      { date: '2025-01-06', value: 19100.25 },
    ]);
  });

  it('does not forward-fill daily series: only exact observation days are written', () => {
    const obs = parseFredObservations(
      fixture<Record<string, unknown>>('SAMPLE_fred_series.json')['NASDAQCOM'],
      'NASDAQCOM',
    );
    const daily = expandToDaily(obs, {
      from: '2025-01-02',
      to: '2025-01-06',
      forwardFill: false,
      maxFillDays: 62,
    });
    expect([...daily.keys()]).toEqual(['2025-01-02', '2025-01-06']);
  });

  it('keeps VIXCLS out of the fetch unless includeLicensedVix is on (CSN-071)', async () => {
    const { fetchImpl, calls } = fakeFetch(fredHandler());
    const result = await fetchFredMacroRows({
      apiKey: 'SAMPLE-KEY-A4',
      to: '2025-01-03',
      config: FIXTURE_CONFIG,
      fetchImpl,
    });
    expect(calls.some((c) => new URL(c.url).searchParams.get('series_id') === 'VIXCLS')).toBe(
      false,
    );
    expect(result.warnings.some((w) => w.startsWith('VIXCLS: not fetched'))).toBe(true);
    expect(result.rows.some((r) => r.seriesId === 'VIXCLS')).toBe(false);
  });

  it('fetches VIXCLS only when the licence flag is on', async () => {
    const { fetchImpl } = fakeFetch(fredHandler());
    const result = await fetchFredMacroRows({
      apiKey: 'SAMPLE-KEY-A4',
      to: '2025-01-03',
      config: { ...FIXTURE_CONFIG, includeLicensedVix: true },
      fetchImpl,
    });
    expect(result.rows.some((r) => r.seriesId === 'VIXCLS' && r.date === '2025-01-02')).toBe(true);
  });
});

describe('A6 dollar proxy and 10-year yield', () => {
  it('labels DTWEXBGS as a DXY proxy, not the DXY itself', () => {
    const spec = FRED_CORE_SERIES.find((s) => s.id === 'DTWEXBGS');
    expect(spec?.label).toContain('DXY proxy');
    expect(spec?.label).toContain('ICE-licensed');
    expect(spec?.planId).toBe('A6');
  });

  it('skips "." days in DGS10', () => {
    const obs = parseFredObservations(
      fixture<Record<string, unknown>>('SAMPLE_fred_series.json')['DGS10'],
      'DGS10',
    );
    expect(obs).toEqual([{ date: '2025-01-02', value: 4.57 }]);
  });
});

describe('A7 oil and gold proxy', () => {
  const coinChart = fixture<Record<string, unknown>>('SAMPLE_coingecko_gold.json');
  const goldHandler =
    (overrides: Record<string, unknown> = {}) =>
    (url: URL) => {
      const coin = url.pathname.split('/')[4] ?? '';
      const payload = { ...coinChart, ...overrides }[coin];
      return payload === undefined ? json({ error: 'not found' }, 404) : json(payload);
    };

  it('gold proxy is the daily mean of PAXG and XAUT last prices', async () => {
    const { fetchImpl } = fakeFetch(goldHandler());
    const result = await fetchA7GoldProxy({
      config: MACRO_CONFIG_DEFAULTS,
      from: '2025-01-01',
      to: '2025-01-02',
      fetchImpl,
    });
    expect(result.warnings).toEqual([]);
    expect(result.rows).toEqual([
      {
        seriesId: A7_GOLD_PROXY_SERIES_ID,
        date: '2025-01-01',
        value: 2650,
        asOf: '2025-01-01',
        source: 'coingecko:pax-gold+tether-gold',
      },
      {
        seriesId: A7_GOLD_PROXY_SERIES_ID,
        date: '2025-01-02',
        value: 2661,
        asOf: '2025-01-02',
        source: 'coingecko:pax-gold+tether-gold',
      },
    ]);
  });

  it('a failed coin is a warning and the other coin still gives the proxy', async () => {
    const { fetchImpl } = fakeFetch(goldHandler({ 'tether-gold': undefined }));
    const result = await fetchA7GoldProxy({
      config: MACRO_CONFIG_DEFAULTS,
      from: '2025-01-01',
      to: '2025-01-02',
      fetchImpl,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.rows.map((r) => r.value)).toEqual([2652, 2660]);
  });

  it('can be switched off by config', async () => {
    const { fetchImpl, calls } = fakeFetch(goldHandler());
    const result = await fetchA7GoldProxy({
      config: {
        ...MACRO_CONFIG_DEFAULTS,
        a7Gold: { ...MACRO_CONFIG_DEFAULTS.a7Gold, enabled: false },
      },
      from: '2025-01-01',
      to: '2025-01-02',
      fetchImpl,
    });
    expect(result.rows).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('sends the CoinGecko key in a header and never in the URL', async () => {
    const { fetchImpl, calls } = fakeFetch(goldHandler());
    await fetchA7GoldProxy({
      config: MACRO_CONFIG_DEFAULTS,
      from: '2025-01-01',
      to: '2025-01-02',
      plan: 'demo',
      apiKey: 'SAMPLE-CG-KEY',
      fetchImpl,
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).not.toContain('SAMPLE-CG-KEY');
      expect(call.headers['x-cg-demo-api-key']).toBe('SAMPLE-CG-KEY');
    }
  });

  it('paid CoinGecko plans use the pro host and pro header', () => {
    expect(coingeckoAccess('analyst', 'SAMPLE')).toEqual({
      baseUrl: 'https://pro-api.coingecko.com/api/v3',
      headers: { 'x-cg-pro-api-key': 'SAMPLE' },
    });
    expect(coingeckoAccess(undefined, undefined).headers).toEqual({});
  });
});

describe('A8 global M2 approximation (flagged approximation)', () => {
  it('A8 label: the spec label "global M2 approximation" is used, with the M2/M3 caveat attached', () => {
    const label = A8_APPROXIMATION_SOURCE;
    expect(label.toLowerCase(), label).toContain('global m2 approximation');
    expect(label.toLowerCase(), label).not.toContain('broad money');
    // The caveat names the M3 series and the 2017 end of the true M2 series (spec label kept, facts stated).
    expect(A8_CAVEAT, A8_CAVEAT).toContain('M3');
    expect(A8_CAVEAT, A8_CAVEAT).toContain('2017');
    expect(A8_CAVEAT, A8_CAVEAT).toContain('UK');
    // The label written on the composite rows is the same constant.
    const result = buildA8GlobalM2Approximation({
      observations: observationsFromFixture(),
      from: '2025-01-01',
      to: '2025-01-01',
      config: FIXTURE_CONFIG,
    });
    expect(result.rows[0]?.source).toBe(label);
    expect(result.rows[0]?.seriesId).toBe('A8_GLOBAL_M2_APPROX');
  });

  it('monthly expansion forward-fills to daily and keeps the observation date before the lag', () => {
    const obs = observationsFromFixture().get('M2SL') ?? [];
    const daily = expandToDaily(obs, {
      from: '2025-01-01',
      to: '2025-02-03',
      forwardFill: true,
      maxFillDays: 62,
    });
    expect(daily.get('2025-01-15')).toEqual({ value: 20000, asOf: '2025-01-01' });
    expect(daily.get('2025-02-03')).toEqual({ value: 20100, asOf: '2025-02-01' });
  });

  it('a monthly value stops being used after maxFillDays', () => {
    const obs: FredObservation[] = [{ date: '2025-01-01', value: 1 }];
    const daily = expandToDaily(obs, {
      from: '2025-01-01',
      to: '2025-03-10',
      forwardFill: true,
      maxFillDays: 62,
    });
    expect(daily.has('2025-03-04')).toBe(true);
    expect(daily.has('2025-03-05')).toBe(false);
  });

  it('composite is the sum of the five areas in USD billions (hand-checked: 92,650 on 2025-01-01)', () => {
    const result = buildA8GlobalM2Approximation({
      observations: observationsFromFixture(),
      from: '2025-01-01',
      to: '2025-01-02',
      config: FIXTURE_CONFIG,
    });
    expect(result.warnings).toEqual([]);
    expect(result.areas).toEqual(['US', 'EA', 'JP', 'CN', 'GB']);
    expect(result.rows).toEqual([
      {
        seriesId: A8_APPROXIMATION_SERIES_ID,
        date: '2025-01-01',
        value: 92650,
        asOf: '2025-01-01',
        source: A8_APPROXIMATION_SOURCE,
      },
      {
        seriesId: A8_APPROXIMATION_SERIES_ID,
        date: '2025-01-02',
        value: 92650,
        asOf: '2025-01-01',
        source: A8_APPROXIMATION_SOURCE,
      },
    ]);
  });

  it('each area converts to USD in the right direction (EUR and GBP multiply, JPY and CNY divide)', () => {
    const expected: Record<string, number> = {
      US: 20000,
      EA: 18750,
      JP: 10000,
      CN: 40000,
      GB: 3900,
    };
    for (const component of A8_COMPONENTS) {
      const excluded = A8_COMPONENTS.map((c) => c.area).filter((a) => a !== component.area);
      const result = buildA8GlobalM2Approximation({
        observations: observationsFromFixture(),
        from: '2025-01-01',
        to: '2025-01-01',
        config: { ...FIXTURE_CONFIG, a8ExcludeAreas: excluded },
      });
      expect(result.rows[0]?.value, component.area).toBeCloseTo(expected[component.area] ?? NaN, 6);
    }
  });

  it('the composite stops when the FX series is older than fxMaxFillDays (7)', () => {
    const result = buildA8GlobalM2Approximation({
      observations: observationsFromFixture(),
      from: '2025-01-01',
      to: '2025-01-12',
      config: FIXTURE_CONFIG,
    });
    const dates = result.rows.map((r) => r.date);
    expect(dates[0]).toBe('2025-01-01');
    expect(dates[dates.length - 1]).toBe('2025-01-08');
    expect(dates).toHaveLength(8);
  });

  it('F2: a truncated CN series stops the composite early and warns, naming the stale input', () => {
    const dailyObs = (startIso: string, days: number, value: number): FredObservation[] => {
      const start = Date.parse(`${startIso}T00:00:00Z`);
      return Array.from({ length: days }, (_, i) => ({
        date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
        value,
      }));
    };
    const observations = observationsFromFixture();
    // CN ends 2024-12-01: usable through 2025-02-01 (62-day cap), then the composite must stop.
    observations.set('MYAGM2CNM189N', [{ date: '2024-12-01', value: 3e14 }]);
    // Keep FX available for the whole window so only CN limits the composite.
    observations.set('DEXUSEU', dailyObs('2025-01-01', 120, 1.25));
    observations.set('DEXJPUS', dailyObs('2025-01-01', 120, 160));
    observations.set('DEXCHUS', dailyObs('2025-01-01', 120, 7.5));
    observations.set('DEXUSUK', dailyObs('2025-01-01', 120, 1.3));
    const result = buildA8GlobalM2Approximation({
      observations,
      from: '2025-01-01',
      to: '2025-03-31',
      config: FIXTURE_CONFIG,
    });
    expect(result.rows[result.rows.length - 1]?.date).toBe('2025-02-01');
    const warnings = result.warnings.join(' | ');
    expect(warnings).toContain('A8 composite ends 2025-02-01, before 2025-03-31');
    expect(warnings).toContain('CN MYAGM2CNM189N (last observation 2024-12-01)');
  });

  it('F2: a complete composite that reaches `to` with fresh inputs carries no warning', () => {
    const result = buildA8GlobalM2Approximation({
      observations: observationsFromFixture(),
      from: '2025-01-01',
      to: '2025-01-02',
      config: FIXTURE_CONFIG,
    });
    expect(result.warnings).toEqual([]);
  });

  it('a unit mistake fails loudly instead of publishing a wrong total', () => {
    const observations = observationsFromFixture();
    observations.set('MABMM301EZM189S', [{ date: '2025-01-01', value: 15_000_000 }]);
    expect(() =>
      buildA8GlobalM2Approximation({
        observations,
        from: '2025-01-01',
        to: '2025-01-02',
        config: FIXTURE_CONFIG,
      }),
    ).toThrow(/plausible range/);
  });

  it('a missing area yields no composite and a warning, never a partial total', () => {
    const observations = observationsFromFixture();
    observations.delete('MYAGM2CNM189N');
    const result = buildA8GlobalM2Approximation({
      observations,
      from: '2025-01-01',
      to: '2025-01-02',
      config: FIXTURE_CONFIG,
    });
    expect(result.rows).toEqual([]);
    expect(result.warnings.join(' ')).toContain('MYAGM2CNM189N');
  });

  it('a unit mistake inside the full fetch withholds the composite but keeps the raw FRED rows', async () => {
    const series = fixture<Record<string, unknown>>('SAMPLE_fred_series.json');
    const misscaled = {
      ...series,
      MABMM301EZM189S: {
        ...(series['MABMM301EZM189S'] as Record<string, unknown>),
        observations: [
          {
            realtime_start: '2026-10-24',
            realtime_end: '2026-10-24',
            date: '2025-01-01',
            value: '15000000',
          },
        ],
      },
    };
    const { fetchImpl } = fakeFetch(fredHandler(misscaled));
    const result = await fetchFredMacroRows({
      apiKey: 'SAMPLE-KEY-UNIT',
      to: '2025-01-03',
      config: FIXTURE_CONFIG,
      fetchImpl,
    });
    expect(result.rows.some((r) => r.seriesId === A8_APPROXIMATION_SERIES_ID)).toBe(false);
    expect(result.rows.some((r) => r.seriesId === 'M2SL')).toBe(true);
    expect(result.warnings.join(' ')).toContain('A8 composite withheld');
    expect(result.warnings.join(' ')).toContain('plausible range');
  });

  it('the full fetch writes raw FRED rows plus the composite, and leaves VIXCLS out', async () => {
    const { fetchImpl } = fakeFetch(fredHandler());
    const result = await fetchFredMacroRows({
      apiKey: 'SAMPLE-KEY-A8',
      to: '2025-01-03',
      config: FIXTURE_CONFIG,
      fetchImpl,
    });
    const composite = result.rows.filter((r) => r.seriesId === A8_APPROXIMATION_SERIES_ID);
    expect(composite.map((r) => r.date)).toEqual(['2025-01-01', '2025-01-02', '2025-01-03']);
    expect(composite.every((r) => r.value === 92650)).toBe(true);
    expect(result.warnings).toEqual([
      'VIXCLS: not fetched, licensed series (CSN-071); set includeLicensedVix to enable',
    ]);
  });

  it('the FRED key is required, and no error or warning carries it', async () => {
    await expect(
      fetchFredMacroRows({
        apiKey: undefined,
        to: '2025-01-03',
        fetchImpl: fakeFetch(fredHandler()).fetchImpl,
      }),
    ).rejects.toThrow('FRED_API_KEY is not set');

    const KEY = 'SAMPLE-KEY-LEAK-CHECK';
    const { fetchImpl } = fakeFetch(() => json({ error_message: 'nope' }, 500));
    const result = await fetchFredMacroRows({
      apiKey: KEY,
      to: '2025-01-03',
      config: { ...FIXTURE_CONFIG, includeLicensedVix: true },
      fetchImpl,
    });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join(' ')).not.toContain(KEY);
    expect(result.warnings.join(' ')).not.toContain('api_key');
  });

  it('FRED payload validation rejects a non-numeric value', () => {
    expect(() =>
      parseFredObservations({ observations: [{ date: '2025-01-02', value: 'abc' }] }, 'NASDAQCOM'),
    ).toThrow(/not numeric/);
  });
});

describe('D1 as_of publication lag and F1 A8 status', () => {
  const monthlyObs = (fromIso: string, toIso: string, value: number): FredObservation[] => {
    const out: FredObservation[] = [];
    let y = Number(fromIso.slice(0, 4));
    let m = Number(fromIso.slice(5, 7));
    const endY = Number(toIso.slice(0, 4));
    const endM = Number(toIso.slice(5, 7));
    while (y < endY || (y === endY && m <= endM)) {
      out.push({ date: `${y}-${String(m).padStart(2, '0')}-01`, value });
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return out;
  };
  const dailyObs = (fromIso: string, toIso: string, value: number): FredObservation[] => {
    const out: FredObservation[] = [];
    const end = Date.parse(`${toIso}T00:00:00Z`);
    for (let t = Date.parse(`${fromIso}T00:00:00Z`); t <= end; t += 86_400_000) {
      out.push({ date: new Date(t).toISOString().slice(0, 10), value });
    }
    return out;
  };
  // Real publication stop dates: CN ends 2019-08-01, EA/JP/GB end 2023-11-01, US is current.
  const realStopObservations = (): Map<string, FredObservation[]> =>
    new Map<string, FredObservation[]>([
      ['M2SL', monthlyObs('2019-01-01', '2026-08-01', 20_000)],
      ['MABMM301EZM189S', monthlyObs('2019-01-01', '2023-11-01', 15_000_000_000_000)],
      ['MABMM301JPM189S', monthlyObs('2019-01-01', '2023-11-01', 1_600_000_000_000_000)],
      ['MYAGM2CNM189N', monthlyObs('2019-01-01', '2019-08-01', 300_000_000_000_000)],
      ['MABMM301GBM189S', monthlyObs('2019-01-01', '2023-11-01', 3_000_000_000_000)],
      ['DEXUSEU', dailyObs('2019-01-01', '2026-10-16', 1.25)],
      ['DEXJPUS', dailyObs('2019-01-01', '2026-10-16', 160)],
      ['DEXCHUS', dailyObs('2019-01-01', '2026-10-16', 7.5)],
      ['DEXUSUK', dailyObs('2019-01-01', '2026-10-16', 1.3)],
    ]);

  it('D1: the lag table matches the spec (daily 1, monthly and GPR 45, Fear & Greed 1, gold 1)', () => {
    const daily = [
      'NASDAQCOM',
      'SP500',
      'VIXCLS',
      'DTWEXBGS',
      'DGS10',
      'DCOILWTICO',
      'DEXUSEU',
      'DEXJPUS',
      'DEXCHUS',
      'DEXUSUK',
    ];
    const monthly = [
      'M2SL',
      'MABMM301EZM189S',
      'MABMM301JPM189S',
      'MYAGM2CNM189N',
      'MABMM301GBM189S',
      'GPR_MONTHLY',
    ];
    for (const id of daily) expect(PUBLICATION_LAG_DAYS[id], id).toBe(1);
    for (const id of monthly) expect(PUBLICATION_LAG_DAYS[id], id).toBe(45);
    expect(PUBLICATION_LAG_DAYS['FEAR_GREED']).toBe(1);
    expect(PUBLICATION_LAG_DAYS['A7_GOLD_PROXY_USD']).toBe(1);
    expect(MACRO_CONFIG_DEFAULTS.asOfRule).toBe('observation-date');
  });

  it('D1: asOfFor adds the lag under publication-lag and keeps the observation date under observation-date', () => {
    expect(asOfFor('2025-03-01', 45, 'publication-lag')).toBe('2025-04-15');
    expect(asOfFor('2025-03-01', 45, 'observation-date')).toBe('2025-03-01');
  });

  it('D1: under publication-lag a March 2025 observation carries an as_of after its month-end publication', async () => {
    const march = { observations: [{ date: '2025-03-01', value: '20200.0' }] };
    const { fetchImpl } = fakeFetch(fredHandler({ M2SL: march }));
    const result = await fetchFredMacroRows({
      apiKey: 'SAMPLE-KEY-D1',
      to: '2025-03-03',
      config: { ...FIXTURE_CONFIG, asOfRule: 'publication-lag' },
      fetchImpl,
    });
    const row = result.rows.find((r) => r.seriesId === 'M2SL' && r.date === '2025-03-01');
    expect(row?.asOf).toBe('2025-04-15');
    expect((row?.asOf ?? '') > '2025-03-31').toBe(true);
  });

  it('D1: under observation-date the same March 2025 row carries the observation date', async () => {
    const march = { observations: [{ date: '2025-03-01', value: '20200.0' }] };
    const { fetchImpl } = fakeFetch(fredHandler({ M2SL: march }));
    const result = await fetchFredMacroRows({
      apiKey: 'SAMPLE-KEY-D1',
      to: '2025-03-03',
      config: { ...FIXTURE_CONFIG, asOfRule: 'observation-date' },
      fetchImpl,
    });
    const row = result.rows.find((r) => r.seriesId === 'M2SL' && r.date === '2025-03-01');
    expect(row?.asOf).toBe('2025-03-01');
  });

  it('D1: GPR and Fear & Greed follow the same rule when given observation-date', () => {
    const gpr = parseGprWorkbookRows(fixture<(string | number)[][]>('SAMPLE_gpr_rows.json'), {
      rule: 'observation-date',
      lagDays: 45,
    });
    expect(gpr.find((r) => r.month === '1985-02-01')?.asOf).toBe('1985-02-01');
    const fng = parseFearGreedResponse(fixture<unknown>('SAMPLE_alternative_me_fng.json'), {
      rule: 'observation-date',
      lagDays: 1,
    });
    expect(fng.find((r) => r.date === '2025-01-01')?.asOf).toBe('2025-01-01');
  });

  it('D1: a series with no configured lag fails with a warning, never a guessed lag', async () => {
    const { fetchImpl } = fakeFetch(fredHandler());
    const result = await fetchFredMacroRows({
      apiKey: 'SAMPLE-KEY-D1',
      to: '2025-01-03',
      config: { ...FIXTURE_CONFIG, asOfRule: 'publication-lag', publicationLagDays: {} },
      fetchImpl,
    });
    expect(result.rows).toEqual([]);
    expect(result.warnings.join(' ')).toContain('no publication lag configured for NASDAQCOM');
  });

  it('R3-1: daily and FX rows carry the publication lag under publication-lag (NASDAQCOM, DEXUSEU)', async () => {
    const { fetchImpl } = fakeFetch(fredHandler());
    const result = await fetchFredMacroRows({
      apiKey: 'SAMPLE-KEY-R31',
      to: '2025-01-03',
      config: { ...FIXTURE_CONFIG, asOfRule: 'publication-lag' },
      fetchImpl,
    });
    const nasdaq = result.rows.find((r) => r.seriesId === 'NASDAQCOM' && r.date === '2025-01-02');
    expect(nasdaq?.asOf, 'NASDAQCOM 2025-01-02 as_of (1-day lag)').toBe('2025-01-03');
    const fx = result.rows.find((r) => r.seriesId === 'DEXUSEU' && r.date === '2025-01-01');
    expect(fx?.asOf, 'DEXUSEU 2025-01-01 as_of (1-day lag)').toBe('2025-01-02');
  });

  it('R3-1: under the spec default (observation-date) the same daily and FX rows carry the observation date', async () => {
    const { fetchImpl } = fakeFetch(fredHandler());
    const result = await fetchFredMacroRows({
      apiKey: 'SAMPLE-KEY-R31',
      to: '2025-01-03',
      config: FIXTURE_CONFIG,
      fetchImpl,
    });
    const nasdaq = result.rows.find((r) => r.seriesId === 'NASDAQCOM' && r.date === '2025-01-02');
    expect(nasdaq?.asOf).toBe('2025-01-02');
    const fx = result.rows.find((r) => r.seriesId === 'DEXUSEU' && r.date === '2025-01-01');
    expect(fx?.asOf).toBe('2025-01-01');
  });

  it('R3-3: Fear & Greed under an observation-date config writes the observation date as as_of', async () => {
    const { fetchImpl } = fakeFetch(() => json(fixture<unknown>('SAMPLE_alternative_me_fng.json')));
    const rows = await fetchD3FearGreed({
      fetchImpl,
      config: { ...MACRO_CONFIG_DEFAULTS, asOfRule: 'observation-date' },
    });
    expect(rows.map((r) => [r.date, r.asOf])).toEqual([
      ['2024-12-31', '2024-12-31'],
      ['2025-01-01', '2025-01-01'],
      ['2025-01-02', '2025-01-02'],
    ]);
  });

  it('R3-3: GPR under an observation-date config writes the month as as_of', async () => {
    const { fetchImpl } = fakeFetch(() => new Response(new Uint8Array([0xd0]), { status: 200 }));
    const rows = await fetchGprMonthly({
      fetchImpl,
      readWorkbook: async () => fixture<(string | number)[][]>('SAMPLE_gpr_rows.json'),
      config: { ...MACRO_CONFIG_DEFAULTS, asOfRule: 'observation-date' },
    });
    expect(rows.find((r) => r.month === '1985-02-01')?.asOf).toBe('1985-02-01');
    expect(rows.find((r) => r.month === '2026-09-01')?.asOf).toBe('2026-09-01');
  });

  it('R3-3: the publication-lag config path adds the table lag to Fear & Greed and GPR', async () => {
    const lagConfig = { ...MACRO_CONFIG_DEFAULTS, asOfRule: 'publication-lag' as const };
    const { fetchImpl } = fakeFetch(() => json(fixture<unknown>('SAMPLE_alternative_me_fng.json')));
    const fng = await fetchD3FearGreed({ fetchImpl, config: lagConfig });
    expect(fng.find((r) => r.date === '2025-01-01')?.asOf).toBe('2025-01-02');
    const gprFetch = fakeFetch(() => new Response(new Uint8Array([0xd0]), { status: 200 }));
    const gpr = await fetchGprMonthly({
      fetchImpl: gprFetch.fetchImpl,
      readWorkbook: async () => fixture<(string | number)[][]>('SAMPLE_gpr_rows.json'),
      config: lagConfig,
    });
    expect(gpr.find((r) => r.month === '1985-02-01')?.asOf).toBe('1985-03-18');
  });

  it('R3-3: a publicationLagDays override reaches Fear & Greed and GPR', async () => {
    const { fetchImpl } = fakeFetch(() => json(fixture<unknown>('SAMPLE_alternative_me_fng.json')));
    const fng = await fetchD3FearGreed({
      fetchImpl,
      config: {
        ...MACRO_CONFIG_DEFAULTS,
        asOfRule: 'publication-lag',
        publicationLagDays: { ...PUBLICATION_LAG_DAYS, FEAR_GREED: 5 },
      },
    });
    expect(fng.find((r) => r.date === '2025-01-01')?.asOf).toBe('2025-01-06');
    const gprFetch = fakeFetch(() => new Response(new Uint8Array([0xd0]), { status: 200 }));
    const gpr = await fetchGprMonthly({
      fetchImpl: gprFetch.fetchImpl,
      readWorkbook: async () => fixture<(string | number)[][]>('SAMPLE_gpr_rows.json'),
      config: {
        ...MACRO_CONFIG_DEFAULTS,
        asOfRule: 'publication-lag',
        publicationLagDays: { ...PUBLICATION_LAG_DAYS, GPR_MONTHLY: 10 },
      },
    });
    expect(gpr.find((r) => r.month === '1985-02-01')?.asOf).toBe('1985-02-11');
  });

  it('F1: real stop dates give lastCompleteDate 2019-10-02 and mark the composite stale', () => {
    const result = buildA8GlobalM2Approximation({
      observations: realStopObservations(),
      from: '2019-01-01',
      to: '2026-10-24',
      config: MACRO_CONFIG_DEFAULTS,
    });
    expect(result.status).toEqual({ lastCompleteDate: '2019-10-02', stale: true });
    expect(result.warnings.join(' ')).toContain('A8 composite ends 2019-10-02, before 2026-10-24');
  });

  it('F1: a composite that reaches `to` with fresh inputs is not stale', () => {
    const result = buildA8GlobalM2Approximation({
      observations: realStopObservations(),
      from: '2019-01-01',
      to: '2019-09-01',
      config: MACRO_CONFIG_DEFAULTS,
    });
    expect(result.status).toEqual({ lastCompleteDate: '2019-09-01', stale: false });
  });

  it('R3-2: exactly monthlyMaxFillDays (62) after the last complete day is not stale', () => {
    // Last complete day 2019-10-02 (CN stop plus the 62-day cap). 2019-10-02 + 62 days = 2019-12-03.
    const result = buildA8GlobalM2Approximation({
      observations: realStopObservations(),
      from: '2019-01-01',
      to: '2019-12-03',
      config: MACRO_CONFIG_DEFAULTS,
    });
    expect(result.status).toEqual({ lastCompleteDate: '2019-10-02', stale: false });
  });

  it('R3-2: one day beyond the cap (63 days) is stale', () => {
    const result = buildA8GlobalM2Approximation({
      observations: realStopObservations(),
      from: '2019-01-01',
      to: '2019-12-04',
      config: MACRO_CONFIG_DEFAULTS,
    });
    expect(result.status).toEqual({ lastCompleteDate: '2019-10-02', stale: true });
  });

  it('F1: fetchFredMacroRows returns the A8 status with its rows', async () => {
    const { fetchImpl } = fakeFetch(fredHandler());
    const result = await fetchFredMacroRows({
      apiKey: 'SAMPLE-KEY-F1',
      to: '2025-01-03',
      config: FIXTURE_CONFIG,
      fetchImpl,
    });
    expect(result.a8).toEqual({ lastCompleteDate: '2025-01-03', stale: false });
  });
});

describe('A9 geopolitical risk (GPR, CC BY)', () => {
  it('Excel serials map to UTC dates, including the 1900 leap-day quirk', () => {
    expect(excelSerialToIsoDate(1)).toBe('1900-01-01');
    expect(excelSerialToIsoDate(32)).toBe('1900-02-01');
    expect(excelSerialToIsoDate(61)).toBe('1900-03-01');
    expect(excelSerialToIsoDate(46235)).toBe('2026-08-01');
  });

  it('reads the GPR column, skips the blank pre-1985 row, and keys rows by first-of-month', () => {
    const rows = parseGprWorkbookRows(fixture<(string | number)[][]>('SAMPLE_gpr_rows.json'));
    expect(rows).toEqual([
      { month: '1985-02-01', gpr: 96.5, asOf: '1985-02-01', source: 'matteoiacoviello.com' },
      { month: '1985-03-01', gpr: 101.25, asOf: '1985-03-01', source: 'matteoiacoviello.com' },
      { month: '2026-08-01', gpr: 146.2, asOf: '2026-08-01', source: 'matteoiacoviello.com' },
      { month: '2026-09-01', gpr: 120, asOf: '2026-09-01', source: 'matteoiacoviello.com' },
    ]);
  });

  it('also reads ISO and compact month text', () => {
    const rows = parseGprWorkbookRows([
      ['month', 'GPR'],
      ['1990-06-15', 90],
      ['1990M07', 91],
    ]);
    expect(rows.map((r) => r.month)).toEqual(['1990-06-01', '1990-07-01']);
  });

  it('F9: month text must name month 1 to 12 (2020-13, 1990M13 and 2020-00 are refused)', () => {
    for (const bad of ['2020-13', '1990M13', '2020-00']) {
      expect(
        () =>
          parseGprWorkbookRows([
            ['month', 'GPR'],
            [bad, 90],
          ]),
        bad,
      ).toThrow(/unreadable month/);
    }
    expect(
      parseGprWorkbookRows([
        ['month', 'GPR'],
        ['2020-12', 90],
      ])[0]?.month,
    ).toBe('2020-12-01');
  });

  it('F10: Date cells use UTC getters, so a UTC-midnight Date keeps its month in every TZ', () => {
    // Reader contract: Date cells are UTC midnight. This must pass under TZ=UTC and TZ=Europe/Berlin.
    const rows = parseGprWorkbookRows([
      ['month', 'GPR'],
      [new Date(Date.UTC(1985, 1, 1)), 96.5],
      [new Date(Date.UTC(2026, 8, 1)), 120],
    ]);
    expect(rows.map((r) => r.month)).toEqual(['1985-02-01', '2026-09-01']);
  });

  it('F10 (pinned): a Date whose UTC and local months differ reads the UTC month', () => {
    // The readings differ only when the process TZ is not UTC: getTimezoneOffset() is negative
    // east of UTC (Europe/Berlin) and positive west (America/New_York). The instant sits 30 minutes
    // either side of 1985-02-01T00:00Z, so the UTC month is January east and February west.
    // A revert to local getters (getMonth, getFullYear) reads the other month and fails here.
    const east = new Date(Date.UTC(1985, 1, 1)).getTimezoneOffset() < 0;
    const instant = Date.UTC(1985, 1, 1) + (east ? -30 : 30) * 60_000;
    const utcMonth = east ? '1985-01-01' : '1985-02-01';
    // Precondition (R3-4): the zone is non-UTC and the two months differ. Fail loudly otherwise.
    expect(new Date(0).getTimezoneOffset(), 'TZ must be non-UTC for the F10 pin').not.toBe(0);
    const local = new Date(instant);
    expect(local.getMonth(), 'local and UTC months must differ').not.toBe(local.getUTCMonth());
    const rows = parseGprWorkbookRows([
      ['month', 'GPR'],
      [new Date(instant), 96.5],
    ]);
    expect(rows.map((r) => r.month)).toEqual([utcMonth]);
  });

  it('R3-5: a GPR serial past year 9999 (3000000) is a SourceError, not a malformed month', () => {
    const rows = [
      ['month', 'GPR'],
      [3_000_000, 90],
    ];
    expect(() => parseGprWorkbookRows(rows)).toThrow(SourceError);
    expect(() => parseGprWorkbookRows(rows)).toThrow(/unreadable month/);
    expect(() => excelSerialToIsoDate(3_000_000)).toThrow(/outside the years 0000 to 9999/);
  });

  it('R3-5: a huge GPR serial (1e9) is a typed SourceError, not an untyped RangeError', () => {
    const parse = () =>
      parseGprWorkbookRows([
        ['month', 'GPR'],
        [1_000_000_000, 90],
      ]);
    expect(parse).toThrow(SourceError);
    expect(parse).not.toThrow(RangeError);
  });

  it('R3-5: the last Excel serial of year 9999 (2958465) reads as 9999-12-01 under observation-date', () => {
    const rows = parseGprWorkbookRows(
      [
        ['month', 'GPR'],
        [2_958_465, 90],
      ],
      {
        rule: 'observation-date',
        lagDays: 45,
      },
    );
    expect(rows.map((r) => [r.month, r.asOf])).toEqual([['9999-12-01', '9999-12-01']]);
  });

  it('R3-5: a Date cell in year 10000 is an unreadable month, not a malformed one', () => {
    const parse = () =>
      parseGprWorkbookRows([
        ['month', 'GPR'],
        [new Date(Date.UTC(10000, 0, 1)), 90],
      ]);
    expect(parse).toThrow(SourceError);
    expect(parse).toThrow(/unreadable month/);
  });

  it('a non-blank GPR row with an unreadable month is an error, not a silent skip', () => {
    expect(() =>
      parseGprWorkbookRows([
        ['month', 'GPR'],
        ['not a date', 90],
      ]),
    ).toThrow(/unreadable month/);
  });

  it('a workbook without a GPR column is rejected', () => {
    expect(() =>
      parseGprWorkbookRows([
        ['month', 'GPRT'],
        [31079, 1],
      ]),
    ).toThrow(/missing the month or GPR/);
  });

  it('baseline is 100 and A9 reads GPR as a signed distance from it', () => {
    expect(GPR_BASELINE).toBe(100);
    expect(gprVsBaseline(146.2)).toBeCloseTo(46.2, 10);
    expect(gprVsBaseline(88)).toBeCloseTo(-12, 10);
  });

  it('the citation names the paper and the CC BY licence', () => {
    expect(GPR_CITATION).toContain('Measuring Geopolitical Risk');
    expect(GPR_CITATION).toContain('CC BY');
  });

  it('C: the default XLS reader parses the SAMPLE_ workbook end to end (no injected reader)', async () => {
    const workbook = readFileSync(new URL('SAMPLE_gpr_workbook.xlsx', FIXTURES));
    const { fetchImpl } = fakeFetch(() => new Response(new Uint8Array(workbook), { status: 200 }));
    const rows = await fetchGprMonthly({ fetchImpl });
    expect(rows.map((r) => [r.month, r.gpr, r.asOf])).toEqual([
      ['1985-02-01', 96.5, '1985-02-01'],
      ['1985-03-01', 101.25, '1985-03-01'],
      ['2026-08-01', 146.2, '2026-08-01'],
      ['2026-09-01', 120, '2026-09-01'],
    ]);
  });

  it('C: bytes that are not a workbook fail with a typed SourceError, not an untyped crash', async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response(new Uint8Array([0x00, 0x01, 0x02, 0x03]), { status: 200 }),
    );
    await expect(fetchGprMonthly({ fetchImpl })).rejects.toThrow(SourceError);
    await expect(fetchGprMonthly({ fetchImpl })).rejects.toThrow(
      /could not be parsed|no readable sheet|missing the month or GPR column/,
    );
  });

  it('with an injected reader, the downloaded bytes are parsed into GPR rows', async () => {
    const xls = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]);
    const { fetchImpl } = fakeFetch(() => new Response(xls, { status: 200 }));
    const rows = await fetchGprMonthly({
      fetchImpl,
      readWorkbook: async (bytes) => {
        expect(Array.from(bytes)).toEqual(Array.from(xls));
        return fixture<(string | number)[][]>('SAMPLE_gpr_rows.json');
      },
    });
    expect(rows).toHaveLength(4);
  });
});

describe('D3 Fear & Greed (alternative.me)', () => {
  const payload = fixture<unknown>('SAMPLE_alternative_me_fng.json');

  it('parses value, classification and UTC date, oldest first', () => {
    const rows = parseFearGreedResponse(payload);
    expect(rows).toEqual([
      {
        date: '2024-12-31',
        value: 12,
        classification: 'Extreme Fear',
        asOf: '2024-12-31',
        source: 'alternative.me',
      },
      {
        date: '2025-01-01',
        value: 20,
        classification: 'Fear',
        asOf: '2025-01-01',
        source: 'alternative.me',
      },
      {
        date: '2025-01-02',
        value: 85,
        classification: 'Extreme Greed',
        asOf: '2025-01-02',
        source: 'alternative.me',
      },
    ]);
  });

  it('extreme flags: above 80 or below 20, and the boundaries 80 and 20 do not count', () => {
    expect(d3SentimentExtreme(85)).toBe('extreme-greed');
    expect(d3SentimentExtreme(81)).toBe('extreme-greed');
    expect(d3SentimentExtreme(80)).toBeNull();
    expect(d3SentimentExtreme(20)).toBeNull();
    expect(d3SentimentExtreme(19)).toBe('extreme-fear');
    expect(d3SentimentExtreme(12)).toBe('extreme-fear');
    expect(d3SentimentExtreme(50)).toBeNull();
  });

  it('F8: a blank value or timestamp is rejected before Number() turns it into 0 or 1970', () => {
    expect(() =>
      parseFearGreedResponse({ data: [{ value: '', timestamp: '1735776000' }] }),
    ).toThrow(/between 0 and 100/);
    expect(() => parseFearGreedResponse({ data: [{ value: '20', timestamp: '' }] })).toThrow(
      /Unix time/,
    );
  });

  it('N3: a timestamp outside the representable date range is a SourceError, not a RangeError', () => {
    for (const timestamp of ['99999999999999', 99999999999999]) {
      const parse = () => parseFearGreedResponse({ data: [{ value: '20', timestamp }] });
      expect(parse).toThrow(SourceError);
      expect(parse).toThrow(/representable date range/);
    }
  });

  it('R3-5: a timestamp for year 10000 (string or number) is a SourceError, not a non-ISO date', () => {
    // 253402300800 is 10000-01-01T00:00:00Z: one second past the last second of year 9999.
    for (const timestamp of ['253402300800', 253402300800]) {
      const parse = () => parseFearGreedResponse({ data: [{ value: '20', timestamp }] });
      expect(parse, String(timestamp)).toThrow(SourceError);
      expect(parse, String(timestamp)).toThrow(/representable date range \(years 0000 to 9999\)/);
    }
  });

  it('R3-5: the last second of year 9999 is written as a 4-digit date under observation-date', () => {
    const rows = parseFearGreedResponse(
      { data: [{ value: '20', timestamp: '253402300799' }] },
      { rule: 'observation-date', lagDays: 1 },
    );
    expect(rows.map((r) => [r.date, r.asOf])).toEqual([['9999-12-31', '9999-12-31']]);
  });

  it('R3-5: under the default lag that row would fall in year 10000, so it is refused as a SourceError', () => {
    const parse = () =>
      parseFearGreedResponse(
        { data: [{ value: '20', timestamp: '253402300799' }] },
        { rule: 'publication-lag', lagDays: 1 },
      );
    expect(parse).toThrow(SourceError);
    expect(parse).toThrow(/0000 to 9999/);
  });

  it('rejects a value outside 0 to 100', () => {
    expect(() =>
      parseFearGreedResponse({ data: [{ value: '101', timestamp: '1735776000' }] }),
    ).toThrow(/between 0 and 100/);
  });

  it('fetches the limit=0 endpoint and names the source on HTTP errors', async () => {
    const ok = fakeFetch(() => json(payload));
    const rows = await fetchD3FearGreed({ fetchImpl: ok.fetchImpl });
    expect(rows).toHaveLength(3);
    expect(ok.calls[0]?.url).toBe(FNG_URL);

    const bad = fakeFetch(() => text('nope', 500));
    await expect(fetchD3FearGreed({ fetchImpl: bad.fetchImpl })).rejects.toThrow(
      'alternative.me: HTTP 500',
    );
  });

  it('attribution text is the one the licensing check asked for', () => {
    expect(ALTERNATIVE_ME_ATTRIBUTION).toBe('Data from alternative.me');
  });
});

describe('A10 event calendar (events_calendar)', () => {
  const excerpt = fixtureText('SAMPLE_fomc_calendar_excerpt.html');
  const releases = fixture<Record<string, unknown>>('SAMPLE_fred_release_dates.json');
  const etf = fixture<unknown>('SAMPLE_etf_decisions.json');

  it('FOMC page parse: 2026 and 2027 meetings, decision on the last day, SEP flagged', () => {
    const meetings = parseFomcCalendarHtml(excerpt);
    expect(meetings).toHaveLength(16);
    expect(meetings[0]).toEqual({ start: '2026-01-27', decision: '2026-01-28', sep: false });
    expect(meetings[1]).toEqual({ start: '2026-03-17', decision: '2026-03-18', sep: true });
    expect(meetings[6]).toEqual({ start: '2026-10-27', decision: '2026-10-28', sep: false });
    expect(meetings[15]).toEqual({ start: '2027-12-07', decision: '2027-12-08', sep: true });
  });

  it('the fixture excerpt parse agrees with the maintained fallback file', () => {
    const fromPage = parseFomcCalendarHtml(excerpt);
    const fallback = parseFomcFallback(
      JSON.parse(readFileSync(new URL('fomc-fallback.json', SOURCES), 'utf8')),
    );
    expect(fromPage).toEqual(fallback);
  });

  it('R8-1: a 2027 January label without <strong> (the review case) is a partial page: no row is stored, FOMC is not ok', async () => {
    // The 2027 section's "January" label loses its <strong> wrapper. Before R8-1 the January row inherited
    // the previous month and a wrong date was stored with status ok. Now the page is partial.
    const first = excerpt.indexOf('<strong>January</strong>');
    const second = excerpt.indexOf('<strong>January</strong>', first + 1);
    expect(second).toBeGreaterThan(first);
    const changed =
      excerpt.slice(0, second) +
      '<span>January</span>' +
      excerpt.slice(second + '<strong>January</strong>'.length);
    const page = parseFomcCalendarPage(changed);
    expect(page.meetings).toEqual([]);
    expect(page.failures.join(' ')).toContain('structure changed');
    expect(
      page.meetings.some((m) => m.decision === '2027-01-27' || m.decision === '2026-12-27'),
    ).toBe(false);
    const { fetchImpl } = fakeFetch((url) =>
      url.pathname.includes('fomccalendars')
        ? text(changed)
        : json({ release_dates: [], count: 0 }),
    );
    const result = await fetchA10Calendar({ today: '2027-01-20', windowDays: 60, fetchImpl });
    expect(result.kindsOk).not.toContain('fomc');
    expect(result.rows.some((r) => r.kind === 'fomc')).toBe(false);
    expect(result.fomcFailure).toContain('partial');
  });

  it('R8-1: a wrapped date cell (<strong> inside the cell) is a partial page', () => {
    const wrapped = excerpt.replace(
      '<div class="fomc-meeting__date col-xs-4 col-sm-9 col-md-10 col-lg-1">27-28</div>',
      '<div class="fomc-meeting__date col-xs-4 col-sm-9 col-md-10 col-lg-1"><strong>27-28</strong></div>',
    );
    expect(wrapped).not.toBe(excerpt);
    const page = parseFomcCalendarPage(wrapped);
    expect(page.meetings).toEqual([]);
    expect(page.failures.join(' ')).toContain('date cell');
  });

  it('R8-1: a reworded year heading ("FOMC Meeting") is a partial page: the 2027 rows are not dated as 2026', () => {
    const reworded = excerpt.replace('2027 FOMC Meetings', '2027 FOMC Meeting');
    expect(reworded).not.toBe(excerpt);
    const page = parseFomcCalendarPage(reworded);
    expect(page.meetings).toEqual([]);
    expect(page.failures.join(' ')).toContain('year heading');
  });

  describe('R9-1: plausibility checks catch the markup changes the structure counts cannot see', () => {
    // Each shape keeps every structure count equal (the counts select by class and tag), so the row parse
    // alone would return a wrong or short page. The plausibility checks must make each one partial.
    const OCT_LABEL =
      '<div class="fomc-meeting__month col-xs-5 col-sm-3 col-md-2"><strong>October</strong>';
    const replaceAfterOctober = (html: string, from: string, to: string): string => {
      const anchor = html.indexOf('<strong>October</strong>');
      const at = html.indexOf(from, anchor);
      expect(anchor).toBeGreaterThan(-1);
      expect(at).toBeGreaterThan(anchor);
      return html.slice(0, at) + to + html.slice(at + from.length);
    };
    const outcome = async (html: string) => {
      const { fetchImpl } = fakeFetch((url) =>
        url.pathname.includes('fomccalendars') ? text(html) : json({ release_dates: [], count: 0 }),
      );
      const fomc = await fetchFomcMeetings({ fetchImpl });
      const result = await fetchA10Calendar({ today: '2026-10-24', windowDays: 60, fetchImpl });
      return { fomc, result };
    };
    const expectPartial = async (html: string, rule: string): Promise<void> => {
      expect(html).not.toBe(excerpt);
      const { fomc, result } = await outcome(html);
      expect(fomc.meetings).toEqual([]);
      expect(fomc.failed).toContain('partial');
      expect(fomc.warnings.join(' ')).toContain(`plausibility rule (${rule})`);
      expect(result.kindsOk).not.toContain('fomc');
      expect(result.rows.some((r) => r.kind === 'fomc')).toBe(false);
      expect(result.fomcFailure).toContain('partial');
    };

    it('control: the fixture excerpt is plausible (16 meetings, every rule holds)', () => {
      expect(fomcPlausibilityFailures(excerpt, parseFomcCalendarHtml(excerpt))).toEqual([]);
    });

    it('shape 1: a renamed October month-label class is a partial page (rule b: September 27 is 12 days after September 15)', async () => {
      const renamed = excerpt.replace(
        OCT_LABEL,
        OCT_LABEL.replace('fomc-meeting__month', 'fomc-meeting__label'),
      );
      // The row parse alone carries September over to the October cell; the plausibility gap check sees it.
      expect(parseFomcCalendarPage(renamed).failures).toEqual([]);
      expect(parseFomcCalendarHtml(renamed).some((m) => m.start === '2026-09-27')).toBe(true);
      await expectPartial(renamed, 'b');
    });

    it('shape 2: a renamed October date-cell class is a partial page (rule e: a day-range cell with no parsed meeting)', async () => {
      const renamed = replaceAfterOctober(
        excerpt,
        'fomc-meeting__date',
        'fomc-meeting__day',
      );
      // The row parse drops the cell silently (15 meetings, no failure); the bare-text count catches it.
      expect(parseFomcCalendarPage(renamed).failures).toEqual([]);
      expect(parseFomcCalendarHtml(renamed)).toHaveLength(15);
      await expectPartial(renamed, 'e');
    });

    it('shape 3: a retagged, reworded 2027 year heading is a partial page (rules a and c: 2027 dates inherit 2026)', async () => {
      const retagged = excerpt.replace(
        '<h4><a>2027 FOMC Meetings</a></h4>',
        '<h3><a>2027 FOMC Meeting dates</a></h3>',
      );
      // The 2027 meetings are dated 2026 by the row parse, with no failure.
      expect(parseFomcCalendarPage(retagged).failures).toEqual([]);
      expect(parseFomcCalendarHtml(retagged)).toHaveLength(16);
      await expectPartial(retagged, 'a');
      const { fomc } = await outcome(retagged);
      expect(fomc.warnings.join(' ')).toContain('plausibility rule (c)');
    });

    it('shape 4: a renamed label that carries a month 22 days after the previous meeting is a partial page (rule b, 30-day bound)', async () => {
      // A carried month can only land after the previous meeting when both fall in the same month, so the
      // previous meeting is moved to September 2-3 (synthetic). The renamed October label then carries
      // September, and its cell 24-25 lands on September 24, 22 days after September 2. The year counts,
      // the order and the bare-cell count all hold; only the 30-day lower bound of rule (b) can see it.
      const sepAt = excerpt.indexOf('<strong>September</strong>');
      const sepCell = excerpt.indexOf('>15-16*<', sepAt);
      expect(sepAt).toBeGreaterThan(-1);
      expect(sepCell).toBeGreaterThan(sepAt);
      const early = excerpt.slice(0, sepCell) + '>2-3*<' + excerpt.slice(sepCell + '>15-16*<'.length);
      const renamedLabel = early.replace(
        OCT_LABEL,
        OCT_LABEL.replace('fomc-meeting__month', 'fomc-meeting__label'),
      );
      const octAt = renamedLabel.indexOf('<strong>October</strong>');
      const octCell = renamedLabel.indexOf('>27-28<', octAt);
      expect(octCell).toBeGreaterThan(octAt);
      const shaped =
        renamedLabel.slice(0, octCell) + '>24-25<' + renamedLabel.slice(octCell + '>27-28<'.length);
      const parsed = parseFomcCalendarPage(shaped);
      expect(parsed.failures).toEqual([]);
      expect(parsed.meetings).toContainEqual({ start: '2026-09-24', decision: '2026-09-25', sep: false });
      expect(parsed.meetings).toHaveLength(16);
      await expectPartial(shaped, 'b');
    });

    it('shape 4, literal case: a renamed January label whose 2027 section has a heading is a row failure, not a carried month', async () => {
      // The brief's example (January under December, cell 28-29) cannot occur on the real structure: the
      // 2027 heading resets the month, so the January row has no label and fails at row level. Pinned here
      // so the outcome is known: the page is partial and no row is dated from December.
      const january2027 =
        '<div class="fomc-meeting__month col-xs-5 col-sm-3 col-md-2"><strong>January</strong></div>\n<div class="fomc-meeting__date col-xs-4 col-sm-9 col-md-10 col-lg-1">26-27</div>';
      expect(excerpt.split(january2027)).toHaveLength(2);
      const literal = excerpt.replace(
        january2027,
        '<div class="fomc-meeting__label col-xs-5 col-sm-3 col-md-2"><strong>January</strong></div>\n<div class="fomc-meeting__date col-xs-4 col-sm-9 col-md-10 col-lg-1">28-29</div>',
      );
      const parsed = parseFomcCalendarPage(literal);
      expect(parsed.failures.join(' ')).toContain('does not name a known month');
      expect(parsed.meetings.some((m) => m.decision === '2026-12-29')).toBe(false);
      const { fetchImpl } = fakeFetch((url) =>
        url.pathname.includes('fomccalendars') ? text(literal) : json({ release_dates: [], count: 0 }),
      );
      const fomc = await fetchFomcMeetings({ fetchImpl });
      expect(fomc.meetings).toEqual([]);
      expect(fomc.failed).toContain('partial');
    });
  });

  describe('R9-4: an attribute on the year anchor does not make FOMC fail closed', () => {
    const attributed = excerpt.replace(
      /<h4><a>(\d{4}) FOMC Meetings<\/a><\/h4>/g,
      '<h4><a id="42828" name="$1">$1 FOMC Meetings</a></h4>',
    );

    it('an attributed year anchor parses to the same 16 meetings with no failure, and the page is accepted', async () => {
      expect(attributed).not.toBe(excerpt);
      const page = parseFomcCalendarPage(attributed);
      expect(page.failures).toEqual([]);
      expect(page.meetings).toEqual(parseFomcCalendarHtml(excerpt));
      const { fetchImpl } = fakeFetch((url) =>
        url.pathname.includes('fomccalendars') ? text(attributed) : json({ release_dates: [], count: 0 }),
      );
      const fomc = await fetchFomcMeetings({ fetchImpl });
      expect(fomc.failed).toBeUndefined();
      expect(fomc.meetings).toHaveLength(16);
    });

    it('control: an attributed anchor with a reworded heading is still a partial page', () => {
      const reworded = attributed.replace('2027 FOMC Meetings', '2027 FOMC Meeting');
      expect(reworded).not.toBe(attributed);
      const page = parseFomcCalendarPage(reworded);
      expect(page.meetings).toEqual([]);
      expect(page.failures.join(' ')).toContain('year heading');
    });
  });

  describe('F1 (R9-1 pinned): rule (d) and the 100-day upper bound of rule (b)', () => {
    const outcome = async (html: string) => {
      const { fetchImpl } = fakeFetch((url) =>
        url.pathname.includes('fomccalendars') ? text(html) : json({ release_dates: [], count: 0 }),
      );
      return fetchFomcMeetings({ fetchImpl });
    };

    it('F1 (a): the end cell "27-Nov 3" under October is accepted by the row parse (R9-2) and refused by rule (d)', async () => {
      const oct = excerpt.indexOf('<strong>October</strong>');
      const cell = excerpt.indexOf('>27-28<', oct);
      expect(oct).toBeGreaterThan(-1);
      expect(cell).toBeGreaterThan(oct);
      const sevenDays = excerpt.slice(0, cell) + '>27-Nov 3<' + excerpt.slice(cell + '>27-28<'.length);
      const parsed = parseFomcCalendarPage(sevenDays);
      expect(parsed.failures).toEqual([]);
      expect(parsed.meetings).toContainEqual({ start: '2026-10-27', decision: '2026-11-03', sep: false });
      const fomc = await outcome(sevenDays);
      expect(fomc.meetings).toEqual([]);
      expect(fomc.failed).toContain('partial');
      expect(fomc.warnings.join(' ')).toContain('plausibility rule (d)');
    });

    it('F1 (b): two adjacent meetings omitted, a 133-day gap, is partial under the 100-day upper bound', async () => {
      // Synthetic. One omitted meeting cannot open a gap above 100 days on this schedule (the widest
      // one-omission gap is 98 days), so two adjacent meetings are blanked: the September and October 2026
      // date cells. The labels stay; a blank cell is not a meeting. Gap from 2026-07-28 to 2026-12-08 is 133.
      // 2026 keeps 6 meetings, inside 6 to 10, so only rule (b) can see it.
      const sep = excerpt.indexOf('<strong>September</strong>');
      const sepCell = excerpt.indexOf('>15-16*<', sep);
      expect(sepCell).toBeGreaterThan(sep);
      const noSep = excerpt.slice(0, sepCell) + '><' + excerpt.slice(sepCell + '>15-16*<'.length);
      const oct = noSep.indexOf('<strong>October</strong>');
      const octCell = noSep.indexOf('>27-28<', oct);
      expect(octCell).toBeGreaterThan(oct);
      const omitted = noSep.slice(0, octCell) + '><' + noSep.slice(octCell + '>27-28<'.length);
      const parsed = parseFomcCalendarPage(omitted);
      expect(parsed.failures).toEqual([]);
      expect(parsed.meetings).toHaveLength(14);
      const fomc = await outcome(omitted);
      expect(fomc.meetings).toEqual([]);
      expect(fomc.failed).toContain('partial');
      expect(fomc.warnings.join(' ')).toContain('plausibility rule (b)');
    });
  });

  describe('F2 (R9-1 pinned): a footnote marker does not change a correct page', () => {
    it('F2: a <sup>1</sup> footnote beside a month label leaves the 16 meetings and the outcome unchanged', async () => {
      const footnoted = excerpt.replace(
        '<strong>January</strong>',
        '<strong>January</strong><sup>1</sup>',
      );
      expect(footnoted).not.toBe(excerpt);
      expect(parseFomcCalendarHtml(footnoted)).toEqual(parseFomcCalendarHtml(excerpt));
      const { fetchImpl } = fakeFetch((url) =>
        url.pathname.includes('fomccalendars') ? text(footnoted) : json({ release_dates: [], count: 0 }),
      );
      const fomc = await fetchFomcMeetings({ fetchImpl });
      expect(fomc.failed).toBeUndefined();
      expect(fomc.meetings).toHaveLength(16);
    });
  });

  describe('R9-2: an explicit end month must be the label\'s second month', () => {
    const page = (label: string, cell: string): string =>
      [
        '<div class="panel-heading"><h4><a>2026 FOMC Meetings</a></h4></div>',
        `<div class="fomc-meeting__month col-xs-5"><strong>${label}</strong></div>`,
        `<div class="fomc-meeting__date col-xs-4">${cell}</div>`,
      ].join('\n');

    it('"27-Sep 28" under October is a failure: the end month does not match the label', () => {
      const parsed = parseFomcCalendarPage(page('October', '27-Sep 28'));
      expect(parsed.meetings).toEqual([]);
      expect(parsed.failures).toHaveLength(1);
      expect(parsed.failures[0]).toContain('does not match the label');
    });

    it('"30-Jun 1" under Apr/May is a failure: the second name is May', () => {
      const parsed = parseFomcCalendarPage(page('Apr/May', '30-Jun 1'));
      expect(parsed.meetings).toEqual([]);
      expect(parsed.failures[0]).toContain('does not match the label');
    });

    it('control: under October, "27-Oct 28" (the label month) and "30-Nov 1" (the next month) are accepted', () => {
      expect(parseFomcCalendarHtml(page('October', '27-Oct 28'))).toEqual([
        { start: '2026-10-27', decision: '2026-10-28', sep: false },
      ]);
      expect(parseFomcCalendarHtml(page('October', '30-Nov 1'))).toEqual([
        { start: '2026-10-30', decision: '2026-11-01', sep: false },
      ]);
    });
  });

  it('R2-1: an unmatched month label fails its row with a warning; the previous month never carries over', () => {
    // "Octobr" is not a month. The 2026-10-27..28 row must fail, not be re-dated into September.
    const broken = excerpt.replace('<strong>October</strong>', '<strong>Octobr</strong>');
    expect(broken).not.toBe(excerpt);
    const page = parseFomcCalendarPage(broken);
    expect(page.failures).toHaveLength(1);
    expect(page.failures[0]).toContain('Octobr');
    // Every other meeting is unchanged; the September meeting stays on 2026-09-15..16.
    expect(page.meetings).toEqual(
      parseFomcCalendarHtml(excerpt).filter((m) => m.decision !== '2026-10-28'),
    );
    expect(page.meetings.some((m) => m.decision === '2026-09-28')).toBe(false);
  });

  it('R2-1: a row with an empty month label and a wrapping cell (30-1) fails; it is not dated from the previous month', () => {
    const html = [
      '<div class="panel-heading"><h4><a>2026 FOMC Meetings</a></h4></div>',
      '<div class="fomc-meeting__month col-xs-5"><strong>November</strong></div>',
      '<div class="fomc-meeting__date col-xs-4">6-7</div>',
      '<div class="fomc-meeting__month col-xs-5"><strong></strong></div>',
      '<div class="fomc-meeting__date col-xs-4">30-1</div>',
    ].join('\n');
    const page = parseFomcCalendarPage(html);
    expect(page.meetings).toEqual([{ start: '2026-11-06', decision: '2026-11-07', sep: false }]);
    expect(page.failures).toHaveLength(1);
    expect(page.failures[0]).toContain('30-1');
  });

  it('R2-1: an abbreviation with a trailing period ("Oct.") is October (control)', () => {
    const page = parseFomcCalendarPage(
      excerpt.replace('<strong>October</strong>', '<strong>Oct.</strong>'),
    );
    expect(page.failures).toEqual([]);
    expect(page.meetings.some((m) => m.decision === '2026-10-28')).toBe(true);
  });

  it('R2-1: the live "(notation vote)" row is a known non-meeting and is skipped, not a failure', () => {
    const html = [
      '<div class="panel-heading"><h4><a>2025 FOMC Meetings</a></h4></div>',
      '<div class="fomc-meeting__month col-xs-5"><strong>August</strong></div>',
      '<div class="fomc-meeting__date col-xs-4">22 (notation vote)</div>',
    ].join('\n');
    expect(parseFomcCalendarPage(html)).toEqual({ meetings: [], failures: [] });
  });

  it('R2-1: a partial page (one failed row) is rejected: fomc is not ok and no FOMC rows are returned', async () => {
    const broken = excerpt.replace('<strong>October</strong>', '<strong>Octobr</strong>');
    const { fetchImpl } = fakeFetch(() => text(broken));
    const fomc = await fetchFomcMeetings({ fetchImpl });
    expect(fomc.failed).toContain('partial');
    expect(fomc.meetings).toEqual([]);
    const { fetchImpl: calendarFetch } = fakeFetch((url) =>
      url.pathname.includes('fomccalendars') ? text(broken) : json({ release_dates: [], count: 0 }),
    );
    const result = await fetchA10Calendar({
      today: '2026-10-24',
      windowDays: 60,
      fetchImpl: calendarFetch,
    });
    expect(result.kindsOk).not.toContain('fomc');
    expect(result.rows.some((r) => r.kind === 'fomc')).toBe(false);
    expect(result.fomcFailure).toContain('partial');
  });

  it('R2-8: when the fallback does not reach the window and the page is down, fomc is not ok (not replaced, no rows)', async () => {
    const { fetchImpl } = fakeFetch(() => text('down', 503));
    const result = await fetchA10Calendar({ today: '2027-12-15', windowDays: 60, fetchImpl });
    expect(result.kindsOk).not.toContain('fomc');
    expect(result.rows.some((r) => r.kind === 'fomc')).toBe(false);
    expect(result.fomcFailure).toContain('no FOMC meeting falls in the window');
    expect(result.warnings.join(' ')).toContain('fomc is not replaced');
  });

  it('R2-8 control: the same page outage inside the fallback coverage keeps fomc ok', async () => {
    const { fetchImpl } = fakeFetch(() => text('down', 503));
    const result = await fetchA10Calendar({ today: '2026-10-24', windowDays: 60, fetchImpl });
    expect(result.kindsOk).toContain('fomc');
    expect(result.fomcFailure).toBeUndefined();
  });

  it('F4: the live 2024 block (Apr/May label, date 30-1) gives Apr 30 to May 1 and keeps every meeting', () => {
    const meetings = parseFomcCalendarHtml(fixtureText('SAMPLE_fomc_calendar_2024_excerpt.html'));
    expect(meetings).toEqual([
      { start: '2024-01-30', decision: '2024-01-31', sep: false },
      { start: '2024-03-19', decision: '2024-03-20', sep: true },
      { start: '2024-04-30', decision: '2024-05-01', sep: false },
      { start: '2024-06-11', decision: '2024-06-12', sep: true },
      { start: '2024-07-30', decision: '2024-07-31', sep: false },
      { start: '2024-09-17', decision: '2024-09-18', sep: true },
      { start: '2024-11-06', decision: '2024-11-07', sep: false },
      { start: '2024-12-17', decision: '2024-12-18', sep: true },
    ]);
  });

  it('R7-5: under an Apr/May label a non-wrapping cell 28-29 is Apr 28 to Apr 29 (not May 29)', () => {
    const html = [
      '<div class="panel-heading"><h4><a>2024 FOMC Meetings</a></h4></div>',
      '<div class="fomc-meeting__month col-xs-5"><strong>Apr/May</strong></div>',
      '<div class="fomc-meeting__date col-xs-4">28-29</div>',
    ].join('\n');
    expect(parseFomcCalendarHtml(html)).toEqual([
      { start: '2024-04-28', decision: '2024-04-29', sep: false },
    ]);
  });

  it('R7-5: under an Apr/May label the wrapping cell 30-1 is still Apr 30 to May 1 (control)', () => {
    const html = [
      '<div class="panel-heading"><h4><a>2024 FOMC Meetings</a></h4></div>',
      '<div class="fomc-meeting__month col-xs-5"><strong>Apr/May</strong></div>',
      '<div class="fomc-meeting__date col-xs-4">30-1</div>',
    ].join('\n');
    expect(parseFomcCalendarHtml(html)).toEqual([
      { start: '2024-04-30', decision: '2024-05-01', sep: false },
    ]);
  });

  it('F4: an "X/Y" label whose meeting ends in the next year rolls the decision date into that year', () => {
    const html = [
      '<div class="panel-heading"><h4><a>2024 FOMC Meetings</a></h4></div>',
      '<div class="fomc-meeting__month col-xs-5"><strong>Dec/Jan</strong></div>',
      '<div class="fomc-meeting__date col-xs-4">28-2</div>',
    ].join('\n');
    expect(parseFomcCalendarHtml(html)).toEqual([
      { start: '2024-12-28', decision: '2025-01-02', sep: false },
    ]);
  });

  it('a meeting that crosses a month boundary ends in the next month', () => {
    const html = [
      '<div class="panel-heading"><h4><a>2026 FOMC Meetings</a></h4></div>',
      '<div class="fomc-meeting__month col-xs-5"><strong>April</strong></div>',
      '<div class="fomc-meeting__date col-xs-4">30-May 1</div>',
    ].join('\n');
    expect(parseFomcCalendarHtml(html)).toEqual([
      { start: '2026-04-30', decision: '2026-05-01', sep: false },
    ]);
  });

  it('a page that parses too thin, or fails, falls back to the maintained JSON', async () => {
    const thin = fakeFetch(() => text('<html></html>'));
    const fromThin = await fetchFomcMeetings({ fetchImpl: thin.fetchImpl });
    expect(fromThin.source).toBe('fomc-fallback.json');
    expect(fromThin.warnings.join(' ')).toContain('using fallback');

    const down = fakeFetch(() => text('down', 503));
    const fromDown = await fetchFomcMeetings({ fetchImpl: down.fetchImpl });
    expect(fromDown.source).toBe('fomc-fallback.json');
    expect(fromDown.meetings.length).toBeGreaterThan(0);
  });

  it('FRED release dates: parses the release and rejects a row for another release', () => {
    const cpi = releases['10'];
    expect(parseFredReleaseDates(cpi, 10)).toEqual(['2026-11-13', '2026-12-10']);
    expect(() => parseFredReleaseDates(cpi, 50)).toThrow(/different release/);
  });

  it('the next 30 days: FOMC, CPI, payrolls, ETF and unlock rows inside the window, nothing after it', async () => {
    const { fetchImpl } = fakeFetch((url) => {
      if (url.pathname.includes('fomccalendars')) return text(excerpt);
      const id = url.searchParams.get('release_id') ?? '';
      return json(releases[id] ?? { release_dates: [] });
    });
    const unlock: CalendarRow = {
      date: '2026-11-10',
      kind: 'unlock',
      title: 'SAMPLE token unlock',
      assetId: 'eth',
      asOf: '2026-10-24',
      source: 'sample',
    };
    const result = await fetchA10Calendar({
      today: '2026-10-24',
      windowDays: 30,
      fetchImpl,
      fredApiKey: 'SAMPLE-KEY-A10',
      etfDecisionsJson: etf,
      unlockEntries: [unlock],
      fomcUrl: FOMC_CALENDAR_URL,
    });
    expect(result.warnings).toEqual([]);
    expect(result.rows.map((r) => `${r.date} ${r.kind}`)).toEqual([
      '2026-10-28 fomc',
      '2026-11-03 etf',
      '2026-11-06 payrolls',
      '2026-11-10 unlock',
      '2026-11-13 cpi',
      '2026-11-20 etf',
    ]);
    expect(result.rows.every((r) => r.date >= '2026-10-24' && r.date <= '2026-11-23')).toBe(true);
    expect(result.rows.find((r) => r.kind === 'fomc')?.title).toBe('FOMC rate decision');
  });

  it('calls the FRED release-dates endpoint with the include-no-data flag and the three release ids', async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url.pathname.includes('fomccalendars')) return text(excerpt);
      return json(releases[url.searchParams.get('release_id') ?? ''] ?? { release_dates: [] });
    });
    await fetchA10Calendar({ today: '2026-10-24', fetchImpl, fredApiKey: 'SAMPLE-KEY-A10' });
    const releaseCalls = calls
      .map((c) => new URL(c.url))
      .filter((u) => u.pathname.endsWith('/release/dates'));
    expect(releaseCalls.map((u) => u.searchParams.get('release_id'))).toEqual(['10', '50', '54']);
    for (const u of releaseCalls) {
      expect(u.searchParams.get('include_release_dates_with_no_data')).toBe('true');
    }
  });

  it('without FRED_API_KEY the CPI, payroll and PCE rows are skipped with a warning and FOMC is still stored', async () => {
    const { fetchImpl, calls } = fakeFetch(() => text(excerpt));
    const result = await fetchA10Calendar({
      today: '2026-10-24',
      windowDays: 30,
      fetchImpl,
      etfDecisionsJson: etf,
    });
    expect(calls.every((c) => !c.url.includes('/release/dates'))).toBe(true);
    expect(result.warnings).toContain('A10 CPI, payrolls and PCE skipped: FRED_API_KEY is not set');
    expect(result.rows.some((r) => r.kind === 'fomc')).toBe(true);
  });

  it('a bad admin ETF file is rejected as a whole and reported, the other rows still store', async () => {
    const { fetchImpl } = fakeFetch(() => text(excerpt));
    const result = await fetchA10Calendar({
      today: '2026-10-24',
      windowDays: 30,
      fetchImpl,
      etfDecisionsJson: [
        { date: '2026-11-03', title: 'fine' },
        { date: '2026-13-40', title: 'bad date' },
      ],
    });
    expect(result.warnings.join(' ')).toContain('entry 1: date must be YYYY-MM-DD');
    expect(result.rows.some((r) => r.kind === 'etf')).toBe(false);
    expect(result.rows.some((r) => r.kind === 'fomc')).toBe(true);
  });

  it('ETF entries need a lowercase asset id or null', () => {
    expect(() =>
      parseEtfDecisionEntries([{ date: '2026-11-03', title: 'x', asset_id: 'BTC Upper' }]),
    ).toThrow(/asset_id/);
    expect(() => parseEtfDecisionEntries({ not: 'an array' })).toThrow(/JSON array/);
    expect(parseEtfDecisionEntries(etf)).toHaveLength(2);
  });

  it('F5: a count above the rows returned fails the release (no partial list)', () => {
    const truncated = fixture<Record<string, unknown>>(
      'SAMPLE_fred_release_dates_count_mismatch.json',
    );
    expect(() => parseFredReleaseDates(truncated, 54)).toThrow(
      /lists 2 of 3 release dates; refusing a partial list/,
    );
  });

  it('F5: a response without a valid count cannot confirm a complete list', () => {
    expect(() => parseFredReleaseDates({ release_dates: [] }, 54)).toThrow(/no valid count/);
  });

  it('F5: release-dates requests set order_by=release_date and an explicit limit', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json(fixture<Record<string, unknown>>('SAMPLE_fred_release_dates.json')['50']),
    );
    await fetchFredReleaseDates({
      apiKey: 'SAMPLE-KEY-F5',
      releaseId: 50,
      from: '2026-10-24',
      to: '2026-12-23',
      fetchImpl,
    });
    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('order_by')).toBe('release_date');
    expect(url.searchParams.get('limit')).toBe(String(FRED_RELEASE_DATES_LIMIT));
    expect(url.searchParams.get('sort_order')).toBe('asc');
  });

  it('F3: FRED release 54 HTTP 503 leaves pce out of kindsOk and out of the rows', async () => {
    const { fetchImpl } = fakeFetch((url) => {
      if (url.pathname.includes('fomccalendars')) return text(excerpt);
      if (url.searchParams.get('release_id') === '54') return text('unavailable', 503);
      return json(releases[url.searchParams.get('release_id') ?? ''] ?? {});
    });
    const result = await fetchA10Calendar({
      today: '2026-10-24',
      windowDays: 60,
      fetchImpl,
      fredApiKey: 'SAMPLE-KEY-F3',
    });
    expect(result.kindsOk).toEqual(['fomc', 'cpi', 'payrolls']);
    expect(result.rows.some((r) => r.kind === 'pce')).toBe(false);
    expect(result.warnings).toEqual(['fred:release/dates:54: HTTP 503']);
    expect(result.from).toBe('2026-10-24');
    expect(result.to).toBe('2026-12-23');
  });

  it('F3: kindsOk lists only the sources that ran: no FRED key, no ETF file, no unlock list', async () => {
    const { fetchImpl } = fakeFetch(() => text(excerpt));
    const result = await fetchA10Calendar({ today: '2026-10-24', fetchImpl });
    expect(result.kindsOk).toEqual(['fomc']);
  });

  it('F3: a configured ETF file and an unlock list (even empty) count as succeeded', async () => {
    const { fetchImpl } = fakeFetch(() => text(excerpt));
    const result = await fetchA10Calendar({
      today: '2026-10-24',
      fetchImpl,
      etfDecisionsJson: etf,
      unlockEntries: [],
    });
    expect(result.kindsOk).toEqual(['fomc', 'etf', 'unlock']);
  });

  it('an unlock input of another kind is ignored with a warning', async () => {
    const { fetchImpl } = fakeFetch(() => text(excerpt));
    const result = await fetchA10Calendar({
      today: '2026-10-24',
      windowDays: 30,
      fetchImpl,
      unlockEntries: [
        {
          date: '2026-10-25',
          kind: 'fomc',
          title: 'wrong kind',
          assetId: null,
          asOf: '2026-10-24',
          source: 's',
        },
      ],
    });
    expect(result.rows.some((r) => r.title === 'wrong kind')).toBe(false);
    expect(result.warnings.join(' ')).toContain('ignored');
  });
});

// Live smoke. Runs only when COINSNIPE_LIVE_SMOKE=1, so CI stays offline. The FRED leg also
// needs FRED_API_KEY set in the environment (exported from a secret store, never inlined).
// Command: COINSNIPE_LIVE_SMOKE=1 pnpm --filter @coinsnipe/data test -- macro
const LIVE = process.env['COINSNIPE_LIVE_SMOKE'] === '1';
const LIVE_FRED_KEY = process.env['FRED_API_KEY'];
const liveFetch: FetchLike = (url, init) => fetch(url, init);

describe.skipIf(!LIVE)('live smoke (COINSNIPE_LIVE_SMOKE=1)', () => {
  it('D3: alternative.me returns a full history with values in range', async () => {
    const rows = await fetchD3FearGreed({ fetchImpl: liveFetch });
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.every((r) => r.value >= 0 && r.value <= 100)).toBe(true);
  });

  it('A10: the Fed FOMC page parses to the live schedule (no key needed)', async () => {
    const result = await fetchFomcMeetings({ fetchImpl: liveFetch });
    expect(result.source).toBe('federalreserve.gov');
    expect(result.meetings.some((m) => m.decision.startsWith('2026-10-28'))).toBe(true);
  });

  it('A7: CoinGecko public route returns a gold proxy (no key needed)', async () => {
    const result = await fetchA7GoldProxy({
      config: MACRO_CONFIG_DEFAULTS,
      from: '2000-01-01',
      to: '2100-01-01',
      fetchImpl: liveFetch,
    });
    expect(result.rows.length).toBeGreaterThan(30);
  });

  it.skipIf(!LIVE_FRED_KEY)(
    'FRED: every core series and the A8 composite (needs FRED_API_KEY)',
    async () => {
      const result = await fetchFredMacroRows({
        apiKey: LIVE_FRED_KEY ?? '',
        to: new Date().toISOString().slice(0, 10),
        fetchImpl: liveFetch,
      });
      expect(result.rows.some((r) => r.seriesId === 'NASDAQCOM')).toBe(true);
      expect(result.rows.some((r) => r.seriesId === 'M2SL')).toBe(true);
    },
  );
});
