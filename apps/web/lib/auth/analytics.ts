/**
 * Auth analytics events (CSN-050): signup_started and signup_completed. Properties carry the
 * method only: never an email, name or user id. No analytics client is wired in yet, so the
 * default sink does nothing; the PostHog task installs one with setAuthAnalyticsSink().
 */
export type AuthEventName = 'signup_started' | 'signup_completed';
export type AuthEventMethod = 'email' | 'google' | 'apple';
export interface AuthEvent {
  name: AuthEventName;
  properties: { method: AuthEventMethod };
}
export type AuthAnalyticsSink = (event: AuthEvent) => void;

let sink: AuthAnalyticsSink = () => undefined;

export function setAuthAnalyticsSink(next: AuthAnalyticsSink): void {
  sink = next;
}

export function methodFromProvider(provider: string): AuthEventMethod | null {
  if (provider === 'resend') return 'email';
  if (provider === 'google' || provider === 'apple') return provider;
  return null;
}

export function emitAuthEvent(name: AuthEventName, provider: string): void {
  const method = methodFromProvider(provider);
  if (!method) return;
  try {
    sink({ name, properties: { method } });
  } catch {
    // Analytics must never break sign-in.
  }
}
