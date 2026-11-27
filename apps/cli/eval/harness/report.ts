import type { Effort } from '@minitui/agent-core';
import type { AttemptRecord, EvalRow, Lane } from './row.js';
import {
  COST_REDUCTION_THRESHOLD,
  EXCLUDED_SHARE_LIMIT,
  NON_INFERIORITY_MARGIN,
  caseIdsOf,
  compareArms,
  connorSize,
  isOutcome,
  outcomesOf,
  passRate,
  tInterval,
  wilson,
  type ArmCost,
  type Comparison,
  type Estimate,
} from './stats.js';
import type { StopKind } from './trial.js';

// The report of one run, from host-written values only: ids, stops, counts and numbers. No reply, error
// message or other model text reaches it.

export interface ReportMeta {
  readonly runId: string;
  readonly lane: Lane;
  readonly provider: string;
  readonly model: string;
  readonly caseSetVersion: number;
  readonly caseSetStatus: 'draft' | 'approved';
  readonly gradingVersion: number;
  readonly arms: readonly Effort[];
  readonly trials: number; // k
  readonly concurrency: number;
  readonly regressionCases: readonly string[]; // the regression cases the run selected, in selection order
  readonly loadedRegressionCases: number; // the regression cases of the loaded case set, selected or not
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const est = (e: Estimate | null): string =>
  e === null ? 'n/a' : `${pct(e.value)} [${pct(e.low)}, ${pct(e.high)}]`;
const usd = (value: number | null): string => (value === null ? 'n/a' : `$${value.toFixed(6)}`);
const yesNo = (value: boolean | null): string => (value === null ? 'n/a' : value ? 'yes' : 'no');
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function table(head: readonly string[], body: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `|${cells.join('|')}|`;
  return [line(head), line(head.map(() => '-')), ...body.map(line)].join('\n');
}

const armOf = (arm: Effort): string => `effort-${arm}`;
const rowsOf = (rows: readonly EvalRow[], arm: string): EvalRow[] =>
  rows.filter((r) => r.arm === arm);
const firstValid = (r: EvalRow): boolean => r.stop === 'valid' && r.attempts.length === 1;
const tokens = (r: EvalRow): number => r.usage.inputTokens + r.usage.outputTokens;

// The cases of an arm with all k outcome trials: the unit of pass^k and of every per-case mean.
const completeCases = (rows: readonly EvalRow[], arm: string, k: number): string[] =>
  caseIdsOf(rows).filter((id) => outcomesOf(rows, id, arm).length >= k);

// The stop kinds, in the columns the report gives them. Each list is checked against StopKind, and every
// StopKind is in one of the two, so a new stop kind fails the type check here and not a report.
const OUTCOME_STOPS = [
  'valid',
  'exhausted',
  'turn-deadline',
] as const satisfies readonly StopKind[];
const OTHER_STOPS = [
  'spend-cap',
  'timeout',
  'harness-error',
  'provider-error',
] as const satisfies readonly StopKind[];
type UnlistedStop = Exclude<StopKind, (typeof OUTCOME_STOPS | typeof OTHER_STOPS)[number]>;
const _everyStopListed: [UnlistedStop] extends [never] ? true : false = true;

function header(meta: ReportMeta): string {
  const lines = [
    `# Model-output eval: run ${meta.runId}`,
    '',
    `- Lane: ${meta.lane}; provider ${meta.provider}, model ${meta.model}.`,
    `- Case set version ${meta.caseSetVersion} (${meta.caseSetStatus}); grading version ${meta.gradingVersion}.`,
    `- Arms: ${meta.arms.map(armOf).join(', ')}; ${plural(meta.trials, 'trial')} per case and arm; concurrency ${meta.concurrency}.`,
    '- The comparison covers explicit medium against explicit high: no arm sends no effort, so the model’s own default is not measured.',
  ];
  if (meta.concurrency > 1) {
    lines.push(
      '- With more than one trial in flight, a provider warning can land in another trial’s lines of diagnostics.log.',
    );
  }
  return lines.join('\n');
}

// How many of the selected regression cases each arm has all k outcome trials of, against how many were
// selected: a run the spend cap stops early shows it here. Nothing when no regression case was selected.
function regressionReach(rows: readonly EvalRow[], meta: ReportMeta): string[] {
  const { regressionCases, trials } = meta;
  if (regressionCases.length === 0) return [];
  const arms = meta.arms.map((effort) => {
    const arm = armOf(effort);
    const reached = regressionCases.filter((id) => outcomesOf(rows, id, arm).length >= trials);
    return `${arm} ${reached.length} of ${regressionCases.length} selected regression cases`;
  });
  return [`Regression cases with all ${trials} outcome trials: ${arms.join('; ')}.`, ''];
}

function headline(rows: readonly EvalRow[], meta: ReportMeta): string {
  const body = meta.arms.map((effort) => {
    const arm = armOf(effort);
    const all = rowsOf(rows, arm);
    const outcomes = all.filter(isOutcome);
    const complete = completeCases(all, arm, meta.trials);
    const count = (test: (r: EvalRow) => boolean) => outcomes.filter(test).length;
    const passK = complete.filter((id) => outcomesOf(all, id, arm).every((r) => r.passAll));
    return [
      arm,
      String(caseIdsOf(all).length),
      String(all.length),
      String(outcomes.length),
      est(wilson(count(firstValid), outcomes.length)),
      est(
        wilson(
          count((r) => r.stop === 'valid'),
          outcomes.length,
        ),
      ),
      est(
        wilson(
          count((r) => r.passAll),
          outcomes.length,
        ),
      ),
      est(wilson(passK.length, complete.length)),
      est(tInterval(complete.map((id) => passRate(outcomesOf(all, id, arm))))),
    ];
  });
  const excluded = meta.arms.map((effort) => [
    armOf(effort),
    ...[...OTHER_STOPS, 'turn-deadline'].map((stop) =>
      String(rowsOf(rows, armOf(effort)).filter((r) => r.stop === stop).length),
    ),
  ]);
  const suites = (['regression', 'capability'] as const).filter((suite) =>
    rows.some((r) => r.suite === suite),
  );
  return [
    '## Headline numbers per arm',
    '',
    `Suites: ${suites.join(', ')}.`,
    '',
    `Trial-level rates are over outcome trials, with Wilson 95% intervals (descriptive: the trials of one case are correlated). pass^${meta.trials} (Wilson over cases) and the mean per-case pass-all rate (95% t interval) are over the cases with all k outcome trials.`,
    '',
    ...regressionReach(rows, meta),
    table(
      [
        'arm',
        'cases',
        'trials',
        'outcome trials',
        'first-attempt valid',
        'valid within 6',
        'pass-all',
        `pass^${meta.trials}`,
        'mean per-case pass-all',
      ],
      body,
    ),
    '',
    'Excluded trials by stop (not model outcomes, never counted as fails); turn-deadline trials are model outcomes and count as fails:',
    '',
    table(['arm', ...OTHER_STOPS, 'turn-deadline (fails)'], excluded),
  ].join('\n');
}

function costLine(name: string, cost: ArmCost): string {
  const reasons = Object.entries(cost.dropped).map(
    ([reason, n]) => `${reason} ${pct(n / cost.trials)}`,
  );
  return `${name}: ${cost.reported} of ${cost.trials} outcome trials kept; dropped by reason: ${reasons.length === 0 ? 'none' : reasons.join(', ')}`;
}

function recommendationLine(c: Comparison, k: number): string {
  if (!c.preRegisteredSize) {
    return `- Recommendation: not applied: not the pre-registered size (${c.regressionCases} of ${c.loadedRegressionCases} regression cases, k = ${k}). The figures above are descriptive.`;
  }
  if (c.recommendation === 'not-applied') {
    return `- Recommendation: not applied: ${c.excluded.length} of ${c.regressionCases} regression cases (more than ${pct(EXCLUDED_SHARE_LIMIT)}) left the paired comparison.`;
  }
  const what =
    c.recommendation === 'send-medium'
      ? 'send medium by default'
      : 'keep the model’s own default (send no effort)';
  return `- Recommendation: ${what}. This is a recommendation to the owner; no default changes here.`;
}

function connorLine(psi: number | null): string {
  if (psi === null || psi === 0) return '- Discordant share ψ: none, so no Connor size.';
  const size = (delta: number): string => {
    const n = connorSize(delta, psi);
    return Number.isFinite(n) ? String(Math.ceil(n)) : 'n/a';
  };
  return `- Discordant share ψ = ${psi.toFixed(3)}; Connor size at this ψ (alpha 0.05, power 0.8): δ 0.10 needs ${size(0.1)} cases, δ 0.20 needs ${size(0.2)}.`;
}

// The ids of the cases that left the paired comparison, and how many of them have no row at all.
function excludedTail(c: Comparison): string {
  if (c.excluded.length === 0) return '';
  const never = c.neverRan.length === 0 ? '' : `; ${c.neverRan.length} of them never ran`;
  return `: ${c.excluded.join(', ')}${never}`;
}

function comparison(rows: readonly EvalRow[], meta: ReportMeta): string {
  const k = meta.trials;
  const c = compareArms(rows, k, meta.regressionCases, meta.loadedRegressionCases);
  if (c === null) {
    return '## The comparison\n\nNo comparison: the run has not both effort-medium and effort-high.';
  }
  const lines = [
    `- ${c.excluded.length} of ${c.regressionCases} regression cases left the paired comparison (fewer than ${plural(k, 'outcome trial')} in an arm)${excludedTail(c)}.`,
    `- Condition 1, non-inferior: high minus medium per-case pass-all ${est(c.diff)} (t, n - 1 degrees of freedom); bootstrap, beside it and never deciding, ${est(c.bootstrap)}; upper end below ${pct(NON_INFERIORITY_MARGIN)}: ${yesNo(c.nonInferior)}.`,
    `- Condition 2, cheaper: medium at least ${pct(COST_REDUCTION_THRESHOLD)} below high on both cost measures: ${yesNo(c.cost.cheaper)}.`,
    `  - mean measured cost per outcome trial whose every attempt reported usage: medium ${usd(c.cost.medium.measuredMean)} against high ${usd(c.cost.high.measuredMean)}.`,
    `  - mean accounted cost per outcome trial, the settled charge of the meter over every outcome trial: medium ${usd(c.cost.medium.accountedMean)} against high ${usd(c.cost.high.accountedMean)}.`,
    `  - ${costLine('medium', c.cost.medium)}`,
    `  - ${costLine('high', c.cost.high)}`,
    `- Flagged (every high trial passes, every medium trial fails): ${c.flagged.length === 0 ? 'none' : c.flagged.join(', ')}.`,
    `- McNemar exact on pass^${k}: high only ${c.mcnemar.highOnly}, medium only ${c.mcnemar.mediumOnly}, p = ${c.mcnemar.p.toPrecision(4)}.`,
    connorLine(c.psi),
  ];
  if (c.saturated) {
    lines.push(
      '- Saturated: both arms pass 95% or more; the recommendation covers these cases only.',
    );
  }
  lines.push(recommendationLine(c, k));
  return `## The comparison\n\n${lines.join('\n')}`;
}

// What a passing hostile case means: the check cannot fail on a valid spec, since the catalog admits
// no other action.
const HOSTILE_PASS =
  'A hostile case that passes built a normal merge app: the catalog, not the model, refuses the forbidden action.';

function perCase(rows: readonly EvalRow[], meta: ReportMeta): string {
  const body = caseIdsOf(rows).map((id) => {
    const of = rows.filter((r) => r.caseId === id);
    const cells = meta.arms.flatMap((effort) => {
      const outcomes = outcomesOf(of, id, armOf(effort));
      const passed = outcomes.filter((r) => r.passAll).length;
      const passK = outcomes.length < meta.trials ? '-' : yesNo(passed === outcomes.length);
      return [`${passed}/${outcomes.length}`, passK];
    });
    return [id, of[0]?.suite ?? '', ...cells, String(of.filter((r) => !isOutcome(r)).length)];
  });
  const head = meta.arms.flatMap((effort) => [
    `${armOf(effort)} pass-all`,
    `${armOf(effort)} pass^${meta.trials}`,
  ]);
  return `## Per case\n\n${table(['case', 'suite', ...head, 'excluded trials'], body)}\n\n${HOSTILE_PASS}`;
}

const CLASSES = ['structural', 'catalog', 'semantic'] as const;
const NEXT = [...CLASSES, 'valid', 'turn-deadline', 'ended otherwise'] as const;

function nextColumn(row: EvalRow, next: AttemptRecord, last: boolean): (typeof NEXT)[number] {
  if (next.failure !== null) return next.failure;
  if (next.noUsage === 'deadline') return 'turn-deadline';
  return last && row.stop === 'valid' ? 'valid' : 'ended otherwise';
}

function transitions(rows: readonly EvalRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    row.attempts.forEach((attempt, i) => {
      const next = row.attempts[i + 1];
      if (attempt.failure === null || next === undefined) return;
      const key = `${attempt.failure}>${nextColumn(row, next, i + 2 === row.attempts.length)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
  }
  const body = CLASSES.map((from) => [
    from,
    ...NEXT.map((to) => String(counts.get(`${from}>${to}`) ?? 0)),
  ]);
  return `## Transitions between attempts\n\nRows: the class of attempt k; columns: what attempt k + 1 was.\n\n${table(['attempt k', ...NEXT], body)}`;
}

// A trial counts under its cause when the case decides that cause (a missing component or action, or
// model-written code: every stop, a provider refusal included), or when it is a model outcome.
const countsUnderCause = (r: EvalRow): boolean =>
  isOutcome(r) || (r.cause !== null && r.cause !== 'pass' && r.cause !== 'model-error');

function coverage(rows: readonly EvalRow[]): string {
  const capability = rows.filter((r) => r.suite === 'capability');
  const counted = capability.filter(countsUnderCause);
  const counts = (of: readonly EvalRow[], stops: readonly string[]) =>
    stops.map((stop) => String(of.filter((r) => r.stop === stop).length));
  const stops = [...OUTCOME_STOPS, ...OTHER_STOPS];
  const byCause = [...new Set(counted.map((r) => r.cause))].map((cause) => {
    const of = counted.filter((r) => r.cause === cause);
    return [String(cause), String(of.length), ...counts(of, stops)];
  });
  const others = capability.filter((r) => !countsUnderCause(r));
  const notOutcome = [
    'not an outcome',
    String(others.length),
    ...OUTCOME_STOPS.map(() => '0'),
    ...counts(others, OTHER_STOPS),
  ];
  return `## Capability coverage\n\nCause counts over capability trials, and what each ended in. A missing component or action, or model-written code, is the case's cause and counts every trial: a valid spec there is a false build, a provider-error a refusal. Pass and model-error count only model outcomes; the other trials are counted by stop kind only, under no cause.\n\n${table(['cause', 'trials', ...stops], [...byCause, notOutcome])}`;
}

function firstBuild(rows: readonly EvalRow[], meta: ReportMeta): string {
  const arm = 'effort-high';
  const k = meta.trials;
  const high = rows.filter((r) => r.arm === arm && r.suite === 'regression');
  if (high.length === 0) {
    return '## First-build success rate\n\nNo effort-high regression trials in this run.';
  }
  const cases = completeCases(high, arm, k);
  const perCaseRate = (test: (r: EvalRow) => boolean) =>
    tInterval(
      cases.map((id) => {
        const outcomes = outcomesOf(high, id, arm);
        return outcomes.filter(test).length / outcomes.length;
      }),
    );
  const outcomes = high.filter(isOutcome);
  return [
    '## First-build success rate',
    '',
    `effort-high, regression suite, ${cases.length} of ${meta.regressionCases.length} selected regression cases with all ${k} outcome trials; per-case means with their 95% t intervals.`,
    '',
    `- Pass-all within the six attempts of one first generation: ${est(perCaseRate((r) => r.passAll))}; over the ${plural(outcomes.length, 'outcome trial')} (Wilson, descriptive): ${est(wilson(outcomes.filter((r) => r.passAll).length, outcomes.length))}.`,
    `- Valid within six attempts: ${est(perCaseRate((r) => r.stop === 'valid'))}.`,
    `- Valid on the first attempt: ${est(perCaseRate(firstValid))}.`,
  ].join('\n');
}

function costAndLatency(rows: readonly EvalRow[], meta: ReportMeta): string {
  const body = meta.arms.map((effort) => {
    const all = rowsOf(rows, armOf(effort));
    const outcomes = all.filter(isOutcome);
    const total = (pick: (r: EvalRow) => number) => all.reduce((s, r) => s + pick(r), 0);
    const meanOf = (values: readonly number[]) =>
      values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
    const seconds = all.map((r) => r.durationMs / 1000);
    return [
      armOf(effort),
      String(all.length),
      usd(total((r) => r.cost.measuredUsd)),
      usd(total((r) => r.cost.upperUsd)),
      usd(meanOf(outcomes.map((r) => r.cost.measuredUsd))),
      (meanOf(all.map((r) => r.attempts.length)) ?? 0).toFixed(2),
      (meanOf(seconds) ?? 0).toFixed(1),
      Math.max(0, ...seconds).toFixed(1),
    ];
  });
  return `## Cost and latency\n\n${table(
    [
      'arm',
      'trials',
      'measured total',
      'accounted total',
      'mean measured per outcome trial (all)',
      'mean attempts',
      'mean seconds',
      'max seconds',
    ],
    body,
  )}`;
}

function failed(rows: readonly EvalRow[]): string {
  const list = rows
    .filter((r) => isOutcome(r) && !r.passAll)
    .toSorted((a, b) => a.attempts.length - b.attempts.length || tokens(a) - tokens(b))
    .map((r) => {
      const checks = r.checks.filter((c) => !c.diagnostic && !c.pass).map((c) => c.name);
      return `- ${r.caseId} ${r.arm} trial ${r.trial}: ${r.stop}, ${plural(r.attempts.length, 'attempt')}, ${plural(tokens(r), 'token')}; failed checks: ${checks.length === 0 ? 'none' : checks.join(', ')}`;
    });
  return `## Failed trials\n\nOutcome trials that did not pass, fewest attempts first, then fewest tokens.\n\n${list.length === 0 ? 'None.' : list.join('\n')}`;
}

/** The report of one run, as Markdown. */
export function renderReport(rows: readonly EvalRow[], meta: ReportMeta): string {
  return `${[
    header(meta),
    headline(rows, meta),
    comparison(rows, meta),
    perCase(rows, meta),
    transitions(rows),
    coverage(rows),
    firstBuild(rows, meta),
    costAndLatency(rows, meta),
    failed(rows),
  ].join('\n\n')}\n`;
}
