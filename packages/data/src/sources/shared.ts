/**
 * Shared helpers for the macro and sentiment adapters: UTC date maths, one HTTP call with a
 * timeout, and a typed error. Error messages name the source and the HTTP status only. They
 * never include the request URL, because FRED puts its API key in the query string.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const DAY_MS = 86_400_000;
/** Largest Unix second whose UTC date is still 9999-12-31. Dates stored must be 0000 to 9999 (R3-5). */
export const MAX_UNIX_SECONDS_YEAR_9999 = 253_402_300_799;
const REQUEST_TIMEOUT_MS = 20_000;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export class SourceError extends Error {
  readonly source: string;
  readonly status: number | undefined;

  constructor(source: string, message: string, status?: number) {
    super(`${source}: ${message}`);
    this.name = 'SourceError';
    this.source = source;
    this.status = status;
  }
}

/** True when the value is a real calendar date written as YYYY-MM-DD. */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

/** Whole days since 1970-01-01 (UTC) for a YYYY-MM-DD string. */
export function isoToDayNumber(iso: string): number {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
}

export function dayNumberToIso(day: number): string {
  // R3-5: toISOString writes ±YYYYYY outside years 0000 to 9999. Refuse, so no stored date is malformed.
  const year = new Date(day * DAY_MS).getUTCFullYear();
  if (!Number.isFinite(year) || year < 0 || year > 9999) {
    throw new SourceError('date', 'day is outside the years 0000 to 9999');
  }
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addUtcDays(iso: string, days: number): string {
  return dayNumberToIso(isoToDayNumber(iso) + days);
}

/** Days from `fromIso` to `toIso` (negative when `toIso` is earlier). */
export function utcDaysBetween(fromIso: string, toIso: string): number {
  return isoToDayNumber(toIso) - isoToDayNumber(fromIso);
}

/** UTC calendar date of a Unix timestamp in seconds. */
export function isoFromUnixSeconds(seconds: number): string {
  return dayNumberToIso(Math.floor(seconds / 86_400));
}

/**
 * How `as_of` is written on a row (D1). 'observation-date' (default, the spec rule): as_of equals
 * the observation date. 'publication-lag' (opt-in): as_of = observation date + the series lag, so a
 * backtest reading rows with as_of <= rebuild date never sees a figure before its release.
 */
export type AsOfRule = 'publication-lag' | 'observation-date';
/** Spec rule (owner decision, CSN-024): as_of = observation date. 'publication-lag' is opt-in. */
export const DEFAULT_AS_OF_RULE: AsOfRule = 'observation-date';

/**
 * Publication lag in days per series key (D1). Daily market series and FX: 1 day. Monthly
 * releases (FRED M2 and the OECD money series, GPR): 45 days after the first of the observation
 * month. Fear & Greed and the gold proxy: 1 day. Keys are FRED series ids plus GPR_MONTHLY,
 * FEAR_GREED and A7_GOLD_PROXY_USD. Documented in packages/data/docs/macro-sentiment-methodology.md.
 */
export const PUBLICATION_LAG_DAYS: Readonly<Record<string, number>> = {
  NASDAQCOM: 1,
  SP500: 1,
  VIXCLS: 1,
  DTWEXBGS: 1,
  DGS10: 1,
  DCOILWTICO: 1,
  DEXUSEU: 1,
  DEXJPUS: 1,
  DEXCHUS: 1,
  DEXUSUK: 1,
  M2SL: 45,
  MABMM301EZM189S: 45,
  MABMM301JPM189S: 45,
  MYAGM2CNM189N: 45,
  MABMM301GBM189S: 45,
  GPR_MONTHLY: 45,
  FEAR_GREED: 1,
  A7_GOLD_PROXY_USD: 1,
};

export interface AsOfSetting {
  readonly rule: AsOfRule;
  readonly lagDays: number;
}

/** as_of for a row whose observation date is `observationIso`. */
export function asOfFor(observationIso: string, lagDays: number, rule: AsOfRule): string {
  return rule === 'observation-date' ? observationIso : addUtcDays(observationIso, lagDays);
}

/** Default as-of setting for a key in PUBLICATION_LAG_DAYS. Throws for an unknown key. */
export function asOfSettingFor(key: string, rule: AsOfRule = DEFAULT_AS_OF_RULE): AsOfSetting {
  const lagDays = PUBLICATION_LAG_DAYS[key];
  if (lagDays === undefined) {
    throw new SourceError(key, 'no publication lag configured for this series');
  }
  return { rule, lagDays };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * GET a URL and return the successful response. The error names the source label and HTTP
 * status. It never includes the URL, so a key in the query string cannot reach a log.
 */
export async function fetchOk(
  fetchImpl: FetchLike,
  url: string,
  options: { source: string; headers?: Record<string, string> },
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: options.headers ?? {},
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const kind = error instanceof Error ? error.name : 'unknown';
    throw new SourceError(options.source, `request failed (${kind})`);
  }
  if (!response.ok) {
    throw new SourceError(options.source, `HTTP ${response.status}`, response.status);
  }
  return response;
}

export async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  options: { source: string; headers?: Record<string, string> },
): Promise<unknown> {
  const response = await fetchOk(fetchImpl, url, options);
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new SourceError(options.source, 'response body was not JSON');
  }
}
