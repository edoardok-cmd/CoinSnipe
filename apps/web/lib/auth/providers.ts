/**
 * Which sign-in providers are available, decided by env (CSN-050). A provider with missing
 * credentials is left out instead of failing at boot.
 */
export type ProviderId = 'resend' | 'google' | 'apple';
export type OAuthProviderId = 'google' | 'apple';

type Env = Record<string, string | undefined>;

export function enabledProviders(env: Env): ProviderId[] {
  const out: ProviderId[] = [];
  if (env['RESEND_API_KEY'] && env['EMAIL_FROM']) out.push('resend');
  if (env['AUTH_GOOGLE_ID'] && env['AUTH_GOOGLE_SECRET']) out.push('google');
  if (env['AUTH_APPLE_ID'] && env['AUTH_APPLE_SECRET']) out.push('apple');
  return out;
}

export function isOAuthProvider(value: unknown): value is OAuthProviderId {
  return value === 'google' || value === 'apple';
}
