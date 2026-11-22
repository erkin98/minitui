import { describe, it, expect } from 'vitest';
import type { Effort } from '@minitui/agent-core';
import type { AttemptRecord, EvalRow } from '../../eval/harness/row.js';
import { renderReport, type ReportMeta } from '../../eval/harness/report.js';
import {
  COST_REDUCTION_THRESHOLD,
  EXCLUDED_SHARE_LIMIT,
  NON_INFERIORITY_MARGIN,
  bootstrapInterval,
  cheaperOf,
  compareArms,
  connorSize,
  mcnemarExact,
  tCritical,
  tInterval,
  wilson,
  type ArmCost,
} from '../../eval/harness/stats.js';
import type { StopKind } from '../../eval/harness/trial.js';

describe('wilson', () => {
  it('24 of 30 gives 0.627 to 0.905', () => {
    const interval = wilson(24, 30);
    expect(interval?.value).toBe(0.8);
    expect(interval?.low).toBeCloseTo(0.627, 3);
    expect(interval?.high).toBeCloseTo(0.905, 3);
    expect(interval?.n).toBe(30);
  });

  it('stays inside 0 to 1 at both ends, and has no interval over nothing', () => {
    expect(wilson(0, 10)?.low).toBe(0);
    expect(wilson(10, 10)?.high).toBe(1);
    expect(wilson(0, 0)).toBeNull();
  });
});

describe('mcnemarExact', () => {
  it.each([
    [6, 0, 0.03125],
    [0, 6, 0.03125],
    [5, 0, 0.0625],
    [3, 3, 1], // the doubled tail passes 1 and is capped there
    [0, 0, 1], // no discordant case: nothing to test
  ])('%i to %i gives %d', (b, c, p) => {
    expect(mcnemarExact(b, c)).toBeCloseTo(p, 10);
  });
});

describe('connorSize', () => {
  it('about 30 cases at δ 0.27, ψ 0.3, and at δ 0.22, ψ 0.2', () => {
    expect(connorSize(0.27, 0.3)).toBeCloseTo(29.8, 1);
    expect(connorSize(0.22, 0.2)).toBeCloseTo(29.9, 1);
  });

  it('has no size when the discordant share is below δ²', () => {
    expect(connorSize(0.5, 0.2)).toBeNaN();
  });
});

describe('the t table', () => {
  it.each([
    [1, 12.706],
    [2, 4.303],
    [10, 2.228],
    [29, 2.045],
    [30, 2.042],
    [60, 2.0],
    [100, 1.984],
  ])('%i degrees of freedom: %d', (df, t) => {
    expect(tCritical(df)).toBe(t);
  });

  it.each([0, 101, 1.5, Number.NaN])('throws for %d degrees of freedom', (df) => {
    expect(() => tCritical(df)).toThrow(/1 to 100/);
  });
});

describe('tInterval', () => {
  it('1, 2, 3, 4, 5: mean 3, from 1.037 to 4.963 at 4 degrees of freedom', () => {
    const interval = tInterval([1, 2, 3, 4, 5]);
    expect(interval?.value).toBe(3);
    expect(interval?.low).toBeCloseTo(1.037, 3);
    expect(interval?.high).toBeCloseTo(4.963, 3);
    expect(interval?.n).toBe(5);
  });

  it('has no interval with fewer than two values', () => {
    expect(tInterval([0.5])).toBeNull();
    expect(tInterval([])).toBeNull();
  });
});

describe('bootstrapInterval', () => {
  const sample = [0, 0.33, 0.67, 1, 1, 0.67, 0, 0.33, 1, 0.67];

  it('the same seed gives the same result; another seed gives another', () => {
    const first = bootstrapInterval(sample, 7);
    expect(bootstrapInterval(sample, 7)).toEqual(first);
    expect(bootstrapInterval(sample, 8)).not.toEqual(first);
    const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
    expect(first?.value).toBeCloseTo(mean, 10);
    expect(first?.low).toBeLessThan(mean);
    expect(first?.high).toBeGreaterThan(mean);
  });

  it('a constant sample has a point interval; an empty one has none', () => {
    expect(bootstrapInterval([0.5, 0.5, 0.5], 1)).toEqual({
      value: 0.5,
      low: 0.5,
      high: 0.5,
      n: 3,
    });
    expect(bootstrapInterval([], 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
// The comparison, over rows built by hand: only the fields the rule reads differ from row to row.

const attempt = (over: Partial<AttemptRecord> = {}): AttemptRecord => ({
  index: 1,
  reprompt: null,
  reply: '',
  failure: null,
  usage: { inputTokens: 10, outputTokens: 10 },
  noUsage: null,
  responseModelIds: [],
  effortLabels: [],
  requests: 1,
  runError: null,
  durationMs: 1,
  ...over,
});

function row(
  caseId: string,
  arm: Effort,
  trial: number,
  over: {
    pass?: boolean;
    stop?: StopKind;
    usd?: number;
    upperUsd?: number;
    noUsage?: boolean;
  } = {},
): EvalRow {
  const pass = over.pass ?? true;
  return {
    harness: 'minitui-eval-harness/1',
    runId: 'run',
    lane: 'replay',
    layer: 'generation',
    caseId,
    caseVersion: 1,
    caseSetVersion: 1,
    gradingVersion: 0,
    suite: 'regression',
    split: 'dev',
    catalog: 'video-merge',
    arm: `effort-${arm}`,
    trial,
    provider: 'p',
    requestedModel: 'm',
    responseModelIds: [],
    effortSent: arm,
    gitCommit: null,
    systemPromptSha256: '0'.repeat(64),
    capabilityFingerprint: '0'.repeat(64),
    priceTable: null,
    attempts: [
      over.noUsage === true ? attempt({ usage: null, noUsage: 'consumer-closed' }) : attempt(),
    ],
    stop: over.stop ?? (pass ? 'valid' : 'exhausted'),
    spec: null,
    checks: [],
    passAll: pass,
    cause: null,
    usage: { inputTokens: 10, outputTokens: 10 },
    cost: { measuredUsd: over.usd ?? 1, upperUsd: over.upperUsd ?? over.usd ?? 1 },
    durationMs: 10,
  };
}

// Case c<n>, both arms, three trials each; `medium` and `high` give the number of trials that pass.
// `cost` is each arm's measured cost per trial, and `accounted` its settled charge, the same when not given.
function pairedCase(
  n: number,
  passes: { readonly medium: number; readonly high: number },
  cost: { readonly medium: number; readonly high: number } = { medium: 1, high: 1 },
  accounted: { readonly medium: number; readonly high: number } = cost,
): EvalRow[] {
  return (['medium', 'high'] as const).flatMap((arm) =>
    [1, 2, 3].map((t) =>
      row(`c${n}`, arm, t, { pass: t <= passes[arm], usd: cost[arm], upperUsd: accounted[arm] }),
    ),
  );
}

const range = (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1);

describe('compareArms: who is in the comparison', () => {
  it('a case with one non-outcome trial leaves the comparison, and is named', () => {
    const rows = [
      ...range(9).flatMap((n) => pairedCase(n, { medium: 3, high: 3 })),
      ...pairedCase(10, { medium: 3, high: 3 }).map((r) =>
        r.arm === 'effort-medium' && r.trial === 2 ? { ...r, stop: 'provider-error' as const } : r,
      ),
    ];
    const result = compareArms(rows, 3);
    expect(result?.regressionCases).toBe(10);
    expect(result?.paired).toEqual(range(9).map((n) => `c${n}`));
    expect(result?.excluded).toEqual(['c10']);
    // one of ten is not more than a tenth
    expect(result?.applied).toBe(true);
  });

  it('a turn-deadline trial is a model outcome: its case stays in, counted as a fail', () => {
    const rows = pairedCase(1, { medium: 3, high: 3 }).map((r) =>
      r.arm === 'effort-high' && r.trial === 1
        ? { ...r, stop: 'turn-deadline' as const, passAll: false }
        : r,
    );
    const result = compareArms([...rows, ...pairedCase(2, { medium: 3, high: 3 })], 3);
    expect(result?.excluded).toEqual([]);
    expect(result?.paired).toEqual(['c1', 'c2']);
    // c1: high 2 of 3 against medium 3 of 3, so -1/3; c2: 0; the mean of the two is -1/6
    expect(result?.diff?.value).toBeCloseTo(-1 / 6, 10);
  });

  it('more than a tenth of the cases out: not applied; at a tenth exactly it is applied', () => {
    const excludedOne = (n: number) =>
      pairedCase(n, { medium: 3, high: 3 }).filter(
        (r) => !(r.arm === 'effort-high' && r.trial === 3),
      );
    const nine = range(8).flatMap((n) => pairedCase(n, { medium: 3, high: 3 }));
    const two = compareArms([...nine, ...excludedOne(9), ...excludedOne(10)], 3);
    expect(two?.excluded).toEqual(['c9', 'c10']);
    expect([two?.applied, two?.recommendation]).toEqual([false, 'not-applied']);
    // the control: one fewer excluded case and the rule is applied
    const one = compareArms(
      [...nine, ...pairedCase(9, { medium: 3, high: 3 }), ...excludedOne(10)],
      3,
    );
    expect(one?.applied).toBe(true);
    expect(one?.recommendation).not.toBe('not-applied');
  });

  it('needs both arms: a run of one arm has no comparison', () => {
    const highOnly = pairedCase(1, { medium: 3, high: 3 }).filter((r) => r.arm === 'effort-high');
    expect(compareArms(highOnly, 3)).toBeNull();
  });

  it('reads only the regression cases', () => {
    const capability = pairedCase(2, { medium: 0, high: 3 }).map((r) => ({
      ...r,
      suite: 'capability' as const,
    }));
    const result = compareArms([...pairedCase(1, { medium: 3, high: 3 }), ...capability], 3);
    expect([result?.regressionCases, result?.paired, result?.flagged]).toEqual([1, ['c1'], []]);
  });
});

describe('compareArms: the decision rule', () => {
  const equalPasses = (count: number) =>
    range(count).flatMap((n) =>
      pairedCase(n, { medium: n % 3, high: n % 3 }, { medium: 0.7, high: 1 }),
    );

  it('non-inferior and cheaper: send medium', () => {
    const result = compareArms(equalPasses(30), 3);
    expect(result?.nonInferior).toBe(true);
    expect(result?.cost.cheaper).toBe(true);
    expect(result?.recommendation).toBe('send-medium');
    expect(result?.diff?.value).toBe(0);
    expect(result?.diff?.high).toBeLessThan(NON_INFERIORITY_MARGIN);
  });

  it('the cost condition: 20% below is enough, 19% below is not', () => {
    const at = (medium: number) =>
      compareArms(
        range(30).flatMap((n) => pairedCase(n, { medium: 3, high: 3 }, { medium, high: 1 })),
        3,
      );
    expect(at(1 - COST_REDUCTION_THRESHOLD)?.cost.cheaper).toBe(true);
    expect(at(0.81)?.cost.cheaper).toBe(false);
    expect(at(0.81)?.recommendation).toBe('keep-default');
  });

  it('the cost reads only trials whose every attempt reported usage, and says what it dropped', () => {
    const rows = range(3).flatMap((n) =>
      pairedCase(n, { medium: 3, high: 3 }, { medium: 0.5, high: 1 }),
    );
    // one medium trial reported no usage and settled at its worst case: it would make medium dearer
    const withHole = rows.map((r) =>
      r.caseId === 'c1' && r.arm === 'effort-medium' && r.trial === 1
        ? { ...row('c1', 'medium', 1, { usd: 100, noUsage: true }) }
        : r,
    );
    const result = compareArms(withHole, 3);
    expect(result?.cost.medium.measuredMean).toBe(0.5);
    expect(result?.cost.medium.reported).toBe(8);
    expect(result?.cost.medium.dropped).toEqual({ 'consumer-closed': 1 });
    expect(result?.cost.high.dropped).toEqual({});
  });

  it('a drop of more than the margin on medium: not non-inferior, keep the default; flags the case', () => {
    const rows = range(30).flatMap((n) =>
      pairedCase(n, n <= 10 ? { medium: 0, high: 3 } : { medium: 3, high: 3 }, {
        medium: 0.5,
        high: 1,
      }),
    );
    const result = compareArms(rows, 3);
    expect(result?.nonInferior).toBe(false);
    expect(result?.recommendation).toBe('keep-default');
    expect(result?.flagged).toEqual(range(10).map((n) => `c${n}`));
    // pass^3 split 10 to 0: the exact McNemar p
    expect(result?.mcnemar).toEqual({ highOnly: 10, mediumOnly: 0, p: mcnemarExact(10, 0) });
  });

  it('both arms at 95% or more: saturated', () => {
    expect(
      compareArms(
        range(5).flatMap((n) => pairedCase(n, { medium: 3, high: 3 })),
        3,
      )?.saturated,
    ).toBe(true);
    expect(compareArms(equalPasses(5), 3)?.saturated).toBe(false);
  });

  it('the decision constants are the ones the owner approved', () => {
    expect([NON_INFERIORITY_MARGIN, COST_REDUCTION_THRESHOLD, EXCLUDED_SHARE_LIMIT]).toEqual([
      0.1, 0.2, 0.1,
    ]);
  });
});

describe('compareArms: condition 2 holds on both cost measures', () => {
  // Thirty cases that pass every trial in both arms, so condition 1 holds and the cost alone decides.
  // High costs 1 on both measures; medium costs what each argument says.
  const at = (measured: number, accounted: number) =>
    compareArms(
      range(30).flatMap((n) =>
        pairedCase(
          n,
          { medium: 3, high: 3 },
          { medium: measured, high: 1 },
          { medium: accounted, high: 1 },
        ),
      ),
      3,
    );

  it('25% cheaper measured but only 10% cheaper accounted: not cheaper, keep the default', () => {
    const result = at(0.75, 0.9);
    expect(result?.nonInferior).toBe(true);
    expect([result?.cost.cheaper, result?.recommendation]).toEqual([false, 'keep-default']);
  });

  it('25% cheaper accounted but only 10% cheaper measured: not cheaper either', () => {
    const result = at(0.9, 0.75);
    expect(result?.nonInferior).toBe(true);
    expect([result?.cost.cheaper, result?.recommendation]).toEqual([false, 'keep-default']);
  });

  it('25% cheaper on both: cheaper, send medium', () => {
    const result = at(0.75, 0.75);
    expect([result?.cost.cheaper, result?.recommendation]).toEqual([true, 'send-medium']);
  });

  it('20% below is enough on each measure; 19% below on either is not', () => {
    const edge = 1 - COST_REDUCTION_THRESHOLD;
    expect(at(edge, edge)?.cost.cheaper).toBe(true);
    expect(at(edge, 0.81)?.cost.cheaper).toBe(false);
    expect(at(0.81, edge)?.cost.cheaper).toBe(false);
  });

  it('the accounted mean is the settled charge over every outcome trial, the measured one only the reported ones', () => {
    // one medium trial reported no usage and settled at its worst case: measured leaves it out (0.5 against
    // 1, cheaper), accounted keeps it ((8 × 0.5 + 100) / 9 = 11.6 against 1, dearer): the arm that breaks
    // more is not cheaper
    const rows = range(3).flatMap((n) =>
      pairedCase(n, { medium: 3, high: 3 }, { medium: 0.5, high: 1 }),
    );
    const withHole = rows.map((r) =>
      r.caseId === 'c1' && r.arm === 'effort-medium' && r.trial === 1
        ? row('c1', 'medium', 1, { usd: 0, upperUsd: 100, noUsage: true })
        : r,
    );
    const result = compareArms(withHole, 3);
    expect(result?.cost.medium.measuredMean).toBe(0.5);
    expect(result?.cost.medium.accountedMean).toBeCloseTo((8 * 0.5 + 100) / 9, 10);
    expect([result?.cost.cheaper, result?.recommendation]).toEqual([false, 'keep-default']);
  });
});

describe('cheaperOf: a measure with nothing to compare', () => {
  const cost = (measuredMean: number | null, accountedMean: number | null): ArmCost => ({
    trials: 3,
    reported: 3,
    measuredMean,
    accountedMean,
    dropped: {},
  });

  it('both means 25% below: true; the control that a clear pair is not null', () => {
    expect(cheaperOf(cost(0.75, 0.75), cost(1, 1))).toBe(true);
    expect(cheaperOf(cost(0.9, 0.75), cost(1, 1))).toBe(false);
  });

  it.each([
    ['medium accounted mean null', cost(0.5, null), cost(1, 1)],
    ['high accounted mean null', cost(0.5, 0.5), cost(1, null)],
    ['medium measured mean null', cost(null, 0.5), cost(1, 1)],
    ['high measured mean null', cost(0.5, 0.5), cost(null, 1)],
    ['high measured mean at zero', cost(0, 0.5), cost(0, 1)],
    ['high accounted mean at zero', cost(0.5, 0), cost(1, 0)],
    // the other measure says no, and a missing one still decides nothing: null, not false
    ['accounted null while measured says no', cost(0.9, null), cost(1, 1)],
    ['measured null while accounted says no', cost(null, 0.9), cost(1, 1)],
  ])('%s: null', (_name, medium, high) => {
    expect(cheaperOf(medium, high)).toBeNull();
  });
});

describe('the report: its figures, on a set worked out by hand', () => {
  // effort-high, regression, ten cases of three trials: c1 to c4 pass all three, c5 to c10 pass two.
  // Each failed trial is a turn-deadline after two structural attempts (c5 to c7) or an exhausted loop of
  // a catalog attempt and five semantic ones (c8 to c10). Every passing trial is valid on its first attempt.
  const failed = (index: number, failure: AttemptRecord['failure']): AttemptRecord =>
    attempt({ index, failure });
  const DEADLINE = [
    failed(1, 'structural'),
    failed(2, 'structural'),
    attempt({ index: 3, usage: null, noUsage: 'deadline' }),
  ];
  const EXHAUSTED = [failed(1, 'catalog'), ...[2, 3, 4, 5, 6].map((i) => failed(i, 'semantic'))];
  const HIGH = range(10).flatMap((n) =>
    [1, 2, 3].map((t): EvalRow => {
      if (n <= 4 || t <= 2) return row(`c${n}`, 'high', t);
      if (n <= 7) {
        return {
          ...row(`c${n}`, 'high', t, { pass: false, stop: 'turn-deadline' }),
          attempts: DEADLINE,
        };
      }
      return { ...row(`c${n}`, 'high', t, { pass: false }), attempts: EXHAUSTED };
    }),
  );
  // capability trials in the medium arm. k1 misses a component, a cause of the case: it counts every trial,
  // its provider refusal included. k2 has nothing missing: one trial valid on its second attempt, and a
  // spend-cap trial still carrying the cause an older row wrote, which counts under no cause. k3's
  // harness-error trial carries the old model-error the same way.
  const capability = (r: EvalRow, cause: EvalRow['cause']): EvalRow => ({
    ...r,
    suite: 'capability',
    cause,
  });
  const CAPABILITY = [
    capability(row('k1', 'medium', 1, { pass: false }), 'missing-component'),
    capability(row('k1', 'medium', 2, { pass: false }), 'missing-component'),
    capability(
      row('k1', 'medium', 3, { pass: false, stop: 'provider-error' }),
      'missing-component',
    ),
    capability(
      { ...row('k2', 'medium', 1), attempts: [failed(1, 'catalog'), attempt({ index: 2 })] },
      'pass',
    ),
    capability(row('k2', 'medium', 2, { pass: false, stop: 'spend-cap' }), 'pass'),
    capability(row('k3', 'medium', 1, { pass: false, stop: 'harness-error' }), 'model-error'),
  ];
  const text = renderReport([...HIGH, ...CAPABILITY], {
    runId: 'r',
    lane: 'replay',
    provider: 'p',
    model: 'm',
    caseSetVersion: 1,
    caseSetStatus: 'draft',
    gradingVersion: 0,
    arms: ['medium', 'high'],
    trials: 3,
    concurrency: 1,
  });
  const section = (heading: string): string => {
    const start = text.indexOf(heading);
    return text.slice(start, text.indexOf('\n## ', start + 1));
  };

  it('the headline row of effort-high, and the suites it covers', () => {
    // 24 of 30 trials pass, all on their first attempt: Wilson centre (0.8 + 1.96²/60) / (1 + 1.96²/30)
    // = 0.766, half-width 1.96 × sqrt(0.16/30 + 1.96²/3600) / 1.128 = 0.139, so 62.7% to 90.5%.
    // pass^3: 4 of 10 cases, Wilson 16.8% to 68.7% (the mirror of 6 of 10: centre 0.427, half 0.260).
    // Per-case mean: (4 × 1 + 6 × 2/3) / 10 = 0.8; sd sqrt((4 × 0.2² + 6 × 0.1333²) / 9) = 0.1721;
    // t(9) = 2.262, half-width 2.262 × 0.1721 / sqrt(10) = 0.1231, so 67.7% to 92.3%.
    const head = section('## Headline numbers per arm');
    expect(head).toContain('Suites: regression, capability.');
    const wilson = '80.0% [62.7%, 90.5%]';
    expect(head).toContain(
      `|effort-high|10|30|30|${wilson}|${wilson}|${wilson}|40.0% [16.8%, 68.7%]|80.0% [67.7%, 92.3%]|`,
    );
  });

  it('the transition matrix', () => {
    // three turn-deadline trials: structural to structural, then structural to the deadline, once each;
    // three exhausted trials: catalog to semantic once, then semantic to semantic four times; the
    // capability trial valid on its second attempt: catalog to valid once
    const matrix = section('## Transitions between attempts');
    expect(matrix).toContain('|structural|3|0|0|0|3|0|');
    expect(matrix).toContain('|catalog|0|0|3|1|0|0|');
    expect(matrix).toContain('|semantic|0|0|12|0|0|0|');
  });

  it('the coverage map: a missing cause counts every trial; pass and model-error only outcome trials', () => {
    const map = section('## Capability coverage');
    expect(map).toContain(
      '|cause|trials|valid|exhausted|turn-deadline|spend-cap|timeout|harness-error|provider-error|',
    );
    // two exhausted loops and one provider refusal
    expect(map).toContain('|missing-component|3|0|2|0|0|0|0|1|');
    expect(map).toContain('|pass|1|1|0|0|0|0|0|0|');
    // the spend-cap and harness-error trials, by stop kind only
    expect(map).toContain('|not an outcome|2|0|0|0|1|0|1|0|');
    expect(map).not.toContain('|model-error|');
  });

  it('the first-build success rate', () => {
    // the same ten cases and thirty trials as the headline: per-case mean 67.7% to 92.3%, Wilson over
    // the trials 62.7% to 90.5%
    expect(section('## First-build success rate')).toContain(
      '- Pass-all within the six attempts of one first generation: 80.0% [67.7%, 92.3%]; over the 30 outcome trials (Wilson, descriptive): 80.0% [62.7%, 90.5%].',
    );
  });
});

describe('the report', () => {
  const META: ReportMeta = {
    runId: '20261120T000000Z-0a1b2c3d',
    lane: 'replay',
    provider: 'p',
    model: 'm',
    caseSetVersion: 1,
    caseSetStatus: 'draft',
    gradingVersion: 0,
    arms: ['medium', 'high'],
    trials: 3,
    concurrency: 1,
  };
  const dropTrial = (rows: EvalRow[], caseId: string) =>
    rows.map((r) =>
      r.caseId === caseId && r.arm === 'effort-high' && r.trial === 1
        ? { ...r, stop: 'timeout' as const }
        : r,
    );

  it('with more than a tenth of the cases excluded, it says "not applied" with the counts', () => {
    const rows = dropTrial(
      dropTrial(
        range(10).flatMap((n) => pairedCase(n, { medium: 3, high: 3 })),
        'c1',
      ),
      'c2',
    );
    const text = renderReport(rows, META);
    expect(text).toContain('not applied');
    expect(text).toContain('2 of 10 regression cases left the paired comparison');
  });

  it('the control: one excluded case of ten, and the rule is applied', () => {
    const text = renderReport(
      dropTrial(
        range(10).flatMap((n) => pairedCase(n, { medium: 3, high: 3 })),
        'c1',
      ),
      META,
    );
    expect(text).not.toContain('not applied');
    expect(text).toContain('1 of 10 regression cases left the paired comparison');
    expect(text).toMatch(/Recommendation: (send medium|keep the model’s own default)/);
  });

  describe('condition 2', () => {
    // the lines of the condition: its verdict, then one line for each cost measure, then one for each arm
    const linesOf = (text: string): string[] => {
      const start = text.indexOf('- Condition 2');
      return text.slice(start, text.indexOf('\n- Flagged', start)).split('\n');
    };
    const casesAt = (cost: { medium: number; high: number }, accounted = cost) =>
      range(10).flatMap((n) => pairedCase(n, { medium: 3, high: 3 }, cost, accounted));

    it('names both cost measures and both means, one line for each; the accounted mean is printed once', () => {
      // medium is 25% cheaper measured and 10% cheaper accounted: the condition fails on the second measure
      const lines = linesOf(
        renderReport(casesAt({ medium: 0.75, high: 1 }, { medium: 0.9, high: 1 }), META),
      );
      expect(lines).toEqual([
        '- Condition 2, cheaper: medium at least 20.0% below high on both cost measures: no.',
        '  - mean measured cost per outcome trial whose every attempt reported usage: medium $0.750000 against high $1.000000.',
        '  - mean accounted cost per outcome trial, the settled charge of the meter over every outcome trial: medium $0.900000 against high $1.000000.',
        '  - medium: 30 of 30 outcome trials kept; dropped by reason: none',
        '  - high: 30 of 30 outcome trials kept; dropped by reason: none',
      ]);
    });

    it('an arm line says how much of the arm the filter dropped, by reason', () => {
      // one medium trial reported no usage: 1 of the arm's 30 outcome trials, 3.3%
      const rows = casesAt({ medium: 0.75, high: 1 }).map((r) =>
        r.caseId === 'c1' && r.arm === 'effort-medium' && r.trial === 1
          ? row('c1', 'medium', 1, { usd: 0, upperUsd: 1, noUsage: true })
          : r,
      );
      expect(linesOf(renderReport(rows, META)).slice(3)).toEqual([
        '  - medium: 29 of 30 outcome trials kept; dropped by reason: consumer-closed 3.3%',
        '  - high: 30 of 30 outcome trials kept; dropped by reason: none',
      ]);
    });

    it('holds on both measures: yes; at zero cost on both arms, as in a dry run: n/a', () => {
      expect(linesOf(renderReport(casesAt({ medium: 0.75, high: 1 }), META))[0]).toBe(
        '- Condition 2, cheaper: medium at least 20.0% below high on both cost measures: yes.',
      );
      const dry = linesOf(renderReport(casesAt({ medium: 0, high: 0 }), META));
      expect(dry.slice(0, 3)).toEqual([
        '- Condition 2, cheaper: medium at least 20.0% below high on both cost measures: n/a.',
        '  - mean measured cost per outcome trial whose every attempt reported usage: medium $0.000000 against high $0.000000.',
        '  - mean accounted cost per outcome trial, the settled charge of the meter over every outcome trial: medium $0.000000 against high $0.000000.',
      ]);
    });
  });

  it('holds every section, and the failed trials sorted by attempts, then tokens', () => {
    const rows = [
      ...range(3).flatMap((n) => pairedCase(n, { medium: 3, high: 3 })),
      { ...row('c9', 'high', 1, { pass: false }), attempts: [attempt(), attempt({ index: 2 })] },
      { ...row('c8', 'high', 1, { pass: false }), usage: { inputTokens: 5, outputTokens: 5 } },
      row('c7', 'high', 1, { pass: false }),
    ];
    const text = renderReport(rows, META);
    for (const heading of [
      '## Headline numbers per arm',
      '## The comparison',
      '## Per case',
      '## Transitions between attempts',
      '## Capability coverage',
      '## First-build success rate',
      '## Cost and latency',
      '## Failed trials',
    ]) {
      expect(text).toContain(heading);
    }
    const failed = text.slice(text.indexOf('## Failed trials'));
    expect(failed.indexOf('c8')).toBeLessThan(failed.indexOf('c7'));
    expect(failed.indexOf('c7')).toBeLessThan(failed.indexOf('c9'));
  });
});
