import { describe, expect, it } from 'vitest';
import { SCORING_PACKAGE } from './index';

describe('@coinsnipe/scoring', () => {
  it('exports its placeholder', () => {
    expect(SCORING_PACKAGE).toBe('@coinsnipe/scoring');
  });
});
