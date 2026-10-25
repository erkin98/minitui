import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { ToolCallRequest, ToolDispatchPort } from '../src/ports/index.js';
import type { ModelProvider } from '../src/provider/provider-port.js';
import type { MinituiEvent } from '../src/events/event-types.js';
import {
  collectWithin,
  makeSession,
  scriptedModel,
  textTurn,
  toolCallTurn,
  within,
  type CallScript,
} from './helpers/sdk-model.js';

const tools = [{ name: 'ffmpeg', description: 'merge', inputSchema: z.object({ a: z.number() }) }];

// A dispatch that never settles and ignores its signal: only the session can end a turn that waits on it.
const hungDispatch: ToolDispatchPort = { dispatch: () => new Promise(() => {}) };

// A dispatch that records what it was asked to run.
function recordingDispatch(): { port: ToolDispatchPort; requests: ToolCallRequest[] } {
  const requests: ToolCallRequest[] = [];
  return {
    requests,
    port: {
      dispatch: (req) => {
        requests.push(req);
        return Promise.resolve({
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          ok: true,
          content: 'done',
          isError: false,
        });
      },
    },
  };
}

describe('a turn ends promptly when it is cancelled or runs out of time', () => {
  it('SDK loop: cancel() ends a turn that waits on a dispatch which ignores its signal', async () => {
    const { model } = scriptedModel([
      { chunks: toolCallTurn('c1', 'ffmpeg', { a: 1 }), end: 'hang' },
    ]);
    const session = makeSession({
      model,
      tools,
      toolDispatch: hungDispatch,
      config: { idleTimeoutMs: 3000 },
    });
    let cancelledAt = 0;
    await within(
      (async () => {
        for await (const ev of session.submit('go')) {
          if (ev.type === 'TOOL_CALL_START' && cancelledAt === 0) {
            cancelledAt = performance.now();
            session.cancel();
          }
        }
      })(),
      6000,
      'the turn',
    );
    expect(cancelledAt).toBeGreaterThan(0);
    expect(performance.now() - cancelledAt).toBeLessThan(600);
  });

  const hangsAfterOneChunk: ModelProvider = {
    id: 'scripted',
    async *streamChat() {
      yield { type: 'text', text: 'hi' };
      await new Promise<void>(() => {});
    },
  };

  it('non-SDK loop: a provider that hangs after one chunk ends at the turn deadline', async () => {
    const session = makeSession({
      model: 'm',
      provider: hangsAfterOneChunk,
      config: { turnTimeoutMs: 80 },
    });
    const events: MinituiEvent[] = [];
    await within(
      (async () => {
        for await (const ev of session.submit('go')) events.push(ev);
      })(),
      2000,
      'the turn',
    );
    expect(events.at(-1)).toMatchObject({
      type: 'RUN_ERROR',
      message: 'turn exceeded its time budget',
      code: 'non-retriable',
    });
  });

  it('non-SDK loop: cancel() ends a turn that waits on a hung dispatch, silently', async () => {
    const callsATool: ModelProvider = {
      id: 'scripted',
      async *streamChat() {
        yield { type: 'tool-call', toolCallId: 'c1', toolName: 'ffmpeg', input: { a: 1 } };
        await new Promise<void>(() => {});
      },
    };
    const session = makeSession({
      model: 'm',
      provider: callsATool,
      tools,
      toolDispatch: hungDispatch,
    });
    const types: string[] = [];
    let cancelledAt = 0;
    await within(
      (async () => {
        for await (const ev of session.submit('go')) {
          types.push(ev.type);
          if (ev.type === 'TOOL_CALL_START') {
            cancelledAt = performance.now();
            session.cancel();
          }
        }
      })(),
      2000,
      'the turn',
    );
    expect(performance.now() - cancelledAt).toBeLessThan(600);
    expect(types.at(-1)).toBe('TOOL_CALL_START');
    expect(types).not.toContain('RUN_ERROR');
    expect(types).not.toContain('RUN_FINISHED');
  });
});

describe('a re-run never dispatches the abandoned attempt', () => {
  // The first attempt says nothing past the idle deadline and then produces a tool call; the second
  // attempt stays busy (a text delta every 30 ms for 300 ms), so the turn is still live when the first
  // attempt's call arrives. With a fast second attempt the turn's own teardown hides the defect.
  const firstAttempt = (errorOnAbort: boolean): CallScript => ({
    chunks: [{ type: 'stream-start', warnings: [] }],
    waitMs: 250,
    more: toolCallTurn('late', 'ffmpeg', { a: 1 }).slice(1),
    end: 'hang',
    errorOnAbort,
  });
  const secondAttempt: CallScript = {
    chunks: [{ type: 'stream-start', warnings: [] }],
    deltas: { count: 10, everyMs: 30 },
    more: textTurn('ok').slice(1),
  };

  it.each([
    ['a provider that errors when aborted', true],
    ['a provider that ignores abort', false],
  ])('%s', async (_label, errorOnAbort) => {
    const { model, calls } = scriptedModel([firstAttempt(errorOnAbort), secondAttempt]);
    const dispatch = recordingDispatch();
    const session = makeSession({
      model,
      tools,
      toolDispatch: dispatch.port,
      config: { idleTimeoutMs: 100, streamMaxRetries: 1 },
    });
    const types = await collectWithin(session.submit('go'), 5000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(calls).toHaveLength(2);
    expect(types.at(-1)).toBe('RUN_FINISHED');
    expect(dispatch.requests).toEqual([]);
  });
});

describe('cancel() reaches every turn, wherever it is', () => {
  it('a turn cancelled before its first pull yields nothing and never calls the model', async () => {
    const { model, calls } = scriptedModel([{ chunks: textTurn('hello') }]);
    const session = makeSession({ model });
    const turn = session.submit('go');
    session.cancel();
    const types = await collectWithin(turn, 2000);
    expect(types).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('a turn whose caller signal is already aborted yields nothing and never calls the model', async () => {
    const { model, calls } = scriptedModel([{ chunks: textTurn('hello') }]);
    const session = makeSession({ model });
    const types = await collectWithin(session.submit('go', { signal: AbortSignal.abort() }), 2000);
    expect(types).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('cancel() with two overlapping turns ends both', async () => {
    const { model, calls } = scriptedModel([{ end: 'hang' }, { end: 'hang' }]);
    const session = makeSession({ model, config: { idleTimeoutMs: 3000 } });
    let started = 0;
    const drain = async (): Promise<void> => {
      for await (const ev of session.submit('go')) {
        if (ev.type === 'RUN_STARTED') started += 1;
      }
    };
    const both = Promise.all([drain(), drain()]);
    while (started < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    // both turns are inside their model call: wait for the calls, not for a fixed time
    while (calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    const cancelledAt = performance.now();
    session.cancel();
    await within(both, 6000, 'both turns');
    expect(performance.now() - cancelledAt).toBeLessThan(600);
  });

  it('a turn started after an earlier one was cancelled runs normally', async () => {
    const { model } = scriptedModel([
      { chunks: textTurn('first') },
      { chunks: textTurn('second') },
    ]);
    const session = makeSession({ model });
    const first = session.submit('one');
    session.cancel();
    await collectWithin(first, 2000);
    const types = await collectWithin(session.submit('two'), 2000);
    expect(types[0]).toBe('RUN_STARTED');
    expect(types.at(-1)).toBe('RUN_FINISHED');
  });
});
