/** Small helpers shared by the /api/v1/me handlers (CSN-050). */

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: NO_STORE });
}

/**
 * State-changing requests must come from our own origin. SameSite=Lax already keeps the
 * session cookie off cross-site POST/DELETE; this is the second layer. A missing Origin is
 * refused: browsers always send it on these methods.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    const ownHost =
      request.headers.get('x-forwarded-host') ??
      request.headers.get('host') ??
      new URL(request.url).host;
    return new URL(origin).host === ownHost;
  } catch {
    return false;
  }
}
