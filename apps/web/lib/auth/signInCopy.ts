/** Sign-in page text (CSN-050). Plain and educational; checked by the copy-lint rules in tests. */
export const SIGN_IN_COPY = {
  title: 'Sign in to CoinSnipe',
  lead: 'One screen for new and returning members. Pick a method and we will take you to your home.',
  emailLabel: 'Email address',
  emailButton: 'Email me a sign-in link',
  emailNote: 'The link works once and expires in 15 minutes.',
  google: 'Continue with Google',
  apple: 'Continue with Apple',
  checkEmailTitle: 'Check your email',
  checkEmailBody: 'If the address is valid, a sign-in link is on its way.',
  errors: {
    default: 'We could not sign you in. Please try again.',
    emailSignin: 'We could not send the link. Wait a little and try again.',
    accountNotLinked:
      'That email already has an account. Sign in with an email link first, then connect Google or Apple from your profile.',
    accessDenied: 'That sign-in method did not share a verified email address.',
    verification: 'That link has expired or was already used. Request a new one.',
  },
} as const;

export function errorMessage(code: string | undefined): string | null {
  if (!code) return null;
  switch (code) {
    case 'EmailSignin':
    case 'Configuration':
      return SIGN_IN_COPY.errors.emailSignin;
    case 'OAuthAccountNotLinked':
    case 'AccountNotLinked':
      return SIGN_IN_COPY.errors.accountNotLinked;
    case 'AccessDenied':
      return SIGN_IN_COPY.errors.accessDenied;
    case 'Verification':
      return SIGN_IN_COPY.errors.verification;
    default:
      return SIGN_IN_COPY.errors.default;
  }
}

/** Only same-site relative paths are accepted as a post-login target. */
export function safeCallbackPath(value: string | undefined): string | undefined {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return undefined;
  }
  return value;
}
