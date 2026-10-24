# Score Lab v0.3 vs master plan v0.3: discrepancies

Recorded by CSN-030. Rule: where the Score Lab's math contradicts the master plan text, the
engine follows the **master plan** (or the textbook definition the plan names) and the Lab
behaviour stays reachable through a config flag. Each entry has a question for the user; the
default holds until the user answers.

Sources: master plan = hub `score-lab/coinsnipe-master-plan` (identical to
`source/scoring-model-master-plan-v0.3.md`). Lab = `score-lab-v0.3.reference.js` (2026-10-23
extract, sha256 `757c60b6…c294`; its script is identical to the hub's Score Lab page apart from
the header comment and the hub sidebar helper, and both produce the same golden). The Lab file is
private, so its behaviour is described here in words, with line numbers in that extract.

**How impact was measured.** `test/oracle/measureImpact.ts` patches one Lab function at a time
inside the vm sandbox with the engine's definition (textbook formula on the Lab's close-only
data). It then compares the Lab's model and combined scores against the unpatched run for all
3 horizons x 3 profiles and 114 sample coins. "Combined" = CoinSnipe Score after gates. To
re-measure:
`SCORE_LAB_REFERENCE_PATH=/abs/path/score-lab-v0.3.reference.js pnpm --filter @coinsnipe/scoring oracle:impact`.

## Summary

| ID   | Topic                                    | Engine default            | Lab setting (config)                   | Read today? | Blocks the +-1 / exact-label golden? |
| ---- | ---------------------------------------- | ------------------------- | -------------------------------------- | ----------- | ------------------------------------ |
| D-01 | Winsorising at 5th/95th percentile       | winsorise                 | `normalization.winsorPct: null`        | yes         | labels only: 1 coin flips label      |
| D-02 | M1 and R6: ranked or fixed scale         | ranked (plan)             | `metricSpec.M1/R6.better: "fixed"`     | yes         | **yes**, almost every coin           |
| D-03 | ADX (M6) definition                      | Wilder ADX                | `indicators.variant: "lab"`            | not yet     | **yes**, up to 7 coins               |
| D-04 | ATR (H2, 5.4 zones) definition           | Wilder ATR, true range    | `indicators.variant: "lab"`            | not yet     | **yes**, 1 coin                      |
| D-05 | RSI (H1) warm-up window                  | full history              | `indicators.variant: "lab"`            | not yet     | **yes** on Long, 2 coins             |
| D-06 | Log vs simple returns (R1, beta for S1)  | log (board text)          | `indicators.returns: "simple"`         | partly      | no                                   |
| D-07 | Which metrics use weekly candles on Long | H1 only (as the Lab)      | `candles.horizonCandleIds`             | not yet     | no (default matches the Lab)         |
| D-08 | Level A sub-score scale (5.1, 5.2)       | z-score vs 1-year history | `levelA.subScore.method: "fixedScale"` | yes         | **yes**, every macro input           |

"Read today?" means whether any code in `src/` reads that key yet. normalize.ts reads the D-01
and D-02 settings now. The `indicators` and `candles` keys are validated but nothing reads them
until CSN-033, CSN-035 and CSN-036 wire them (see "Config keys not yet consumed" below), so today
`indicators.variant: "lab"` changes no output. The Level A settings (D-08 and the notes below it)
are read by `src/levelA/` from CSN-031 on.

**The +-1-point golden target is not reachable with the engine defaults** (D-02 to D-05, plus
D-01 for exact labels, and D-08 for market weather and alt season). CSN-031 to CSN-038 should run
the golden comparison with `test/oracle/labCompat.ts` (`labCompatConfig()`, which sets exactly the
settings above) and pin the master-plan behaviour with their own unit tests. Level A adds
`test/oracle/labLevelACompat.ts` (`labLevelACompatConfig()`: `labCompatConfig()` plus D-08). If the user sides with the Lab on an item, change
the default in `model-config.v0.3.json` instead.

## D-01 Winsorising (master plan 7.1)

- **Master plan 7.1:** "Size metrics are logged first, and all metrics are winsorized at the 5th
  and 95th percentile."
- **Lab (line 630):** ranks each coin's raw value against its peers' raw values. Nothing is
  winsorised.
- **Impact:** Quality max |Δ| 0.40, Timing max 0.55, combined max 0.34. No coin moves by more than
  1 point, but on Short and Medium one coin per profile sits on a label boundary and changes
  label.
- **Where it bites:** with linearly interpolated percentiles (type 7), the 5th-percentile position
  is (n - 1) x 0.05. That reaches 1 at n = 21. From 21 coins with data, the lowest value is clipped
  to (or past) the second-lowest and the two tie; the same happens at the top. A peer group of 20
  or fewer is never changed. In the sample, two kinds of ranking move:
  - All-coins rankings, including small sectors that fall back to all coins.
  - The bank sector, the only sector with 21 coins. Four bank coins move on each of U4, U5, E1, E2,
    E3, E4, T1, T2 and T3. Bank metrics with fewer than 21 coins with data (U1, U2, U3, T5) do not
    move.

  Both thresholds and the bank counts are pinned in `test/normalize.test.ts`.

- **Engine:** winsorises within the peer group actually used (`normalization.winsorPct [5, 95]`).
- **Question:** (a) Confirm winsorising stays. (b) With 5th/95th-percentile bounds, winsorising
  does nothing to a peer group of 20 or fewer coins. In the sample it reaches only the bank sector
  and the all-coins rankings. Is that the intent, or should small sectors be clipped too? That
  would need a different rule, for example clipping a fixed number of coins in each tail.

## D-02 M1 and R6: ranked or fixed scale (master plan 7.1, 7.2, 7.3)

- **Master plan:** the "Better" column says `higher` for M1 ("MA stack: points for price above
  20, 50, 200 and 20 > 50 > 200") and R6 ("Security: audits, past hacks, admin-key risk"), and
  `fixed scale` only for L2 and L4. 7.1 adds "Market access, Price trend and Safety compare with all
  coins", so M1 and R6 are percentile-ranked.
- **Lab (lines 314-315, 628):** both metrics are marked as rule-based, and rule-based metrics skip
  ranking: the point value, clamped to 0-100, is used directly as the score.
- **Impact:** Timing moves by more than 1 point for all 114 coins, by up to 10.0 on Short, 8.4 on
  Medium and 6.7 on Long. Combined max |Δ| is 7.3 / 4.3 / 2.1 (Short / Medium / Long), with
  111 / 112 / 87 coins beyond 1 point and 34 / 22 / 9 label flips. Quadrant flips: 22 / 19 / 13.
  Quality max |Δ| is 1.26 (5 coins beyond 1 point).
- **Engine:** ranks M1 and R6 across all coins (`metricSpec.M1/R6.better: "higher"`).
- **Question:** Should M1 and R6 be ranked against all coins, as the plan reads, or used as point
  scores, as the Lab does? If the Lab is right, the plan's Better column should say "fixed
  scale" for both.

## D-03 ADX(14), M6 (master plan 7.3)

- **Master plan 7.3:** "M6 Trend strength: ADX(14), signed by direction". Textbook (Wilder 1978):
  +DM/-DM from highs and lows, true range, 14-bar sums smoothed as S - S/14 + x, and ADX as a
  Wilder-smoothed DX seeded with the mean of 14 DX values, over the whole history.
- **Lab (lines 405-408):**
  - It measures the up and down moves from consecutive closes only, and uses the absolute close
    change, with a tiny floor, as the true range.
  - Its running sums start from zero 3 x 14 bars back, with no 14-bar seed.
  - ADX is the plain average of the last 14 DX values, not Wilder-smoothed.
- **Impact:** With close-only data the DM and TR inputs are identical (high = low = close), so the
  difference comes from the window, the seed and the ADX smoothing.
  - Raw M6: median difference 2.9 ADX points, up to 34.3 where the sign flips because +DI ≈ -DI.
  - Timing max |Δ| 1.95 / 1.62 / 1.30, with 7 / 5 / 1 coins beyond 1 point.
  - Combined max 1.36 on Short (1 coin beyond 1 point, 1 label flip).
  - Quadrant flips: 6 / 2 / 0.

  Real highs and lows will widen this.

- **Engine:** textbook `indicators.adx` / `adxSeries`. It reproduces the StockCharts ChartSchool
  worked example exactly (see `test/indicators.test.ts`).
- **Question:** Confirm the textbook Wilder ADX on daily high/low/close (recommended).

## D-04 ATR(14), H2 and key-level zones (master plan 7.3, 5.4)

- **Master plan:** H2 "Distance from 20D MA in ATR units"; 5.4 "candidate prices within 0.5 × the
  14-day ATR of each other merge into one zone". ATR is Wilder's average true range.
- **Lab (line 404):** ATR is the plain average of the absolute close-to-close change over the last
  14 days. It uses no highs or lows and no Wilder smoothing.
- **Impact:** Raw H2 differs by a median of 6.6% and up to 24.9%. One coin's Temperature band
  changes on every horizon, which moves Timing by 7-8 points and the combined score by up to 5.6
  (Short) / 3.6 (Medium) / 1.4 (Long), plus one quadrant flip on Long. Bitcoin's key levels did
  not change in the sample. With real data, true range is at least |Δclose|, so ATR grows and H2
  shrinks further.
- **Engine:** Wilder ATR with true range (`indicators.atr`). Its first value is the mean TR of
  bars 1..14, which equals "TR14 / 14" in Wilder's ADX worksheet.
- **Question:** Confirm the Wilder ATR on daily high/low/close for H2 and zone merging
  (recommended).

## D-05 RSI(14) warm-up, H1 (master plan 7.3)

- **Master plan 7.3:** "H1 RSI(14) on the horizon's candles". The textbook Wilder RSI smooths over
  all available history (StockCharts uses at least 250 bars).
- **Lab (line 400):** RSI looks back only 4 x 14 steps, so it uses the last 57 price changes,
  seeded with a simple average. It returns 50 when there is not enough history. The recursion is
  otherwise Wilder's.
- **Impact:** Raw H1 differs by a median of 0.14-0.18 and at most 1.0 RSI point. Short and Medium
  outputs do not change. On Long, 2 coins change Temperature band (Timing ±7, combined up to 1.4,
  2 coins beyond 1 point).
- **Engine:** full history (`indicators.variant: "textbook"` with `rsiWarmupBars: null`). The
  engine reproduces the StockCharts ChartSchool worked example exactly. It returns null rather
  than 50 when history is too short.
- **One defined switch:** `variant: "lab"` selects the Lab's RSI with its fixed 57-change window,
  and the schema then requires `rsiWarmupBars: null`. A non-null value would be a second, competing
  window, so it is rejected. `rsiWarmupBars` applies only to `variant: "textbook"`.
  `rsi(closes, { changes: 57 })` matches the Lab to 1e-9, but the golden run uses `variant: "lab"`.
- **Question:** Full-history Wilder RSI (recommended), or a fixed warm-up window?

## D-06 Log or simple returns: R1 volatility and beta for S1 (board text vs Lab)

- **CSN-030 board text:** "realised volatility (annualised stdev of log returns, 90D)", "beta to
  BTC (cov/var of daily log returns, 90D)". The master plan R1 says only "Realised volatility,
  90D".
- **Lab (lines 410, 567-570):** daily returns are simple returns (price over previous price,
  minus 1), for both volatility and beta.
- **Impact:** R1 differs by a median of 0.6% (max 2.8%) and beta by 0.5% (max 3.9%). Quality max
  |Δ| 0.21, Timing 0.10, combined 0.15. No coin moves beyond 1 point and no label flips.
- **Engine:** log returns (`indicators.returns: "log"`), annualised with sqrt(365). Today only the
  Level A macro-scaling correlation reads the key (log or simple changes that correlation by a
  hair and so the macro weights); R1 and the beta in S1 will read it in CSN-035 and CSN-036.
- **Question:** Confirm log returns (recommended).

## D-07 Weekly candles on the Long horizon: which metrics (master plan 7.3)

- **Master plan 7.3:** "The horizon also sets the candles and the rate-of-change blend: Short uses
  daily candles …, Long weekly with 90D-heavy (10/30/60)". H1: "RSI(14) on the horizon's
  candles".
- **Lab (line 573):** only the RSI steps through every 7th close on the Long horizon. ADX (M6),
  ATR distance (H2), Bollinger (H4) and the moving averages use daily bars on every horizon.
- **Impact:** None with the current default, which matches the Lab. Not measured for the
  alternative, which would change Long-horizon Timing substantially.
- **Engine:** `candles.horizonCandleIds: ["H1"]`, because H1 is the only ID whose plan text
  names the horizon's candles. Weekly candles are built aligned to the scoring day
  (`resampleCandles`, `sampleEvery`).
- **Question:** On Long, should M6 (ADX) and H2 / H4 also use weekly candles?

## D-08 Level A sub-score scale (master plan 5.1, 5.2; CSN-031)

- **Master plan 5.1:** "Each input becomes a sub-score from -100 to +100 (clamped against its own
  1-year history), then a weighted sum." The CSN-031 brief reads this as either the value's
  position between the 1-year minimum and maximum, or a z-score clipped to +-2 and scaled x50, and
  asks for whichever the Lab uses.
- **Lab (lines 423-431, 450-451):** neither. Every input is divided by its own fixed constant and
  clamped to +-100, about a neutral point that is 0 for most inputs and differs for a few (Fear &
  Greed, VIX, GPR, the two M2 changes). The sample has no 1-year macro history, so the Lab could not have used one. C2 and C3
  use the same idea with their own constants. The constants are not in `src/` or the model config: they sit
  only in the fixture `test/oracle/__fixtures__/SAMPLE_labLevelAScale.v0.3.json`.
- **Impact:** Market weather and alt season cannot be reproduced from the plan text on the golden:
  the golden carries one scalar per macro input and no history. Only A1 (from the golden's 1500
  days of BTC closes) can be compared: today A1 is 100 under the Lab, 100 under the z-score
  method and 89.6 under min-max; a week earlier 100, 100 and 85.7. A1's BTC-vs-200D-average and
  50D-slope readings are both far above their own 1-year range in the sample, so the z-score
  clips them, as the Lab's constants do. Nothing else could be measured.
- **Engine:** `levelA.subScore.method` is one of three, all of the form
  `direction x clamp((value - centre) / unit x 100, -100, +100)`:
  - `zscore` (default): centre = 1-year mean, unit = `zClip` (2) x the sample standard deviation,
    i.e. exactly "z clipped to +-2, x50". This is the reading closest to the Lab, whose fixed
    constant plays the part of "two standard deviations".
  - `minmax`: centre = mid-range, unit = half the range, i.e. the position between min and max.
  - `fixedScale`: the Lab's constants. They are **not** in `model-config.v0.3.json` (the table is
    null there, and the schema refuses `fixedScale` without a complete one). They live in
    that SAMPLE_ fixture, loaded by `test/oracle/labLevelACompat.ts`, which is how the golden comparison reaches the Lab to
    floating-point noise (max difference about 1e-14 on the scores).
  - History is the measure's value on each of the `historyDays` (365) days before asOf, at least
    `minHistory` (10) of them; a measure without enough history is dropped and the input
    reweighted (it is listed as `noHistory`). A natural neutral point overrides the centre: GPR
    uses the plan's baseline of 100 (`levelA.market.gprBaseline`).
- **Question:** (a) z-score (recommended), min-max, or keep the Lab's fixed constants for launch?
  (b) With monthly series (M2, GPR) the 1-year history is 12 points; is `minHistory` 10 acceptable?
  The backtest (CSN-040) should compare the three.

### Related Level A choices (no contradiction with the plan, but the plan is silent or the Lab differs)

- **Weights inside an input (A3, A4, A6, A7).** The plan gives the split only for A1 (40/30/30),
  A8 (60/40) and A9 (50/50). For the rest the engine takes the Lab's: A3 funding 30, open interest
  30, Fear & Greed 40; A4 Nasdaq 35, S&P 35, VIX 30; A6 dollar 60, yield 40; A7 oil 70, gold 30.
  All sit in `levelA.market.parts`. Question: keep the Lab's splits?
- **A8 lag.** The plan says crypto follows M2 by about 10 weeks. The Lab ignores this (it uses the
  M2 values as given). The engine, given an M2 level series, uses the observation at or before
  asOf minus `levelA.market.m2LagDays` (70) and computes the 3-month and yearly change from it.
  Pre-computed changes are used as given (the data layer owns the lag then). An observation more
  than 45 days away from the date it should stand for is treated as absent (not a model
  parameter; M2 is monthly).
- **A3 funding "inverted above 0.03% per 8h".** Up to the threshold a higher rate scores higher;
  above it, the excess over 0.03 scores negative on the same scale (the Lab does the same, with
  its own unit of 0.03). The plan's "above" is strict, so exactly 0.03 stays on the first branch
  (the Lab puts it on the second, scoring 0). The score jumps at the threshold, as in the Lab.
- **A9 "unconfirmed speculation scores 0".** The tone is the mean over the regulation headlines
  with an unconfirmed one counting as 0 (it still counts as a headline). An explicit tone from the
  data layer wins over headlines. The Lab takes the tone as a given number.
- **Macro scaling.** Correlation is floored at `market.corrFloor` and capped at 1 (the Lab
  floors only). The freed weight goes to the present inputs of A1-A3 pro rata to their weights;
  if none is present it is dropped and the rest rescaled. The engine computes the 90-day
  correlation of daily returns from aligned BTC and Nasdaq closes (`indicators.correlationDays`,
  `indicators.returns`) when it is not supplied. With no correlation at all the plan weights stay
  (`levelA.market.corrMissing: "none"`; `"floor"` applies the floor instead).
- **Missing inputs.** The Lab has no such case. The engine drops the input and rescales the others
  to 100 (listed in `missingInputs`); a partly-missing input is reweighted inside (`partial`).
- **C1 stablecoins.** The plan says "excluding gold tokens"; the brief adds stablecoins. The Lab
  excludes only Bitcoin and the gold tokens (`cycle.dex`), and the sample has no stablecoin, so
  the golden is unaffected. The engine also drops the symbols in `levelA.cycle.stablecoins` and
  any coin flagged `isStablecoin`; excluded coins do not use up a top-50 place. Alts without a
  90-day return are not counted either way.
- **A10.** Flag only. "Large" unlock = at least `levelA.market.events.largeUnlockPct` (1) percent
  of supply (the SG7 text uses 1%); an unlock of unknown size is not called large.

## Config keys not yet consumed (contract)

`PENDING_CONFIG_KEYS` in `src/config/schema.ts` lists every `indicators.*` and `candles.*` key
with the task that will read it. A test in `test/config.test.ts` fails if a key is added without
an entry. Nothing in `src/` reads these keys today, so editing them changes no output. Each
consuming task removes its entries when it wires them.

| Keys                                                             | Consumed by                               |
| ---------------------------------------------------------------- | ----------------------------------------- |
| `indicators.variant`                                             | CSN-036 (H1, H2, M6), CSN-033 (zone ATR)  |
| `indicators.rsiPeriod`, `rsiWarmupBars`                          | CSN-036 (H1)                              |
| `indicators.atrPeriod`                                           | CSN-036 (H2), CSN-033 (5.4 zone merging)  |
| `indicators.adxPeriod`, `upDownVolumeDays`                       | CSN-036 (M6, M7)                          |
| `indicators.bollingerPeriod`, `bollingerK`                       | CSN-036 (H4)                              |
| `indicators.betaDays`                                            | CSN-036 (beta in S1)                      |
| `indicators.annualisationDays`, `volatilityDays`, `drawdownDays` | CSN-035 (R1, R2)                          |
| `indicators.pivotBars`                                           | CSN-033 (K1)                              |
| `candles.short`, `medium`, `long`, `horizonCandleIds`            | CSN-036 (H1 on the horizon's candles)     |
| `candles.weeklyBars`                                             | CSN-036 (weekly RSI), CSN-033 (K1 weekly) |

Already read by Level A (CSN-031), so not in the table: `indicators.correlationDays` and
`indicators.returns` (the macro-scaling correlation). CSN-035 and CSN-036 will read `returns` too.

Precedence: `indicators.variant` picks the implementation of RSI, ATR and ADX. The Lab ports have
fixed windows, so `variant: "lab"` requires `rsiWarmupBars: null` (enforced by the schema). The
period keys apply to both variants. `returns` and the `candles` keys are independent of
`variant`.

## Interpretations (no contradiction; recorded so the choice is visible)

- **Percentile rank, ties averaged:** (count below + ½ count equal) / n x 100, as in the Lab's
  percentile-rank helper (line 413). With n distinct values the range is 50/n to 100 - 50/n, so no
  coin reaches exactly 0 or 100.
- **"Fewer than 8 peers have data" (D16):** the coin itself counts toward the 8, as in the Lab
  (line 629, where the sector group being counted includes the coin).
  `normalization.peerCountIncludesSelf: false` requires 8 other coins. Gold, payments, real-world
  and networks have 7 sample coins each, so they always fall back to all coins.
- **Log transform (U5, R4)** is monotone, so it changes neither ranks nor which values winsorising
  clips. Scores are identical with or without it. It is kept because the plan asks for it. Growth
  metrics (U1, U2, U3, E3) can be negative and are never logged; the schema rejects them in
  `logIds`.
- **M7 up/down volume:** an unchanged close counts as an up day, and when there is no down-day
  volume the up-day volume is divided by 1 (Lab line 566). The engine does the same by default
  (`flatDays: 'up'`).
- **RSI with no movement at all** is 50 in the engine; the Lab returns 100 whenever the average
  loss is 0.
- **True range of the first bar** needs a previous close, so the first ATR averages bars 1..14,
  matching Wilder's ADX worksheet. The StockCharts ATR page also counts bar 0's high - low.
- **K1 pivots on an outside bar** (the highest high and the lowest low of its window) are
  reported as both a pivot high and a pivot low, so the bar yields a resistance and a support
  candidate. On the Lab's close-only data a bar can never be both, so the golden is unaffected.
- **G4 coverage:** `weightedAverage` counts every positive-weight item it is given. For G4 the
  caller must pass only the metrics that apply to the coin, as the Lab's applicability rule does
  (lines 587-595): no U2/E4 outside deposit sectors, no fee metrics without revenue, no T4 for
  non-stakeable coins, and the meme exclusions. G4 is owned by CSN-036.

## Noticed outside CSN-030's scope (not measured; the owner task should confirm, measure and record)

- **5.1 (CSN-031):** recorded and handled as D-08 above.
- **5.3 (CSN-032):** the plan builds Regime from "A1 Bitcoin trend + price vs 200-week MA". The
  Lab's regime rule (line 675) uses the 200D MA and the 50D slope only. The plan wants base rates
  for 9 Regime x Fuel states, but the Lab computes them by regime alone (line 690, marked there as
  a sample simplification).
- **7.5 (CSN-037):**
  - P2: the plan says "Fees growth minus price change, 90D; P/F vs sector median". The Lab uses
    revenue growth and revenue yield (line 654).
  - P3 Crowded: the plan says "Heat above 80 or most of the sector Overheated". The Lab checks
    heat above 80 only (line 655).
  - Headroom band: the plan says High needs "P1 and P2 both 65+ and nothing blocks it". In the Lab
    only the supply block stops High, and a missing P2 falls back to Usage of at least 60 (lines
    665-666).
  - Hype-driven: the plan says "Meme sector, or no usage data and attention-driven". The Lab uses
    the meme sector only (line 598).
- **9 (CSN-038):** the plan's SG8 is "Volume ÷ market cap above 3× its 30D average". The Lab's
  SG8 compares volume with its own 30D average volume (line 743).
- **decisions.md D13 (CSN-036):** the accepted new gate G6 "Regulatory action" (cap 50) is in
  neither the Lab nor this config yet.
