'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { nav } from '../../content/marketing';
import { CloseIcon, Logogram, MenuIcon } from './ui';

/** Distance from the top of the viewport at which a section counts as "reached". */
/** A section counts as reached once its top passes this share of the viewport height. */
export const SPY_SHARE = 0.45;
/** Same line in px for a viewport height. */
export const spyLine = (viewportHeight: number): number => viewportHeight * SPY_SHARE;

/**
 * Which link is active: the last link whose section top is above the line (see spyLine).
 * Pure so the unit test can pin it. Returns -1 above the first section.
 */
export function activeIndex(tops: (number | null)[], line: number): number {
  let active = -1;
  tops.forEach((top, i) => {
    if (top !== null && top <= line) active = i;
  });
  return active;
}

export function Nav() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLSpanElement>(null);

  /* Section dots: one 1px sentinel per section, watched by an IntersectionObserver whose root is
     shifted down by SPY_SHARE of the viewport. A sentinel changes state exactly when its section crosses the line. */
  useEffect(() => {
    const sentinels: (HTMLElement | null)[] = nav.links.map((link) => {
      const target = document.getElementById(link.href.slice(1));
      if (!target) return null;
      const s = document.createElement('span');
      s.setAttribute('aria-hidden', 'true');
      s.dataset.spySentinel = link.href;
      s.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;pointer-events:none';
      target.insertBefore(s, target.firstChild);
      return s;
    });
    const evaluate = () =>
      setActive(
        activeIndex(
          sentinels.map((s) => (s ? s.getBoundingClientRect().top : null)),
          spyLine(window.innerHeight),
        ),
      );
    const io = new IntersectionObserver(evaluate, {
      rootMargin: `-${SPY_SHARE * 100}% 0px 0px 0px`,
      threshold: [0, 1],
    });
    sentinels.forEach((s) => s && io.observe(s));
    // The observer only fires when a sentinel crosses the line, so a jump that skips past a
    // section (an anchor or a scrollTo) would leave the highlight stale. Re-check on every scroll.
    window.addEventListener('scroll', evaluate, { passive: true });
    evaluate();
    return () => {
      io.disconnect();
      window.removeEventListener('scroll', evaluate);
      sentinels.forEach((s) => s?.remove());
    };
  }, []);

  /* Mint progress line along the bottom of the bar: scroll progress, written straight to a CSS
     variable so scrolling never re-renders React. */
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const doc = document.documentElement;
      const pct = Math.max(
        0,
        Math.min(100, (window.scrollY / Math.max(1, doc.scrollHeight - window.innerHeight)) * 100),
      );
      progressRef.current?.style.setProperty('--cs-progress', pct.toFixed(2));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  /* The burger only exists below 980px: close the panel if the viewport grows past it. */
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 981px)');
    const onChange = () => mq.matches && setOpen(false);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('a')?.focus();
  }, [open]);

  /* Escape closes; Tab is trapped between the burger and the menu links while the panel is open. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [
      buttonRef.current,
      ...Array.from(menuRef.current?.querySelectorAll<HTMLElement>('a[href]') ?? []),
    ].filter((el): el is HTMLElement => el !== null);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const current = document.activeElement;
    if (e.shiftKey && current === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && current === last) {
      e.preventDefault();
      first.focus();
    } else if (!items.includes(current as HTMLElement)) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="nav-wrap" onKeyDown={onKeyDown}>
      <nav className="nav" aria-label="Main">
        <span className="nav-prog" ref={progressRef} aria-hidden="true" />
        <a href="#top" className="brand" aria-label={nav.homeLabel}>
          <Logogram size={26} />
          CoinSnipe
        </a>
        <div className="navspy">
          {nav.links.map((link, i) => (
            <a
              key={link.href}
              href={link.href}
              aria-current={active === i ? 'true' : undefined}
              data-spy-link={link.href}
            >
              <i aria-hidden="true" />
              {link.label}
            </a>
          ))}
        </div>
        <div className="nav-actions">
          <a href={nav.login.href} className="btn btn-glass hide-m">
            {nav.login.label}
          </a>
          <a href={nav.cta.href} className="btn btn-mint">
            {nav.cta.label}
          </a>
          <button
            type="button"
            ref={buttonRef}
            className="menu-btn"
            aria-label={open ? nav.closeMenuLabel : nav.openMenuLabel}
            aria-expanded={open}
            aria-controls="mnav"
            onClick={() => (open ? close(false) : setOpen(true))}
          >
            {open ? <CloseIcon /> : <MenuIcon />}
          </button>
        </div>
      </nav>
      <nav
        id="mnav"
        ref={menuRef}
        className="mnav"
        data-open={open ? 'true' : 'false'}
        aria-label={nav.menuLabel}
      >
        {nav.links.map((link) => (
          <a key={link.href} href={link.href} onClick={() => close(false)}>
            {link.label}
          </a>
        ))}
        <a href={nav.login.href} onClick={() => close(false)}>
          {nav.login.label}
        </a>
      </nav>
    </div>
  );
}
