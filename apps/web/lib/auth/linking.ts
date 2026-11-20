/**
 * Account linking rules (CSN-050). allowDangerousEmailAccountLinking stays false, so a Google
 * or Apple login that shares an email with an existing account is refused by Auth.js
 * (AccountNotLinked). Linking happens only on purpose: a signed-in user starts it from
 * Profile, and Auth.js then attaches the provider account to THAT session's user. This file
 * adds the one rule Auth.js does not: the provider must say the email is verified.
 */
import type { OAuthProviderId } from './providers';

export type ProviderProfile = { email?: string | null; email_verified?: boolean | string | null };

/** Google sends a boolean; Apple sends true or the string "true". Anything else is unverified. */
export function isProviderEmailVerified(profile: ProviderProfile | undefined): boolean {
  if (!profile?.email) return false;
  const flag = profile.email_verified;
  return flag === true || flag === 'true';
}

export type OAuthSignInDecision =
  { allow: true; mode: 'sign-in' | 'link' } | { allow: false; reason: 'unverified-email' };

/**
 * sessionUserId is set when someone is already signed in, which makes this an explicit link
 * from Profile. Both a link and a fresh sign-in require a verified provider email.
 */
export function decideOAuthSignIn(input: {
  provider: OAuthProviderId;
  profile: ProviderProfile | undefined;
  sessionUserId: string | null;
}): OAuthSignInDecision {
  if (!isProviderEmailVerified(input.profile)) return { allow: false, reason: 'unverified-email' };
  return { allow: true, mode: input.sessionUserId ? 'link' : 'sign-in' };
}
