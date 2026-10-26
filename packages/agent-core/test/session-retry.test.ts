import { homedir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { APICallError } from 'ai';
import { z } from 'zod';
import type { DiagnosticsPort } from '@minitui/types';
import { systemClock, type Clock } from '../src/ports/index.js';
import type { MinituiEvent } from '../src/events/event-types.js';
import {
  collectWithin,
  makeSession,
  rejectionRecorder,
  scriptedModel,
  textTurn,
  toolCallTurn,
  within,
  type CallScript,
  type StreamPart,
} from './helpers/sdk-model.js';

interface Record1 {
  readonly msg: string;
  readonly meta: Record<string, unknown> | undefined;
}

// A real diagnostics port that keeps what it was told.
function capturingPort(): { port: DiagnosticsPort; warnings: Record1[] } {
  const warnings: Record1[] = [];
  return {
    warnings,
    port: {
      warn: (msg, meta) => {
        warnings.push({ msg, meta });
      },
      debug: () => {},
    },
  };
}

// A real clock whose waits are recorded and yield one macrotask, so a loop that never stops fails its
// test (the scripted model refuses after 25 calls) instead of hanging the run.
function recordingClock(): {
  clock: Clock;
  waits: number[];
  signals: Array<AbortSignal | undefined>;
} {
  const waits: number[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  return {
    waits,
    signals,
    clock: {
      now: () => 0,
      sleep: (ms, signal) => {
        waits.push(ms);
        signals.push(signal);
        return new Promise<void>((resolve) => setTimeout(resolve, 0));
      },
    },
  };
}

// The events of a turn without the run and thread ids, which differ between sessions.
const shape = (list: readonly MinituiEvent[]): unknown[] =>
  list.map((ev) =>
    ev.type === 'RUN_ERROR'
      ? { type: ev.type, message: ev.message, code: ev.code }
      : { type: ev.type },
  );

const drop: CallScript = { chunks: [{ type: 'stream-start', warnings: [] }] };

async function events(turn: AsyncGenerator<MinituiEvent>): Promise<MinituiEvent[]> {
  const out: MinituiEvent[] = [];
  await within(
    (async () => {
      for await (const ev of turn) out.push(ev);
    })(),
    10_000,
    'the turn',
  );
  return out;
}

describe('provider output reaches the diagnostics port, never the console', () => {
  const recorder = rejectionRecorder();
  beforeEach(() => recorder.attach());
  afterEach(() => recorder.detach());

  it('reports a stream error once, as { message }, with the path collapsed and no request text', async () => {
    const error = new APICallError({
      message: `cannot read ${homedir()}/clips/a.mp4`,
      url: 'https://example.invalid/v1/messages',
      requestBodyValues: { prompt: 'REQUEST-BODY-TEXT' },
      statusCode: 400,
      responseHeaders: { 'x-secret-header': 'HEADER-VALUE' },
    });
    const { model } = scriptedModel([
      {
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'error', error },
        ],
      },
    ]);
    const { port, warnings } = capturingPort();
    const session = makeSession({ model, diagnostics: port, config: { streamMaxRetries: 0 } });
    await events(session.submit('go'));
    expect(warnings).toEqual([
      { msg: 'model stream error', meta: { message: 'cannot read ~/clips/a.mp4' } },
    ]);
    const text = JSON.stringify(warnings);
    expect(text).not.toContain('REQUEST-BODY-TEXT');
    expect(text).not.toContain('HEADER-VALUE');
  });

  it('reports a provider warning from the stream start', async () => {
    const { model } = scriptedModel([
      {
        chunks: [
          { type: 'stream-start', warnings: [{ type: 'other', message: 'careful now' }] },
          ...textTurn('hi').slice(1),
        ],
      },
    ]);
    const { port, warnings } = capturingPort();
    await events(makeSession({ model, diagnostics: port }).submit('go'));
    const warning = warnings.find((w) => w.msg === 'model provider warning');
    expect(warning).toBeDefined();
    expect(String(warning?.meta?.warning)).toContain('careful now');
  });

  it('reports two consecutive warning batches', async () => {
    const withWarning = (message: string, rest: readonly StreamPart[]): CallScript => ({
      chunks: [{ type: 'stream-start', warnings: [{ type: 'other', message }] }, ...rest],
    });
    const { model } = scriptedModel([
      withWarning('first batch', toolCallTurn('c1', 'ffmpeg', { a: 1 }).slice(1)),
      withWarning('second batch', textTurn('done').slice(1)),
    ]);
    const { port, warnings } = capturingPort();
    const session = makeSession({
      model,
      diagnostics: port,
      tools: [{ name: 'ffmpeg', description: 'merge', inputSchema: z.object({ a: z.number() }) }],
    });
    await events(session.submit('go'));
    const texts = warnings
      .filter((w) => w.msg === 'model provider warning')
      .map((w) => String(w.meta?.warning));
    expect(texts.some((t) => t.includes('first batch'))).toBe(true);
    expect(texts.some((t) => t.includes('second batch'))).toBe(true);
  });

  it('leaves the SDK warning switch off the console path when the session has no port', async () => {
    // an earlier row may have left its own port behind: start from the SDK's default
    globalThis.AI_SDK_LOG_WARNINGS = undefined;
    const { model } = scriptedModel([{ chunks: textTurn('hi') }]);
    await events(makeSession({ model }).submit('go'));
    const logger: unknown = globalThis.AI_SDK_LOG_WARNINGS;
    expect(logger === false || typeof logger === 'function').toBe(true);
  });

  it.each([
    [
      'a port whose warn throws',
      (): DiagnosticsPort => ({
        warn: () => {
          throw new Error('port broke');
        },
        debug: () => {},
      }),
    ],
    [
      'a port whose warn returns a rejected promise',
      (): DiagnosticsPort => {
        const warn = (): Promise<never> => Promise.reject(new Error('port rejected'));
        return { warn, debug: () => {} };
      },
    ],
  ])('a turn is the same with %s', async (_label, makePort) => {
    // one turn that would finish cleanly, with a provider warning; one that ends in a provider error
    const warned = (): CallScript[] => [
      {
        chunks: [
          { type: 'stream-start', warnings: [{ type: 'other', message: 'careful' }] },
          ...textTurn('hi').slice(1),
        ],
      },
    ];
    const failing = (): CallScript[] => [
      {
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'error', error: new Error('provider down') },
        ],
      },
    ];
    for (const script of [warned, failing]) {
      const baseline = await events(
        makeSession({
          model: scriptedModel(script()).model,
          config: { streamMaxRetries: 0 },
        }).submit('go'),
      );
      const broken = await events(
        makeSession({
          model: scriptedModel(script()).model,
          diagnostics: makePort(),
          config: { streamMaxRetries: 0 },
        }).submit('go'),
      );
      await recorder.settle();
      expect(shape(broken)).toEqual(shape(baseline));
      expect(recorder.seen).toEqual([]);
    }
  });
});

// The real clock, with a record of when each wait started and settled.
function timedSystemClock(): { clock: Clock; started: number[]; settled: number[] } {
  const started: number[] = [];
  const settled: number[] = [];
  return {
    started,
    settled,
    clock: {
      now: () => systemClock.now(),
      sleep: async (ms, signal) => {
        started.push(ms);
        await systemClock.sleep(ms, signal);
        settled.push(performance.now());
      },
    },
  };
}

describe('a re-run waits, on the injected clock', () => {
  it('a stream that always drops, budget 3: four calls, waits 250/500/1000, each given a signal', async () => {
    const { model, calls } = scriptedModel([drop, drop, drop, drop, drop]);
    const { clock, waits, signals } = recordingClock();
    const session = makeSession({ model, clock, config: { streamMaxRetries: 3 } });
    const out = await events(session.submit('go'));
    expect(calls).toHaveLength(4);
    expect(waits).toEqual([250, 500, 1000]);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
    expect(out.at(-1)).toEqual({ type: 'RUN_ERROR', message: 'stream closed before finish' });
  });

  it('keeps doubling to a ceiling of 4000 ms', async () => {
    const { model } = scriptedModel(Array.from({ length: 8 }, () => drop));
    const { clock, waits } = recordingClock();
    await events(makeSession({ model, clock, config: { streamMaxRetries: 7 } }).submit('go'));
    expect(waits).toEqual([250, 500, 1000, 2000, 4000, 4000, 4000]);
  });

  it('budget 0: one call and no wait', async () => {
    const { model, calls } = scriptedModel([drop, drop]);
    const { clock, waits } = recordingClock();
    await events(makeSession({ model, clock, config: { streamMaxRetries: 0 } }).submit('go'));
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('a thrown non-retriable failure with nothing emitted: one call and no wait', async () => {
    let calls = 0;
    const throwing = (): never => {
      calls += 1;
      throw new Error('maximum context length exceeded');
    };
    const { clock, waits } = recordingClock();
    const { model } = scriptedModel([]);
    const session = makeSession({
      model,
      clock,
      config: { streamMaxRetries: 3, streamTextImpl: throwing },
    });
    const out = await events(session.submit('go'));
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
    expect(out.at(-1)).toMatchObject({ type: 'RUN_ERROR', code: 'non-retriable' });
  });

  it('real clock: cancel() during the second wait ends the turn and the wait promptly, after two calls', async () => {
    const { model, calls } = scriptedModel(Array.from({ length: 6 }, () => drop));
    const { clock, started, settled } = timedSystemClock();
    const session = makeSession({ model, clock, config: { streamMaxRetries: 5 } });
    const turn = session.submit('go');
    const finished = collectWithin(turn, 5000);
    while (calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    // cancel inside the second wait: wait until it has started, not for a fixed time
    while (started.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    const cancelledAt = performance.now();
    session.cancel();
    await finished;
    expect(performance.now() - cancelledAt).toBeLessThan(700);
    expect(calls).toHaveLength(2);
    // the wait itself was cut short by the abort, not left to run its 500 ms
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toHaveLength(2);
    expect(settled[1]! - cancelledAt).toBeLessThan(200);
  });

  it('real clock: a 300 ms turn deadline with a budget of 50 ends at the deadline', async () => {
    const { model } = scriptedModel(Array.from({ length: 25 }, () => drop));
    const session = makeSession({ model, config: { streamMaxRetries: 10, turnTimeoutMs: 300 } });
    const startedAt = performance.now();
    const out = await events(session.submit('go'));
    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeLessThan(1500);
    expect(out.at(-1)).toMatchObject({
      type: 'RUN_ERROR',
      message: 'turn exceeded its time budget',
    });
  });
});
