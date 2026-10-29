import type { Decision, PermissionDescriptor, PermissionRequest } from '@minitui/types';
import type { DispatchContext } from '@minitui/renderer-core';
import type { SandboxManagerHandle } from '../../src/sandbox/index.js';
import type { ActionRouterDeps } from '../../src/dispatch/router.js';
import type { ExecLocalDeps } from '../../src/dispatch/exec-local-handler.js';
import type { LocalRunner } from '../../src/exec/local-runner.js';
import type { MergeSpec, RunnerEvent, RunSpec } from '../../src/types.js';

export const DEFAULT_DESCRIPTOR: PermissionDescriptor = {
  danger: true,
  resourceTemplate: 'ffmpeg ${/output}',
  summaryTemplate: 'Merge',
};

/** A merge action context with host-resolved params; `over` replaces any field. */
export function mergeCtx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    actionName: 'merge',
    actionKind: 'exec-local',
    permission: DEFAULT_DESCRIPTOR,
    resolvedParams: { inputs: ['/abs/a.mp4'], output: '/abs/out.mp4' },
    stateSnapshot: {},
    elementKey: 'btn-merge',
    ...over,
  };
}

/** A real-shaped sandbox handle (active by default); the wraps are pass-through. */
export function fakeSandbox(overrides?: Partial<SandboxManagerHandle>): SandboxManagerHandle {
  return {
    probe: { supported: true, errors: [], warnings: [], platform: process.platform },
    active: true,
    wrapCommand: async (cmd) => cmd,
    wrapArgv: async (command: string) => ({ argv: ['/bin/sh', '-c', command], env: {} }),
    violationsFor: async () => [],
    assertGatable: () => {},
    cleanup: () => {},
    dispose: async () => {},
    ...overrides,
  } satisfies SandboxManagerHandle;
}

/**
 * A real LocalRunner that records each invocation into `calls` and yields `stream()` (an empty stream by
 * default). A deny test asserts `calls.length === 0`; a run test reads the events it yielded.
 */
export function makeRunner(stream: () => AsyncGenerator<RunnerEvent> = async function* () {}): {
  runner: LocalRunner;
  calls: RunSpec[];
} {
  const calls: RunSpec[] = [];
  const runner: LocalRunner = {
    run(spec) {
      calls.push(spec);
      return stream();
    },
  };
  return { runner, calls };
}

/** A real engine.check that records each request into `calls` and returns `impl(req)` (default allow). */
export function makeEngine(
  impl: (req: PermissionRequest) => Promise<Decision> = async () => ({ kind: 'allow' }),
): { check: (req: PermissionRequest) => Promise<Decision>; calls: PermissionRequest[] } {
  const calls: PermissionRequest[] = [];
  return {
    check(req) {
      calls.push(req);
      return impl(req);
    },
    calls,
  };
}

/**
 * A planning-only builder injected through the handler's own seam: no module is replaced and no real file
 * is touched. It returns a genuine FfmpegRun whose closures record what the handler does with it.
 */
export function fakePlanner(): {
  build: NonNullable<ExecLocalDeps['buildFfmpegRun']>;
  builds: MergeSpec[];
  writes: string[];
  cleanups: string[];
} {
  const builds: MergeSpec[] = [];
  const writes: string[] = [];
  const cleanups: string[] = [];
  const listFile = '/tmp/minitui-concat-x/inputs.ffconcat';
  const build: NonNullable<ExecLocalDeps['buildFfmpegRun']> = (spec) => {
    builds.push(spec);
    return {
      run: {
        command: '/abs/ffmpeg',
        args: ['-y', spec.output],
        cwd: '/tmp',
        sandboxPolicy: { allowWrite: [spec.output], allowEgress: [] },
      },
      listFile,
      writeList: async () => {
        writes.push(listFile);
      },
      cleanup: async () => {
        cleanups.push(listFile);
      },
    };
  };
  return { build, builds, writes, cleanups };
}

export const allowPath = async (): Promise<Decision> => ({ kind: 'allow' });

/** The exec-local deps a router or handler test needs, every seam a real in-memory implementation. */
export function execLocalDeps(
  over: Partial<Omit<ExecLocalDeps, 'signal'>> = {},
): Omit<ExecLocalDeps, 'signal'> {
  return {
    runner: makeRunner().runner,
    sandbox: fakeSandbox(),
    checkPath: allowPath,
    onEvent: () => {},
    buildFfmpegRun: fakePlanner().build,
    ensureOutputFile: async () => {},
    ...over,
  };
}

/** A full host-resolved request, so an `ask` decision carries every field a real one does. */
export function fullRequest(
  descriptor: PermissionDescriptor = DEFAULT_DESCRIPTOR,
): PermissionRequest {
  return {
    id: 'request-1',
    descriptor,
    resolvedCommand: "'ffmpeg' '-i' '/abs/a.mp4' '/abs/out.mp4'",
    resolvedPaths: ['/abs/a.mp4', '/abs/out.mp4'],
  };
}

/** Router deps with a fixed host-resolved request; the caller supplies the engine. */
export function routerDeps(
  engine: ActionRouterDeps['engine'],
  over: Partial<Omit<ActionRouterDeps, 'engine'>> = {},
): ActionRouterDeps {
  return {
    engine,
    buildPermissionRequest: (c) => fullRequest(c.permission ?? DEFAULT_DESCRIPTOR),
    execLocal: execLocalDeps(),
    callback: { allowlist: new Set(['regenerate']), emit: () => {} },
    signal: new AbortController().signal,
    ...over,
  };
}
