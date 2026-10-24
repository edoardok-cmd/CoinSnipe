/**
 * Lab-compatibility config and golden inputs for Level A (test code only; CSN-031).
 *
 * DISCREPANCIES.md D-08: the master plan scales every market-weather input against its own
 * 1-year history, but the Score Lab divides each input by a fixed constant, and the golden has
 * no 1-year macro history. So the golden comparison runs with `levelA.subScore.method:
 * "fixedScale"` and the Lab's constants, on top of {@link labCompatConfig}. The constants sit in
 * the SAMPLE_labLevelAScale fixture, not in this file: the engine config ships `fixedScale: null`,
 * so no Lab-only number is part of the production model. Units are the engine's (percent, not fractions).
 *
 * Every number in the golden is invented SAMPLE data. Never import this from src/.
 */
import { readFileSync } from 'node:fs';
import { cloneModelConfig, type ModelConfig } from '../../src/config/schema';
import type { AltCandidate, AltSeasonInputs, MarketWeatherInputs } from '../../src/index';
import { coinSeries, type Golden } from './golden';
import { labCompatConfig } from './labCompat';

type Scale = { centre: number; unit: number; aboveUnit?: number };

/**
 * The Score Lab's per-input scale, loaded from the SAMPLE_ fixture: a value equal to `centre`
 * scores 0, `unit` away scores 100.
 */
export const LAB_FIXED_SCALE: Record<string, Scale> = (
  JSON.parse(
    readFileSync(
      new URL('./__fixtures__/SAMPLE_labLevelAScale.v0.3.json', import.meta.url),
      'utf8',
    ),
  ) as { scales: Record<string, Scale> }
).scales;

/** {@link labCompatConfig} plus the Lab's fixed-scale sub-scores for Level A. */
export function labLevelACompatConfig(base?: ModelConfig): ModelConfig {
  const cfg = labCompatConfig(cloneModelConfig(base));
  cfg.levelA.subScore.method = 'fixedScale';
  cfg.levelA.subScore.fixedScale = structuredClone(LAB_FIXED_SCALE);
  return cfg;
}

export type GoldenDay = 'now' | 'prev';

const dayIndex = (golden: Golden, day: GoldenDay): number =>
  day === 'now' ? golden.meta.scoredDay : golden.meta.prevDay;

/** Market-weather inputs for the golden's scored day or its previous-week day. */
export function goldenMarketInputs(golden: Golden, day: GoldenDay): MarketWeatherInputs {
  const m = golden.inputs.macro[day] as Record<string, number>;
  const end = dayIndex(golden, day);
  const btc = coinSeries(golden, 'BTC').p.slice(0, end + 1);
  const value = (v: number) => ({ value: v });
  return {
    asOf: day === 'now' ? '2026-10-10' : '2026-10-03',
    btcCloses: btc,
    stablecoinSupplyChange30d: value(m.stable30!),
    fundingRate: value(m.funding!),
    openInterestChange30d: value(m.oi30!),
    fearGreed: value(m.fng!),
    nasdaqVs50dma: value(m.ndx50!),
    spxVs50dma: value(m.spx50!),
    vix: value(m.vix!),
    btcDominanceChange30d: value(m.dom30!),
    dollarIndexChange30d: value(m.dxy30!),
    us10yChange30d: value(m.us10y30!),
    wtiChange30d: value(m.wti30!),
    goldChange30d: value(m.gold30!),
    globalM2: {
      threeMonthChange: value(m.m2_3m!),
      yearlyChange: value(m.m2yoy!),
    },
    regulationTone: value(m.reg!),
    geopoliticalRisk: value(m.gpr!),
    btcNasdaqCorrelation: m.corr90!,
  };
}

/** Alt-season inputs for the golden's scored day or its previous-week day. */
export function goldenAltInputs(golden: Golden, day: GoldenDay): AltSeasonInputs {
  const m = golden.inputs.macro[day] as Record<string, number>;
  const end = dayIndex(golden, day);
  const last = golden.meta.days - 1;
  const alts: AltCandidate[] = golden.inputs.coins.map((c) => {
    const p = coinSeries(golden, c.s).p;
    return {
      symbol: c.s,
      // The Lab ranks by market cap on the scored day: today's cap scaled by the price ratio.
      marketCap: (c.mcap * p[end]!) / p[last]!,
      closes: p.slice(0, end + 1),
    };
  });
  return {
    asOf: day === 'now' ? '2026-10-10' : '2026-10-03',
    btcCloses: coinSeries(golden, 'BTC').p.slice(0, end + 1),
    ethCloses: coinSeries(golden, 'ETH').p.slice(0, end + 1),
    alts,
    btcDominanceChange30d: { value: m.dom30! },
  };
}
