import { describe, it, expect } from 'vitest';
import { createAiSdkProvider, createAnthropicModel } from '../src/provider/ai-sdk-provider.js';
import type { ProviderChunk, ProviderRequest } from '../src/provider/provider-types.js';
import { runProviderStream } from '../src/session/stream-turns.js';
import { createAsyncEventQueue } from '../src/events/event-stream.js';
import { createConversation } from '../src/session/conversation.js';
import type { MinituiEvent } from '../src/events/event-types.js';
import type { ToolCallResult, ToolDispatchPort } from '../src/ports/index.js';

const req: ProviderRequest = {
  messages: [{ role: 'user', content: 'merge' }],
  config: { model: 'claude' },
};

// A fake streamText mirroring the real result shape: fullStream is an async-iterable property
// (not a method the caller invokes).
function fakeStreamText(parts: Array<Record<string, unknown>>) {
  return ((_args: unknown) => ({
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
  })) as unknown as typeof import('ai').streamText;
}

describe('ai-sdk-provider', () => {
  it('maps each stream part type to the right ProviderChunk, including finish.totalUsage into usage', async () => {
    const parts = [
      { type: 'text-delta', text: 'hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'tool-call', toolCallId: 't1', toolName: 'ffmpeg', input: { a: 1 } },
      { type: 'tool-result', toolCallId: 't1', toolName: 'ffmpeg', output: { ok: true } },
      { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 5, outputTokens: 7 } },
    ];
    const p = createAiSdkProvider({ streamTextImpl: fakeStreamText(parts) });
    const out: ProviderChunk[] = [];
    for await (const c of p.streamChat(req, new AbortController().signal)) out.push(c);
    expect(out).toEqual([
      { type: 'text', text: 'hel' },
      { type: 'text', text: 'lo' },
      { type: 'tool-call', toolCallId: 't1', toolName: 'ffmpeg', input: { a: 1 } },
      {
        type: 'tool-result',
        toolCallId: 't1',
        toolName: 'ffmpeg',
        output: { ok: true },
        isError: false,
      },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 5, outputTokens: 7 } },
    ]);
  });

  it('maps a tool-error part to a tool-result chunk with isError:true', async () => {
    // A thrown tool execute is caught by the SDK and emitted as a tool-error part, never a tool-result.
    const p = createAiSdkProvider({
      streamTextImpl: fakeStreamText([
        {
          type: 'tool-error',
          toolCallId: 't1',
          toolName: 'ffmpeg',
          input: { a: 1 },
          error: new Error('exit 1'),
        },
        { type: 'finish', finishReason: 'stop' },
      ]),
    });
    const out: ProviderChunk[] = [];
    for await (const c of p.streamChat(req, new AbortController().signal)) out.push(c);
    expect(out[0]).toMatchObject({
      type: 'tool-result',
      toolCallId: 't1',
      toolName: 'ffmpeg',
      isError: true,
    });
    expect(out.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('a tool-error carries its message on the observation content AND error slot', async () => {
    // The tool-error arm derives the failure text once and puts it on BOTH `output` and the dedicated
    // `error` slot. Driven through runProviderStream (which maps output -> content, error -> error), the
    // observation surfaces the message on both fields. Before the fix `output` held the raw Error object,
    // so content JSON-stringified to '{}' and error was undefined — the failure text was lost.
    const provider = createAiSdkProvider({
      streamTextImpl: fakeStreamText([
        {
          type: 'tool-error',
          toolCallId: 't1',
          toolName: 'ffmpeg',
          input: { a: 1 },
          error: new Error('exit 1'),
        },
        { type: 'finish', finishReason: 'stop' },
      ]),
    });
    // The tool-error path yields a tool-result chunk (no dispatch), so this double is never called; it
    // only satisfies runProviderStream's required port.
    const noopDispatch: ToolDispatchPort = {
      dispatch: async (r): Promise<ToolCallResult> => ({
        toolCallId: r.toolCallId,
        ok: true,
        toolName: r.toolName,
        content: '',
        isError: false,
      }),
    };
    const queue = createAsyncEventQueue<MinituiEvent>();
    const done = runProviderStream({
      provider,
      conversation: createConversation([{ role: 'user', content: 'merge' }]),
      threadId: 'tid',
      runId: 'run-1',
      model: 'test-model',
      toolDispatch: noopDispatch,
      queue,
      signal: new AbortController().signal,
    }).then(() => queue.close());
    const out: MinituiEvent[] = [];
    for await (const e of queue) out.push(e);
    await done;
    const ev = out.find((e) => e.type === 'TOOL_CALL_RESULT');
    expect(ev).toBeDefined();
    if (ev?.type === 'TOOL_CALL_RESULT') {
      expect(ev.isError).toBe(true);
      expect(ev.error).toBe('exit 1');
      expect(ev.content).toBe('exit 1');
    }
  });

  it('maps tool-approval request/response parts to approval chunks (forward-compatible arms)', async () => {
    const toolCall = { toolCallId: 't9', toolName: 'ffmpeg', input: { a: 2 } };
    const p = createAiSdkProvider({
      streamTextImpl: fakeStreamText([
        { type: 'tool-approval-request', approvalId: 'ap1', toolCall },
        { type: 'tool-approval-response', approvalId: 'ap1', toolCall, approved: true },
        { type: 'finish', finishReason: 'stop' },
      ]),
    });
    const out: ProviderChunk[] = [];
    for await (const c of p.streamChat(req, new AbortController().signal)) out.push(c);
    expect(out).toEqual([
      { type: 'approval-request', toolCallId: 't9', toolName: 'ffmpeg', input: { a: 2 } },
      { type: 'approval-response', toolCallId: 't9', approved: true },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('maps a transient error part to a retriable error chunk with a parsed retry-after', async () => {
    const p = createAiSdkProvider({
      streamTextImpl: fakeStreamText([
        { type: 'error', error: new Error('Rate limit reached. Please try again in 11.05s.') },
      ]),
    });
    const out: ProviderChunk[] = [];
    for await (const c of p.streamChat(req, new AbortController().signal)) out.push(c);
    expect(out).toEqual([
      {
        type: 'error',
        message: 'Rate limit reached. Please try again in 11.05s.',
        retriable: true,
        retryAfterMs: 11050,
      },
    ]);
  });

  it('classifies a context-overflow error part as fatal (retriable:false, no retry-after)', async () => {
    const p = createAiSdkProvider({
      streamTextImpl: fakeStreamText([
        { type: 'error', error: new Error('maximum context length exceeded') },
      ]),
    });
    const out: ProviderChunk[] = [];
    for await (const c of p.streamChat(req, new AbortController().signal)) out.push(c);
    expect(out).toEqual([
      { type: 'error', message: 'maximum context length exceeded', retriable: false },
    ]);
  });

  it('stops emitting once the signal aborts', async () => {
    const ac = new AbortController();
    const parts = [
      { type: 'text-delta', text: 'a' },
      { type: 'text-delta', text: 'b' },
      { type: 'finish', finishReason: 'stop' },
    ];
    const p = createAiSdkProvider({ streamTextImpl: fakeStreamText(parts) });
    const out: ProviderChunk[] = [];
    for await (const c of p.streamChat(req, ac.signal)) {
      out.push(c);
      ac.abort();
    }
    expect(out).toEqual([{ type: 'text', text: 'a' }]);
  });

  it('createAnthropicModel wraps createAnthropic()(modelId) into a LanguageModel handle (no network)', () => {
    const model = createAnthropicModel('claude-sonnet-4-5', { apiKey: 'sk-ant-test' });
    expect(model).toBeDefined();
    expect((model as { modelId?: string }).modelId).toBe('claude-sonnet-4-5');
  });
});
