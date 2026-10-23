'use client';

import { useId, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  SAMPLE_COINS,
  SAMPLE_GEMS,
  SAMPLE_NICHES,
  coinTabs,
  signalConfig,
} from '../../content/marketing';
import type { Momentum } from '../../content/marketing';
import {
  BellIcon,
  Change,
  CheckIcon,
  CoinLogo,
  LockIcon,
  Sparkline,
  StarIcon,
  TabIcons,
  TemperaturePill,
} from './ui';

type TabId = 'coins' | 'niches' | 'gems' | 'portfolio';

/** Rows of the three tables are SAMPLE data until CSN-043. The favourite star is local state only. */
function Star({ label, name }: { label: string; name: string }) {
  const [on, setOn] = useState(false);
  return (
    <button
      type="button"
      className="star"
      aria-label={`${label}: ${name}`}
      aria-pressed={on}
      onClick={() => setOn((v) => !v)}
    >
      <StarIcon />
    </button>
  );
}

/** Niche momentum: a plain text pill, as on the canvas (no gauge). */
function MomentumPill({ value }: { value: Momentum }) {
  const tone = value === 'Heating up' ? 'heated' : value === 'Cooling down' ? 'cooled' : '';
  return <span className={`sig sig-wide ${tone}`}>{value}</span>;
}

function CoinsTable() {
  const v03 = signalConfig.showV03Signals;
  const h = coinTabs.coinsHead;
  return (
    <div role="table" aria-label="Top coins (sample data)">
      <div role="row" className={`lhead${v03 ? ' v03' : ''}`}>
        <span role="columnheader">
          <span className="sr-only">Favorite</span>
        </span>
        <span role="columnheader">#</span>
        <span role="columnheader">{h.name}</span>
        <span role="columnheader" className="r">
          {h.price}
        </span>
        <span role="columnheader" className="r">
          {h.change}
        </span>
        <span role="columnheader">{h.signal}</span>
        {v03 ? <span role="columnheader">{coinTabs.coinsQuadrantHead}</span> : null}
        <span role="columnheader" className="r">
          {h.week}
        </span>
      </div>
      {SAMPLE_COINS.map((c) => (
        <div role="row" className={`lrow${v03 ? ' v03' : ''}`} key={c.symbol}>
          <span role="cell" className="h-m">
            <Star label={coinTabs.favoriteLabel} name={c.name} />
          </span>
          <span role="cell" className="h-m" style={{ color: 'var(--cs-muted)' }}>
            {c.rank}
          </span>
          <span role="cell" className="coin">
            <CoinLogo symbol={c.symbol} name={c.name} />
            <span style={{ minWidth: 0 }}>
              <span className="cname">{c.name}</span>
              <span className="only-m" style={{ marginTop: 4 }}>
                <TemperaturePill value={c.temperature} fill={c.gauge} />
              </span>
            </span>
            <span className="csym h-m">{c.symbol}</span>
          </span>
          <span role="cell" className="r h-m" style={{ fontWeight: 600 }}>
            {c.price}
          </span>
          <span role="cell" className="r h-m">
            <Change value={c.change} />
          </span>
          <span role="cell" className="h-m">
            <TemperaturePill value={c.temperature} fill={c.gauge} wide />
          </span>
          {v03 ? (
            <span role="cell" className="h-m quad">
              {c.quadrant}
            </span>
          ) : null}
          <span role="cell" className="rr">
            <Sparkline values={c.spark} up={c.change >= 0} />
          </span>
          <span role="cell" className="mcol only-m">
            <b style={{ fontWeight: 600, fontSize: 14 }}>{c.price}</b>
            <Change value={c.change} />
          </span>
        </div>
      ))}
    </div>
  );
}

function NichesTable() {
  const h = coinTabs.nichesHead;
  return (
    <div role="table" aria-label="Top niches (sample data)">
      <div role="row" className="lhead">
        <span role="columnheader">
          <span className="sr-only">Favorite</span>
        </span>
        <span role="columnheader">#</span>
        <span role="columnheader">{h.name}</span>
        <span role="columnheader" className="r">
          {h.leaders}
        </span>
        <span role="columnheader" className="r">
          {h.change}
        </span>
        <span role="columnheader">{h.signal}</span>
        <span role="columnheader" className="r">
          {h.week}
        </span>
      </div>
      {SAMPLE_NICHES.map((n) => (
        <div role="row" className="lrow" key={n.name}>
          <span role="cell" className="h-m">
            <Star label={coinTabs.favoriteLabel} name={n.name} />
          </span>
          <span role="cell" className="h-m" style={{ color: 'var(--cs-muted)' }}>
            {n.rank}
          </span>
          <span role="cell" className="coin">
            <span style={{ minWidth: 0 }}>
              <span className="cname">{n.name}</span>
              <span className="csym">{n.projects} projects</span>
            </span>
          </span>
          <span role="cell" className="r h-m stack">
            {n.leaders.map((s) => (
              <CoinLogo key={s} symbol={s} name={s} size={30} />
            ))}
          </span>
          <span role="cell" className="r h-m">
            <Change value={n.change} />
          </span>
          <span role="cell" className="h-m">
            <MomentumPill value={n.momentum} />
          </span>
          <span role="cell" className="rr">
            <Sparkline values={n.spark} up={n.change >= 0} />
          </span>
          <span role="cell" className="mcol only-m">
            <MomentumPill value={n.momentum} />
            <Change value={n.change} />
          </span>
        </div>
      ))}
    </div>
  );
}

function GemsTable() {
  const h = coinTabs.gemsHead;
  return (
    <div>
      <div role="table" aria-label="Hidden gems (sample data)">
        <div role="row" className="lhead">
          <span role="columnheader">
            <span className="sr-only">Favorite</span>
          </span>
          <span role="columnheader">#</span>
          <span role="columnheader">{h.name}</span>
          <span role="columnheader" className="r">
            {h.price}
          </span>
          <span role="columnheader" className="r">
            {h.change}
          </span>
          <span role="columnheader">{h.why}</span>
          <span role="columnheader" className="r">
            {h.week}
          </span>
        </div>
        {SAMPLE_GEMS.map((g) => (
          <div role="row" className="lrow" key={g.symbol}>
            <span role="cell" className="h-m">
              <Star label={coinTabs.favoriteLabel} name={g.name} />
            </span>
            <span role="cell" className="h-m" style={{ color: 'var(--cs-muted)' }}>
              {g.rank}
            </span>
            <span role="cell" className="coin">
              <CoinLogo symbol={g.symbol} name={g.name} />
              <span style={{ minWidth: 0 }}>
                <span className="cname">{g.name}</span>
                <span className="why only-m">{g.why}</span>
              </span>
              <span className="csym h-m">{g.ticker}</span>
            </span>
            <span role="cell" className="r h-m" style={{ fontWeight: 600 }}>
              {g.price}
            </span>
            <span role="cell" className="r h-m">
              <Change value={g.change} />
            </span>
            <span role="cell" className="h-m why-col">
              {g.why}
            </span>
            <span role="cell" className="rr">
              <Sparkline values={g.spark} up={g.change >= 0} />
            </span>
            <span role="cell" className="mcol only-m">
              <b style={{ fontWeight: 600, fontSize: 14 }}>{g.price}</b>
              <Change value={g.change} />
            </span>
          </div>
        ))}
      </div>
      <div className="lock">
        <span className="lk">
          <LockIcon />
          {coinTabs.gemsLock.text}
        </span>
        <a className="btn btn-mint" href={coinTabs.gemsLock.href}>
          {coinTabs.gemsLock.cta}
        </a>
      </div>
    </div>
  );
}

function Radar() {
  const r = coinTabs.radar;
  return (
    <div className="radarbox">
      <div className="radar">
        <svg viewBox="0 0 260 260" role="img" aria-label="Radar graphic with three sample alerts">
          <defs>
            <radialGradient id="radar-fill" cx="50%" cy="50%" r="50%">
              <stop offset="0" stopColor="#3DF5B4" stopOpacity="0.16" />
              <stop offset="1" stopColor="#3DF5B4" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="radar-sweep" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#3DF5B4" stopOpacity="0" />
              <stop offset="1" stopColor="#3DF5B4" stopOpacity="0.5" />
            </linearGradient>
          </defs>
          <circle cx="130" cy="130" r="124" fill="url(#radar-fill)" />
          {[40, 80, 120].map((rad) => (
            <circle
              key={rad}
              cx="130"
              cy="130"
              r={rad}
              fill="none"
              stroke="rgba(255,255,255,.1)"
              strokeWidth="1"
            />
          ))}
          <path d="M130 6v248M6 130h248" stroke="rgba(255,255,255,.07)" strokeWidth="1" />
          <g className="sweep">
            <path d="M130 130 L130 8 A122 122 0 0 1 216 44 Z" fill="url(#radar-sweep)" />
          </g>
          <circle cx="130" cy="130" r="4" fill="#3DF5B4" />
          <rect x="176" y="168" width="12" height="12" rx="3" fill="#FF8A5B" />
          <rect x="72" y="182" width="12" height="12" rx="3" fill="#5CB2F2" />
          <rect x="88" y="70" width="12" height="12" rx="3" fill="#E7C35A" />
        </svg>
        {r.alerts.map((a, i) => {
          return (
            <span className={`alert a${i + 1} a-${a.kind}`} key={a.kind}>
              <BellIcon />
              {'leadFirst' in a ? (
                <>
                  {a.lead}&nbsp;<b style={{ fontWeight: 600 }}>{a.tail}</b>
                </>
              ) : (
                <>
                  <b style={{ fontWeight: 600 }}>{a.lead}</b>
                  {a.tail}
                </>
              )}
            </span>
          );
        })}
      </div>
      <div>
        <span className="tag-s" style={{ fontSize: 12, padding: '4px 10px' }}>
          {r.tag}
        </span>
        <h3 style={{ fontSize: 'clamp(28px,3vw,38px)', marginTop: 14, lineHeight: 1.1 }}>
          {r.title}
        </h3>
        <p style={{ marginTop: 14, fontSize: 17, color: 'var(--cs-muted)', lineHeight: 1.6 }}>
          {r.body}
        </p>
        <div className="checks">
          {r.checks.map((c) => (
            <div key={c}>
              <CheckIcon />
              {c}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 26, flexWrap: 'wrap' }}>
          <a href={r.primaryCta.href} className="btn btn-mint">
            {r.primaryCta.label}
          </a>
          <a href={r.secondaryCta.href} className="btn btn-glass">
            {r.secondaryCta.label}
          </a>
        </div>
        <p style={{ marginTop: 12, fontSize: 13, color: 'var(--cs-dim)' }}>{r.note}</p>
      </div>
    </div>
  );
}

export function CoinTabs() {
  const [tab, setTab] = useState<TabId>('coins');
  const uid = useId();
  const tabs = coinTabs.tabs;
  const ids = tabs.map((t) => t.id as TabId);

  /* Roving tabindex with arrow keys, Home and End (WAI-ARIA tabs pattern). */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = ids.indexOf(tab);
    let next: number;
    if (e.key === 'ArrowRight') next = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    else return;
    e.preventDefault();
    const target = ids[next] ?? 'coins';
    setTab(target);
    document.getElementById(`${uid}-tab-${target}`)?.focus();
  };

  return (
    <>
      <div className="tabs" role="tablist" aria-label={coinTabs.ariaLabel} onKeyDown={onKeyDown}>
        {tabs.map((t) => {
          const Icon = TabIcons[t.id as TabId];
          const selected = tab === t.id;
          return (
            <button
              key={t.id}
              id={`${uid}-tab-${t.id}`}
              type="button"
              role="tab"
              className="tab"
              aria-selected={selected}
              aria-controls={`${uid}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(t.id as TabId)}
            >
              <Icon />
              {t.label}
              {'tag' in t ? <span className="tag-s">{t.tag}</span> : null}
            </button>
          );
        })}
      </div>
      <div
        className="listpanel"
        id={`${uid}-panel`}
        role="tabpanel"
        aria-labelledby={`${uid}-tab-${tab}`}
        tabIndex={0}
      >
        <div className="fade-in" key={tab}>
          {tab === 'coins' ? <CoinsTable /> : null}
          {tab === 'niches' ? <NichesTable /> : null}
          {tab === 'gems' ? <GemsTable /> : null}
          {tab === 'portfolio' ? <Radar /> : null}
        </div>
      </div>
      {tab !== 'portfolio' ? (
        <div className="more">
          <a href={coinTabs.moreHref} className="btn btn-glass">
            {coinTabs.moreLabels[tab]}
          </a>
        </div>
      ) : null}
    </>
  );
}
