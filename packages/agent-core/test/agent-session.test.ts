import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AgentSession } from '../src/session/agent-session.js';
import type { ToolDispatchPort, ToolCallResult, SpecSinkPort } from '../src/ports/index.js';
import type { VisibilityChannel } from '../src/visibility/index.js';
import type { ModelProvider } from '../src/provider/provider-port.js';
import type { MinituiEvent } from '../src/events/event-types.js';
import { activitySnapshot } from '../src/events/event-factory.js';

const provider: ModelProvider = { id: 'x', async *streamChat() {} };
const toolDispatch: ToolDispatchPort = {
  dispatch: async (req): Promise<ToolCallResult> => ({
    toolCallId: req.toolCallId,
    ok: true,
    toolName: req.toolName,
    content: '',
    isError: false,
  }),
};
const specSink: SpecSinkPort = { emit: (spec) => activitySnapshot(spec) };
// A pass-through visibility channel with the real shape (classOf/isModelVisible/projectForModel).
const visibility: VisibilityChannel = {
  classOf: () => 'modelVisible',
  isModelVisible: () => true,
  projectForModel: (v) => v,
};

// Inject a fake streamText through AgentConfig.streamTextImpl (a typed seam — no cast on config). The
// fake mirrors the real result shape: fullStream is an async-iterable PROPERTY.
function fakeStreamText(parts: Array<Record<string, unknown>>) {
  return (() => ({
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
  })) as unknown as typeof import('ai').streamText;
}

const tools = [{ name: 'ffmpeg', description: 'm', inputSchema: z.object({ a: z.number() }) }];

describe('AgentSession', () => {
  it('submit yields RUN_STARTED ... RUN_FINISHED bracketing the turn', async () => {
    const session = new AgentSession({
      provider,
      toolDispatch,
      specSink,
      visibility,
      tools,
      model: 'test-model',
      config: {
        streamTextImpl: fakeStreamText([
          { type: 'text-delta', text: 'hi' },
          { type: 'finish', finishReason: 'stop' },
        ]),
      },
    });
    const out: string[] = [];
    for await (const e of session.submit('merge these')) out.push(e.type);
    expect(out[0]).toBe('RUN_STARTED');
    expect(out.at(-1)).toBe('RUN_FINISHED');
    expect(out).toContain('TEXT_MESSAGE_CONTENT');
  });

  it('emitSpec routes a generated spec through SpecSinkPort into the LIVE stream (ACTIVITY_SNAPSHOT)', async () => {
    // The specSink wiring: the compose-loop caller calls emitSpec once validation passes; the event
    // must ride the SAME submit() stream the transport consumes.
    const session = new AgentSession({
      provider,
      toolDispatch,
      specSink,
      visibility,
      tools,
      model: 'test-model',
      config: {
        streamTextImpl: (() => ({
          fullStream: (async function* () {
            yield { type: 'text-delta', text: 'spec ready' };
            await new Promise((r) => setTimeout(r, 10));
            yield { type: 'finish', finishReason: 'stop' };
          })(),
        })) as unknown as typeof import('ai').streamText,
      },
    });
    const seen: MinituiEvent[] = [];
    for await (const e of session.submit('make a merge ui')) {
      seen.push(e);
      if (e.type === 'TEXT_MESSAGE_CONTENT') session.emitSpec({ root: 'r', elements: {} });
    }
    expect(seen.some((e) => e.type === 'ACTIVITY_SNAPSHOT')).toBe(true);
  });

  it('cancel aborts the in-flight turn so the generator ends early', async () => {
    const session = new AgentSession({
      provider,
      toolDispatch,
      specSink,
      visibility,
      tools,
      model: 'test-model',
      config: {
        streamTextImpl: (() => ({
          fullStream: (async function* () {
            yield { type: 'text-delta', text: 'a' };
            // a slow second part the cancel should cut off
            await new Promise((r) => setTimeout(r, 50));
            yield { type: 'text-delta', text: 'b' };
            yield { type: 'finish', finishReason: 'stop' };
          })(),
        })) as unknown as typeof import('ai').streamText,
      },
    });
    const seen: string[] = [];
    const gen = session.submit('go');
    for await (const e of gen) {
      seen.push(e.type);
      if (e.type === 'TEXT_MESSAGE_CONTENT') session.cancel();
    }
    expect(seen).not.toContain('RUN_FINISHED');
  });

  it('cancel aborts the SAME signal threaded into an in-flight ToolDispatchPort.dispatch (abort unwinding)', async () => {
    // Prove the provider stream AND tool dispatch share one controller.
    let dispatchSignal: AbortSignal | undefined;
    const slowDispatch: ToolDispatchPort = {
      dispatch: (req, signal) => {
        dispatchSignal = signal;
        return new Promise<ToolCallResult>((resolve) => {
          signal.addEventListener('abort', () =>
            resolve({
              toolCallId: req.toolCallId,
              ok: false,
              toolName: req.toolName,
              content: 'aborted',
              isError: true,
            }),
          );
        });
      },
    };
    const session = new AgentSession({
      provider,
      toolDispatch: slowDispatch,
      specSink,
      visibility,
      tools,
      model: 'test-model',
      config: {
        // streamText calls the tool's execute (which awaits dispatch), then emits a text delta we cancel
        // on. The aborted dispatch resolves isError:true, so execute THROWS by design — swallow it here
        // exactly like the real SDK does (it catches the throw and emits a tool-error part).
        streamTextImpl: ((args: {
          tools?: Record<
            string,
            { execute: (i: unknown, c: { toolCallId: string }) => Promise<unknown> }
          >;
        }) => ({
          fullStream: (async function* () {
            void args.tools?.ffmpeg
              ?.execute({ a: 1 }, { toolCallId: 't1' })
              ?.catch(() => undefined);
            yield { type: 'text-delta', text: 'working' };
            await new Promise((r) => setTimeout(r, 50));
            yield { type: 'finish', finishReason: 'stop' };
          })(),
        })) as unknown as typeof import('ai').streamText,
      },
    });
    const gen = session.submit('go');
    for await (const e of gen) {
      if (e.type === 'TEXT_MESSAGE_CONTENT') session.cancel();
    }
    expect(dispatchSignal?.aborted).toBe(true);
  });

  it('drives provider.streamChat on the NON-SDK path — scripted provider, no streamTextImpl', async () => {
    // A scripted ModelProvider carries its own chunks and does NOT set usesSdkLoop, so submit() consumes
    // provider.streamChat instead of the SDK streamText loop. Without this every event after RUN_STARTED
    // goes missing (the script is dead).
    const scripted: ModelProvider = {
      id: 'scripted',
      async *streamChat() {
        yield { type: 'text', text: 'from script' };
        // The scripted tool-call is DISPATCHED through toolDispatch on the non-SDK path (no SDK loop
        // runs it) — the dispatch produces the TOOL_CALL_RESULT observation, so the script does NOT also
        // yield a redundant same-id tool-result (that would double the observation).
        yield { type: 'tool-call', toolCallId: 't1', toolName: 'ffmpeg', input: { a: 1 } };
        yield { type: 'finish', reason: 'stop' };
      },
    };
    const session = new AgentSession({
      provider: scripted,
      toolDispatch,
      specSink,
      visibility,
      tools,
      model: 'test-model',
    });
    const out: string[] = [];
    for await (const e of session.submit('merge these')) out.push(e.type);
    // RUN_STARTED (from submit) then the mapped script — the tool-call dispatched an observation — closed
    // by RUN_FINISHED from the finish chunk.
    expect(out).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_CONTENT',
      'TOOL_CALL_START',
      'TOOL_CALL_RESULT',
      'RUN_FINISHED',
    ]);
  });

  it('stays alive across turns: a second submit(reprompt) re-enters with the SAME threadId + a fresh runId', async () => {
    // The post-mount error round-trip: the host holds ONE session for its lifetime and, on a failed
    // action outcome, calls submit(reprompt) again. The session must NOT tear down after the first turn —
    // one thread (stable threadId), a distinct runId per run. A regression witness for the still-alive
    // ingress contract (submit is already re-callable).
    const session = new AgentSession({
      provider,
      toolDispatch,
      specSink,
      visibility,
      tools,
      model: 'test-model',
      config: {
        streamTextImpl: fakeStreamText([
          { type: 'text-delta', text: 'ok' },
          { type: 'finish', finishReason: 'stop' },
        ]),
      },
    });
    const runTurn = async (intent: string) => {
      const seen: MinituiEvent[] = [];
      for await (const e of session.submit(intent)) seen.push(e);
      const started = seen.find((e) => e.type === 'RUN_STARTED') as
        | { threadId: string; runId: string }
        | undefined;
      return { last: seen.at(-1)?.type, started };
    };
    const first = await runTurn('make a merge ui');
    const second = await runTurn(
      'the merge action failed with exit 1 — regenerate a corrected spec',
    );
    // both turns completed on their own RUN_FINISHED
    expect(first.last).toBe('RUN_FINISHED');
    expect(second.last).toBe('RUN_FINISHED');
    // same thread across the re-entry, distinct runs — the session outlived the first turn
    expect(first.started?.threadId).toBe(session.threadId);
    expect(second.started?.threadId).toBe(session.threadId);
    expect(first.started?.runId).not.toBe(second.started?.runId);
  });
});
