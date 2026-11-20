/**
 * Bitcoin outlook sentence (master plan 5.3 and 10; CSN-032).
 *
 * Every word shown to the user comes from the reviewed template file
 * `templates/outlook.templates.json` (scanned by tools/copy-lint). This module only picks a
 * template by label and fills placeholders with numbers it was given; there is no free text, and
 * an unknown or unfilled placeholder throws instead of printing a half-built sentence.
 */
import { z } from 'zod';
import type { KeyLevelsResult, KeyZone } from '../levels/keyLevels';
import rawTemplates from './templates/outlook.templates.json';

export const REGIMES = ['Uptrend', 'Range', 'Downtrend'] as const;
export type Regime = (typeof REGIMES)[number];
export const FUELS = ['Rising', 'Flat', 'Falling'] as const;
export type Fuel = (typeof FUELS)[number];
export const FRAGILITIES = ['Low', 'Elevated', 'High'] as const;
export type Fragility = (typeof FRAGILITIES)[number];

/** Plan tier of an output field (gating is enforced later, CSN-043). */
export type Tier = 'free' | 'pro';

const text = z.string().min(1);
const keyed = <K extends string>(keys: readonly K[]) =>
  z.strictObject(Object.fromEntries(keys.map((k) => [k, text])) as Record<K, typeof text>);

const driverTemplate = <S extends string>(states: readonly S[]) =>
  z.strictObject({
    name: text,
    tells: text,
    source: text,
    leads: text,
    states: keyed(states),
  });

const templatesSchema = z.strictObject({
  version: z.literal(1),
  headline: text,
  regime: keyed(REGIMES),
  fuel: keyed(FUELS),
  fragility: keyed(FRAGILITIES),
  levels: keyed([
    'intro',
    'support',
    'noSupport',
    'resistanceTwo',
    'resistanceOne',
    'resistanceNone',
    'resistanceAllTimeHigh',
    'unavailable',
  ] as const),
  history: keyed(['pending', 'ready', 'thinNote'] as const),
  drivers: z.strictObject({
    D1: driverTemplate(['inflow', 'outflow', 'flat', 'unavailable'] as const),
    D2: driverTemplate(['early', 'inWindow', 'late', 'unavailable'] as const),
    D3: driverTemplate(['extremeGreed', 'extremeFear', 'neutral', 'unavailable'] as const),
    D4: driverTemplate(['near', 'far', 'unavailable'] as const),
    D5: driverTemplate(['accumulating', 'distributing', 'neutral'] as const),
  }),
  scenarios: z.strictObject({
    unavailable: text,
    lead: keyed(['Uptrend', 'Range', 'Downtrend', 'unknown'] as const),
    base: keyed([
      'title',
      'both',
      'noSupport',
      'noResistance',
      'none',
      'trigger',
      'triggerNoSupport',
      'triggerNoResistance',
      'triggerNone',
    ] as const),
    upside: keyed([
      'title',
      'summary',
      'trigger',
      'triggerNoNext',
      'triggerWeakOnly',
      'triggerNone',
      'allTimeHigh',
    ] as const),
    downside: keyed(['title', 'summary', 'trigger', 'triggerNoNext', 'triggerNone'] as const),
  }),
});

export type OutlookTemplates = z.output<typeof templatesSchema>;

/** The reviewed template file, validated once. */
export const OUTLOOK_TEMPLATES: OutlookTemplates = templatesSchema.parse(rawTemplates);

/**
 * Fill `{name}` placeholders. Throws when the template names a placeholder with no value or a
 * value is given that the template does not use, so a template edit cannot silently drop a number.
 */
export function fillTemplate(
  template: string,
  values: Readonly<Record<string, string | number>> = {},
): string {
  const used = new Set<string>();
  const out = template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = values[name];
    if (v === undefined) throw new Error(`template needs {${name}}: "${template}"`);
    used.add(name);
    return String(v);
  });
  for (const k of Object.keys(values))
    if (!used.has(k)) throw new Error(`template does not use {${k}}: "${template}"`);
  return out;
}

/** '$86,000': whole dollars with thousands separators (no locale, so output never varies). */
export function formatPrice(x: number): string {
  const whole = Math.round(Math.abs(x)).toString();
  return `${x < 0 ? '-' : ''}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** '$82,000 to $84,000', or one price when both ends round to the same dollar. */
export function formatZone(zone: Pick<KeyZone, 'low' | 'high'>): string {
  const lo = formatPrice(zone.low);
  const hi = formatPrice(zone.high);
  return lo === hi ? lo : `${lo} to ${hi}`;
}

/** Lower-case strength word for running text ('strong'). */
export const strengthWord = (z: Pick<KeyZone, 'strength'>): string => z.strength.toLowerCase();

export type LevelsView = Pick<KeyLevelsResult, 'supports' | 'resistances' | 'resistanceNote'>;

/**
 * 'Levels to watch: support <zone> (<strength>). Resistance <zone>, then <zone>.' with the
 * nearest zones only. Missing sides read as plain statements; at an all-time high the
 * no-earlier-price note follows the resistance zones (or replaces them when there are none).
 */
export function levelsClause(levels: LevelsView | null | undefined): string {
  const t = OUTLOOK_TEMPLATES.levels;
  if (!levels) return t.unavailable;
  const s = levels.supports[0];
  const [r1, r2] = levels.resistances;
  const support = s
    ? fillTemplate(t.support, { zone: formatZone(s), strength: strengthWord(s) })
    : t.noSupport;
  const parts: string[] = [];
  if (r1 && r2)
    parts.push(fillTemplate(t.resistanceTwo, { first: formatZone(r1), second: formatZone(r2) }));
  else if (r1) parts.push(fillTemplate(t.resistanceOne, { first: formatZone(r1) }));
  else if (!levels.resistanceNote) parts.push(t.resistanceNone);
  if (levels.resistanceNote) parts.push(t.resistanceAllTimeHigh);
  return [t.intro, support, ...parts].join(' ');
}

export interface OutlookSentenceInput {
  readonly regime: Regime | null;
  readonly fuel: Fuel | null;
  readonly fragility: Fragility | null;
  readonly levels?: LevelsView | null;
}

export interface OutlookSentence {
  readonly text: string;
  readonly headline: string;
  readonly regimeLine: string;
  readonly fuelLine: string;
  readonly fragilityLine: string;
  readonly levelsLine: string;
  readonly tier: Tier;
}

/**
 * The outlook sentence, or null when a label could not be computed (never a partial sentence).
 * Free tier: regime, fuel, fragility and levels are all free (master plan 14).
 */
export function outlookSentence(input: OutlookSentenceInput): OutlookSentence | null {
  const { regime, fuel, fragility } = input;
  if (!regime || !fuel || !fragility) return null;
  const t = OUTLOOK_TEMPLATES;
  const headline = fillTemplate(t.headline, {
    regime,
    fuel: fuel.toLowerCase(),
    fragility: fragility.toLowerCase(),
  });
  const regimeLine = t.regime[regime];
  const fuelLine = t.fuel[fuel];
  const fragilityLine = t.fragility[fragility];
  const levelsLine = levelsClause(input.levels);
  return {
    text: [headline, regimeLine, fuelLine, fragilityLine, levelsLine].join(' '),
    headline,
    regimeLine,
    fuelLine,
    fragilityLine,
    levelsLine,
    tier: 'free',
  };
}
