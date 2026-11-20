import { describe, expect, it } from 'vitest';
import config from '../next.config';
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

  it('next.config.ts applies the headers to every route, without unsafe-eval in production', async () => {
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    try {
      for (const [mode, expectEval] of [
        ['production', false],
        ['development', true],
      ] as const) {
        env.NODE_ENV = mode;
        const rules = (await config.headers!()) as {
          source: string;
          headers: { key: string; value: string }[];
        }[];
        const rule = rules[0]!;
        expect(rules).toHaveLength(1);
        expect(rule.source).toBe('/(.*)');
        const csp = rule.headers.find((h) => h.key === 'Content-Security-Policy')!.value;
        expect(csp.includes("'unsafe-eval'")).toBe(expectEval);
        expect(rule.headers.length).toBe(securityHeaders().length);
      }
    } finally {
      env.NODE_ENV = prev;
    }
  });

  it('allows unsafe-eval only in dev', () => {
    expect(buildCsp(true)).toContain("'unsafe-eval'");
  });
});
