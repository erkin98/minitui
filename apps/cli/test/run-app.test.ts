import { describe, it, expect } from 'vitest';
import { buildValidationEnvelope, toWireSpec, type MiniAppSpec } from '@minitui/spec';
import type { AppEvent, RunHandle } from '@minitui/transport';
import type { TaskOutcome } from '@minitui/runtime-host';
import { createGenerationContext } from '../src/generation.js';
import type { MountedApp, RepairTarget, RunAppGraph } from '../src/graph-types.js';
import { runApp } from '../src/run-app.js';
import type { CliArgs } from '../src/args.js';
import { recordingDiagnostics, until } from './support/fakes.js';

const args: CliArgs = {
  intent: 'merge two clips',
  mode: 'default',
  accessible: false,
  showVersion: false,
  showHelp: false,
};
const spec: MiniAppSpec = { root: 'r', elements: {}, state: {} };

function handleOf(events: readonly AppEvent[]): RunHandle {
  return {
    events: (async function* () {
      await Promise.resolve();
      for (const event of events) yield event;
    })(),
    abort: () => {},
    signal: new AbortController().signal,
  };
}

const text = (delta: string): AppEvent => ({ kind: 'text-delta', messageId: 'm', delta });
const finished = (inputTokens: number, outputTokens: number): AppEvent => ({
  kind: 'run-finished',
  threadId: 't',
  runId: 'r',
  usage: { inputTokens, outputTokens },
});

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += chunk;
  return out;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeGraph(
  over: {
    runs?: readonly AppEvent[][];
    validate?: RunAppGraph['validate'];
    done?: Promise<TaskOutcome>;
    mount?: RunAppGraph['host']['mount'];
    cancelled?: () => boolean;
  } = {},
) {
  const order: string[] = [];
  const statusUpdates: Array<{ attempt: number; tokens?: number | undefined }> = [];
  const userTexts: string[] = [];
  const bound: Array<RepairTarget | undefined> = [];
  const log = recordingDiagnostics();
  const stderr: string[] = [];
  let unmounts = 0;
  let disposes = 0;
  let runs = 0;
  const mounted: MountedApp = {
    done: over.done ?? Promise.resolve({ status: 'completed', exitCode: 0 }),
    dispose: () => {
      disposes += 1;
    },
    updateSpec: () => {},
  };
  const graph: RunAppGraph = {
    host: {
      mount:
        over.mount ??
        (() => {
          order.push('mount');
          return Promise.resolve(mounted);
        }),
    },
    agentPort: {
      run: (input) => {
        const last = input.messages.at(-1);
        userTexts.push(typeof last?.content === 'string' ? last.content : '');
        const events = over.runs?.[runs] ?? [];
        runs += 1;
        return handleOf(events);
      },
    },
    session: {
      emitSpec: (s) => {
        order.push('emit');
        return { type: 'ACTIVITY_SNAPSHOT', spec: s };
      },
    },
    mountStatus: () => ({
      update: (state) => {
        statusUpdates.push(state);
      },
      unmount: () => {
        unmounts += 1;
        order.push('unmount');
      },
    }),
    validate:
      over.validate ??
      (async (stream) => ({ ok: true as const, spec: (await drain(stream), spec) })),
    diagnostics: log.diagnostics,
    stderr: { write: (s) => stderr.push(s) },
    cancelled: over.cancelled ?? (() => false),
    bindHostSession: (s) => {
      bound.push(s);
    },
    generation: createGenerationContext(),
  };
  return {
    graph,
    order,
    statusUpdates,
    userTexts,
    bound,
    log,
    stderr,
    mounted,
    unmounts: () => unmounts,
    disposes: () => disposes,
    runs: () => runs,
  };
}

describe('runApp: the interactive phase', () => {
  it('emits the spec, swaps the status line for the app, mounts it and returns the exit code of the outcome', async () => {
    const fake = fakeGraph({
      runs: [[text('{}')]],
      done: Promise.resolve({ status: 'completed', exitCode: 7 }),
    });
    expect(await runApp(args, fake.graph)).toBe(7);
    expect(fake.order.slice(0, 3)).toEqual(['emit', 'unmount', 'mount']);
    expect(fake.disposes()).toBe(1);
  });

  it('sends the wire form of the validated spec to the session', async () => {
    let emitted: unknown;
    const fake = fakeGraph();
    const graph: RunAppGraph = {
      ...fake.graph,
      session: {
        emitSpec: (s) => {
          emitted = s;
          return { type: 'ACTIVITY_SNAPSHOT', spec: s };
        },
      },
    };
    await runApp(args, graph);
    expect(emitted).toEqual(toWireSpec(spec));
  });

  it('does not return until the app is done', async () => {
    const done = deferred<TaskOutcome>();
    const fake = fakeGraph({ done: done.promise });
    const result = runApp(args, fake.graph);
    await until(() => fake.order.includes('mount'), 'the app to mount');
    const early = await Promise.race([
      result,
      new Promise<string>((resolve) => setTimeout(() => resolve('still running'), 20)),
    ]);
    expect(early).toBe('still running');
    done.resolve({ status: 'cancelled', exitCode: 130 });
    expect(await result).toBe(130);
  });

  it('carries a failed outcome through as its own code', async () => {
    const fake = fakeGraph({ done: Promise.resolve({ status: 'failed', exitCode: 3 }) });
    expect(await runApp(args, fake.graph)).toBe(3);
  });

  it('binds the mounted session for repairs and releases it at the end', async () => {
    const fake = fakeGraph();
    await runApp(args, fake.graph);
    expect(fake.bound).toEqual([fake.mounted, undefined]);
  });

  it('tears the status line down and releases the binding when the mount fails', async () => {
    const fake = fakeGraph({ mount: () => Promise.reject(new Error('mount failed')) });
    await expect(runApp(args, fake.graph)).rejects.toThrow('mount failed');
    expect(fake.unmounts()).toBeGreaterThan(0);
    expect(fake.bound.at(-1)).toBeUndefined();
  });
});

describe('runApp: generation', () => {
  it('shows the attempt and the running token total on the status line', async () => {
    const fake = fakeGraph({
      runs: [
        [text('a'), finished(10, 5)],
        [text('b'), finished(1, 1)],
      ],
      validate: async (stream, regenerate) => {
        await drain(stream);
        await drain(regenerate('fix it'));
        return { ok: true, spec };
      },
    });
    await runApp(args, fake.graph);
    expect(fake.statusUpdates).toEqual([
      { attempt: 1, tokens: 15 },
      { attempt: 2, tokens: 15 },
      { attempt: 2, tokens: 17 },
    ]);
  });

  it('keeps the token total an exact integer however many tokens the runs report', async () => {
    const fake = fakeGraph({ runs: [[finished(Number.MAX_SAFE_INTEGER, 5)]] });
    await runApp(args, fake.graph);
    expect(fake.statusUpdates.at(-1)).toEqual({ attempt: 1, tokens: Number.MAX_SAFE_INTEGER });
  });

  it('re-asks with the intent, the previous reply and the loop reprompt', async () => {
    const fake = fakeGraph({
      runs: [[text('first reply')], [text('second reply')]],
      validate: async (stream, regenerate) => {
        await drain(stream);
        await drain(regenerate('fix the root'));
        return { ok: true, spec };
      },
    });
    await runApp(args, fake.graph);
    const second = fake.userTexts[1] ?? '';
    expect(second).toContain('merge two clips');
    expect(second).toContain('first reply');
    expect(second).toContain('fix the root');
    expect(fake.graph.generation.previousText).toBe('second reply');
  });

  it('starts no new turn once cancelled, and exits 130 without mounting', async () => {
    let cancelled = false;
    const fake = fakeGraph({
      runs: [[text('x')]],
      cancelled: () => cancelled,
      validate: async (stream, regenerate) => {
        await drain(stream);
        cancelled = true;
        await drain(regenerate('again'));
        return { ok: true, spec };
      },
    });
    expect(await runApp(args, fake.graph)).toBe(130);
    expect(fake.runs()).toBe(1);
    expect(fake.order).not.toContain('mount');
    expect(fake.unmounts()).toBeGreaterThan(0);
  });

  it('a stream that fails because of the cancel is a cancel and not an error', async () => {
    let cancelled = false;
    const fake = fakeGraph({
      cancelled: () => cancelled,
      validate: () => {
        cancelled = true;
        return Promise.reject(new Error('aborted'));
      },
    });
    expect(await runApp(args, fake.graph)).toBe(130);
    expect(fake.log.records).toEqual([]);
  });

  it('an error that is not a cancel reaches the caller', async () => {
    const fake = fakeGraph({ validate: () => Promise.reject(new Error('boom')) });
    await expect(runApp(args, fake.graph)).rejects.toThrow('boom');
    expect(fake.unmounts()).toBeGreaterThan(0);
  });
});

describe('runApp: the ways generation ends without an app', () => {
  const first = buildValidationEnvelope({
    attempt: 1,
    structural: [{ severity: 'error', code: 'empty_spec', message: 'the spec is empty' }],
    semantic: [],
  });
  const last = buildValidationEnvelope({ attempt: 6, structural: [], semantic: [] });

  it('on exhaustion prints a summary, logs it and exits 1 without mounting', async () => {
    const fake = fakeGraph({
      validate: () => Promise.resolve({ ok: false, firstEnvelope: first, lastEnvelope: last }),
    });
    expect(await runApp(args, fake.graph)).toBe(1);
    expect(fake.stderr.join('')).toContain('exhausted 6 attempts');
    expect(fake.stderr.join('')).toContain('the spec is empty');
    expect(fake.log.records).toContainEqual({
      level: 'warn',
      msg: 'could not generate a valid mini app',
      meta: expect.objectContaining({ attempts: 6 }) as Record<string, unknown>,
    });
    expect(fake.order).not.toContain('mount');
    expect(fake.unmounts()).toBeGreaterThan(0);
  });

  it('on a provider error prints it cleaned and bounded, logs it and exits 1 without mounting', async () => {
    const hostile = `overloaded ${String.fromCharCode(0x9b)}2J ${'x'.repeat(5000)}`;
    const fake = fakeGraph({
      runs: [[{ kind: 'run-error', message: hostile, code: 'overloaded', retriable: true }]],
    });
    expect(await runApp(args, fake.graph)).toBe(1);
    const printed = fake.stderr.join('');
    expect(printed).toContain('provider error');
    expect(printed).toContain('overloaded');
    expect(printed).not.toContain(String.fromCharCode(0x9b));
    expect(printed.length).toBeLessThanOrEqual(2001);
    expect(fake.log.records[0]).toMatchObject({
      msg: 'provider error',
      meta: { code: 'overloaded' },
    });
    expect(fake.order).not.toContain('mount');
  });

  it('a provider error does not use up the regeneration budget', async () => {
    const fake = fakeGraph({
      runs: [[{ kind: 'run-error', message: 'down', retriable: true }]],
    });
    await runApp(args, fake.graph);
    expect(fake.runs()).toBe(1);
  });
});
