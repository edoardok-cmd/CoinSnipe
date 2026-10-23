import { describe, expect, it } from 'vitest';
import { UI_PACKAGE } from './index';

describe('@coinsnipe/ui', () => {
  it('exports its placeholder', () => {
    expect(UI_PACKAGE).toBe('@coinsnipe/ui');
  });
});
