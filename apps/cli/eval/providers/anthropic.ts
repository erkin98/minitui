import { cleaner, createModelRoute, keyRedactionPolicy } from '../../src/model-route.js';
import type { FetchLike } from '../harness/spend.js';
import type {
  KeyedAccess,
  ProviderEntry,
  ReplayReply,
  ReplayRouteArgs,
  TrialRouteArgs,
} from './index.js';

// The provider's entry in the table: its key variable, the live route over the real fetch, and the replay
// route over a fetch that answers from a list of replies in the provider's own event-stream format.

const KEY_VARIABLE = 'ANTHROPIC_API_KEY';

// One Messages API stream event, framed as the provider package reads it.
const frame = (event: { readonly type: string }): string =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

// A whole reply: one text block, its model id and input count on message_start, its output count on
// message_delta, ending for the turn's end.
function eventStream(reply: ReplayReply): string {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_replay',
        type: 'message',
        role: 'assistant',
        model: reply.modelId,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: reply.usage.inputTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: reply.usage.outputTokens },
    },
    { type: 'message_stop' },
  ]
    .map(frame)
    .join('');
}

// What an observer is told of a request: its URL and its parsed body, never a header.
function requestOf(
  input: Parameters<FetchLike>[0],
  init: Parameters<FetchLike>[1],
): { readonly url: string; readonly body: unknown } {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const raw = init?.body;
  const body: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return { url, body };
}

/**
 * Answers request n with reply n and never reaches the network. It reads only the URL and the body, never a
 * header. Past the last reply it rejects with a plain Error, which the provider utilities do not retry.
 */
function replayingFetch(
  replies: readonly ReplayReply[],
  onRequest: ReplayRouteArgs['onRequest'],
): FetchLike {
  let served = 0;
  return (input, init) => {
    onRequest?.(requestOf(input, init));
    served += 1;
    const reply = replies[served - 1];
    if (reply === undefined) {
      return Promise.reject(new Error(`replay: no reply for request ${served}`));
    }
    return Promise.resolve(
      new Response(eventStream(reply), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
  };
}

// The cli's policy, cleaner and route over one key; `base` is the fetch each trial's meter wraps. The key
// stays in here: what is returned holds the policy, the cleaner and the route, never the key itself.
function keyedAccess<A extends TrialRouteArgs>(
  key: string,
  base: (args: A) => FetchLike,
): KeyedAccess<A> {
  const redactionPolicy = keyRedactionPolicy(key);
  return {
    redactionPolicy,
    clean: cleaner(key),
    route: (args) =>
      createModelRoute({
        apiKey: key,
        modelId: args.model,
        diagnostics: args.diagnostics,
        redactionPolicy,
        fetch: args.meter(base(args)),
      }),
  };
}

export const anthropicEntry: ProviderEntry = {
  id: 'anthropic',
  keyVariable: KEY_VARIABLE,
  live: (env) => {
    const key = env[KEY_VARIABLE];
    return key === undefined || key === ''
      ? undefined
      : keyedAccess<TrialRouteArgs>(key, () => globalThis.fetch);
  },
  // Each route gets its own replaying fetch, so each trial's replies start at its first request.
  replay: (key) =>
    keyedAccess<ReplayRouteArgs>(key, (args) => replayingFetch(args.replies, args.onRequest)),
};
