import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../testing/fixtureRouter';
import { ETF_DECISIONS_ENV, etfDecisionsPath, loadEtfDecisions } from './etfDecisions';

describe('ETF decisions config (R5-1, F1)', () => {
  it('F1: an unset variable is the only not-configured case: unavailable, the warning names the unset config, no path, and no file is read', () => {
    let reads = 0;
    const input = loadEtfDecisions(
      {},
      {
        read: () => {
          reads += 1;
          return '[]';
        },
      },
    );
    expect(input.status).toBe('unavailable');
    expect(input.status === 'unavailable' ? input.warning : '').toContain(
      'COINSNIPE_ETF_DECISIONS_PATH is not set',
    );
    expect(input.status === 'unavailable' ? input.path : 'set').toBeUndefined();
    expect(reads).toBe(0);
  });

  it('F1: a blank variable is unset, so it is not configured either', () => {
    const input = loadEtfDecisions({ [ETF_DECISIONS_ENV]: '   ' });
    expect(input.status).toBe('unavailable');
    expect(input.status === 'unavailable' ? input.warning : '').toContain('is not set');
  });

  it('a configured SAMPLE file loads as configured (status loaded, the parsed list)', () => {
    const input = loadEtfDecisions({ [ETF_DECISIONS_ENV]: `${FIXTURES}SAMPLE_etf_decisions.json` });
    expect(input.status).toBe('loaded');
    expect(input.status === 'loaded' && Array.isArray(input.json) ? input.json.length : -1).toBe(2);
  });

  it('a configured file that holds a deliberately empty list loads (status loaded, no rows)', () => {
    const input = loadEtfDecisions({
      [ETF_DECISIONS_ENV]: `${FIXTURES}SAMPLE_etf_decisions_empty.json`,
    });
    expect(input.status).toBe('loaded');
    expect(input.status === 'loaded' ? input.json : null).toEqual([]);
  });

  it('a relative COINSNIPE_ETF_DECISIONS_PATH resolves from the working directory', () => {
    expect(etfDecisionsPath({ [ETF_DECISIONS_ENV]: 'admin/etf.json' }, '/work/dir')).toBe(
      resolve('/work/dir', 'admin/etf.json'),
    );
    expect(etfDecisionsPath({}, '/work/dir')).toBeUndefined();
  });

  it('an unreadable file is unavailable with a warning, never a crash', () => {
    const input = loadEtfDecisions(
      { [ETF_DECISIONS_ENV]: '/nowhere/etf.json' },
      {
        read: () => {
          throw new Error('ENOENT');
        },
      },
    );
    expect(input.status).toBe('unavailable');
    expect(input.status === 'unavailable' ? input.warning : '').toContain('not readable');
  });

  it('invalid JSON is unavailable with a warning, so the etf kind is not replaced', () => {
    const input = loadEtfDecisions(
      { [ETF_DECISIONS_ENV]: '/x/etf.json' },
      { read: () => '[{ bad json' },
    );
    expect(input.status).toBe('unavailable');
    expect(input.status === 'unavailable' ? input.warning : '').toContain('not valid JSON');
  });
});
