import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as content from '../content/marketing';

/** Collect every user-visible string in a content object (functions and non-strings are skipped). */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
  return out;
}

// Copy that is data (paths, urls, ids) rather than words a visitor reads.
const isCopy = (s: string) => !/^(\/|#|https?:|[a-z]+-[a-z0-9-]+$)/.test(s);

const copy = strings(content.marketingSections).filter(isCopy);

// Words the product must never use (MiCA: educational, never advisory). The hero headline is the
// one brief-mandated exception for "buy" and is pinned separately below.
const FORBIDDEN =
  /\b(buy|sell|hold|target|pump|guaranteed|recommended for you|will reach|10x|100x|moon)\b/i;

describe('marketing content: compliance', () => {
  it('has one object per section for the copy lint', () => {
    expect(Object.keys(content.marketingSections)).toEqual([
      'siteMeta',
      'nav',
      'hero',
      'coinTabs',
      'signalFlow',
      'pillars',
      'story',
      'pricing',
      'faq',
      'finale',
      'footer',
    ]);
  });

  it('does not ship either flagged phrase', () => {
    const all = copy.join('\n').toLowerCase();
    expect(all).not.toContain('find the coins worth buying');
    expect(all).not.toContain('find winners early');
    expect(all).not.toContain('winners');
  });

  it('uses no advisory words outside the brief-mandated hero headline', () => {
    const offenders = copy.filter((s) => FORBIDDEN.test(s) && s !== content.hero.titleAccent);
    expect(offenders).toEqual([]);
    expect(content.hero.titleAccent).toBe('Know what you buy.');
  });

  it('keeps the SAMPLE_ data free of advisory words too', () => {
    const sample = strings([
      content.SAMPLE_COINS,
      content.SAMPLE_NICHES,
      content.SAMPLE_GEMS,
      content.SAMPLE_GEM_FEED,
      content.SAMPLE_STORY_NICHES,
      content.SAMPLE_PORTFOLIO,
    ]);
    expect(sample.filter((s) => FORBIDDEN.test(s))).toEqual([]);
  });

  it('ships the educational disclaimer verbatim', () => {
    expect(content.footer.disclaimer).toBe(
      'CoinSnipe provides educational information only and is not financial advice. Crypto is risky and you can lose money.',
    );
  });
});

describe('marketing content: metadata and advisory-leaning copy', () => {
  it('page metadata comes from content and carries no banned word', () => {
    const layout = readFileSync(new URL('../app/(marketing)/layout.tsx', import.meta.url), 'utf8');
    expect(layout).toContain('title: siteMeta.title');
    expect(layout).toContain('description: siteMeta.description');
    expect(layout).not.toMatch(/title:\s*'/);
    for (const s of strings(content.siteMeta)) expect(s).not.toMatch(FORBIDDEN);
    expect(content.siteMeta.title).not.toMatch(/\bhold/i);
  });

  it('has no price-judgement or timing-prediction wording', () => {
    const ADVISORY =
      /\b(cheap|promising|before the crowd|moment is coming|early|undervalued|bargain)\b/i;
    expect(copy.filter((s) => ADVISORY.test(s))).toEqual([]);
  });
});

describe('marketing content: brief rules', () => {
  it('titles end with a full stop only when they hold two sentences', () => {
    const titles: [string, string | undefined][] = [
      ['story.markets', content.story.markets.title],
      ['story.gems', content.story.gems.title],
      ['story.portfolio', content.story.portfolio.title],
    ];
    for (const [name, t] of titles) expect(t, name).not.toMatch(/\.$/);
    // Two-sentence titles are split lead + accent, each ending in a full stop.
    for (const [lead, accent] of [
      [content.pillars.titleLead, content.pillars.titleAccent],
      [content.pricing.titleLead, content.pricing.titleAccent],
      [content.finale.titleLead, content.finale.titleAccent],
    ]) {
      expect(lead).toMatch(/\.$/);
      expect(accent).toMatch(/\.$/);
    }
    // One-sentence titles carry no final full stop.
    expect(content.faq.titleAccent).not.toMatch(/\.$/);
    expect(content.signalFlow.titleAccent).not.toMatch(/\.$/);
  });

  it('nav links, in order, match the section anchors', () => {
    expect(content.nav.links.map((l) => l.label)).toEqual([
      'Coin signals',
      'Trends',
      'Portfolio',
      'Pricing',
    ]);
    expect(content.nav.links.map((l) => l.href)).toEqual([
      '#signals',
      '#trends',
      '#portfolio',
      '#pricing',
    ]);
  });

  it('lists the four tabs and the four feature cards of the canvas', () => {
    expect(content.coinTabs.tabs.map((t) => t.label)).toEqual([
      'Top coins',
      'Top niches',
      'Hidden gems',
      'Portfolio',
    ]);
    expect(content.signalFlow.slides.map((s) => s.title)).toEqual([
      'Discover gems',
      'Get smart signals',
      'Track what matters',
      'Learn the basics',
    ]);
  });

  it('prices Pro as yearly-only with the D06 trial', () => {
    expect(content.pricing.free.price).toBe('$0');
    expect(content.pricing.pro.price).toBe('$12.99/mo');
    expect(content.pricing.pro.period).toBe('per month, billed yearly');
    expect(content.pricing.pro.trial).toBe('7-day free trial');
  });

  it('answers six FAQ questions', () => {
    expect(content.faq.items).toHaveLength(6);
  });

  it('keeps the footer company name and year as a D07 placeholder', () => {
    expect(content.footer.company).toBe('[COMPANY NAME], [YEAR]');
  });

  it('every coin logo path points at a file in public/brand/coins', () => {
    for (const path of Object.values(content.COIN_LOGOS)) {
      expect(path).toMatch(/^\/brand\/coins\/coin-[a-z]+\.png$/);
    }
  });

  it('season shares add to 100', () => {
    const sum = content.SAMPLE_PORTFOLIO.seasonShares.reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });
});
