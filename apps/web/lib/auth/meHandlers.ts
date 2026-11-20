/**
 * Request handlers for /api/v1/me/sessions and /api/v1/me/accounts/link (CSN-050). The route
 * files inject the real dependencies; tests inject fakes.
 */
import { jsonError, isSameOrigin, NO_STORE } from './requestGuards';
import { logOutEverywhere, type SessionStore } from './sessions';
import { LINK_INTENT_CLEAR_COOKIE } from './linkIntent';
import { SECURE_SESSION_COOKIE_NAME, SESSION_COOKIE_NAME } from './cookies';
import { isOAuthProvider, type OAuthProviderId } from './providers';

export const SESSION_CLEAR_COOKIES: readonly string[] = [
  `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
  `${SECURE_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  // A pending Apple link intent must not outlive the sessions it was issued for.
  LINK_INTENT_CLEAR_COOKIE,
];

export interface MeDeps {
  /** Validated against the sessions table, not just the cookie. null when not signed in. */
  getUserId(): Promise<string | null>;
}

export async function handleLogOutEverywhere(
  request: Request,
  deps: MeDeps & { sessions: SessionStore },
): Promise<Response> {
  if (!isSameOrigin(request))
    return jsonError(403, 'forbidden_origin', 'Request origin not allowed.');
  const userId = await deps.getUserId();
  if (!userId) return jsonError(401, 'unauthorized', 'Sign in to continue.');
  const removed = await logOutEverywhere(deps.sessions, userId);
  const res = Response.json({ ok: true, sessionsRemoved: removed }, { headers: NO_STORE });
  // Clear the cookie on this device as well; the row it pointed to is already gone.
  // The __Secure- cookie must carry Secure or browsers ignore even an expiring Set-Cookie.
  for (const header of SESSION_CLEAR_COOKIES) res.headers.append('Set-Cookie', header);
  return res;
}

export async function handleLinkProvider(
  request: Request,
  deps: MeDeps & {
    isEnabled(provider: OAuthProviderId): boolean;
    /** Starts the Auth.js OAuth flow for the signed-in user and returns the provider URL. */
    startLink(provider: OAuthProviderId): Promise<string>;
    /** Set-Cookie header for providers whose callback cannot carry the session cookie (Apple). */
    linkIntentCookie(userId: string, provider: OAuthProviderId): string | null;
  },
): Promise<Response> {
  if (!isSameOrigin(request))
    return jsonError(403, 'forbidden_origin', 'Request origin not allowed.');
  const userId = await deps.getUserId();
  if (!userId) return jsonError(401, 'unauthorized', 'Sign in to continue.');

  let provider: unknown;
  try {
    provider = ((await request.json()) as { provider?: unknown } | null)?.provider;
  } catch {
    return jsonError(400, 'invalid_body', 'Send a JSON body like {"provider":"google"}.');
  }
  if (!isOAuthProvider(provider)) {
    return jsonError(400, 'invalid_provider', 'Provider must be "google" or "apple".');
  }
  if (!deps.isEnabled(provider)) {
    return jsonError(404, 'provider_unavailable', 'That sign-in method is not available.');
  }
  const url = await deps.startLink(provider);
  const res = Response.json({ url }, { headers: NO_STORE });
  const intent = deps.linkIntentCookie(userId, provider);
  if (intent) res.headers.append('Set-Cookie', intent);
  return res;
}
