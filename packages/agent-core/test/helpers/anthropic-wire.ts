// The Anthropic provider driven over a recording fetch: no network, and no real key. The reply is a
// hand-written Messages API event stream, so a test sees exactly what the provider sends and what it reads.

/** One request the provider sent: its URL and its parsed JSON body. Headers are never kept, nor the key. */
export interface WireRequest {
  readonly url: string;
  readonly body: unknown;
}

/** The token counts the reply reports, in the Messages API's own field names. */
export interface WireUsage {
  readonly input_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly output_tokens: number;
}

const sse = (events: readonly Record<string, unknown>[]): string =>
  events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');

/** A reply of one text block, with `usage` on message_start and the final output count on message_delta. */
export function textReply(text: string, usage: WireUsage): string {
  return sse([
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    },
    { type: 'message_stop' },
  ]);
}

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** A fetch that records each request and answers every one with `reply`. */
export function recordingFetch(reply: string): {
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly requests: readonly WireRequest[];
} {
  const requests: WireRequest[] = [];
  return {
    requests,
    fetch: (input, init) => {
      const raw = init?.body;
      requests.push({ url: urlOf(input), body: typeof raw === 'string' ? JSON.parse(raw) : raw });
      return Promise.resolve(
        new Response(reply, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    },
  };
}

// A field of a value read from the wire, without assuming the value is an object.
function fieldOf(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

/** The text of a `system` or `content` value: a plain string, or the joined text of its text blocks. */
export function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  return value
    .map((block) => fieldOf(block, 'text'))
    .filter((t): t is string => typeof t === 'string')
    .join('');
}

/** The request's messages as role and text pairs, whatever block format the provider version uses. */
export function messagesOf(body: unknown): readonly { role: unknown; text: string | undefined }[] {
  const messages = fieldOf(body, 'messages');
  return Array.isArray(messages)
    ? messages.map((m) => ({ role: fieldOf(m, 'role'), text: textOf(fieldOf(m, 'content')) }))
    : [];
}

export { fieldOf };
