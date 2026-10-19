import type { LanguageModel } from 'ai';
import type { DiagnosticsPort } from '@minitui/types';

// A real model object for the installed `streamText`. The provider interface is not exported by name
// from `ai`, and the provider package is not a declared dependency, so the types are derived from the
// public `LanguageModel` union.
export type SdkModel = Exclude<LanguageModel, string>;
export type CallOptions = Parameters<SdkModel['doStream']>[0];
type Stream = Awaited<ReturnType<SdkModel['doStream']>>['stream'];
export type StreamPart = Stream extends ReadableStream<infer P> ? P : never;

const USAGE = { inputTokens: 3, outputTokens: 2, totalTokens: 5 } as const;

/** A stream-start part, one text block, and a finish part with the given reason. */
export function textTurn(
  text: string,
  finishReason: Extract<StreamPart, { type: 'finish' }>['finishReason'] = 'stop',
): readonly StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason, usage: USAGE },
  ];
}

/** A stream-start part and a finish part: a reply with no content. */
export function finishOnly(
  finishReason: Extract<StreamPart, { type: 'finish' }>['finishReason'],
): readonly StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'finish', finishReason, usage: USAGE },
  ];
}

/** A stream-start part and one tool call. The model then waits for the tool result. */
export function toolCallTurn(
  toolCallId: string,
  toolName: string,
  input: unknown,
  finishReason: Extract<StreamPart, { type: 'finish' }>['finishReason'] = 'tool-calls',
): readonly StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason, usage: USAGE },
  ];
}

/** What one `doStream` call does: chunks, an optional wait, further chunks, then an ending. */
export interface CallScript {
  readonly chunks?: readonly StreamPart[];
  /** Milliseconds to wait after `chunks`. A stream that errors discards what is still queued, so a scenario
   * that fails after content was delivered must wait here first. */
  readonly waitMs?: number;
  readonly more?: readonly StreamPart[];
  /** Default 'close'. 'hang' never ends the stream; { error } errors it. */
  readonly end?: 'close' | 'hang' | { readonly error: unknown };
  /** Error the stream when the call's abort signal fires, the way a network provider does. */
  readonly errorOnAbort?: boolean;
  /** Fail the call itself before any stream exists. */
  readonly reject?: unknown;
  /** Emit this many text deltas, one every `everyMs`, instead of closing (a busy attempt). */
  readonly deltas?: { readonly count: number; readonly everyMs: number };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function buildStream(script: CallScript, signal: AbortSignal | undefined): Stream {
  return new ReadableStream<StreamPart>({
    async start(controller) {
      const onAbort = (): void => {
        if (script.errorOnAbort === true) {
          try {
            controller.error(signal?.reason ?? new Error('aborted'));
          } catch {
            /* already closed */
          }
        }
      };
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      try {
        for (const part of script.chunks ?? []) controller.enqueue(part);
        if (script.waitMs !== undefined) await sleep(script.waitMs);
        if (script.deltas !== undefined) {
          controller.enqueue({ type: 'text-start', id: 'busy' });
          for (let i = 0; i < script.deltas.count; i += 1) {
            await sleep(script.deltas.everyMs);
            controller.enqueue({ type: 'text-delta', id: 'busy', delta: '.' });
          }
          controller.enqueue({ type: 'text-end', id: 'busy' });
        }
        for (const part of script.more ?? []) controller.enqueue(part);
        const end = script.end ?? 'close';
        if (end === 'hang') return;
        if (end === 'close') controller.close();
        else controller.error(end.error);
      } catch {
        /* the stream was errored by the abort listener */
      }
    },
  });
}

export interface ScriptedModel {
  readonly model: SdkModel;
  /** The options of every `doStream` call, in order. */
  readonly calls: CallOptions[];
}

/**
 * Builds a model whose n-th `doStream` call follows `scripts[n]`. A call past the end of the list fails
 * (and so does any call past `maxCalls`), so a loop that never ends fails its test instead of hanging.
 */
export function scriptedModel(scripts: readonly CallScript[], maxCalls = 25): ScriptedModel {
  const calls: CallOptions[] = [];
  const model: SdkModel = {
    specificationVersion: 'v2',
    provider: 'scripted',
    modelId: 'scripted-model',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('doGenerate is not scripted')),
    doStream: (options) => {
      const index = calls.length;
      calls.push(options);
      const script = scripts[index];
      if (script === undefined || index >= maxCalls) {
        return Promise.reject(new Error(`scripted model: no script for call ${index + 1}`));
      }
      if (script.reject !== undefined) return Promise.reject(script.reject);
      return Promise.resolve({ stream: buildStream(script, options.abortSignal) });
    },
  };
  return { model, calls };
}

/** Records unhandled rejections of the process between `attach()` and `detach()`. */
export function rejectionRecorder(): {
  readonly seen: unknown[];
  attach(): void;
  detach(): void;
  settle(): Promise<void>;
} {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  return {
    seen,
    attach: () => {
      seen.length = 0;
      process.on('unhandledRejection', listener);
    },
    detach: () => {
      process.off('unhandledRejection', listener);
    },
    // A rejection surfaces on a later turn of the event loop: wait one timer tick of at least 50 ms.
    settle: () => sleep(60),
  };
}

// A session wired the way the composition root wires it, with a scripted model and no real I/O.
import { AgentSession, type AgentConfig } from '../../src/session/agent-session.js';
import type { ToolSchema } from '../../src/session/stream-turns.js';
import type { ToolDispatchPort, SpecSinkPort, Clock } from '../../src/ports/index.js';
import type { VisibilityChannel } from '../../src/visibility/index.js';
import type { ModelProvider } from '../../src/provider/provider-port.js';
import { activitySnapshot } from '../../src/events/event-factory.js';

const sdkProvider: ModelProvider = { id: 'sdk', usesSdkLoop: true, async *streamChat() {} };
const specSink: SpecSinkPort = { emit: (spec) => activitySnapshot(spec) };
const visibility: VisibilityChannel = {
  classOf: () => 'modelVisible',
  isModelVisible: () => true,
  projectForModel: (v) => v,
};
const okDispatch: ToolDispatchPort = {
  dispatch: (req) =>
    Promise.resolve({
      toolCallId: req.toolCallId,
      toolName: req.toolName,
      ok: true,
      content: 'done',
      isError: false,
    }),
};

export function makeSession(args: {
  readonly model: LanguageModel;
  readonly config?: AgentConfig;
  readonly tools?: readonly ToolSchema[];
  readonly toolDispatch?: ToolDispatchPort;
  /** Default: a provider that drives the SDK loop. A provider that leaves usesSdkLoop unset takes the other loop. */
  readonly provider?: ModelProvider;
  readonly clock?: Clock;
  readonly diagnostics?: DiagnosticsPort;
}): AgentSession {
  return new AgentSession({
    provider: args.provider ?? sdkProvider,
    toolDispatch: args.toolDispatch ?? okDispatch,
    specSink,
    visibility,
    tools: args.tools ?? [],
    model: args.model,
    ...(args.config !== undefined ? { config: args.config } : {}),
    ...(args.clock !== undefined ? { clock: args.clock } : {}),
    ...(args.diagnostics !== undefined ? { diagnostics: args.diagnostics } : {}),
  });
}

/** Collects a turn's events; fails the test when the turn does not end within `ms`. */
export async function collectWithin(
  turn: AsyncGenerator<{ readonly type: string }>,
  ms: number,
): Promise<string[]> {
  const types: string[] = [];
  await within(
    (async () => {
      for await (const ev of turn) types.push(ev.type);
    })(),
    ms,
    'the turn',
  );
  return types;
}

export async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
