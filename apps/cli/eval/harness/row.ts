import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { redactDeep, type Effort, type RedactionPolicy } from '@minitui/agent-core';
import { JsonValueSchema, type JsonValue } from '@minitui/types';
import type {
  AttemptObservation,
  FailureClass,
  StopKind,
  TrialObservation,
  Usage,
} from './trial.js';

/** The row schema id and the sentinel the bundle scan looks for. */
export const EVAL_HARNESS_ID = 'minitui-eval-harness/1';

/** dry: the scripted provider; replay: the real SDK loop over the replaying fetch; live: a paid run. */
export type Lane = 'dry' | 'replay' | 'live';

export interface AttemptRecord {
  readonly index: number;
  readonly reprompt: string | null;
  readonly reply: string; // the model's text as received; the writer removes secrets
  readonly failure: FailureClass | null;
  readonly usage: Usage | null;
  readonly noUsage: 'deadline' | 'consumer-closed' | 'run-error' | 'unreported' | null;
  readonly responseModelIds: readonly string[]; // one per step record
  readonly effortLabels: readonly string[]; // the effort each step record names: the requested one
  readonly requests: number;
  readonly runError: {
    readonly message: string;
    readonly code: string | null;
    readonly retriable: boolean;
  } | null;
  readonly durationMs: number;
}

export interface CheckResult {
  readonly name: string; // stable, kebab-case
  readonly pass: boolean;
  readonly evidence: string; // a short reason the host writes; never model text
  readonly diagnostic: boolean; // true: reported, never part of pass-all
}

export type CapabilityCause =
  | 'pass'
  | 'missing-component'
  | 'missing-action'
  | 'needs-model-written-code'
  | 'model-error';

export interface EvalRow {
  readonly harness: typeof EVAL_HARNESS_ID;
  readonly runId: string;
  readonly lane: Lane;
  readonly layer: 'generation';
  readonly caseId: string;
  readonly caseVersion: number;
  readonly caseSetVersion: number;
  readonly gradingVersion: number;
  readonly suite: 'regression' | 'capability';
  readonly split: 'dev' | 'test';
  readonly catalog: string;
  readonly arm: `effort-${Effort}`; // "effort-medium" or "effort-high" today
  readonly trial: number; // 1-based within case and arm
  readonly provider: string; // route.provider.id
  readonly requestedModel: string;
  readonly responseModelIds: readonly string[]; // every id the steps named, in order of first sight
  readonly effortSent: Effort; // the arm's effort
  readonly gitCommit: string | null; // null on a dry or replay run given no --commit
  readonly systemPromptSha256: string;
  readonly capabilityFingerprint: string; // sha256 of the sorted encoder list the semantic stage saw
  readonly priceTable: { readonly date: string; readonly key: string } | null; // null on the dry lane
  readonly attempts: readonly AttemptRecord[];
  readonly stop: StopKind;
  readonly spec: JsonValue | null; // JsonValueSchema.parse(spec); the writer removes secrets
  readonly checks: readonly CheckResult[];
  readonly passAll: boolean;
  readonly cause: CapabilityCause | null; // capability cases only
  readonly usage: Usage; // the sum over attempts of reported usage
  readonly cost: { readonly measuredUsd: number; readonly upperUsd: number }; // measured: attempts that reported usage; upper: the meter's settled charge, the accounted cost the cap counts
  readonly durationMs: number;
}

/** What a row carries besides the observation: the run's labels, and what the caller computed. */
export interface RowContext {
  readonly runId: string;
  readonly lane: Lane;
  readonly case: {
    readonly id: string;
    readonly version: number;
    readonly suite: EvalRow['suite'];
    readonly split: EvalRow['split'];
    readonly catalog: string;
  };
  readonly caseSetVersion: number;
  readonly gradingVersion: number;
  readonly arm: Effort; // the row's arm and its effort sent both come from this one value
  readonly trial: number;
  readonly provider: string;
  readonly model: string;
  readonly commit: string | null;
  readonly priceTable: EvalRow['priceTable'];
  readonly fingerprint: string;
  readonly checks: readonly CheckResult[];
  readonly cause: CapabilityCause | null;
  readonly cost: EvalRow['cost']; // computed by the caller from the spend meter
}

const attemptRecord = (a: AttemptObservation): AttemptRecord => ({
  index: a.index,
  reprompt: a.reprompt,
  reply: a.reply,
  failure: a.failure,
  usage: a.usage,
  noUsage: a.noUsage,
  responseModelIds: a.steps.map((step) => step.modelId),
  effortLabels: a.steps.map((step) => step.effort),
  requests: a.requests,
  runError: a.runError,
  durationMs: a.durationMs,
});

// Only the usage an attempt reported counts: an attempt without any adds nothing.
const reportedUsage = (attempts: readonly AttemptObservation[]): Usage =>
  attempts.reduce<Usage>(
    (sum, { usage }) =>
      usage === null
        ? sum
        : {
            inputTokens: sum.inputTokens + usage.inputTokens,
            outputTokens: sum.outputTokens + usage.outputTokens,
          },
    { inputTokens: 0, outputTokens: 0 },
  );

/**
 * One row for one trial. A mapping and nothing more: the price comes in through the context, and the
 * model's text stays as received (the writer removes secrets).
 */
export function toRow(observation: TrialObservation, context: RowContext): EvalRow {
  return {
    harness: EVAL_HARNESS_ID,
    runId: context.runId,
    lane: context.lane,
    layer: 'generation',
    caseId: context.case.id,
    caseVersion: context.case.version,
    caseSetVersion: context.caseSetVersion,
    gradingVersion: context.gradingVersion,
    suite: context.case.suite,
    split: context.case.split,
    catalog: context.case.catalog,
    arm: `effort-${context.arm}`,
    trial: context.trial,
    provider: context.provider,
    requestedModel: context.model,
    // a Set keeps the order a value was first added in
    responseModelIds: [
      ...new Set(observation.attempts.flatMap((a) => a.steps.map((step) => step.modelId))),
    ],
    effortSent: context.arm,
    gitCommit: context.commit,
    systemPromptSha256: createHash('sha256').update(observation.systemPrompt).digest('hex'),
    capabilityFingerprint: context.fingerprint,
    priceTable: context.priceTable,
    attempts: observation.attempts.map(attemptRecord),
    stop: observation.stop,
    spec: observation.spec === null ? null : JsonValueSchema.parse(observation.spec),
    checks: context.checks,
    // a valid stop and every check that is not a diagnostic: a trial with no spec passes nothing
    passAll: observation.stop === 'valid' && context.checks.every((c) => c.diagnostic || c.pass),
    cause: context.cause,
    usage: reportedUsage(observation.attempts),
    cost: context.cost,
    durationMs: observation.durationMs,
  };
}

// What JSON.stringify leaves raw and a terminal or a line reader would act on: DEL and the C1 range
// (U+007F to U+009F), and the line and paragraph separators (U+2028, U+2029). It escapes the C0 range
// itself, so those never reach this pattern. Written as general categories, so no such character sits in
// this source.
const LEFT_RAW = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

const jsonEscape = (char: string): string =>
  `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;

/**
 * Appends the rows to the file, one JSON line each. Every row goes through the key's exact-value pattern
 * and the shape patterns first, and what is written holds none of the characters above, so printing the
 * file cannot drive a terminal.
 */
export function writeRows(path: string, rows: readonly EvalRow[], policy: RedactionPolicy): void {
  // An empty directory collapses nothing, so a case path is kept byte for byte. Only the writer adds the
  // two: the graph and the provider get the policy exactly as the cli builds it.
  const keep: RedactionPolicy = { ...policy, tmpDir: '', homeDir: '' };
  const lines = rows.map(
    (row) => `${JSON.stringify(redactDeep(row, keep)).replace(LEFT_RAW, jsonEscape)}\n`,
  );
  appendFileSync(path, lines.join(''));
}
