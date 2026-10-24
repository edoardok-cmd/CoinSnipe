'use client';

import { useEffect, useState } from 'react';
import { finale, stickyCta } from '../../content/marketing';

/**
 * Pure rule for the pill: shown once the hero is fully out of view, hidden again while any part of
 * the final CTA is on screen. Pure so the unit test can pin it.
 */
export function pillVisible(heroGone: boolean, finaleInView: boolean): boolean {
  return heroGone && !finaleInView;
}

/**
 * Sticky "Start for free" pill for the mobile layout (flow map, "Mobile web"). Two
 * IntersectionObservers drive `data-show`; the CSS (tokens.css, `.sticky-cta`) makes it exist only
 * at the burger breakpoint (max-width 980px), animates it, and keeps it invisible (and out of the
 * tab order) while it is not shown. Without IntersectionObserver it simply stays hidden.
 *
 * "The hero" here is the headline block and the Start for free / See top coins buttons docked on
 * the panel edge (`.hero .junction`), not the coin-table panel below them, which sits inside the
 * same <section> but is a separate block of the flow map ("Coin tabs with signals"). The pill takes
 * over exactly when the hero's own button leaves the screen.
 */
export function MobileStickyCta() {
  const [heroGone, setHeroGone] = useState(false);
  const [finaleInView, setFinaleInView] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const hero = document.querySelector('.hero .junction');
    const end = document.getElementById(finale.id);
    const observers: IntersectionObserver[] = [];
    if (hero) {
      const io = new IntersectionObserver(([entry]) => {
        // "out of view" means scrolled past (above the viewport), not merely not intersecting yet
        if (entry) setHeroGone(!entry.isIntersecting && entry.boundingClientRect.bottom <= 0);
      });
      io.observe(hero);
      observers.push(io);
    }
    if (end) {
      const io = new IntersectionObserver(([entry]) => {
        if (entry) setFinaleInView(entry.isIntersecting);
      });
      io.observe(end);
      observers.push(io);
    }
    return () => observers.forEach((o) => o.disconnect());
  }, []);

  return (
    // An aside (complementary landmark) so the link is not stray content outside every landmark.
    <aside
      className="sticky-cta"
      aria-label={stickyCta.landmarkLabel}
      data-show={pillVisible(heroGone, finaleInView) ? 'true' : 'false'}
    >
      <a href={stickyCta.href} className="btn btn-mint">
        {stickyCta.label}
      </a>
    </aside>
  );
}
