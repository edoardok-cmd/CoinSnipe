import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// This repo is public. Internal cost and vendor-price docs live in the private Agent X
// workspace and must never be tracked here (CSN-002-FOLLOWUP-1). Static checks on the
// tracked file list, so a re-added doc fails CI before it can be pushed.

const root = new URL('..', import.meta.url);
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const PRIVATE_DOCS = ['docs/decisions.md', 'docs/data-licensing.md'];
// A currency amount: $49, €1,200, £5.50, 49 USD, 49 EUR.
const PRICE = /[$€£]\s?\d|\b\d[\d,.]*\s?(USD|EUR|GBP)\b/;

describe('private docs stay out of the public repo', () => {
  it.each(PRIVATE_DOCS)('%s is not tracked', (doc) => {
    expect(tracked).not.toContain(doc);
  });

  it.each(PRIVATE_DOCS)('%s is gitignored so a plain git add cannot re-add it', (doc) => {
    const ignore = readFileSync(new URL('.gitignore', root), 'utf8').split('\n');
    expect(ignore).toContain(doc);
  });

  it('no tracked doc under docs/ contains a currency amount', () => {
    const offenders = tracked
      .filter((file) => file.startsWith('docs/') && /\.(md|mdx|txt)$/.test(file))
      .filter((file) => PRICE.test(readFileSync(new URL(file, root), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
