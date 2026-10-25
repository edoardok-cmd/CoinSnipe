/**
 * alternative.me Crypto Fear & Greed index (master plan D3, also an input to A3).
 * Free endpoint, API only (never page scraping: alternative.me's terms bar scraping).
 * Attribution is required next to any display: "Data from alternative.me" with a link.
 */
import {
  asOfFor,
  type AsOfSetting,
  asOfSettingFor,
  fetchJson,
  type FetchLike,
  isoFromUnixSeconds,
  isRecord,
  MAX_UNIX_SECONDS_YEAR_9999,
  SourceError,
} from './shared';
import { asOfSettingFrom, MACRO_CONFIG_DEFAULTS, type MacroSourceConfig } from './fred';

export const ALTERNATIVE_ME_SOURCE = 'alternative.me';
export const FNG_URL = 'https://api.alternative.me/fng/?limit=0';
export const ALTERNATIVE_ME_ATTRIBUTION = 'Data from alternative.me';
export const ALTERNATIVE_ME_ATTRIBUTION_URL = 'https://alternative.me/crypto/fear-and-greed-index/';

/** D3: "Fear & Greed above 80 or below 20" marks a sentiment extreme. Boundary values do not count. */
export const D3_EXTREME_GREED_ABOVE = 80;
export const D3_EXTREME_FEAR_BELOW = 20;

export interface FearGreedRow {
  /** UTC day the reading describes, YYYY-MM-DD. */
  readonly date: string;
  /** 0 to 100. */
  readonly value: number;
  readonly classification: string | null;
  /** as_of = observation date (default, observation-date); observation date + 1 day under publication-lag. */
  readonly asOf: string;
  readonly source: string;
}

/** Parse the alternative.me payload. Rows come back sorted oldest first, one per UTC day. */
export function parseFearGreedResponse(
  json: unknown,
  asOfSetting: AsOfSetting = asOfSettingFor('FEAR_GREED'),
): FearGreedRow[] {
  const fail = (detail: string): never => {
    throw new SourceError(ALTERNATIVE_ME_SOURCE, detail);
  };
  if (!isRecord(json) || !Array.isArray(json.data)) {
    return fail('unexpected payload shape');
  }
  const byDate = new Map<string, FearGreedRow>();
  for (const item of json.data as unknown[]) {
    if (!isRecord(item)) return fail('data entry is not an object');
    // F8: check the text before Number(), which turns "" into 0.
    const rawValue = item.value;
    if (typeof rawValue === 'string' && !/^\d{1,3}$/.test(rawValue)) {
      return fail('value is not an integer between 0 and 100');
    }
    const value = typeof rawValue === 'string' ? Number(rawValue) : rawValue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
      return fail('value is not an integer between 0 and 100');
    }
    const rawTs = item.timestamp;
    if (typeof rawTs === 'string' && !/^\d+$/.test(rawTs)) {
      return fail('timestamp is not a Unix time in seconds');
    }
    const ts = typeof rawTs === 'string' ? Number(rawTs) : rawTs;
    if (typeof ts !== 'number' || !Number.isInteger(ts) || ts < 0) {
      return fail('timestamp is not a Unix time in seconds');
    }
    // N3/R3-5: a Unix second past 9999-12-31 has no 4-digit date. It must not reach toISOString
    // (a RangeError or a ±YYYYYY string) and then the store.
    if (ts > MAX_UNIX_SECONDS_YEAR_9999) {
      return fail('timestamp is outside the representable date range (years 0000 to 9999)');
    }
    const classification =
      typeof item.value_classification === 'string' && item.value_classification.length > 0
        ? item.value_classification
        : null;
    const date = isoFromUnixSeconds(ts);
    if (!byDate.has(date)) {
      const asOf = asOfFor(date, asOfSetting.lagDays, asOfSetting.rule);
      byDate.set(date, { date, value, classification, asOf, source: ALTERNATIVE_ME_SOURCE });
    }
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** D3 extreme flag for one reading. Null means inside the band. */
export function d3SentimentExtreme(value: number): 'extreme-greed' | 'extreme-fear' | null {
  if (value > D3_EXTREME_GREED_ABOVE) return 'extreme-greed';
  if (value < D3_EXTREME_FEAR_BELOW) return 'extreme-fear';
  return null;
}

export async function fetchD3FearGreed(options: {
  readonly fetchImpl: FetchLike;
  readonly url?: string | undefined;
  /** asOfRule and the FEAR_GREED lag come from this config (R3-3). Defaults to MACRO_CONFIG_DEFAULTS. */
  readonly config?: MacroSourceConfig | undefined;
}): Promise<FearGreedRow[]> {
  const json = await fetchJson(options.fetchImpl, options.url ?? FNG_URL, {
    source: ALTERNATIVE_ME_SOURCE,
  });
  const setting = asOfSettingFrom(options.config ?? MACRO_CONFIG_DEFAULTS, 'FEAR_GREED');
  return parseFearGreedResponse(json, setting);
}
