/**
 * Lab-compatibility config for the golden comparison (test code only).
 *
 * The engine default follows the master plan and textbook indicator definitions. Where the
 * Score Lab differs (packages/scoring/DISCREPANCIES.md), the default config would miss the
 * golden's +-1 point / exact-label target, so CSN-031 to CSN-038 run the golden comparison with
 * this variant and pin the master-plan behaviour with their own unit tests. Each override names
 * the DISCREPANCIES.md entry it undoes.
 *
 * What takes effect today: only the normalisation overrides (D-01, D-02), because normalize.ts is
 * the only code that reads the config so far. The `indicators` overrides (D-03 to D-06) are set
 * here so the golden run is already configured, but nothing reads those keys yet; they take
 * effect when CSN-033/035/036 wire them (see PENDING_CONFIG_KEYS in src/config/schema.ts).
 */
import { cloneModelConfig, type ModelConfig } from '../../src/config/schema';

export function labCompatConfig(base?: ModelConfig): ModelConfig {
  const cfg = cloneModelConfig(base);
  // D-01 (in effect): the Lab ranks raw values without winsorising.
  cfg.normalization.winsorPct = null;
  // D-02 (in effect): the Lab scores M1 and R6 on their fixed 0-100 point scale.
  cfg.metricSpec.M1 = { pillar: 'M', better: 'fixed', range: [0, 100] };
  cfg.metricSpec.R6 = { pillar: 'R', better: 'fixed', range: [0, 100] };
  // D-03 to D-05 (not read yet): Lab RSI / ATR / ADX ports. Under 'lab' the RSI window is fixed,
  // so rsiWarmupBars must stay null (the schema rejects anything else).
  cfg.indicators.variant = 'lab';
  cfg.indicators.rsiWarmupBars = null;
  // D-06 (not read yet): simple, not log, daily returns.
  cfg.indicators.returns = 'simple';
  return cfg;
}
