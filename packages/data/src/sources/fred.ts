/**
 * FRED adapter (St. Louis Fed API) plus the two macro inputs built from it: the A8 broad-money
 * approximation (not a global M2 series) and the A7 gold proxy (CoinGecko PAXG/XAUT).
 *
 * Series are grouped by master-plan ID (A4, A6, A7, A8). Methodology, licence notes and the
 * live-smoke command: packages/data/docs/macro-sentiment-methodology.md.
 *
 * The API key is read only from the FRED_API_KEY env var by the caller. It is never logged,
 * and error messages never include the request URL.
 */
import {
  addUtcDays,
  asOfFor,
  type AsOfRule,
  type AsOfSetting,
  DEFAULT_AS_OF_RULE,
  dayNumberToIso,
  fetchJson,
  isIsoDate,
  isoToDayNumber,
  isRecord,
  PUBLICATION_LAG_DAYS,
  SourceError,
  utcDaysBetween,
  type FetchLike,
} from './shared';

export const FRED_SOURCE = 'fred';
/** Attribution FRED requires next to any use of its data (licensing check, CSN-071). */
export const FRED_ATTRIBUTION =
  'This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.';
export const FRED_TERMS_URL = 'https://fred.stlouisfed.org/docs/api/terms_of_use.html';
const FRED_API_BASE = 'https://api.stlouisfed.org/fred';

export const A7_GOLD_PROXY_SERIES_ID = 'A7_GOLD_PROXY_USD';
export const A8_APPROXIMATION_SERIES_ID = 'A8_GLOBAL_M2_APPROX';
/** Source label on every A8 row (spec label: flagged 'approximation'). */
export const A8_APPROXIMATION_SOURCE =
  'approximation:fred global M2 approximation (US M2SL, EA, JP, CN, UK)';
/**
 * Caveat that travels with the composite. The spec's EA, JP and UK IDs are M3 (broad money) on
 * FRED, and the true M2 series for EA and JP end in early 2017. The composite is approximate.
 */
export const A8_CAVEAT =
  'Approximate: the EA, JP and UK series are M3 (broad money) on FRED, not M2. True M2 for EA and JP ends in 2017 (MYAGM2EZM196N Mar 2017, MYAGM2JPM189N Feb 2017). No UK M2 series was found. The composite is stale after 2019-10-02.';
/** FRED's OECD-based "189" series are in national-currency units, not millions or billions. */
const LOCAL_UNITS_PER_BILLION = 1e9;

export type MacroFrequency = 'daily' | 'monthly';
export type GlobalM2Area = 'US' | 'EA' | 'JP' | 'CN' | 'GB';

export interface FredObservation {
  /** Observation date, YYYY-MM-DD. */
  readonly date: string;
  readonly value: number;
}

/** One row ready for macro_daily. Matches the MacroDaily model (value is a Decimal in the DB). */
export interface MacroDailyRow {
  readonly seriesId: string;
  readonly date: string;
  readonly value: number;
  readonly asOf: string;
  readonly source: string;
}

export interface MacroFetchResult {
  readonly rows: MacroDailyRow[];
  /** Per-series or per-step problems. Each one names its series and never carries a key. */
  readonly warnings: string[];
}

export interface FredSeriesSpec {
  readonly id: string;
  readonly planId: 'A4' | 'A6' | 'A7' | 'A8';
  readonly label: string;
  readonly frequency: MacroFrequency;
  /** Licensed series are fetched only when the matching config flag is on (CSN-071). */
  readonly licensed: boolean;
}

/** Every FRED series the macro job reads, grouped by master-plan ID. */
export const FRED_CORE_SERIES: readonly FredSeriesSpec[] = [
  {
    id: 'NASDAQCOM',
    planId: 'A4',
    label: 'Nasdaq Composite index',
    frequency: 'daily',
    licensed: false,
  },
  { id: 'SP500', planId: 'A4', label: 'S&P 500 index', frequency: 'daily', licensed: false },
  {
    id: 'VIXCLS',
    planId: 'A4',
    label: 'VIX (inverted in A4). Cboe copyright: off unless includeLicensedVix',
    frequency: 'daily',
    licensed: true,
  },
  {
    id: 'DTWEXBGS',
    planId: 'A6',
    label: 'Broad US dollar index, DXY proxy (the true DXY is ICE-licensed)',
    frequency: 'daily',
    licensed: false,
  },
  {
    id: 'DGS10',
    planId: 'A6',
    label: 'US 10-year Treasury yield, percent (inverted in A6)',
    frequency: 'daily',
    licensed: false,
  },
  {
    id: 'DCOILWTICO',
    planId: 'A7',
    label: 'WTI crude oil, USD per barrel',
    frequency: 'daily',
    licensed: false,
  },
  {
    id: 'M2SL',
    planId: 'A8',
    label: 'US M2 money stock, USD billions',
    frequency: 'monthly',
    licensed: false,
  },
  {
    id: 'MABMM301EZM189S',
    planId: 'A8',
    label: 'Euro area M2, euro units (OECD via FRED)',
    frequency: 'monthly',
    licensed: false,
  },
  {
    id: 'MABMM301JPM189S',
    planId: 'A8',
    label: 'Japan M2, yen units (OECD via FRED)',
    frequency: 'monthly',
    licensed: false,
  },
  {
    id: 'MYAGM2CNM189N',
    planId: 'A8',
    label: 'China M2, yuan units (OECD via FRED)',
    frequency: 'monthly',
    licensed: false,
  },
  {
    id: 'MABMM301GBM189S',
    planId: 'A8',
    label: 'UK M2, pound units (OECD via FRED)',
    frequency: 'monthly',
    licensed: false,
  },
  {
    id: 'DEXUSEU',
    planId: 'A8',
    label: 'USD per euro (FX for A8)',
    frequency: 'daily',
    licensed: false,
  },
  {
    id: 'DEXJPUS',
    planId: 'A8',
    label: 'Yen per USD (FX for A8)',
    frequency: 'daily',
    licensed: false,
  },
  {
    id: 'DEXCHUS',
    planId: 'A8',
    label: 'Yuan per USD (FX for A8)',
    frequency: 'daily',
    licensed: false,
  },
  {
    id: 'DEXUSUK',
    planId: 'A8',
    label: 'USD per pound (FX for A8)',
    frequency: 'daily',
    licensed: false,
  },
];

export interface GlobalM2Component {
  readonly area: GlobalM2Area;
  readonly seriesId: string;
  /** usd-billions for M2SL; local-units for the national-currency series. */
  readonly unit: 'usd-billions' | 'local-units';
  readonly fxSeriesId?: string;
  /**
   * usd-per-unit: USD = local * FX (EUR and GBP are quoted as USD per unit).
   * unit-per-usd: USD = local / FX (JPY and CNY are quoted as units per USD).
   */
  readonly fxQuote?: 'usd-per-unit' | 'unit-per-usd';
}

export const A8_COMPONENTS: readonly GlobalM2Component[] = [
  { area: 'US', seriesId: 'M2SL', unit: 'usd-billions' },
  {
    area: 'EA',
    seriesId: 'MABMM301EZM189S',
    unit: 'local-units',
    fxSeriesId: 'DEXUSEU',
    fxQuote: 'usd-per-unit',
  },
  {
    area: 'JP',
    seriesId: 'MABMM301JPM189S',
    unit: 'local-units',
    fxSeriesId: 'DEXJPUS',
    fxQuote: 'unit-per-usd',
  },
  {
    area: 'CN',
    seriesId: 'MYAGM2CNM189N',
    unit: 'local-units',
    fxSeriesId: 'DEXCHUS',
    fxQuote: 'unit-per-usd',
  },
  {
    area: 'GB',
    seriesId: 'MABMM301GBM189S',
    unit: 'local-units',
    fxSeriesId: 'DEXUSUK',
    fxQuote: 'usd-per-unit',
  },
];

export interface MacroSourceConfig {
  /** First observation date requested from FRED and the first day written. */
  readonly startDate: string;
  /** CSN-071: VIXCLS is Cboe copyright and has no licence yet. Off by default. */
  readonly includeLicensedVix: boolean;
  readonly a7Gold: {
    readonly enabled: boolean;
    /** CoinGecko ids: pax-gold (PAXG) and tether-gold (XAUT). Daily value = mean of coins with a price. */
    readonly coinIds: readonly string[];
    /** CoinGecko market_chart window in days. 365 is the Demo limit. */
    readonly days: number;
  };
  /** Forward-fill cap for monthly series. A monthly value stops being used this many days after its observation date. */
  readonly monthlyMaxFillDays: number;
  /** Bridge for FX holidays when the FX series is aligned to a monthly day. */
  readonly fxMaxFillDays: number;
  /** Plausibility band for each A8 component in USD billions. Catches unit mistakes. */
  readonly a8PlausibleUsdBnRange: readonly [number, number];
  /** Areas dropped from the A8 composite (flag). Dropping an area changes what the number means. */
  readonly a8ExcludeAreas: readonly GlobalM2Area[];
  /**
   * How as_of is written (D1). 'observation-date' (default, the spec rule): as_of = observation date.
   * 'publication-lag' (opt-in): observation date + lag.
   */
  readonly asOfRule: AsOfRule;
  /** Publication lag in days per series key. Defaults from PUBLICATION_LAG_DAYS in shared.ts. */
  readonly publicationLagDays: Readonly<Record<string, number>>;
}

export const MACRO_CONFIG_DEFAULTS: MacroSourceConfig = {
  startDate: '2000-01-01',
  includeLicensedVix: false,
  a7Gold: { enabled: true, coinIds: ['pax-gold', 'tether-gold'], days: 365 },
  monthlyMaxFillDays: 62,
  fxMaxFillDays: 7,
  a8PlausibleUsdBnRange: [100, 500_000],
  a8ExcludeAreas: [],
  asOfRule: DEFAULT_AS_OF_RULE,
  publicationLagDays: PUBLICATION_LAG_DAYS,
};

/** Result of the A8 composite. lastCompleteDate is the last day with a full set of areas. */
export interface A8Status {
  readonly lastCompleteDate: string | null;
  /** True when lastCompleteDate is earlier than `to` minus monthlyMaxFillDays (F1). */
  readonly stale: boolean;
}

const NO_COMPOSITE: A8Status = { lastCompleteDate: null, stale: true };

/** fetchFredMacroRows result: rows, warnings and the A8 status (F1). */
export interface FredMacroResult extends MacroFetchResult {
  readonly a8: A8Status;
  /** Core series requested (licensed series skipped by config are not counted) and answered. R5-2. */
  readonly seriesRequested: number;
  readonly seriesOk: number;
}

/** Publication lag for a series key. A missing key fails the series rather than guessing. */
function lagFor(config: MacroSourceConfig, key: string): number {
  // Under the spec rule (observation-date) no lag applies, so no lag lookup is needed.
  if (config.asOfRule === 'observation-date') return 0;
  const lag = config.publicationLagDays[key];
  if (lag === undefined) {
    throw new SourceError(FRED_SOURCE, `no publication lag configured for ${key}`);
  }
  return lag;
}

/**
 * As-of setting for one series key, read from the config (D1, R3-3). Fear & Greed and GPR use
 * this too, so the config flag governs every adapter.
 */
export function asOfSettingFrom(config: MacroSourceConfig, key: string): AsOfSetting {
  return { rule: config.asOfRule, lagDays: lagFor(config, key) };
}

/** Apply the as_of rule to every point of an expanded series (D1). Forward-fill is unchanged. */
function withPublicationLag(
  points: Map<string, { value: number; asOf: string }>,
  lagDays: number,
  rule: AsOfRule,
): Map<string, { value: number; asOf: string }> {
  const out = new Map<string, { value: number; asOf: string }>();
  for (const [date, point] of points) {
    out.set(date, { value: point.value, asOf: asOfFor(point.asOf, lagDays, rule) });
  }
  return out;
}

/** Parse a FRED observations payload. Missing values ("." in FRED) are dropped. */
export function parseFredObservations(json: unknown, seriesId: string): FredObservation[] {
  const fail = (detail: string): never => {
    throw new SourceError(`${FRED_SOURCE}:${seriesId}`, detail);
  };
  if (!isRecord(json) || !Array.isArray(json.observations)) {
    return fail('unexpected payload shape');
  }
  const out: FredObservation[] = [];
  for (const item of json.observations as unknown[]) {
    if (!isRecord(item) || typeof item.date !== 'string' || !isIsoDate(item.date)) {
      return fail('observation has no valid date');
    }
    if (typeof item.value !== 'string') return fail('observation value is not a string');
    if (item.value === '.') continue;
    if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(item.value)) {
      return fail('observation value is not numeric');
    }
    out.push({ date: item.date, value: Number(item.value) });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

export async function fetchFredSeries(options: {
  readonly seriesId: string;
  readonly apiKey: string;
  readonly startDate: string;
  readonly fetchImpl: FetchLike;
}): Promise<FredObservation[]> {
  const params = new URLSearchParams({
    series_id: options.seriesId,
    api_key: options.apiKey,
    file_type: 'json',
    observation_start: options.startDate,
    sort_order: 'asc',
  });
  const json = await fetchJson(
    options.fetchImpl,
    `${FRED_API_BASE}/series/observations?${params.toString()}`,
    { source: `${FRED_SOURCE}:${options.seriesId}` },
  );
  return parseFredObservations(json, options.seriesId);
}

/**
 * Turn a sorted observation list into one point per calendar day in [from, to].
 * Daily series: only the exact observation days are kept (no fill).
 * Monthly series: each day takes the latest observation on or before it, with asOf set to
 * that observation's date. A value stops being used after maxFillDays.
 */
export function expandToDaily(
  observations: readonly FredObservation[],
  options: { from: string; to: string; forwardFill: boolean; maxFillDays: number },
): Map<string, { value: number; asOf: string }> {
  const out = new Map<string, { value: number; asOf: string }>();
  let pointer = 0;
  let current: FredObservation | undefined;
  const lastDay = isoToDayNumber(options.to);
  for (let day = isoToDayNumber(options.from); day <= lastDay; day++) {
    const iso = dayNumberToIso(day);
    for (;;) {
      const next = observations[pointer];
      if (!next || next.date > iso) break;
      current = next;
      pointer++;
    }
    if (!current) continue;
    if (!options.forwardFill) {
      if (current.date === iso) out.set(iso, { value: current.value, asOf: current.date });
      continue;
    }
    if (utcDaysBetween(current.date, iso) <= options.maxFillDays) {
      out.set(iso, { value: current.value, asOf: current.date });
    }
  }
  return out;
}

function seriesRows(
  spec: FredSeriesSpec,
  observations: readonly FredObservation[],
  config: MacroSourceConfig,
  to: string,
): MacroDailyRow[] {
  const daily = expandToDaily(observations, {
    from: config.startDate,
    to,
    forwardFill: spec.frequency === 'monthly',
    maxFillDays: config.monthlyMaxFillDays,
  });
  const lagged = withPublicationLag(daily, lagFor(config, spec.id), config.asOfRule);
  return [...lagged].map(([date, point]) => ({
    seriesId: spec.id,
    date,
    value: point.value,
    asOf: point.asOf,
    source: FRED_SOURCE,
  }));
}

/**
 * A8 global M2 approximation, USD billions (spec: US M2SL + EA + JP + CN + UK, converted to USD,
 * flagged 'approximation'). The UK has no M2 series on FRED; the spec's UK input is the M3 series
 * MABMM301GBM189S. The EA, JP and UK IDs are M3 (broad money) on FRED. See A8_CAVEAT.
 *
 * Method: convert each area to USD (FX from FRED), then add the five areas on every day where all
 * of them have a value. The US series is already in USD billions (M2SL). Monthly values
 * forward-fill for at most monthlyMaxFillDays. A day is written only when every included area has a
 * value, so the series stops where the first area stops updating. The composite stops at 2019-10-02
 * (China ends 2019-08; EA, JP and UK end 2023-11). It is then reported stale (status.stale).
 * Current sources are tracked as CSN-024-FOLLOWUP-2.
 */
export function buildA8GlobalM2Approximation(input: {
  readonly observations: ReadonlyMap<string, readonly FredObservation[]>;
  readonly from: string;
  readonly to: string;
  readonly config: MacroSourceConfig;
}): { rows: MacroDailyRow[]; areas: GlobalM2Area[]; warnings: string[]; status: A8Status } {
  const warnings: string[] = [];
  const included = A8_COMPONENTS.filter((c) => !input.config.a8ExcludeAreas.includes(c.area));
  const [low, high] = input.config.a8PlausibleUsdBnRange;
  const perArea: { area: GlobalM2Area; usd: Map<string, { value: number; asOf: string }> }[] = [];

  for (const component of included) {
    const level = input.observations.get(component.seriesId);
    if (!level || level.length === 0) {
      warnings.push(
        `A8: no ${component.area} observations (${component.seriesId}); composite not built`,
      );
      return { rows: [], areas: [], warnings, status: NO_COMPOSITE };
    }
    const levelDaily = withPublicationLag(
      expandToDaily(level, {
        from: input.from,
        to: input.to,
        forwardFill: true,
        maxFillDays: input.config.monthlyMaxFillDays,
      }),
      lagFor(input.config, component.seriesId),
      input.config.asOfRule,
    );
    let fxDaily: Map<string, { value: number; asOf: string }> | undefined;
    if (component.unit === 'local-units') {
      const fx = component.fxSeriesId ? input.observations.get(component.fxSeriesId) : undefined;
      if (!fx || fx.length === 0) {
        warnings.push(
          `A8: no ${component.area} FX observations (${component.fxSeriesId ?? 'none'}); composite not built`,
        );
        return { rows: [], areas: [], warnings, status: NO_COMPOSITE };
      }
      fxDaily = withPublicationLag(
        expandToDaily(fx, {
          from: input.from,
          to: input.to,
          forwardFill: true,
          maxFillDays: input.config.fxMaxFillDays,
        }),
        lagFor(input.config, component.fxSeriesId ?? ''),
        input.config.asOfRule,
      );
    }
    const usd = new Map<string, { value: number; asOf: string }>();
    for (const [date, point] of levelDaily) {
      let usdBn: number;
      let asOf = point.asOf;
      if (component.unit === 'usd-billions') {
        usdBn = point.value;
      } else {
        const fx = fxDaily?.get(date);
        if (!fx) continue;
        asOf = asOf > fx.asOf ? asOf : fx.asOf;
        const localBn = point.value / LOCAL_UNITS_PER_BILLION;
        usdBn = component.fxQuote === 'usd-per-unit' ? localBn * fx.value : localBn / fx.value;
      }
      if (!(usdBn >= low && usdBn <= high)) {
        throw new SourceError(
          `${FRED_SOURCE}:A8`,
          `${component.area} value ${usdBn} USD bn on ${date} is outside the plausible range; check the unit assumption for ${component.seriesId}`,
        );
      }
      usd.set(date, { value: usdBn, asOf });
    }
    perArea.push({ area: component.area, usd });
  }

  const rows: MacroDailyRow[] = [];
  const lastDay = isoToDayNumber(input.to);
  for (let day = isoToDayNumber(input.from); day <= lastDay; day++) {
    const iso = dayNumberToIso(day);
    let total = 0;
    let asOf = '';
    let complete = perArea.length > 0;
    for (const area of perArea) {
      const point = area.usd.get(iso);
      if (!point) {
        complete = false;
        break;
      }
      total += point.value;
      if (point.asOf > asOf) asOf = point.asOf;
    }
    if (complete) {
      rows.push({
        seriesId: A8_APPROXIMATION_SERIES_ID,
        date: iso,
        value: total,
        asOf,
        source: A8_APPROXIMATION_SOURCE,
      });
    }
  }

  // F2: a composite that stops early, or an input older than its fill cap, is never silent.
  const lastRow = rows[rows.length - 1]?.date;
  if (lastRow === undefined || lastRow < input.to) {
    warnings.push(
      `A8 composite ends ${lastRow ?? 'nowhere'}, before ${input.to}; no value is written after that date`,
    );
  }
  const stale = staleInputs(input, included);
  if (stale.length > 0) {
    warnings.push(`A8 inputs older than their fill cap at ${input.to}: ${stale.join('; ')}`);
  }
  // F1: the composite stops at its last complete day. It is stale when that day is more than the
  // fill cap before `to`. The adapter does not add sources; the job reports the status.
  const lastCompleteDate = rows[rows.length - 1]?.date ?? null;
  const threshold = addUtcDays(input.to, -input.config.monthlyMaxFillDays);
  const status: A8Status = {
    lastCompleteDate,
    stale: lastCompleteDate === null || lastCompleteDate < threshold,
  };
  return { rows, areas: perArea.map((a) => a.area), warnings, status };
}

/** Inputs whose latest observation is older than their fill cap at `to` (F2). */
function staleInputs(
  input: {
    readonly observations: ReadonlyMap<string, readonly FredObservation[]>;
    readonly to: string;
    readonly config: MacroSourceConfig;
  },
  included: readonly GlobalM2Component[],
): string[] {
  const latest = (id: string): string | undefined => {
    let last: string | undefined;
    for (const obs of input.observations.get(id) ?? []) {
      if (last === undefined || obs.date > last) last = obs.date;
    }
    return last;
  };
  const out: string[] = [];
  for (const component of included) {
    const last = latest(component.seriesId);
    if (last !== undefined && utcDaysBetween(last, input.to) > input.config.monthlyMaxFillDays) {
      out.push(`${component.area} ${component.seriesId} (last observation ${last})`);
    }
    if (component.fxSeriesId !== undefined && component.unit === 'local-units') {
      const fxLast = latest(component.fxSeriesId);
      if (fxLast !== undefined && utcDaysBetween(fxLast, input.to) > input.config.fxMaxFillDays) {
        out.push(`${component.area} FX ${component.fxSeriesId} (last observation ${fxLast})`);
      }
    }
  }
  return out;
}

export type MacroCoinGeckoPlan = 'demo' | 'basic' | 'analyst';

/** Attribution for the A7 gold proxy (CSN-071: one line, linked, not an endorsement). */
export const COINGECKO_ATTRIBUTION = 'Data provided by CoinGecko. Powered by CoinGecko.';
export const COINGECKO_URL = 'https://www.coingecko.com';

/** Base URL and auth header for CoinGecko. The key goes in a header, never in the URL. */
export function coingeckoAccess(
  plan: MacroCoinGeckoPlan | undefined,
  apiKey: string | undefined,
): { baseUrl: string; headers: Record<string, string> } {
  if (!apiKey) return { baseUrl: 'https://api.coingecko.com/api/v3', headers: {} };
  if (plan === 'basic' || plan === 'analyst') {
    return {
      baseUrl: 'https://pro-api.coingecko.com/api/v3',
      headers: { 'x-cg-pro-api-key': apiKey },
    };
  }
  return {
    baseUrl: 'https://api.coingecko.com/api/v3',
    headers: { 'x-cg-demo-api-key': apiKey },
  };
}

/** Last price of each UTC day in a CoinGecko market_chart payload. */
export function parseCoinGeckoMarketChart(json: unknown, coinId: string): Map<string, number> {
  const source = `coingecko:${coinId}`;
  if (!isRecord(json) || !Array.isArray(json.prices)) {
    throw new SourceError(source, 'unexpected market_chart payload shape');
  }
  const daily = new Map<string, { ts: number; price: number }>();
  for (const pair of json.prices as unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new SourceError(source, 'price point is not a [timestamp, price] pair');
    }
    const [ts, price] = pair as [unknown, unknown];
    if (
      typeof ts !== 'number' ||
      typeof price !== 'number' ||
      !Number.isFinite(price) ||
      price <= 0
    ) {
      throw new SourceError(source, 'price point is not a positive number');
    }
    const date = new Date(ts).toISOString().slice(0, 10);
    const prior = daily.get(date);
    if (!prior || ts >= prior.ts) daily.set(date, { ts, price });
  }
  return new Map([...daily].map(([date, point]) => [date, point.price]));
}

/**
 * A7 gold proxy: the daily mean of the listed gold-backed token prices (PAXG and XAUT) in USD.
 * The proxy tracks spot gold closely, but it is a token price, not the LBMA fix. Proxy label:
 * "gold proxy" everywhere.
 */
export async function fetchA7GoldProxy(options: {
  readonly config: MacroSourceConfig;
  readonly from: string;
  readonly to: string;
  readonly plan?: MacroCoinGeckoPlan | undefined;
  readonly apiKey?: string | undefined;
  readonly fetchImpl: FetchLike;
}): Promise<MacroFetchResult> {
  const warnings: string[] = [];
  const gold = options.config.a7Gold;
  if (!gold.enabled) return { rows: [], warnings: ['A7 gold proxy disabled by config'] };
  const access = coingeckoAccess(options.plan, options.apiKey);
  const perCoin: Map<string, number>[] = [];
  for (const coinId of gold.coinIds) {
    try {
      const json = await fetchJson(
        options.fetchImpl,
        `${access.baseUrl}/coins/${coinId}/market_chart?vs_currency=usd&days=${gold.days}`,
        { source: `coingecko:${coinId}`, headers: access.headers },
      );
      perCoin.push(parseCoinGeckoMarketChart(json, coinId));
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : `coingecko:${coinId} failed`);
    }
  }
  if (perCoin.length === 0) return { rows: [], warnings };

  const dates = new Set<string>();
  for (const series of perCoin) for (const date of series.keys()) dates.add(date);
  const rows: MacroDailyRow[] = [];
  for (const date of [...dates].sort()) {
    if (date < options.from || date > options.to) continue;
    const prices = perCoin.map((s) => s.get(date)).filter((p): p is number => p !== undefined);
    if (prices.length === 0) continue;
    const mean = prices.reduce((sum, p) => sum + p, 0) / prices.length;
    rows.push({
      seriesId: A7_GOLD_PROXY_SERIES_ID,
      date,
      value: mean,
      asOf: asOfFor(date, lagFor(options.config, A7_GOLD_PROXY_SERIES_ID), options.config.asOfRule),
      source: `coingecko:${gold.coinIds.join('+')}`,
    });
  }
  return { rows, warnings };
}

/**
 * Fetch every FRED series in FRED_CORE_SERIES plus the A8 composite. A failed series becomes a
 * warning. The composite is skipped if any input is missing. A missing key throws.
 */
export async function fetchFredMacroRows(options: {
  readonly apiKey: string | undefined;
  readonly to: string;
  readonly config?: MacroSourceConfig | undefined;
  readonly fetchImpl: FetchLike;
}): Promise<FredMacroResult> {
  const config = options.config ?? MACRO_CONFIG_DEFAULTS;
  if (!options.apiKey) {
    throw new SourceError(FRED_SOURCE, 'FRED_API_KEY is not set');
  }
  const apiKey = options.apiKey;
  const rows: MacroDailyRow[] = [];
  const warnings: string[] = [];
  const observations = new Map<string, FredObservation[]>();
  let seriesRequested = 0;
  let seriesOk = 0;

  for (const spec of FRED_CORE_SERIES) {
    if (spec.licensed && !config.includeLicensedVix) {
      warnings.push(
        `${spec.id}: not fetched, licensed series (CSN-071); set includeLicensedVix to enable`,
      );
      continue;
    }
    seriesRequested += 1;
    try {
      const obs = await fetchFredSeries({
        seriesId: spec.id,
        apiKey,
        startDate: config.startDate,
        fetchImpl: options.fetchImpl,
      });
      observations.set(spec.id, obs);
      rows.push(...seriesRows(spec, obs, config, options.to));
      seriesOk += 1;
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : `${spec.id} failed`);
    }
  }

  // A unit failure withholds the composite (no wrong total is written) but keeps the raw rows.
  let a8: A8Status = NO_COMPOSITE;
  try {
    const composite = buildA8GlobalM2Approximation({
      observations,
      from: config.startDate,
      to: options.to,
      config,
    });
    rows.push(...composite.rows);
    warnings.push(...composite.warnings);
    a8 = composite.status;
  } catch (error) {
    warnings.push(
      error instanceof Error
        ? `A8 composite withheld: ${error.message}`
        : 'A8 composite withheld: unknown error',
    );
  }
  return { rows, warnings, a8, seriesRequested, seriesOk };
}
