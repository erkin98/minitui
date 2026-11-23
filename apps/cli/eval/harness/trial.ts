import {
  AgentSession,
  isSdkLoopRoute,
  type Effort,
  type ModelRoute,
  type RedactionPolicy,
} from '@minitui/agent-core';
import { videoMergeCatalog } from '@minitui/catalog';
import { createSandboxManager } from '@minitui/exec';
import type { RendererPort } from '@minitui/renderer-core';
import { createInkBinding } from '@minitui/renderer-ink';
import {
  CATALOG_HEADER,
  REPAIR_HEADER,
  SEMANTIC_HEADER,
  type CapabilityProvider,
  type MiniAppSpec,
  type ValidationEnvelope,
} from '@minitui/spec';
import type { AppEvent, RunHandle } from '@minitui/transport';
import type { DiagnosticsPort } from '@minitui/types';
import type { CliArgs } from '../../src/args.js';
import { ProviderRunError } from '../../src/generation.js';
import { buildAppGraph } from '../../src/graph.js';
import type {
  AppGraph,
  AppGraphDeps,
  MountedApp,
  RunAppGraph,
  TextSink,
} from '../../src/graph-types.js';
import { runApp } from '../../src/run-app.js';

export type StopKind =
  | 'valid' //          the loop returned a spec and the recording host took it
  | 'exhausted' //      the loop used every attempt
  | 'turn-deadline' //  a model turn passed the session's own whole-turn deadline: a fail
  | 'provider-error' // a run ended in a provider failure the session did not retry
  | 'spend-cap' //      the meter refused a request of this trial
  | 'timeout' //        the trial passed its time limit and was cancelled
  | 'harness-error'; // anything else the harness threw

/** Not model outcomes: excluded from every rate and from the comparison, never counted as fails. */
export const NON_OUTCOME_STOPS: readonly StopKind[] = [
  'spend-cap',
  'timeout',
  'harness-error',
  'provider-error',
];

/** The session's whole-turn deadline error, a pinned seam: the session and the stop rule share it. */
export const TURN_DEADLINE_MESSAGE = 'turn exceeded its time budget';

export type FailureClass = 'structural' | 'catalog' | 'semantic';

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** One `debug('model step', { effort, modelId })` record. */
export interface StepRecord {
  readonly effort: string;
  readonly modelId: string;
}

export interface AttemptObservation {
  readonly index: number; // 1 to MAX_GEN_ATTEMPTS
  readonly reprompt: string | null; // the loop's text that started it; null on the first attempt
  readonly reply: string; // the model's text as received; the writer removes secrets
  readonly failure: FailureClass | null; // null when this attempt validated, or ended in a run error (then runError is set)
  readonly usage: Usage | null; // null when the run ended without a finish
  readonly noUsage: 'deadline' | 'consumer-closed' | 'run-error' | 'unreported' | null; // why usage is null; null when it is set
  readonly steps: readonly StepRecord[]; // the step records that arrived during it
  readonly requests: number; // requests the metered fetch saw; 0 on a route with no network
  readonly runError: {
    readonly message: string;
    readonly code: string | null;
    readonly retriable: boolean;
  } | null;
  readonly durationMs: number;
}

export interface TrialObservation {
  readonly stop: StopKind;
  readonly attempts: readonly AttemptObservation[];
  readonly spec: MiniAppSpec | null; // the validated spec the recording host took
  readonly systemPrompt: string;
  readonly durationMs: number;
}

/** What a trial tells the spend meter; the dry lane passes none. */
export interface AttemptHooks {
  /** Attempt n starts: the requests it makes from now on are charged to it. */
  readonly start: (attempt: number) => void;
  /** It ended, with its reported usage; returns how many requests it made and whether one was refused. */
  readonly end: (
    attempt: number,
    usage: Usage | null,
  ) => { readonly requests: number; readonly refused: boolean };
}

/** Ends the whole run, not the trial: a broken recording seam or a runtime spend guard. */
export class RunAbort extends Error {}

/** Records every debug('model step', { effort, modelId }) and forwards every record to `next`. */
export function createStepLog(next: DiagnosticsPort): {
  readonly port: DiagnosticsPort;
  readonly steps: () => readonly StepRecord[];
} {
  const records: StepRecord[] = [];
  return {
    port: {
      warn: (msg, meta) => next.warn(msg, meta),
      debug: (msg, meta) => {
        const effort = meta?.effort;
        const modelId = meta?.modelId;
        if (msg === 'model step' && typeof effort === 'string' && typeof modelId === 'string') {
          records.push({ effort, modelId });
        }
        next.debug(msg, meta);
      },
    },
    steps: () => [...records],
  };
}

// The eval mounts no app: a spec that validated is kept by the recording host instead.
const NO_RENDERER: RendererPort = {
  mount: () => Promise.reject(new Error('the eval never mounts an app')),
};

/** The deps the cli hands buildAppGraph, for an eval trial; the differences are named one by one. */
export function graphDepsFor(args: {
  readonly route: ModelRoute;
  readonly workingDirectory: string;
  readonly effort: Effort;
  readonly diagnostics: DiagnosticsPort;
  readonly redactionPolicy: RedactionPolicy;
  readonly stderr: TextSink;
  readonly capabilities: CapabilityProvider;
}): AppGraphDeps {
  return {
    // the keys the cli sets
    mode: 'default',
    accessible: false,
    binding: createInkBinding(videoMergeCatalog),
    route: args.route,
    workingDirectory: args.workingDirectory,
    makeSession: (wiring) => new AgentSession(wiring),
    diagnostics: args.diagnostics,
    redactionPolicy: args.redactionPolicy,
    effort: args.effort,
    // the four the cli leaves to their defaults: where the person's messages go, no terminal, the
    // production fail-closed sandbox (a loader that rejects gives an inactive handle), the host's files
    stderr: args.stderr,
    renderer: NO_RENDERER,
    createSandbox: () =>
      createSandboxManager(() => Promise.reject(new Error('the eval runs no action'))),
    capabilities: args.capabilities,
  };
}

/** A host that keeps the spec it is given and hands back an app that has already ended. */
export function recordingHost(keep: (spec: MiniAppSpec) => void): RunAppGraph['host'] {
  return {
    mount: (spec) => {
      keep(spec);
      const app = {
        done: Promise.resolve({ status: 'completed', exitCode: 0 }),
        dispose: () => {},
        // no action runs, so no repair can reach the app
        updateSpec: () => {
          throw new Error('the eval applies no repair');
        },
      } satisfies MountedApp;
      return Promise.resolve(app);
    },
  };
}

// The class of a failed attempt, read from the one section the reprompt renders after the repair header.
// Only its start is read: an issue line quotes model-written keys, which can spell any header.
function classOfReprompt(reprompt: string): FailureClass {
  const head = `${REPAIR_HEADER}\n\n`;
  if (!reprompt.startsWith(head)) return 'structural';
  const section = reprompt.slice(head.length);
  if (section.startsWith(`${CATALOG_HEADER}\n`)) return 'catalog';
  if (section.startsWith(`${SEMANTIC_HEADER}\n`)) return 'semantic';
  return 'structural';
}

// The class of the last attempt: the one issue list its envelope holds.
function classOfEnvelope(envelope: ValidationEnvelope): FailureClass {
  if (envelope.catalog.length > 0) return 'catalog';
  if (envelope.semantic.length > 0) return 'semantic';
  return 'structural';
}

// What one attempt's event stream carried.
interface RunSeen {
  reply: string;
  finished: boolean;
  usage: Usage | null;
  runError: AttemptObservation['runError'];
}

function noUsageOf(seen: RunSeen): AttemptObservation['noUsage'] {
  if (seen.usage !== null) return null;
  if (seen.runError !== null) {
    return seen.runError.message === TURN_DEADLINE_MESSAGE ? 'deadline' : 'run-error';
  }
  return seen.finished ? 'unreported' : 'consumer-closed';
}

function note(seen: RunSeen, event: AppEvent): void {
  if (event.kind === 'text-delta') seen.reply += event.delta;
  if (event.kind === 'run-finished') {
    seen.finished = true;
    seen.usage = event.usage ?? null;
  }
  if (event.kind === 'run-error') {
    seen.runError = {
      message: event.message,
      code: event.code ?? null,
      retriable: event.retriable,
    };
  }
}

type ValidateResult = Awaited<ReturnType<RunAppGraph['validate']>>;

interface TrialArgs {
  readonly intent: string;
  readonly deps: AppGraphDeps;
  readonly steps: () => readonly StepRecord[];
  readonly arm: Effort;
  readonly timeoutMs: number;
  readonly now: () => number;
  readonly hooks: AttemptHooks | null; // null on a route with no network
}

// What the recording members saw during one trial.
interface Recorder {
  readonly args: TrialArgs;
  readonly sdkLoop: boolean;
  readonly cancelled: () => boolean;
  readonly attempts: AttemptObservation[];
  readonly failures: Map<number, FailureClass>;
  pendingReprompt: string | null;
  refused: boolean;
  thrown: ProviderRunError | null;
  result: ValidateResult | null;
  spec: MiniAppSpec | null;
  abort: RunAbort | null;
}

// What the meter says about attempt n. A run abort it throws ends the whole run: it is kept in the trial's
// abort slot, so a stream that a cancel swallowed cannot lose it, the attempt is still recorded, with no
// request counted, and `aborted` tells the caller. Any other error it throws goes up unchanged.
function endAttempt(rec: Recorder, index: number, usage: Usage | null) {
  try {
    const metered = rec.args.hooks?.end(index, usage) ?? { requests: 0, refused: false };
    return { ...metered, aborted: false };
  } catch (error) {
    if (!(error instanceof RunAbort)) throw error;
    rec.abort ??= error;
    return { requests: 0, refused: false, aborted: true };
  }
}

// Closes attempt n. Returns the abort when the meter threw one, or when a finished step on the SDK loop came
// without its step record, or with one at another effort than the arm's.
function closeAttempt(
  rec: Recorder,
  opened: AttemptObservation,
  seen: RunSeen,
  stepsBefore: number,
) {
  const { index } = opened;
  const metered = endAttempt(rec, index, seen.usage);
  if (metered.refused) rec.refused = true;
  const steps = rec.args.steps().slice(stepsBefore);
  rec.attempts[index - 1] = {
    ...opened,
    reply: seen.reply,
    usage: seen.usage,
    noUsage: noUsageOf(seen),
    steps,
    requests: metered.requests,
    runError: seen.runError,
  };
  const broken = steps.length === 0 || steps.some((step) => step.effort !== rec.args.arm);
  const brokenSeam = rec.sdkLoop && seen.finished && broken;
  if (brokenSeam) {
    rec.abort ??= new RunAbort(`attempt ${index}: no model step record at the arm's effort`);
  }
  return metered.aborted || brokenSeam ? rec.abort : null;
}

// Passes the attempt's events through unchanged and closes the attempt when they end, however they end.
async function* observeAttempt(
  rec: Recorder,
  opened: AttemptObservation,
  source: AsyncGenerator<AppEvent>,
  startedAt: number,
  stepsBefore: number,
): AsyncGenerator<AppEvent> {
  const seen: RunSeen = { reply: '', finished: false, usage: null, runError: null };
  let closed = false;
  const close = () => {
    closed = true;
    return closeAttempt(
      rec,
      { ...opened, durationMs: rec.args.now() - startedAt },
      seen,
      stepsBefore,
    );
  };
  try {
    for await (const event of source) {
      note(seen, event);
      yield event;
    }
    const abort = close();
    if (abort !== null) throw abort;
  } finally {
    if (!closed) close();
  }
}

// The recording agent port: every run is one attempt, opened here before the real run is called and
// closed by its own stream.
function openAttempt(rec: Recorder, run: () => RunHandle): RunHandle {
  const opened: AttemptObservation = {
    index: rec.attempts.length + 1,
    reprompt: rec.pendingReprompt,
    reply: '',
    failure: null,
    usage: null,
    noUsage: 'consumer-closed',
    steps: [],
    requests: 0,
    runError: null,
    durationMs: 0,
  };
  rec.args.hooks?.start(opened.index);
  const startedAt = rec.args.now();
  const stepsBefore = rec.args.steps().length;
  rec.attempts.push(opened);
  rec.pendingReprompt = null;
  const handle = run();
  return { ...handle, events: observeAttempt(rec, opened, handle.events, startedAt, stepsBefore) };
}

// The recording validation: the real one, with the reprompt and the class of each failed attempt kept.
function observeValidation(rec: Recorder, real: RunAppGraph['validate']): RunAppGraph['validate'] {
  return async (stream, regenerate) => {
    try {
      const result = await real(stream, (reprompt) => {
        // After a cancel the loop only drains empty passes: no attempt opens, nothing is read.
        if (!rec.cancelled()) {
          rec.failures.set(rec.attempts.length, classOfReprompt(reprompt));
          rec.pendingReprompt = reprompt;
        }
        return regenerate(reprompt);
      });
      rec.result = result;
      if (!result.ok && !rec.cancelled()) {
        rec.failures.set(rec.attempts.length, classOfEnvelope(result.lastEnvelope));
      }
      return result;
    } catch (error) {
      if (error instanceof ProviderRunError) rec.thrown = error;
      throw error;
    }
  };
}

// The stop, in order: the trial's own timer, the meter, the session's deadline, any other provider
// failure, the loop's result; anything else the harness threw.
function stopOf(rec: Recorder, timedOut: boolean): StopKind {
  if (timedOut) return 'timeout';
  if (rec.refused) return 'spend-cap';
  if (rec.thrown !== null) {
    return rec.thrown.message === TURN_DEADLINE_MESSAGE ? 'turn-deadline' : 'provider-error';
  }
  if (rec.result?.ok === false) return 'exhausted';
  if (rec.result?.ok === true && rec.spec !== null) return 'valid';
  return 'harness-error';
}

// A harness-error keeps its cause: the message goes to the trial's diagnostics, with where it was thrown.
function reportHarnessError(deps: AppGraphDeps, stage: 'build' | 'run', error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  deps.diagnostics?.warn('trial harness error', { stage, message });
}

/** One trial: the real graph, the real runApp, four members of RunAppGraph observed. */
export async function runTrial(args: TrialArgs): Promise<TrialObservation> {
  const startedAt = args.now();
  // A graph that cannot be built ends this trial, not the run.
  const graph = await buildAppGraph(args.deps).catch((error: unknown): AppGraph | null => {
    if (error instanceof RunAbort) throw error;
    reportHarnessError(args.deps, 'build', error);
    return null;
  });
  if (graph === null) {
    return {
      stop: 'harness-error',
      attempts: [],
      spec: null,
      systemPrompt: '',
      durationMs: args.now() - startedAt,
    };
  }
  const rec: Recorder = {
    args,
    sdkLoop: isSdkLoopRoute(args.deps.route),
    cancelled: graph.cancelled,
    attempts: [],
    failures: new Map(),
    pendingReprompt: null,
    refused: false,
    thrown: null,
    result: null,
    spec: null,
    abort: null,
  };
  const observed: RunAppGraph = {
    ...graph,
    host: recordingHost((spec) => {
      rec.spec = spec;
    }),
    mountStatus: () => ({ update: () => {}, unmount: () => {} }),
    agentPort: { run: (input) => openAttempt(rec, () => graph.agentPort.run(input)) },
    validate: observeValidation(rec, graph.validate),
  };
  const cliArgs: CliArgs = {
    intent: args.intent,
    mode: 'default',
    accessible: false,
    showVersion: false,
    showHelp: false,
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    graph.cancel();
  }, args.timeoutMs);
  try {
    await runApp(cliArgs, observed);
  } catch (error) {
    if (error instanceof RunAbort) throw error;
    // anything else is the stop rule's harness-error
    reportHarnessError(args.deps, 'run', error);
  } finally {
    clearTimeout(timer);
    await graph.dispose();
  }
  // A cancelled run swallows what its stream threw, so a broken seam is rethrown from here.
  if (rec.abort !== null) throw rec.abort;
  return {
    stop: stopOf(rec, timedOut),
    attempts: rec.attempts.map((a) => ({ ...a, failure: rec.failures.get(a.index) ?? null })),
    spec: rec.spec,
    systemPrompt: graph.systemPrompt,
    durationMs: args.now() - startedAt,
  };
}
