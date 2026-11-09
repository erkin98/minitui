import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { videoMergeCatalog } from '@minitui/catalog';
import {
  buildPermissionRequest,
  checkHardFloor,
  checkPathRules,
  createActionRouter,
  createCapabilityProvider,
  createLocalRunner,
  createPermissionEngine,
  createSandboxManager,
  type PathRule,
  type PermissionEngine,
  type SandboxManagerHandle,
} from '@minitui/exec';
import type { ActionDispatcher } from '@minitui/renderer-core';
import { sanitize } from '@minitui/sanitizer';
import type { CapabilityProvider } from '@minitui/spec';
import type {
  ApprovalMode,
  Decision,
  DiagnosticsPort,
  ExecEvent,
  PermissionRequest,
} from '@minitui/types';

// The ffmpeg planner writes its resolved concat list under the temporary directory, after this gate
// has allowed it; every other path falls to the rules' default, which is to ask.
const PATH_RULES: readonly PathRule[] = [{ glob: `${tmpdir()}/**`, effect: 'allow' }];

/**
 * The write-path gate: a decision over the path rules. An ask goes to the permission engine, which blocks
 * until the person answers, so the exec handler only ever sees allow or deny. While the temporary directory
 * is allowed, no path the planner writes asks.
 */
export function makeCheckPathDecision(engine: {
  check(req: PermissionRequest): Promise<Decision>;
}): (path: string) => Promise<Decision> {
  return async (path) => {
    const verdict = checkPathRules(path, PATH_RULES);
    if (verdict === 'allow') return { kind: 'allow' };
    if (verdict === 'deny') return { kind: 'deny', reason: `write path denied: ${path}` };
    const decision = await engine.check({
      id: randomUUID(),
      descriptor: {
        danger: false,
        resourceTemplate: 'write ${/path}',
        summaryTemplate: 'write a file to ${/path}',
      },
      resolvedCommand: '',
      resolvedPaths: [path],
    });
    return decision.kind === 'ask'
      ? { kind: 'deny', reason: 'write path approval did not resolve' }
      : decision;
  };
}

export interface ExecStack {
  readonly permission: PermissionEngine;
  readonly sandbox: SandboxManagerHandle;
  readonly sandboxNotice: string | undefined;
  readonly dispatcher: ActionDispatcher;
  readonly capabilities: CapabilityProvider;
  /** Aborts every exec the router has in flight. The router holds one signal for the whole run. */
  readonly abort: () => void;
}

const NOTICE_CAP = 500;

/**
 * The execution side: the permission engine, the sandbox, the runner and the router that ties them. The
 * sandbox is awaited once, here, before the runner is built, because it fails closed: an inactive handle is
 * kept and reported, and every gated action then refuses.
 */
export async function buildExecStack(args: {
  readonly mode: ApprovalMode;
  readonly diagnostics: DiagnosticsPort;
  readonly onExecEvent: (ev: ExecEvent) => void;
  readonly createSandbox?: (() => Promise<SandboxManagerHandle>) | undefined;
  readonly capabilities?: CapabilityProvider | undefined;
}): Promise<ExecStack> {
  const permission = await createPermissionEngine({
    mode: args.mode,
    diagnostics: args.diagnostics,
  });
  const sandbox = await (args.createSandbox ?? createSandboxManager)();
  const sandboxNotice = sandbox.active
    ? undefined
    : sanitize(
        `gated actions are unavailable: ${sandbox.probe.errors.join('; ') || 'the sandbox is not available'}`,
        { allow: 'none' },
      ).slice(0, NOTICE_CAP);
  const runner = createLocalRunner({ sandbox, checkHardFloor, diagnostics: args.diagnostics });
  const controller = new AbortController();
  const dispatcher = createActionRouter({
    engine: permission,
    execLocal: {
      runner,
      sandbox,
      checkPath: makeCheckPathDecision(permission),
      onEvent: args.onExecEvent,
    },
    callback: {
      allowlist: new Set(videoMergeCatalog.actionNames),
      // No action of the catalog is an agent callback, so this is not reached; the change that adds one
      // wires it to the agent loop's observation channel.
      emit: () => {},
    },
    buildPermissionRequest,
    signal: controller.signal,
  });
  return {
    permission,
    sandbox,
    sandboxNotice,
    dispatcher,
    capabilities: args.capabilities ?? createCapabilityProvider(),
    abort: () => controller.abort(),
  };
}
