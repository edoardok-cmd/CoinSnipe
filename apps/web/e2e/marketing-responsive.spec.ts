import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  BURGER_MAX,
  WIDTHS,
  clippedText,
  horizontalOverflow,
  jumpToY,
  pageHeight,
  siblingOverlaps,
  textCollisions,
} from './helpers/layout';
import type { ViewportDef } from './helpers/layout';

/**
 * Responsive pass (CSN-012): at 1440, 1024 and 390 nothing scrolls sideways, overlaps or is cut
 * off, in every interactive state of the page; and the mobile layout carries the sticky
 * "Start for free" pill from the product flow map.
 *
 * Screenshots: set E2E_REPORT_DIR to also write them to <dir>/screenshots/<width>/.
 */

const REPORT_DIR = process.env.E2E_REPORT_DIR;

async function open(browser: Browser, width: number, height: number, reduced = true) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    reducedMotion: reduced ? 'reduce' : 'no-preference',
  });
  const page = await ctx.newPage();
  await page.goto('/', { waitUntil: 'networkidle' });
  return { ctx, page };
}

type State = { name: string; apply: (page: Page, width: number) => Promise<void> };

/** Every state that changes what is on screen. Each one is laid out and checked. */
const STATES: State[] = [
  { name: 'default', apply: async () => {} },
  ...['Top niches', 'Hidden gems'].map<State>((label) => ({
    name: `coin tab: ${label}`,
    apply: async (page) => {
      await page
        .getByRole('tab', { name: new RegExp(label) })
        .first()
        .click();
    },
  })),
  ...[0, 1, 2, 3].map<State>((i) => ({
    name: `feature slide ${i + 1}`,
    apply: async (page) => {
      await page.locator('.fdots button').nth(i).click();
    },
  })),
  ...[0, 1, 2].map<State>((i) => ({
    name: `story card tab ${i + 1}`,
    apply: async (page) => {
      // The niche tabs live in the trends step; bring that step into view first (the page order is
      // hero, how, trends, gems, portfolio, signals), so the tabs are rendered and clickable.
      await page.evaluate(() => {
        document.documentElement.style.scrollBehavior = 'auto';
        document.getElementById('trends')!.scrollIntoView({ block: 'center' });
      });
      await page.waitForTimeout(300);
      await page.locator('.ntab').nth(i).click();
    },
  })),
  {
    name: 'all FAQ answers open',
    apply: async (page) => {
      await page.evaluate(() =>
        document.querySelectorAll('details').forEach((d) => (d.open = true)),
      );
    },
  },
  {
    name: 'mobile menu open',
    apply: async (page, width) => {
      if (width > BURGER_MAX) return;
      await page.locator('.menu-btn').click();
    },
  },
];

/**
 * The three widths of the brief, plus the widths just around the breakpoints (900/980 and 720)
 * where the layout switches, which is where overlaps hide.
 */
const LAYOUT_WIDTHS = [
  ...WIDTHS,
  { name: '768', width: 768, height: 1024 },
  { name: '901', width: 901, height: 800 },
  { name: '1100', width: 1100, height: 800 },
] as const;

test.describe('responsive: no sideways scroll, no overlap, no cut-off text', () => {
  for (const vp of LAYOUT_WIDTHS) {
    test(`${vp.name}px, every page state`, async ({ browser }) => {
      test.setTimeout(120_000);
      const { ctx, page } = await open(browser, vp.width, vp.height);
      const problems: string[] = [];
      for (const state of STATES) {
        await state.apply(page, vp.width);
        await page.waitForTimeout(150);
        const tag = `[${vp.name} / ${state.name}]`;

        const o = await horizontalOverflow(page);
        if (o.scrollWidth > o.innerWidth)
          problems.push(
            `${tag} documentElement.scrollWidth ${o.scrollWidth} > innerWidth ${o.innerWidth}`,
          );
        if (o.bodyScrollWidth > o.innerWidth)
          problems.push(
            `${tag} body.scrollWidth ${o.bodyScrollWidth} > innerWidth ${o.innerWidth}`,
          );
        for (const e of o.escaping) problems.push(`${tag} escapes the viewport: ${e}`);

        for (const ov of await siblingOverlaps(page))
          problems.push(
            `${tag} sibling overlap in ${ov.parent}: ${ov.a} x ${ov.b} (${ov.area}px2)`,
          );

        for (const t of await textCollisions(page))
          problems.push(`${tag} text on text: ${t.a} x ${t.b} (${t.area}px2)`);

        const c = await clippedText(page);
        for (const x of c.clipped)
          problems.push(`${tag} text cut off (${x.axis}) by ${x.by}: ${x.container} "${x.text}"`);
        for (const x of c.ellipsised)
          problems.push(
            `${tag} text truncated with an ellipsis by ${x.by}: ${x.container} "${x.text}"`,
          );

        // Close the menu again so the next state starts from the page, not the overlay.
        if (state.name === 'mobile menu open' && vp.width <= BURGER_MAX)
          await page.keyboard.press('Escape');
      }
      // Dedupe repeats of the same finding across states and rows, keep the first sighting.
      const seen = new Set<string>();
      const unique = problems.filter((p) => {
        const key = p.replace(/^\[[^\]]*\]\s*/, '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      expect(unique).toEqual([]);
      await ctx.close();
    });
  }

  test('nothing scrolls sideways with motion on either (default state, after the intro settles)', async ({
    browser,
  }) => {
    for (const vp of WIDTHS) {
      const { ctx, page } = await open(browser, vp.width, vp.height, false);
      await page.waitForTimeout(1600);
      const o = await horizontalOverflow(page);
      expect(o.scrollWidth, `${vp.name} scrollWidth`).toBeLessThanOrEqual(o.innerWidth);
      expect(o.escaping, `${vp.name} escaping`).toEqual([]);
      expect(await siblingOverlaps(page), `${vp.name} overlaps`).toEqual([]);
      await ctx.close();
    }
  });

  test('the four coin tabs are all fully visible at 390 (no hidden scroller)', async ({
    browser,
  }) => {
    const { ctx, page } = await open(browser, 390, 844);
    const m = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>('.tabs')!;
      const rb = row.getBoundingClientRect();
      return {
        scrollable: row.scrollWidth > row.clientWidth + 1,
        outside: Array.from(row.querySelectorAll<HTMLElement>('.tab')).filter((t) => {
          const b = t.getBoundingClientRect();
          return b.left < rb.left - 1 || b.right > rb.right + 1 || b.right > innerWidth;
        }).length,
      };
    });
    expect(m).toEqual({ scrollable: false, outside: 0 });
    await ctx.close();
  });
});

/* ------------------------------------------------------------------ mobile web: burger + sticky pill */

test.describe('mobile web layout', () => {
  test('at 390 the page uses the burger nav, not the link row', async ({ browser }) => {
    const { ctx, page } = await open(browser, 390, 844);
    await expect(page.locator('.menu-btn')).toBeVisible();
    await expect(page.locator('.navspy')).toBeHidden();
    await expect(page.locator('.nav-actions .hide-m')).toBeHidden();
    await ctx.close();
  });

  test('the pill follows the burger breakpoint: on at 980 and below, off at 981 and above', async ({
    browser,
  }) => {
    for (const w of [390, 768, 980, 981, 1024, 1440]) {
      const { ctx, page } = await open(browser, w, 800);
      const state = await page.evaluate(() => ({
        burger: getComputedStyle(document.querySelector('.menu-btn')!).display !== 'none',
        pill: getComputedStyle(document.querySelector('.sticky-cta')!).display !== 'none',
      }));
      expect(state.pill, `pill display at ${w}`).toBe(w <= BURGER_MAX);
      expect(state.burger, `burger display at ${w}`).toBe(w <= BURGER_MAX);
      await ctx.close();
    }
  });

  test('390: hidden over the hero, shown once the hero is out of view, hidden over the final CTA', async ({
    browser,
  }) => {
    const { ctx, page } = await open(browser, 390, 844);
    const pill = page.locator('.sticky-cta');
    const geo = await page.evaluate(() => {
      const hero = document.querySelector<HTMLElement>('.hero .junction')!;
      const fin = document.getElementById('quiz')!;
      return {
        heroBottom: hero.getBoundingClientRect().bottom + window.scrollY,
        finTop: fin.getBoundingClientRect().top + window.scrollY,
        finBottom: fin.getBoundingClientRect().bottom + window.scrollY,
      };
    });
    const vh = 844;

    await expect(pill).toBeHidden(); // top of the page
    await jumpToY(page, Math.round(geo.heroBottom - vh + 200)); // hero button well inside the viewport
    await expect(pill).toBeHidden();
    await jumpToY(page, Math.round(geo.heroBottom - 40)); // hero button still 40px in view
    await expect(pill).toBeHidden();
    await jumpToY(page, Math.round(geo.heroBottom + 2)); // hero button gone
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText('Start for free');

    await jumpToY(page, Math.round(geo.finTop - vh + 10)); // final CTA 10px into view
    await expect(pill).toBeHidden();
    await jumpToY(page, Math.round(geo.finTop - 200)); // inside the final CTA
    await expect(pill).toBeHidden();
    await jumpToY(page, Math.round(geo.finBottom + 5)); // final CTA just scrolled out, footer on screen
    await expect(pill).toBeVisible();
    await jumpToY(page, Math.round(geo.finTop - vh - 60)); // well before the final CTA
    await expect(pill).toBeVisible();
    await ctx.close();
  });

  test('390: the pill sits inside the viewport, clear of the sample badge, and links to the final CTA', async ({
    browser,
  }) => {
    const { ctx, page } = await open(browser, 390, 844);
    await jumpToY(page, 1500);
    const pill = page.locator('.sticky-cta');
    await expect(pill).toBeVisible();
    const g = await page.evaluate(() => {
      const r = (s: string) => {
        const e = document.querySelector(s);
        return e ? e.getBoundingClientRect().toJSON() : null;
      };
      return {
        pill: r('.sticky-cta')!,
        badge: r('.sample-badge'),
        vw: innerWidth,
        vh: innerHeight,
      };
    });
    expect(g.pill.left).toBeGreaterThanOrEqual(8);
    expect(g.pill.right).toBeLessThanOrEqual(g.vw - 8);
    expect(g.pill.bottom).toBeLessThanOrEqual(g.vh - 8);
    expect(g.pill.height).toBeGreaterThanOrEqual(44); // touch target
    if (g.badge) {
      const overlaps =
        g.pill.left < g.badge.right &&
        g.pill.right > g.badge.left &&
        g.pill.top < g.badge.bottom &&
        g.pill.bottom > g.badge.top;
      expect(overlaps, 'pill must not sit on the sample badge').toBe(false);
    }
    expect(await pill.locator('a').getAttribute('href')).toBe('#quiz');
    await pill.locator('a').click();
    await expect
      .poll(
        () => page.evaluate(() => document.getElementById('quiz')!.getBoundingClientRect().top),
        {
          timeout: 5000,
        },
      )
      .toBeLessThan(260);
    await expect(pill).toBeHidden();
    await ctx.close();
  });

  test('390: at the very end of the page the pill covers no text and no control', async ({
    browser,
  }) => {
    const { ctx, page } = await open(browser, 390, 844);
    await jumpToY(page, (await pageHeight(page)) - 844);
    const pill = page.locator('.sticky-cta');
    await expect(pill).toBeVisible();
    const hits = await page.evaluate(() => {
      const p = document.querySelector('.sticky-cta')!.getBoundingClientRect();
      const hit = (r: DOMRect) =>
        r.left < p.right && r.right > p.left && r.top < p.bottom && r.bottom > p.top;
      const out: string[] = [];
      const walker = document.createTreeWalker(
        document.querySelector('.cs')!,
        NodeFilter.SHOW_TEXT,
      );
      let n: Node | null;
      while ((n = walker.nextNode())) {
        const el = n.parentElement!;
        if (
          !(n.textContent ?? '').trim() ||
          el.closest('.sticky-cta, .sample-badge, .nav-wrap, .sr-only')
        )
          continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        if (Array.from(range.getClientRects()).some(hit))
          out.push(`text "${(n.textContent ?? '').trim().slice(0, 30)}"`);
      }
      document
        .querySelectorAll<HTMLElement>('a[href], button, summary, [tabindex="0"]')
        .forEach((e) => {
          if (e.closest('.sticky-cta, .nav-wrap')) return;
          if (hit(e.getBoundingClientRect()))
            out.push(
              `control ${e.tagName.toLowerCase()} "${(e.textContent ?? '').trim().slice(0, 30)}"`,
            );
        });
      return out;
    });
    expect(hits).toEqual([]);
    await ctx.close();
  });

  test('the pill respects reduced motion (instant) and animates otherwise', async ({ browser }) => {
    const reduced = await open(browser, 390, 844, true);
    const rd = await reduced.page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('.sticky-cta')!);
      return { t: cs.transitionDuration, a: cs.animationName };
    });
    expect(rd.t.split(',').every((d) => parseFloat(d) === 0)).toBe(true);
    expect(rd.a).toBe('none');
    await reduced.ctx.close();

    const motion = await open(browser, 390, 844, false);
    const mo = await motion.page.evaluate(
      () => getComputedStyle(document.querySelector('.sticky-cta')!).transitionDuration,
    );
    expect(mo.split(',').some((d) => parseFloat(d) > 0)).toBe(true);
    await motion.ctx.close();
  });

  test('the pill label comes from the content layer', async ({ browser }) => {
    const { ctx, page } = await open(browser, 390, 844);
    const label = await page.evaluate(() => document.querySelector('.sticky-cta a')!.textContent);
    expect(label).toBe('Start for free');
    await ctx.close();
  });
});

/* ------------------------------------------------------------------ screenshots */

async function shot(page: Page, vp: ViewportDef, name: string) {
  mkdirSync(`${REPORT_DIR}/screenshots/${vp.name}`, { recursive: true });
  await page.screenshot({ path: `${REPORT_DIR}/screenshots/${vp.name}/${name}.png` });
}

test.describe('screenshots on file', () => {
  test.skip(!REPORT_DIR, 'set E2E_REPORT_DIR to write the screenshots');
  const SECTIONS: [string, string][] = [
    ['01-hero', 'body'],
    ['02-coin-tabs', '#signals'],
    ['03-pillars', '#how'],
    ['04-signal-to-decision', '#flow-title'],
    ['05-story-markets', '#trends'],
    ['06-story-gems', '#gems'],
    ['07-story-portfolio', '#portfolio'],
    ['08-pricing', '#pricing'],
    ['09-faq', '#faq'],
    ['10-final-cta', '#quiz'],
    ['11-footer', 'footer'],
  ];
  for (const vp of WIDTHS) {
    test(`${vp.name}px`, async ({ browser }) => {
      test.setTimeout(120_000);
      const { ctx, page } = await open(browser, vp.width, vp.height);
      for (const [name, selector] of SECTIONS) {
        await page.evaluate((sel) => {
          document.documentElement.style.scrollBehavior = 'auto';
          const el = document.querySelector(sel)!;
          window.scrollTo(
            0,
            sel === 'body' ? 0 : el.getBoundingClientRect().top + window.scrollY - 110,
          );
        }, selector);
        await page.waitForTimeout(500);
        await shot(page, vp, name);
      }
      if (vp.width <= BURGER_MAX) {
        await jumpToY(page, 1500);
        await shot(page, vp, '12-sticky-pill');
        await jumpToY(page, 0);
        await page.locator('.menu-btn').click();
        await page.waitForTimeout(200);
        await shot(page, vp, '13-burger-menu-open');
      }
      await ctx.close();
    });
  }
});
