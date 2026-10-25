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
import { Change, CoinLogo, LockIcon, Sparkline, StarIcon, TabIcons, TemperaturePill } from './ui';

type TabId = 'coins' | 'niches' | 'gems';

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

/** "Spot the moves that matter": section wrapper (id "signals", the nav's Coin signals link). */
export function CoinTabsSection() {
  return (
    <section className="sec" id="signals" aria-labelledby="moves-title">
      <div className="wrap">
        <div className="head">
          <h2 id="moves-title">{coinTabs.title}</h2>
        </div>
        <div className="moves-panel">
          <CoinTabs />
        </div>
      </div>
    </section>
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
        </div>
      </div>
      <div className="more">
        <a href={coinTabs.moreHref} className="btn btn-glass">
          {coinTabs.moreLabels[tab]}
        </a>
      </div>
    </>
  );
}
