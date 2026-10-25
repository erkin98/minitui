import { randomUUID } from 'node:crypto';
import { streamText as realStreamText, type LanguageModel } from 'ai';
import type { StreamTextFn } from '../provider/stream-part.js';
import type { AppSpec } from '@minitui/types';
import type { ModelProvider } from '../provider/provider-port.js';
import {
  systemClock,
  type ToolDispatchPort,
  type SpecSinkPort,
  type Clock,
} from '../ports/index.js';
import { noopDiagnostics, type DiagnosticsPort } from '@minitui/types';
import { routeProviderWarnings } from './model-diagnostics.js';
import type { VisibilityChannel, RedactionPolicy } from '../visibility/index.js';
import type { MinituiEvent } from '../events/event-types.js';
import { createAsyncEventQueue, type AsyncEventQueue } from '../events/event-stream.js';
import { createConversation, type Conversation } from './conversation.js';
import { runTurns, runProviderStream, type ToolSchema, type RunTurnsDeps } from './stream-turns.js';
import { withTimeout } from '../guards/timeout.js';
import { runStarted, runError } from '../events/event-factory.js';
import { DEFAULT_STEP_CEILING } from '../guards/loop-guard.js';

export interface AgentConfig {
  readonly turnTimeoutMs?: number;
  readonly stepCeiling?: number;
  readonly system?: string | undefined;
  /** Per-pull idle deadline for the model stream (default applied in runTurns). */
  readonly idleTimeoutMs?: number;
  /** Mid-stream-drop re-run budget (default applied in runTurns). */
  readonly streamMaxRetries?: number;
  /** Output-token ceiling for one model call; forwarded to the model only when set. */
  readonly maxOutputTokens?: number;
  /**
   * Test seam: the streamText the SDK-driven loop calls. Production leaves this undefined (the installed
   * SDK is used). It does not choose the loop: the provider's usesSdkLoop does.
   */
  readonly streamTextImpl?: StreamTextFn;
  /**
   * Host redaction policy applied to every tool result on the model-feed path — the safety valve for
   * org-specific secret shapes the built-in heuristics miss (extraSecretPatterns) and for a custom
   * home/tmp. Threaded to routeToolCallResult on both the SDK and non-SDK loops; the built-in patterns +
   * default $HOME/$TMPDIR still fire when this is undefined.
   */
  readonly redactionPolicy?: RedactionPolicy | undefined;
}

// The largest delay a Node timer takes: a larger value is clamped to one millisecond.
const MAX_TIMER_MS = 2 ** 31 - 1;

// The numeric config fields and the integer range each accepts. An absent field keeps its default.
const CONFIG_LIMITS: ReadonlyArray<
  readonly [
    field: Exclude<keyof AgentConfig, 'system' | 'streamTextImpl' | 'redactionPolicy'>,
    min: number,
    max: number,
  ]
> = [
  ['stepCeiling', 1, 1000],
  ['turnTimeoutMs', 1, MAX_TIMER_MS],
  ['idleTimeoutMs', 1, MAX_TIMER_MS],
  ['streamMaxRetries', 0, 10],
  ['maxOutputTokens', 1, MAX_TIMER_MS],
];

/** Throws a RangeError that names the field when a present numeric value is not an integer in range. */
function assertConfig(config: AgentConfig): void {
  for (const [field, min, max] of CONFIG_LIMITS) {
    const value = config[field];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new RangeError(`AgentConfig.${field} must be an integer from ${min} to ${max}`);
    }
  }
}

/** A whole-turn deadline (AbortSignal.timeout) aborts with a TimeoutError; a user cancel with an AbortError. */
function isTimeoutAbort(signal: AbortSignal): boolean {
  return signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError';
}

const isTerminalEvent = (ev: MinituiEvent): boolean =>
  ev.type === 'RUN_FINISHED' || ev.type === 'RUN_ERROR';

/**
 * The event that closes a turn whose run produced no terminal event, or undefined when it ends silently:
 * a user cancel is the consumer's own doing; a deadline surfaces a non-retriable error; anything else means
 * the runner died inside its own error path, and the consumer is still told the turn is over.
 */
function endingWithoutResult(signal: AbortSignal): MinituiEvent | undefined {
  if (isTimeoutAbort(signal)) return runError('turn exceeded its time budget', 'non-retriable');
  if (signal.aborted) return undefined;
  return runError('turn ended without a result', 'non-retriable');
}

/** Closes the queue the moment the signal aborts, so a consumer parked on a hung run is released at once. */
function closeOnAbort(signal: AbortSignal, queue: AsyncEventQueue<MinituiEvent>): void {
  if (signal.aborted) queue.close();
  else signal.addEventListener('abort', () => queue.close(), { once: true });
}

/**
 * Yields the queue's events until it ends. Events still buffered when the turn signal has aborted are
 * dropped. Returns whether a terminal event was seen.
 */
async function* drain(
  queue: AsyncEventQueue<MinituiEvent>,
  signal: AbortSignal,
): AsyncGenerator<MinituiEvent, boolean> {
  let sawTerminal = false;
  for await (const ev of queue) {
    if (signal.aborted) break;
    if (isTerminalEvent(ev)) sawTerminal = true;
    yield ev;
  }
  return sawTerminal;
}

/**
 * The agent loop facade. The composition root wraps submit() into a local AgentPort with a thin adapter
 * — `createLocalAgentPort((input, signal) => submit(intentFrom(input), { signal }))` — since the port's
 * genFactory takes `(RunAgentInput, AbortSignal)` while submit takes `(intent, opts)`. The yielded event
 * type already matches exactly (MinituiEvent = the transport AgentPort's AgentEvent), so only the call
 * shape is adapted, never the event.
 */
export class AgentSession {
  readonly threadId: string;
  // Every live turn's controller: cancel() aborts them all. A controller leaves the set in its turn's finally.
  readonly #controllers = new Set<AbortController>();
  // The queue of the most recently started turn: emitSpec() pushes there.
  #queue: AsyncEventQueue<MinituiEvent> | undefined;
  readonly #provider: ModelProvider;
  readonly #toolDispatch: ToolDispatchPort;
  readonly #specSink: SpecSinkPort;
  readonly #tools: readonly ToolSchema[];
  readonly #model: LanguageModel;
  readonly #config: AgentConfig;
  readonly #clock: Clock;
  readonly #diagnostics: DiagnosticsPort;

  constructor(deps: {
    provider: ModelProvider;
    toolDispatch: ToolDispatchPort;
    specSink: SpecSinkPort;
    visibility: VisibilityChannel;
    tools: readonly ToolSchema[];
    model: LanguageModel;
    clock?: Clock;
    diagnostics?: DiagnosticsPort;
    config?: AgentConfig;
  }) {
    this.threadId = randomUUID();
    // provider supplies the day-1 model handle and is the swap point for a non-SDK provider. specSink is
    // LIVE here — emitSpec() below is its call path. clock (re-run waits) and diagnostics are read from here
    // on. visibility is accepted as a required seam dep but is not read on this path yet (it will drive
    // observation routing); a field is added the same change that first reads it, so no unread state
    // lingers here.
    this.#provider = deps.provider;
    this.#toolDispatch = deps.toolDispatch;
    this.#specSink = deps.specSink;
    this.#tools = deps.tools;
    this.#model = deps.model;
    this.#config = deps.config ?? {};
    assertConfig(this.#config);
    this.#clock = deps.clock ?? systemClock;
    this.#diagnostics = deps.diagnostics ?? noopDiagnostics;
  }

  /**
   * Starts a turn. An ordinary method: the turn's controller is created and registered when this is called,
   * so a cancel() between submit() and the first pull is seen. A turn that is cancelled before its first
   * pull yields nothing, and a consumer must accept a turn with zero events. A generator that is never
   * pulled keeps its controller in the set until cancel().
   */
  submit(intent: string, opts?: { signal?: AbortSignal }): AsyncGenerator<MinituiEvent> {
    const controller = new AbortController();
    this.#controllers.add(controller);
    return this.#turn(intent, opts?.signal, controller);
  }

  async *#turn(
    intent: string,
    callerSignal: AbortSignal | undefined,
    controller: AbortController,
  ): AsyncGenerator<MinituiEvent> {
    const queue = createAsyncEventQueue<MinituiEvent>();
    try {
      // Aborted before the first pull: no RUN_STARTED, and neither the model nor the dispatch port is called.
      if (controller.signal.aborted || callerSignal?.aborted === true) return;
      const signal = withTimeout(
        callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal,
        this.#config.turnTimeoutMs ?? 120_000,
      );
      closeOnAbort(signal, queue);
      // Keep the SDK's provider warnings off the console, for this turn's diagnostics port.
      routeProviderWarnings(this.#diagnostics);
      this.#queue = queue;
      // One runId per run — runId is REQUIRED on RUN_STARTED/RUN_FINISHED (this layer owns run identity;
      // the transport adapter never synthesizes ids).
      const runId = randomUUID();
      yield runStarted(this.threadId, runId);

      const conversation = createConversation(
        this.#config.system ? [{ role: 'system', content: this.#config.system }] : [],
      ).append({ role: 'user', content: intent });

      // The run's own errors surface as in-band RUN_ERROR events, so a terminal .catch keeps a
      // hypothetical runner rejection from escaping as an unhandledRejection.
      void this.#startRunner({ conversation, runId, queue, signal })
        .finally(() => queue.close())
        .catch(() => {});

      const sawTerminal = yield* drain(queue, signal);
      // The whole-turn deadline aborts the SAME signal the loop breaks on, so a timed-out turn would
      // otherwise leave RUN_STARTED unbracketed (the stream returns silently on abort). A user cancel
      // (AbortError) ends silently by design — the consumer initiated it; a deadline (TimeoutError from
      // AbortSignal.timeout) surfaces a non-retriable RUN_ERROR so the consumer learns the turn ended.
      if (!sawTerminal) {
        const ending = endingWithoutResult(signal);
        if (ending !== undefined) yield ending;
      }
    } finally {
      // Abort on ANY exit so abandoning the generator (consumer break/throw/.return()) tears down the
      // run graph — the model stream and any in-flight tool dispatch stop, not just the queue. Harmless
      // on normal completion (the run has already finished). Then close: with backpressure runTurns can
      // be parked on an awaited push when the consumer stops draining; close() releases parked producers
      // so the graph unwinds instead of deadlocking. Idempotent with runTurns' own finally(queue.close()).
      controller.abort();
      this.#controllers.delete(controller);
      queue.close();
      if (this.#queue === queue) this.#queue = undefined;
    }
  }

  /**
   * Route the turn. SDK path (runTurns — the SDK-owned streamText tool loop) when the provider drives
   * the SDK loop (the day-1 ai-sdk-provider sets usesSdkLoop); a test seam streamTextImpl replaces the
   * SDK function on that path and chooses nothing. Otherwise the NON-SDK path (runProviderStream) that
   * consumes provider.streamChat directly, which is what a scripted provider needs.
   */
  #startRunner(args: {
    conversation: Conversation;
    runId: string;
    queue: AsyncEventQueue<MinituiEvent>;
    signal: AbortSignal;
  }): Promise<void> {
    const { conversation, runId, queue, signal } = args;
    if (this.#provider.usesSdkLoop !== true) {
      return runProviderStream({
        provider: this.#provider,
        conversation,
        threadId: this.threadId,
        runId,
        model: this.#model,
        system: this.#config.system,
        toolDispatch: this.#toolDispatch,
        tools: this.#tools,
        redactionPolicy: this.#config.redactionPolicy,
        queue,
        signal,
      });
    }
    const deps: RunTurnsDeps = {
      streamTextImpl: this.#config.streamTextImpl ?? realStreamText,
      toolDispatch: this.#toolDispatch,
      tools: this.#tools,
      stepCeiling: this.#config.stepCeiling ?? DEFAULT_STEP_CEILING,
      // Stream-resilience knobs threaded through; runTurns applies the defaults when undefined.
      idleTimeoutMs: this.#config.idleTimeoutMs,
      streamMaxRetries: this.#config.streamMaxRetries,
      redactionPolicy: this.#config.redactionPolicy,
      model: this.#model,
      maxOutputTokens: this.#config.maxOutputTokens,
      clock: this.#clock,
      diagnostics: this.#diagnostics,
    };
    return runTurns({ conversation, threadId: this.threadId, runId, queue, signal, deps });
  }

  /**
   * The LIVE SpecSinkPort path: a generated spec leaves the loop as an ACTIVITY_SNAPSHOT. The compose-loop
   * caller (after validation passes) hands the validated spec here; the event is pushed into the in-flight
   * submit() stream (if a turn is active) AND returned, so the caller can also forward it when the turn has
   * already closed. This layer renders nothing.
   */
  emitSpec(spec: AppSpec): MinituiEvent {
    const ev = this.#specSink.emit(spec);
    // push() is awaitable (queue backpressure) but a single spec snapshot is fire-and-forget: the value is
    // enqueued synchronously, so `void` here never loses it.
    void this.#queue?.push(ev);
    return ev;
  }

  /**
   * Aborts the provider stream AND running tool dispatch of EVERY live turn, including one that has been
   * submitted but not yet pulled. Also the SIGINT hook: a signal handler calls cancel() BEFORE restoring
   * the terminal, so the run graph unwinds instead of orphaning in-flight tool processes.
   */
  cancel(): void {
    for (const controller of [...this.#controllers]) controller.abort();
  }
}
