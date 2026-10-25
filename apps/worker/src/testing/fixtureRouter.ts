/**
 * Test-only HTTP router for the macro job. It serves the SAMPLE_ fixtures from
 * packages/data/src/__fixtures__ for every upstream the job calls (FRED, alternative.me, the Fed
 * calendar, the GPR workbook and CoinGecko). No vendor is contacted. Not imported by production code.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FIXTURES = fileURLToPath(
  new URL('../../../../packages/data/src/__fixtures__/', import.meta.url),
);

export type FixtureRouter = (url: string, init?: RequestInit) => Promise<Response>;

export interface FixtureRouterOptions {
  /** Answer every FRED series request with HTTP 400 (a rejected key or a bad request). */
  readonly rejectAllFredSeries?: boolean | undefined;
  /** Answer every FRED release-date request with HTTP 503. */
  readonly rejectAllFredReleases?: boolean | undefined;
  /** Answer these FRED series ids with HTTP 400 and the rest normally (R7-3). */
  readonly failFredSeries?: readonly string[] | undefined;
  /** Answer only FRED release 54 with HTTP 503. */
  readonly failFredRelease54?: boolean | undefined;
  /** Answer every CoinGecko request with HTTP 503 (both gold coins fail). R6-1. */
  readonly rejectAllCoinGecko?: boolean | undefined;
  /** Answer the FOMC page with HTTP 503 (the fallback then decides the window). R2-8. */
  readonly failFomcPage?: boolean | undefined;
  /** Serve this FOMC page instead of the SAMPLE excerpt (for a partial-page test). R2-1. */
  readonly fomcHtml?: string | undefined;
  /** Record every requested URL (for asserting which upstreams were called). */
  readonly calls?: string[] | undefined;
}

export function fixtureBytes(name: string): Buffer {
  return readFileSync(`${FIXTURES}${name}`);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function fixtureRouter(options: FixtureRouterOptions = {}): FixtureRouter {
  const series = JSON.parse(fixtureBytes('SAMPLE_fred_series.json').toString()) as Record<
    string,
    unknown
  >;
  const releases = JSON.parse(fixtureBytes('SAMPLE_fred_release_dates.json').toString()) as Record<
    string,
    unknown
  >;
  const gold = JSON.parse(fixtureBytes('SAMPLE_coingecko_gold.json').toString()) as Record<
    string,
    unknown
  >;
  const fng = JSON.parse(fixtureBytes('SAMPLE_alternative_me_fng.json').toString()) as unknown;
  const fomcHtml = fixtureBytes('SAMPLE_fomc_calendar_excerpt.html').toString();
  const gprBytes = new Uint8Array(fixtureBytes('SAMPLE_gpr_workbook.xlsx'));

  return async (url) => {
    options.calls?.push(url);
    const u = new URL(url);
    if (u.hostname === 'api.stlouisfed.org' && u.pathname === '/fred/series/observations') {
      const seriesId = u.searchParams.get('series_id') ?? '';
      if (options.rejectAllFredSeries || options.failFredSeries?.includes(seriesId)) {
        return json({ error_message: 'Bad Request' }, 400);
      }
      const payload = series[seriesId];
      return payload === undefined ? json({ error_message: 'unknown series' }, 400) : json(payload);
    }
    if (u.hostname === 'api.stlouisfed.org' && u.pathname === '/fred/release/dates') {
      const id = u.searchParams.get('release_id') ?? '';
      if (options.rejectAllFredReleases) return new Response('unavailable', { status: 503 });
      if (id === '54' && options.failFredRelease54)
        return new Response('unavailable', { status: 503 });
      return json(releases[id] ?? { release_dates: [], count: 0 });
    }
    if (u.hostname === 'api.alternative.me') return json(fng);
    if (u.hostname === 'www.federalreserve.gov') {
      if (options.failFomcPage) return new Response('unavailable', { status: 503 });
      return new Response(options.fomcHtml ?? fomcHtml, { status: 200 });
    }
    if (u.hostname === 'www.matteoiacoviello.com') return new Response(gprBytes, { status: 200 });
    if (u.hostname === 'api.coingecko.com') {
      if (options.rejectAllCoinGecko) return new Response('unavailable', { status: 503 });
      const coin = u.pathname.split('/')[4] ?? '';
      const payload = gold[coin];
      return payload === undefined ? json({ error: 'not found' }, 404) : json(payload);
    }
    return new Response('not found', { status: 404 });
  };
}
