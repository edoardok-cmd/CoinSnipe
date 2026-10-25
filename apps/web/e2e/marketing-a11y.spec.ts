import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Browser, ElementHandle, Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  composite,
  contrastRatio,
  mergeWorst,
  measureViewport,
  newHelperPage,
  sweepContrast,
} from './helpers/contrast';
import type { Measurement } from './helpers/contrast';
import { checkRing } from './helpers/focus';
import { BURGER_MAX, WIDTHS, jumpToY, pageHeight } from './helpers/layout';

/**
 * Accessibility pass (CSN-012, R-N4, R-F1): axe on every width, measured text contrast, visible
 * focus rings, tab order, keyboard operation, reduced motion, image alt text.
 *
 * Reports: set E2E_REPORT_DIR to write axe-report.json and contrast-report.json there.
 */

const REPORT_DIR = process.env.E2E_REPORT_DIR;
const AA = 4.5;

type Report = {
  axe: Record<string, unknown>;
  contrast: Record<string, unknown>;
  focus: Record<string, unknown>;
  axeVersion?: string;
};
const report: Report = { axe: {}, contrast: {}, focus: {} };

test.afterAll(() => {
  if (!REPORT_DIR) return;
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(
    `${REPORT_DIR}/axe-report.json`,
    JSON.stringify(
      {
        generatedBy: 'apps/web/e2e/marketing-a11y.spec.ts (CSN-012)',
        generatedAt: new Date().toISOString(),
        baseUrl: test.info().project.use.baseURL ?? process.env.E2E_BASE_URL,
        axeCoreVersion: report.axeVersion,
        tags: AXE_TAGS,
        widths: report.axe,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    `${REPORT_DIR}/contrast-report.json`,
    JSON.stringify(
      {
        generatedBy: 'apps/web/e2e/marketing-a11y.spec.ts (CSN-012)',
        generatedAt: new Date().toISOString(),
        method:
          'Text is made transparent, the page is screenshotted, and the darkest and lightest backdrop pixel under each text rect is read; the text colour (alpha x ancestor opacity, or gradient stops) is composited over each and the WCAG ratio taken. Fixed/sticky elements are swept past the whole page.',
        threshold: AA,
        widths: report.contrast,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    `${REPORT_DIR}/focus-report.json`,
    JSON.stringify({ generatedAt: new Date().toISOString(), widths: report.focus }, null, 2),
  );
});

async function open(browser: Browser, width: number, height: number, reduced = true) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    reducedMotion: reduced ? 'reduce' : 'no-preference',
  });
  const page = await ctx.newPage();
  await page.goto('/', { waitUntil: 'networkidle' });
  return { ctx, page };
}

/* ------------------------------------------------------------------ the maths the contrast checks rely on */

test('contrast helper maths matches WCAG reference values', () => {
  expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
  expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5);
  // #767676 on white is the well-known 4.54:1 boundary grey
  expect(contrastRatio([0x76, 0x76, 0x76], [255, 255, 255])).toBeCloseTo(4.54, 1);
  // 50% white over black composites to mid grey
  expect(composite([255, 255, 255], 0.5, [0, 0, 0])[0]).toBeCloseTo(127.5, 5);
});

/* ------------------------------------------------------------------ axe */

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

type AxeNode = { target: string; html: string; failureSummary: string };
type AxeEntry = {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  states: string[];
  nodes: AxeNode[];
  disposition: string;
};

/** Dispositions for axe results that are not violations but need a human look. */
const INCOMPLETE_DISPOSITION: Record<string, string> = {
  'color-contrast':
    'axe cannot resolve text on glass, gradients and the hero beam; covered by the measured contrast tests in this spec (screenshot backdrop extremes, >= 4.5:1).',
  'color-contrast-enhanced': 'AAA, not required.',
};

async function axeStates(page: Page, width: number) {
  const states: { name: string; run: () => Promise<void> }[] = [
    { name: 'default (top of page)', run: async () => {} },
    {
      name: 'coin tabs: niches, gems',
      run: async () => {
        for (const t of ['Top niches', 'Hidden gems'])
          await page
            .getByRole('tab', { name: new RegExp(t) })
            .first()
            .click();
      },
    },
    {
      name: 'story card tabs and all FAQ answers open',
      run: async () => {
        await page.evaluate(() =>
          document.querySelectorAll('details').forEach((d) => (d.open = true)),
        );
      },
    },
    {
      name: 'scrolled: sticky pill visible (mobile layout)',
      run: async () => {
        await jumpToY(page, 2400);
      },
    },
    {
      name: 'mobile menu open',
      run: async () => {
        if (width > BURGER_MAX) return;
        await jumpToY(page, 0);
        await page.locator('.menu-btn').click();
      },
    },
  ];
  return states;
}

for (const vp of WIDTHS) {
  test(`axe at ${vp.name}px: zero violations, report saved`, async ({ browser }) => {
    test.setTimeout(120_000);
    const { ctx, page } = await open(browser, vp.width, vp.height);
    const violations = new Map<string, AxeEntry>();
    const incomplete = new Map<string, AxeEntry>();
    let passes = 0;
    const stateNames: string[] = [];
    for (const state of await axeStates(page, vp.width)) {
      await state.run();
      await page.waitForTimeout(250);
      stateNames.push(state.name);
      const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      report.axeVersion = r.testEngine.version;
      passes = Math.max(passes, r.passes.length);
      for (const [list, store] of [
        [r.violations, violations],
        [r.incomplete, incomplete],
      ] as const) {
        for (const v of list) {
          const entry = store.get(v.id) ?? {
            id: v.id,
            impact: v.impact ?? null,
            help: v.help,
            helpUrl: v.helpUrl,
            states: [],
            nodes: [],
            disposition:
              store === violations
                ? 'FIX: this test fails while any violation is listed'
                : (INCOMPLETE_DISPOSITION[v.id] ?? 'needs a manual look'),
          };
          if (!entry.states.includes(state.name)) entry.states.push(state.name);
          for (const n of v.nodes) {
            const target = n.target.join(' ');
            if (!entry.nodes.some((x) => x.target === target))
              entry.nodes.push({
                target,
                html: n.html.slice(0, 200),
                failureSummary: (n.failureSummary ?? '').slice(0, 300),
              });
          }
          store.set(v.id, entry);
        }
      }
    }
    const list = [...violations.values()];
    const bySeverity = (imp: string) => list.filter((v) => v.impact === imp).length;
    report.axe[vp.name] = {
      viewport: { width: vp.width, height: vp.height },
      reducedMotion: 'reduce',
      statesAnalysed: stateNames,
      rulesPassed: passes,
      summary: {
        critical: bySeverity('critical'),
        serious: bySeverity('serious'),
        moderate: bySeverity('moderate'),
        minor: bySeverity('minor'),
      },
      violations: list,
      incomplete: [...incomplete.values()],
    };
    // Acceptance: zero serious/critical. This spec is stricter and also fails on moderate/minor, so
    // every impact level has to be fixed, there is no disposition list to hide behind.
    expect(
      list.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id),
      'serious/critical axe violations',
    ).toEqual([]);
    expect(
      list.map((v) => `${v.impact}: ${v.id} (${v.nodes.map((n) => n.target).join(' | ')})`),
      'any axe violation',
    ).toEqual([]);
    await ctx.close();
  });
}

/* ------------------------------------------------------------------ measured text contrast */

async function measureRegion(
  page: Page,
  helper: Page,
  into: Map<string, Measurement>,
  selector: string,
) {
  await page.evaluate((sel) => {
    document.documentElement.style.scrollBehavior = 'auto';
    const el = document.querySelector(sel)!;
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 130);
  }, selector);
  await page.waitForTimeout(250);
  mergeWorst(into, await measureViewport(page, helper));
}

for (const vp of WIDTHS) {
  test(`text contrast >= 4.5:1 at ${vp.name}px, measured on the rendered backdrops`, async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const { ctx, page } = await open(browser, vp.width, vp.height);
    const helper = await newHelperPage(ctx);
    const all = new Map<string, Measurement & { state: string }>();
    const add = (state: string, m: Map<string, Measurement>) => {
      for (const [k, v] of m) {
        const key = `${state} | ${k}`;
        const prev = all.get(key);
        if (!prev || v.ratio < prev.ratio) all.set(key, { ...v, state });
      }
    };

    // 1. the whole page in half-viewport steps (nav, pill and badge float over every section)
    const sweep = new Map<string, Measurement>();
    await sweepContrast(page, helper, sweep);
    add('page sweep', sweep);

    // 2. every state that swaps content
    for (const tab of ['Top niches', 'Hidden gems', 'Top coins']) {
      const m = new Map<string, Measurement>();
      await page
        .getByRole('tab', { name: new RegExp(tab) })
        .first()
        .click();
      await measureRegion(page, helper, m, '.moves-panel');
      await jumpToY(page, (await page.evaluate(() => Math.round(window.scrollY))) + 500);
      mergeWorst(m, await measureViewport(page, helper));
      add(`coin tab ${tab}`, m);
    }
    for (let i = 0; i < 4; i++) {
      const m = new Map<string, Measurement>();
      await page.locator('.fdots button').nth(i).click();
      await measureRegion(page, helper, m, '.stats');
      add(`feature slide ${i + 1}`, m);
    }
    for (let i = 0; i < 3; i++) {
      const m = new Map<string, Measurement>();
      // The niche tabs live in the trends step: bring it into view so they are clickable.
      await page.evaluate(() => {
        document.documentElement.style.scrollBehavior = 'auto';
        document.getElementById('trends')!.scrollIntoView({ block: 'center' });
      });
      await page.waitForTimeout(300);
      await page.locator('.ntab').nth(i).click();
      await measureRegion(page, helper, m, '#trends');
      add(`story card tab ${i + 1}`, m);
    }
    {
      const m = new Map<string, Measurement>();
      await page.evaluate(() =>
        document.querySelectorAll('details').forEach((d) => (d.open = true)),
      );
      await measureRegion(page, helper, m, '#faq');
      await jumpToY(page, (await page.evaluate(() => Math.round(window.scrollY))) + 420);
      mergeWorst(m, await measureViewport(page, helper));
      add('all FAQ answers open', m);
    }
    // 3. the open mobile menu is glass over whatever is behind it: sweep the page with it open
    if (vp.width <= BURGER_MAX) {
      await jumpToY(page, 0);
      await page.locator('.menu-btn').click();
      const m = new Map<string, Measurement>();
      await sweepContrast(page, helper, m, Math.round(vp.height / 2));
      add('mobile menu open, page sweep', m);
    }

    const list = [...all.values()].sort((a, b) => a.ratio - b.ratio);
    const failing = list.filter((m) => m.ratio < AA);
    // aggregate by component for the report: worst ratio per (state-free) element path
    const byComponent = new Map<string, Measurement & { state: string }>();
    for (const m of list) {
      const prev = byComponent.get(m.label);
      if (!prev || m.ratio < prev.ratio) byComponent.set(m.label, m);
    }
    report.contrast[vp.name] = {
      textNodesMeasured: list.length,
      lowestRatio: list[0]?.ratio ?? null,
      failing: failing.length,
      worstPerComponent: [...byComponent.values()]
        .sort((a, b) => a.ratio - b.ratio)
        .map((m) => ({
          component: m.label,
          sample: m.text,
          ratio: Math.round(m.ratio * 100) / 100,
          textColour: m.fg,
          textAlpha: m.alpha,
          worstBackdrop: m.worstOn === 'darkest' ? m.darkest : m.lightest,
          backdropKind: m.worstOn,
          fontPx: m.size,
          fontWeight: m.weight,
          state: m.state,
          scrollY: m.scrollY,
        })),
    };
    expect(
      failing
        .slice(0, 25)
        .map(
          (m) =>
            `${m.ratio.toFixed(2)}:1 ${m.fg}@${m.alpha} on ${m.worstOn === 'darkest' ? m.darkest : m.lightest} (${m.worstOn}) | ${m.label} | "${m.text}" ${m.size}px | ${m.state} y=${m.scrollY}`,
        ),
      `text below ${AA}:1 (${failing.length} in total)`,
    ).toEqual([]);
    expect(list.length).toBeGreaterThan(150); // the sweep really saw the page
    await ctx.close();
  });
}

/* ------------------------------------------------------------------ focus rings */

const FOCUSABLE =
  'a[href], button:not([disabled]), summary, [role="tab"], [tabindex]:not([tabindex="-1"])';

async function focusableHandles(page: Page, scope = 'body') {
  const handles = (await page
    .locator(scope)
    .locator(FOCUSABLE)
    .elementHandles()) as ElementHandle<Element>[];
  const out: ElementHandle<Element>[] = [];
  for (const h of handles) {
    const ok = await h.evaluate((e) => {
      const r = e.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        (e as HTMLElement).checkVisibility({ visibilityProperty: true })
      );
    });
    if (ok) out.push(h);
  }
  return out;
}

for (const vp of WIDTHS) {
  test(`every interactive element shows a visible, unclipped focus ring at ${vp.name}px`, async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const { ctx, page } = await open(browser, vp.width, vp.height);
    const helper = await newHelperPage(ctx);
    await page.keyboard.press('Tab'); // keyboard modality, so programmatic focus() shows :focus-visible
    const problems: string[] = [];
    const rows: unknown[] = [];
    let checked = 0;

    const run = async (group: string, scope?: string) => {
      for (const h of await focusableHandles(page, scope)) {
        const r = await checkRing(page, helper, h);
        checked++;
        rows.push({
          group,
          element: r.label,
          outline: r.outline,
          minContrastVsSurroundings: Math.round(r.minContrast * 100) / 100,
          sidesSampled: r.sidesSampled,
          problems: r.problems,
        });
        for (const p of r.problems) problems.push(`[${group}] ${r.label}: ${p}`);
      }
    };

    await run('page');
    if (vp.width <= BURGER_MAX) {
      // sticky pill (visible once the hero is gone) and the open mobile menu
      await jumpToY(page, 2400);
      await expect(page.locator('.sticky-cta')).toBeVisible();
      await run('sticky pill', '.sticky-cta');
      await jumpToY(page, 0);
      await page.locator('.menu-btn').click();
      await page.keyboard.press('Tab'); // keyboard modality again after the mouse click
      await run('mobile menu open: burger and menu links', '.nav-wrap');
      await page.keyboard.press('Escape');
    }
    report.focus[vp.name] = { elementsChecked: checked, problems: problems.length, rows };
    expect(checked).toBeGreaterThan(vp.width <= BURGER_MAX ? 50 : 60);
    expect(problems).toEqual([]);
    await ctx.close();
  });
}

test('no rule in the stylesheets removes the focus outline', async ({ browser }) => {
  const { ctx, page } = await open(browser, 1440, 900);
  const offenders = await page.evaluate(() => {
    const out: string[] = [];
    const visit = (rules: CSSRuleList) => {
      for (const r of Array.from(rules)) {
        if (r instanceof CSSStyleRule) {
          const o = r.style.getPropertyValue('outline').trim();
          const os = r.style.getPropertyValue('outline-style').trim();
          const ow = r.style.getPropertyValue('outline-width').trim();
          if (/^(none|0|0px)\b/.test(o) || os === 'none' || /^0(px)?$/.test(ow))
            out.push(r.selectorText);
        } else if ('cssRules' in r) visit((r as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) visit(sheet.cssRules);
    return out;
  });
  expect(offenders).toEqual([]);
  await ctx.close();
});

/* ------------------------------------------------------------------ tab order = visual order */

type Stop = {
  label: string;
  top: number;
  left: number;
  right: number;
  bottom: number;
  group: string; // '' | 'story:<key>' | 'fgrid:<key>'
  key: number;
  region: 'skip' | 'nav' | 'main' | 'footer' | 'pill';
  /** True when the focused element's box intersects the visible sticky pill (focus obscured). */
  underPill: boolean;
};

async function tabThrough(page: Page, max = 200): Promise<Stop[]> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const stops: Stop[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    // a person needs far more than a frame between key presses; scroll-driven UI (the pill) settles
    await page.waitForTimeout(120);
    const s = await page.evaluate((): Stop | null => {
      const e = document.activeElement as HTMLElement | null;
      if (!e || e === document.body) return null;
      const r = e.getBoundingClientRect();
      const label = `${e.tagName.toLowerCase()} "${(e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 28)}"`;
      const story = e.closest('.story');
      let group = '';
      let key = 0;
      if (story) {
        const child = Array.from(story.children).find((c) => c.contains(e))!;
        group = 'story';
        key = Array.from(story.children).indexOf(child);
      }
      const fcol = e.closest('.fgrid');
      if (fcol) {
        const col = Array.from(fcol.children).find((c) => c.contains(e))!;
        group = 'fgrid';
        key = Array.from(fcol.children).indexOf(col);
      }
      const region = e.classList.contains('skip')
        ? 'skip'
        : e.closest('.nav-wrap')
          ? 'nav'
          : e.closest('.sticky-cta')
            ? 'pill'
            : e.closest('footer')
              ? 'footer'
              : 'main';
      const fixedOrSticky = region === 'nav' || region === 'pill' || region === 'skip';
      // fixed/sticky bars are measured where they sit in the document at scroll 0
      const top = fixedOrSticky ? r.top : r.top + window.scrollY;
      const pill = document.querySelector<HTMLElement>('.sticky-cta');
      const pr =
        pill && getComputedStyle(pill).visibility === 'visible'
          ? pill.getBoundingClientRect()
          : null;
      const underPill =
        !!pr &&
        region !== 'pill' &&
        r.left < pr.right &&
        r.right > pr.left &&
        r.top < pr.bottom &&
        r.bottom > pr.top;
      return {
        label,
        top,
        left: r.left,
        right: r.right,
        bottom: top + r.height,
        group,
        key,
        region,
        underPill,
      };
    });
    if (!s) break;
    stops.push(s);
  }
  return stops;
}

for (const vp of WIDTHS) {
  test(`tab order follows reading order at ${vp.name}px`, async ({ browser }) => {
    test.setTimeout(120_000);
    const { ctx, page } = await open(browser, vp.width, vp.height);
    const stops = await tabThrough(page);
    expect(stops.length).toBeGreaterThan(40);

    // 1. regions come in page order: skip link, nav, main content, footer, then the sticky pill
    const regionRank = { skip: 0, nav: 1, main: 2, footer: 3, pill: 4 } as const;
    const problems: string[] = [];
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1]!;
      const b = stops[i]!;
      if (regionRank[b.region] < regionRank[a.region])
        problems.push(`${b.label} (${b.region}) comes after ${a.label} (${a.region})`);
      if (b.region !== a.region || b.region === 'pill' || b.region === 'skip') continue;
      // 2. inside a region: reading order, top to bottom and left to right
      const sameRow =
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) >
        0.5 * Math.min(a.bottom - a.top, b.bottom - b.top);
      if (sameRow) {
        if (b.left < a.left - 2)
          problems.push(`${b.label} jumps left of ${a.label} on the same row`);
        continue;
      }
      if (b.top >= a.top - 2) continue; // moved down: fine
      // moved up: only legal as a move into the next column of a column layout (story text then
      // its card; footer columns), and then the DOM index of that column must grow
      const columnMove =
        a.group !== '' && a.group === b.group && b.key > a.key && b.left > a.right - 2;
      if (!columnMove)
        problems.push(
          `${b.label} (y ${Math.round(b.top)}) jumps back up from ${a.label} (y ${Math.round(a.top)})`,
        );
    }
    expect(problems).toEqual([]);

    // 3. nothing interactive is skipped: every visible control was a tab stop (roving tabs excepted)
    const visited = new Set(stops.map((s) => s.label));
    const missed = await page.evaluate(
      (visitedLabels) => {
        const seen = new Set(visitedLabels);
        return Array.from(
          document.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), summary'),
        )
          .filter(
            (e) =>
              e.tabIndex >= 0 &&
              e.checkVisibility({ visibilityProperty: true }) &&
              e.getBoundingClientRect().width > 0,
          )
          .map(
            (e) =>
              `${e.tagName.toLowerCase()} "${(e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 28)}"`,
          )
          .filter((l) => !seen.has(l));
      },
      [...visited],
    );
    expect(missed, 'visible controls that Tab never reached').toEqual([]);

    // 4. WCAG 2.4.11: while the sticky pill is on screen, a focused control is never hidden under it
    expect(
      stops.filter((s) => s.underPill).map((s) => s.label),
      'focused elements covered by the sticky pill',
    ).toEqual([]);

    // 5. the pill is a mobile-layout control: never a tab stop above the burger breakpoint, and when
    //    it is a stop (it is only focusable while shown) it comes after everything else
    if (vp.width > BURGER_MAX) {
      expect(stops.some((s) => s.region === 'pill')).toBe(false);
    } else {
      const i = stops.findIndex((s) => s.region === 'pill');
      if (i !== -1) expect(i).toBe(stops.length - 1);
    }
    await ctx.close();
  });
}

/* ------------------------------------------------------------------ keyboard operation */

test('keyboard: burger menu opens with Enter and Space, closes with Escape, focus returns', async ({
  browser,
}) => {
  const { ctx, page } = await open(browser, 390, 844);
  const burger = page.locator('.menu-btn');
  for (const key of ['Enter', 'Space']) {
    await burger.focus();
    await page.keyboard.press(key);
    await expect(burger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#mnav a').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(burger).toHaveAttribute('aria-expanded', 'false');
    await expect(burger).toBeFocused();
  }
  // choosing a link with the keyboard closes the menu and moves to its section
  await burger.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab'); // Trends
  await page.keyboard.press('Enter');
  await expect(burger).toHaveAttribute('aria-expanded', 'false');
  await ctx.close();
});

test('keyboard: feature slider dots are operable and the slider does not move under focus', async ({
  browser,
}) => {
  const { ctx, page } = await open(browser, 1440, 900, false);
  const dots = page.locator('.fdots button');
  await dots.nth(0).scrollIntoViewIfNeeded();
  await dots.nth(0).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(dots.nth(2)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dots.nth(2)).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('.fslide[data-on="true"]')).toHaveCount(1);
  const title = await page.locator('.fslide[data-on="true"] h3').innerText();
  await page.waitForTimeout(4800); // longer than the 4s auto-advance
  expect(await page.locator('.fslide[data-on="true"] h3').innerText()).toBe(title);
  await page.keyboard.press('Space');
  await expect(dots.nth(2)).toHaveAttribute('aria-current', 'true');
  await ctx.close();
});

test('keyboard: coin tabs and story card tabs follow the arrow-key tabs pattern', async ({
  browser,
}) => {
  const { ctx, page } = await open(browser, 1440, 900);
  const tab = (name: RegExp) => page.getByRole('tab', { name }).first();
  await tab(/Top coins/).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab(/Top niches/)).toBeFocused();
  await expect(tab(/Top niches/)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(tab(/Hidden gems/)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tab(/Top coins/)).toBeFocused();
  await page.keyboard.press('ArrowLeft'); // wraps
  await expect(tab(/Hidden gems/)).toBeFocused();

  // Fresh page for the story tabs: the coin-tab checks above leave focus and scroll in a state
  // that is not what a visitor arriving at the story would have.
  // A reload restores the old scroll position, which leaves the story out of view; navigate afresh.
  await page.goto('/', { waitUntil: 'networkidle' });
  const nt = page.locator('.ntab');
  await nt.nth(0).scrollIntoViewIfNeeded();
  await nt.nth(0).focus();
  await page.keyboard.press('ArrowRight');
  await expect(nt.nth(1)).toBeFocused();
  await expect(nt.nth(1)).toHaveAttribute('aria-selected', 'true');
  await ctx.close();
});

test('keyboard: FAQ items open and close with Enter and Space', async ({ browser }) => {
  const { ctx, page } = await open(browser, 1440, 900);
  const first = page.locator('details').first();
  await first.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('open', '');
  await page.keyboard.press('Space');
  await expect(first).not.toHaveAttribute('open', '');
  await ctx.close();
});

test('keyboard: the sticky pill is reached with Tab after the footer and activated with Enter', async ({
  browser,
}) => {
  const { ctx, page } = await open(browser, 390, 844);
  await jumpToY(page, await pageHeight(page));
  const last = page.locator('footer a').last();
  await last.focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('.sticky-cta a')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect
    .poll(() => page.evaluate(() => document.getElementById('quiz')!.getBoundingClientRect().top), {
      timeout: 5000,
    })
    .toBeLessThan(260);
  await ctx.close();
});

test('a hidden pill is not focusable', async ({ browser }) => {
  const { ctx, page } = await open(browser, 390, 844);
  await expect(page.locator('.sticky-cta')).toBeHidden();
  const focusable = await page.evaluate(() => {
    const a = document.querySelector<HTMLElement>('.sticky-cta a')!;
    a.focus();
    return document.activeElement === a;
  });
  expect(focusable).toBe(false);
  await ctx.close();
});

/* ------------------------------------------------------------------ reduced motion */

test.describe('prefers-reduced-motion: reduce', () => {
  test('no CSS animation or transition is running anywhere on the page', async ({ browser }) => {
    const { ctx, page } = await open(browser, 1440, 900, true);
    const h = await pageHeight(page);
    for (let y = 0; y < h; y += 700) await jumpToY(page, y);
    await jumpToY(page, 0);
    await page.waitForTimeout(500);
    const info = await page.evaluate(() => {
      const running = document
        .getAnimations()
        .map((a) => (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty);
      const slow = Array.from(document.querySelectorAll<HTMLElement>('.cs *')).filter((e) => {
        const cs = getComputedStyle(e);
        return (
          cs.transitionDuration.split(',').some((d) => parseFloat(d) > 0) ||
          cs.animationName !== 'none'
        );
      }).length;
      return { running, slow };
    });
    expect(info.running).toEqual([]);
    expect(info.slow).toBe(0);
    // smooth scrolling is motion too: anchors and the nav links jump instead
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior),
    ).toBe('auto');
    await ctx.close();

    // control: without the preference the page does animate, so the check above is not vacuous
    const motion = await open(browser, 1440, 900, false);
    const n = await motion.page.evaluate(() => document.getAnimations().length);
    expect(n).toBeGreaterThan(0);
    expect(
      await motion.page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior),
    ).toBe('smooth');
    await motion.ctx.close();
  });

  test('feature slider never auto-advances (and does with motion on)', async ({ browser }) => {
    const reduced = await open(browser, 1440, 900, true);
    await reduced.page.locator('.fcard').scrollIntoViewIfNeeded();
    const first = await reduced.page.locator('.fslide[data-on="true"] h3').innerText();
    await reduced.page.waitForTimeout(8500); // two full 4s intervals
    expect(await reduced.page.locator('.fslide[data-on="true"] h3').innerText()).toBe(first);
    await reduced.ctx.close();

    const motion = await open(browser, 1440, 900, false);
    await motion.page.locator('.fcard').scrollIntoViewIfNeeded();
    // mouse parked away from the card, so it is not paused by hover
    await motion.page.mouse.move(5, 5);
    const before = await motion.page.locator('.fslide[data-on="true"] h3').innerText();
    await expect
      .poll(() => motion.page.locator('.fslide[data-on="true"] h3').innerText(), { timeout: 9000 })
      .not.toBe(before);
    await motion.ctx.close();
  });

  test('story card does not rotate on its own, steps swap instantly, nothing is scroll-linked', async ({
    browser,
  }) => {
    const reduced = await open(browser, 1440, 900, true);
    await reduced.page.evaluate(() =>
      document.getElementById('trends')!.scrollIntoView({ block: 'center' }),
    );
    await reduced.page.waitForTimeout(400);
    const active = () => reduced.page.locator('.ntab[aria-selected="true"]').first().innerText();
    const t0 = await active();
    await reduced.page.waitForTimeout(9000); // two full 4.2s intervals
    expect(await active()).toBe(t0);

    // instant swaps: transitions are zero length, and the swap has completed in the same frame
    const swap = await reduced.page.evaluate(async () => {
      document.documentElement.style.scrollBehavior = 'auto';
      const sv = Array.from(document.querySelectorAll<HTMLElement>('.sv'));
      const steps = Array.from(document.querySelectorAll<HTMLElement>('.step'));
      const durations = [...sv, ...steps].map((e) => getComputedStyle(e).transitionDuration);
      document.getElementById('gems')!.scrollIntoView({ block: 'center' });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise((r) => setTimeout(r, 120));
      const on = sv.filter((e) => e.dataset.on === 'true');
      return {
        durations,
        onCount: on.length,
        onOpacity: on.map((e) => getComputedStyle(e).opacity),
        onTransform: on.map((e) => getComputedStyle(e).transform),
        stepOpacities: steps.map((e) => getComputedStyle(e).opacity),
      };
    });
    expect(swap.durations.every((d) => d.split(',').every((x) => parseFloat(x) === 0))).toBe(true);
    expect(swap.onCount).toBe(1);
    expect(swap.onOpacity).toEqual(['1']);
    expect(swap.onTransform).toEqual(['none']);

    // no parallax: the decorative layers keep the same transform at two different scroll offsets
    const sig = async (y: number) => {
      await jumpToY(reduced.page, y);
      return reduced.page.evaluate(() =>
        [
          '.hero-bg .beam',
          '.hero-bg .gridlines',
          '.pillar-img',
          '.finale .floor',
          '.finale .mist',
        ].map((s) => getComputedStyle(document.querySelector(s)!).transform),
      );
    };
    expect(await sig(0)).toEqual(await sig(1500));
    await reduced.ctx.close();

    // control: with motion on, the story swap does use a transition
    const motion = await open(browser, 1440, 900, false);
    const d = await motion.page.evaluate(
      () => getComputedStyle(document.querySelector('.sv')!).transitionDuration,
    );
    expect(d.split(',').some((x) => parseFloat(x) > 0)).toBe(true);
    await motion.ctx.close();
  });

  test('story card rotates by itself with motion on (control for the check above)', async ({
    browser,
  }) => {
    const motion = await open(browser, 1440, 900, false);
    await motion.page.evaluate(() =>
      document.getElementById('trends')!.scrollIntoView({ block: 'center' }),
    );
    await motion.page.mouse.move(5, 5);
    const first = await motion.page.locator('.ntab[aria-selected="true"]').first().innerText();
    await expect
      .poll(() => motion.page.locator('.ntab[aria-selected="true"]').first().innerText(), {
        timeout: 9000,
      })
      .not.toBe(first);
    await motion.ctx.close();
  });

  test('counting stats show their final values immediately', async ({ browser }) => {
    for (const reduced of [true, false]) {
      const { ctx, page } = await open(browser, 1440, 900, reduced);
      // nothing has been scrolled into view and no time has passed: the number is already final
      const shown = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.stat b > span[aria-hidden="true"]')).map(
          (s) => s.textContent,
        ),
      );
      expect(shown).toEqual(['11+', '1000+', '24', '0']);
      if (reduced) {
        // and it stays final when the tiles are scrolled into view
        await page.locator('.stats').scrollIntoViewIfNeeded();
        await page.waitForTimeout(150);
        const after = await page.evaluate(() =>
          Array.from(document.querySelectorAll('.stat b > span[aria-hidden="true"]')).map(
            (s) => s.textContent,
          ),
        );
        expect(after).toEqual(['11+', '1000+', '24', '0']);
      }
      await ctx.close();
    }
  });
});

/* ------------------------------------------------------------------ images */

test('images: every img has an alt attribute; informative ones say something, decorative ones are empty', async ({
  browser,
}) => {
  const { ctx, page } = await open(browser, 1440, 900);
  const imgs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('img')).map((i) => ({
      alt: i.getAttribute('alt'),
      src: i.getAttribute('src') ?? '',
      inLink: !!i.closest('a'),
      cls: i.className,
      // text that names the same thing next to the image (so an empty alt loses nothing)
      siblingText: (i.parentElement?.textContent ?? '').trim().length > 0,
      pillarHeading: !!i.closest('.pillar')?.querySelector('h3'),
      linkName: i.closest('a')?.getAttribute('aria-label') ?? '',
    })),
  );
  expect(imgs.length).toBeGreaterThan(30);
  const missing = imgs.filter((i) => i.alt === null).map((i) => i.src);
  expect(missing, 'img without an alt attribute').toEqual([]);
  // informative images (non-empty alt): only the two partner logos, and the name is the vendor
  const informative = imgs.filter((i) => i.alt !== '');
  expect(informative.map((i) => i.alt).sort()).toEqual(['CoinGecko', 'DefiLlama']);
  // decorative images (alt=""): coin logos sit next to the coin name, pillar art above its heading,
  // the logogram is inside the brand link that carries its own name
  for (const d of imgs.filter((i) => i.alt === '')) {
    const ok = d.cls.includes('cimg') || d.cls.includes('pillar-img') || d.src.includes('logogram');
    expect(ok, `unexpected decorative image ${d.src}`).toBe(true);
    if (d.cls.includes('cimg')) expect(d.siblingText).toBe(true);
    if (d.cls.includes('pillar-img')) expect(d.pillarHeading).toBe(true);
    if (d.src.includes('logogram')) expect(d.inLink).toBe(true);
  }
  // graphics that are not <img>: every svg with a role is named, every other svg is hidden from AT
  const svgs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('svg')).map((s) => ({
      role: s.getAttribute('role'),
      label: s.getAttribute('aria-label') ?? s.querySelector('title')?.textContent ?? '',
      hidden: s.getAttribute('aria-hidden') === 'true' || !!s.closest('[aria-hidden="true"]'),
    })),
  );
  for (const s of svgs) {
    if (s.role === 'img') expect(s.label.length).toBeGreaterThan(0);
    else expect(s.hidden).toBe(true);
  }
  await ctx.close();
});
