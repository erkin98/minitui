import { describe, it, expect } from 'vitest';
import { createAnthropic } from '@ai-sdk/anthropic';
import { makeSession } from './helpers/sdk-model.js';
import { createAiSdkProvider, createAnthropicModel } from '../src/provider/ai-sdk-provider.js';
import type { AgentConfig } from '../src/session/agent-session.js';
import {
  fieldOf,
  messagesOf,
  recordingFetch,
  textOf,
  textReply,
} from './helpers/anthropic-wire.js';
import type { MinituiEvent } from '../src/events/event-types.js';

const USAGE = {
  input_tokens: 11,
  cache_creation_input_tokens: 5,
  cache_read_input_tokens: 7,
  output_tokens: 9,
} as const;

// One turn through the real streamText and the real Anthropic provider, over a recording fetch.
async function turn(system: string): Promise<{
  readonly body: unknown;
  readonly events: readonly MinituiEvent[];
}> {
  const wire = recordingFetch(textReply('hello', USAGE));
  const model = createAnthropic({ apiKey: 'test', fetch: wire.fetch })('test-model');
  const session = makeSession({ model, config: { system, maxOutputTokens: 1000 } });
  const events: MinituiEvent[] = [];
  for await (const ev of session.submit('merge the clips')) events.push(ev);
  expect(wire.requests).toHaveLength(1);
  return { body: wire.requests[0]?.body, events };
}

describe('how a turn reaches the model API', () => {
  it('sends the system prompt in the body’s system field and the intent as the only message', async () => {
    const { body, events } = await turn('you build merge apps');
    expect(textOf(fieldOf(body, 'system'))).toBe('you build merge apps');
    expect(messagesOf(body)).toEqual([{ role: 'user', text: 'merge the clips' }]);
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
  });

  it('reports the reply’s token usage on RUN_FINISHED, input counting the cache reads and writes', async () => {
    const { events } = await turn('you build merge apps');
    const last = events.at(-1);
    // 11 uncached + 5 written to the cache + 7 read from it. Before the SDK's current major version the
    // input count was the uncached 11 only.
    expect(last).toMatchObject({
      type: 'RUN_FINISHED',
      usage: { inputTokens: 23, outputTokens: 9 },
    });
  });
});

describe('the model endpoint is fixed', () => {
  it('sends the request to api.anthropic.com even when ANTHROPIC_BASE_URL names another host', async () => {
    const before = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = 'https://elsewhere.test/v1';
    try {
      const wire = recordingFetch(textReply('hello', USAGE));
      const model = createAnthropicModel('test-model', { apiKey: 'test', fetch: wire.fetch });
      const session = makeSession({ model, config: { maxOutputTokens: 1000 } });
      for await (const ev of session.submit('merge the clips')) void ev;
      expect(wire.requests.map((r) => new URL(r.url).origin)).toEqual([
        'https://api.anthropic.com',
      ]);
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = before;
    }
  });
});

describe('effort on the wire', () => {
  // One turn through the real provider package and its effort mapping, over a recording fetch.
  async function bodyWith(config: AgentConfig): Promise<unknown> {
    const wire = recordingFetch(textReply('hello', USAGE));
    const model = createAnthropicModel('test-model', { apiKey: 'test', fetch: wire.fetch });
    const session = makeSession({
      model,
      provider: createAiSdkProvider(),
      config: { system: 'you build merge apps', maxOutputTokens: 1000, ...config },
    });
    for await (const ev of session.submit('merge the clips')) void ev;
    expect(wire.requests).toHaveLength(1);
    return wire.requests[0]?.body;
  }

  it('sends a chosen effort as output_config.effort, with the system text and no thinking budget', async () => {
    const body = await bodyWith({ effort: 'medium' });
    expect(fieldOf(fieldOf(body, 'output_config'), 'effort')).toBe('medium');
    expect(textOf(fieldOf(body, 'system'))).toBe('you build merge apps');
    expect(JSON.stringify(body)).not.toContain('budget_tokens');
  });

  it('sends no effort and no thinking when effort is unset', async () => {
    const body = await bodyWith({});
    expect(fieldOf(fieldOf(body, 'output_config'), 'effort')).toBeUndefined();
    expect(fieldOf(body, 'thinking')).toBeUndefined();
  });
});
