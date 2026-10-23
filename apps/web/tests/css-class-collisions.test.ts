import { readdirSync, readFileSync } from 'node:fs';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';

/**
 * Custom class names must not double as Tailwind utilities. A class such as `fixed` or `block`
 * silently picks up `position: fixed` / `display: block` from Tailwind and detaches elements from
 * the layout (CSN-010 review F1). This compiles every class name the marketing code and CSS use
 * through Tailwind itself and fails if any of them generates a rule.
 */
const root = new URL('../', import.meta.url);
const componentsDir = new URL('components/marketing/', root);

function classNamesFromSource(): Set<string> {
  const names = new Set<string>();
  const add = (text: string) => text.split(/\s+/).forEach((t) => t && names.add(t));
  for (const file of readdirSync(componentsDir)) {
    if (!file.endsWith('.tsx')) continue;
    const src = readFileSync(new URL(file, componentsDir), 'utf8');
    // className="a b", className={'a b'}, className={`a ${x ? ' b' : ''}`}, className = 'a' (default).
    for (const m of src.matchAll(
      /(?:className|class)\s*=\s*(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\}|'([^']*)')/g,
    )) {
      const raw = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
      // quoted strings inside ${...} are class names too, e.g. `${wide ? ' sig-wide' : ''}`
      for (const q of raw.matchAll(/'([^']*)'/g)) add(q[1] ?? '');
      add(raw.replace(/\$\{[^}]*\}/g, ' '));
    }
  }
  return names;
}

function classNamesFromCss(): Set<string> {
  const css = readFileSync(new URL('../../packages/ui/src/tokens.css', root), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const names = new Set<string>();
  for (const m of css.matchAll(/\.([a-zA-Z_][\w-]*)/g)) {
    // skip numbers like 0.5 (the dot is followed by a digit, so the pattern already excludes them)
    names.add(m[1]!);
  }
  return names;
}

// Utilities that are intentionally the same as Tailwind's.
const ALLOWED = new Set(['sr-only']);

async function generated(candidates: string[]): Promise<string[]> {
  // compiler.build() is cumulative, so a class is a hit when it changes the output.
  const compiler = await compile('@tailwind utilities;');
  const out: string[] = [];
  let previous = compiler.build([]);
  for (const c of candidates) {
    const css = compiler.build([c]);
    if (css !== previous) out.push(c);
    previous = css;
  }
  return out;
}

describe('custom class names do not collide with Tailwind utilities', () => {
  it('has class names to check', () => {
    expect(classNamesFromSource().size).toBeGreaterThan(40);
    expect(classNamesFromCss().size).toBeGreaterThan(100);
  });

  it('no component class name generates a Tailwind rule', async () => {
    const names = [...classNamesFromSource()].filter((n) => !ALLOWED.has(n));
    expect(await generated(names)).toEqual([]);
  });

  it('no tokens.css class selector generates a Tailwind rule', async () => {
    const names = [...classNamesFromCss()].filter((n) => !ALLOWED.has(n));
    expect(await generated(names)).toEqual([]);
  });

  it('the detector catches the known offenders', async () => {
    expect(await generated(['fixed', 'block', 'hidden', 'sig-wide'])).toEqual([
      'fixed',
      'block',
      'hidden',
    ]);
  });
});
