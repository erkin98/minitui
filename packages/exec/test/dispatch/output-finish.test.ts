import { describe, it, expect } from 'vitest';
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { handleExecLocal } from '../../src/dispatch/exec-local-handler.js';
import { HardFloorError, SandboxUnavailableError } from '../../src/errors.js';
import type { Decision } from '@minitui/types';
import type { ExecLocalDeps } from '../../src/dispatch/exec-local-handler.js';
import type { RunnerEvent } from '../../src/types.js';
import {
  execLocalDeps,
  fakePlanner,
  inTempDir,
  makeRunner,
  mergeCtx,
  withDeps,
} from './doubles.js';

const ctxFor = (output: string, over: Parameters<typeof mergeCtx>[0] = {}) =>
  mergeCtx({ resolvedParams: { inputs: ['/abs/a.mp4'], output }, ...over });

const exit = (code: number | null, signal: NodeJS.Signals | null = null): RunnerEvent => ({
  kind: 'exit',
  code,
  signal,
});

type Create = NonNullable<ExecLocalDeps['ensureOutputFile']>;

/** A create double that makes no file and hands back a finisher that records the `keep` it receives. */
function recordingCreate(seen: boolean[], fail?: Error): Create {
  return async () => {
    return (keep: boolean): Promise<void> => {
      seen.push(keep);
      // a finisher that throws synchronously, not only one that rejects
      if (fail) throw fail;
      return Promise.resolve();
    };
  };
}

describe('handleExecLocal: the output file made by the host when the run does not settle', () => {
  it('removes it after a failed exit', async () => {
    await inTempDir(async (dir) => {
      const output = join(dir, 'out.mp4');
      const runner = makeRunner(async function* () {
        writeFileSync(output, 'x'.repeat(10));
        yield exit(1);
      });
      const out = await handleExecLocal(
        ctxFor(output),
        withDeps(execLocalDeps({ runner: runner.runner, ensureOutputFile: undefined })),
      );
      expect(out.status).toBe('failed');
      expect(existsSync(output)).toBe(false);
    });
  });

  it('removes it after an abort, and the same name can be used again', async () => {
    await inTempDir(async (dir) => {
      const output = join(dir, 'out.mp4');
      const aborted = makeRunner(async function* () {
        writeFileSync(output, 'partial encode');
        yield exit(null, 'SIGTERM');
      });
      const first = await handleExecLocal(
        ctxFor(output),
        withDeps(execLocalDeps({ runner: aborted.runner, ensureOutputFile: undefined })),
      );
      expect(first.status).toBe('failed');
      expect(existsSync(output)).toBe(false);
      const retry = makeRunner(async function* () {
        yield exit(0);
      });
      const second = await handleExecLocal(
        ctxFor(output),
        withDeps(execLocalDeps({ runner: retry.runner, ensureOutputFile: undefined })),
      );
      expect(second).toEqual({ status: 'settled', result: { output } });
      expect(statSync(output).size).toBe(0);
    });
  });

  it('removes it when the runner rejects after the create, and the rejection is the original one', async () => {
    for (const make of [
      () => new HardFloorError('floor'),
      () => new SandboxUnavailableError('wrap refused'),
    ]) {
      await inTempDir(async (dir) => {
        const output = join(dir, 'out.mp4');
        const failure = make();
        // eslint-disable-next-line require-yield
        const runner = makeRunner(async function* (): AsyncGenerator<RunnerEvent> {
          throw failure;
        });
        await expect(
          handleExecLocal(
            ctxFor(output),
            withDeps(execLocalDeps({ runner: runner.runner, ensureOutputFile: undefined })),
          ),
        ).rejects.toBe(failure);
        expect(existsSync(output)).toBe(false);
      });
    }
  });

  it('a finisher that throws never replaces the runner rejection, and the list is still removed', async () => {
    const seen: boolean[] = [];
    const planner = fakePlanner();
    const failure = new HardFloorError('floor');
    // eslint-disable-next-line require-yield
    const runner = makeRunner(async function* (): AsyncGenerator<RunnerEvent> {
      throw failure;
    });
    await expect(
      handleExecLocal(
        ctxFor('/abs/out.mp4'),
        withDeps(
          execLocalDeps({
            runner: runner.runner,
            buildFfmpegRun: planner.build,
            ensureOutputFile: recordingCreate(seen, new Error('finisher failed')),
          }),
        ),
      ),
    ).rejects.toBe(failure);
    expect(seen).toEqual([false]);
    expect(planner.cleanups).toHaveLength(1);
  });

  it('keeps the output of a settled run, and tells the finisher to keep it', async () => {
    await inTempDir(async (dir) => {
      const output = join(dir, 'out.mp4');
      const runner = makeRunner(async function* () {
        writeFileSync(output, 'the merged clip');
        yield exit(0);
      });
      const out = await handleExecLocal(
        ctxFor(output),
        withDeps(execLocalDeps({ runner: runner.runner, ensureOutputFile: undefined })),
      );
      expect(out).toEqual({ status: 'settled', result: { output } });
      expect(readFileSync(output, 'utf8')).toBe('the merged clip');
    });
    const seen: boolean[] = [];
    const settled = await handleExecLocal(
      ctxFor('/abs/out.mp4'),
      withDeps(
        execLocalDeps({
          runner: makeRunner(async function* () {
            yield exit(0);
          }).runner,
          ensureOutputFile: recordingCreate(seen),
        }),
      ),
    );
    expect(settled.status).toBe('settled');
    expect(seen).toEqual([true]);
  });

  it('leaves a different regular file that took the path during the run', async () => {
    await inTempDir(async (dir) => {
      const output = join(dir, 'out.mp4');
      const runner = makeRunner(async function* () {
        rmSync(output);
        writeFileSync(output, 'SOMEONE ELSE');
        yield exit(1);
      });
      const out = await handleExecLocal(
        ctxFor(output),
        withDeps(execLocalDeps({ runner: runner.runner, ensureOutputFile: undefined })),
      );
      expect(out.status).toBe('failed');
      expect(readFileSync(output, 'utf8')).toBe('SOMEONE ELSE');
    });
  });

  it('leaves a link at the path and the file it points at when the made file was moved aside', async () => {
    await inTempDir(async (dir) => {
      const output = join(dir, 'out.mp4');
      const moved = join(dir, 'moved.mp4');
      const runner = makeRunner(async function* () {
        writeFileSync(output, 'kept');
        renameSync(output, moved);
        symlinkSync(moved, output);
        yield exit(1);
      });
      const out = await handleExecLocal(
        ctxFor(output),
        withDeps(execLocalDeps({ runner: runner.runner, ensureOutputFile: undefined })),
      );
      expect(out.status).toBe('failed');
      expect(lstatSync(output).isSymbolicLink()).toBe(true);
      expect(readFileSync(moved, 'utf8')).toBe('kept');
    });
  });

  it('a create that returns no finisher is fine on a failed run', async () => {
    const out = await handleExecLocal(
      ctxFor('/abs/out.mp4'),
      withDeps(
        execLocalDeps({
          runner: makeRunner(async function* () {
            yield exit(1);
          }).runner,
        }),
      ),
    );
    expect(out.status).toBe('failed');
  });

  it('a finisher that throws does not change the outcome and does not skip the list cleanup', async () => {
    const seen: boolean[] = [];
    const planner = fakePlanner();
    const out = await handleExecLocal(
      ctxFor('/abs/out.mp4'),
      withDeps(
        execLocalDeps({
          runner: makeRunner(async function* () {
            yield exit(1);
          }).runner,
          buildFfmpegRun: planner.build,
          ensureOutputFile: recordingCreate(seen, new Error('finisher failed')),
        }),
      ),
    );
    expect(out).toMatchObject({ status: 'failed', fault: { exitCode: 1 } });
    expect(seen).toEqual([false]);
    expect(planner.cleanups).toHaveLength(1);
  });

  it('calls the finisher after the runner has ended, not before', async () => {
    const order: string[] = [];
    const runner = makeRunner(async function* (): AsyncGenerator<RunnerEvent> {
      try {
        order.push('run');
        yield exit(1);
        order.push('runner-last');
      } finally {
        order.push('runner-finally');
      }
    });
    const create: Create = async () => {
      return (keep: boolean): Promise<void> => {
        order.push(`finish:${String(keep)}`);
        return Promise.resolve();
      };
    };
    await handleExecLocal(
      ctxFor('/abs/out.mp4'),
      withDeps(execLocalDeps({ runner: runner.runner, ensureOutputFile: create })),
    );
    expect(order).toEqual(['run', 'runner-last', 'runner-finally', 'finish:false']);
  });

  it('removes nothing, and creates nothing, when the path gate denies or an abort lands first', async () => {
    await inTempDir(async (dir) => {
      const output = join(dir, 'out.mp4');
      writeFileSync(output, 'PRECIOUS');
      const created: string[] = [];
      const denied = await handleExecLocal(
        ctxFor(output),
        withDeps(
          execLocalDeps({
            checkPath: async (): Promise<Decision> => ({ kind: 'deny', reason: 'outside' }),
            ensureOutputFile: async (p) => {
              created.push(p);
            },
          }),
        ),
      );
      expect(denied).toEqual({ status: 'denied', reason: 'outside' });
      const ctl = new AbortController();
      const cancelled = await handleExecLocal(
        ctxFor(output),
        withDeps(
          execLocalDeps({
            checkPath: async (): Promise<Decision> => {
              ctl.abort();
              return { kind: 'allow' };
            },
            ensureOutputFile: async (p) => {
              created.push(p);
            },
          }),
          ctl.signal,
        ),
      );
      expect(cancelled.status).toBe('failed');
      expect(created).toHaveLength(0);
      expect(readFileSync(output, 'utf8')).toBe('PRECIOUS');
    });
  });

  it('removes it when the stream ends with no exit event', async () => {
    await inTempDir(async (dir) => {
      const output = join(dir, 'out.mp4');
      const out = await handleExecLocal(
        ctxFor(output),
        withDeps(execLocalDeps({ runner: makeRunner().runner, ensureOutputFile: undefined })),
      );
      expect(out).toMatchObject({ status: 'failed', fault: { exitCode: -1 } });
      expect(existsSync(output)).toBe(false);
    });
  });

  it('removes it when an event sink throws mid-run, and the runner is released', async () => {
    await inTempDir(async (dir) => {
      const output = join(dir, 'out.mp4');
      let released = false;
      const runner = makeRunner(async function* (): AsyncGenerator<RunnerEvent> {
        try {
          yield { kind: 'stdout', text: 'hello' };
          yield exit(0);
        } finally {
          released = true;
        }
      });
      await expect(
        handleExecLocal(
          ctxFor(output, {
            onEvent: () => {
              throw new Error('sink failed');
            },
          }),
          withDeps(execLocalDeps({ runner: runner.runner, ensureOutputFile: undefined })),
        ),
      ).rejects.toThrow('sink failed');
      expect(existsSync(output)).toBe(false);
      expect(released).toBe(true);
    });
  });
});
