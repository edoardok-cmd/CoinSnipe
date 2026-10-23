'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  SAMPLE_GEM_FEED,
  SAMPLE_PORTFOLIO,
  SAMPLE_STORY_NICHES,
  story,
} from '../../content/marketing';
import { ArrowRight, CheckIcon, CoinLogo, Sparkline, TemperaturePill } from './ui';

/** Auto-rotate interval of the niches card, in ms. */
export const NICHE_MS = 4200;

/**
 * Which story step is "current": the first step whose last element still ends below the reading
 * line (the larger of 190px and 26% of the viewport). Pure so the unit test can pin it.
 */
export function activeStep(bottoms: number[], viewportHeight: number): number {
  const line = Math.max(190, viewportHeight * 0.26);
  const found = bottoms.findIndex((b) => b > line);
  return found === -1 ? Math.max(0, bottoms.length - 1) : found;
}

function useReducedMotion(): boolean {
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

function NichesCard({ on }: { on: boolean }) {
  const uid = useId();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduced = useReducedMotion();
  const count = SAMPLE_STORY_NICHES.length;
  const m = story.markets;

  useEffect(() => {
    if (paused || reduced || !on) return;
    const t = setTimeout(() => setIndex((i) => (i + 1) % count), NICHE_MS);
    return () => clearTimeout(t);
  }, [index, paused, reduced, on, count]);

  return (
    <div
      className="mock nfocus"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setPaused(false);
      }}
    >
      <div className="ntabs">
        <div className="ntablist" role="tablist" aria-label={m.cardTabsLabel}>
          {SAMPLE_STORY_NICHES.map((n, i) => (
            <button
              key={n.tab}
              id={`${uid}-t${i}`}
              type="button"
              role="tab"
              className="ntab"
              aria-selected={i === index}
              aria-controls={`${uid}-p${i}`}
              tabIndex={i === index ? 0 : -1}
              onClick={() => setIndex(i)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                e.preventDefault();
                const next = (i + (e.key === 'ArrowRight' ? 1 : count - 1)) % count;
                setIndex(next);
                document.getElementById(`${uid}-t${next}`)?.focus();
              }}
            >
              {n.tab}
            </button>
          ))}
        </div>
        <a href={m.cardCta.href} className="ntab-cta">
          {m.cardCta.label}
          <ArrowRight size={14} />
        </a>
      </div>
      <div className="nf-body">
        {SAMPLE_STORY_NICHES.map((n, i) => {
          const up = n.change >= 0;
          return (
            <div
              key={n.tab}
              id={`${uid}-p${i}`}
              role="tabpanel"
              aria-labelledby={`${uid}-t${i}`}
              className="npanel"
              hidden={i !== index}
              data-on={i === index ? 'true' : 'false'}
            >
              <div className="nf-head">
                <div>
                  <div className="nf-name">{n.name}</div>
                  <div className="nf-cnt">
                    {n.projects} {m.projectsSuffix}
                  </div>
                </div>
                <span className={`nf-pill ${up ? 'up' : 'down'}`}>{m.window}</span>
              </div>
              <div className={`nf-val ${up ? 'up' : 'down'}`}>
                <span aria-hidden="true" style={{ fontSize: '0.6em' }}>
                  {up ? '▲' : '▼'}
                </span>
                <span className="sr-only">{up ? 'Up ' : 'Down '}</span>
                {Math.abs(n.change).toFixed(1)}%
              </div>
              <Sparkline
                className="nf-chart"
                values={n.spark}
                up={up}
                width={400}
                height={118}
                strokeWidth={2.2}
                area
              />
              <div className="nf-lead">{m.leading}</div>
              <div className="nf-projs">
                {n.leaders.map((l) => (
                  <span className="nproj" key={l.symbol}>
                    <CoinLogo symbol={l.symbol} name={l.name} size={30} />
                    <span>{l.name}</span>
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GemsCard() {
  const g = story.gems;
  const rows = [...SAMPLE_GEM_FEED, ...SAMPLE_GEM_FEED];
  return (
    <div className="mock" style={{ background: 'linear-gradient(180deg, #0A1715, #07110E)' }}>
      <div className="nf-head">
        <div>
          <div className="nf-name">{g.cardTitle}</div>
          <div className="nf-cnt">{g.cardSub}</div>
        </div>
        <span className="nf-pill up">{g.found}</span>
      </div>
      <div className="feed">
        <div className="feed-track">
          {rows.map((r, i) => (
            <div
              className="gem"
              key={`${r.symbol}-${i}`}
              aria-hidden={i >= SAMPLE_GEM_FEED.length ? true : undefined}
            >
              <span className="coin">
                <CoinLogo symbol={r.symbol} name={r.name} size={34} />
                <span style={{ minWidth: 0 }}>
                  <span className="cname" style={{ fontSize: 15 }}>
                    {r.name}
                  </span>
                  <span className="why">{r.why}</span>
                </span>
              </span>
              <span className="kv">
                <span>{r.a.label}</span>
                <b>{r.a.value}</b>
              </span>
              <span className="kv">
                <span>{r.b.label}</span>
                <b>{r.b.value}</b>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PortfolioCard() {
  const p = SAMPLE_PORTFOLIO;
  const labels = story.portfolio.seasonLabels;
  const [a, b, c] = p.seasonShares;
  return (
    <div className="mock">
      <div className="pf-top">
        <div>
          <div style={{ fontSize: 13, color: 'var(--cs-dim)' }}>
            {story.portfolio.cardValueLabel}
          </div>
          <div className="pf-val">{p.value}</div>
          <div style={{ fontSize: 14, color: 'var(--cs-up)', fontWeight: 600 }}>{p.change}</div>
        </div>
        <Sparkline values={[...p.spark]} up width={140} height={52} strokeWidth={2} />
      </div>
      <div
        className="pf-bar"
        role="img"
        aria-label={`${a}% ${labels[0]}, ${b}% ${labels[1]}, ${c}% ${labels[2]}`}
      >
        <span style={{ flex: a, background: 'var(--cs-mint)' }} />
        <span style={{ flex: b, background: 'rgba(61,245,180,.35)' }} />
        <span style={{ flex: c, background: '#1F2E2B' }} />
      </div>
      <div className="pf-legend" aria-hidden="true">
        <span>
          {a}% {labels[0]}
        </span>
        <span>
          {b}% {labels[1]}
        </span>
        <span>
          {c}% {labels[2]}
        </span>
      </div>
      <div style={{ marginTop: 10 }}>
        {p.holdings.map((h) => (
          <div className="hold" key={h.name}>
            <span className="coin">
              <CoinLogo symbol={h.symbol} name={h.name} size={30} />
              <span>
                <span style={{ display: 'block', fontWeight: 600, fontSize: 14 }}>{h.name}</span>
                <span style={{ fontSize: 12, color: 'var(--cs-dim)' }}>{h.amount}</span>
              </span>
            </span>
            <span className="r" style={{ fontWeight: 600, fontSize: 14 }}>
              {h.value}
            </span>
            <span className="r">
              <TemperaturePill value={h.temperature} fill={h.gauge} wide />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Story() {
  const [active, setActive] = useState(0);
  const storyRef = useRef<HTMLDivElement>(null);

  /* Swap the pinned card when the previous text has left the reading zone. */
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const steps = Array.from(storyRef.current?.querySelectorAll<HTMLElement>('.step') ?? []);
      const bottoms = steps.map((el) => (el.lastElementChild ?? el).getBoundingClientRect().bottom);
      setActive(activeStep(bottoms, window.innerHeight));
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

  const m = story.markets;
  const g = story.gems;
  const p = story.portfolio;

  return (
    <div className="wrap">
      <div className="story" ref={storyRef}>
        <div className="step r0" id={m.id} data-on={active === 0 ? 'true' : 'false'}>
          <h2>{m.title}</h2>
          <p>{m.body}</p>
          <a href={m.cta.href} className="link">
            {m.cta.label}
            <ArrowRight />
          </a>
        </div>
        <div className="sv" data-on={active === 0 ? 'true' : 'false'}>
          <NichesCard on={active === 0} />
        </div>
        <div className="step r1" id={g.id} data-on={active === 1 ? 'true' : 'false'}>
          <h2>{g.title}</h2>
          <p>{g.body}</p>
          <a href={g.cta.href} className="link">
            {g.cta.label}
            <ArrowRight />
          </a>
        </div>
        <div className="sv" data-on={active === 1 ? 'true' : 'false'}>
          <GemsCard />
        </div>
        <div className="step r2" id={p.id} data-on={active === 2 ? 'true' : 'false'}>
          <h2>{p.title}</h2>
          <p>{p.body}</p>
          <div className="checks">
            {p.checks.map((c) => (
              <div key={c}>
                <CheckIcon />
                {c}
              </div>
            ))}
          </div>
          <a href={p.cta.href} className="link">
            {p.cta.label}
            <ArrowRight />
          </a>
        </div>
        <div className="sv" data-on={active === 2 ? 'true' : 'false'}>
          <PortfolioCard />
        </div>
      </div>
    </div>
  );
}
