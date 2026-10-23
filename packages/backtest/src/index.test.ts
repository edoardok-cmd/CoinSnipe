import { describe, expect, it } from 'vitest';
import { BACKTEST_PACKAGE } from './index';

describe('@coinsnipe/backtest', () => {
  it('exports its placeholder', () => {
    expect(BACKTEST_PACKAGE).toBe('@coinsnipe/backtest');
  });
});
