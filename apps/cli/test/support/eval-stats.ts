import type { Effort } from '@minitui/agent-core';
import type { AttemptRecord, EvalRow } from '../../eval/harness/row.js';
import type { StopKind } from '../../eval/harness/trial.js';

// What the statistics and report tests share: rows built by hand, where only the fields the rule reads
// differ from row to row.

export const attempt = (over: Partial<AttemptRecord> = {}): AttemptRecord => ({
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

export function row(
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
export function pairedCase(
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

export const range = (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1);

// The ids of the first `count` cases, c1 on: the cases a run selected, which the comparison is given.
export const ids = (count: number): string[] => range(count).map((n) => `c${n}`);

// Case c<n>, both arms, but one trial short in the high arm: it has fewer than three outcome trials.
export const excludedOne = (n: number) =>
  pairedCase(n, { medium: 3, high: 3 }).filter((r) => !(r.arm === 'effort-high' && r.trial === 3));
