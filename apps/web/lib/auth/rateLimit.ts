/**
 * Magic-link rate limits (CSN-050): 5 per email per hour and 20 per IP per hour.
 *
 * LIMITATION: the default store is in memory, so counts are per server instance and reset on
 * restart. On serverless hosting with several instances the effective ceiling is higher than
 * the nominal one. No rate-limit table exists in the Prisma schema (CSN-003), and schema
 * changes belong to the database owner. The RateLimitStore interface is the seam for a
 * Postgres or Redis store; see docs/auth-setup.md.
 */
export const MAGIC_LINK_WINDOW_MS = 60 * 60 * 1000;
export const MAGIC_LINK_EMAIL_LIMIT = 5;
export const MAGIC_LINK_IP_LIMIT = 20;

export interface RateLimitStore {
  /** Records one hit for the key and returns how many hits fall inside the window, this one included. */
  hit(key: string, windowMs: number, now: number): Promise<number>;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, number[]>();
  private static readonly MAX_KEYS = 50_000;

  async hit(key: string, windowMs: number, now: number): Promise<number> {
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - windowMs);
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > InMemoryRateLimitStore.MAX_KEYS) this.prune(windowMs, now);
    return recent.length;
  }

  private prune(windowMs: number, now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((t) => t <= now - windowMs)) this.hits.delete(key);
    }
  }
}

export type RateLimitResult = { allowed: true } | { allowed: false; limitedBy: 'email' | 'ip' };

export function normalizeEmailKey(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Client IP for the per-IP limit. Assumes the app sits behind a proxy that sets x-real-ip or
 * overwrites/appends x-forwarded-for (Vercel does). x-real-ip wins; otherwise the LAST
 * x-forwarded-for entry is used, the one our own proxy appended, because earlier entries are
 * client-supplied. Without any proxy header everyone shares the 'unknown' bucket.
 */
export function clientIp(headers: Headers): string {
  const real = headers.get('x-real-ip')?.trim();
  if (real) return real;
  const parts = headers.get('x-forwarded-for')?.split(',') ?? [];
  return parts[parts.length - 1]?.trim() || 'unknown';
}

/** Both counters are always incremented, so a blocked caller keeps using up its own budget. */
export async function checkMagicLinkLimit(
  store: RateLimitStore,
  input: { email: string; ip: string; now?: number },
): Promise<RateLimitResult> {
  const now = input.now ?? Date.now();
  const emailCount = await store.hit(
    `magic:email:${normalizeEmailKey(input.email)}`,
    MAGIC_LINK_WINDOW_MS,
    now,
  );
  const ipCount = await store.hit(`magic:ip:${input.ip}`, MAGIC_LINK_WINDOW_MS, now);
  if (emailCount > MAGIC_LINK_EMAIL_LIMIT) return { allowed: false, limitedBy: 'email' };
  if (ipCount > MAGIC_LINK_IP_LIMIT) return { allowed: false, limitedBy: 'ip' };
  return { allowed: true };
}

const globalForLimit = globalThis as unknown as { coinsnipeRateLimitStore?: RateLimitStore };

export function defaultRateLimitStore(): RateLimitStore {
  globalForLimit.coinsnipeRateLimitStore ??= new InMemoryRateLimitStore();
  return globalForLimit.coinsnipeRateLimitStore;
}
