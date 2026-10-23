import { describe, expect, it } from 'vitest';
import {
  assertSampleContentLabelled,
  isProductionEnv,
  shouldShowSampleBadge,
} from '../components/marketing/SampleBadge';

describe('sample-data guard (CSN-010)', () => {
  it('shows the badge in every non-production environment', () => {
    for (const env of ['development', 'preview', 'staging', 'test', '']) {
      expect(shouldShowSampleBadge(env), env).toBe(true);
    }
  });

  it('hides the badge only in production', () => {
    expect(isProductionEnv('production')).toBe(true);
    expect(shouldShowSampleBadge('production')).toBe(false);
  });

  it('fails the production build while sample content is rendered', () => {
    expect(() =>
      assertSampleContentLabelled({ hasSampleContent: true, env: 'production' }),
    ).toThrow(/sample-data guard/);
  });

  it('passes outside production, where the badge is visible', () => {
    expect(() =>
      assertSampleContentLabelled({ hasSampleContent: true, env: 'development' }),
    ).not.toThrow();
    expect(() =>
      assertSampleContentLabelled({ hasSampleContent: true, env: 'preview' }),
    ).not.toThrow();
  });

  it('passes in production once the page renders no sample content (CSN-043)', () => {
    expect(() =>
      assertSampleContentLabelled({ hasSampleContent: false, env: 'production' }),
    ).not.toThrow();
  });
});
