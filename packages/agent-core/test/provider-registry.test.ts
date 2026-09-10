import { describe, it, expect } from 'vitest';
import { createProviderRegistry } from '../src/provider/provider-registry.js';
import type { ModelProvider } from '../src/provider/provider-port.js';

function fakeProvider(id: string): ModelProvider {
  return {
    id,
    async *streamChat() {
      yield { type: 'finish', reason: 'stop' } as const;
    },
  };
}

describe('ProviderRegistry', () => {
  it('resolves a registered provider by id', () => {
    const reg = createProviderRegistry('mock');
    reg.register(fakeProvider('mock'));
    expect(reg.get('mock').id).toBe('mock');
  });

  it('returns the default provider', () => {
    const reg = createProviderRegistry('mock');
    reg.register(fakeProvider('mock'));
    reg.register(fakeProvider('anthropic'));
    expect(reg.default().id).toBe('mock');
  });

  it('throws on an unknown id', () => {
    const reg = createProviderRegistry('mock');
    expect(() => reg.get('nope')).toThrow(/unknown provider: nope/);
  });
});
