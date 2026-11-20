/**
 * Bitcoin scenarios: base, upside, downside (master plan 5.3; CSN-032). Pro tier.
 *
 * Triggers, not dates, built from the regime and the nearest key levels (CSN-033):
 * - Base case: the regime continues between the nearest support and the nearest resistance.
 * - Upside: a daily close above the nearest Medium-or-Strong resistance opens the next resistance.
 * - Downside: a daily close below the nearest support opens the next support.
 *
 * All wording comes from the reviewed template file (see outlookSentence.ts). Nothing here says
 * where price will go; each scenario only names the close that would confirm it.
 */
import type { KeyZone } from '../levels/keyLevels';
import {
  OUTLOOK_TEMPLATES,
  fillTemplate,
  formatZone,
  strengthWord,
  type LevelsView,
  type Regime,
  type Tier,
} from './outlookSentence';

export const SCENARIO_KINDS = ['base', 'upside', 'downside'] as const;
export type ScenarioKind = (typeof SCENARIO_KINDS)[number];

export interface Scenario {
  readonly kind: ScenarioKind;
  readonly title: string;
  /** One line saying what the path is. */
  readonly summary: string;
  /** The close that would confirm it; never a date. */
  readonly trigger: string;
  /** The zones the trigger names, nearest first (empty when none apply). */
  readonly zones: readonly KeyZone[];
  readonly tier: Tier;
}

const zoneText = (z: KeyZone): string => formatZone(z);

/**
 * The three scenarios. `levels` null means key levels could not be computed; zones missing on one
 * side (no support, or no resistance at an all-time high) change the wording but never throw.
 * Zones are re-sorted here (supports high to low, resistances low to high), so the caller's order
 * does not matter.
 */
export function buildScenarios(
  regime: Regime | null,
  levels: LevelsView | null | undefined,
): Scenario[] {
  const t = OUTLOOK_TEMPLATES.scenarios;
  const lead = t.lead[regime ?? 'unknown'];
  const tier: Tier = 'pro';

  if (!levels) {
    return [
      {
        kind: 'base',
        title: t.base.title,
        summary: fillTemplate(t.base.none, { lead }),
        trigger: t.unavailable,
        zones: [],
        tier,
      },
      {
        kind: 'upside',
        title: t.upside.title,
        summary: t.upside.summary,
        trigger: t.unavailable,
        zones: [],
        tier,
      },
      {
        kind: 'downside',
        title: t.downside.title,
        summary: t.downside.summary,
        trigger: t.unavailable,
        zones: [],
        tier,
      },
    ];
  }

  const supports = [...levels.supports].sort((a, b) => b.high - a.high);
  const resistances = [...levels.resistances].sort((a, b) => a.low - b.low);
  const s1 = supports[0];
  const s2 = supports[1];
  const r1 = resistances[0];

  /* base case */
  let baseSummary: string;
  let baseTrigger: string;
  if (s1 && r1) {
    const v = { support: zoneText(s1), resistance: zoneText(r1) };
    baseSummary = fillTemplate(t.base.both, { lead, ...v });
    baseTrigger = fillTemplate(t.base.trigger, v);
  } else if (r1) {
    baseSummary = fillTemplate(t.base.noSupport, { lead, resistance: zoneText(r1) });
    baseTrigger = fillTemplate(t.base.triggerNoSupport, { resistance: zoneText(r1) });
  } else if (s1) {
    baseSummary = fillTemplate(t.base.noResistance, { lead, support: zoneText(s1) });
    baseTrigger = fillTemplate(t.base.triggerNoResistance, { support: zoneText(s1) });
  } else {
    baseSummary = fillTemplate(t.base.none, { lead });
    baseTrigger = t.base.triggerNone;
  }

  /* upside: nearest Medium-or-Strong resistance, then the zone after it */
  const upIdx = resistances.findIndex((z) => z.strength !== 'Weak');
  const upZone = upIdx >= 0 ? resistances[upIdx] : undefined;
  const upNext = upIdx >= 0 ? resistances[upIdx + 1] : undefined;
  let upTrigger: string;
  let upZones: KeyZone[];
  if (upZone && upNext) {
    upTrigger = fillTemplate(t.upside.trigger, {
      zone: zoneText(upZone),
      strength: strengthWord(upZone),
      next: zoneText(upNext),
    });
    upZones = [upZone, upNext];
  } else if (upZone) {
    upTrigger = fillTemplate(t.upside.triggerNoNext, {
      zone: zoneText(upZone),
      strength: strengthWord(upZone),
    });
    upZones = [upZone];
  } else if (r1) {
    upTrigger = fillTemplate(t.upside.triggerWeakOnly, {
      zone: zoneText(r1),
      strength: strengthWord(r1),
    });
    upZones = [r1];
  } else {
    upTrigger = t.upside.triggerNone;
    upZones = [];
  }
  if (levels.resistanceNote) upTrigger = `${t.upside.allTimeHigh} ${upTrigger}`;

  /* downside: nearest support, then the support after it */
  let downTrigger: string;
  let downZones: KeyZone[];
  if (s1 && s2) {
    downTrigger = fillTemplate(t.downside.trigger, {
      zone: zoneText(s1),
      strength: strengthWord(s1),
      next: zoneText(s2),
    });
    downZones = [s1, s2];
  } else if (s1) {
    downTrigger = fillTemplate(t.downside.triggerNoNext, {
      zone: zoneText(s1),
      strength: strengthWord(s1),
    });
    downZones = [s1];
  } else {
    downTrigger = t.downside.triggerNone;
    downZones = [];
  }

  return [
    {
      kind: 'base',
      title: t.base.title,
      summary: baseSummary,
      trigger: baseTrigger,
      zones: [s1, r1].filter((z): z is KeyZone => z !== undefined),
      tier,
    },
    {
      kind: 'upside',
      title: t.upside.title,
      summary: t.upside.summary,
      trigger: upTrigger,
      zones: upZones,
      tier,
    },
    {
      kind: 'downside',
      title: t.downside.title,
      summary: t.downside.summary,
      trigger: downTrigger,
      zones: downZones,
      tier,
    },
  ];
}
