import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { composite, contrastRatio, parseHex, token } from './a11y-helpers';

/**
 * Static guards for the accessibility pass (CSN-012, R-N4). The measured checks live in
 * e2e/marketing-a11y.spec.ts; these fail fast, without a browser, when the stylesheet drifts.
 */
const css = readFileSync(new URL('../../../packages/ui/src/tokens.css', import.meta.url), 'utf8');
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('focus rings', () => {
  it('no rule removes an outline (outline: none / 0 / outline-style: none / outline-width: 0)', () => {
    expect(stripped).not.toMatch(/outline\s*:\s*(none|0)\b/);
    expect(stripped).not.toMatch(/outline-style\s*:\s*none/);
    expect(stripped).not.toMatch(/outline-width\s*:\s*0/);
  });

  it('the base ring is a 2px mint outline with an offset', () => {
    const rule = stripped.match(/\.cs :focus-visible\s*\{([^}]*)\}/)![1]!;
    expect(rule).toMatch(/outline:\s*2px solid var\(--cs-mint\)/);
    expect(rule).toMatch(/outline-offset:\s*3px/);
  });

  it('the mint final CTA uses a dark ring: mint on mint is 1.1:1', () => {
    const rule = stripped.match(/\.cs \.finale :focus-visible\s*\{([^}]*)\}/)![1]!;
    const ring = rule.match(/outline-color:\s*(#[0-9a-f]{6})/i)![1]!;
    const finaleLightest = parseHex('#ffffff'); // the mist at the top of the CTA is up to white
    expect(contrastRatio(parseHex('#3df5b4'), parseHex('#5cffc6'))).toBeLessThan(1.5);
    expect(contrastRatio(parseHex(ring), finaleLightest)).toBeGreaterThan(3);
    expect(contrastRatio(parseHex(ring), parseHex('#1fcb98'))).toBeGreaterThan(3);
  });
});

describe('reduced motion', () => {
  it('one global rule switches every animation and transition off', () => {
    const block = stripped.match(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.cs \*,\s*\.cs \*::before,\s*\.cs \*::after\s*\{([^}]*)\}/,
    );
    expect(block, 'global reduce block').not.toBeNull();
    expect(block![1]).toMatch(/animation:\s*none !important/);
    expect(block![1]).toMatch(/transition:\s*none !important/);
  });

  it('smooth scrolling is turned off too', () => {
    expect(stripped).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*html\s*\{\s*scroll-behavior:\s*auto/,
    );
  });
});

describe('story step dimming keeps AA', () => {
  it('the muted paragraph at --cs-step-dim over the page background is >= 4.5:1', () => {
    const dim = parseFloat(token(css, '--cs-step-dim'));
    const bg = parseHex(token(css, '--cs-bg'));
    for (const name of ['--cs-muted', '--cs-text', '--cs-mint']) {
      const fg = parseHex(token(css, name));
      expect(contrastRatio(composite(fg, dim, bg), bg), name).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('mobile layout', () => {
  it('the sticky pill lives in the same max-width query as the burger', () => {
    const burger = stripped.match(/@media \(max-width: (\d+)px\)\s*\{\s*\.cs \.nav-wrap/);
    const pill = stripped.match(/@media \(max-width: (\d+)px\)\s*\{\s*\.cs \.sticky-cta/);
    expect(burger).not.toBeNull();
    expect(pill).not.toBeNull();
    expect(pill![1]).toBe(burger![1]);
  });

  it('the pill is display:none above that breakpoint', () => {
    expect(stripped).toMatch(/\.cs \.sticky-cta\s*\{\s*display:\s*none;?\s*\}/);
  });
});
