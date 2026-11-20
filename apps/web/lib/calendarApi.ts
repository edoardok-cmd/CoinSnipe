/**
 * Request handling for GET /api/calendar/upcoming (CSN-024-FOLLOWUP-8). Kept out of route.ts so it
 * is testable without a database or a Next runtime: the reader is injected.
 */
export interface CalendarResult {
  from: string;
  to: string;
  days: number;
  events: unknown[];
}

export interface CalendarApiDeps {
  /** Throws an Error named 'CalendarInputError' on invalid input (see @coinsnipe/db). */
  list: (options: { from: string; days?: number }) => Promise<CalendarResult>;
  now: () => Date;
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function handleUpcomingCalendar(
  request: Request,
  deps: CalendarApiDeps,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const from = params.get('from') ?? deps.now().toISOString().slice(0, 10);
  const options: { from: string; days?: number } = { from };
  const rawDays = params.get('days');
  if (rawDays !== null) {
    // Number('') is 0 and Number(' 5') is 5: require plain digits so only integers get through.
    if (!/^\d+$/.test(rawDays)) return json({ error: 'days must be an integer from 1 to 90' }, 400);
    options.days = Number(rawDays);
  }
  try {
    return json(await deps.list(options), 200);
  } catch (err) {
    if (err instanceof Error && err.name === 'CalendarInputError') {
      return json({ error: err.message }, 400);
    }
    console.error('calendar upcoming failed', err instanceof Error ? err.name : 'unknown error');
    return json({ error: 'Internal error' }, 500);
  }
}
