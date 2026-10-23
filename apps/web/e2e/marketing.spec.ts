import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
];

// Sections in page order, with the selector to scroll to for each screenshot.
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
      ['Coin signals', 'signals'],
      ['Trends', 'trends'],
      ['Portfolio', 'portfolio'],
      ['Pricing', 'pricing'],
    ]) {
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: label! })
        .click();
      await expect
        .poll(
          async () =>
            page.evaluate((i) => document.getElementById(i!)!.getBoundingClientRect().top, id),
          {
            timeout: 5000,
          },
        )
        .toBeLessThan(260);
      const top = await page.evaluate(
        (i) => document.getElementById(i!)!.getBoundingClientRect().top,
        id,
      );
      expect(top).toBeGreaterThan(-40);
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
});
