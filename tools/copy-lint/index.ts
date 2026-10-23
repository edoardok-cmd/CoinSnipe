// Copy compliance lint (CSN-011). Fails CI when user-facing text breaks the CoinSnipe copy
// rules: brief "Copy and tone", master plan section 15, forecasting methodology "Rules for
// the copy". Rules live in rules.json, exceptions in allowlist.json.
// Usage: node tools/copy-lint/index.ts [repo-root]

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface Rule {
  id: string;
  severity: 'error' | 'warning';
  pattern: string;
  reason: string;
}

export interface Allowlist {
  entries: { file: string; phrase: string; reason: string }[];
  patterns: { pattern: string; reason: string }[];
}

export interface Finding {
  file: string;
  line: number;
  col: number;
  ruleId: string;
  severity: Rule['severity'];
  matched: string;
  reason: string;
}

export interface RunResult {
  scanned: number;
  findings: Finding[];
  errors: number;
  warnings: number;
}

// One unit of user-facing text. line and col are 1-based and point at text[0].
interface Segment {
  text: string;
  line: number;
  col: number;
}

interface Span {
  start: number;
  end: number;
  matched: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..', '..');

const TS_EXTS = new Set(['.ts', '.tsx']);
const TEXT_EXTS = new Set(['.ts', '.tsx', '.md', '.mdx', '.json', '.txt']);

const SCAN_TARGETS: { dir: string; exts: Set<string> }[] = [
  { dir: 'apps/web/content', exts: TEXT_EXTS },
  { dir: 'apps/web/app', exts: new Set(['.tsx', '.ts']) },
  { dir: 'packages/scoring/src/signals/templates', exts: TEXT_EXTS },
  { dir: 'apps/worker/src/email/templates', exts: TEXT_EXTS },
  { dir: 'packages/db/content', exts: TEXT_EXTS },
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  '.turbo',
  'coverage',
  // Per-task worktrees are full copies of the repo; scanning them would double every finding.
  'task-folders',
]);

function walk(dir: string, visit: (path: string) => void): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), visit);
    } else if (entry.isFile()) {
      visit(join(dir, entry.name));
    }
  }
}

export function collectFiles(root: string): string[] {
  const files = new Set<string>();
  for (const { dir, exts } of SCAN_TARGETS) {
    walk(join(root, dir), (path) => {
      if (exts.has(extname(path))) files.add(path);
    });
  }
  // Any markdown under a content/ directory, wherever it sits in the repo.
  walk(root, (path) => {
    if (extname(path) !== '.md') return;
    if (relative(root, path).split(sep).includes('content')) files.add(path);
  });
  return [...files].sort();
}

function tsSegments(file: string, source: string): Segment[] {
  const kind = extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const out: Segment[] = [];
  // String literals and JSX text only: identifiers and comments are code, not copy.
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      const at = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const openQuote = ts.isJsxText(node) ? 0 : 1;
      const text = ts.isJsxText(node) ? decodeEntities(node.text) : node.text;
      out.push({ text, line: at.line + 1, col: at.character + 1 + openQuote });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

// Prose files are one segment, so a phrase split by a line break still matches (\s spans \n).
function segmentsOf(file: string, source: string): Segment[] {
  if (TS_EXTS.has(extname(file))) return tsSegments(file, source);
  return [{ text: source, line: 1, col: 1 }];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
};

// Code points past U+10FFFF throw in fromCodePoint; leave such an entity as written.
function codePointOrWhole(whole: string, code: number): string {
  return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
}

// JSX text is markup, so "Buy&nbsp;now" renders as "Buy now". Decode before matching.
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (whole, hex: string) =>
      codePointOrWhole(whole, parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (whole, dec: string) => codePointOrWhole(whole, parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name] ?? whole);
}

function spansOf(pattern: string, text: string): Span[] {
  const re = new RegExp(pattern, 'gi');
  const out: Span[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length, matched: m[0] });
  }
  return out;
}

function occurrencesOf(phrase: string, text: string): Span[] {
  const out: Span[] = [];
  if (phrase.length === 0) return out;
  let i = text.indexOf(phrase);
  while (i !== -1) {
    out.push({ start: i, end: i + phrase.length, matched: phrase });
    i = text.indexOf(phrase, i + 1);
  }
  return out;
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

function locate(seg: Segment, index: number): { line: number; col: number } {
  const before = seg.text.slice(0, index);
  const lastNewline = before.lastIndexOf('\n');
  if (lastNewline === -1) return { line: seg.line, col: seg.col + index };
  const newlines = before.split('\n').length - 1;
  return { line: seg.line + newlines, col: index - lastNewline };
}

// Rules run in order. The first rule to claim a span owns it, so "price target" reports once
// as price-target rather than twice. A span covered by an allowlist entry is claimed but silent.
export function lintSource(
  file: string,
  source: string,
  rules: Rule[],
  allow: Allowlist,
): Finding[] {
  const phrases = allow.entries.filter((entry) => entry.file === file);
  const allowPatterns = allow.patterns.map((entry) => entry.pattern);
  const findings: Finding[] = [];

  for (const seg of segmentsOf(file, source)) {
    const allowed: Span[] = phrases.flatMap((entry) => occurrencesOf(entry.phrase, seg.text));
    for (const pattern of allowPatterns) allowed.push(...spansOf(pattern, seg.text));

    const claimed: Span[] = [];
    for (const rule of rules) {
      for (const hit of spansOf(rule.pattern, seg.text)) {
        if (claimed.some((span) => overlaps(span, hit))) continue;
        const isAllowed = allowed.some((span) => span.start <= hit.start && hit.end <= span.end);
        // Only a reported hit claims its span. An allowlisted hit stays open so a
        // forecast that wraps the allowed fact is still judged by the other rules.
        if (isAllowed) continue;
        claimed.push(hit);
        const at = locate(seg, hit.start);
        findings.push({
          file,
          line: at.line,
          col: at.col,
          ruleId: rule.id,
          severity: rule.severity,
          matched: hit.matched,
          reason: rule.reason,
        });
      }
    }
  }
  return findings;
}

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(HERE, name), 'utf8')) as T;
}

// Fail closed: a misspelled severity must not silently demote an error to a warning.
export function validateRules(rules: Rule[]): Rule[] {
  for (const rule of rules) {
    if (rule.severity !== 'error' && rule.severity !== 'warning') {
      throw new Error(`rules.json: rule "${rule.id}" has unknown severity "${rule.severity}"`);
    }
  }
  return rules;
}

export function runCopyLint(root: string): RunResult {
  const rules = validateRules(loadJson<Rule[]>('rules.json'));
  const allow = loadJson<Allowlist>('allowlist.json');
  const files = collectFiles(root);
  const findings: Finding[] = [];
  for (const abs of files) {
    const rel = relative(root, abs).split(sep).join('/');
    findings.push(...lintSource(rel, readFileSync(abs, 'utf8'), rules, allow));
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);
  const errors = findings.filter((f) => f.severity === 'error').length;
  return { scanned: files.length, findings, errors, warnings: findings.length - errors };
}

export function formatFinding(f: Finding): string {
  return `${f.file}:${f.line}:${f.col} ${f.severity} ${f.ruleId} "${f.matched}" - ${f.reason}`;
}

function main(argv: string[]): number {
  const root = resolve(argv[2] ?? DEFAULT_ROOT);
  const result = runCopyLint(root);
  for (const finding of result.findings) console.log(formatFinding(finding));
  console.log(
    `copy-lint: ${result.scanned} file(s) scanned, ${result.errors} error(s), ${result.warnings} warning(s)`,
  );
  return result.errors > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
