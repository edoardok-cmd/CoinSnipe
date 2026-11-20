import { describe, expect, it, vi } from 'vitest';
import { handleUpcomingCalendar, type CalendarApiDeps } from '../lib/calendarApi';

const NOW = new Date('2026-11-20T23:59:59.000Z');
const result = { from: '2026-11-20', to: '2026-12-20', days: 30, events: [] };

function deps(list?: CalendarApiDeps['list']) {
  const fn = vi.fn(list ?? (async () => result));
  return { fn, deps: { list: fn, now: () => NOW } satisfies CalendarApiDeps };
}
const get = (qs = '') => new Request(`http://x/api/calendar/upcoming${qs}`);

describe('handleUpcomingCalendar', () => {
  it('defaults from to today (UTC) and days to the reader default', async () => {
    const { fn, deps: d } = deps();
    const res = await handleUpcomingCalendar(get(), d);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual(result);
    expect(fn).toHaveBeenCalledWith({ from: '2026-11-20' });
  });

  it('passes from and days through', async () => {
    const { fn, deps: d } = deps();
    await handleUpcomingCalendar(get('?from=2026-12-01&days=7'), d);
    expect(fn).toHaveBeenCalledWith({ from: '2026-12-01', days: 7 });
  });

  it.each(['abc', '', '-1', '1.5', ' 5', '1e1'])('400 on non-integer days=%j', async (days) => {
    const { fn, deps: d } = deps();
    const res = await handleUpcomingCalendar(get(`?days=${encodeURIComponent(days)}`), d);
    expect(res.status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });

  it('400 when the reader rejects the input (bad from, days out of range)', async () => {
    const { deps: d } = deps(async () => {
      const e = new Error('from must be a YYYY-MM-DD date');
      e.name = 'CalendarInputError';
      throw e;
    });
    const res = await handleUpcomingCalendar(get('?from=nope'), d);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'from must be a YYYY-MM-DD date' });
  });

  it('500 without leaking the error text on an unexpected failure', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps: d } = deps(async () => {
      throw new Error('connect ECONNREFUSED postgres://user:secret@host/db');
    });
    const res = await handleUpcomingCalendar(get(), d);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret');
    spy.mockRestore();
  });
});
