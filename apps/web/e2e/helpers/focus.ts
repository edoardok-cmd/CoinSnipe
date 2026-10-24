import type { ElementHandle, Page } from '@playwright/test';
import { contrastRatio } from './contrast';
import type { Rgb } from './contrast';

/**
 * Focus ring checks (CSN-012, R-N4): for one element, move focus to it from the keyboard modality
 * and verify, from computed style AND from real pixels, that a ring is drawn, is not clipped by an
 * ancestor, and stands out (>= 3:1, WCAG 1.4.11) from what is next to it.
 */

export type RingReport = {
  label: string;
  outline: string;
  focusVisible: boolean;
  /** Lowest ring-vs-neighbour contrast over the sides that were sampled. */
  minContrast: number;
  sidesSampled: number;
  problems: string[];
};

type Info = {
  label: string;
  rect: { x: number; y: number; w: number; h: number };
  style: string;
  width: number;
  offset: number;
  styleName: string;
  colour: Rgb;
  focusVisible: boolean;
  active: boolean;
  radiusBefore: string;
  radiusAfter: string;
  paints: boolean;
  clippedBy: string | null;
};

async function pixelAt(
  helper: Page,
  png: Buffer,
  points: { x: number; y: number }[],
): Promise<(Rgb | null)[]> {
  return helper.evaluate(
    async ({ b64, points }) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      return points.map((p) => {
        const x = Math.round(p.x);
        const y = Math.round(p.y);
        if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return null;
        const d = ctx.getImageData(x, y, 1, 1).data;
        return [d[0]!, d[1]!, d[2]!] as [number, number, number];
      });
    },
    { b64: png.toString('base64'), points },
  );
}

export async function checkRing(
  page: Page,
  helper: Page,
  el: ElementHandle<Element>,
): Promise<RingReport> {
  const info: Info = await el.evaluate((e) => {
    const h = e as HTMLElement;
    const label = `${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : ''} "${(e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30)}"`;
    const before = getComputedStyle(h);
    const radiusBefore = before.borderRadius;
    // does the element draw a border or a fill? then a radius change on focus would change its look
    const paints =
      before.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
      before.backgroundImage !== 'none' ||
      ['Top', 'Right', 'Bottom', 'Left'].some(
        (side) =>
          parseFloat(before.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
          before.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none',
      );
    document.documentElement.style.scrollBehavior = 'auto';
    e.scrollIntoView({ block: 'center', inline: 'center' });
    h.focus();
    const cs = getComputedStyle(h);
    const m = cs.outlineColor.match(/rgba?\(([^)]+)\)/)!;
    const [r, g, b] = m[1]!.split(/[ ,/]+/).map(parseFloat);
    const rect = h.getBoundingClientRect();
    const width = parseFloat(cs.outlineWidth);
    const offset = parseFloat(cs.outlineOffset);
    // ring box = border box grown by offset + width; every clipping ancestor must contain it
    const grow = offset + width;
    const ring = {
      l: rect.left - grow,
      r: rect.right + grow,
      t: rect.top - grow,
      b: rect.bottom + grow,
    };
    let clippedBy: string | null = null;
    for (let a = e.parentElement; a && !clippedBy; a = a.parentElement) {
      const acs = getComputedStyle(a);
      const clips = acs.overflowX !== 'visible' || acs.overflowY !== 'visible';
      if (!clips) continue;
      if (a === document.documentElement || a === document.body) continue;
      const ar = a.getBoundingClientRect();
      const isCs = a.classList.contains('cs');
      // .cs clips only sideways (overflow-x: clip), so only the left/right edges count for it
      const outX = ring.l < ar.left - 1 || ring.r > ar.right + 1;
      const outY = ring.t < ar.top - 1 || ring.b > ar.bottom + 1;
      if (outX || (!isCs && outY)) {
        clippedBy = `${a.tagName.toLowerCase()}.${typeof a.className === 'string' ? a.className.trim().split(/\s+/).join('.') : ''}`;
      }
    }
    return {
      label,
      rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      style: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} offset ${cs.outlineOffset}`,
      width,
      offset,
      styleName: cs.outlineStyle,
      colour: [r!, g!, b!] as Rgb,
      focusVisible: h.matches(':focus-visible'),
      active: document.activeElement === e,
      radiusBefore,
      radiusAfter: cs.borderRadius,
      paints,
      clippedBy,
    };
  });

  const problems: string[] = [];
  if (!info.active) problems.push('element did not take focus');
  if (!info.focusVisible) problems.push(':focus-visible does not match');
  if (info.styleName === 'none' || info.width < 2)
    problems.push(`no visible outline (${info.style})`);
  if (info.offset < 2) problems.push(`outline offset ${info.offset}px < 2px`);
  if (info.clippedBy) problems.push(`ring is clipped by ${info.clippedBy}`);

  // Real pixels: ring colour on each side vs the pixel just outside the ring.
  const pad = 16;
  const vp = page.viewportSize()!;
  const clip = {
    x: Math.max(0, Math.floor(info.rect.x - pad)),
    y: Math.max(0, Math.floor(info.rect.y - pad)),
    width: 0,
    height: 0,
  };
  clip.width = Math.min(vp.width, Math.ceil(info.rect.x + info.rect.w + pad)) - clip.x;
  clip.height = Math.min(vp.height, Math.ceil(info.rect.y + info.rect.h + pad)) - clip.y;
  let minContrast = Infinity;
  let sides = 0;
  if (clip.width > 0 && clip.height > 0 && info.width >= 2 && info.styleName !== 'none') {
    const png = await page.screenshot({ clip, animations: 'disabled' });
    const { x, y, w, h } = info.rect;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const mid = info.offset + info.width / 2;
    // On each side the ring is compared with the pixel in the gap between element and ring and with
    // the pixel just outside the ring. It must stand out from at least one of them: the gap can be
    // the wide active slider dot, the outside can be the neighbouring button, but a ring that matches
    // BOTH (mint on the mint final CTA) is invisible.
    const inner = info.offset / 2;
    const outer = info.offset + info.width + 3;
    const sidesDef = [
      {
        name: 'top',
        ring: { x: cx, y: y - mid },
        a: { x: cx, y: y - inner },
        b: { x: cx, y: y - outer },
      },
      {
        name: 'bottom',
        ring: { x: cx, y: y + h + mid },
        a: { x: cx, y: y + h + inner },
        b: { x: cx, y: y + h + outer },
      },
      {
        name: 'left',
        ring: { x: x - mid, y: cy },
        a: { x: x - inner, y: cy },
        b: { x: x - outer, y: cy },
      },
      {
        name: 'right',
        ring: { x: x + w + mid, y: cy },
        a: { x: x + w + inner, y: cy },
        b: { x: x + w + outer, y: cy },
      },
    ];
    const pts = sidesDef.flatMap((s) => [
      { x: s.ring.x - clip.x, y: s.ring.y - clip.y },
      { x: s.a.x - clip.x, y: s.a.y - clip.y },
      { x: s.b.x - clip.x, y: s.b.y - clip.y },
    ]);
    const px = await pixelAt(helper, png, pts);
    sidesDef.forEach((s, i) => {
      const ringPx = px[i * 3];
      const innerPx = px[i * 3 + 1];
      const outerPx = px[i * 3 + 2];
      if (!ringPx || !innerPx || !outerPx) return; // side is off the screenshot (element at the viewport edge)
      sides++;
      const diff = Math.max(...[0, 1, 2].map((k) => Math.abs(ringPx[k]! - info.colour[k]!)));
      if (diff > 70) {
        problems.push(
          `ring not painted on the ${s.name} side (pixel ${ringPx.join(',')} vs ring ${info.colour.join(',')})`,
        );
        return;
      }
      minContrast = Math.min(
        minContrast,
        Math.max(contrastRatio(ringPx, innerPx), contrastRatio(ringPx, outerPx)),
      );
    });
    if (sides >= 2 && minContrast < 3) {
      problems.push(`ring contrast against its surroundings ${minContrast.toFixed(2)}:1 < 3:1`);
    }
  }
  if (info.paints && info.radiusBefore !== info.radiusAfter) {
    problems.push(`border-radius changes on focus: ${info.radiusBefore} -> ${info.radiusAfter}`);
  }
  return {
    label: info.label,
    outline: info.style,
    focusVisible: info.focusVisible,
    minContrast: Number.isFinite(minContrast) ? minContrast : 0,
    sidesSampled: sides,
    problems,
  };
}
