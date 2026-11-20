/**
 * Level B phase: Heating up / Steady / Cooling down, with hysteresis (master plan section 6).
 *
 * Raw phase from today's Heat and the Heat 14 days earlier (config `sector`):
 *   - Heating up   when Heat rose by MORE than `phaseDelta` (5) and today's Heat is ABOVE `minHeat` (45);
 *   - Cooling down when Heat fell by MORE than `phaseDelta`, or it is falling (any amount) from a
 *                  level ABOVE `highHeat` (70);
 *   - Steady       otherwise.
 * Every comparison is strict, so exactly 5, exactly 45 and exactly 70 do not trip a rule.
 *
 * Hysteresis (decision D20, config `sector.hysteresis`, 3 days): the published phase changes
 * only after `hysteresis` consecutive days of the same different raw phase. {@link advancePhase}
 * is a pure state machine: previous state + today's raw phase in, new state out. CSN-039
 * persists the state in sector_heat_daily / narrative_heat_daily; nothing here reads a clock
 * or a store. It describes data only; it never advises.
 */
import type { ModelConfig } from '../config/schema';

export const PHASES = ['Heating up', 'Steady', 'Cooling down'] as const;
export type Phase = (typeof PHASES)[number];

/** The slice of the model config the phase rules read. */
export type PhaseRules = Pick<ModelConfig['sector'], 'phaseDelta' | 'minHeat' | 'highHeat'>;

/**
 * Raw (same-day) phase. A missing Heat on either day gives `Steady`: there is no evidence of a
 * move (the Lab's NaN comparisons fall through to Steady the same way).
 */
export function rawPhase(
  now: number | null | undefined,
  prev: number | null | undefined,
  rules: PhaseRules,
): Phase {
  if (typeof now !== 'number' || typeof prev !== 'number') return 'Steady';
  if (!Number.isFinite(now) || !Number.isFinite(prev)) return 'Steady';
  const d = now - prev;
  if (d > rules.phaseDelta && now > rules.minHeat) return 'Heating up';
  if (d < -rules.phaseDelta || (prev > rules.highHeat && d < 0)) return 'Cooling down';
  return 'Steady';
}

/** What is persisted per group between days. */
export interface PhaseState {
  /** The published phase. */
  readonly phase: Phase;
  /** The different raw phase currently being counted, or null when raw agrees with `phase`. */
  readonly pendingPhase: Phase | null;
  /** Consecutive days `pendingPhase` has been the raw phase (0 when there is none). */
  readonly pendingDays: number;
}

/** A group with no history yet starts Steady with nothing pending. */
export const INITIAL_PHASE_STATE: PhaseState = Object.freeze({
  phase: 'Steady',
  pendingPhase: null,
  pendingDays: 0,
});

function assertHysteresis(h: number): void {
  if (!Number.isInteger(h) || h < 1)
    throw new RangeError(`hysteresis must be an integer >= 1, got ${h}`);
}

/**
 * One day of the state machine.
 *  - raw equals the published phase: the counter resets (a reversal cancels a pending change);
 *  - raw equals the pending phase: the counter grows, and at `hysteresis` days the phase flips;
 *  - raw is another phase: it becomes the pending one, counted from 1 (a flip at once when
 *    `hysteresis` is 1).
 * `previous` null/undefined means no history: {@link INITIAL_PHASE_STATE}.
 */
export function advancePhase(
  previous: PhaseState | null | undefined,
  raw: Phase,
  hysteresis: number,
): PhaseState {
  assertHysteresis(hysteresis);
  const prev = previous ?? INITIAL_PHASE_STATE;
  if (raw === prev.phase) return { phase: prev.phase, pendingPhase: null, pendingDays: 0 };
  const days = raw === prev.pendingPhase ? prev.pendingDays + 1 : 1;
  if (days >= hysteresis) return { phase: raw, pendingPhase: null, pendingDays: 0 };
  return { phase: prev.phase, pendingPhase: raw, pendingDays: days };
}

/**
 * Replay raw phases (oldest first) from the initial state. Used to seed a state from history
 * and by tests; production advances one day at a time with {@link advancePhase}.
 */
export function replayPhases(raws: readonly Phase[], hysteresis: number): PhaseState {
  let state: PhaseState = INITIAL_PHASE_STATE;
  for (const r of raws) state = advancePhase(state, r, hysteresis);
  return state;
}

/**
 * Stateless snapshot used when no stored state exists, and by the Score Lab golden: the phase
 * is the raw phase of the last `hysteresis` days when they all agree, otherwise Steady.
 */
export function windowPhase(lastRaws: readonly Phase[]): Phase {
  if (lastRaws.length === 0) return 'Steady';
  const first = lastRaws[0]!;
  return lastRaws.every((p) => p === first) ? first : 'Steady';
}
