import { describe, it, expect } from 'vitest';
import { MockLlmProvider, type MockChunk } from '../src/llm/mock-provider.js';

const script: MockChunk[] = [
  { type: 'text', text: 'building merge app' },
  { type: 'tool-call', toolCallId: 't1', toolName: 'lookup', input: { q: 'codec' } },
  {
    type: 'tool-result',
    toolCallId: 't1',
    toolName: 'lookup',
    output: { ok: true },
    isError: false,
  },
  { type: 'finish', reason: 'stop', usage: { inputTokens: 3, outputTokens: 5 } },
];

const req = { messages: [], config: { model: 'mock' } };

async function drain(provider: MockLlmProvider, request: unknown): Promise<string[]> {
  const seen: string[] = [];
  for await (const chunk of provider.streamChat(request, new AbortController().signal)) {
    seen.push(chunk.type);
  }
  return seen;
}

describe('MockLlmProvider', () => {
  it('yields the scripted chunks in order as a real async generator', async () => {
    expect(await drain(new MockLlmProvider(script), req)).toEqual([
      'text',
      'tool-call',
      'tool-result',
      'finish',
    ]);
  });

  it('exposes a stable id', () => {
    expect(new MockLlmProvider(script, { id: 'mock-1' }).id).toBe('mock-1');
    expect(new MockLlmProvider(script).id).toBe('mock-llm');
  });

  it('stops and throws when the signal aborts mid-stream', async () => {
    const provider = new MockLlmProvider(script, { delayMs: 5 });
    const ac = new AbortController();
    const seen: string[] = [];
    const run = (async () => {
      for await (const chunk of provider.streamChat(req, ac.signal)) {
        seen.push(chunk.type);
        if (seen.length === 1) ac.abort();
      }
    })();
    await expect(run).rejects.toThrow(/abort/i);
    expect(seen).toEqual(['text']);
  });

  it('records each request it is driven with, so a second turn is observable', async () => {
    const provider = new MockLlmProvider(script);
    expect(provider.receivedRequests()).toHaveLength(0);
    await drain(provider, { messages: [{ role: 'user', content: 'first' }] });
    await drain(provider, { messages: [{ role: 'user', content: 'reprompt: RUNTIME_ERROR' }] });
    expect(provider.receivedRequests()).toHaveLength(2);
    expect(JSON.stringify(provider.receivedRequests().at(-1))).toContain('RUNTIME_ERROR');
  });

  it('scripts every finish reason the model loop knows, and a tool-result error text', async () => {
    const endings: MockChunk[] = [
      {
        type: 'tool-result',
        toolCallId: 't',
        toolName: 'x',
        output: null,
        isError: true,
        error: 'boom',
      },
      ...(['stop', 'length', 'tool-calls', 'content-filter', 'error', 'other'] as const).map(
        (reason): MockChunk => ({ type: 'finish', reason }),
      ),
    ];
    expect(await drain(new MockLlmProvider(endings), req)).toHaveLength(7);
  });
});
