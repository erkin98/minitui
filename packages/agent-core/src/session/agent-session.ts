import { randomUUID } from 'node:crypto';
import { streamText as realStreamText, type LanguageModel } from 'ai';
import type { AppSpec } from '@minitui/types';
import type { ModelProvider } from '../provider/provider-port.js';
import type { ToolDispatchPort, SpecSinkPort, Clock } from '../ports/index.js';
import type { VisibilityChannel, RedactionPolicy } from '../visibility/index.js';
import type { MinituiEvent } from '../events/event-types.js';
import { createAsyncEventQueue, type AsyncEventQueue } from '../events/event-stream.js';
import { createConversation } from './conversation.js';
import { runTurns, runProviderStream, type ToolSchema, type RunTurnsDeps } from './stream-turns.js';
import { withTimeout } from '../guards/timeout.js';
import { runStarted } from '../events/event-factory.js';
import { DEFAULT_STEP_CEILING } from '../guards/loop-guard.js';

export interface AgentConfig {
  readonly turnTimeoutMs?: number;
  readonly stepCeiling?: number;
  readonly system?: string | undefined;
  /** Per-pull idle deadline for the model stream (default applied in runTurns). */
  readonly idleTimeoutMs?: number;
  /** Mid-stream-drop re-run budget (default applied in runTurns). */
  readonly streamMaxRetries?: number;
  /** Test seam: inject a fake streamText. Production leaves this undefined (the real SDK is used). */
  readonly streamTextImpl?: typeof realStreamText;
  /**
   * Host redaction policy applied to every tool result on the model-feed path — the safety valve for
   * org-specific secret shapes the built-in heuristics miss (extraSecretPatterns) and for a custom
   * home/tmp. Threaded to routeToolCallResult on both the SDK and non-SDK loops; the built-in patterns +
   * default $HOME/$TMPDIR still fire when this is undefined.
   */
  readonly redactionPolicy?: RedactionPolicy | undefined;
}

/** The agent loop facade. submit() is what the composition root hands createLocalAgentPort(session.submit). */
export class AgentSession {
  readonly threadId: string;
  #controller: AbortController | undefined;
  #queue: AsyncEventQueue<MinituiEvent> | undefined;
  readonly #provider: ModelProvider;
  readonly #toolDispatch: ToolDispatchPort;
  readonly #specSink: SpecSinkPort;
  readonly #tools: readonly ToolSchema[];
  readonly #model: LanguageModel;
  readonly #config: AgentConfig;

  constructor(deps: {
    provider: ModelProvider;
    toolDispatch: ToolDispatchPort;
    specSink: SpecSinkPort;
    visibility: VisibilityChannel;
    tools: readonly ToolSchema[];
    model: LanguageModel;
    clock?: Clock;
    config?: AgentConfig;
  }) {
    this.threadId = randomUUID();
    // provider supplies the day-1 model handle and is the swap point for a non-SDK provider. specSink is
    // LIVE here — emitSpec() below is its call path. visibility and clock are accepted as required seam
    // deps but are not read on this path yet (visibility drives observation routing in a later slice); a
    // field is added the same change that first reads them, so no unread state lingers here.
    this.#provider = deps.provider;
    this.#toolDispatch = deps.toolDispatch;
    this.#specSink = deps.specSink;
    this.#tools = deps.tools;
    this.#model = deps.model;
    this.#config = deps.config ?? {};
  }

  async *submit(intent: string, opts?: { signal?: AbortSignal }): AsyncGenerator<MinituiEvent> {
    const controller = new AbortController();
    this.#controller = controller;
    // One runId per run — runId is REQUIRED on RUN_STARTED/RUN_FINISHED (this layer owns run identity;
    // the transport adapter never synthesizes ids).
    const runId = randomUUID();
    const signal = withTimeout(
      opts?.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal,
      this.#config.turnTimeoutMs ?? 120_000,
    );

    const queue = createAsyncEventQueue<MinituiEvent>();
    this.#queue = queue;
    yield runStarted(this.threadId, runId);

    const conversation = createConversation(
      this.#config.system ? [{ role: 'system', content: this.#config.system }] : [],
    ).append({ role: 'user', content: intent });

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
    };

    // Route the turn. SDK path (runTurns — the SDK-owned streamText tool loop) when the provider drives
    // the SDK loop (the day-1 ai-sdk-provider sets usesSdkLoop) OR a fake streamText is injected for a
    // test. Otherwise the NON-SDK path (runProviderStream) that consumes provider.streamChat directly —
    // what a scripted provider needs (no streamTextImpl, no usesSdkLoop); without this branch the injected
    // script is dead and only RUN_STARTED reaches out.
    const useSdkLoop =
      this.#config.streamTextImpl !== undefined || this.#provider.usesSdkLoop === true;
    try {
      const runner = useSdkLoop
        ? runTurns({ conversation, threadId: this.threadId, runId, queue, signal, deps })
        : runProviderStream({
            provider: this.#provider,
            conversation,
            threadId: this.threadId,
            runId,
            model: this.#model,
            system: this.#config.system,
            toolDispatch: this.#toolDispatch,
            redactionPolicy: this.#config.redactionPolicy,
            queue,
            signal,
          });
      // The run's own errors surface as in-band RUN_ERROR events, so a terminal .catch keeps a
      // hypothetical runner rejection from escaping as an unhandledRejection.
      void runner.finally(() => queue.close()).catch(() => {});

      for await (const ev of queue) {
        if (signal.aborted) break;
        yield ev;
      }
    } finally {
      // Abort on ANY exit so abandoning the generator (consumer break/throw/.return()) tears down the
      // run graph — the model stream and any in-flight tool dispatch stop, not just the queue. Harmless
      // on normal completion (the run has already finished). Then close: with backpressure runTurns can
      // be parked on an awaited push when the consumer stops draining; close() releases parked producers
      // so the graph unwinds instead of deadlocking. Idempotent with runTurns' own finally(queue.close()).
      controller.abort();
      queue.close();
      if (this.#queue === queue) this.#queue = undefined;
    }
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
   * Aborts the provider stream AND running tool dispatch together (one controller). Also the SIGINT hook:
   * a signal handler calls cancel() BEFORE restoring the terminal, so the run graph unwinds instead of
   * orphaning in-flight tool processes.
   */
  cancel(): void {
    this.#controller?.abort();
  }
}
