import { describe, expect, it } from 'vitest';
import { DATA_PACKAGE } from './index';

describe('@coinsnipe/data', () => {
  it('exports its placeholder', () => {
    expect(DATA_PACKAGE).toBe('@coinsnipe/data');
  });
});
