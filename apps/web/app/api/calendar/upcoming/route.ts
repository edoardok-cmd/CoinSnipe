import { handleUpcomingCalendar } from '../../../../lib/calendarApi';

// Live data: never prerendered or cached.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  // Imported lazily so the Prisma client is only loaded when the route is hit.
  const { prisma, listUpcomingCalendar } = await import('@coinsnipe/db');
  return handleUpcomingCalendar(request, {
    list: (options) => listUpcomingCalendar(prisma, options),
    now: () => new Date(),
  });
}
