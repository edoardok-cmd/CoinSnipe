/**
 * Source fetchers for the asset universe (CSN-020): CoinGecko and DefiLlama over a small
 * rate-limited, retrying HTTP client.
 *
 * Everything that touches the outside world is injected (`fetch`, `sleep`, `now`), so tests run
 * with a fake clock and no network. The CoinGecko key travels only in a request header, taken
 * from COINGECKO_API_KEY (listed in .env.example); it is never put in a URL, an error message
 * or a log line.
 */
import {
  DEFAULT_OVERRIDES,
  DEFAULT_UNIVERSE_CONFIG,
  UNIVERSE_CANDIDATE_POOL,
  classifyCandidate,
} from './buildUniverse';
import type {
  CoinGeckoCoinDetail,
  CoinGeckoMarketRow,
  DefiLlamaChain,
  DefiLlamaParentProtocol,
  DefiLlamaProtocol,
  UniverseConfig,
  UniverseOverrides,
} from './buildUniverse';

// ---------------------------------------------------------------------------
// HTTP client with rate limit and retry
// ---------------------------------------------------------------------------

/** The slice of `Response` the client uses, so tests can pass a plain object. */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<FetchResponseLike>;

export interface HttpDeps {
  readonly fetch: FetchLike;
  /** Resolves after `ms` milliseconds. Tests replace it with a fake clock. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Milliseconds, monotonic or wall clock. */
  readonly now: () => number;
}

export interface HttpClientConfig {
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Minimum gap between the starts of two requests (the rate limit). */
  readonly minIntervalMs: number;
  /** Retries after the first attempt. */
  readonly maxRetries: number;
  /** First retry delay; doubles each attempt up to `maxBackoffMs`. */
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  /** HTTP statuses worth retrying. Network errors are always retried. */
  readonly retryStatuses: readonly number[];
}

export interface HttpClient {
  getJson<T = unknown>(path: string): Promise<T>;
}

/** An error response that was not retried or ran out of retries. Carries no headers. */
export class HttpError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string, attempts: number) {
    super(`GET ${path} failed with HTTP ${status} after ${attempts} attempt(s)`);
    this.name = 'HttpError';
    this.status = status;
    this.path = path;
  }
}

const DEFAULT_RETRY_STATUSES: readonly number[] = [408, 429, 500, 502, 503, 504];

function parseRetryAfterMs(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

export function createHttpClient(config: HttpClientConfig, deps: HttpDeps): HttpClient {
  let nextSlotAt = 0;
  let queue: Promise<void> = Promise.resolve();

  // Requests take their slot one at a time, so concurrent callers still obey the interval.
  const takeSlot = async (): Promise<void> => {
    const previous = queue;
    let release: () => void = () => undefined;
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const wait = nextSlotAt - deps.now();
      if (wait > 0) await deps.sleep(wait);
      nextSlotAt = deps.now() + config.minIntervalMs;
    } finally {
      release();
    }
  };

  const backoff = (attempt: number): number =>
    Math.min(config.baseBackoffMs * 2 ** attempt, config.maxBackoffMs);

  return {
    async getJson<T = unknown>(path: string): Promise<T> {
      const url = `${config.baseUrl}${path}`;
      const attempts = config.maxRetries + 1;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const last = attempt === attempts - 1;
        await takeSlot();
        let response: FetchResponseLike;
        try {
          response = await deps.fetch(
            url,
            config.headers ? { headers: { ...config.headers } } : {},
          );
        } catch {
          // Network failure. The cause may mention the URL but never the headers.
          if (last)
            throw new Error(`GET ${path} failed: network error after ${attempts} attempt(s)`);
          await deps.sleep(backoff(attempt));
          continue;
        }
        if (response.ok) return (await response.json()) as T;
        if (!config.retryStatuses.includes(response.status) || last) {
          throw new HttpError(response.status, path, attempt + 1);
        }
        const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
        await deps.sleep(Math.min(retryAfter ?? backoff(attempt), config.maxBackoffMs));
      }
      throw new Error(`GET ${path} failed`); // unreachable: the loop returns or throws
    },
  };
}

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

export type CoinGeckoPlan = 'public' | 'demo' | 'basic' | 'analyst';

/** Calls per minute the plan allows, turned into a spacing, with a little headroom. */
const COINGECKO_MIN_INTERVAL_MS: Readonly<Record<CoinGeckoPlan, number>> = {
  public: 6500,
  demo: 2100,
  basic: 300,
  analyst: 150,
};

const RETRY_DEFAULTS = {
  maxRetries: 4,
  baseBackoffMs: 2000,
  maxBackoffMs: 60_000,
  retryStatuses: DEFAULT_RETRY_STATUSES,
} as const;

/**
 * CoinGecko client configuration from the environment (COINGECKO_API_KEY, COINGECKO_PLAN).
 * No key means the public endpoint at its low limit. `demo` uses the public host with the demo
 * header; `basic` and `analyst` use the paid host with the pro header.
 */
export function coingeckoConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  overrides: Partial<HttpClientConfig> = {},
): HttpClientConfig {
  const key = env['COINGECKO_API_KEY']?.trim() ?? '';
  const requested = (env['COINGECKO_PLAN'] ?? '').trim().toLowerCase();
  let plan: CoinGeckoPlan = 'public';
  if (key !== '') {
    plan = requested === 'basic' || requested === 'analyst' ? requested : 'demo';
  }
  const paid = plan === 'basic' || plan === 'analyst';
  return {
    baseUrl: paid ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3',
    ...(key === '' ? {} : { headers: { [paid ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key']: key } }),
    minIntervalMs: COINGECKO_MIN_INTERVAL_MS[plan],
    ...RETRY_DEFAULTS,
    ...overrides,
  };
}

/** DefiLlama's /protocols and /v2/chains are free and need no key. */
export function defillamaConfig(overrides: Partial<HttpClientConfig> = {}): HttpClientConfig {
  return {
    baseUrl: 'https://api.llama.fi',
    minIntervalMs: 250,
    ...RETRY_DEFAULTS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

function expectArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected a JSON array`);
  return value;
}

/** CoinGecko /coins/markets, top `pool` coins by market cap in USD, in rank order. */
export async function fetchMarkets(
  client: HttpClient,
  options: { pool?: number; perPage?: number } = {},
): Promise<CoinGeckoMarketRow[]> {
  const pool = options.pool ?? UNIVERSE_CANDIDATE_POOL;
  const perPage = options.perPage ?? 250;
  const rows: CoinGeckoMarketRow[] = [];
  for (let page = 1; rows.length < pool; page += 1) {
    const batch = expectArray(
      await client.getJson(
        `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}&sparkline=false`,
      ),
      'CoinGecko /coins/markets',
    ) as CoinGeckoMarketRow[];
    rows.push(...batch);
    if (batch.length < perPage) break;
  }
  return rows.slice(0, pool);
}

/** CoinGecko /coins/{id} without the heavy sections. */
export async function fetchCoinDetail(
  client: HttpClient,
  id: string,
): Promise<CoinGeckoCoinDetail> {
  return client.getJson<CoinGeckoCoinDetail>(
    `/coins/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`,
  );
}

/**
 * Mean daily volume from a CoinGecko `total_volumes` series. A daily chart over 7 days ends with
 * today's partial day; when there are more than 7 points the last one is dropped so the mean
 * covers 7 whole days.
 */
export function averageDailyVolume(
  totalVolumes: ReadonlyArray<readonly [number, number]>,
): number | null {
  const values = totalVolumes
    .map((point) => point[1])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  const window = values.length > 7 ? values.slice(-8, -1) : values;
  if (window.length === 0) return null;
  return window.reduce((sum, v) => sum + v, 0) / window.length;
}

/** 7-day average daily volume in USD for one coin, or null if CoinGecko has no series. */
export async function fetchVolume7dAvg(client: HttpClient, id: string): Promise<number | null> {
  const chart = await client.getJson<{ total_volumes?: Array<[number, number]> }>(
    `/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=7&interval=daily`,
  );
  return averageDailyVolume(chart.total_volumes ?? []);
}

export async function fetchDefillamaProtocols(client: HttpClient): Promise<DefiLlamaProtocol[]> {
  return expectArray(
    await client.getJson('/protocols'),
    'DefiLlama /protocols',
  ) as DefiLlamaProtocol[];
}

/**
 * Parent projects from `/lite/protocols2`. /protocols carries only the versions of a project;
 * the project-level `gecko_id` is on the parent, so this is what lets "Uniswap" match UNI.
 */
export async function fetchDefillamaParents(
  client: HttpClient,
): Promise<DefiLlamaParentProtocol[]> {
  const lite = await client.getJson<{ parentProtocols?: unknown }>('/lite/protocols2');
  return expectArray(
    lite.parentProtocols ?? [],
    'DefiLlama /lite/protocols2 parentProtocols',
  ) as DefiLlamaParentProtocol[];
}

export async function fetchDefillamaChains(client: HttpClient): Promise<DefiLlamaChain[]> {
  return expectArray(
    await client.getJson('/v2/chains'),
    'DefiLlama /v2/chains',
  ) as DefiLlamaChain[];
}

// ---------------------------------------------------------------------------
// One call that gathers everything buildUniverse needs
// ---------------------------------------------------------------------------

export interface UniverseSources {
  readonly markets: CoinGeckoMarketRow[];
  readonly details: Record<string, CoinGeckoCoinDetail>;
  readonly volume7dAvg: Record<string, number>;
  /** Ids whose volume call failed; `buildUniverse` treats them as incomplete. */
  readonly volumeFailed: string[];
  readonly protocols: DefiLlamaProtocol[];
  readonly parentProtocols: DefiLlamaParentProtocol[];
  readonly chains: DefiLlamaChain[];
  /** Per-coin calls that failed after all retries: `detail:<id>` or `volume:<id>`. */
  readonly failures: string[];
}

export interface FetchUniverseSourcesOptions {
  readonly coingecko: HttpClient;
  readonly defillama: HttpClient;
  readonly overrides?: UniverseOverrides;
  readonly config?: Partial<UniverseConfig>;
  readonly pool?: number;
  /** Progress lines. Never receives headers or keys. */
  readonly log?: (line: string) => void;
}

/**
 * Reads DefiLlama first (cheap, and a failure there stops the run before the long CoinGecko
 * pass), then CoinGecko markets, then one detail call per candidate, then one volume call per
 * candidate that survives the category filters. A failed per-coin call is recorded in
 * `failures` and left out; `buildUniverse` treats a missing detail as "incomplete".
 */
export async function fetchUniverseSources(
  options: FetchUniverseSourcesOptions,
): Promise<UniverseSources> {
  const overrides = options.overrides ?? DEFAULT_OVERRIDES;
  const config: UniverseConfig = { ...DEFAULT_UNIVERSE_CONFIG, ...options.config };
  const log = options.log ?? (() => undefined);

  const protocols = await fetchDefillamaProtocols(options.defillama);
  const parentProtocols = await fetchDefillamaParents(options.defillama);
  const chains = await fetchDefillamaChains(options.defillama);
  log(
    `defillama: ${protocols.length} protocols, ${parentProtocols.length} parents, ${chains.length} chains`,
  );

  const markets = await fetchMarkets(options.coingecko, {
    ...(options.pool === undefined ? {} : { pool: options.pool }),
  });
  log(`coingecko: ${markets.length} market rows`);

  const failures: string[] = [];
  const details: Record<string, CoinGeckoCoinDetail> = {};
  for (const row of markets) {
    if (overrides.coins[row.id]?.exclude === true) continue;
    try {
      details[row.id] = await fetchCoinDetail(options.coingecko, row.id);
    } catch {
      failures.push(`detail:${row.id}`);
    }
  }

  const volume7dAvg: Record<string, number> = {};
  const volumeFailed: string[] = [];
  for (const row of markets) {
    const detail = details[row.id];
    if (detail === undefined) continue;
    const cls = classifyCandidate(row.id, detail, overrides, config);
    if (cls.reason !== null || cls.isGoldToken) continue;
    try {
      const avg = await fetchVolume7dAvg(options.coingecko, row.id);
      if (avg !== null) volume7dAvg[row.id] = avg;
    } catch {
      failures.push(`volume:${row.id}`);
      volumeFailed.push(row.id);
    }
  }
  log(
    `coingecko: ${Object.keys(details).length} details, ${Object.keys(volume7dAvg).length} volume series, ${failures.length} failed call(s)`,
  );
  return {
    markets,
    details,
    volume7dAvg,
    volumeFailed,
    protocols,
    parentProtocols,
    chains,
    failures,
  };
}
