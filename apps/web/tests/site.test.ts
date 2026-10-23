import { describe, expect, it } from 'vitest';
import { siteConfig } from '../lib/site';

describe('@coinsnipe/web', () => {
  it('exposes the site name', () => {
    expect(siteConfig.name).toBe('CoinSnipe');
  });
});
