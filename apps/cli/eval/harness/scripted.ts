import type { DirectProvider, ProviderChunk, ProviderRequest } from '@minitui/agent-core';
import type { CapabilityProvider } from '@minitui/spec';
import type { Usage } from './trial.js';

/**
 * One scripted answer: a reply with its usage (null: a finish that reports none), a provider error, or a
 * reply that never ends.
 */
export type ScriptedReply =
  | { readonly kind: 'text'; readonly text: string; readonly usage: Usage | null }
  | { readonly kind: 'error'; readonly message: string; readonly retriable: boolean }
  | { readonly kind: 'never-ends' };

// Settles once the request is aborted: by the trial's cancel or by the session's own deadline.
const untilAborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

async function* answer(
  reply: ScriptedReply | undefined,
  index: number,
  signal: AbortSignal,
): AsyncGenerator<ProviderChunk> {
  if (reply === undefined) {
    yield { type: 'error', message: `the script has no reply ${index}`, retriable: false };
  } else if (reply.kind === 'never-ends') {
    await untilAborted(signal);
  } else if (reply.kind === 'error') {
    yield { type: 'error', message: reply.message, retriable: reply.retriable };
  } else {
    yield { type: 'text', text: reply.text };
    yield {
      type: 'finish',
      reason: 'stop',
      ...(reply.usage !== null ? { usage: reply.usage } : {}),
    };
  }
}

/**
 * A scripted model that answers request n with reply n of the queue, so a trial can be "invalid, then
 * valid". Past the end of the queue it fails, and the failure is not one the session retries.
 */
export function scriptedProvider(
  replies: readonly ScriptedReply[],
  onRequest?: (request: ProviderRequest) => void,
): DirectProvider {
  let served = 0;
  return {
    id: 'scripted',
    streamChat(request, signal) {
      onRequest?.(request);
      served += 1;
      return answer(replies[served - 1], served, signal);
    },
  };
}

/**
 * The host as the semantic stage sees it: the one list answers for the encoders and the codecs alike,
 * there are no filters, and every path is an existing, readable file.
 */
export function fixedCapabilities(encoders: readonly string[]): CapabilityProvider {
  return {
    listEncoders: () => Promise.resolve(encoders),
    listCodecs: () => Promise.resolve(encoders),
    listFilters: () => Promise.resolve([]),
    statFile: () => Promise.resolve({ exists: true, readable: true, isFile: true }),
  };
}
