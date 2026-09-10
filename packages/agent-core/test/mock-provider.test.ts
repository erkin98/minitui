import { describe, it, expect } from 'vitest';
import { createMockProvider } from '../src/provider/mock-provider.js';
import type { ProviderChunk, ProviderRequest } from '../src/provider/provider-types.js';

const req: ProviderRequest = {
  messages: [{ role: 'user', content: 'hi' }],
  config: { model: 'm' },
};

describe('mock-provider', () => {
  it('is a real async iterable yielding the scripted chunks in order', async () => {
    const script: ProviderChunk[] = [
      { type: 'text', text: 'hel' },
      { type: 'text', text: 'lo' },
      { type: 'finish', reason: 'stop' },
    ];
    const p = createMockProvider({ script });
    const out: ProviderChunk[] = [];
    for await (const c of p.streamChat(req, new AbortController().signal)) out.push(c);
    expect(out).toEqual(script);
  });

  it('stops yielding once the signal is aborted', async () => {
    const script: ProviderChunk[] = [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'finish', reason: 'stop' },
    ];
    const ac = new AbortController();
    const p = createMockProvider({ script });
    const out: ProviderChunk[] = [];
    for await (const c of p.streamChat(req, ac.signal)) {
      out.push(c);
      ac.abort();
    }
    expect(out).toEqual([{ type: 'text', text: 'a' }]);
  });

  it('exposes the request via onRequest', async () => {
    let seen: ProviderRequest | undefined;
    const p = createMockProvider({
      script: [{ type: 'finish', reason: 'stop' }],
      onRequest: (r) => (seen = r),
    });
    for await (const _ of p.streamChat(req, new AbortController().signal)) void _;
    expect(seen?.messages[0]?.content).toBe('hi');
  });
});
