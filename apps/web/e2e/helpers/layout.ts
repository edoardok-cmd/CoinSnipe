import type { Page } from '@playwright/test';

/**
 * In-page layout checks shared by marketing-responsive.spec.ts (CSN-012).
 * Every function passed to page.evaluate is self-contained (no outer-scope references).
 */

export const WIDTHS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
] as const;

export type ViewportDef = (typeof WIDTHS)[number];

/** Sticky pill / burger breakpoint (px). Same number as the `max-width: 980px` media query in tokens.css. */
export const BURGER_MAX = 980;

/** Instant scroll (the page sets scroll-behavior: smooth). */
export async function jumpToY(page: Page, y: number): Promise<void> {
  await page.evaluate((top) => {
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, top);
  }, y);
  await page.waitForTimeout(250);
}

export async function pageHeight(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollHeight);
}

export type OverflowReport = {
  scrollWidth: number;
  bodyScrollWidth: number;
  innerWidth: number;
  /** Elements wider than the viewport that no ancestor below `.cs` clips (`.cs` itself clips, which hides the overflow from scrollWidth). */
  escaping: string[];
};

export async function horizontalOverflow(page: Page): Promise<OverflowReport> {
  return page.evaluate(() => {
    const label = (e: Element) =>
      `${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : ''}`;
    const escaping: string[] = [];
    for (const e of Array.from(document.querySelectorAll('.cs *'))) {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right <= window.innerWidth + 1 && r.left >= -1) continue;
      let a = e.parentElement;
      let protectedByAncestor = false;
      while (a && !a.classList.contains('cs')) {
        if (getComputedStyle(a).overflowX !== 'visible') {
          protectedByAncestor = true;
          break;
        }
        a = a.parentElement;
      }
      if (!protectedByAncestor) {
        escaping.push(`${label(e)} [${Math.round(r.left)}..${Math.round(r.right)}]`);
      }
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      innerWidth: window.innerWidth,
      escaping,
    };
  });
}

export type OverlapIssue = { parent: string; a: string; b: string; area: number };

/**
 * Pairwise rect intersection between the in-flow children of every container on the page.
 *
 * Skipped on purpose (each is an intentional overlay, not a layout box):
 * - invisible boxes (display none, visibility hidden, opacity 0, zero size), e.g. inactive slides
 * - position sticky/fixed boxes (nav, pill, sample badge): they float over content by design
 * - boxes with no text, image, svg or control inside (decorative gradients, grids, glows)
 * - an absolutely positioned box against a sibling svg/img: the radar alerts sit on the radar graphic
 * Everything else, including the absolutely positioned hero "junction" buttons and the radar
 * alerts against each other, must not intersect by more than 1px in both axes.
 */
export async function siblingOverlaps(page: Page): Promise<OverlapIssue[]> {
  return page.evaluate(() => {
    const label = (e: Element) =>
      `${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : ''}`;
    const hasContent = (e: Element) =>
      (e.textContent ?? '').trim().length > 0 ||
      e.matches('img, svg, canvas, button, a, input') ||
      !!e.querySelector('img, svg, canvas, button, a, input');
    const isGraphic = (e: Element) => e.matches('svg, img, canvas');
    const boxOk = (e: Element) => {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.display === 'contents') return false;
      if (cs.visibility !== 'visible') return false;
      if (cs.position === 'sticky' || cs.position === 'fixed') return false;
      let n: Element | null = e;
      while (n) {
        const o = parseFloat(getComputedStyle(n).opacity);
        if (o < 0.05) return false;
        n = n.parentElement;
      }
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      return hasContent(e);
    };
    const issues: { parent: string; a: string; b: string; area: number }[] = [];
    const parents = Array.from(document.querySelectorAll('.cs, .cs *')).filter(
      (p) => p.children.length > 1 && !p.closest('svg'),
    );
    for (const p of parents) {
      const kids = Array.from(p.children).filter(boxOk);
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const a = kids[i]!;
          const b = kids[j]!;
          const pa = getComputedStyle(a).position;
          const pb = getComputedStyle(b).position;
          const abs = (x: string) => x === 'absolute';
          if ((abs(pa) && isGraphic(b)) || (abs(pb) && isGraphic(a))) continue;
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
          const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
          if (w > 1 && h > 1) {
            issues.push({ parent: label(p), a: label(a), b: label(b), area: Math.round(w * h) });
          }
        }
      }
    }
    return issues;
  });
}

export type ClipIssue = { text: string; container: string; by: string; axis: 'x' | 'y' | 'xy' };

/**
 * Text that is cut off. For every text node, find the first ancestor that clips (overflow not
 * visible) and compare the text's own rect with that ancestor's padding box. `ellipsis` truncation
 * (text-overflow: ellipsis) is reported separately: it is a deliberate cut but still hides words.
 *
 * Allowed on purpose: the vertical window of the gems ticker (`.feed`), whose rows scroll through
 * a fixed-height mask by design. Horizontal cuts in the ticker are NOT allowed.
 */
export async function clippedText(
  page: Page,
): Promise<{ clipped: ClipIssue[]; ellipsised: ClipIssue[] }> {
  return page.evaluate(() => {
    const label = (e: Element) =>
      `${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : ''}`;
    const clipped: { text: string; container: string; by: string; axis: 'x' | 'y' | 'xy' }[] = [];
    const ellipsised: { text: string; container: string; by: string; axis: 'x' | 'y' | 'xy' }[] =
      [];
    const walker = document.createTreeWalker(document.querySelector('.cs')!, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = (node.textContent ?? '').trim();
      if (!text) continue;
      const el = node.parentElement!;
      if (el.closest('.sr-only, svg, [hidden]')) continue;
      let hiddenByOpacity = false;
      for (let n: Element | null = el; n; n = n.parentElement) {
        if (parseFloat(getComputedStyle(n).opacity) < 0.05) hiddenByOpacity = true;
      }
      const cs = getComputedStyle(el);
      if (hiddenByOpacity || cs.display === 'none' || cs.visibility !== 'visible') continue;
      if (!el.checkVisibility({ contentVisibilityAuto: true })) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      if (!rects.length) continue;
      let a: Element | null = el;
      while (a && !a.classList.contains('cs')) {
        const acs = getComputedStyle(a);
        if (acs.overflowX !== 'visible' || acs.overflowY !== 'visible') {
          const ar = a.getBoundingClientRect();
          const box = {
            l: ar.left + parseFloat(acs.borderLeftWidth),
            r: ar.right - parseFloat(acs.borderRightWidth),
            t: ar.top + parseFloat(acs.borderTopWidth),
            b: ar.bottom - parseFloat(acs.borderBottomWidth),
          };
          const outX = rects.some((r) => r.left < box.l - 1 || r.right > box.r + 1);
          const outY = rects.some((r) => r.top < box.t - 1 || r.bottom > box.b + 1);
          const axis = outX && outY ? 'xy' : outX ? 'x' : 'y';
          const tickerWindow = a.classList.contains('feed') && axis === 'y';
          if ((outX || outY) && !tickerWindow) {
            const item = {
              text: text.slice(0, 60),
              container: label(el),
              by: label(a),
              axis,
            } as const;
            const ell = acs.textOverflow === 'ellipsis' || cs.textOverflow === 'ellipsis';
            (ell ? ellipsised : clipped).push(item);
          }
          if (outX || outY) break; // the first clipping ancestor is the one that cuts it
        }
        a = a.parentElement;
      }
    }
    return { clipped, ellipsised };
  });
}

export type CollisionIssue = { a: string; b: string; area: number };

/**
 * Visible text that lands on other visible text. Each text node's rect is first cut down to what
 * the clipping ancestors let through (so ticker rows and scrolled tab rows do not count), then
 * every pair of text nodes from different elements is intersected. Text inside the floating
 * overlays (sticky nav, sticky pill, sample badge) is left out: they sit over content by design
 * and have their own checks.
 */
export async function textCollisions(page: Page): Promise<CollisionIssue[]> {
  return page.evaluate(() => {
    const label = (e: Element) =>
      `${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : ''}`;
    type R = { l: number; r: number; t: number; b: number };
    const items: { el: Element; text: string; rect: R }[] = [];
    const walker = document.createTreeWalker(document.querySelector('.cs')!, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = (node.textContent ?? '').trim();
      if (!text) continue;
      const el = node.parentElement!;
      if (el.closest('.sr-only, svg, [hidden], .nav-wrap, .sticky-cta, .sample-badge')) continue;
      let invisible = false;
      for (let n: Element | null = el; n; n = n.parentElement) {
        if (parseFloat(getComputedStyle(n).opacity) < 0.05) invisible = true;
      }
      const cs = getComputedStyle(el);
      if (invisible || cs.display === 'none' || cs.visibility !== 'visible') continue;
      if (!el.checkVisibility({ contentVisibilityAuto: true })) continue; // e.g. a closed <details>
      // A text rect is the font box, taller than the line box when line-height < 1.2. Use the line box
      // so two lines of one heading do not "overlap".
      const fs = parseFloat(cs.fontSize);
      const lh = cs.lineHeight === 'normal' ? fs * 1.2 : parseFloat(cs.lineHeight);
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rr of Array.from(range.getClientRects())) {
        if (rr.width < 1 || rr.height < 1) continue;
        const h = Math.min(rr.height, lh);
        const mid = (rr.top + rr.bottom) / 2;
        const rect: R = { l: rr.left, r: rr.right, t: mid - h / 2, b: mid + h / 2 };
        // cut to the clipping ancestors
        for (let a: Element | null = el; a && !a.classList.contains('cs'); a = a.parentElement) {
          const acs = getComputedStyle(a);
          if (acs.overflowX !== 'visible' || acs.overflowY !== 'visible') {
            const ar = a.getBoundingClientRect();
            rect.l = Math.max(rect.l, ar.left);
            rect.r = Math.min(rect.r, ar.right);
            rect.t = Math.max(rect.t, ar.top);
            rect.b = Math.min(rect.b, ar.bottom);
          }
        }
        if (rect.r - rect.l > 1 && rect.b - rect.t > 1) items.push({ el, text, rect });
      }
    }
    const out: { a: string; b: string; area: number }[] = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const A = items[i]!;
        const B = items[j]!;
        if (A.el === B.el) continue;
        const w = Math.min(A.rect.r, B.rect.r) - Math.max(A.rect.l, B.rect.l);
        const h = Math.min(A.rect.b, B.rect.b) - Math.max(A.rect.t, B.rect.t);
        if (w > 1 && h > 1) {
          out.push({
            a: `${label(A.el)} "${A.text.slice(0, 24)}"`,
            b: `${label(B.el)} "${B.text.slice(0, 24)}"`,
            area: Math.round(w * h),
          });
        }
      }
    }
    return out;
  });
}
