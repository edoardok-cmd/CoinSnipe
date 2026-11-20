/**
 * Link-intent cookie for explicit Apple linking (CSN-050).
 *
 * Apple answers with a cross-site form POST, and browsers do not send the SameSite=Lax session
 * cookie on that request, so Auth.js cannot tell which signed-in user is linking. The link route
 * (which has a validated session) therefore sets this short-lived, HttpOnly, HMAC-signed cookie,
 * scoped to the Apple callback path with SameSite=None; Secure. The signIn callback verifies it
 * and links the Apple account to the user named in it. The verified-email rule still applies.
 * The cookie is useless without the server secret and cannot be read or set from page scripts.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const LINK_INTENT_COOKIE = '__Secure-csn-link-intent';
export const LINK_INTENT_PATH = '/api/auth/callback/apple';
export const LINK_INTENT_MAX_AGE_SECONDS = 5 * 60;

const mac = (secret: string, body: string): string =>
  createHmac('sha256', secret).update(body).digest('base64url');

export function createLinkIntentValue(secret: string, userId: string, now: number): string {
  const payload = {
    u: userId,
    e: now + LINK_INTENT_MAX_AGE_SECONDS * 1000,
    n: randomBytes(8).toString('hex'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(secret, body)}`;
}

/** Returns the user id, or null for anything missing, forged, malformed or expired. */
export function verifyLinkIntentValue(
  secret: string,
  value: string | undefined,
  now: number,
): string | null {
  if (!secret || !value) return null;
  const [body, signature, ...rest] = value.split('.');
  if (!body || !signature || rest.length > 0) return null;
  const expected = Buffer.from(mac(secret, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      u?: unknown;
      e?: unknown;
    };
    if (typeof payload.u !== 'string' || typeof payload.e !== 'number') return null;
    return payload.e > now ? payload.u : null;
  } catch {
    return null;
  }
}

const ATTRS = `Path=${LINK_INTENT_PATH}; HttpOnly; Secure; SameSite=None`;

export function linkIntentSetCookie(secret: string, userId: string, now: number): string {
  return `${LINK_INTENT_COOKIE}=${createLinkIntentValue(secret, userId, now)}; ${ATTRS}; Max-Age=${LINK_INTENT_MAX_AGE_SECONDS}`;
}

export const LINK_INTENT_CLEAR_COOKIE = `${LINK_INTENT_COOKIE}=; ${ATTRS}; Max-Age=0`;

/** Set-Cookie for the link route: only Apple needs it, and only when AUTH_SECRET is set. */
export function linkIntentCookieFor(
  userId: string,
  provider: string,
  env: Record<string, string | undefined>,
  now: number,
): string | null {
  const secret = env['AUTH_SECRET'];
  return provider === 'apple' && secret ? linkIntentSetCookie(secret, userId, now) : null;
}

/** User id named by a valid link-intent cookie value, or null. Used by the signIn callback. */
export function readIntentUserId(
  cookieValue: string | undefined,
  env: Record<string, string | undefined>,
  now: number,
): string | null {
  return verifyLinkIntentValue(env['AUTH_SECRET'] ?? '', cookieValue, now);
}

/** Options for expiring the cookie through next/headers; same attributes as LINK_INTENT_CLEAR_COOKIE. */
export const LINK_INTENT_CLEAR_OPTIONS = {
  path: LINK_INTENT_PATH,
  httpOnly: true,
  secure: true,
  sameSite: 'none',
  maxAge: 0,
} as const;
