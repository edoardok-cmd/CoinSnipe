'use client';

import { useEffect, useRef, useState } from 'react';
import { SAMPLE_STATS, signalFlow } from '../../content/marketing';
import { FeatureIcons } from './ui';

/** Auto-advance interval of the feature slider, in ms. */
export const SLIDE_MS = 4000;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return reduced;
}

/** Next slide index, wrapping. Pure so the unit test can pin it. */
export function nextSlide(index: number, count: number): number {
  return (index + 1) % count;
}

/**
 * Number on screen for a stat. `progress` is null until the count-up starts (and always under
 * reduced motion), and then the real number stays untouched; no zero is ever shown beforehand.
 */
export function displayValue(value: number, progress: number | null): number {
  if (progress === null) return value;
  return Math.round(value * (1 - Math.pow(1 - Math.min(1, Math.max(0, progress)), 3)));
}

/** The server render shows the final number; it only counts up once the tile is in view. */
function CountStat({ value, suffix, label }: { value: number; suffix: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const reduced = usePrefersReducedMotion();
  const shown = displayValue(value, reduced ? null : progress);

  useEffect(() => {
    const el = ref.current;
    if (!el || reduced || value === 0 || typeof IntersectionObserver === 'undefined') return;
    let raf = 0;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        const start = performance.now();
        const duration = 900;
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / duration);
          setProgress(t);
          if (t < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [value, reduced]);

  return (
    <div className="card stat" ref={ref}>
      <b className="grad">
        <span aria-hidden="true">
          {shown}
          {suffix}
        </span>
        <span className="sr-only">
          {value}
          {suffix}
        </span>
      </b>
      <span>{label}</span>
    </div>
  );
}

function FeatureSlider() {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduced = usePrefersReducedMotion();
  const count = signalFlow.slides.length;

  /* Auto-advance, but never while the pointer or keyboard focus is inside, and never under
     prefers-reduced-motion. Picking a dot restarts the timer because `index` changes. */
  useEffect(() => {
    if (paused || reduced) return;
    const t = setTimeout(() => setIndex((i) => nextSlide(i, count)), SLIDE_MS);
    return () => clearTimeout(t);
  }, [index, paused, reduced, count]);

  const autoplay = !paused && !reduced;

  return (
    <div
      className="card fcard"
      role="group"
      aria-roledescription="carousel"
      aria-label={signalFlow.sliderLabel}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setPaused(false);
      }}
    >
      <div className="fslides" aria-live={autoplay ? 'off' : 'polite'}>
        {signalFlow.slides.map((s, i) => {
          const Icon = FeatureIcons[s.id as keyof typeof FeatureIcons];
          const on = i === index;
          return (
            <div
              key={s.id}
              className="fslide"
              role="group"
              aria-roledescription="slide"
              aria-label={`${i + 1} of ${count}`}
              aria-hidden={on ? undefined : true}
              data-on={on ? 'true' : 'false'}
            >
              <h3>
                <Icon />
                <span>{s.title}</span>
              </h3>
              <p>{s.body}</p>
            </div>
          );
        })}
      </div>
      <div className="fdots">
        {signalFlow.slides.map((s, i) => (
          <button
            key={s.id}
            type="button"
            aria-label={`${signalFlow.slideDotLabel} ${i + 1}: ${s.title}`}
            aria-current={i === index ? 'true' : undefined}
            onClick={() => setIndex(i)}
          />
        ))}
      </div>
    </div>
  );
}

export function SignalFlow() {
  return (
    <section className="block feat-sec" aria-labelledby="flow-title">
      <div className="wrap">
        <div className="head">
          <h2 id="flow-title">
            {signalFlow.titleLead} <span className="grad">{signalFlow.titleAccent}</span>
          </h2>
          <p>{signalFlow.subline}</p>
        </div>
        <div className="stats">
          {SAMPLE_STATS.map((s, i) => (
            <CountStat
              key={`stat-${i}`}
              value={s.value}
              suffix={s.suffix}
              label={signalFlow.statLabels[i] ?? ''}
            />
          ))}
          <FeatureSlider />
        </div>
      </div>
    </section>
  );
}
