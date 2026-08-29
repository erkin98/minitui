import { describe, it, expect } from 'vitest';
import { createAiSdkProvider, createAnthropicModel } from '../src/provider/ai-sdk-provider.js';
import type { ProviderChunk, ProviderRequest } from '../src/provider/provider-types.js';

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
