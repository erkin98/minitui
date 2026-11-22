import type { AttemptRecord, EvalRow } from './row.js';
import { NON_OUTCOME_STOPS } from './trial.js';

// The decision constants of the effort comparison, approved by the owner on 2026-11-22: each is one line here.
/** Condition 1: the upper end of the paired interval of (high - medium) must be below this. */
export const NON_INFERIORITY_MARGIN = 0.1;
/** Condition 2: medium's mean cost must be at least this share below high's, on both cost measures. */
export const COST_REDUCTION_THRESHOLD = 0.2;
/** Past this share of regression cases out of the paired comparison, the rule is not applied. */
export const EXCLUDED_SHARE_LIMIT = 0.1;

const Z95 = 1.96;

/** A point estimate and its 95% interval, over n values. */
export interface Estimate {
  readonly value: number;
  readonly low: number;
  readonly high: number;
  readonly n: number;
}

const sum = (values: readonly number[]): number => values.reduce((total, v) => total + v, 0);
const mean = (values: readonly number[]): number => sum(values) / values.length;
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** The Wilson score interval of a rate; null over nothing. */
export function wilson(successes: number, n: number): Estimate | null {
  if (n === 0) return null;
  const p = successes / n;
  const z2 = Z95 * Z95;
  const scale = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / scale;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / scale;
  return { value: p, low: clamp01(centre - half), high: clamp01(centre + half), n };
}

/** The exact two-sided McNemar test: twice the binomial tail of the smaller discordant count, at most 1. */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  let tail = 0;
  let coefficient = 1; // C(n, 0)
  for (let k = 0; k <= Math.min(b, c); k += 1) {
    tail += coefficient;
    coefficient = (coefficient * (n - k)) / (k + 1);
  }
  return Math.min(1, 2 * tail * 0.5 ** n);
}

/** Connor's paired-binary sample size at alpha 0.05 two-sided and power 0.8; NaN when ψ is below δ². */
export const connorSize = (delta: number, psi: number): number =>
  (Z95 * Math.sqrt(psi) + 0.84 * Math.sqrt(psi - delta ** 2)) ** 2 / delta ** 2;

// Two-sided 95% Student t values for 1 to 100 degrees of freedom, to three places.
// prettier-ignore
const T_95: readonly number[] = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
  2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
  2.04, 2.037, 2.035, 2.032, 2.03, 2.028, 2.026, 2.024, 2.023, 2.021,
  2.02, 2.018, 2.017, 2.015, 2.014, 2.013, 2.012, 2.011, 2.01, 2.009,
  2.008, 2.007, 2.006, 2.005, 2.004, 2.003, 2.002, 2.002, 2.001, 2.0,
  2.0, 1.999, 1.998, 1.998, 1.997, 1.997, 1.996, 1.995, 1.995, 1.994,
  1.994, 1.993, 1.993, 1.993, 1.992, 1.992, 1.991, 1.991, 1.99, 1.99,
  1.99, 1.989, 1.989, 1.989, 1.988, 1.988, 1.988, 1.987, 1.987, 1.987,
  1.986, 1.986, 1.986, 1.986, 1.985, 1.985, 1.985, 1.984, 1.984, 1.984,
];

/** The two-sided 95% t value. No case set here is larger than the table, so a larger one throws. */
export function tCritical(df: number): number {
  const value = Number.isInteger(df) ? T_95[df - 1] : undefined;
  if (value === undefined) {
    throw new Error(`no 95% t value for ${df} degrees of freedom: the table holds 1 to 100`);
  }
  return value;
}

/** The mean and its 95% t interval with n - 1 degrees of freedom; null under two values. */
export function tInterval(values: readonly number[]): Estimate | null {
  const n = values.length;
  if (n < 2) return null;
  const centre = mean(values);
  const sd = Math.sqrt(sum(values.map((v) => (v - centre) ** 2)) / (n - 1));
  const half = (tCritical(n - 1) * sd) / Math.sqrt(n);
  return { value: centre, low: centre - half, high: centre + half, n };
}

// A seeded generator (mulberry32), so a bootstrap is the same for the same seed.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The percentile bootstrap 95% interval of the mean. Reported beside the t interval, never deciding. */
export function bootstrapInterval(
  values: readonly number[],
  seed: number,
  resamples = 10_000,
): Estimate | null {
  const n = values.length;
  if (n === 0) return null;
  const random = seeded(seed);
  const means = Array.from({ length: resamples }, () => {
    let total = 0;
    for (let i = 0; i < n; i += 1) total += values[Math.floor(random() * n)] ?? 0;
    return total / n;
  }).sort((a, b) => a - b);
  const at = (q: number): number => means[Math.round(q * (resamples - 1))] ?? Number.NaN;
  return { value: mean(values), low: at(0.025), high: at(0.975), n };
}

// ---------------------------------------------------------------------------------------------------
// Rows to per-case outcomes.

/** A trial whose stop is a model outcome; the others are excluded from every rate. */
export const isOutcome = (row: EvalRow): boolean => !NON_OUTCOME_STOPS.includes(row.stop);

export const passRate = (rows: readonly EvalRow[]): number =>
  rows.filter((r) => r.passAll).length / rows.length;

/** The outcome trials of one case in one arm. */
export const outcomesOf = (rows: readonly EvalRow[], caseId: string, arm: string): EvalRow[] =>
  rows.filter((r) => r.caseId === caseId && r.arm === arm && isOutcome(r));

/** The case ids of the rows, in the order first seen. */
export const caseIdsOf = (rows: readonly EvalRow[]): string[] => [
  ...new Set(rows.map((r) => r.caseId)),
];

type NoUsage = NonNullable<AttemptRecord['noUsage']>;

export interface ArmCost {
  readonly trials: number; // outcome trials of the paired cases
  readonly reported: number; // of which every attempt reported usage
  readonly measuredMean: number | null; // over the reported ones
  readonly accountedMean: number | null; // the meter's settled charge, over every outcome trial
  readonly dropped: Partial<Record<NoUsage, number>>; // trials left out, by each reason one of them gave
}

function armCost(rows: readonly EvalRow[]): ArmCost {
  const reported = rows.filter((r) => r.attempts.every((a) => a.usage !== null));
  const dropped: Partial<Record<NoUsage, number>> = {};
  for (const r of rows) {
    for (const reason of new Set(r.attempts.map((a) => a.noUsage))) {
      if (reason !== null) dropped[reason] = (dropped[reason] ?? 0) + 1;
    }
  }
  return {
    trials: rows.length,
    reported: reported.length,
    measuredMean: reported.length === 0 ? null : mean(reported.map((r) => r.cost.measuredUsd)),
    accountedMean: rows.length === 0 ? null : mean(rows.map((r) => r.cost.upperUsd)),
    dropped,
  };
}

export interface Comparison {
  readonly regressionCases: number;
  readonly paired: readonly string[];
  readonly excluded: readonly string[]; // fewer than k outcome trials in either arm
  readonly applied: boolean; // the excluded share is within EXCLUDED_SHARE_LIMIT
  readonly diff: Estimate | null; // paired t interval of the per-case (high - medium) pass-all rate
  readonly bootstrap: Estimate | null; // beside it, never deciding
  readonly nonInferior: boolean | null;
  readonly cost: {
    readonly medium: ArmCost;
    readonly high: ArmCost;
    readonly cheaper: boolean | null; // at least the threshold below high on both measures; null when not comparable
  };
  readonly flagged: readonly string[]; // every high trial passes and every medium trial fails
  readonly mcnemar: { readonly highOnly: number; readonly mediumOnly: number; readonly p: number };
  readonly psi: number | null; // the discordant share of pass^3 over the paired cases
  readonly saturated: boolean; // both arms' mean per-case pass-all at 95% or more
  readonly recommendation: 'send-medium' | 'keep-default' | 'not-applied';
}

const MEDIUM = 'effort-medium';
const HIGH = 'effort-high';
export const BOOTSTRAP_SEED = 56;

// Whether medium's mean is far enough below high's; null when either is missing or high's is zero.
const cheaperBy = (medium: number | null, high: number | null): boolean | null =>
  medium === null || high === null || high === 0
    ? null
    : medium <= (1 - COST_REDUCTION_THRESHOLD) * high;

// Condition 2 holds only on both cost measures. Each alone leans one way: the measured mean leaves out the
// trials with a cut attempt, which are the costliest, so it favours the arm that breaks more; the accounted
// mean prices a cut attempt at its worst case, so it goes the other way. Requiring both can never favour
// medium. A measure that cannot be compared makes the whole condition null, whatever the other says.
// Exported so a test can reach the state compareArms cannot: a null accounted mean beside a measured one.
export function cheaperOf(medium: ArmCost, high: ArmCost): boolean | null {
  const measured = cheaperBy(medium.measuredMean, high.measuredMean);
  const accounted = cheaperBy(medium.accountedMean, high.accountedMean);
  return measured === null || accounted === null ? null : measured && accounted;
}

function recommend(applied: boolean, nonInferior: boolean | null, cheaper: boolean | null) {
  if (!applied) return 'not-applied';
  return nonInferior === true && cheaper === true ? 'send-medium' : 'keep-default';
}

/**
 * The effort comparison over the regression rows of one run: explicit medium against explicit high, the
 * case as the unit, k outcome trials per case and arm. Null when the run lacks either arm.
 */
export function compareArms(rows: readonly EvalRow[], k: number): Comparison | null {
  const regression = rows.filter((r) => r.suite === 'regression');
  const arms = new Set(regression.map((r) => r.arm));
  if (!arms.has(MEDIUM) || !arms.has(HIGH)) return null;
  const ids = caseIdsOf(regression);
  const of = (id: string, arm: string) => outcomesOf(regression, id, arm);
  const paired = ids.filter((id) => of(id, MEDIUM).length >= k && of(id, HIGH).length >= k);
  const excluded = ids.filter((id) => !paired.includes(id));
  const applied = excluded.length / ids.length <= EXCLUDED_SHARE_LIMIT;
  const diffs = paired.map((id) => passRate(of(id, HIGH)) - passRate(of(id, MEDIUM)));
  const diff = tInterval(diffs);
  const nonInferior = diff === null ? null : diff.high < NON_INFERIORITY_MARGIN;
  const medium = armCost(paired.flatMap((id) => of(id, MEDIUM)));
  const high = armCost(paired.flatMap((id) => of(id, HIGH)));
  const cheaper = cheaperOf(medium, high);
  const all = (id: string, arm: string) => of(id, arm).every((r) => r.passAll);
  const none = (id: string, arm: string) => of(id, arm).every((r) => !r.passAll);
  const highOnly = paired.filter((id) => all(id, HIGH) && !all(id, MEDIUM)).length;
  const mediumOnly = paired.filter((id) => all(id, MEDIUM) && !all(id, HIGH)).length;
  const meanRate = (arm: string) => mean(paired.map((id) => passRate(of(id, arm))));
  return {
    regressionCases: ids.length,
    paired,
    excluded,
    applied,
    diff,
    bootstrap: bootstrapInterval(diffs, BOOTSTRAP_SEED),
    nonInferior,
    cost: { medium, high, cheaper },
    flagged: paired.filter((id) => all(id, HIGH) && none(id, MEDIUM)),
    mcnemar: { highOnly, mediumOnly, p: mcnemarExact(highOnly, mediumOnly) },
    psi: paired.length === 0 ? null : (highOnly + mediumOnly) / paired.length,
    saturated: paired.length > 0 && meanRate(MEDIUM) >= 0.95 && meanRate(HIGH) >= 0.95,
    recommendation: recommend(applied, nonInferior, cheaper),
  };
}
