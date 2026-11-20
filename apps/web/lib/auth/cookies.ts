/**
 * Session cookie configuration and the names middleware looks for (CSN-050).
 * Auth.js v5 names the cookie `authjs.session-token`, with a `__Secure-` prefix on https.
 * The flags are set explicitly instead of relying on library defaults so a unit test can pin them.
 */
export const SESSION_COOKIE_NAME = 'authjs.session-token';
export const SECURE_SESSION_COOKIE_NAME = '__Secure-authjs.session-token';

export const SESSION_COOKIE_NAMES: readonly string[] = [
  SESSION_COOKIE_NAME,
  SECURE_SESSION_COOKIE_NAME,
];

/** Sessions last 30 days and slide forward at most once a day. */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;

export function buildSessionCookie(isProduction: boolean) {
  return {
    name: isProduction ? SECURE_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME,
    options: {
      httpOnly: true,
      sameSite: 'lax' as const,
      path: '/',
      secure: isProduction,
    },
  };
}

export function hasSessionCookie(has: (name: string) => boolean): boolean {
  return SESSION_COOKIE_NAMES.some((name) => has(name));
}
