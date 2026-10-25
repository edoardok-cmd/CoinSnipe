/**
 * Event calendar for A10 (Home "upcoming events", the Market calendar and forecasting event
 * variance). Feeds events_calendar (CalendarEventKind: fomc, cpi, payrolls, pce, etf, unlock).
 *
 *   fomc      FOMC decision dates, scraped from federalreserve.gov (fallback: fomc-fallback.json)
 *   cpi       FRED release dates, release 10 (Consumer Price Index)
 *   payrolls  FRED release dates, release 50 (Employment Situation)
 *   pce       FRED release dates, release 54 (Personal Income and Outlays)
 *   etf       ETF decision dates entered by hand in an admin JSON file (parsed by the caller)
 *   unlock    token unlocks, supplied by CSN-026 (passed in, not fetched here)
 *
 * Window: rows are kept for [today, today + windowDays]. The Market and Home UI show the next 30
 * days from this store.
 */
import fomcFallback from './fomc-fallback.json' with { type: 'json' };
import {
  addUtcDays,
  fetchJson,
  fetchOk,
  isIsoDate,
  isRecord,
  SourceError,
  type FetchLike,
} from './shared';

export const CALENDAR_SOURCE_FED = 'federalreserve.gov';
export const CALENDAR_SOURCE_FALLBACK = 'fomc-fallback.json';
export const FOMC_CALENDAR_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
export const FRED_RELEASE_DATES_SOURCE = 'fred:release/dates';
const FRED_API_BASE = 'https://api.stlouisfed.org/fred';
/** Fewer parsed meetings than this means the page layout changed, so the fallback is used. */
const MIN_FOMC_MEETINGS_FROM_PAGE = 4;
const DEFAULT_WINDOW_DAYS = 60;

export type CalendarKind = 'fomc' | 'cpi' | 'payrolls' | 'pce' | 'etf' | 'unlock';
/** Every CalendarEventKind, in enum order. */
export const CALENDAR_KINDS: readonly CalendarKind[] = [
  'fomc',
  'cpi',
  'payrolls',
  'pce',
  'etf',
  'unlock',
];

export interface CalendarRow {
  /** Event date, YYYY-MM-DD (UTC calendar day). */
  readonly date: string;
  readonly kind: CalendarKind;
  readonly title: string;
  readonly assetId: string | null;
  /**
   * as_of = the fetch date (the day the schedule was read). Calendar rows are outside the asOfRule
   * setting: a schedule is known on the day it is read, and no observation date applies.
   */
  readonly asOf: string;
  readonly source: string;
}

export interface FomcMeeting {
  readonly start: string;
  /** Statement day: the last day of the meeting. */
  readonly decision: string;
  readonly sep: boolean;
}

export const FRED_RELEASE_KINDS = [
  {
    releaseId: 10,
    kind: 'cpi',
    title: 'US CPI inflation release',
  },
  {
    releaseId: 50,
    kind: 'payrolls',
    title: 'US jobs report (Employment Situation)',
  },
  {
    releaseId: 54,
    kind: 'pce',
    title: 'US PCE inflation release (Personal Income and Outlays)',
  },
] as const satisfies readonly { releaseId: number; kind: CalendarKind; title: string }[];

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** 1 to 12 for a full or three-letter-abbreviated month name (the live page uses "Apr", "Dec"). 0 if unknown. */
function monthNumber(name: string): number {
  const key = name.trim().replace(/\.$/, '').toLowerCase();
  if (key.length < 3) return 0;
  return MONTHS.findIndex((m) => m === key || m.startsWith(key)) + 1;
}

function isoOf(year: number, month: number, day: number): string | null {
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

export interface FomcPageParse {
  readonly meetings: FomcMeeting[];
  /** One entry per row that could not be dated. Any entry makes the page parse partial (R2-1). */
  readonly failures: string[];
}

/** A known non-meeting row on the live page (the August notation vote). Skipped on purpose. */
const FOMC_NOTATION_VOTE = /\(notation vote\)/i;

/** A date cell: "27-28", "17-18*", "30-1", "30-May 1" (start day, optional end month, optional end day, SEP asterisk). */
const FOMC_DATE_CELL = /^(\d{1,2})(?:\s*-\s*(?:([A-Za-z.]+)\s+)?(\d{1,2}))?\s*(\*)?$/;

/**
 * The markup of the FOMC page, counted (R8-1). Each marker kind is counted loosely (an element that is
 * there) and strictly (the element in the exact expected form). A page whose loose and strict counts
 * differ has changed shape, and its rows cannot be dated from the markup alone.
 */
function fomcStructureFailures(html: string): string[] {
  const count = (pattern: RegExp): number => [...html.matchAll(pattern)].length;
  const failures: string[] = [];
  const headings = count(/<h4>/g);
  const yearHeadings = count(/<h4>\s*<a(?:\s[^>]*)?>\s*\d{4} FOMC Meetings\s*<\/a>\s*<\/h4>/g);
  if (headings !== yearHeadings) {
    failures.push(
      `FOMC page structure changed: ${headings} year heading(s), ${yearHeadings} in the expected form "<h4><a>YYYY FOMC Meetings</a></h4>"`,
    );
  }
  const months = count(/fomc-meeting__month/g);
  const monthLabels = count(/fomc-meeting__month[^>]*>\s*<strong>[^<]*<\/strong>/g);
  if (months !== monthLabels) {
    failures.push(
      `FOMC page structure changed: ${months} month label(s), ${monthLabels} with the label in <strong>`,
    );
  }
  const dates = count(/fomc-meeting__date/g);
  const dateCells = count(/fomc-meeting__date[^>]*>\s*[^<]*?\s*<\/div>/g);
  if (dates !== dateCells) {
    failures.push(
      `FOMC page structure changed: ${dates} date cell(s), ${dateCells} with the cell as bare text`,
    );
  }
  return failures;
}

/**
 * Parse the FOMC calendar page. The page lists each year under "YYYY FOMC Meetings", then one row per
 * meeting: a fomc-meeting__month label ("January", or an X/Y label such as "Apr/May") and a
 * fomc-meeting__date cell such as "27-28", "17-18*" (asterisk = SEP meeting), "30-1" (wrapping under
 * an X/Y label) or "30-May 1" (wrapping with a named month). Decision date = the last day of the meeting.
 *
 * A row is never dated from a previous row's month (R2-1). A label that does not name a known month,
 * a cell that is not a day range, or a decision before its start is recorded in `failures`, and the
 * row is not returned. A blank cell is skipped; so is the known "(notation vote)" row.
 */
export function parseFomcCalendarPage(html: string): FomcPageParse {
  // R8-1: check the page structure first. Every year heading, month label and date cell must match its
  // exact markup. A count mismatch (a label without <strong>, a wrapped date cell, a reworded heading) is
  // a partial page: no row from it is returned, so no row is dated from a neighbour.
  const structureFailures = fomcStructureFailures(html);
  if (structureFailures.length > 0) return { meetings: [], failures: structureFailures };
  const token =
    /(\d{4}) FOMC Meetings|fomc-meeting__month[^>]*>\s*<strong>([^<]*)<\/strong>|fomc-meeting__date[^>]*>\s*([^<]*?)\s*</g;
  const meetings: FomcMeeting[] = [];
  const failures: string[] = [];
  let year: number | undefined;
  let month: number | undefined;
  let label = '';
  // F4: a live "Apr/May" label starts in Apr and ends in May. The second name is the end month of the
  // meeting when the day wraps (R7-5: "30-1" under Apr/May is Apr 30 to May 1; "28-29" stays in April).
  let labelEndMonth: number | undefined;
  for (const match of html.matchAll(token)) {
    if (match[1] !== undefined) {
      year = Number(match[1]);
      month = undefined;
      labelEndMonth = undefined;
      label = '';
      continue;
    }
    if (match[2] !== undefined) {
      // R2-1: a new label resets the month. An unmatched label leaves it undefined, so its rows fail.
      label = match[2].trim();
      month = undefined;
      labelEndMonth = undefined;
      const names = label.split('/').map((name) => name.trim());
      const startMonth = monthNumber(names[0] ?? '');
      if (names.length === 1 && startMonth > 0) {
        month = startMonth;
      } else if (names.length === 2) {
        const endMonth = monthNumber(names[1] ?? '');
        if (startMonth > 0 && endMonth > 0) {
          month = startMonth;
          labelEndMonth = endMonth;
        }
      }
      continue;
    }
    const cell = (match[3] ?? '').trim();
    if (cell === '') continue;
    if (FOMC_NOTATION_VOTE.test(cell)) continue;
    if (year === undefined) {
      failures.push(`FOMC row "${cell}" appears before any year heading`);
      continue;
    }
    if (month === undefined) {
      failures.push(
        `FOMC row "${cell}" under label "${label}": the label does not name a known month, so the row is not dated`,
      );
      continue;
    }
    const parsed = FOMC_DATE_CELL.exec(cell);
    if (!parsed) {
      failures.push(`FOMC row under "${label}": date cell "${cell}" is not a day range`);
      continue;
    }
    const startDay = Number(parsed[1]);
    const endDay = parsed[3] !== undefined ? Number(parsed[3]) : startDay;
    const explicitEnd = parsed[2] !== undefined ? monthNumber(parsed[2]) : undefined;
    if (parsed[2] !== undefined && explicitEnd === 0) {
      failures.push(
        `FOMC row under "${label}": end month "${parsed[2]}" in "${cell}" is not a month`,
      );
      continue;
    }
    // R9-2: an explicit end month must be the label's second month. For an X/Y label that is the
    // second name; for a single-month label it is the label's own month or the month after it.
    if (explicitEnd !== undefined) {
      const allowed =
        labelEndMonth !== undefined ? [labelEndMonth] : [month, (month % 12) + 1];
      if (!allowed.includes(explicitEnd)) {
        failures.push(
          `FOMC row under "${label}": end month "${parsed[2]}" in "${cell}" does not match the label`,
        );
        continue;
      }
    }
    const endMonth =
      explicitEnd !== undefined
        ? explicitEnd
        : labelEndMonth !== undefined && endDay < startDay
          ? labelEndMonth
          : month;
    const endYear = endMonth < month ? year + 1 : year;
    const start = isoOf(year, month, startDay);
    const decision = isoOf(endYear, endMonth, endDay);
    if (!start || !decision) {
      failures.push(`FOMC row under "${label}": cell "${cell}" is not a valid date`);
      continue;
    }
    if (decision < start) {
      failures.push(`FOMC row under "${label}": decision ${decision} is before start ${start}`);
      continue;
    }
    meetings.push({ start, decision, sep: parsed[4] === '*' });
  }
  return { meetings, failures };
}

/** The meetings of a page parse (failures are dropped; use parseFomcCalendarPage to see them). */
export function parseFomcCalendarHtml(html: string): FomcMeeting[] {
  return parseFomcCalendarPage(html).meetings;
}

/** Plausibility bounds on a parsed FOMC page (R8-1, R9-1). Measured on the live page for 2021 to 2027. */
const FOMC_MIN_GAP_DAYS = 30;
const FOMC_MAX_GAP_DAYS = 100;
const FOMC_MIN_PER_YEAR = 6;
const FOMC_MAX_PER_YEAR = 10;
const FOMC_MAX_SPAN_DAYS = 3;
const DAY_MS = 86_400_000;

/**
 * A day-range cell as bare text: a hyphenated range ("27-28", "17-18*", "30-1", "30-May 1"). A lone number
 * is not counted, so a footnote marker ("<sup>1</sup>") does not change the count (F2).
 */
const FOMC_DAY_RANGE_CELL = /^\d{1,2}\s*-\s*(?:[A-Za-z.]+\s+)?\d{1,2}\s*\*?$/;

/** Count the day-range date cells on the page as bare text, whatever class or tag wraps them (R9-1 rule e). */
function dayRangeCellCount(html: string): number {
  let count = 0;
  for (const match of html.matchAll(/>([^<]*)</g)) {
    if (FOMC_DAY_RANGE_CELL.test((match[1] ?? '').trim())) count += 1;
  }
  return count;
}

/**
 * Plausibility checks on a parsed FOMC page. They run after parsing and before any row is returned, and
 * they catch markup changes that the structure counts cannot see: a renamed month-label class, a renamed
 * date-cell class, a retagged and reworded year heading (R9-1). Each rule is named in its message.
 *   (a) Within one start year the meetings are listed in increasing order, and no start date repeats on
 *       the page. (The live page lists its year blocks in the order 2026, 2025 ... 2021, 2027, so the
 *       order is checked within each year, not across the page.)
 *   (b) In date order, consecutive meetings start 30 to 100 days apart.
 *   (c) Each start year that appears has 6 to 10 meetings.
 *   (d) Each decision date is on or after its start and at most 3 days after it.
 *   (e) The page has as many hyphenated day-range date cells, counted as bare text, as meetings were parsed.
 * An empty result means the page is plausible. Any entry makes the page partial (see fetchFomcMeetings).
 */
export function fomcPlausibilityFailures(html: string, meetings: readonly FomcMeeting[]): string[] {
  const failures: string[] = [];
  const dayOf = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / DAY_MS;

  // (a)
  const seen = new Set<string>();
  const repeated: string[] = [];
  const unordered: string[] = [];
  meetings.forEach((meeting, index) => {
    if (seen.has(meeting.start)) repeated.push(meeting.start);
    seen.add(meeting.start);
    const previous = meetings[index - 1];
    if (
      previous !== undefined &&
      previous.start.slice(0, 4) === meeting.start.slice(0, 4) &&
      meeting.start <= previous.start
    ) {
      unordered.push(`${previous.start} then ${meeting.start}`);
    }
  });
  if (unordered.length > 0 || repeated.length > 0) {
    const first = unordered[0] ?? repeated[0] ?? '';
    failures.push(
      `plausibility rule (a) violated: ${unordered.length} start date(s) do not increase within their year, ${repeated.length} start date(s) repeat (first: ${first})`,
    );
  }

  // (b)
  const dates = meetings.map((meeting) => meeting.start).sort();
  const gaps: string[] = [];
  for (let index = 1; index < dates.length; index += 1) {
    const from = dates[index - 1] ?? '';
    const to = dates[index] ?? '';
    const days = dayOf(to) - dayOf(from);
    if (days < FOMC_MIN_GAP_DAYS || days > FOMC_MAX_GAP_DAYS) {
      gaps.push(`${from} to ${to} is ${days} days`);
    }
  }
  if (gaps.length > 0) {
    failures.push(
      `plausibility rule (b) violated: ${gaps.length} gap(s) outside ${FOMC_MIN_GAP_DAYS} to ${FOMC_MAX_GAP_DAYS} days (first: ${gaps[0] ?? ''})`,
    );
  }

  // (c)
  const perYear = new Map<string, number>();
  for (const meeting of meetings) {
    const year = meeting.start.slice(0, 4);
    perYear.set(year, (perYear.get(year) ?? 0) + 1);
  }
  for (const [year, count] of perYear) {
    if (count < FOMC_MIN_PER_YEAR || count > FOMC_MAX_PER_YEAR) {
      failures.push(
        `plausibility rule (c) violated: ${year} has ${count} meeting(s), allowed ${FOMC_MIN_PER_YEAR} to ${FOMC_MAX_PER_YEAR}`,
      );
    }
  }

  // (d)
  const badSpan = meetings.filter((meeting) => {
    const span = dayOf(meeting.decision) - dayOf(meeting.start);
    return span < 0 || span > FOMC_MAX_SPAN_DAYS;
  });
  const firstBadSpan = badSpan[0];
  if (firstBadSpan !== undefined) {
    failures.push(
      `plausibility rule (d) violated: ${badSpan.length} meeting(s) end before their start or more than ${FOMC_MAX_SPAN_DAYS} days after it (first: ${firstBadSpan.start} to ${firstBadSpan.decision})`,
    );
  }

  // (e)
  const cells = dayRangeCellCount(html);
  if (cells !== meetings.length) {
    failures.push(
      `plausibility rule (e) violated: the page has ${cells} day-range date cell(s) but ${meetings.length} parsed meeting(s)`,
    );
  }
  return failures;
}

/** Validate the maintained fallback file. Throws on any bad row. */
export function parseFomcFallback(json: unknown): FomcMeeting[] {
  if (!isRecord(json) || !Array.isArray(json.meetings)) {
    throw new SourceError(CALENDAR_SOURCE_FALLBACK, 'unexpected shape');
  }
  return (json.meetings as unknown[]).map((item) => {
    if (
      !isRecord(item) ||
      typeof item.start !== 'string' ||
      typeof item.decision !== 'string' ||
      !isIsoDate(item.start) ||
      !isIsoDate(item.decision) ||
      typeof item.sep !== 'boolean'
    ) {
      throw new SourceError(CALENDAR_SOURCE_FALLBACK, 'meeting row is not {start, decision, sep}');
    }
    return { start: item.start, decision: item.decision, sep: item.sep };
  });
}

/**
 * Read the FOMC dates from the live page.
 *   - Page unreadable (network error, non-200) or too thin (fewer than 4 meetings): the maintained
 *     fallback is used, and the source is ok only if the fallback covers the window (see
 *     fetchA10Calendar).
 *   - Page partial (any row failed to parse, or a plausibility rule of fomcPlausibilityFailures is
 *     violated): the page is rejected. Nothing is returned, and `failed` says why, so fomc is not ok
 *     and its stored rows are left alone (R2-1, R8-1, R9-1). The fallback is not used for a partial
 *     page, because it would hide the markup change.
 */
export async function fetchFomcMeetings(options: {
  readonly fetchImpl: FetchLike;
  readonly url?: string | undefined;
}): Promise<{
  meetings: FomcMeeting[];
  source: string;
  warnings: string[];
  failed?: string | undefined;
}> {
  const warnings: string[] = [];
  try {
    const response = await fetchOk(options.fetchImpl, options.url ?? FOMC_CALENDAR_URL, {
      source: CALENDAR_SOURCE_FED,
    });
    const html = await response.text();
    const page = parseFomcCalendarPage(html);
    if (page.failures.length > 0) {
      return {
        meetings: [],
        source: CALENDAR_SOURCE_FED,
        warnings: page.failures.map((failure) => `A10 FOMC page: ${failure}`),
        failed: `FOMC page parse was partial: ${page.failures.length} row(s) could not be dated`,
      };
    }
    if (page.meetings.length >= MIN_FOMC_MEETINGS_FROM_PAGE) {
      // R8-1 / R9-1: a page that is plausible row by row can still be wrong (a renamed class, a retagged
      // heading). Any plausibility violation makes the page partial: no rows, and no fallback.
      const implausible = fomcPlausibilityFailures(html, page.meetings);
      if (implausible.length > 0) {
        return {
          meetings: [],
          source: CALENDAR_SOURCE_FED,
          warnings: implausible.map((failure) => `A10 FOMC page: ${failure}`),
          failed: `FOMC page parse was partial: ${implausible.length} plausibility rule(s) violated`,
        };
      }
      return { meetings: page.meetings, source: CALENDAR_SOURCE_FED, warnings };
    }
    warnings.push(`A10 FOMC: page parsed only ${page.meetings.length} meetings; using fallback`);
  } catch (error) {
    warnings.push(
      error instanceof Error
        ? `A10 FOMC: ${error.message}; using fallback`
        : 'A10 FOMC: page read failed; using fallback',
    );
  }
  return {
    meetings: parseFomcFallback(fomcFallback),
    source: CALENDAR_SOURCE_FALLBACK,
    warnings,
  };
}

export function fomcRows(
  meetings: readonly FomcMeeting[],
  asOf: string,
  source: string,
): CalendarRow[] {
  return meetings.map((m) => ({
    date: m.decision,
    kind: 'fomc' as const,
    title: m.sep ? 'FOMC rate decision (with projections)' : 'FOMC rate decision',
    assetId: null,
    asOf,
    source,
  }));
}

/**
 * Parse a FRED /fred/release/dates payload into sorted, unique YYYY-MM-DD dates.
 * F5: `count` is the total FRED reports for the request. If it exceeds the rows returned, the
 * list is partial and the release fails (no rows), so a cut-off future date cannot pass silently.
 */
export function parseFredReleaseDates(json: unknown, releaseId: number): string[] {
  const source = `${FRED_RELEASE_DATES_SOURCE}:${releaseId}`;
  if (!isRecord(json) || !Array.isArray(json.release_dates)) {
    throw new SourceError(source, 'unexpected payload shape');
  }
  const entries = json.release_dates as unknown[];
  const count = json.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    throw new SourceError(source, 'response has no valid count; cannot confirm a complete list');
  }
  if (count > entries.length) {
    throw new SourceError(
      source,
      `response lists ${entries.length} of ${count} release dates; refusing a partial list`,
    );
  }
  const dates = new Set<string>();
  for (const item of entries) {
    if (!isRecord(item) || typeof item.date !== 'string' || !isIsoDate(item.date)) {
      throw new SourceError(source, 'release date entry has no valid date');
    }
    if (Number(item.release_id) !== releaseId) {
      throw new SourceError(source, 'release date entry names a different release');
    }
    dates.add(item.date);
  }
  return [...dates].sort();
}

/** FRED's maximum page size for release/dates. A longer list fails via the count check (F5). */
export const FRED_RELEASE_DATES_LIMIT = 1000;

/**
 * Scheduled release dates for one FRED release. include_release_dates_with_no_data is set so
 * future (not yet published) dates come back. order_by and limit are explicit (F5). Needs
 * FRED_API_KEY.
 */
export async function fetchFredReleaseDates(options: {
  readonly apiKey: string;
  readonly releaseId: number;
  readonly from: string;
  readonly to: string;
  readonly fetchImpl: FetchLike;
}): Promise<string[]> {
  const params = new URLSearchParams({
    release_id: String(options.releaseId),
    api_key: options.apiKey,
    file_type: 'json',
    realtime_start: options.from,
    realtime_end: options.to,
    include_release_dates_with_no_data: 'true',
    order_by: 'release_date',
    sort_order: 'asc',
    limit: String(FRED_RELEASE_DATES_LIMIT),
  });
  const json = await fetchJson(
    options.fetchImpl,
    `${FRED_API_BASE}/release/dates?${params.toString()}`,
    { source: `${FRED_RELEASE_DATES_SOURCE}:${options.releaseId}` },
  );
  return parseFredReleaseDates(json, options.releaseId);
}

export interface EtfDecisionEntry {
  readonly date: string;
  readonly title: string;
  readonly assetId: string | null;
  readonly source: string;
}

/**
 * Validate the admin ETF decision file: a JSON array of
 * { "date": "YYYY-MM-DD", "title": "...", "asset_id": null | "btc", "source": "..." }.
 * Throws with the entry index on any bad row, so the file can be fixed.
 */
export function parseEtfDecisionEntries(json: unknown): EtfDecisionEntry[] {
  if (!Array.isArray(json)) throw new SourceError('etf-decisions', 'file must be a JSON array');
  return (json as unknown[]).map((item, index) => {
    const fail = (detail: string): never => {
      throw new SourceError('etf-decisions', `entry ${index}: ${detail}`);
    };
    if (!isRecord(item)) return fail('not an object');
    if (typeof item.date !== 'string' || !isIsoDate(item.date))
      return fail('date must be YYYY-MM-DD');
    if (typeof item.title !== 'string' || item.title.trim() === '' || item.title.length > 140) {
      return fail('title must be 1 to 140 characters');
    }
    let assetId: string | null = null;
    if (item.asset_id !== undefined && item.asset_id !== null) {
      if (typeof item.asset_id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(item.asset_id)) {
        return fail('asset_id must be a lowercase id or null');
      }
      assetId = item.asset_id;
    }
    const source =
      typeof item.source === 'string' && item.source.trim() !== ''
        ? item.source.slice(0, 120)
        : 'admin:etf-decisions';
    return { date: item.date, title: item.title.trim(), assetId, source };
  });
}

export interface A10CalendarOptions {
  /** Today's date (UTC), YYYY-MM-DD. The window starts here. */
  readonly today: string;
  readonly windowDays?: number | undefined;
  readonly fetchImpl: FetchLike;
  /** FRED_API_KEY. Without it the CPI, payrolls and PCE rows are skipped with a warning. */
  readonly fredApiKey?: string | undefined;
  /** Parsed admin ETF file (JSON). Undefined means no file is configured. */
  readonly etfDecisionsJson?: unknown;
  /** Token unlock rows from CSN-026. Passed in because this module does not fetch unlocks. */
  readonly unlockEntries?: readonly CalendarRow[] | undefined;
  readonly fomcUrl?: string | undefined;
}

/**
 * A10 calendar for [today, today + windowDays]. Each source fails on its own, and the failure
 * becomes a warning. A failed FRED or ETF step does not block FOMC rows.
 */
/** Result of one A10 run. The store may replace stored rows of `kindsOk` only (F3). */
export interface A10CalendarResult {
  /** Set when fomc is not ok (partial page, or no FOMC meeting in the window). R2-1, R2-8. */
  readonly fomcFailure?: string | undefined;
  /** Window start (today, UTC). */
  readonly from: string;
  /** Window end, inclusive. */
  readonly to: string;
  readonly rows: CalendarRow[];
  readonly warnings: string[];
  /**
   * Kinds whose source succeeded this run, in CalendarEventKind order. A kind missing here had a
   * failed or unconfigured source, so its stored rows must be left untouched.
   */
  readonly kindsOk: CalendarKind[];
  /** FRED release-date requests attempted and answered (R5-2: all failing is a failed source). */
  readonly releasesRequested: number;
  readonly releasesOk: number;
}

export async function fetchA10Calendar(options: A10CalendarOptions): Promise<A10CalendarResult> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const end = addUtcDays(options.today, windowDays);
  const asOf = options.today;
  const rows: CalendarRow[] = [];
  const warnings: string[] = [];
  const ok = new Set<CalendarKind>();
  let releasesRequested = 0;
  let releasesOk = 0;

  // FOMC: the live page, or the maintained fallback. fomc is ok only when the rows it found include at
  // least one meeting in the window (R2-8). A partial page (R2-1) or a fallback that does not reach the
  // window leaves fomc not ok, so its stored rows are not replaced.
  const fomc = await fetchFomcMeetings({ fetchImpl: options.fetchImpl, url: options.fomcUrl });
  warnings.push(...fomc.warnings);
  rows.push(...fomcRows(fomc.meetings, asOf, fomc.source));
  const fomcInWindow = fomc.meetings.some((m) => m.decision >= options.today && m.decision <= end);
  let fomcFailure: string | undefined = fomc.failed;
  if (fomcInWindow) {
    ok.add('fomc');
  } else {
    fomcFailure =
      fomcFailure ??
      `no FOMC meeting falls in the window ${options.today} to ${end}: the ${fomc.source} rows do not cover it`;
    warnings.push(
      `A10 FOMC: ${fomcFailure}; fomc is not replaced, stored FOMC rows are left alone`,
    );
  }

  if (!options.fredApiKey) {
    warnings.push('A10 CPI, payrolls and PCE skipped: FRED_API_KEY is not set');
  } else {
    for (const release of FRED_RELEASE_KINDS) {
      releasesRequested += 1;
      try {
        const dates = await fetchFredReleaseDates({
          apiKey: options.fredApiKey,
          releaseId: release.releaseId,
          from: options.today,
          to: end,
          fetchImpl: options.fetchImpl,
        });
        for (const date of dates) {
          rows.push({
            date,
            kind: release.kind,
            title: release.title,
            assetId: null,
            asOf,
            source: FRED_RELEASE_DATES_SOURCE,
          });
        }
        ok.add(release.kind);
        releasesOk += 1;
      } catch (error) {
        warnings.push(
          error instanceof Error ? error.message : `A10 release ${release.releaseId} failed`,
        );
      }
    }
  }

  // ETF: only when an admin file is configured and valid. An unconfigured file leaves ETF rows alone.
  if (options.etfDecisionsJson !== undefined) {
    try {
      for (const entry of parseEtfDecisionEntries(options.etfDecisionsJson)) {
        rows.push({
          date: entry.date,
          kind: 'etf',
          title: entry.title,
          assetId: entry.assetId,
          asOf,
          source: entry.source,
        });
      }
      ok.add('etf');
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : 'A10 ETF decisions file failed');
    }
  }

  // Unlocks: a supplied list (even empty) counts as the unlock source having succeeded.
  if (options.unlockEntries !== undefined) {
    for (const row of options.unlockEntries) {
      if (row.kind !== 'unlock') {
        warnings.push(`A10 unlock input has kind ${row.kind}; ignored`);
        continue;
      }
      rows.push(row);
    }
    ok.add('unlock');
  }

  const inWindow = rows.filter((row) => row.date >= options.today && row.date <= end);
  const seen = new Set<string>();
  const unique = inWindow.filter((row) => {
    const key = `${row.assetId ?? ''}|${row.date}|${row.kind}|${row.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) =>
    a.date === b.date ? (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) : a.date < b.date ? -1 : 1,
  );
  return {
    from: options.today,
    to: end,
    rows: unique,
    warnings,
    kindsOk: CALENDAR_KINDS.filter((kind) => ok.has(kind)),
    releasesRequested,
    releasesOk,
    fomcFailure,
  };
}
