import { describe, it, expect } from 'vitest';
import { createLocalRunner } from '../../src/exec/local-runner.js';
import { FakeChild, fakeSandbox, passHardFloor } from './runner-doubles.js';
import { rejectingSink, throwingSink, unhandledRejectionsDuring } from '../support/sinks.js';
import type { DiagnosticsPort } from '@minitui/types';
import type { SpawnFn } from '../../src/exec/spawn-opts.js';
import type { RunnerEvent, RunSpec } from '../../src/types.js';

const spec: RunSpec = {
  command: process.execPath,
  args: [],
  cwd: process.cwd(),
  sandboxPolicy: { allowWrite: [], allowEgress: [] },
};

/** Starts a run on a child that never spawns, closes it as given, and returns what the run yielded. */
async function closeWith(
  diagnostics: DiagnosticsPort,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<RunnerEvent[]> {
  const child = new FakeChild(4301, code ?? 1);
  const run = createLocalRunner({
    sandbox: fakeSandbox(),
    checkHardFloor: passHardFloor,
    spawn: (() => child) as SpawnFn,
    diagnostics,
  }).run(spec, new AbortController().signal);
  const events: RunnerEvent[] = [];
  const first = await run.next();
  if (!first.done) events.push(first.value);
  // the row emits the close itself: a sink that throws out of the listener would throw here
  child.emit('close', code, signal);
  for await (const ev of run) events.push(ev);
  return events;
}

describe('createLocalRunner: the seccomp warning cannot escape a failing sink', () => {
  it('a sink that throws on a SIGSYS exit changes nothing: the run still yields its exit', async () => {
    const events = await closeWith(throwingSink, null, 'SIGSYS');
    expect(events.at(-1)).toEqual({ kind: 'exit', code: null, signal: 'SIGSYS' });
  });

  it('a sink that rejects on an exit of 159 leaves no unhandled rejection, and the exit is yielded', async () => {
    let events: RunnerEvent[] = [];
    const seen = await unhandledRejectionsDuring(async () => {
      events = await closeWith(rejectingSink, 159, null);
    });
    expect(seen).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: 'exit', code: 159, signal: null });
  });
});
