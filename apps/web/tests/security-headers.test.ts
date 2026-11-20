import { describe, expect, it } from 'vitest';
import { buildCsp, securityHeaders } from '../lib/security-headers';

const get = (name: string) => securityHeaders().find((h) => h.key === name)?.value;

describe('security headers (CSN-015)', () => {
  it('sets the required headers', () => {
    expect(get('Strict-Transport-Security')).toMatch(/max-age=\d{8,}/);
    expect(get('X-Content-Type-Options')).toBe('nosniff');
    expect(get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(get('Permissions-Policy')).toContain('camera=()');
  });

  it('CSP forbids framing and allows Google Fonts and analytics', () => {
    const csp = buildCsp();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('https://fonts.googleapis.com');
    expect(csp).toContain('https://fonts.gstatic.com');
    expect(csp).toContain('posthog.com');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('allows unsafe-eval only in dev', () => {
    expect(buildCsp(true)).toContain("'unsafe-eval'");
  });
});
