/**
 * Versioned model config: zod schema, parser and the v0.3 default.
 *
 * The config is the single place where weights, thresholds and per-ID statuses live
 * (design.md 2.3, R-F5), so that the engine never hard-codes a model parameter. Weights within a
 * group must be non-negative, unknown keys are rejected everywhere, ordering and uniqueness
 * invariants are checked, and retired IDs (R3, S4) must stay present with weight 0.
 *
 * Which code reads which section is not listed here (it goes stale); see {@link PENDING_CONFIG_KEYS}
 * for the `indicators` and `candles` keys that no code reads yet, and grep `config.` in `src/`.
 */
import { z } from 'zod';
import rawModelConfigV03 from './model-config.v0.3.json';
import {
  ARCHETYPES,
  DIRECTIONS,
  GROWTH_METRIC_IDS,
  HORIZONS,
  ID_STATUSES,
  MARKET_MEASURES,
  MARKET_WEIGHT_IDS,
  METRIC_IDS,
  METRIC_PILLARS,
  MODEL_IDS,
  PEER_SCOPES,
  PROFILES,
  QUALITY_PILLARS,
  SCALED_MEASURE_KEYS,
  SECTOR_IDS,
  SUB_SCORE_METHODS,
  TIMING_PARTS,
  type MetricId,
} from '../types';

const weight = z.number().nonnegative();
const share = z.number().min(0).max(1);
const score100 = z.number().min(0).max(100);
const nonNegative = z.number().nonnegative();
const positiveInt = z.number().int().positive();
const metricId = z.enum(METRIC_IDS);

const sumOf = (values: Iterable<number>): number => {
  let s = 0;
  for (const v of values) s += v;
  return s;
};
const hasPositiveSum = (o: Record<string, number> | readonly number[]): boolean =>
  sumOf(Object.values(o)) > 0;
const positiveSumMessage = { message: 'at least one weight in the group must be above 0' };

/** Weights that must add up to 100 (the master-plan tables are points out of 100). */
const sumsTo100 = (values: Iterable<number>): boolean => Math.abs(sumOf(values) - 100) < 1e-9;

const weightShape = <K extends string>(ids: readonly K[]): Record<K, typeof weight> =>
  Object.fromEntries(ids.map((id) => [id, weight])) as Record<K, typeof weight>;

const profileSchema = z.strictObject({
  archetypes: z.array(z.enum(ARCHETYPES)).min(1),
  qualityMin: score100.optional(),
  minTierA: z.number().int().nonnegative().optional(),
  maxUnlock30: nonNegative.optional(),
  minAge: nonNegative.optional(),
  mcFloor: nonNegative,
});

const metricSpecSchema = z
  .strictObject({
    pillar: z.enum(METRIC_PILLARS),
    better: z.enum(DIRECTIONS),
    range: z.tuple([z.number(), z.number()]).optional(),
  })
  .superRefine((spec, ctx) => {
    if (spec.better === 'fixed') {
      if (!spec.range)
        ctx.addIssue({ code: 'custom', message: 'a fixed-scale metric needs a range' });
      else if (!(spec.range[0] < spec.range[1]))
        ctx.addIssue({ code: 'custom', message: 'range must be [low, high] with low < high' });
    } else if (spec.range) {
      ctx.addIssue({ code: 'custom', message: 'only fixed-scale metrics take a range' });
    }
  });

const rankedPillars = ['U', 'E', 'T', 'L', 'R', 'M'] as const;

const firstDuplicate = (values: readonly string[]): string | undefined =>
  values.find((v, k) => values.indexOf(v) !== k);
/** Array of IDs or names in which every entry appears once. */
const uniqueList = <T extends z.ZodType<string>>(item: T, what: string) =>
  z.array(item).superRefine((list, ctx) => {
    const dup = firstDuplicate(list);
    if (dup !== undefined) ctx.addIssue({ code: 'custom', message: `duplicate ${what} ${dup}` });
  });

/**
 * Config keys that are validated but not yet read by any code in src/, with the task that will
 * consume each one. Until then, editing them changes no output.
 *
 * Precedence in `indicators`: `variant` picks the implementation of RSI (H1), ATR (H2 and 5.4 zone
 * merging) and ADX (M6). 'textbook' uses ../indicators.ts; 'lab' uses the Score Lab ports in
 * ../lab/reference.ts, whose warm-up windows are fixed (RSI: the last 4 x period + 1 changes; ADX:
 * 3 x period bars; ATR: a plain period-bar mean). So `rsiWarmupBars` only applies to 'textbook',
 * and the schema rejects 'lab' with a non-null `rsiWarmupBars` because the two would disagree.
 * `rsiPeriod`, `atrPeriod` and `adxPeriod` apply to both variants. `returns` and the `candles`
 * keys are independent of `variant`.
 *
 * `indicators.returns` is already read by the Level A macro-scaling correlation (CSN-031) and so
 * is not listed; CSN-035 (R1) and CSN-036 (beta in S1) will read it too.
 *
 * A consuming task removes its keys from this map when it wires them (config.test.ts checks
 * that every `indicators` and `candles` key is either listed here or removed from the list on
 * purpose).
 */
export const PENDING_CONFIG_KEYS: Readonly<Record<string, string>> = {
  'indicators.variant': 'CSN-036 (H1 RSI, H2 ATR, M6 ADX) and CSN-033 (ATR for zone merging)',
  'indicators.rsiPeriod': 'CSN-036 (H1)',
  'indicators.rsiWarmupBars': 'CSN-036 (H1)',
  'indicators.atrPeriod': 'CSN-036 (H2) and CSN-033 (5.4 zone merging)',
  'indicators.adxPeriod': 'CSN-036 (M6)',
  'indicators.bollingerPeriod': 'CSN-036 (H4)',
  'indicators.bollingerK': 'CSN-036 (H4)',
  'indicators.annualisationDays': 'CSN-035 (R1)',
  'indicators.volatilityDays': 'CSN-035 (R1)',
  'indicators.betaDays': 'CSN-036 (beta in S1)',
  'indicators.drawdownDays': 'CSN-035 (R2)',
  'indicators.pivotBars': 'CSN-033 (K1)',
  'indicators.upDownVolumeDays': 'CSN-036 (M7)',
  'candles.short': 'CSN-036 (candles for horizonCandleIds)',
  'candles.medium': 'CSN-036 (candles for horizonCandleIds)',
  'candles.long': 'CSN-036 (candles for horizonCandleIds)',
  'candles.weeklyBars': 'CSN-036 (weekly RSI) and CSN-033 (K1 weekly pivots)',
  'candles.horizonCandleIds': "CSN-036 (which metrics use the horizon's candles; D-07)",
};

const measureWeights = <K extends string>(keys: readonly K[]) =>
  z
    .strictObject(weightShape(keys))
    .refine((o) => hasPositiveSum(o as Record<string, number>), positiveSumMessage);

const fixedScaleEntry = z.strictObject({
  /** Neutral point: a value equal to `centre` scores 0. */
  centre: z.number(),
  /** The distance from `centre` that scores a full +-100 (alt season: on the signed scale too). */
  unit: z.number().positive(),
  /** A3 funding only: the unit above the crowded-leverage threshold, when it differs from `unit`. */
  aboveUnit: z.number().positive().optional(),
});

/**
 * Level A sub-score method (master plan 5.1: "clamped against its own 1-year history").
 * `zscore` (default): (value - 1-year mean) / (zClip x 1-year standard deviation) x 100, clipped
 * to +-100, which is the plan's "z-score clipped to +-2, scaled x50" when zClip is 2. `minmax`:
 * the position between the 1-year minimum and maximum, mapped to -100..+100. `fixedScale`: the
 * Score Lab's per-input constants (a neutral point and a unit), which need no history; the table
 * is null by default, so the golden run supplies it (test/oracle/labLevelACompat.ts).
 */
const subScoreSchema = z
  .strictObject({
    method: z.enum(SUB_SCORE_METHODS),
    historyDays: z.number().int().min(2),
    minHistory: z.number().int().min(2),
    zClip: z.number().positive(),
    fixedScale: z.partialRecord(z.enum(SCALED_MEASURE_KEYS), fixedScaleEntry).nullable(),
  })
  .superRefine((s, ctx) => {
    if (s.minHistory > s.historyDays)
      ctx.addIssue({ code: 'custom', message: 'minHistory cannot exceed historyDays' });
    if (s.method === 'fixedScale') {
      if (!s.fixedScale)
        ctx.addIssue({ code: 'custom', message: 'method "fixedScale" needs a fixedScale table' });
      else
        for (const key of SCALED_MEASURE_KEYS)
          if (!s.fixedScale[key])
            ctx.addIssue({
              code: 'custom',
              path: ['fixedScale', key],
              message: `method "fixedScale" needs an entry for ${key}`,
            });
    }
  });

const levelASchema = z.strictObject({
  subScore: subScoreSchema,
  market: z.strictObject({
    /** Weights of the measures inside each input (they are reweighted when one is missing). */
    parts: z.strictObject({
      A1: measureWeights(MARKET_MEASURES.A1),
      A2: measureWeights(MARKET_MEASURES.A2),
      A3: measureWeights(MARKET_MEASURES.A3),
      A4: measureWeights(MARKET_MEASURES.A4),
      A5: measureWeights(MARKET_MEASURES.A5),
      A6: measureWeights(MARKET_MEASURES.A6),
      A7: measureWeights(MARKET_MEASURES.A7),
      A8: measureWeights(MARKET_MEASURES.A8),
      A9: measureWeights(MARKET_MEASURES.A9),
    }),
    /** A1 windows in days: the three averages of the stack, and the slope span of the middle one. */
    trend: z
      .strictObject({
        shortMa: positiveInt,
        midMa: positiveInt,
        longMa: positiveInt,
        slopeDays: positiveInt,
      })
      .refine((t) => t.shortMa < t.midMa && t.midMa < t.longMa, {
        message: 'trend averages must satisfy shortMa < midMa < longMa',
      }),
    /** A3: funding per 8 hours, in percent, above which a higher rate scores lower. */
    fundingInvertAbove: nonNegative,
    /** A9: the GPR index level that counts as no extra geopolitical risk. */
    gprBaseline: z.number(),
    /** A8: days between the M2 observation used and asOf. */
    m2LagDays: z.number().int().nonnegative(),
    /** Macro scaling when no BTC-Nasdaq correlation is available: keep plan weights, or use the floor. */
    corrMissing: z.enum(['none', 'floor']),
    /** A10: days ahead of asOf that count, and the unlock size (percent of supply) that counts as large. */
    events: z.strictObject({
      windowDays: z.number().int().nonnegative(),
      largeUnlockPct: nonNegative,
    }),
  }),
  cycle: z.strictObject({
    /** C1: how many of the largest alts are compared with Bitcoin. */
    topN: positiveInt,
    /** C1: the return window in days. */
    returnDays: positiveInt,
    /** C3: the ETH/BTC change window in days. */
    ethBtcDays: positiveInt,
    /** C1: stablecoin symbols left out of the top alts (the data layer can also flag them). */
    stablecoins: uniqueList(z.string().min(1), 'stablecoin'),
  }),
});

export const modelConfigSchema = z
  .strictObject({
    model_version: z
      .string()
      .regex(/^\d+\.\d+(\.\d+)?$/, 'model_version must look like 0.3 or 1.0.0'),
    description: z.string(),
    quality: z.record(z.enum(QUALITY_PILLARS), weight).refine(hasPositiveSum, positiveSumMessage),
    timing: z.record(
      z.enum(HORIZONS),
      z.record(z.enum(TIMING_PARTS), weight).refine(hasPositiveSum, positiveSumMessage),
    ),
    blendQ: z.record(z.enum(HORIZONS), share),
    tempAdj: z.strictObject({ over: z.number(), heated: z.number(), cool: z.number() }),
    tempBands: z
      .strictObject({ cool: score100, heated: score100, over: score100 })
      .refine((b) => b.cool <= b.heated && b.heated <= b.over, {
        message: 'temperature bands must satisfy cool <= heated <= over',
      }),
    rocBlend: z.record(
      z.enum(HORIZONS),
      z.tuple([weight, weight, weight]).refine(hasPositiveSum, positiveSumMessage),
    ),
    absBlend: z.strictObject({
      share,
      span: z.number().positive(),
      ids: uniqueList(metricId, 'metric'),
    }),
    metrics: z.record(metricId, weight),
    market: z
      .strictObject({
        ...weightShape(MARKET_WEIGHT_IDS),
        corrFloor: share,
        tailwind: z.number(),
        headwind: z.number(),
      })
      .refine((m) => sumsTo100(MARKET_WEIGHT_IDS.map((id) => m[id])), {
        message: 'market weights A1-A9 must add up to 100',
      })
      .refine((m) => m.headwind < m.tailwind, { message: 'headwind must be below tailwind' }),
    cycle: z
      .strictObject({
        altIndex: weight,
        dominance: weight,
        ethBtc: weight,
        altSeason: score100,
        btcSeason: score100,
        dex: z.array(z.string().min(1)),
      })
      .refine((c) => sumsTo100([c.altIndex, c.dominance, c.ethBtc]), {
        message: 'cycle weights C1-C3 (altIndex, dominance, ethBtc) must add up to 100',
      })
      .refine((c) => c.btcSeason < c.altSeason, { message: 'btcSeason must be below altSeason' }),
    /**
     * Level A parameters that the master plan leaves open or that the Lab hard-codes (CSN-031).
     * `market` and `cycle` above stay identical to the Lab's keys; everything the engine added
     * lives here. See DISCREPANCIES.md D-08 to D-13.
     */
    levelA: levelASchema,
    sector: z
      .strictObject({
        ...weightShape(SECTOR_IDS),
        phaseDelta: nonNegative,
        minHeat: score100,
        highHeat: score100,
        hysteresis: positiveInt,
      })
      .refine((s) => sumOf(SECTOR_IDS.map((id) => s[id])) > 0, positiveSumMessage)
      .refine((s) => s.minHeat < s.highHeat, { message: 'sector minHeat must be below highHeat' }),
    gates: z.strictObject({
      G1: z.strictObject({ unlock30: nonNegative, cap: score100 }),
      G2: z.strictObject({ turnover: nonNegative, cap: score100 }),
      G3: z.strictObject({ days: z.number().int().nonnegative(), cap: score100 }),
      G4: z.strictObject({ coverage: share }),
      G5: z.strictObject({ usageCap: score100 }),
    }),
    exchanges: z
      .strictObject({
        tierA: uniqueList(z.string().min(1), 'exchange'),
        tierB: uniqueList(z.string().min(1), 'exchange'),
        weightA: weight,
        weightB: weight,
        weightDex: weight,
      })
      .superRefine((e, ctx) => {
        const both = e.tierA.find((x) => e.tierB.includes(x));
        if (both !== undefined)
          ctx.addIssue({
            code: 'custom',
            path: ['tierB'],
            message: `exchange ${both} is in both tierA and tierB (L1 would count it twice)`,
          });
      }),
    access: z.strictObject({ usVenue: weight, euVenue: weight, etp: weight }),
    quadrant: z.strictObject({ threshold: score100 }),
    archetypes: z
      .strictObject({
        blueChipMc: nonNegative,
        blueChipAge: nonNegative,
        establishedMc: nonNegative,
        establishedAge: nonNegative,
        establishedTierA: z.number().int().nonnegative(),
        emergingMc: nonNegative,
        earlyAge: nonNegative,
      })
      .refine((a) => a.emergingMc < a.establishedMc && a.establishedMc < a.blueChipMc, {
        message: 'archetype market caps must satisfy emergingMc < establishedMc < blueChipMc',
      }),
    profiles: z.record(z.enum(PROFILES), profileSchema),
    upside: z
      .strictObject({ high: score100, low: score100, supplyBlock: nonNegative })
      .refine((u) => u.low < u.high, { message: 'upside low must be below high' }),
    levels: z
      .strictObject({
        mergeAtr: nonNegative,
        methodPts: nonNegative,
        reactMax: nonNegative,
        recentDays: z.number().int().nonnegative(),
        strong: nonNegative,
        medium: nonNegative,
        range: share,
      })
      .refine((l) => l.medium < l.strong, { message: 'levels medium must be below strong' }),
    outlook: z
      .strictObject({
        fuelUp: z.number(),
        fuelDown: z.number(),
        fragHigh: score100,
        fragElev: score100,
      })
      .refine((o) => o.fuelDown < o.fuelUp, { message: 'outlook fuelDown must be below fuelUp' })
      .refine((o) => o.fragElev < o.fragHigh, {
        message: 'outlook fragElev must be below fragHigh',
      }),
    labels: z
      .array(z.tuple([score100, z.string().min(1)]))
      .min(1)
      .refine((ls) => ls.every((l, k) => k === 0 || l[0] < (ls[k - 1]?.[0] ?? Infinity)), {
        message: 'label thresholds must be strictly descending',
      })
      .refine((ls) => ls[ls.length - 1]?.[0] === 0, { message: 'the last label must start at 0' }),
    metricSpec: z.partialRecord(metricId, metricSpecSchema),
    normalization: z
      .strictObject({
        /** Winsorising percentiles within the peer group; null = no winsorising (Score Lab). */
        winsorPct: z.tuple([score100, score100]).nullable(),
        peerMin: positiveInt,
        peerCountIncludesSelf: z.boolean(),
        peerScope: z.record(z.enum(rankedPillars), z.enum(PEER_SCOPES)),
        logIds: uniqueList(metricId, 'metric'),
      })
      .refine((n) => n.winsorPct === null || n.winsorPct[0] < n.winsorPct[1], {
        message: 'winsorPct must be [lower, upper] with lower < upper',
      }),
    candles: z.strictObject({
      short: z.enum(['daily', 'weekly']),
      medium: z.enum(['daily', 'weekly']),
      long: z.enum(['daily', 'weekly']),
      weeklyBars: z.number().int().min(2),
      horizonCandleIds: uniqueList(metricId, 'metric'),
    }),
    indicators: z
      .strictObject({
        variant: z.enum(['textbook', 'lab']),
        rsiPeriod: positiveInt,
        rsiWarmupBars: z.number().int().nonnegative().nullable(),
        atrPeriod: positiveInt,
        adxPeriod: positiveInt,
        bollingerPeriod: z.number().int().min(2),
        bollingerK: z.number().positive(),
        returns: z.enum(['log', 'simple']),
        annualisationDays: z.number().positive(),
        volatilityDays: z.number().int().min(2),
        betaDays: z.number().int().min(2),
        correlationDays: z.number().int().min(2),
        drawdownDays: z.number().int().min(2),
        pivotBars: z
          .number()
          .int()
          .min(3)
          .refine((n) => n % 2 === 1, {
            message: 'pivotBars must be odd (centre bar plus equal sides)',
          }),
        upDownVolumeDays: positiveInt,
      })
      .refine((i) => i.variant === 'textbook' || i.rsiWarmupBars === null, {
        message:
          'rsiWarmupBars applies only to variant "textbook"; the "lab" RSI has a fixed window, so set it to null',
      }),
    status: z.record(z.enum(MODEL_IDS as [string, ...string[]]), z.enum(ID_STATUSES)),
  })
  .superRefine((cfg, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const pillarSums = new Map<string, number>();
    for (const id of METRIC_IDS) {
      const status = cfg.status[id];
      const w = cfg.metrics[id];
      const spec = cfg.metricSpec[id];
      if (status === 'retired') {
        if (w !== 0) issue(['metrics', id], `${id} is retired, so its weight must be 0`);
        continue;
      }
      if (!spec) {
        issue(['metricSpec', id], `${id} is not retired, so it needs a metricSpec entry`);
        continue;
      }
      if (spec.pillar !== id.charAt(0))
        issue(['metricSpec', id, 'pillar'], `${id} belongs to pillar ${id.charAt(0)}`);
      pillarSums.set(spec.pillar, (pillarSums.get(spec.pillar) ?? 0) + w);
    }
    for (const pillar of METRIC_PILLARS) {
      if (!((pillarSums.get(pillar) ?? 0) > 0))
        issue(['metrics'], `pillar ${pillar}: ${positiveSumMessage.message}`);
    }
    const mustBeRanked = (path: string, ids: readonly MetricId[]) => {
      ids.forEach((id, k) => {
        const spec = cfg.metricSpec[id];
        if (cfg.status[id] === 'retired') issue([path, k], `${id} is retired`);
        else if (!spec || spec.better === 'fixed')
          issue([path, k], `${id} must be a ranked metric (better: higher or lower)`);
      });
    };
    mustBeRanked('absBlend.ids', cfg.absBlend.ids);
    mustBeRanked('normalization.logIds', cfg.normalization.logIds);
    cfg.normalization.logIds.forEach((id, k) => {
      if ((GROWTH_METRIC_IDS as readonly string[]).includes(id) || cfg.absBlend.ids.includes(id))
        issue(
          ['normalization', 'logIds', k],
          `${id} is a growth metric (it can be negative, and a log would drop those coins); only size metrics are logged`,
        );
    });
    cfg.candles.horizonCandleIds.forEach((id, k) => {
      if (cfg.status[id] === 'retired')
        issue(['candles', 'horizonCandleIds', k], `${id} is retired`);
    });
  });

export type ModelConfig = z.output<typeof modelConfigSchema>;

/** Thrown by {@link parseModelConfig}; `message` lists every issue with its path. */
export class ModelConfigError extends Error {
  readonly issues: z.ZodError['issues'];
  constructor(error: z.ZodError) {
    super(`Invalid model config:\n${z.prettifyError(error)}`);
    this.name = 'ModelConfigError';
    this.issues = error.issues;
  }
}

/** Validate an unknown value as a model config. Throws {@link ModelConfigError} when invalid. */
export function parseModelConfig(input: unknown): ModelConfig {
  const result = modelConfigSchema.safeParse(input);
  if (!result.success) throw new ModelConfigError(result.error);
  return result.data;
}

/** Non-throwing variant of {@link parseModelConfig}. */
export function safeParseModelConfig(input: unknown) {
  return modelConfigSchema.safeParse(input);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** The v0.3 default config, validated once and frozen. Use {@link cloneModelConfig} to edit. */
export const MODEL_CONFIG_V0_3: ModelConfig = deepFreeze(parseModelConfig(rawModelConfigV03));

/** Mutable deep copy of a config (for the backtest or a "what if" run). */
export function cloneModelConfig(config: ModelConfig = MODEL_CONFIG_V0_3): ModelConfig {
  return JSON.parse(JSON.stringify(config)) as ModelConfig;
}

/** Status of a master-plan ID, or `undefined` if the config does not know it. */
export function statusOf(config: ModelConfig, id: string) {
  return (config.status as Record<string, (typeof ID_STATUSES)[number] | undefined>)[id];
}
