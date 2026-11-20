import { NextResponse, type NextRequest } from 'next/server';
import { decideAccess } from './lib/auth/access';
import { hasSessionCookie } from './lib/auth/cookies';

/**
 * Protects /app/** (redirect to the sign-in page) and /api/v1/me/** (401 JSON) (CSN-050).
 * Cookie presence only: database sessions cannot be read from the edge runtime. Handlers
 * re-check the session row (lib/auth/session.ts). See lib/auth/access.ts.
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const decision = decideAccess(
    pathname,
    search,
    hasSessionCookie((name) => request.cookies.has(name)),
  );
  if (decision.action === 'redirect') {
    return NextResponse.redirect(new URL(decision.to, request.url));
  }
  if (decision.action === 'unauthorized') {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Sign in to continue.' } },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/app/:path*', '/api/v1/me/:path*'],
};
