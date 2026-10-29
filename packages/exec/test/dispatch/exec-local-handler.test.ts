import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleExecLocal, isLikelySandboxDenied } from '../../src/dispatch/exec-local-handler.js';
import type { Decision, ExecEvent } from '@minitui/types';
import type { ExecLocalDeps } from '../../src/dispatch/exec-local-handler.js';
import type { RunnerEvent } from '../../src/types.js';
import { allowPath, execLocalDeps, fakePlanner, makeRunner, mergeCtx } from './doubles.js';

function withDeps(
  deps: Omit<ExecLocalDeps, 'signal'>,
  signal: AbortSignal = new AbortController().signal,
): ExecLocalDeps {
  return { ...deps, signal };
}

// A real temporary directory per row, removed at the end of the row.
async function inTempDir(row: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'minitui-handler-'));
  try {
    await row(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const exitZero = async function* (): AsyncGenerator<RunnerEvent> {
  yield { kind: 'exit', code: 0, signal: null };
};

describe('handleExecLocal: the output file', () => {
  it('creates a fresh output exclusively and empty, before the run, then settles', async () => {
    await inTempDir(async (dir) => {
      const output = join(dir, 'out.mp4');
      const seenAtRun: boolean[] = [];
      const runner = makeRunner(async function* () {
        seenAtRun.push(existsSync(output)); // the write root must exist when the run starts
        yield { kind: 'exit', code: 0, signal: null };
      });
      const planner = fakePlanner();
      // no `ensureOutputFile`: the handler's own exclusive create runs on the real temporary directory
      const rest = execLocalDeps({
        runner: runner.runner,
        buildFfmpegRun: planner.build,
        ensureOutputFile: undefined,
      });
      const out = await handleExecLocal(
        mergeCtx({ resolvedParams: { inputs: ['/abs/a.mp4'], output } }),
        withDeps(rest),
      );
      expect(out).toEqual({ status: 'settled', result: { output } });
      expect(seenAtRun).toEqual([true]);
      expect(statSync(output).size).toBe(0);
      expect(statSync(output).mode & 0o777).toBe(0o600);
    });
  });

  it('refuses an output that already exists: nothing is overwritten and nothing runs', async () => {
    await inTempDir(async (dir) => {
      const output = join(dir, 'out.mp4');
      writeFileSync(output, 'PRECIOUS');
      const runner = makeRunner(exitZero);
      const planner = fakePlanner();
      // no `ensureOutputFile`: the handler's own exclusive create runs on the real temporary directory
      const rest = execLocalDeps({
        runner: runner.runner,
        buildFfmpegRun: planner.build,
        ensureOutputFile: undefined,
      });
      await expect(
        handleExecLocal(
          mergeCtx({ resolvedParams: { inputs: ['/abs/a.mp4'], output } }),
          withDeps(rest),
        ),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      expect(readFileSync(output, 'utf8')).toBe('PRECIOUS');
      expect(runner.calls).toHaveLength(0);
      expect(planner.cleanups).toHaveLength(1); // the list directory is removed on a refusal too
    });
  });

  it('refuses a link at the output path: the link is not followed and its target is never created', async () => {
    await inTempDir(async (dir) => {
      const output = join(dir, 'out.mp4');
      const target = join(dir, 'elsewhere.bin');
      symlinkSync(target, output);
      const runner = makeRunner(exitZero);
      const rest = execLocalDeps({ runner: runner.runner, ensureOutputFile: undefined });
      await expect(
        handleExecLocal(
          mergeCtx({ resolvedParams: { inputs: ['/abs/a.mp4'], output } }),
          withDeps(rest),
        ),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      expect(existsSync(target)).toBe(false);
      expect(runner.calls).toHaveLength(0);
    });
  });
});

describe('handleExecLocal: cancellation', () => {
  it('an action cancelled before it starts plans, writes, creates and runs nothing', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const runner = makeRunner(exitZero);
    const planner = fakePlanner();
    const created: string[] = [];
    const out = await handleExecLocal(
      mergeCtx(),
      withDeps(
        execLocalDeps({
          runner: runner.runner,
          buildFfmpegRun: planner.build,
          ensureOutputFile: async (p) => {
            created.push(p);
          },
        }),
        ctl.signal,
      ),
    );
    expect(out).toEqual({
      status: 'failed',
      fault: { actionKey: 'merge', exitCode: -1, stderrExcerpt: 'cancelled before start' },
    });
    expect(planner.builds).toHaveLength(0);
    expect(planner.writes).toHaveLength(0);
    expect(created).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
  });

  it('an abort that lands while the path gate waits for a person writes nothing, creates nothing and runs nothing', async () => {
    const ctl = new AbortController();
    const runner = makeRunner(exitZero);
    const planner = fakePlanner();
    const created: string[] = [];
    const out = await handleExecLocal(
      mergeCtx(),
      withDeps(
        execLocalDeps({
          runner: runner.runner,
          buildFfmpegRun: planner.build,
          checkPath: async (): Promise<Decision> => {
            ctl.abort(); // the person's answer arrives after the turn was cancelled
            return { kind: 'allow' };
          },
          ensureOutputFile: async (p) => {
            created.push(p);
          },
        }),
        ctl.signal,
      ),
    );
    expect(out).toMatchObject({
      status: 'failed',
      fault: { stderrExcerpt: 'cancelled before start' },
    });
    expect(planner.writes).toHaveLength(0);
    expect(created).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
    expect(planner.cleanups).toHaveLength(1);
  });

  it('an abort between the list write and the output create still creates nothing', async () => {
    const ctl = new AbortController();
    const planner = fakePlanner();
    const created: string[] = [];
    const wrapped: typeof planner.build = (spec, opts) => {
      const built = planner.build(spec, opts);
      return {
        ...built,
        writeList: async () => {
          await built.writeList();
          ctl.abort();
        },
      };
    };
    const out = await handleExecLocal(
      mergeCtx(),
      withDeps(
        execLocalDeps({
          buildFfmpegRun: wrapped,
          ensureOutputFile: async (p) => {
            created.push(p);
          },
        }),
        ctl.signal,
      ),
    );
    expect(out.status).toBe('failed');
    expect(planner.writes).toHaveLength(1);
    expect(created).toHaveLength(0);
  });
});

describe('handleExecLocal: run, events and cleanup', () => {
  it('forwards each mapped event to BOTH the global sink and the per-dispatch sink, in the wire shape', async () => {
    const runner = makeRunner(async function* (): AsyncGenerator<RunnerEvent> {
      yield { kind: 'started', argv: ['/abs/ffmpeg'], cwd: '/tmp' };
      yield { kind: 'stdout', text: 'out' };
      yield { kind: 'progress', progress: 0.5, message: 'frame=1' };
      yield { kind: 'exit', code: 0, signal: null };
    });
    const globalEvents: ExecEvent[] = [];
    const perDispatch: ExecEvent[] = [];
    const out = await handleExecLocal(
      mergeCtx({
        onEvent: (e) => {
          perDispatch.push(e);
        },
      }),
      withDeps(
        execLocalDeps({
          runner: runner.runner,
          onEvent: (e) => {
            globalEvents.push(e);
          },
        }),
      ),
    );
    expect(out.status).toBe('settled');
    const wire: ExecEvent[] = [
      { kind: 'stdout', chunk: 'out' },
      { kind: 'progress', value: 0.5, message: 'frame=1' },
      { kind: 'exit', code: 0 },
    ];
    expect(globalEvents).toEqual(wire); // `started` is not part of the wire shape
    expect(perDispatch).toEqual(wire);
  });

  it('removes the planned list after a settled run and after a failed run', async () => {
    const settled = fakePlanner();
    await handleExecLocal(
      mergeCtx(),
      withDeps(
        execLocalDeps({ runner: makeRunner(exitZero).runner, buildFfmpegRun: settled.build }),
      ),
    );
    expect(settled.cleanups).toHaveLength(1);
    const failed = fakePlanner();
    await handleExecLocal(
      mergeCtx(),
      withDeps(
        execLocalDeps({
          runner: makeRunner(async function* (): AsyncGenerator<RunnerEvent> {
            yield { kind: 'exit', code: 2, signal: null };
          }).runner,
          buildFfmpegRun: failed.build,
        }),
      ),
    );
    expect(failed.cleanups).toHaveLength(1);
  });

  it('writes the list only after the path gate allows, and not at all on a deny or an unresolved ask', async () => {
    const denyPlanner = fakePlanner();
    const denied = await handleExecLocal(
      mergeCtx(),
      withDeps(
        execLocalDeps({
          buildFfmpegRun: denyPlanner.build,
          checkPath: async (): Promise<Decision> => ({
            kind: 'deny',
            reason: 'write outside workspace',
          }),
        }),
      ),
    );
    expect(denied).toEqual({ status: 'denied', reason: 'write outside workspace' });
    expect(denyPlanner.writes).toHaveLength(0);
    const askPlanner = fakePlanner();
    const asked = await handleExecLocal(
      mergeCtx(),
      withDeps(
        execLocalDeps({
          buildFfmpegRun: askPlanner.build,
          checkPath: async (): Promise<Decision> => ({
            kind: 'ask',
            request: {
              id: 'p1',
              descriptor: { danger: true, resourceTemplate: 'x', summaryTemplate: 'x' },
              resolvedCommand: 'x',
              resolvedPaths: [],
            },
          }),
        }),
      ),
    );
    expect(asked).toEqual({ status: 'denied', reason: 'write path approval did not resolve' });
    expect(askPlanner.writes).toHaveLength(0);
    const okPlanner = fakePlanner();
    await handleExecLocal(
      mergeCtx(),
      withDeps(execLocalDeps({ buildFfmpegRun: okPlanner.build, checkPath: allowPath })),
    );
    expect(okPlanner.writes).toHaveLength(1);
  });

  it('a stream that ends without an exit event fails with exit -1 and never settles', async () => {
    const out = await handleExecLocal(
      mergeCtx(),
      withDeps(execLocalDeps({ runner: makeRunner().runner })),
    );
    expect(out).toMatchObject({ status: 'failed', fault: { actionKey: 'merge', exitCode: -1 } });
  });

  it('an exit with no code (a kill) reports -1 on the wire and in the fault', async () => {
    const wire: ExecEvent[] = [];
    const out = await handleExecLocal(
      mergeCtx(),
      withDeps(
        execLocalDeps({
          runner: makeRunner(async function* (): AsyncGenerator<RunnerEvent> {
            yield { kind: 'exit', code: null, signal: 'SIGTERM' };
          }).runner,
          onEvent: (e) => {
            wire.push(e);
          },
        }),
      ),
    );
    expect(wire).toContainEqual({ kind: 'exit', code: -1 });
    expect(out).toMatchObject({ status: 'failed', fault: { exitCode: -1 } });
  });

  it('marks a likely sandbox denial at the END of the bounded, sanitised fault excerpt', async () => {
    const esc = String.fromCharCode(0x1b);
    const out = await handleExecLocal(
      mergeCtx(),
      withDeps(
        execLocalDeps({
          runner: makeRunner(async function* (): AsyncGenerator<RunnerEvent> {
            yield { kind: 'stderr', text: 'x'.repeat(20_000) };
            yield { kind: 'stderr', text: `${esc}[2Jffmpeg: Operation not permitted` };
            yield { kind: 'exit', code: 1, signal: null };
          }).runner,
        }),
      ),
    );
    expect(out).toMatchObject({ status: 'failed', fault: { actionKey: 'merge', exitCode: 1 } });
    const excerpt = (out as { fault: { stderrExcerpt: string } }).fault.stderrExcerpt;
    expect(excerpt.endsWith('\n[sandbox-denied]')).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(16_384 + '\n[sandbox-denied]'.length);
    expect(excerpt).toContain('ffmpeg: Operation not permitted');
    expect(excerpt).not.toContain(esc);
  });

  it('leaves an ordinary failure unmarked', async () => {
    const out = await handleExecLocal(
      mergeCtx(),
      withDeps(
        execLocalDeps({
          runner: makeRunner(async function* (): AsyncGenerator<RunnerEvent> {
            yield { kind: 'stderr', text: 'invalid codec parameter' };
            yield { kind: 'exit', code: 1, signal: null };
          }).runner,
        }),
      ),
    );
    const excerpt = (out as { fault: { stderrExcerpt: string } }).fault.stderrExcerpt;
    expect(excerpt).toContain('invalid codec parameter');
    expect(excerpt).not.toContain('[sandbox-denied]');
  });
});

describe('isLikelySandboxDenied', () => {
  it('flags a permission, seccomp, landlock or bad-system-call keyword, in any case', () => {
    expect(
      isLikelySandboxDenied({
        stderr: 'bwrap: Operation not permitted',
        exitCode: 1,
        signal: null,
      }),
    ).toBe(true);
    expect(
      isLikelySandboxDenied({ stderr: 'seccomp: bad syscall', exitCode: 1, signal: null }),
    ).toBe(true);
    // the strerror keyword wins even on darwin, where the exit-159 form does not apply
    expect(
      isLikelySandboxDenied(
        { stderr: 'ffmpeg: Bad system call', exitCode: 159, signal: null },
        'darwin',
      ),
    ).toBe(true);
  });

  it('flags a SIGSYS-killed child with no keyword', () => {
    expect(isLikelySandboxDenied({ stderr: '', exitCode: null, signal: 'SIGSYS' })).toBe(true);
  });

  it('flags exit 159 (128 + SIGSYS, the wrapped form) on linux only', () => {
    expect(isLikelySandboxDenied({ stderr: '', exitCode: 159, signal: null }, 'linux')).toBe(true);
    expect(isLikelySandboxDenied({ stderr: '', exitCode: 159, signal: null }, 'darwin')).toBe(
      false,
    );
  });

  it('does not flag a clean exit, even when stderr holds a keyword, nor a plain failure', () => {
    expect(
      isLikelySandboxDenied({ stderr: 'permission denied (ignored)', exitCode: 0, signal: null }),
    ).toBe(false);
    expect(
      isLikelySandboxDenied({ stderr: 'invalid codec parameter', exitCode: 1, signal: null }),
    ).toBe(false);
  });
});
