import { emitAuthEvent } from './analytics';
import type { OAuthProviderId } from './providers';

/** Sign-in page: emits signup_started (method only, no email) and then starts the OAuth flow. */
export async function beginOAuthSignIn(
  provider: OAuthProviderId,
  start: (provider: OAuthProviderId) => Promise<unknown>,
): Promise<void> {
  emitAuthEvent('signup_started', provider);
  await start(provider);
}
