import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostCatalogDeps, videoMergeCatalog } from '@minitui/catalog';
import {
  buildPermissionRequest,
  createActionRouter,
  createPermissionEngine,
  type LocalRunner,
  type PermissionEngine,
  type RunSpec,
  type SandboxManagerHandle,
} from '@minitui/exec';
import type {
  ActionDispatcher,
  ActionOutcome,
  RenderHandle,
  RendererPort,
} from '@minitui/renderer-core';
import { createInkBinding } from '@minitui/renderer-ink';
import { createAppHost, type HostSession } from '@minitui/runtime-host';
import type { MiniAppSpec } from '@minitui/spec';
import { MERGE_SPEC } from '@minitui/test-kit';
import { createDataStore } from '@minitui/transport';
import type { ApprovalMode } from '@minitui/types';

/** A renderer that draws nothing and keeps the dispatcher the host hands it, so a row presses as a widget would. */
export function capturingRenderer(): {
  renderer: RendererPort;
  dispatcher: () => ActionDispatcher;
} {
  let captured: ActionDispatcher | undefined;
  const handle: RenderHandle = {
    update: () => undefined,
    applyStatePatch: () => undefined,
    onAction: () => () => undefined,
    unmount: () => undefined,
  };
  return {
    renderer: {
      mount: (args) => {
        captured = args.dispatcher;
        return Promise.resolve(handle);
      },
    },
    dispatcher: () => {
      if (captured === undefined) throw new Error('the host never mounted the renderer');
      return captured;
    },
  };
}

/** An active sandbox handle whose wraps pass the command through, for rows that never reach a spawn. */
export function passThroughSandbox(): SandboxManagerHandle {
  return {
    probe: { supported: true, errors: [], warnings: [], platform: process.platform },
    active: true,
    wrapCommand: (command) => Promise.resolve(command),
    wrapArgv: (command) => Promise.resolve({ argv: ['/bin/sh', '-c', command], env: {} }),
    violationsFor: () => Promise.resolve([]),
    assertGatable: () => undefined,
    cleanup: () => undefined,
    dispose: () => Promise.resolve(),
  };
}

/** A real temporary directory by its real path, removed after the row. */
export async function inTempDir(row: (dir: string) => Promise<void>): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'minitui-integration-')));
  try {
    await row(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The canonical merge app with its state replaced. */
export function mergeAppWithState(state: Record<string, unknown>): MiniAppSpec {
  return { ...MERGE_SPEC, state: { ...MERGE_SPEC.state, ...state } };
}

export interface HostOverExec {
  readonly engine: PermissionEngine;
  readonly session: HostSession;
  /** Every run the runner was handed; a refused merge leaves it empty. */
  readonly runs: readonly RunSpec[];
  /** Raises the merge as the button would, with the parameters a renderer resolved itself. */
  pressMerge(rendererParams: Record<string, unknown>): Promise<ActionOutcome>;
}

/**
 * The runtime host over the real exec router, the real request builder and the real permission engine.
 * The runner records and never spawns; planning or creating the output throws, so a row that was meant
 * to be refused cannot pass by running.
 */
export async function hostOverExec(args: {
  readonly spec: MiniAppSpec;
  readonly mode: ApprovalMode;
  readonly sandbox: SandboxManagerHandle;
}): Promise<HostOverExec> {
  const engine = await createPermissionEngine({ mode: args.mode });
  const runs: RunSpec[] = [];
  const runner: LocalRunner = {
    run: (spec) => {
      runs.push(spec);
      return (async function* () {})();
    },
  };
  const exec = createActionRouter({
    engine,
    execLocal: {
      runner,
      sandbox: args.sandbox,
      checkPath: () => Promise.resolve({ kind: 'allow' }),
      onEvent: () => undefined,
      buildFfmpegRun: () => {
        throw new Error('the merge was planned');
      },
      ensureOutputFile: () => Promise.reject(new Error('the merge output was created')),
    },
    callback: { allowlist: new Set(), emit: () => undefined },
    buildPermissionRequest,
    signal: new AbortController().signal,
  });
  const { renderer, dispatcher } = capturingRenderer();
  const host = createAppHost({
    renderer,
    binding: createInkBinding(videoMergeCatalog),
    dispatcher: exec,
    store: createDataStore(),
    ...hostCatalogDeps(videoMergeCatalog),
  });
  const session = await host.mount(args.spec);
  return {
    engine,
    session,
    runs,
    pressMerge: (rendererParams) =>
      dispatcher().dispatch('merge', {
        actionName: 'merge',
        actionKind: 'exec-local',
        permission: videoMergeCatalog.permissionOf('merge'),
        resolvedParams: rendererParams,
        stateSnapshot: session.state.getState(),
        elementKey: 'merge',
      }),
  };
}
