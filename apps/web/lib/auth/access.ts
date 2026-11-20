/**
 * Route protection decision used by middleware.ts (CSN-050).
 *
 * Sessions are stored in the database, and the Prisma client cannot run in the edge runtime
 * where middleware executes. Middleware therefore only checks that a session cookie is
 * PRESENT, which is a cheap first gate and not a proof of login. The real validation (the
 * session row exists and has not expired) happens in route handlers and server components
 * through requireSessionUserId() in lib/auth/session.ts.
 */
export type AccessDecision =
  { action: 'next' } | { action: 'redirect'; to: string } | { action: 'unauthorized' };

export const SIGN_IN_PATH = '/sign-in';

const isUnder = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

export function isProtectedPage(pathname: string): boolean {
  return isUnder(pathname, '/app');
}

export function isProtectedApi(pathname: string): boolean {
  return isUnder(pathname, '/api/v1/me');
}

export function decideAccess(
  pathname: string,
  search: string,
  hasSession: boolean,
): AccessDecision {
  if (isProtectedApi(pathname)) return hasSession ? { action: 'next' } : { action: 'unauthorized' };
  if (isProtectedPage(pathname) && !hasSession) {
    const callbackUrl = encodeURIComponent(`${pathname}${search}`);
    return { action: 'redirect', to: `${SIGN_IN_PATH}?callbackUrl=${callbackUrl}` };
  }
  return { action: 'next' };
}
