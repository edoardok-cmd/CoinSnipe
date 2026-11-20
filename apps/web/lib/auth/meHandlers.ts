/**
 * Request handlers for /api/v1/me/sessions and /api/v1/me/accounts/link (CSN-050). The route
 * files inject the real dependencies; tests inject fakes.
 */
import { jsonError, isSameOrigin, NO_STORE } from './requestGuards';
import { logOutEverywhere, type SessionStore } from './sessions';
import { isOAuthProvider, type OAuthProviderId } from './providers';

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
  for (const name of ['authjs.session-token', '__Secure-authjs.session-token']) {
    res.headers.append('Set-Cookie', `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  }
  return res;
}

export async function handleLinkProvider(
  request: Request,
  deps: MeDeps & {
    isEnabled(provider: OAuthProviderId): boolean;
    /** Starts the Auth.js OAuth flow for the signed-in user and returns the provider URL. */
    startLink(provider: OAuthProviderId): Promise<string>;
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
  return Response.json({ url }, { headers: NO_STORE });
}
