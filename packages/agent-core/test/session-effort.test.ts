import { describe, it, expect } from 'vitest';
import type { DiagnosticsPort } from '@minitui/types';
import type { AgentConfig } from '../src/session/agent-session.js';
import type { DirectProvider, SdkLoopProvider } from '../src/provider/provider-port.js';
import type { ProviderRequest } from '../src/provider/provider-types.js';
import type { MinituiEvent } from '../src/events/event-types.js';
import { makeSession, scriptedModel, textTurn, toolCallTurn } from './helpers/sdk-model.js';
import { z } from 'zod';

// A provider whose per-call options name the effort under its own key, the way a real adapter does.
const effortProvider: SdkLoopProvider = {
  id: 'sdk',
  usesSdkLoop: true,
  sdkCallOptions: ({ effort }) => (effort === undefined ? {} : { test: { effort } }),
  async *streamChat() {},
};

async function drain(turn: AsyncGenerator<MinituiEvent>): Promise<MinituiEvent[]> {
  const events: MinituiEvent[] = [];
  for await (const ev of turn) events.push(ev);
  return events;
}

function debugPort(): { port: DiagnosticsPort; lines: { msg: string; meta: unknown }[] } {
  const lines: { msg: string; meta: unknown }[] = [];
  return { lines, port: { warn: () => {}, debug: (msg, meta) => lines.push({ msg, meta }) } };
}

describe('effort on the SDK loop', () => {
  it('sends the provider’s options for a chosen effort', async () => {
    const { model, calls } = scriptedModel([{ chunks: textTurn('hi') }]);
    const session = makeSession({ model, provider: effortProvider, config: { effort: 'medium' } });
    await drain(session.submit('go'));
    expect(calls[0]?.providerOptions).toEqual({ test: { effort: 'medium' } });
  });

  it('sends no provider options when effort is unset, so the model keeps its own default', async () => {
    const { model, calls } = scriptedModel([{ chunks: textTurn('hi') }]);
    await drain(makeSession({ model, provider: effortProvider }).submit('go'));
    expect(calls[0]?.providerOptions).toBeUndefined();
  });

  it('records the effort and the model id once per model step', async () => {
    const { model } = scriptedModel([
      { chunks: toolCallTurn('c1', 'ffmpeg', { a: 1 }) },
      { chunks: textTurn('done') },
    ]);
    const { port, lines } = debugPort();
    const tools = [
      { name: 'ffmpeg', description: 'merge', inputSchema: z.object({ a: z.number() }) },
    ];
    const session = makeSession({ model, provider: effortProvider, diagnostics: port, tools });
    await drain(session.submit('go'));
    const step = {
      msg: 'model step',
      meta: { effort: 'model-default', modelId: 'scripted-model' },
    };
    expect(lines).toEqual([step, step]);
  });

  it('records a chosen effort by its name', async () => {
    const { model } = scriptedModel([{ chunks: textTurn('hi') }]);
    const { port, lines } = debugPort();
    const config: AgentConfig = { effort: 'max' };
    await drain(
      makeSession({ model, provider: effortProvider, diagnostics: port, config }).submit('go'),
    );
    expect(lines).toEqual([
      { msg: 'model step', meta: { effort: 'max', modelId: 'scripted-model' } },
    ]);
  });
});

describe('effort on the other loop', () => {
  async function requestWith(config: AgentConfig): Promise<ProviderRequest | undefined> {
    let seen: ProviderRequest | undefined;
    const provider: DirectProvider = {
      id: 'scripted',
      async *streamChat(req) {
        seen = req;
        yield { type: 'finish', reason: 'stop' };
      },
    };
    await drain(makeSession({ model: 'm', provider, config }).submit('go'));
    return seen;
  }

  it('puts a chosen effort on the request', async () => {
    expect((await requestWith({ effort: 'low' }))?.config.effort).toBe('low');
  });

  it('leaves it off the request when unset', async () => {
    expect(Object.hasOwn((await requestWith({}))?.config ?? {}, 'effort')).toBe(false);
  });
});

describe('the effort setting is validated when the session is built', () => {
  const model = scriptedModel([]).model;

  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)('accepts %s', (effort) => {
    expect(() => makeSession({ model, config: { effort } })).not.toThrow();
  });

  it.each(['', 'HIGH', 'extreme', 'minimal'])(
    'refuses %j with a RangeError that names the field and the levels',
    (effort) => {
      // Parsed, not cast: an effort from outside the program arrives as an unchecked string.
      const config: AgentConfig = JSON.parse(JSON.stringify({ effort }));
      expect(() => makeSession({ model, config })).toThrowError(RangeError);
      expect(() => makeSession({ model, config })).toThrowError(
        /AgentConfig\.effort must be one of low, medium, high, xhigh, max/,
      );
    },
  );
});
