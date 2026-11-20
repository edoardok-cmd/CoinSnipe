/**
 * Sign-in page: what to show after asking Auth.js for a magic link (CSN-050).
 *
 * signIn(..., { redirect: false }) does NOT throw when the send was refused (rate limit) or
 * failed (Resend): it returns a URL such as /sign-in?error=Configuration, or the verify-request
 * URL on success. The page must read that result, never assume success.
 */
export const CHECK_EMAIL_PATH = '/sign-in?check=1';

export function errorTargetFor(code: string): string {
  return `/sign-in?error=${encodeURIComponent(code)}`;
}

/** Maps the string signIn returned to the page to show. Anything unreadable is an error. */
export function targetFromSignInResult(result: unknown): string {
  if (typeof result !== 'string') return errorTargetFor('Default');
  let url: URL;
  try {
    url = new URL(result, 'http://localhost');
  } catch {
    return errorTargetFor('Default');
  }
  const error = url.searchParams.get('error');
  if (error) return errorTargetFor(error);
  return url.pathname.endsWith('/verify-request') ? CHECK_EMAIL_PATH : errorTargetFor('Default');
}

export async function emailSignInTarget(
  start: () => Promise<unknown>,
  isAuthError: (error: unknown) => string | null,
): Promise<string> {
  try {
    return targetFromSignInResult(await start());
  } catch (error) {
    const code = isAuthError(error);
    if (code) return errorTargetFor(code);
    throw error;
  }
}
