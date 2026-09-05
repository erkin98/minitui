import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { runTurns, runProviderStream } from '../src/session/stream-turns.js';
import { createAsyncEventQueue } from '../src/events/event-stream.js';
import { createConversation } from '../src/session/conversation.js';
import type { MinituiEvent } from '../src/events/event-types.js';
import type { ToolDispatchPort, ToolCallResult } from '../src/ports/index.js';
import type { ModelProvider } from '../src/provider/provider-port.js';

// Fake streamText that (1) calls a registered tool's execute, then (2) emits a real fullStream.
// Mirrors the real result shape: fullStream is an async-iterable PROPERTY, not a method.
function fakeStreamText(opts: {
  callTool?: { name: string; input: unknown };
  parts: Array<Record<string, unknown>>;
}) {
  return ((args: {
    tools?: Record<
      string,
      { execute: (i: unknown, ctx: { toolCallId: string }) => Promise<unknown> }
    >;
  }) => {
    const ran: Promise<unknown>[] = [];
    if (opts.callTool && args.tools?.[opts.callTool.name]) {
      // a failed execute THROWS by design; the real SDK catches it (tool-error) — mirror that here
      ran.push(
        args.tools[opts.callTool.name]!.execute(opts.callTool.input, { toolCallId: 't1' }).catch(
          () => undefined,
        ),
      );
    }
    return {
      fullStream: (async function* () {
        await Promise.all(ran);
        for (const p of opts.parts) yield p;
      })(),
    };
  }) as unknown as typeof import('ai').streamText;
}

// A fake streamText that ACTUALLY consults the passed stopWhen conditions across simulated steps,
// proving the doom-loop ceiling is wired into runTurns (not just unit-tested in isolation).
// Synchronous return (like the real streamText); the simulated loop runs lazily inside fullStream.
function loopingStreamText(opts: {
  repeatCall: { name: string; input: unknown };
  maxSimSteps: number;
  onDone: (sim: { simulatedSteps: number; stopped: boolean }) => void;
}) {
  return ((args: {
    tools?: Record<
      string,
      { execute: (i: unknown, ctx: { toolCallId: string }) => Promise<unknown> }
    >;
    stopWhen?: ReadonlyArray<(s: { steps: ReadonlyArray<unknown> }) => boolean | Promise<boolean>>;
  }) => ({
    fullStream: (async function* () {
      const steps: Array<{ toolCalls: Array<{ toolName: string; input: unknown }> }> = [];
      let stopped = false;
      for (let i = 0; i < opts.maxSimSteps; i += 1) {
        await args.tools?.[opts.repeatCall.name]?.execute(opts.repeatCall.input, {
          toolCallId: `t${i}`,
        });
        steps.push({
          toolCalls: [{ toolName: opts.repeatCall.name, input: opts.repeatCall.input }],
        });
        const results = await Promise.all((args.stopWhen ?? []).map((c) => c({ steps })));
        if (results.some(Boolean)) {
          stopped = true;
          break;
        }
      }
      opts.onDone({ simulatedSteps: steps.length, stopped });
      yield { type: 'finish', finishReason: 'stop' };
    })(),
  })) as unknown as typeof import('ai').streamText;
}

const dispatch: ToolDispatchPort = {
  dispatch: async (req): Promise<ToolCallResult> => ({
    toolCallId: req.toolCallId,
    ok: true,
    toolName: req.toolName,
    content: 'done',
    isError: false,
  }),
};

const tools = [{ name: 'ffmpeg', description: 'merge', inputSchema: z.object({ a: z.number() }) }];

describe('stream-turns', () => {
  it('maps fullStream parts to MinituiEvents in order, RUN_FINISHED carries the real threadId+runId', async () => {
    const queue = createAsyncEventQueue<MinituiEvent>();
    const parts = [
      { type: 'text-delta', text: 'on it' },
      { type: 'tool-call', toolCallId: 't1', toolName: 'ffmpeg', input: { a: 1 } },
      { type: 'finish', finishReason: 'stop' },
    ];
    const done = runTurns({
      conversation: createConversation([{ role: 'user', content: 'merge' }]),
      threadId: 'thread-xyz',
      runId: 'run-1',
      queue,
      signal: new AbortController().signal,
      deps: {
        streamTextImpl: fakeStreamText({ parts }),
        toolDispatch: dispatch,
        tools,
        model: 'test-model',
      },
    }).then(() => queue.close());
    const out: MinituiEvent[] = [];
    for await (const e of queue) out.push(e);
    await done;
    expect(out.map((e) => e.type)).toEqual([
      'TEXT_MESSAGE_CONTENT',
      'TOOL_CALL_START',
      'RUN_FINISHED',
    ]);
    expect(out.at(-1)).toMatchObject({
      type: 'RUN_FINISHED',
      threadId: 'thread-xyz',
      runId: 'run-1',
    });
  });

  it("delegates a tool's execute to ToolDispatchPort with { toolName, args }", async () => {
    const queue = createAsyncEventQueue<MinituiEvent>();
    const localCalls: Array<Parameters<ToolDispatchPort['dispatch']>> = [];
    const localDispatch: ToolDispatchPort = {
      dispatch: async (req, signal): Promise<ToolCallResult> => {
        localCalls.push([req, signal]);
        return {
          toolCallId: req.toolCallId,
          ok: true,
          toolName: req.toolName,
          content: '42',
          isError: false,
        };
      },
    };
    const done = runTurns({
      conversation: createConversation(),
      threadId: 'tid',
      runId: 'run-1',
      queue,
      signal: new AbortController().signal,
      deps: {
        streamTextImpl: fakeStreamText({
          callTool: { name: 'ffmpeg', input: { a: 1 } },
          parts: [{ type: 'finish', finishReason: 'stop' }],
        }),
        toolDispatch: localDispatch,
        tools,
        model: 'test-model',
      },
    }).then(() => queue.close());
    for await (const _ of queue) void _;
    await done;
    expect(localCalls).toHaveLength(1);
    const firstCall = localCalls[0]!;
    expect(firstCall[0]).toMatchObject({ toolName: 'ffmpeg', args: { a: 1 } });
    expect(firstCall[1]).toBeInstanceOf(AbortSignal);
  });

  it('THROWS a failed dispatch out of execute so the SDK emits tool-error -> TOOL_CALL_RESULT isError:true', async () => {
    // A thrown execute is caught by the SDK and emitted as a 'tool-error' part (never a tool-result).
    // Returning the failure content instead would re-feed it to the model as a SUCCESS — the exact
    // drift this test pins down.
    const failingDispatch: ToolDispatchPort = {
      dispatch: async (req) => ({
        toolCallId: req.toolCallId,
        ok: false,
        toolName: req.toolName,
        content: 'exit 1: bad file',
        isError: true,
      }),
    };
    const sdkLike = ((args: {
      tools?: Record<
        string,
        { execute: (i: unknown, c: { toolCallId: string }) => Promise<unknown> }
      >;
    }) => ({
      fullStream: (async function* () {
        const parts: Array<Record<string, unknown>> = [];
        try {
          const output = await args.tools?.ffmpeg?.execute({ a: 1 }, { toolCallId: 't1' });
          parts.push({
            type: 'tool-result',
            toolCallId: 't1',
            toolName: 'ffmpeg',
            input: { a: 1 },
            output,
          });
        } catch (error) {
          parts.push({
            type: 'tool-error',
            toolCallId: 't1',
            toolName: 'ffmpeg',
            input: { a: 1 },
            error,
          });
        }
        parts.push({ type: 'finish', finishReason: 'stop' });
        for (const p of parts) yield p;
      })(),
    })) as unknown as typeof import('ai').streamText;
    const queue = createAsyncEventQueue<MinituiEvent>();
    const done = runTurns({
      conversation: createConversation(),
      threadId: 'tid',
      runId: 'run-1',
      queue,
      signal: new AbortController().signal,
      deps: { streamTextImpl: sdkLike, toolDispatch: failingDispatch, tools, model: 'test-model' },
    }).then(() => queue.close());
    const out: MinituiEvent[] = [];
    for await (const e of queue) out.push(e);
    await done;
    expect(out).toContainEqual(
      expect.objectContaining({
        type: 'TOOL_CALL_RESULT',
        toolCallId: 't1',
        isError: true,
        content: expect.stringContaining('exit 1: bad file'),
      }),
    );
  });

  it('preserves the denied bit on the observation when a permission gate refuses', async () => {
    // A host permission-gate refusal (ok:false + denied:true) must stay DISTINGUISHABLE from a plain
    // execution failure on the model-facing observation — not flattened into error text. buildTools
    // attaches `denied` to the thrown Error; the SDK echoes it as the tool-error part's `error`, and
    // the fullStream mapping re-emits the observation with denied:true.
    const deniedDispatch: ToolDispatchPort = {
      dispatch: async (req) => ({
        toolCallId: req.toolCallId,
        ok: false,
        toolName: req.toolName,
        content: 'permission denied',
        isError: true,
        denied: true,
      }),
    };
    const sdkLike = ((args: {
      tools?: Record<
        string,
        { execute: (i: unknown, c: { toolCallId: string }) => Promise<unknown> }
      >;
    }) => ({
      fullStream: (async function* () {
        const parts: Array<Record<string, unknown>> = [];
        try {
          const output = await args.tools?.ffmpeg?.execute({ a: 1 }, { toolCallId: 't1' });
          parts.push({
            type: 'tool-result',
            toolCallId: 't1',
            toolName: 'ffmpeg',
            input: { a: 1 },
            output,
          });
        } catch (error) {
          parts.push({
            type: 'tool-error',
            toolCallId: 't1',
            toolName: 'ffmpeg',
            input: { a: 1 },
            error,
          });
        }
        parts.push({ type: 'finish', finishReason: 'stop' });
        for (const p of parts) yield p;
      })(),
    })) as unknown as typeof import('ai').streamText;
    const queue = createAsyncEventQueue<MinituiEvent>();
    const done = runTurns({
      conversation: createConversation(),
      threadId: 'tid',
      runId: 'run-1',
      queue,
      signal: new AbortController().signal,
      deps: { streamTextImpl: sdkLike, toolDispatch: deniedDispatch, tools, model: 'test-model' },
    }).then(() => queue.close());
    const out: MinituiEvent[] = [];
    for await (const e of queue) out.push(e);
    await done;
    // The denied distinction survives structurally on the TOOL_CALL_RESULT observation (not just as
    // "Denied:" text) — a host refusal, not an execution failure.
    expect(out).toContainEqual(
      expect.objectContaining({
        type: 'TOOL_CALL_RESULT',
        toolCallId: 't1',
        isError: true,
        denied: true,
      }),
    );
  });

  it('redacts every dispatch result through routeToolCallResult before the SDK re-feed', async () => {
    // The attack: a tool result (or failure detail) carrying a secret-shaped token. buildTools'
    // execute must hand the dispatch result to routeToolCallResult — the single redaction chokepoint —
    // so the SDK re-feeds ONLY redacted strings, on the success return AND on the failure throw.
    // Returning result.content raw would hand the model the secret verbatim.
    const secret = 'sk-abc123DEF456ghi789JKL012mno';
    const leakyDispatch: ToolDispatchPort = {
      dispatch: async (req) =>
        req.args.fail === true
          ? {
              toolCallId: req.toolCallId,
              ok: false,
              toolName: req.toolName,
              content: '',
              isError: true,
              error: `boom ${secret}`,
            }
          : {
              toolCallId: req.toolCallId,
              ok: true,
              toolName: req.toolName,
              content: `key ${secret} written`,
              isError: false,
            },
    };
    const sdkLike = ((args: {
      tools?: Record<
        string,
        { execute: (i: unknown, c: { toolCallId: string }) => Promise<unknown> }
      >;
    }) => ({
      fullStream: (async function* () {
        const parts: Array<Record<string, unknown>> = [];
        const output = await args.tools?.ffmpeg?.execute({ a: 1 }, { toolCallId: 't-ok' });
        parts.push({
          type: 'tool-result',
          toolCallId: 't-ok',
          toolName: 'ffmpeg',
          input: { a: 1 },
          output,
        });
        try {
          await args.tools?.ffmpeg?.execute({ fail: true }, { toolCallId: 't-err' });
        } catch (error) {
          parts.push({
            type: 'tool-error',
            toolCallId: 't-err',
            toolName: 'ffmpeg',
            input: { fail: true },
            error,
          });
        }
        parts.push({ type: 'finish', finishReason: 'stop' });
        for (const p of parts) yield p;
      })(),
    })) as unknown as typeof import('ai').streamText;
    const queue = createAsyncEventQueue<MinituiEvent>();
    const done = runTurns({
      conversation: createConversation(),
      threadId: 'tid',
      runId: 'run-1',
      queue,
      signal: new AbortController().signal,
      deps: { streamTextImpl: sdkLike, toolDispatch: leakyDispatch, tools, model: 'test-model' },
    }).then(() => queue.close());
    const out: MinituiEvent[] = [];
    for await (const e of queue) out.push(e);
    await done;
    // The queue's TOOL_CALL_RESULT events mirror exactly what the SDK saw (the tool-result part's
    // output / the tool-error part's message): the raw secret must be gone from BOTH paths,
    // replaced by the redaction placeholder.
    const results = out.filter((e) => e.type === 'TOOL_CALL_RESULT');
    expect(results).toHaveLength(2);
    expect(JSON.stringify(results)).not.toContain(secret);
    expect(JSON.stringify(results)).toContain('[redacted-secret]');
  });

  it('redacts a REJECTED dispatch on BOTH the model re-feed and the observation', async () => {
    // A dispatch that REJECTS (an unexpected throw, not the modelled ok:false result) must still cross the
    // redaction chokepoint. buildTools' execute catches the rejection and rethrows a REDACTED Error, so the
    // secret reaches neither the SDK's model re-feed (the thrown Error the SDK echoes back) NOR the
    // observation. Without the catch, the raw rejection would flow straight to the model as a failure.
    const secret = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa';
    const rejectingDispatch: ToolDispatchPort = {
      dispatch: async () => {
        throw new Error(`boom ${secret}`);
      },
    };
    // The SDK fake captures the error execute rethrew (the model re-feed exit) AND surfaces it as a
    // tool-error part (the observation exit), mirroring the real SDK's tool-error path.
    const caught: unknown[] = [];
    const sdkLike = ((args: {
      tools?: Record<
        string,
        { execute: (i: unknown, c: { toolCallId: string }) => Promise<unknown> }
      >;
    }) => ({
      fullStream: (async function* () {
        const parts: Array<Record<string, unknown>> = [];
        try {
          const output = await args.tools?.ffmpeg?.execute({ a: 1 }, { toolCallId: 't1' });
          parts.push({
            type: 'tool-result',
            toolCallId: 't1',
            toolName: 'ffmpeg',
            input: { a: 1 },
            output,
          });
        } catch (error) {
          caught.push(error);
          parts.push({
            type: 'tool-error',
            toolCallId: 't1',
            toolName: 'ffmpeg',
            input: { a: 1 },
            error,
          });
        }
        parts.push({ type: 'finish', finishReason: 'stop' });
        for (const p of parts) yield p;
      })(),
    })) as unknown as typeof import('ai').streamText;
    const queue = createAsyncEventQueue<MinituiEvent>();
    const done = runTurns({
      conversation: createConversation(),
      threadId: 'tid',
      runId: 'run-1',
      queue,
      signal: new AbortController().signal,
      deps: {
        streamTextImpl: sdkLike,
        toolDispatch: rejectingDispatch,
        tools,
        model: 'test-model',
      },
    }).then(() => queue.close());
    const out: MinituiEvent[] = [];
    for await (const e of queue) out.push(e);
    await done;
    // Exit 1 — the model re-feed: the Error execute rethrew (which the SDK echoes to the model) is redacted.
    // This is the assert the try/catch keeps honest: remove it and the raw key reaches this exit.
    expect(caught).toHaveLength(1);
    expect((caught[0] as Error).message).toContain('[redacted-secret]');
    expect((caught[0] as Error).message).not.toContain(secret);
    // Exit 2 — the observation: the queued TOOL_CALL_RESULT carries the redacted text on content AND error.
    const result = out.find((e) => e.type === 'TOOL_CALL_RESULT');
    expect(result).toBeDefined();
    if (result?.type === 'TOOL_CALL_RESULT') {
      expect(result.content).toContain('[redacted-secret]');
      expect(result.error).toContain('[redacted-secret]');
    }
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it('applies the host redactionPolicy (extraSecretPatterns) on the SDK loop', async () => {
    // An org-specific token shape the built-in patterns deliberately MISS. It is redacted ONLY because
    // AgentConfig.redactionPolicy threads through RunTurnsDeps to routeToolCallResult — if that wiring
    // breaks, the built-ins never match this shape and the org token reaches the model verbatim.
    const orgToken = 'COMPANY-123456';
    const orgDispatch: ToolDispatchPort = {
      dispatch: async (req) => ({
        toolCallId: req.toolCallId,
        ok: true,
        toolName: req.toolName,
        content: `wrote ${orgToken}`,
        isError: false,
      }),
    };
    const sdkLike = ((args: {
      tools?: Record<
        string,
        { execute: (i: unknown, c: { toolCallId: string }) => Promise<unknown> }
      >;
    }) => ({
      fullStream: (async function* () {
        const output = await args.tools?.ffmpeg?.execute({ a: 1 }, { toolCallId: 't-ok' });
        yield {
          type: 'tool-result',
          toolCallId: 't-ok',
          toolName: 'ffmpeg',
          input: { a: 1 },
          output,
        };
        yield { type: 'finish', finishReason: 'stop' };
      })(),
    })) as unknown as typeof import('ai').streamText;
    const queue = createAsyncEventQueue<MinituiEvent>();
    const done = runTurns({
      conversation: createConversation(),
      threadId: 'tid',
      runId: 'run-1',
      queue,
      signal: new AbortController().signal,
      deps: {
        streamTextImpl: sdkLike,
        toolDispatch: orgDispatch,
        tools,
        model: 'test-model',
        redactionPolicy: { extraSecretPatterns: [/COMPANY-\d{6}/g] },
      },
    }).then(() => queue.close());
    const out: MinituiEvent[] = [];
    for await (const e of queue) out.push(e);
    await done;
    const results = out.filter((e) => e.type === 'TOOL_CALL_RESULT');
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results)).not.toContain(orgToken);
    expect(JSON.stringify(results)).toContain('[redacted-secret]');
  });

  it('halts the wired SDK loop when repeatedToolCallDetector fires (doom-loop exit)', async () => {
    const queue = createAsyncEventQueue<MinituiEvent>();
    let captured: { simulatedSteps: number; stopped: boolean } | undefined;
    const impl = loopingStreamText({
      repeatCall: { name: 'ffmpeg', input: { a: 1 } },
      maxSimSteps: 20,
      onDone: (sim) => (captured = sim),
    });
    const done = runTurns({
      conversation: createConversation(),
      threadId: 'tid',
      runId: 'run-1',
      queue,
      signal: new AbortController().signal,
      deps: { streamTextImpl: impl, toolDispatch: dispatch, tools, model: 'test-model' },
    }).then(() => queue.close());
    for await (const _ of queue) void _;
    await done;
    // repeatedToolCallDetector(default 3) must fire BEFORE the 20-step ceiling.
    expect(captured?.stopped).toBe(true);
    expect(captured?.simulatedSteps).toBeLessThan(20);
    expect(captured?.simulatedSteps).toBe(3);
  });

  it('pushes RUN_ERROR (not throw) when the stream yields an error part', async () => {
    const queue = createAsyncEventQueue<MinituiEvent>();
    const done = runTurns({
      conversation: createConversation(),
      threadId: 'tid',
      runId: 'run-1',
      queue,
      signal: new AbortController().signal,
      deps: {
        streamTextImpl: fakeStreamText({ parts: [{ type: 'error', error: new Error('rate') }] }),
        toolDispatch: dispatch,
        tools,
        model: 'test-model',
      },
    }).then(() => queue.close());
    const out: MinituiEvent[] = [];
    for await (const e of queue) out.push(e);
    await done;
    expect(out.at(-1)).toMatchObject({ type: 'RUN_ERROR', message: 'rate' });
  });

  it('idle-timeout: a stalled fullStream surfaces a retriable RUN_ERROR', async () => {
    const queue = createAsyncEventQueue<MinituiEvent>();
    const stalling = (() => ({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'thinking' };
        await new Promise<void>(() => {}); // silent forever — the idle deadline must break this
        yield { type: 'finish', finishReason: 'stop' };
      })(),
    })) as unknown as typeof import('ai').streamText;
    const done = runTurns({
      conversation: createConversation(),
      threadId: 'tid',
      runId: 'run-1',
      queue,
      signal: new AbortController().signal,
      deps: {
        streamTextImpl: stalling,
        toolDispatch: dispatch,
        tools,
        model: 'test-model',
        idleTimeoutMs: 20,
        streamMaxRetries: 0,
      },
    }).then(() => queue.close());
    const out: MinituiEvent[] = [];
    for await (const e of queue) out.push(e);
    await done;
    expect(out.some((e) => e.type === 'TEXT_MESSAGE_CONTENT')).toBe(true);
    expect(out.at(-1)).toMatchObject({ type: 'RUN_ERROR' });
    expect(out.some((e) => e.type === 'RUN_FINISHED')).toBe(false);
  });

  it('truncated stream (ends without a finish part) surfaces a retriable RUN_ERROR', async () => {
    const queue = createAsyncEventQueue<MinituiEvent>();
    const truncated = (() => ({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'partial' };
        // ends WITHOUT a finish part — a truncated stream
      })(),
    })) as unknown as typeof import('ai').streamText;
    const done = runTurns({
      conversation: createConversation(),
      threadId: 'tid',
      runId: 'run-1',
      queue,
      signal: new AbortController().signal,
      deps: {
        streamTextImpl: truncated,
        toolDispatch: dispatch,
        tools,
        model: 'test-model',
        streamMaxRetries: 0,
      },
    }).then(() => queue.close());
    const out: MinituiEvent[] = [];
    for await (const e of queue) out.push(e);
    await done;
    expect(out.map((e) => e.type)).toEqual(['TEXT_MESSAGE_CONTENT', 'RUN_ERROR']);
  });

  it('re-runs a dropped stream that emitted nothing, then completes on the retry', async () => {
    const queue = createAsyncEventQueue<MinituiEvent>();
    let calls = 0;
    const flaky = (() => {
      calls += 1;
      const attempt = calls;
      return {
        fullStream: (async function* () {
          if (attempt === 1) return; // first attempt: truncated with NO content -> a re-runnable drop
          yield { type: 'text-delta', text: 'ok' };
          yield { type: 'finish', finishReason: 'stop' };
        })(),
      };
    }) as unknown as typeof import('ai').streamText;
    const done = runTurns({
      conversation: createConversation(),
      threadId: 'tid',
      runId: 'run-1',
      queue,
      signal: new AbortController().signal,
      deps: {
        streamTextImpl: flaky,
        toolDispatch: dispatch,
        tools,
        model: 'test-model',
        streamMaxRetries: 2,
      },
    }).then(() => queue.close());
    const out: MinituiEvent[] = [];
    for await (const e of queue) out.push(e);
    await done;
    expect(calls).toBe(2); // attempt 1 dropped before content, attempt 2 succeeded
    expect(out.map((e) => e.type)).toEqual(['TEXT_MESSAGE_CONTENT', 'RUN_FINISHED']);
  });

  it('does NOT re-run a stream that already emitted content — no dup / no tool re-exec', async () => {
    const queue = createAsyncEventQueue<MinituiEvent>();
    let calls = 0;
    const dropsAfterContent = (() => {
      calls += 1;
      return {
        fullStream: (async function* () {
          yield { type: 'text-delta', text: 'half' };
          // drops (truncated) AFTER emitting content — must be surfaced, never retried
        })(),
      };
    }) as unknown as typeof import('ai').streamText;
    const done = runTurns({
      conversation: createConversation(),
      threadId: 'tid',
      runId: 'run-1',
      queue,
      signal: new AbortController().signal,
      deps: {
        streamTextImpl: dropsAfterContent,
        toolDispatch: dispatch,
        tools,
        model: 'test-model',
        streamMaxRetries: 2,
      },
    }).then(() => queue.close());
    const out: MinituiEvent[] = [];
    for await (const e of queue) out.push(e);
    await done;
    expect(calls).toBe(1); // content was emitted -> surfaced, never retried
    expect(out.map((e) => e.type)).toEqual(['TEXT_MESSAGE_CONTENT', 'RUN_ERROR']);
  });

  it('runProviderStream dispatches a scripted tool-call through ToolDispatchPort + maps observations — non-SDK path', async () => {
    // A scripted ModelProvider has NO streamText tool loop, so runProviderStream IS the host's dispatch
    // site — a scripted `tool-call` must reach ToolDispatchPort and its observation flow back, else the
    // injected dispatch is dead. A pre-composed `tool-result` chunk (a remote provider reporting its OWN
    // result) maps straight through, WITHOUT a second dispatch. The finish chunk closes the run.
    const queue = createAsyncEventQueue<MinituiEvent>();
    const dispatched: Array<{ toolCallId: string; toolName: string; args: unknown }> = [];
    const recording: ToolDispatchPort = {
      dispatch: async (req): Promise<ToolCallResult> => {
        dispatched.push(req);
        return {
          toolCallId: req.toolCallId,
          ok: true,
          toolName: req.toolName,
          content: 'dispatched',
          isError: false,
        };
      },
    };
    const scripted: ModelProvider = {
      id: 'scripted',
      async *streamChat() {
        yield { type: 'text', text: 'from script' };
        yield { type: 'tool-call', toolCallId: 't1', toolName: 'ffmpeg', input: { a: 1 } };
        yield {
          type: 'tool-result',
          toolCallId: 't2',
          toolName: 'ffprobe',
          output: { ok: true },
          isError: false,
        };
        yield { type: 'finish', reason: 'stop' };
      },
    };
    const done = runProviderStream({
      provider: scripted,
      conversation: createConversation([{ role: 'user', content: 'merge' }]),
      threadId: 'thread-xyz',
      runId: 'run-1',
      model: 'test-model',
      toolDispatch: recording,
      queue,
      signal: new AbortController().signal,
    }).then(() => queue.close());
    const out: MinituiEvent[] = [];
    for await (const e of queue) out.push(e);
    await done;
    // tool-call -> TOOL_CALL_START + the dispatched observation; the pre-composed tool-result -> its own observation.
    expect(out.map((e) => e.type)).toEqual([
      'TEXT_MESSAGE_CONTENT',
      'TOOL_CALL_START',
      'TOOL_CALL_RESULT',
      'TOOL_CALL_RESULT',
      'RUN_FINISHED',
    ]);
    // Positive control: the scripted tool-call reached ToolDispatchPort exactly once (t2's pre-composed result did NOT dispatch).
    expect(dispatched).toEqual([{ toolCallId: 't1', toolName: 'ffmpeg', args: { a: 1 } }]);
    expect(out.at(-1)).toMatchObject({
      type: 'RUN_FINISHED',
      threadId: 'thread-xyz',
      runId: 'run-1',
    });
  });

  it('threads a scripted error tool-result chunk into the observation error slot — redacted, not lost', async () => {
    // A non-SDK provider reporting its OWN failed tool run carries the failure text in the chunk's
    // dedicated `error` field. The observation must surface it in its `error` slot, redacted like every
    // provider-sourced string — stringifying only `output` would collapse a non-string failure (an Error
    // serializes to '{}') and lose the message entirely.
    const queue = createAsyncEventQueue<MinituiEvent>();
    const scripted: ModelProvider = {
      id: 'scripted',
      async *streamChat() {
        yield {
          type: 'tool-result',
          toolCallId: 't9',
          toolName: 'ffmpeg',
          output: { exitCode: 1 },
          isError: true,
          error: 'encode failed: bad key sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa',
        };
        // A success tool-result without a chunk error must NOT grow an error key on its observation.
        yield {
          type: 'tool-result',
          toolCallId: 't10',
          toolName: 'ffprobe',
          output: 'ok',
          isError: false,
        };
        yield { type: 'finish', reason: 'stop' };
      },
    };
    const done = runProviderStream({
      provider: scripted,
      conversation: createConversation([{ role: 'user', content: 'merge' }]),
      threadId: 'tid',
      runId: 'run-1',
      model: 'test-model',
      toolDispatch: dispatch,
      queue,
      signal: new AbortController().signal,
    }).then(() => queue.close());
    const out: MinituiEvent[] = [];
    for await (const e of queue) out.push(e);
    await done;
    const results = out.filter((e) => e.type === 'TOOL_CALL_RESULT');
    expect(results[0]).toEqual({
      type: 'TOOL_CALL_RESULT',
      toolCallId: 't9',
      toolName: 'ffmpeg',
      content: '{"exitCode":1}',
      isError: true,
      error: 'encode failed: bad key [redacted-secret]',
    });
    expect(results[1]).toBeDefined();
    expect(results[1] && 'error' in results[1]).toBe(false);
  });

  it('repairs a wrong-CASE tool name in place — tier 1, and never lets the model call `invalid`', async () => {
    // Capture the repair fn + activeTools runTurns passes to streamText, then drive the repair directly.
    let repair:
      | ((o: {
          toolCall: { toolCallId: string; toolName: string; input: string };
          error: { message: string };
        }) => Promise<{ toolName?: string } | null>)
      | undefined;
    let activeTools: string[] | undefined;
    const capturing = ((args: {
      experimental_repairToolCall?: typeof repair;
      activeTools?: string[];
    }) => {
      repair = args.experimental_repairToolCall;
      activeTools = args.activeTools;
      return {
        fullStream: (async function* () {
          yield { type: 'finish', finishReason: 'stop' };
        })(),
      };
    }) as unknown as typeof import('ai').streamText;
    const queue = createAsyncEventQueue<MinituiEvent>();
    const done = runTurns({
      conversation: createConversation(),
      threadId: 'tid',
      runId: 'run-1',
      queue,
      signal: new AbortController().signal,
      deps: { streamTextImpl: capturing, toolDispatch: dispatch, tools, model: 'test-model' },
    }).then(() => queue.close());
    for await (const _ of queue) void _;
    await done;
    // The synthetic `invalid` tool is registered but NOT model-callable — only the real catalog tools are.
    expect(activeTools).toEqual(['ffmpeg']);
    const fixed = await repair!({
      toolCall: { toolCallId: 't1', toolName: 'FFMPEG', input: '{"a":1}' },
      error: { message: 'no such tool: FFMPEG' },
    });
    expect(fixed).toMatchObject({ toolName: 'ffmpeg', toolCallId: 't1' });
  });

  it('reroutes a still-unknown tool call to the synthetic `invalid` tool — tier 2', async () => {
    let repair:
      | ((o: {
          toolCall: { toolCallId: string; toolName: string; input: string };
          error: { message: string };
        }) => Promise<{ toolName: string; input: string }>)
      | undefined;
    const capturing = ((args: { experimental_repairToolCall?: typeof repair }) => {
      repair = args.experimental_repairToolCall;
      return {
        fullStream: (async function* () {
          yield { type: 'finish', finishReason: 'stop' };
        })(),
      };
    }) as unknown as typeof import('ai').streamText;
    const queue = createAsyncEventQueue<MinituiEvent>();
    const done = runTurns({
      conversation: createConversation(),
      threadId: 'tid',
      runId: 'run-1',
      queue,
      signal: new AbortController().signal,
      deps: { streamTextImpl: capturing, toolDispatch: dispatch, tools, model: 'test-model' },
    }).then(() => queue.close());
    for await (const _ of queue) void _;
    await done;
    const rerouted = await repair!({
      toolCall: { toolCallId: 't2', toolName: 'delete_everything', input: '{}' },
      error: { message: 'no such tool: delete_everything' },
    });
    expect(rerouted.toolName).toBe('invalid');
    // The invalid tool's input carries the model's bad name + the SDK error, so its result can tell the model.
    expect(JSON.parse(rerouted.input)).toEqual({
      tool: 'delete_everything',
      error: 'no such tool: delete_everything',
    });
  });

  it('aborts immediately on a non-retriable provider error — RUN_ERROR, no empty/malformed turn', async () => {
    // A dead/overloaded provider (auth failure, context overflow) surfaces retriable:false. The run ends
    // on RUN_ERROR(code:'non-retriable') with NO RUN_FINISHED and never reaches the `finish` chunk, so a
    // downstream compose loop reads THIS and aborts rather than treating the empty turn as a malformed
    // spec. This is the runProviderStream error arm; the runTurns error-part arm above is its SDK twin.
    const queue = createAsyncEventQueue<MinituiEvent>();
    const dying: ModelProvider = {
      id: 'dying',
      async *streamChat() {
        yield { type: 'error', message: 'provider auth failed', retriable: false };
        yield { type: 'finish', reason: 'stop' }; // must NOT be reached — the error arm returns first
      },
    };
    const done = runProviderStream({
      provider: dying,
      conversation: createConversation([{ role: 'user', content: 'merge' }]),
      threadId: 'tid',
      runId: 'run-1',
      model: 'test-model',
      toolDispatch: dispatch,
      queue,
      signal: new AbortController().signal,
    }).then(() => queue.close());
    const out: MinituiEvent[] = [];
    for await (const e of queue) out.push(e);
    await done;
    expect(out).toEqual([
      { type: 'RUN_ERROR', message: 'provider auth failed', code: 'non-retriable' },
    ]);
    expect(out.some((e) => e.type === 'RUN_FINISHED')).toBe(false);
  });

  it('rejects a catalog tool named `invalid` — reserved for the repair-reroute tool', async () => {
    // buildTools registers a synthetic `invalid` tool for the repair reroute; a catalog tool of that name
    // would be silently shadowed. runTurns surfaces the collision as RUN_ERROR (a config error, not a
    // dead-shadowed grant) — the frozen v1 catalog has no such tool, so this guards a future change.
    const queue = createAsyncEventQueue<MinituiEvent>();
    const done = runTurns({
      conversation: createConversation(),
      threadId: 'tid',
      runId: 'run-1',
      queue,
      signal: new AbortController().signal,
      deps: {
        streamTextImpl: fakeStreamText({ parts: [{ type: 'finish', finishReason: 'stop' }] }),
        toolDispatch: dispatch,
        tools: [{ name: 'invalid', description: 'x', inputSchema: z.object({}) }],
        model: 'test-model',
        streamMaxRetries: 0,
      },
    }).then(() => queue.close());
    const out: MinituiEvent[] = [];
    for await (const e of queue) out.push(e);
    await done;
    const last = out.at(-1);
    expect(last?.type).toBe('RUN_ERROR');
    if (last?.type === 'RUN_ERROR') expect(last.message).toContain('reserved');
    expect(out.some((e) => e.type === 'RUN_FINISHED')).toBe(false);
  });
});
