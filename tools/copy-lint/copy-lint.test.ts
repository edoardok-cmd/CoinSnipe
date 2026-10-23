import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { type Allowlist, lintSource, type Rule, runCopyLint, validateRules } from './index.ts';

const rules: Rule[] = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8'));
const allow: Allowlist = JSON.parse(
  readFileSync(new URL('./allowlist.json', import.meta.url), 'utf8'),
);

const CONTENT = 'apps/web/content/lesson.md';

const findingsOf = (text: string, file = CONTENT) => lintSource(file, text, rules, allow);
const ruleIdsOf = (text: string) => findingsOf(text).map((f) => f.ruleId);

const POSITIVE: [string, string][] = [
  ['buy-directive', 'Buy now and get ahead'],
  ['buy-directive', 'Buy at the dip'],
  ['buy-directive', 'You should buy this coin'],
  ['buy-directive', 'Find the coins worth buying'],
  ['sell-directive', 'Sell now before it drops'],
  ['sell-directive', 'You should sell'],
  ['hold-directive', 'Hold it until spring'],
  ['hold-directive', 'You should hold through the dip'],
  ['price-target', 'Set your price target at the next level'],
  ['target', 'This is our target for Q3'],
  ['will-reach', 'BTC will reach the old high'],
  ['will-reach', 'ETH will hit new highs'],
  ['could-10x', 'This coin could 10x from here'],
  ['could-10x', '100x gains are possible'],
  ['could-10x', 'The 10x coin of 2026'],
  ['could-10x', 'Get 10x returns'],
  ['multiple-forecast', 'Potential of 5x in a year'],
  ['multiple-forecast', '3× upside if the trend holds'],
  ['moon', 'To the moon'],
  ['pump', 'Crypto pump incoming'],
  ['guaranteed', 'Returns are guaranteed'],
  ['risk-free', 'A risk-free way to earn'],
  ['get-rich', 'Get rich with altcoins'],
  ['recommended-for-you', 'Recommended for you: SOL'],
  ['we-recommend', 'We recommend this coin'],
  ['you-should', 'You should check the score first'],
  ['returns-hint', 'Find winners early'],
  ['returns-hint', 'Discover gems in every market'],
];

const NEGATIVE: string[] = [
  'Learn the basics',
  'Track what matters',
  'See which markets are moving',
  "The sector's top 3 are 12× bigger",
  'Odds and ranges describe history and can be wrong',
  'Hold on while the page loads',
  'Not investment advice',
  'We describe data, probabilities and history',
  'Stop guessing. Start knowing.',
  'Your coins, finally explained',
  'buy-side liquidity in the order book',
  'Buying power is shown in your wallet',
];

describe('copy-lint rules: positive fixtures fail with the expected rule', () => {
  it.each(POSITIVE)('%s flags: %s', (ruleId, text) => {
    const hit = findingsOf(text).find((f) => f.ruleId === ruleId);
    expect(hit, `expected ${ruleId} on "${text}"`).toBeDefined();
  });

  it('keeps returns-hint as a warning, not an error', () => {
    const hits = findingsOf('Find winners early');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe('warning');
  });

  it('reports the more specific rule once when two rules match the same span', () => {
    expect(ruleIdsOf('Set your price target')).toEqual(['price-target']);
  });
});

describe('copy-lint rules: negative fixtures pass', () => {
  it.each(NEGATIVE)('is clean: %s', (text) => {
    expect(findingsOf(text)).toEqual([]);
  });
});

describe('copy-lint scanning', () => {
  it('reads JSX text and string literals, not identifiers or comments', () => {
    const source = [
      '// buy now, this comment is code',
      'const buyNow = "Learn the basics";',
      'export const Heading = () => <h2>Find the coins worth buying</h2>;',
    ].join('\n');
    const hits = lintSource('apps/web/app/page.tsx', source, rules, allow);
    expect(hits.map((f) => [f.ruleId, f.line])).toEqual([['buy-directive', 3]]);
  });

  it('flags a template-literal string in a .ts email template', () => {
    const hits = lintSource(
      'apps/worker/src/email/templates/welcome.ts',
      'export const subject = `Buy now`;',
      rules,
      allow,
    );
    expect(hits.map((f) => f.ruleId)).toEqual(['buy-directive']);
  });

  it('reports the line and column of a markdown match', () => {
    const hits = findingsOf('Intro line\nSecond line: you should buy');
    expect(hits[0]).toMatchObject({ line: 2, ruleId: 'buy-directive' });
    expect(hits[0]?.col).toBeGreaterThan(1);
  });

  it('matches a phrase split across a line break in prose', () => {
    expect(ruleIdsOf('BTC will\nreach 100k.')).toContain('will-reach');
    expect(ruleIdsOf('Sell now, do not\nhold it')).toContain('hold-directive');
  });

  it('decodes HTML entities in JSX text before matching', () => {
    const named = lintSource('apps/web/app/a.tsx', '<p>Buy&nbsp;now</p>', rules, allow);
    const numeric = lintSource('apps/web/app/a.tsx', '<p>Buy&#32;now</p>', rules, allow);
    const amp = lintSource('apps/web/app/a.tsx', '<p>Buy&amp;nbsp;now</p>', rules, allow);
    expect(named.map((f) => f.ruleId)).toEqual(['buy-directive']);
    expect(numeric.map((f) => f.ruleId)).toEqual(['buy-directive']);
    expect(amp).toEqual([]);
  });

  it('decodes the en, em and thin space entities', () => {
    for (const entity of ['&ensp;', '&emsp;', '&thinsp;']) {
      const hits = lintSource('apps/web/app/a.tsx', `<p>Buy${entity}now</p>`, rules, allow);
      expect(
        hits.map((f) => f.ruleId),
        entity,
      ).toEqual(['buy-directive']);
    }
  });

  it('does not throw on an out-of-range numeric entity', () => {
    const hits = lintSource(
      'apps/web/app/a.tsx',
      '<p>&#x110000; Learn the basics</p>',
      rules,
      allow,
    );
    expect(hits).toEqual([]);
  });

  it('refuses a rule with an unknown severity instead of demoting it', () => {
    const typo = [{ id: 'x', severity: 'eror', pattern: 'x', reason: 'x' }] as unknown as Rule[];
    expect(() => validateRules(typo)).toThrow(/unknown severity "eror"/);
    expect(() => validateRules(rules)).not.toThrow();
  });

  it('does not let an allowlisted fact hide a forecast that wraps it', () => {
    const text = 'Your upside: the top 3 are 10x bigger, so act now.';
    expect(ruleIdsOf(text)).toContain('multiple-forecast');
    expect(ruleIdsOf("The sector's top 3 are 12× bigger")).toEqual([]);
  });

  it('suppresses only the allowlisted span, not the whole line', () => {
    const text = "The sector's top 3 are 12× bigger. Buy now.";
    expect(ruleIdsOf(text)).toEqual(['buy-directive']);
  });

  it('applies phrase allowlist entries to their exact file only', () => {
    const scoped: Allowlist = {
      entries: [{ file: CONTENT, phrase: 'Quiz: buy now', reason: 'quoted quiz answer' }],
      patterns: [],
    };
    const text = 'Quiz: buy now or wait';
    expect(lintSource(CONTENT, text, rules, scoped)).toEqual([]);
    expect(lintSource('apps/web/content/other.md', text, rules, scoped)).toHaveLength(1);
  });
});

describe('copy-lint CLI run over a repo tree', () => {
  let root = '';

  const write = (rel: string, body: string) => {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  };

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('fails on a seeded violation and passes once it is removed', () => {
    root = mkdtempSync(join(tmpdir(), 'copy-lint-'));
    write('apps/web/app/page.tsx', 'export const A = () => <h2>Find the coins worth buying</h2>;');
    expect(runCopyLint(root).errors).toBe(1);

    write('apps/web/app/page.tsx', 'export const A = () => <h2>Learn the basics</h2>;');
    expect(runCopyLint(root)).toMatchObject({ errors: 0, warnings: 0 });
  });

  it('exits 1 from the CLI on a seeded violation and 0 when clean', () => {
    root = mkdtempSync(join(tmpdir(), 'copy-lint-'));
    write('apps/web/app/page.tsx', '<h2>Find the coins worth buying</h2>');
    const cli = fileURLToPath(new URL('./index.ts', import.meta.url));
    const run = () => spawnSync(process.execPath, [cli, root], { encoding: 'utf8' });
    expect(run().status).toBe(1);
    write('apps/web/app/page.tsx', '<h2>Learn the basics</h2>');
    expect(run().status).toBe(0);
  });

  it('counts warnings without failing', () => {
    root = mkdtempSync(join(tmpdir(), 'copy-lint-'));
    write('apps/web/content/feature.md', 'Find winners early');
    expect(runCopyLint(root)).toMatchObject({ errors: 0, warnings: 1 });
  });

  it('scans markdown under any content/ directory and skips task-folders', () => {
    root = mkdtempSync(join(tmpdir(), 'copy-lint-'));
    write('docs/content/glossary.md', 'Buy now');
    write('task-folders/CSN-011/apps/web/content/copy.md', 'Buy now');
    const result = runCopyLint(root);
    expect(result.findings.map((f) => f.file)).toEqual(['docs/content/glossary.md']);
  });
});
