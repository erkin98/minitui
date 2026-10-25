import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { APICallError } from 'ai';
import type { ModelProvider } from '../src/provider/provider-port.js';
import type { ProviderChunk } from '../src/provider/provider-types.js';
import type { MinituiEvent } from '../src/events/event-types.js';
import type { ToolDispatchPort } from '../src/ports/index.js';
import {
  finishOnly,
  makeSession,
  scriptedModel,
  textTurn,
  toolCallTurn,
  within,
  type CallScript,
} from './helpers/sdk-model.js';

const tools = [{ name: 'ffmpeg', description: 'merge', inputSchema: z.object({ a: z.number() }) }];

async function run(session: ReturnType<typeof makeSession>, ms = 5000): Promise<MinituiEvent[]> {
  const events: MinituiEvent[] = [];
  await within(
    (async () => {
      for await (const ev of session.submit('go')) events.push(ev);
    })(),
    ms,
    'the turn',
  );
  return events;
}

async function endingOf(
  scripts: readonly CallScript[],
  config = {},
): Promise<MinituiEvent | undefined> {
  const { model } = scriptedModel(scripts);
  const events = await run(
    makeSession({ model, tools, config: { streamMaxRetries: 0, ...config } }),
  );
  return events.at(-1);
}

const NON_RETRIABLE = 'non-retriable';

describe('every finish reason ends the run as what it was (SDK loop)', () => {
  it('stop ends RUN_FINISHED', async () => {
    expect((await endingOf([{ chunks: textTurn('hi', 'stop') }]))?.type).toBe('RUN_FINISHED');
  });

  it('other ends RUN_FINISHED', async () => {
    expect((await endingOf([{ chunks: textTurn('hi', 'other') }]))?.type).toBe('RUN_FINISHED');
  });

  it('length ends with a non-retriable error, never a clean finish', async () => {
    expect(await endingOf([{ chunks: textTurn('hi', 'length') }])).toEqual({
      type: 'RUN_ERROR',
      message: 'the model reply was cut by the output-token limit',
      code: NON_RETRIABLE,
    });
  });

  it('content-filter ends with a non-retriable error', async () => {
    expect(await endingOf([{ chunks: textTurn('hi', 'content-filter') }])).toEqual({
      type: 'RUN_ERROR',
      message: 'model output was blocked by the provider content filter',
      code: NON_RETRIABLE,
    });
  });

  it('a step-ceiling halt ends with a non-retriable error', async () => {
    const ending = await endingOf([{ chunks: toolCallTurn('c1', 'ffmpeg', { a: 1 }) }], {
      stepCeiling: 1,
    });
    expect(ending).toEqual({
      type: 'RUN_ERROR',
      message: 'turn halted: the tool-call limit was reached',
      code: NON_RETRIABLE,
    });
  });

  it('a repeated-call halt ends with a non-retriable error', async () => {
    const same = (id: string): CallScript => ({ chunks: toolCallTurn(id, 'ffmpeg', { a: 1 }) });
    const ending = await endingOf([same('c1'), same('c2'), same('c3'), same('c4')]);
    expect(ending).toEqual({
      type: 'RUN_ERROR',
      message: 'turn halted: the tool-call limit was reached',
      code: NON_RETRIABLE,
    });
  });

  it('error ends with the retriable failed-generation error', async () => {
    expect(await endingOf([{ chunks: finishOnly('error') }])).toEqual({
      type: 'RUN_ERROR',
      message: 'the provider reported a failed generation',
    });
  });

  it('a provider stream that closes without a finish chunk ends with the retriable truncation error', async () => {
    expect(await endingOf([{ chunks: [{ type: 'stream-start', warnings: [] }] }])).toEqual({
      type: 'RUN_ERROR',
      message: 'stream closed before finish',
    });
  });
});

describe('more endings on the installed SDK', () => {
  it('re-runs a truncation that delivered nothing, within the budget', async () => {
    const { model, calls } = scriptedModel([
      { chunks: [{ type: 'stream-start', warnings: [] }] },
      { chunks: textTurn('recovered') },
    ]);
    const events = await run(makeSession({ model, config: { streamMaxRetries: 1 } }));
    expect(calls).toHaveLength(2);
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
  });

  it('ends a rejected request (status 401) as non-retriable after one call', async () => {
    const unauthorized = new APICallError({
      message: 'invalid x-api-key',
      url: 'https://example.invalid/v1/messages',
      requestBodyValues: {},
      statusCode: 401,
    });
    const { model, calls } = scriptedModel([{ reject: unauthorized }]);
    const events = await run(makeSession({ model, config: { streamMaxRetries: 2 } }));
    expect(calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'RUN_ERROR', code: NON_RETRIABLE });
  });

  it('keeps the message of a plain in-stream error object', async () => {
    const ending = await endingOf([
      {
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
        ],
      },
    ]);
    expect(ending).toMatchObject({ type: 'RUN_ERROR', message: 'overloaded_error: Overloaded' });
  });

  it('forwards maxOutputTokens to the model call, and leaves it out when not configured', async () => {
    const configured = scriptedModel([{ chunks: textTurn('hi') }]);
    await run(makeSession({ model: configured.model, config: { maxOutputTokens: 777 } }));
    expect(configured.calls[0]?.maxOutputTokens).toBe(777);
    const plain = scriptedModel([{ chunks: textTurn('hi') }]);
    await run(makeSession({ model: plain.model }));
    expect(plain.calls[0]?.maxOutputTokens).toBeUndefined();
  });

  it('ends the run with a terminal event when the provider stream throws a value with no prototype', async () => {
    const bare: unknown = Object.create(null);
    const ending = await endingOf([
      { chunks: [{ type: 'stream-start', warnings: [] }], end: { error: bare } },
    ]);
    // The error itself is reported; this is not the end-of-turn bracket covering for a dead runner.
    expect(ending).toMatchObject({ type: 'RUN_ERROR', message: '[object Object]' });
  });

  it('still ends the turn when the runner dies inside its own error path', async () => {
    // A host redaction pattern that cannot be read: the error handler cannot even print its message.
    class ThrowingPattern extends RegExp {
      override get flags(): string {
        throw new Error('flags unreadable');
      }
    }
    const { model } = scriptedModel([
      {
        chunks: [{ type: 'stream-start', warnings: [] }],
        end: { error: new Error('provider down') },
      },
    ]);
    const events = await run(
      makeSession({
        model,
        config: {
          streamMaxRetries: 0,
          redactionPolicy: { extraSecretPatterns: [new ThrowingPattern('x')] },
        },
      }),
    );
    expect(events.at(-1)).toEqual({
      type: 'RUN_ERROR',
      message: 'turn ended without a result',
      code: NON_RETRIABLE,
    });
  });
});

describe('endings that must stay clean finishes', () => {
  const dispatchOk: ToolDispatchPort = {
    dispatch: (req) =>
      Promise.resolve({
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        ok: true,
        content: 'done',
        isError: false,
      }),
  };

  it('a tool step followed by a final answer', async () => {
    const ending = await endingOf([
      { chunks: toolCallTurn('c1', 'ffmpeg', { a: 1 }) },
      { chunks: textTurn('done') },
    ]);
    expect(ending?.type).toBe('RUN_FINISHED');
  });

  it('four different tool steps then a final answer', async () => {
    const steps = [1, 2, 3, 4].map((a) => ({ chunks: toolCallTurn(`c${a}`, 'ffmpeg', { a }) }));
    const ending = await endingOf([...steps, { chunks: textTurn('done') }]);
    expect(ending?.type).toBe('RUN_FINISHED');
  });

  it('a failed tool step then a final answer', async () => {
    const failing: ToolDispatchPort = {
      dispatch: (req) =>
        Promise.resolve({
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          ok: false,
          content: '',
          isError: true,
          error: 'bad file',
        }),
    };
    const { model } = scriptedModel([
      { chunks: toolCallTurn('c1', 'ffmpeg', { a: 1 }) },
      { chunks: textTurn('sorry') },
    ]);
    const events = await run(makeSession({ model, tools, toolDispatch: failing }));
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
    void dispatchOk;
  });

  it('an empty answer', async () => {
    expect((await endingOf([{ chunks: finishOnly('stop') }]))?.type).toBe('RUN_FINISHED');
  });
});

describe('the other loop ends a finish chunk as what it was', () => {
  const providerFinishing = (chunk: ProviderChunk): ModelProvider => ({
    id: 'scripted',
    async *streamChat() {
      yield chunk;
    },
  });
  const endWith = async (chunk: ProviderChunk): Promise<MinituiEvent | undefined> => {
    const events = await run(makeSession({ model: 'm', provider: providerFinishing(chunk) }));
    return events.at(-1);
  };

  it.each(['stop', 'other'] as const)('%s ends RUN_FINISHED', async (reason) => {
    expect((await endWith({ type: 'finish', reason }))?.type).toBe('RUN_FINISHED');
  });

  it('length ends non-retriable', async () => {
    expect(await endWith({ type: 'finish', reason: 'length' })).toEqual({
      type: 'RUN_ERROR',
      message: 'the model reply was cut by the output-token limit',
      code: NON_RETRIABLE,
    });
  });

  it('content-filter ends non-retriable', async () => {
    expect(await endWith({ type: 'finish', reason: 'content-filter' })).toEqual({
      type: 'RUN_ERROR',
      message: 'model output was blocked by the provider content filter',
      code: NON_RETRIABLE,
    });
  });

  it('tool-calls ends non-retriable', async () => {
    expect(await endWith({ type: 'finish', reason: 'tool-calls' })).toEqual({
      type: 'RUN_ERROR',
      message: 'turn halted: the tool-call limit was reached',
      code: NON_RETRIABLE,
    });
  });

  it('error ends with the retriable failed-generation error (this loop has no re-run tier)', async () => {
    expect(await endWith({ type: 'finish', reason: 'error' })).toEqual({
      type: 'RUN_ERROR',
      message: 'the provider reported a failed generation',
    });
  });

  it('ends the run with a terminal event when the provider throws a value with no prototype', async () => {
    const bare: unknown = Object.create(null);
    const throwing: ModelProvider = {
      id: 'scripted',
      // eslint-disable-next-line require-yield
      async *streamChat() {
        throw bare;
      },
    };
    const events = await run(makeSession({ model: 'm', provider: throwing }));
    expect(events.at(-1)).toMatchObject({ type: 'RUN_ERROR', message: '[object Object]' });
  });
});
