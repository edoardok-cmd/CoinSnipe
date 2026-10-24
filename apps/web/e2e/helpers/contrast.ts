import type { BrowserContext, Page } from '@playwright/test';
import { jumpToY, pageHeight } from './layout';

/**
 * Measured text contrast (CSN-012, R-N4).
 *
 * Computed styles alone cannot say what a glass bar, a blurred gradient or a hero glow looks like
 * behind a word, so the backdrop is MEASURED:
 *   1. every text node in view is found and its colour is resolved (rgba colour times the opacity of
 *      every ancestor; for `.grad` text the colours of its gradient);
 *   2. the page is made text-transparent and a real screenshot is taken, so blur, gradients,
 *      glass and the hero beam are all in the pixels;
 *   3. for each text rect the darkest and the lightest backdrop pixel are found;
 *   4. the text colour is composited over each extreme and the WCAG ratio is computed; the lower one
 *      is the worst case that text sits on.
 * Sticky/fixed elements (nav, pill, badge) get many different backdrops because the page is swept
 * past them in steps. Text hidden behind another element (elementFromPoint) is not measured.
 */

export type Rgb = [number, number, number];

export function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => fg[i]! * alpha + bg[i]! * (1 - alpha)) as Rgb;
}

export function hex(c: Rgb): string {
  return '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

type TextTarget = {
  key: string;
  label: string;
  text: string;
  size: number;
  weight: number;
  /** Candidate text colours (one for solid text, several for gradient text). */
  fgs: Rgb[];
  /** Colour alpha times the opacity of every ancestor. */
  alpha: number;
  rects: { x: number; y: number; w: number; h: number }[];
  /** Text inside a floating bar (nav, open menu, pill, badge). */
  overlay: boolean;
};

export type Measurement = {
  key: string;
  label: string;
  text: string;
  size: number;
  weight: number;
  ratio: number;
  fg: string;
  alpha: number;
  darkest: string;
  lightest: string;
  /** Which backdrop produced the worst ratio. */
  worstOn: 'darkest' | 'lightest';
  scrollY: number;
};

const hideTextCss = (scopes: string[]) =>
  scopes
    .map(
      (scope) => `
  ${scope}, ${scope} *, ${scope} *::before, ${scope} *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; }
  ${scope} .grad { background-image: none !important; background: none !important; }
  ${scope}::before, ${scope}::after { color: transparent !important; }`,
    )
    .join('\n');
/** Floating bars: the page text moving underneath them is part of their backdrop. */
const OVERLAY_SCOPES = ['.cs .nav-wrap', '.cs .sticky-cta', '.cs .sample-badge'];

async function collectTargets(page: Page): Promise<TextTarget[]> {
  // elementFromPoint ignores pointer-events: none (the sample badge), so make everything hit-testable.
  const probe = await page.addStyleTag({ content: '.cs * { pointer-events: auto !important; }' });
  try {
    return await collect(page);
  } finally {
    await probe.evaluate((n) => (n as Element).remove());
  }
}

async function collect(page: Page): Promise<TextTarget[]> {
  return page.evaluate(() => {
    const parse = (s: string): [number, number, number, number] | null => {
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1]!
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(parseFloat);
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
    };
    const label = (e: Element) =>
      `${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : ''}`;
    const path = (e: Element) => {
      const parts: string[] = [];
      let n: Element | null = e;
      while (n && !n.classList.contains('cs') && parts.length < 4) {
        parts.unshift(label(n));
        n = n.parentElement;
      }
      return parts.join(' > ');
    };
    const out: {
      key: string;
      label: string;
      text: string;
      size: number;
      weight: number;
      fgs: [number, number, number][];
      alpha: number;
      rects: { x: number; y: number; w: number; h: number }[];
      overlay: boolean;
    }[] = [];
    const walker = document.createTreeWalker(document.querySelector('.cs')!, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = (node.textContent ?? '').trim();
      if (!text) continue;
      const el = node.parentElement!;
      if (el.closest('svg, [hidden], .sr-only')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility !== 'visible') continue;
      let opacity = 1;
      for (let n: Element | null = el; n; n = n.parentElement) {
        opacity *= parseFloat(getComputedStyle(n).opacity);
      }
      if (opacity < 0.02) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const overlays = Array.from(
        document.querySelectorAll(
          '.nav-wrap .nav, .mnav[data-open="true"], .sample-badge, .sticky-cta',
        ),
      ).filter((o) => !o.contains(el) && getComputedStyle(o).visibility === 'visible');
      // The pill's mint glow (box-shadow 30px blur) reaches ~40px past its box: text that scrolls
      // under it is under an overlay, not on a backdrop, so that margin is excluded too.
      const overlayRects = overlays.map((o) => {
        const r = o.getBoundingClientRect();
        const m = o.classList.contains('sticky-cta') ? 40 : 0;
        return { left: r.left - m, right: r.right + m, top: r.top - m, bottom: r.bottom + m };
      });
      // Drop rects that sit (even partly) under the sticky nav, open menu, pill or sample badge:
      // that is an overlay on top of text, not a text backdrop. Everything else must hit the text.
      const rects = Array.from(range.getClientRects())
        .map((r) => {
          const x = Math.max(0, Math.floor(r.left));
          const y = Math.max(0, Math.floor(r.top));
          const x2 = Math.min(vw, Math.ceil(r.right));
          const y2 = Math.min(vh, Math.ceil(r.bottom));
          return { x, y, w: x2 - x, h: y2 - y };
        })
        .filter((r) => r.w > 1 && r.h > 1)
        .filter(
          (r) =>
            !overlayRects.some(
              (o) => r.x < o.right && r.x + r.w > o.left && r.y < o.bottom && r.y + r.h > o.top,
            ),
        )
        .filter((r) => {
          for (const fx of [0.05, 0.5, 0.95]) {
            for (const fy of [0.1, 0.5, 0.9]) {
              const hit = document.elementFromPoint(r.x + r.w * fx, r.y + r.h * fy);
              if (!hit || !(el.contains(hit) || hit.contains(el))) return false;
            }
          }
          return true;
        });
      if (!rects.length) continue;
      // Text colour: gradient text (background-clip: text on the element or an ancestor) uses the
      // colours of its gradient.
      let fgs: [number, number, number][];
      let alpha = 1;
      let gradientHost: Element | null = null;
      for (let n: Element | null = el; n && !n.classList.contains('cs'); n = n.parentElement) {
        const ncs = getComputedStyle(n);
        if (
          (ncs.backgroundClip === 'text' || ncs.webkitBackgroundClip === 'text') &&
          ncs.backgroundImage !== 'none'
        ) {
          gradientHost = n;
          break;
        }
      }
      if (gradientHost) {
        const bi = getComputedStyle(gradientHost).backgroundImage;
        fgs = Array.from(bi.matchAll(/rgba?\([^)]+\)/g)).map((m) => {
          const p = parse(m[0])!;
          return [p[0], p[1], p[2]] as [number, number, number];
        });
      } else {
        const c = parse(cs.color);
        if (!c) continue;
        fgs = [[c[0], c[1], c[2]]];
        alpha = c[3];
      }
      if (!fgs.length) continue;
      out.push({
        key: `${path(el)} :: ${text.slice(0, 40)}`,
        label: path(el),
        text: text.slice(0, 60),
        size: parseFloat(cs.fontSize),
        weight: parseInt(cs.fontWeight, 10),
        fgs,
        alpha: alpha * opacity,
        rects,
        overlay: !!el.closest('.nav-wrap, .sticky-cta, .sample-badge'),
      });
    }
    return out;
  });
}

/** Darkest and lightest backdrop colour inside each rect, read from a screenshot in a blank page. */
async function backdropExtremes(
  helper: Page,
  png: Buffer,
  groups: { x: number; y: number; w: number; h: number }[][],
): Promise<{ dark: Rgb; light: Rgb }[]> {
  return helper.evaluate(
    async ({ b64, groups }) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      const lum = (r: number, g: number, b: number) => {
        const f = (c: number) => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      return groups.map((rects) => {
        let dark: [number, number, number] = [255, 255, 255];
        let light: [number, number, number] = [0, 0, 0];
        let dl = Infinity;
        let ll = -Infinity;
        for (const r of rects) {
          const w = Math.min(r.w, bmp.width - r.x);
          const h = Math.min(r.h, bmp.height - r.y);
          if (w <= 0 || h <= 0) continue;
          const d = ctx.getImageData(r.x, r.y, w, h).data;
          for (let i = 0; i < d.length; i += 4) {
            const l = lum(d[i]!, d[i + 1]!, d[i + 2]!);
            if (l < dl) {
              dl = l;
              dark = [d[i]!, d[i + 1]!, d[i + 2]!];
            }
            if (l > ll) {
              ll = l;
              light = [d[i]!, d[i + 1]!, d[i + 2]!];
            }
          }
        }
        return { dark, light };
      });
    },
    { b64: png.toString('base64'), groups },
  );
}

/** Measure every text node currently in the viewport. */
export async function measureViewport(page: Page, helper: Page): Promise<Measurement[]> {
  const scrollY = await page.evaluate(() => Math.round(window.scrollY));
  const targets = await collectTargets(page);
  // Pass 1 hides all text: the backdrop of ordinary text. Pass 2 hides only the floating bars' own
  // text, so the page text sliding under the glass stays in their backdrop (worst case: the screenshot
  // is not blurred, which can only make the backdrop busier than a real backdrop-filter would).
  const shot = async (scopes: string[]) => {
    const style = await page.addStyleTag({ content: hideTextCss(scopes) });
    try {
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      return await page.screenshot({ animations: 'disabled' });
    } finally {
      await style.evaluate((n) => (n as Element).remove());
    }
  };
  const ext: { dark: Rgb; light: Rgb }[] = new Array(targets.length);
  const plain = targets.map((t, i) => ({ t, i })).filter((x) => !x.t.overlay);
  const over = targets.map((t, i) => ({ t, i })).filter((x) => x.t.overlay);
  if (plain.length) {
    const e = await backdropExtremes(
      helper,
      await shot(['.cs']),
      plain.map((x) => x.t.rects),
    );
    plain.forEach((x, k) => (ext[x.i] = e[k]!));
  }
  if (over.length) {
    const e = await backdropExtremes(
      helper,
      await shot(OVERLAY_SCOPES),
      over.map((x) => x.t.rects),
    );
    over.forEach((x, k) => (ext[x.i] = e[k]!));
  }
  return targets.map((t, i) => {
    const { dark, light } = ext[i]!;
    let worst = Infinity;
    let worstOn: 'darkest' | 'lightest' = 'darkest';
    let worstFg: Rgb = t.fgs[0]!;
    for (const fg of t.fgs) {
      for (const [name, bg] of [
        ['darkest', dark],
        ['lightest', light],
      ] as const) {
        const r = contrastRatio(composite(fg, t.alpha, bg), bg);
        if (r < worst) {
          worst = r;
          worstOn = name;
          worstFg = fg;
        }
      }
    }
    return {
      key: t.key,
      label: t.label,
      text: t.text,
      size: t.size,
      weight: t.weight,
      ratio: worst,
      fg: hex(worstFg),
      alpha: Math.round(t.alpha * 100) / 100,
      darkest: hex(dark),
      lightest: hex(light),
      worstOn,
      scrollY,
    };
  });
}

/** Keep the worst ratio per text key. */
export function mergeWorst(into: Map<string, Measurement>, list: Measurement[]): void {
  for (const m of list) {
    const prev = into.get(m.key);
    if (!prev || m.ratio < prev.ratio) into.set(m.key, m);
  }
}

/** A blank page in the same browser, used only to decode screenshots. */
export async function newHelperPage(ctx: BrowserContext): Promise<Page> {
  const p = await ctx.newPage();
  await p.goto('about:blank');
  return p;
}

/** Sweep the whole page in `step` px frames (default: half a viewport) and merge the worst ratios. */
export async function sweepContrast(
  page: Page,
  helper: Page,
  into: Map<string, Measurement>,
  step?: number,
): Promise<void> {
  const vh = page.viewportSize()!.height;
  const h = await pageHeight(page);
  const stride = step ?? Math.round(vh / 2);
  for (let y = 0; y < h - vh + stride; y += stride) {
    await jumpToY(page, Math.min(y, h - vh));
    mergeWorst(into, await measureViewport(page, helper));
  }
}
