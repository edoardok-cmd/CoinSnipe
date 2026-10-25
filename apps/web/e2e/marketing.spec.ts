import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
];

// Sections in page order, with the selector to scroll to for each screenshot.
// Order follows the hub's live page (#site): hero, how, trends, gems, portfolio, signal to decision,
// spot the moves, pricing, final CTA, questions.
const SECTIONS: [string, string][] = [
  ['01-hero', 'body'],
  ['02-pillars', '#how'],
  ['03-story-markets', '#trends'],
  ['04-story-gems', '#gems'],
  ['05-story-portfolio', '#portfolio'],
  ['06-signal-to-decision', '#flow-title'],
  ['07-coin-tabs', '#signals'],
  ['08-pricing', '#pricing'],
  ['09-final-cta', '#quiz'],
  ['10-faq', '#faq'],
  ['11-footer', 'footer'],
];

async function jumpTo(page: Page, selector: string) {
  await page.evaluate((sel) => {
    document.documentElement.style.scrollBehavior = 'auto';
    const el = document.querySelector(sel);
    if (!el) throw new Error(`missing ${sel}`);
    const y = sel === 'body' ? 0 : el.getBoundingClientRect().top + window.scrollY - 110;
    window.scrollTo(0, y);
  }, selector);
  await page.waitForTimeout(900);
}

test.describe('marketing page', () => {
  for (const vp of VIEWPORTS) {
    test(`no console errors and screenshots at ${vp.name}`, async ({ page }) => {
      const errors: string[] = [];
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/', { waitUntil: 'networkidle' });
      for (const [name, selector] of SECTIONS) {
        await jumpTo(page, selector);
        await page.screenshot({ path: `e2e/__screenshots__/${vp.name}/${name}.png` });
      }
      expect(errors).toEqual([]);
    });
  }

  test('every nav link scrolls to its section', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/', { waitUntil: 'networkidle' });
    for (const [label, id] of [
      ['Trends', 'trends'],
      ['Portfolio', 'portfolio'],
      ['Coin signals', 'signals'],
      ['Pricing', 'pricing'],
    ]) {
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: label! })
        .click();
      // Wait for the smooth scroll to land: the section top is inside the band under the nav.
      await expect
        .poll(
          async () =>
            page.evaluate((i) => {
              const t = document.getElementById(i!)!.getBoundingClientRect().top;
              return t > -40 && t < 260;
            }, id),
          { timeout: 5000 },
        )
        .toBe(true);
      const top = await page.evaluate(
        (i) => document.getElementById(i!)!.getBoundingClientRect().top,
        id,
      );
      expect(top).toBeLessThan(260);
      await expect(
        page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label! }),
      ).toHaveAttribute('aria-current', 'true');
    }
  });

  test('burger menu: aria-expanded, focus trap, Escape', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/', { waitUntil: 'networkidle' });
    const burger = page.locator('.menu-btn');
    await expect(burger).toHaveAttribute('aria-expanded', 'false');
    await burger.click();
    await expect(burger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#mnav a').first()).toBeFocused();
    // Tab cycles: 5 menu links, then the burger, then back to the first link.
    for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
    await expect(burger).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#mnav a').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(burger).toHaveAttribute('aria-expanded', 'false');
    await expect(burger).toBeFocused();
  });

  test('feature slider pauses on hover and shows four dots', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/', { waitUntil: 'networkidle' });
    const card = page.locator('.fcard');
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator('.fdots button')).toHaveCount(4);
    await card.hover();
    const before = await card.locator('.fslide[data-on="true"] h3').innerText();
    await page.waitForTimeout(4600);
    expect(await card.locator('.fslide[data-on="true"] h3').innerText()).toBe(before);
  });

  test('the sample data badge shows in non-production builds', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Sample data', { exact: true })).toBeVisible();
  });

  test('temperature pills stay in their rows, also with reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/', { waitUntil: 'networkidle' });
    const check = async (rowSelector: string, expected: number) => {
      const result = await page.evaluate((sel) => {
        const rows = Array.from(document.querySelectorAll<HTMLElement>(sel));
        return rows
          .filter((r) => r.offsetParent !== null)
          .map((r) => {
            const pill = r.querySelector<HTMLElement>('.sig:not(.only-m .sig)');
            if (!pill) return { ok: false, why: 'no pill' };
            const rb = r.getBoundingClientRect();
            const pb = pill.getBoundingClientRect();
            return {
              ok:
                getComputedStyle(pill).position !== 'fixed' &&
                pb.top >= rb.top - 1 &&
                pb.bottom <= rb.bottom + 1 &&
                pb.right <= rb.right + 1,
              why: `${getComputedStyle(pill).position} ${Math.round(pb.top - rb.top)}`,
            };
          });
      }, rowSelector);
      expect(result.length).toBe(expected);
      expect(result.filter((r) => !r.ok)).toEqual([]);
    };
    await page.locator('#signals').scrollIntoViewIfNeeded();
    await check('#signals .lrow', 6);
    await page.getByRole('tab', { name: /Top niches/ }).click();
    await check('#signals .lrow', 6);
    // niche momentum words fit inside their pill
    const overflow = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll<HTMLElement>('.sig-wide')).filter(
          (e) => e.offsetParent !== null && e.scrollWidth > e.clientWidth,
        ).length,
    );
    expect(overflow).toBe(0);
    await page.locator('.story').scrollIntoViewIfNeeded();
    await page.evaluate(() => document.getElementById('portfolio')!.scrollIntoView());
    await page.waitForTimeout(800);
    await check('.sv[data-on="true"] .hold', 4);
  });

  test('niche pills do not collide with the sparklines at 390', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: /Top niches/ }).click();
    const collisions = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll<HTMLElement>('#signals .lrow')).filter((row) => {
          const pill = row.querySelector<HTMLElement>('.mcol .sig');
          const spark = row.querySelector<HTMLElement>('.rr');
          if (!pill || !spark) return true;
          return pill.getBoundingClientRect().left < spark.getBoundingClientRect().right;
        }).length,
    );
    expect(collisions).toBe(0);
  });

  test('nav highlights Portfolio while the portfolio step is centred', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = 'auto';
      const el = document.getElementById('portfolio')!;
      const r = el.getBoundingClientRect();
      window.scrollTo(0, r.top + window.scrollY - (window.innerHeight - r.height) / 2);
    });
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Portfolio' }),
    ).toHaveAttribute('aria-current', 'true');
  });
});
