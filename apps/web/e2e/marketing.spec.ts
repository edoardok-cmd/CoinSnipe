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

  test('radar panel fits at 390 and the niche pills do not collide', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: /Portfolio/ }).click();
    const clipped = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('.listpanel')!;
      const pb = panel.getBoundingClientRect();
      return Array.from(panel.querySelectorAll<HTMLElement>('.radarbox *'))
        .filter((e) => e.getBoundingClientRect().width > 0)
        .filter(
          (e) =>
            e.getBoundingClientRect().right > pb.right + 1 ||
            e.getBoundingClientRect().left < pb.left - 1,
        )
        .map((e) => e.className || e.tagName);
    });
    expect(clipped).toEqual([]);
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

  // CSN-010-FOLLOWUP-3: the sweep must rotate about the radar centre (130,130 of the 260 viewBox),
  // not the wedge bbox centre, at every width. Motion is enabled; the animation is paused and
  // seeked so the sampled transform is deterministic.
  for (const vp of VIEWPORTS) {
    test(`radar sweep rotates about the radar centre at ${vp.name}`, async ({ browser }) => {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        reducedMotion: 'no-preference',
      });
      const page = await ctx.newPage();
      await page.goto('/', { waitUntil: 'networkidle' });
      await page.getByRole('tab', { name: /Portfolio/ }).click();
      const m = await page.evaluate(() => {
        const g = document.querySelector<SVGGElement>('.radar .sweep')!;
        const svg = g.ownerSVGElement!;
        const anims = g.getAnimations();
        // Screen position of the wedge apex (130,130 in user space) under the g's current transform.
        const at = (ux: number, uy: number) => {
          const c = g.getScreenCTM()!;
          return { x: c.a * ux + c.c * uy + c.e, y: c.b * ux + c.d * uy + c.f };
        };
        const apex = () => at(130, 130);
        // Far end of the wedge's straight edge (130,8): 122 user units from the apex.
        const tip = () => at(130, 8);
        const seek = (t: number) => {
          anims.forEach((a) => {
            a.pause();
            a.currentTime = t;
          });
          return { apex: apex(), tip: tip() };
        };
        const r = svg.getBoundingClientRect();
        const centre = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        const times = [0, 500, 1000, 2000, 3000];
        const all = times.map(seek);
        const samples = all.map((a) => a.apex);
        const tips = all.map((a) => a.tip);
        // At t=0 the angle is 0 and at t=2000 (half of 4s) it is 180deg: the fixed point of the
        // rotation is the midpoint of the apex positions at those two times.
        const rotCentre = {
          x: (samples[0].x + samples[3].x) / 2,
          y: (samples[0].y + samples[3].y) / 2,
        };
        return { animations: anims.length, centre, rotCentre, samples, tips, times, size: r.width };
      });
      expect(m.animations).toBeGreaterThan(0);
      console.log(`radar ${vp.name}`, JSON.stringify(m));
      expect(Math.abs(m.rotCentre.x - m.centre.x)).toBeLessThan(0.5);
      expect(Math.abs(m.rotCentre.y - m.centre.y)).toBeLessThan(0.5);
      for (const s of m.samples) {
        expect(Math.abs(s.x - m.centre.x)).toBeLessThan(0.5);
        expect(Math.abs(s.y - m.centre.y)).toBeLessThan(0.5);
      }
      // The wedge tip must actually orbit the centre: constant radius (122 user units, scaled),
      // and an angle that advances 360deg per 4s from the t=0 angle (guards a no-op keyframe).
      const radius = (m.size / 260) * 122;
      const angle = (p: { x: number; y: number }) =>
        (Math.atan2(p.y - m.centre.y, p.x - m.centre.x) * 180) / Math.PI;
      const a0 = angle(m.tips[0]);
      m.tips.forEach((t, i) => {
        expect(Math.abs(Math.hypot(t.x - m.centre.x, t.y - m.centre.y) - radius)).toBeLessThan(0.5);
        const expected = (360 * m.times[i]) / 4000;
        const delta = ((((angle(t) - a0 - expected + 540) % 360) + 360) % 360) - 180;
        expect(Math.abs(delta)).toBeLessThan(1);
      });
      expect(Math.abs(angle(m.tips[1]) - a0)).toBeGreaterThan(30);
      await ctx.close();
    });
  }

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
