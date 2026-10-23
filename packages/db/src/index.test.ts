import { describe, expect, it } from 'vitest';
import { DB_PACKAGE } from './index';

describe('@coinsnipe/db', () => {
  it('exports its placeholder', () => {
    expect(DB_PACKAGE).toBe('@coinsnipe/db');
  });
});
