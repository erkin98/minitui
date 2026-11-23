import { describe, it, expect } from 'vitest';
import {
  AgentSession,
  EFFORTS,
  createSpecSink,
  createVisibilityChannel,
  isSdkLoopRoute,
  redact,
  type MinituiEvent,
} from '@minitui/agent-core';
import { noopDiagnostics } from '@minitui/types';
import { MESSAGE_CAP, cleaner, createModelRoute, keyRedactionPolicy } from '../src/model-route.js';

const KEY = 'sk-ant-test-0123456789abcdefghijklmnop';
// A colour reset: the strip removes the whole sequence and joins what stood on either side of it.
const SGR = `${String.fromCharCode(27)}[m`;

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

describe('createModelRoute', () => {
  it('builds the SDK-loop route of the key and the model id, with no fetch given', () => {
    const route = createModelRoute({
      apiKey: KEY,
      modelId: 'test-model',
      diagnostics: noopDiagnostics,
      redactionPolicy: keyRedactionPolicy(KEY),
    });
    expect(route.provider.id).toBe('anthropic');
    expect(isSdkLoopRoute(route)).toBe(true);
    expect(route.provider.sdkCallOptions({})).toEqual({});
    for (const effort of EFFORTS) {
      expect(route.provider.sdkCallOptions({ effort })).toEqual({ anthropic: { effort } });
    }
    expect(route.model.modelId).toBe('test-model');
  });

  it('sends the one request of a turn through the fetch it is given, to the fixed endpoint', async () => {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = (input) => {
      urls.push(urlOf(input));
      // A plain Error, not the TypeError of a failed network call: the SDK retries only the latter.
      return Promise.reject(new Error('this fetch answers no request'));
    };
    const route = createModelRoute({
      apiKey: KEY,
      modelId: 'test-model',
      diagnostics: noopDiagnostics,
      redactionPolicy: keyRedactionPolicy(KEY),
      fetch,
    });
    const session = new AgentSession({
      route,
      toolDispatch: { dispatch: () => Promise.reject(new Error('no tool runs here')) },
      specSink: createSpecSink(),
      visibility: createVisibilityChannel({}),
      tools: [],
    });
    const events: MinituiEvent[] = [];
    for await (const event of session.submit('merge two clips')) events.push(event);
    expect(events.at(-1)?.type).toBe('RUN_ERROR');
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0] ?? '').origin).toBe('https://api.anthropic.com');
  });
});

describe('keyRedactionPolicy', () => {
  it('removes a key that holds regular-expression characters, and nothing else', () => {
    const odd = 'sk-a.b*c+d(e)[f]';
    expect(redact(`with ${odd} and sk-aXbYc`, keyRedactionPolicy(odd))).toBe(
      'with [redacted-secret] and sk-aXbYc',
    );
  });
});

describe('cleaner', () => {
  it('removes a key split by a control sequence, since the strip joins its halves', () => {
    const split = `${KEY.slice(0, 12)}${SGR}${KEY.slice(12)}`;
    const clean = cleaner(KEY);
    expect(clean.line(`left ${split} right`)).toBe('left [redacted-secret] right');
    expect(clean.line(`left ${KEY} right`)).toBe('left [redacted-secret] right');
  });

  it('cuts a crash at 4,000 characters and a message at 500', () => {
    const clean = cleaner(KEY);
    expect(clean.crash('x'.repeat(10_000))).toHaveLength(4000);
    expect(MESSAGE_CAP).toBe(500);
    expect(clean.message(new Error('y'.repeat(1000)))).toHaveLength(MESSAGE_CAP);
    expect(clean.message('z'.repeat(1000))).toHaveLength(MESSAGE_CAP);
  });
});
