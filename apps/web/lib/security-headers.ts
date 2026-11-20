/**
 * Security headers for every route (CSN-015). Kept out of next.config.ts so a unit test can
 * assert them. Allowed third parties: Google Fonts (styles + font files) and the PostHog
 * analytics host. Next.js injects inline bootstrap scripts, so script-src keeps
 * 'unsafe-inline' until a nonce-based CSP is added.
 */
export const ANALYTICS_HOST = 'https://eu.i.posthog.com';
export const ANALYTICS_ASSETS_HOST = 'https://eu-assets.i.posthog.com';

export function buildCsp(isDev = false): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      "'unsafe-inline'",
      ...(isDev ? ["'unsafe-eval'"] : []),
      ANALYTICS_ASSETS_HOST,
    ],
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'font-src': ["'self'", 'https://fonts.gstatic.com'],
    'img-src': ["'self'", 'data:', 'blob:'],
    'connect-src': ["'self'", ANALYTICS_HOST, ANALYTICS_ASSETS_HOST],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  const body = Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
  // Not in dev: it would rewrite http://localhost subresources to https and break Safari.
  return isDev ? body : `${body}; upgrade-insecure-requests`;
}

export function securityHeaders(isDev = false): { key: string; value: string }[] {
  return [
    { key: 'Content-Security-Policy', value: buildCsp(isDev) },
    { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    },
    { key: 'X-Frame-Options', value: 'DENY' },
  ];
}
