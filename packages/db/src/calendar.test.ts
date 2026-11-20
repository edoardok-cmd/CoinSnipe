import { describe, expect, it, vi } from 'vitest';
import { CalendarInputError, listUpcomingCalendar, type CalendarReader } from './calendar';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function fake(rows: unknown[] = []) {
  const findMany = vi.fn().mockResolvedValue(rows);
  return { findMany, prisma: { eventCalendarEntry: { findMany } } as unknown as CalendarReader };
}

describe('listUpcomingCalendar', () => {
  it('queries the inclusive [from, from+30d] window ordered by date, kind, title', async () => {
    const { findMany, prisma } = fake();
    const out = await listUpcomingCalendar(prisma, { from: '2026-11-20' });
    expect(findMany).toHaveBeenCalledWith({
      where: { date: { gte: d('2026-11-20'), lte: d('2026-12-20') } },
      orderBy: [{ date: 'asc' }, { kind: 'asc' }, { title: 'asc' }],
    });
    expect(out).toEqual({ from: '2026-11-20', to: '2026-12-20', days: 30, events: [] });
  });

  it('honours days and crosses year and leap boundaries', async () => {
    const { findMany, prisma } = fake();
    const out = await listUpcomingCalendar(prisma, { from: '2027-12-20', days: 90 });
    expect(out.to).toBe('2028-03-19');
    expect(findMany.mock.calls[0]![0].where.date.lte).toEqual(d('2028-03-19'));
  });

  it('serialises BigInt id to a string and dates to YYYY-MM-DD, keeping asset_id', async () => {
    const { prisma } = fake([
      {
        id: 9007199254740993n,
        date: d('2026-11-25'),
        kind: 'fomc',
        title: 'FOMC decision',
        assetId: null,
        asOf: d('2026-11-20'),
        fetchedAt: new Date(),
        source: 'sample',
      },
      {
        id: 2n,
        date: d('2026-11-26'),
        kind: 'unlock',
        title: 'ARB unlock',
        assetId: 'arbitrum',
        asOf: d('2026-11-20'),
        fetchedAt: new Date(),
        source: 'sample',
      },
    ]);
    const { events } = await listUpcomingCalendar(prisma, { from: '2026-11-20' });
    expect(events[0]).toEqual({
      id: '9007199254740993',
      date: '2026-11-25',
      kind: 'fomc',
      title: 'FOMC decision',
      assetId: null,
      asOf: '2026-11-20',
      source: 'sample',
    });
    expect(events[1]!.assetId).toBe('arbitrum');
    expect(() => JSON.stringify(events)).not.toThrow();
  });

  it.each(['2026-13-01', '2026-02-30', '20261120', '2026-11-20T00:00', '', 'today'])(
    'rejects from=%j',
    async (from) => {
      const { findMany, prisma } = fake();
      await expect(listUpcomingCalendar(prisma, { from })).rejects.toBeInstanceOf(
        CalendarInputError,
      );
      expect(findMany).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 91, 1.5, Number.NaN])('rejects days=%s', async (days) => {
    const { findMany, prisma } = fake();
    await expect(listUpcomingCalendar(prisma, { from: '2026-11-20', days })).rejects.toBeInstanceOf(
      CalendarInputError,
    );
    expect(findMany).not.toHaveBeenCalled();
  });
});
