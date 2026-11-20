/**
 * Read side of events_calendar (CSN-024-FOLLOWUP-8). The worker writes the rows
 * (replaceCalendarWindow); this is the query the Home upcoming-events panel and the Market-tab
 * calendar use: the next 30 days, date-only and inclusive at both ends.
 *
 * Pure and parameterised: Prisma builds the query, nothing is interpolated into SQL. The client is
 * injected, so the unit tests pass a fake.
 */
import type { PrismaClient } from '@prisma/client';

export const CALENDAR_DEFAULT_DAYS = 30;
export const CALENDAR_MAX_DAYS = 90;

export interface UpcomingCalendarEvent {
  /** BigInt id as a decimal string (BigInt is not JSON-serialisable). */
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  kind: string;
  title: string;
  assetId: string | null;
  asOf: string;
  source: string;
}

export interface UpcomingCalendar {
  from: string;
  to: string;
  days: number;
  events: UpcomingCalendarEvent[];
}

export class CalendarInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarInputError';
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a strict YYYY-MM-DD (a real calendar date) to a UTC-midnight Date, or throw. */
function parseDateOnly(value: unknown): Date {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new CalendarInputError('from must be a YYYY-MM-DD date');
  }
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new CalendarInputError('from must be a real calendar date');
  }
  return d;
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export type CalendarReader = Pick<PrismaClient, 'eventCalendarEntry'>;

export async function listUpcomingCalendar(
  prisma: CalendarReader,
  options: { from: string; days?: number },
): Promise<UpcomingCalendar> {
  const days = options.days ?? CALENDAR_DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > CALENDAR_MAX_DAYS) {
    throw new CalendarInputError(`days must be an integer from 1 to ${CALENDAR_MAX_DAYS}`);
  }
  const start = parseDateOnly(options.from);
  const end = new Date(start.getTime() + days * 86_400_000);

  const rows = await prisma.eventCalendarEntry.findMany({
    where: { date: { gte: start, lte: end } },
    orderBy: [{ date: 'asc' }, { kind: 'asc' }, { title: 'asc' }],
  });

  return {
    from: isoDate(start),
    to: isoDate(end),
    days,
    events: rows.map((r) => ({
      id: r.id.toString(),
      date: isoDate(r.date),
      kind: r.kind,
      title: r.title,
      assetId: r.assetId,
      asOf: isoDate(r.asOf),
      source: r.source,
    })),
  };
}
