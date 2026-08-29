import type { ModelProvider } from './provider-port.js';
import type { ProviderChunk, ProviderRequest } from './provider-types.js';

/** A scripted ModelProvider backed by a real async generator (never a replacement mock). */
export function createMockProvider(opts: {
  id?: string;
  script: readonly ProviderChunk[];
  onRequest?: (r: ProviderRequest) => void;
}): ModelProvider {
  return {
    id: opts.id ?? 'mock',
    // eslint-disable-next-line @typescript-eslint/require-await -- must be an async generator to satisfy the AsyncIterable port; the body only yields
    async *streamChat(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk> {
      opts.onRequest?.(req);
      for (const chunk of opts.script) {
        if (signal.aborted) return;
        yield chunk;
      }
    },
  };
}
