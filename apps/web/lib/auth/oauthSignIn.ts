import { decideOAuthSignIn, type ProviderProfile } from './linking';
import { isOAuthProvider } from './providers';

export const PROFILE_PATH = '/app/profile';

/**
 * Logic of the Auth.js signIn callback for Google and Apple (CSN-050). Returns what the callback
 * returns: true to continue, or a path to redirect to.
 *
 * - sessionUserId set: the user is signed in and Auth.js attaches the provider account to them
 *   (Google, GET callback). We only enforce the verified-email rule.
 * - no session but a valid link intent (Apple, cross-site POST): link here, then redirect.
 * - neither: an ordinary sign-in; Auth.js refuses a matching-email account (no dangerous linking).
 */
export async function handleOAuthSignIn(input: {
  account: { provider: string } | null | undefined;
  profile: ProviderProfile | undefined;
  sessionUserId: string | null;
  intentUserId: string | null;
  linkAccount(userId: string): Promise<void>;
  consumeIntent(): void;
}): Promise<true | string> {
  const provider = input.account?.provider;
  if (!provider || !isOAuthProvider(provider)) return true;

  const linking = input.sessionUserId ?? input.intentUserId;
  const decision = decideOAuthSignIn({ provider, profile: input.profile, sessionUserId: linking });
  if (!decision.allow) {
    if (input.intentUserId) input.consumeIntent();
    return linking ? `${PROFILE_PATH}?link_error=unverified-email` : '/sign-in?error=AccessDenied';
  }
  if (input.sessionUserId || !input.intentUserId) return true;

  input.consumeIntent();
  try {
    await input.linkAccount(input.intentUserId);
  } catch {
    // Unique (provider, providerAccountId) violation: already linked, to this or another user.
    return `${PROFILE_PATH}?link_error=already-linked`;
  }
  return `${PROFILE_PATH}?linked=${provider}`;
}
