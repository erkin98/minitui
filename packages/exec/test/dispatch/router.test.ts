import { describe, it, expect } from 'vitest';
import { SandboxUnavailableError } from '../../src/errors.js';
import { createActionRouter } from '../../src/dispatch/index.js';
import { buildPermissionRequest } from '../../src/permission/resolve-request.js';
import type { Decision, ExecEvent } from '@minitui/types';
import type { RunnerEvent } from '../../src/types.js';
import {
  execLocalDeps,
  fakePlanner,
  fakeSandbox,
  fullRequest,
  makeEngine,
  makeRunner,
  mergeCtx,
  routerDeps,
} from './doubles.js';

const allowEngine = { check: async (): Promise<Decision> => ({ kind: 'allow' }) };

describe('createActionRouter: the sandbox guard, then the gate, then execute', () => {
  it('refuses every gated kind BEFORE the permission engine when the sandbox is not active', async () => {
    const runner = makeRunner();
    const engine = makeEngine();
    const inactive = fakeSandbox({
      active: false,
      assertGatable: () => {
        throw new SandboxUnavailableError('sandbox unavailable: fail closed');
      },
    });
    for (const actionKind of ['exec-local', 'exec-mcp', 'agent-callback'] as const) {
      const out = await createActionRouter(
        routerDeps(engine, {
          execLocal: execLocalDeps({ runner: runner.runner, sandbox: inactive }),
        }),
      ).dispatch('merge', mergeCtx({ actionKind }));
      expect(out).toMatchObject({ status: 'denied', reason: expect.stringMatching(/fail closed/) });
    }
    expect(engine.calls).toHaveLength(0); // the guard runs before the engine
    expect(runner.calls).toHaveLength(0);
  });

  it('denies WITHOUT executing when the engine denies', async () => {
    const runner = makeRunner();
    const out = await createActionRouter(
      routerDeps(
        { check: async (): Promise<Decision> => ({ kind: 'deny', reason: 'hard floor' }) },
        { execLocal: execLocalDeps({ runner: runner.runner }) },
      ),
    ).dispatch('merge', mergeCtx());
    expect(out).toEqual({ status: 'denied', reason: 'hard floor' });
    expect(runner.calls).toHaveLength(0);
  });

  it('denies an unresolved ask from the engine, still without executing', async () => {
    const runner = makeRunner();
    const out = await createActionRouter(
      routerDeps(
        { check: async (): Promise<Decision> => ({ kind: 'ask', request: fullRequest() }) },
        { execLocal: execLocalDeps({ runner: runner.runner }) },
      ),
    ).dispatch('merge', mergeCtx());
    expect(out).toEqual({ status: 'denied', reason: 'approval did not resolve' });
    expect(runner.calls).toHaveLength(0);
  });

  it('strips terminal escapes from the text of a refused guard before it becomes the denial reason', async () => {
    const esc = String.fromCharCode(0x1b);
    const noisy = fakeSandbox({
      assertGatable: () => {
        throw new SandboxUnavailableError(`blocked${esc}[2Jhere`);
      },
    });
    const out = await createActionRouter(
      routerDeps(makeEngine(), { execLocal: execLocalDeps({ sandbox: noisy }) }),
    ).dispatch('merge', mergeCtx());
    expect(out.status).toBe('denied');
    const reason = (out as { reason: string }).reason;
    expect(reason).not.toContain(esc);
    expect(reason).toContain('blocked');
  });

  it('hands its own signal to the handler: a router whose signal is already aborted plans and runs nothing', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const runner = makeRunner();
    const planner = fakePlanner();
    const out = await createActionRouter(
      routerDeps(allowEngine, {
        signal: ctl.signal,
        execLocal: execLocalDeps({ runner: runner.runner, buildFfmpegRun: planner.build }),
      }),
    ).dispatch('merge', mergeCtx());
    expect(out).toMatchObject({
      status: 'failed',
      fault: { stderrExcerpt: 'cancelled before start' },
    });
    expect(planner.builds).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
  });

  it('rejects render-local by design, without consulting the engine', async () => {
    const engine = makeEngine();
    const out = await createActionRouter(routerDeps(engine)).dispatch(
      'setX',
      mergeCtx({ actionKind: 'render-local' }),
    );
    expect(out.status).toBe('denied');
    expect(engine.calls).toHaveLength(0);
  });

  it('exec-mcp skips the generic gate, runs no handler and is refused', async () => {
    const engine = makeEngine();
    const runner = makeRunner();
    const emitted: unknown[] = [];
    const out = await createActionRouter(
      routerDeps(engine, {
        execLocal: execLocalDeps({ runner: runner.runner }),
        callback: { allowlist: new Set(['merge']), emit: (e) => emitted.push(e) },
      }),
    ).dispatch('merge', mergeCtx({ actionKind: 'exec-mcp' }));
    expect(out).toEqual({ status: 'denied', reason: 'exec-mcp is not available in this version' });
    expect(engine.calls).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it('on allow, routes a callback through the allowlist gate', async () => {
    const emitted: { kind: string; name: string }[] = [];
    const out = await createActionRouter(
      routerDeps(allowEngine, {
        callback: { allowlist: new Set(['regenerate']), emit: (e) => emitted.push(e) },
      }),
    ).dispatch('regenerate', mergeCtx({ actionName: 'regenerate', actionKind: 'agent-callback' }));
    expect(out.status).toBe('settled');
    expect(emitted).toContainEqual(
      expect.objectContaining({ kind: 'agent-callback', name: 'regenerate' }),
    );
  });

  it('refuses a callback whose name is not on the allowlist, without emitting it', async () => {
    const emitted: unknown[] = [];
    const out = await createActionRouter(
      routerDeps(allowEngine, {
        callback: { allowlist: new Set(['regenerate']), emit: (e) => emitted.push(e) },
      }),
    ).dispatch('erase', mergeCtx({ actionName: 'erase', actionKind: 'agent-callback' }));
    expect(out).toEqual({ status: 'denied', reason: 'callback not in catalog allowlist' });
    expect(emitted).toHaveLength(0);
  });

  it('maps a thrown fail-closed wrap (the runner aborts before the spawn) to a failed outcome and never lets it escape', async () => {
    // eslint-disable-next-line require-yield
    const runner = makeRunner(async function* (): AsyncGenerator<never> {
      throw new SandboxUnavailableError('sandbox unsupported OS: fail closed');
    });
    const out = await createActionRouter(
      routerDeps(allowEngine, { execLocal: execLocalDeps({ runner: runner.runner }) }),
    ).dispatch('merge', mergeCtx());
    expect(out.status).toBe('failed');
    expect(out).toMatchObject({ fault: { actionKey: 'merge', exitCode: -1 } });
  });

  it('maps a thrown value that is not an Error to a fixed text, never running its own toString', async () => {
    let ran = false;
    const hostile = {
      toString(): string {
        ran = true;
        return 'attacker text';
      },
    };
    const out = await createActionRouter(
      routerDeps(allowEngine, {
        execLocal: execLocalDeps({
          // eslint-disable-next-line require-yield
          runner: makeRunner(async function* (): AsyncGenerator<never> {
            // a thrown non-Error is the case under test
            throw hostile;
          }).runner,
        }),
      }),
    ).dispatch('merge', mergeCtx());
    expect(out).toMatchObject({ status: 'failed', fault: { stderrExcerpt: 'unexpected failure' } });
    expect(ran).toBe(false);
  });

  it('denies before writing, creating or running when the resolved list-file path is denied', async () => {
    const runner = makeRunner();
    const planner = fakePlanner();
    const created: string[] = [];
    const out = await createActionRouter(
      routerDeps(allowEngine, {
        execLocal: execLocalDeps({
          runner: runner.runner,
          buildFfmpegRun: planner.build,
          checkPath: async (): Promise<Decision> => ({
            kind: 'deny',
            reason: 'write outside workspace',
          }),
          ensureOutputFile: async (p) => {
            created.push(p);
          },
        }),
      }),
    ).dispatch('merge', mergeCtx());
    expect(out).toMatchObject({ status: 'denied', reason: 'write outside workspace' });
    expect(planner.writes).toHaveLength(0);
    expect(created).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
  });

  it('writes the list only after a blocking path gate allows, then creates the output, then runs', async () => {
    const order: string[] = [];
    const runner = makeRunner(async function* (): AsyncGenerator<RunnerEvent> {
      order.push('run');
      yield { kind: 'exit', code: 0, signal: null };
    });
    const planner = fakePlanner();
    let answer: (decision: Decision) => void = () => {};
    const answered = new Promise<Decision>((resolve) => {
      answer = resolve;
    });
    const pending = createActionRouter(
      routerDeps(allowEngine, {
        execLocal: execLocalDeps({
          runner: runner.runner,
          buildFfmpegRun: planner.build,
          checkPath: async (): Promise<Decision> => {
            order.push('gate');
            return answered;
          },
          ensureOutputFile: async (path) => {
            order.push(`create ${path} after ${String(planner.writes.length)} write`);
          },
        }),
      }),
    ).dispatch('merge', mergeCtx());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(planner.writes).toHaveLength(0); // the gate has not answered: nothing is written
    answer({ kind: 'allow' });
    expect(await pending).toEqual({ status: 'settled', result: { output: '/abs/out.mp4' } });
    expect(order).toEqual(['gate', 'create /abs/out.mp4 after 1 write', 'run']);
  });

  it('sanitises and windows the message of a thrown error before it becomes fault text', async () => {
    const esc = String.fromCharCode(0x1b);
    // eslint-disable-next-line require-yield
    const runner = makeRunner(async function* (): AsyncGenerator<never> {
      throw new Error(`${'y'.repeat(20_000)}${esc}[2Jcleared`);
    });
    const out = await createActionRouter(
      routerDeps(allowEngine, { execLocal: execLocalDeps({ runner: runner.runner }) }),
    ).dispatch('merge', mergeCtx());
    expect(out.status).toBe('failed');
    const excerpt = (out as { fault: { stderrExcerpt: string } }).fault.stderrExcerpt;
    expect(excerpt).not.toContain(esc);
    expect(excerpt.length).toBeLessThanOrEqual(16_384);
    expect(excerpt.endsWith('cleared')).toBe(true);
  });

  it('forwards each mapped exec event to BOTH the global sink and the per-dispatch sink', async () => {
    const runner = makeRunner(async function* (): AsyncGenerator<RunnerEvent> {
      yield { kind: 'progress', progress: 0.5, message: 'frame=1' };
      yield { kind: 'exit', code: 0, signal: null };
    });
    const globalEvents: ExecEvent[] = [];
    const perDispatch: ExecEvent[] = [];
    const out = await createActionRouter(
      routerDeps(allowEngine, {
        execLocal: execLocalDeps({
          runner: runner.runner,
          onEvent: (e) => {
            globalEvents.push(e);
          },
        }),
      }),
    ).dispatch(
      'merge',
      mergeCtx({
        onEvent: (e) => {
          perDispatch.push(e);
        },
      }),
    );
    expect(out.status).toBe('settled');
    expect(globalEvents).toContainEqual(expect.objectContaining({ kind: 'progress', value: 0.5 }));
    expect(perDispatch).toContainEqual(expect.objectContaining({ kind: 'progress', value: 0.5 }));
  });
});

describe('createActionRouter with the real request builder', () => {
  it('turns a relative resolved path into a denial before the engine is consulted', async () => {
    const engine = makeEngine();
    const runner = makeRunner();
    const out = await createActionRouter(
      routerDeps(engine, {
        buildPermissionRequest,
        execLocal: execLocalDeps({ runner: runner.runner }),
      }),
    ).dispatch(
      'merge',
      mergeCtx({ resolvedParams: { inputs: ['relative/a.mp4'], output: '/abs/o.mp4' } }),
    );
    expect(out).toMatchObject({ status: 'denied', reason: expect.stringMatching(/absolute/i) });
    expect(engine.calls).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
  });

  it('hands the engine a request built from the resolved slots, and runs only after the engine allows', async () => {
    const engine = makeEngine();
    const runner = makeRunner(async function* (): AsyncGenerator<RunnerEvent> {
      yield { kind: 'exit', code: 0, signal: null };
    });
    const out = await createActionRouter(
      routerDeps(engine, {
        buildPermissionRequest,
        execLocal: execLocalDeps({ runner: runner.runner }),
      }),
    ).dispatch(
      'merge',
      mergeCtx({ resolvedParams: { inputs: ['/abs/a.mp4', '/abs/b.mp4'], output: '/abs/o.mp4' } }),
    );
    expect(out.status).toBe('settled');
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]?.resolvedPaths).toEqual(['/abs/a.mp4', '/abs/b.mp4', '/abs/o.mp4']);
  });
});
