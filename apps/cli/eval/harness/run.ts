import type { Effort, ModelRoute, RedactionPolicy } from '@minitui/agent-core';
import { videoMergeCatalog } from '@minitui/catalog';
import type { CapabilityProvider } from '@minitui/spec';
import type { DiagnosticsPort } from '@minitui/types';
import { MAX_GEN_ATTEMPTS } from '../../src/generation.js';
import { GRADING_VERSION, capabilityCause, grade } from '../graders/index.js';
import type { KeyedAccess, Meter, ReplayRouteArgs, TrialRouteArgs } from '../providers/index.js';
import { renderPatchText, type CaseSet, type GenerationCase } from './cases.js';
import type { RunRoot } from './fixtures.js';
import {
  toRow,
  writeRows,
  type CapabilityCause,
  type EvalRow,
  type Lane,
  type RowContext,
} from './row.js';
import { schedule, type Job } from './schedule.js';
import { isOutcome } from './stats.js';
import { scriptedProvider } from './scripted.js';
import { trialMeter, type SpendMeter } from './spend.js';
import { createStepLog, graphDepsFor, runTrial, type TrialObservation } from './trial.js';

/** What one trial's route is built from: the reply the dry and replay lanes answer with, its meter and its step log. */
export interface TrialRoute {
  readonly text: string;
  readonly meter: Meter;
  readonly diagnostics: DiagnosticsPort;
}

/** A lane, as the run sees it: the row's labels, the run's meter (none on the dry lane) and a route per trial. */
export interface LaneSetup {
  readonly lane: Lane;
  readonly provider: string;
  readonly model: string;
  readonly priceTable: EvalRow['priceTable'];
  readonly meter: SpendMeter | null;
  readonly redactionPolicy: RedactionPolicy;
  readonly route: (args: TrialRoute) => ModelRoute;
}

// One token each way: the settled charge of an attempt stays far below a cent, so a 1.00 cap always has
// room for the next request's worst case.
const ONE_EACH = { inputTokens: 1, outputTokens: 1 };
const copies = <T>(item: T): T[] => Array.from({ length: MAX_GEN_ATTEMPTS }, () => item);

/** The scripted lane: the reply on every request, no meter, no network. */
export function dryLane(redactionPolicy: RedactionPolicy): LaneSetup {
  return {
    lane: 'dry',
    provider: 'scripted',
    model: 'scripted',
    priceTable: null,
    meter: null,
    redactionPolicy,
    route: ({ text }) => ({
      provider: scriptedProvider(copies({ kind: 'text', text, usage: ONE_EACH })),
      model: 'scripted',
    }),
  };
}

interface MeteredLane<A extends TrialRouteArgs> {
  readonly provider: string;
  readonly model: string;
  readonly priceTable: NonNullable<EvalRow['priceTable']>;
  readonly meter: SpendMeter;
  readonly access: KeyedAccess<A>;
}

/** The real model SDK loop over the replaying fetch: the reply on every request, under the meter. */
export function replayLane(args: MeteredLane<ReplayRouteArgs>): LaneSetup {
  const { provider, model, priceTable, meter, access } = args;
  return {
    lane: 'replay',
    provider,
    model,
    priceTable,
    meter,
    redactionPolicy: access.redactionPolicy,
    route: (trial) =>
      access.route({
        model,
        meter: trial.meter,
        diagnostics: trial.diagnostics,
        replies: copies({ text: trial.text, modelId: model, usage: ONE_EACH }),
      }),
  };
}

/** The paid lane: the real route over the real fetch, under the meter. */
export function liveLane(args: MeteredLane<TrialRouteArgs>): LaneSetup {
  const { provider, model, priceTable, meter, access } = args;
  return {
    lane: 'live',
    provider,
    model,
    priceTable,
    meter,
    redactionPolicy: access.redactionPolicy,
    route: (trial) => access.route({ model, meter: trial.meter, diagnostics: trial.diagnostics }),
  };
}

export interface RunPlan {
  readonly runId: string;
  readonly lane: LaneSetup;
  readonly caseSet: CaseSet;
  readonly selected: readonly { readonly testCase: GenerationCase; readonly position: number }[];
  readonly arms: readonly Effort[];
  readonly trials: number;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly commit: string | null;
  readonly fingerprint: string;
  readonly capabilities: CapabilityProvider;
  readonly root: RunRoot;
  readonly rowsPath: string;
  readonly diagnostics: DiagnosticsPort; // the run's file port
  readonly graphDiagnostics: (port: DiagnosticsPort) => DiagnosticsPort;
  readonly progress: (line: string) => void;
}

type RowArgs = Omit<RowContext, 'checks' | 'cause'> & {
  readonly testCase: GenerationCase;
  readonly caseDirectory: string;
  readonly diagnostics: DiagnosticsPort;
};

// The two causes that read the trial's outcome; the three missing causes are the case's, whatever the stop.
const readsOutcome = (cause: CapabilityCause | null): boolean =>
  cause === 'pass' || cause === 'model-error';

/**
 * The row of one trial: graded, then mapped. A throw from the grading or from the mapping (a spec that is
 * not JSON, or over budget) makes the trial a harness error with no spec, with a warning in its diagnostics
 * naming the stage that threw, and the run goes on. A cause the case decides (a missing component or action,
 * or model-written code) is kept whatever the stop, so a provider refusal shows under it; pass and
 * model-error need a model outcome, and a trial that is not one gets no cause, never a model error.
 */
export function rowFor(observation: TrialObservation, args: RowArgs): EvalRow {
  const { testCase, caseDirectory, diagnostics, ...context } = args;
  const checksOf = (seen: TrialObservation) =>
    grade({
      testCase,
      stop: seen.stop,
      attempts: seen.attempts.length,
      spec: seen.stop === 'valid' ? seen.spec : null,
      caseDirectory,
      catalog: videoMergeCatalog,
    });
  const rowOf = (seen: TrialObservation, checks: EvalRow['checks']): EvalRow => {
    const row = toRow(seen, { ...context, checks, cause: null });
    const cause = capabilityCause(testCase, videoMergeCatalog, row.passAll);
    return { ...row, cause: readsOutcome(cause) && !isOutcome(row) ? null : cause };
  };
  let stage: 'grade' | 'row' = 'grade';
  try {
    const checks = checksOf(observation);
    stage = 'row';
    return rowOf(observation, checks);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.warn('trial harness error', { stage, message });
    const failed: TrialObservation = { ...observation, stop: 'harness-error', spec: null };
    return rowOf(failed, checksOf(failed));
  }
}

// The reply text of a trial: the case's reference, or its dry-run reply, with the case directory written in.
export function replyFor(caseSet: CaseSet, testCase: GenerationCase, dir: string): string {
  const file = testCase.reference ?? testCase.dryRun?.reply;
  const text = file === undefined ? undefined : caseSet.patches.get(file);
  if (text === undefined) throw new Error(`the case set holds no reply for ${testCase.id}`);
  return renderPatchText(text, dir);
}

type Selected = RunPlan['selected'][number];

// The run's one diagnostics file, each record marked with the trial it came from.
const forTrial = (next: DiagnosticsPort, trial: string): DiagnosticsPort => ({
  warn: (msg, meta) => next.warn(msg, { trial, ...meta }),
  debug: (msg, meta) => next.debug(msg, { trial, ...meta }),
});

async function oneTrial(plan: RunPlan, job: Job<Selected>): Promise<EvalRow> {
  const { testCase, position } = job.item;
  const { lane } = plan;
  const dir = await plan.root.refill(position, testCase.files);
  const trialId = `${testCase.id}/${job.arm}/${job.trial}`;
  const diagnostics = forTrial(plan.diagnostics, trialId);
  const log = createStepLog(diagnostics);
  const view = lane.meter === null ? null : trialMeter(lane.meter, trialId);
  const route = lane.route({
    text: replyFor(plan.caseSet, testCase, dir),
    meter: view?.wrap ?? ((base) => base),
    diagnostics: log.port,
  });
  const observation = await runTrial({
    intent: testCase.input.text,
    deps: graphDepsFor({
      route,
      workingDirectory: dir,
      effort: job.arm,
      diagnostics: plan.graphDiagnostics(log.port),
      redactionPolicy: lane.redactionPolicy,
      // what the graph tells the person is also a warning in the diagnostics log
      stderr: { write: () => {} },
      capabilities: plan.capabilities,
    }),
    steps: log.steps,
    arm: job.arm,
    timeoutMs: plan.timeoutMs,
    now: () => performance.now(),
    hooks: view?.hooks ?? null,
  });
  const { id, version, suite, split, catalog } = testCase;
  return rowFor(observation, {
    testCase,
    caseDirectory: dir,
    diagnostics,
    runId: plan.runId,
    lane: lane.lane,
    case: { id, version, suite, split, catalog },
    caseSetVersion: plan.caseSet.caseSetVersion,
    gradingVersion: GRADING_VERSION,
    arm: job.arm,
    trial: job.trial,
    provider: lane.provider,
    model: lane.model,
    commit: plan.commit,
    priceTable: lane.priceTable,
    fingerprint: plan.fingerprint,
    cost: view?.cost() ?? { measuredUsd: 0, upperUsd: 0 },
  });
}

// The progress line of a trial: host words, and the provider's failure text when the trial ended in one.
function progressLine(done: number, total: number, row: EvalRow): string {
  const failure = row.attempts.at(-1)?.runError?.message;
  const attempts = `${row.attempts.length} attempt${row.attempts.length === 1 ? '' : 's'}`;
  return `${done}/${total} ${row.caseId} ${row.arm} trial ${row.trial}: ${row.stop}, ${attempts}, pass-all ${row.passAll ? 'yes' : 'no'}${failure === undefined ? '' : ` (${failure})`}`;
}

/**
 * Runs every selected case, arm and trial; each row is appended as its trial ends. Resolves with the rows
 * and with what stopped the run early (a RunAbort, or any other throw), or null.
 */
export async function runEval(plan: RunPlan): Promise<{
  readonly rows: readonly EvalRow[];
  readonly halt: { readonly error: unknown } | null;
}> {
  const rows: EvalRow[] = [];
  const total = plan.selected.length * plan.arms.length * plan.trials;
  const halt = await schedule({
    items: plan.selected,
    arms: plan.arms,
    trials: plan.trials,
    concurrency: plan.concurrency,
    stopped: () => plan.lane.meter?.refused ?? false,
    run: async (job) => {
      const row = await oneTrial(plan, job);
      writeRows(plan.rowsPath, [row], plan.lane.redactionPolicy);
      rows.push(row);
      plan.progress(progressLine(rows.length, total, row));
    },
  });
  return { rows, halt };
}
