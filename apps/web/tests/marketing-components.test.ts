import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CoinTabs } from '../components/marketing/CoinTabs';
import { Faq } from '../components/marketing/Faq';
import { Finale } from '../components/marketing/Finale';
import { Footer } from '../components/marketing/Footer';
import { Hero } from '../components/marketing/Hero';
import { MobileStickyCta, pillVisible } from '../components/marketing/MobileStickyCta';
import { activeIndex, spyLine } from '../components/marketing/Nav';
import { Nav } from '../components/marketing/Nav';
import { Pillars } from '../components/marketing/Pillars';
import { Pricing } from '../components/marketing/Pricing';
import { SampleBadge } from '../components/marketing/SampleBadge';
import { SignalFlow, displayValue, nextSlide } from '../components/marketing/SignalFlow';
import { Story, activeStep } from '../components/marketing/Story';
import { Change, Sparkline, TemperaturePill } from '../components/marketing/ui';

const html = (c: Parameters<typeof createElement>[0]) => renderToStaticMarkup(createElement(c));

describe('marketing components render', () => {
  it('Nav: four section links, burger with aria state, mint progress line', () => {
    const out = html(Nav);
    expect(out).toContain('href="#signals"');
    expect(out).toContain('href="#trends"');
    expect(out).toContain('href="#portfolio"');
    expect(out).toContain('href="#pricing"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('aria-controls="mnav"');
    expect(out).toContain('class="nav-prog"');
    expect(out).toContain('Log in');
    expect(out).toContain('Start for free');
  });

  it('Hero: headline, two docked buttons, both partner logos', () => {
    const out = html(Hero);
    expect(out).toContain('Invest in crypto?');
    expect(out).toContain('Know what you buy.');
    expect(out).toContain('class="junction"');
    expect(out).toContain('See top coins');
    expect(out).toContain('alt="DefiLlama"');
    expect(out).toContain('alt="CoinGecko"');
  });

  it('CoinTabs: four tabs, first selected, coin rows render', () => {
    const out = html(CoinTabs);
    expect((out.match(/role="tab"/g) ?? []).length).toBe(4);
    expect(out).toContain('aria-selected="true"');
    expect(out).toContain('Bitcoin');
    expect(out).toContain('Smart signal');
  });

  it('SignalFlow: four stats and four slides with dots', () => {
    const out = html(SignalFlow);
    expect((out.match(/class="card stat"/g) ?? []).length).toBe(4);
    expect((out.match(/aria-roledescription="slide"/g) ?? []).length).toBe(4);
    expect((out.match(/Show slide/g) ?? []).length).toBe(4);
  });

  it('Pillars: three pillars and one button', () => {
    const out = html(Pillars);
    expect(out).toContain('Adoption');
    expect(out).toContain('Liquidity');
    expect(out).toContain('Momentum');
    expect((out.match(/class="btn btn-mint"/g) ?? []).length).toBe(1);
  });

  it('Story: three steps with the nav anchors, three pinned cards', () => {
    const out = html(Story);
    expect(out).toContain('id="trends"');
    expect(out).toContain('id="gems"');
    expect(out).toContain('id="portfolio"');
    expect((out.match(/class="sv"/g) ?? []).length).toBe(3);
    expect(out).not.toContain('Find winners early');
  });

  it('Pricing, Faq, Finale, Footer render their copy', () => {
    expect(html(Pricing)).toContain('$12.99/mo');
    expect((html(Faq).match(/<details/g) ?? []).length).toBe(6);
    expect(html(Finale)).toContain('Start knowing.');
    const footer = html(Footer);
    expect(footer).toContain('educational information only');
    for (const col of ['Product', 'Company', 'Resources', 'Legal']) expect(footer).toContain(col);
  });

  it('SampleBadge renders the label outside production, inside a landmark', () => {
    const out = html(SampleBadge);
    expect(out).toContain('Sample data');
    expect(out).toMatch(/^<aside [^>]*aria-label="[^"]+"/);
  });

  it('MobileStickyCta: server render is hidden, labelled from the content layer, links to the final CTA', () => {
    const out = html(MobileStickyCta);
    expect(out).toContain('class="sticky-cta"');
    expect(out).toContain('data-show="false"'); // never visible before the hero has scrolled away
    expect(out).toContain('href="#quiz"');
    expect(out).toContain('>Start for free<');
    expect(out).toContain('aria-label="Get started"');
  });
});

describe('sticky pill rule', () => {
  it('shows only after the hero is gone and never while the final CTA is on screen', () => {
    expect(pillVisible(false, false)).toBe(false); // hero still in view
    expect(pillVisible(true, false)).toBe(true); // hero gone
    expect(pillVisible(true, true)).toBe(false); // final CTA on screen
    expect(pillVisible(false, true)).toBe(false);
  });
});

describe('marketing primitives', () => {
  it('Change marks up and down with colour classes and text, not colour alone', () => {
    const up = renderToStaticMarkup(createElement(Change, { value: 1.5 }));
    const down = renderToStaticMarkup(createElement(Change, { value: -2.25 }));
    expect(up).toContain('chg up');
    expect(up).toContain('Up ');
    expect(down).toContain('chg down');
    expect(down).toContain('Down ');
  });

  it('TemperaturePill draws one white fill on a track, never a coloured range', () => {
    const out = renderToStaticMarkup(createElement(TemperaturePill, { value: 'Heated', fill: 72 }));
    expect(out).toContain('--fill:72');
    expect(out).toContain('Heated');
    expect(out).not.toContain('<i></i><i>');
  });

  it('Sparkline colours by price move', () => {
    const up = renderToStaticMarkup(createElement(Sparkline, { values: [3, 2, 1], up: true }));
    const down = renderToStaticMarkup(createElement(Sparkline, { values: [1, 2, 3], up: false }));
    expect(up).toContain('#5ED3A0');
    expect(down).toContain('#F08C78');
  });
});

describe('scroll logic', () => {
  it('activeIndex: last section whose top passed the line, -1 above the first', () => {
    const line = spyLine(900);
    expect(activeIndex([900, 1800, 2700, 3600], line)).toBe(-1);
    expect(activeIndex([line, 1800, 2700, 3600], line)).toBe(0);
    expect(activeIndex([-1200, 40, 2700, 3600], line)).toBe(1);
    expect(activeIndex([-3000, -2000, -900, 100], line)).toBe(3);
    expect(activeIndex([-3000, null, 90, 500], line)).toBe(2);
  });

  it('spy line sits mid-viewport so a centred story step highlights its own link', () => {
    // Portfolio step centred in a 900px viewport: its top is about 260px down the screen.
    expect(activeIndex([-2400, -900, 260, 1500], spyLine(900))).toBe(2);
    expect(spyLine(900)).toBeGreaterThan(260);
  });

  it('activeStep: swaps when the previous text leaves the reading zone', () => {
    // viewport 900 tall: reading line = max(190, 234) = 234
    expect(activeStep([500, 1300, 2100], 900)).toBe(0);
    expect(activeStep([234, 700, 1500], 900)).toBe(1);
    expect(activeStep([-300, 100, 600], 900)).toBe(2);
    expect(activeStep([-300, -200, -100], 900)).toBe(2);
    // short viewport: line is 190
    expect(activeStep([200, 900, 1700], 500)).toBe(0);
  });

  it('stat count-up never shows a zero before it starts, and is skipped under reduced motion', () => {
    expect(displayValue(1000, null)).toBe(1000);
    expect(displayValue(11, null)).toBe(11);
    expect(displayValue(1000, 1)).toBe(1000);
    const mid = displayValue(1000, 0.3);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1000);
  });

  it('server render of the stats carries the final numbers', () => {
    const out = html(SignalFlow);
    expect(out).toContain('>1000+<');
    expect(out).toContain('>11+<');
  });

  it('nextSlide wraps', () => {
    expect(nextSlide(0, 4)).toBe(1);
    expect(nextSlide(3, 4)).toBe(0);
  });
});
