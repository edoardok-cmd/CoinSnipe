import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// This repo is public. Internal cost and vendor-price docs live in the private Agent X
// workspace and must never be tracked here (CSN-002-FOLLOWUP-1). Static checks on the
// tracked file list: they catch a re-added doc on the PR. History is guarded at push time
// by scripts/git-hooks/pre-push (CI runs after a push, so it cannot).

const root = new URL('..', import.meta.url);
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const PRIVATE_DOCS = ['docs/decisions.md', 'docs/data-licensing.md'];
// A currency amount: $49, €1,200, 49 USD, USD 49, 49 euros.
const PRICE =
  /[$€£]\s?\d|\b\d[\d,.]*[kKmM]?\s?(USD|EUR|GBP|dollars?|euros?)\b|\b(USD|EUR|GBP)\s?\d/;

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
      .filter((file) => file.startsWith('docs/') && /\.(md|mdx|txt|csv|json|ya?ml)$/.test(file))
      .filter((file) => PRICE.test(readFileSync(new URL(file, root), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('pre-push hook refuses history that ever held a private doc', () => {
  const hook = fileURLToPath(new URL('../scripts/git-hooks/pre-push', import.meta.url));
  const run = (dir, args, input) =>
    execFileSync(args[0], args.slice(1), {
      cwd: dir,
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const git = (dir, ...args) =>
    run(dir, ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);

  it('rejects a branch whose ancestor added then a later commit deleted the doc', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepush-'));
    try {
      git(dir, 'init', '-q');
      mkdirSync(join(dir, 'docs'));
      writeFileSync(join(dir, 'docs/decisions.md'), 'x\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'add');
      git(dir, 'rm', '-q', 'docs/decisions.md');
      git(dir, 'commit', '-qm', 'delete');
      const sha = git(dir, 'rev-parse', 'HEAD').trim();
      const line = `refs/heads/x ${sha} refs/heads/x ${'0'.repeat(40)}\n`;
      expect(() => run(dir, ['bash', hook], line)).toThrow(/private cost docs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows a branch that never held them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepush-'));
    try {
      git(dir, 'init', '-q');
      writeFileSync(join(dir, 'a.txt'), 'x\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'ok');
      const sha = git(dir, 'rev-parse', 'HEAD').trim();
      const line = `refs/heads/x ${sha} refs/heads/x ${'0'.repeat(40)}\n`;
      expect(() => run(dir, ['bash', hook], line)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
