import { describe, it, expect } from 'vitest';
import { createLocalRunner } from '../../src/exec/local-runner.js';
import { StreamChild, fakeSandbox, passHardFloor } from './runner-doubles.js';
import type { SpawnFn } from '../../src/exec/spawn-opts.js';
import type { RunnerEvent, RunSpec } from '../../src/types.js';

const spec: RunSpec = {
  command: process.execPath,
  args: [],
  cwd: process.cwd(),
  sandboxPolicy: { allowWrite: [], allowEgress: [] },
};

describe('createLocalRunner: the event queue is bounded by backpressure', () => {
  it('pauses both streams past 1,024 unread events, resumes them below 256, and loses nothing', async () => {
    const child = new StreamChild(4302, 0);
    const run = createLocalRunner({
      sandbox: fakeSandbox(),
      checkHardFloor: passHardFloor,
      spawn: (() => child) as SpawnFn,
    }).run(spec, new AbortController().signal);
    expect((await run.next()).value).toMatchObject({ kind: 'started' });
    expect(child.stdout.isPaused()).toBe(false);
    // one read of 1,100 lines: a read is split in full before a pause can act
    child.stdout.emit('data', Buffer.from('x\n'.repeat(1_100)));
    expect(child.stdout.isPaused()).toBe(true);
    expect(child.stderr.isPaused()).toBe(true);
    const events: RunnerEvent[] = [];
    const pull = async (): Promise<void> => {
      const next = await run.next();
      if (!next.done) events.push(next.value);
    };
    for (let i = 0; i < 844; i++) await pull();
    expect(child.stdout.isPaused()).toBe(true); // 256 still unread
    await pull();
    expect(child.stdout.isPaused()).toBe(false); // 255 unread: flowing again
    expect(child.stderr.isPaused()).toBe(false);
    child.stdout.emit('data', Buffer.from('y\n'.repeat(5)));
    child.emit('close', 0, null);
    for await (const ev of run) events.push(ev);
    expect(events.filter((e) => e.kind === 'stdout')).toHaveLength(1_105);
    expect(events.at(-1)).toEqual({ kind: 'exit', code: 0, signal: null });
  });
});
