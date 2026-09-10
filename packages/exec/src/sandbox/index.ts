import type { ActionKind } from '@minitui/types';
import { SandboxUnavailableError } from '../errors.js';
import { type SandboxPolicy } from './config.js';
import {
  probeSandbox,
  loadSandboxRuntime,
  type SandboxProbe,
  type LoadSandboxRuntime,
} from './platform.js';
import { type SandboxViolation } from './violation.js';
import {
  initSession,
  wrapCommandWith,
  wrapArgvWith,
  violationsForCommand,
  cleanupAfterCommand,
  type SandboxSession,
  type WrappedArgv,
} from './manager.js';

export type { SandboxProbe, SandboxPolicy, WrappedArgv, SandboxViolation };

export interface SandboxManagerHandle {
  readonly probe: SandboxProbe;
  readonly active: boolean;
  wrapCommand(command: string, policy: SandboxPolicy): Promise<string>;
  wrapArgv(command: string, policy: SandboxPolicy): Promise<WrappedArgv>;
  violationsFor(command: string): Promise<readonly SandboxViolation[]>;
  assertGatable(kind: ActionKind): void;
  cleanup(): void;
}

/** Only render-local is gatable without a live sandbox (state-only, no side effects). */
function isGated(kind: ActionKind): boolean {
  return kind !== 'render-local';
}

/**
 * Thin adapter over the single global sandbox runtime. FAIL-CLOSED: on an unloadable runtime, a
 * genuinely-unsupported OS, or fatal dependency errors, `active` is false and every gated path
 * throws — a gated command is NEVER returned unwrapped. Async because the probe dynamic-imports the
 * runtime (a static import could not fail closed). `loadRuntime` defaults to the memoized dynamic
 * import and is threaded into BOTH the probe and the one init call, so a unit test injects ONE real
 * fake loader to drive supported/fail-closed without replacing platform.js/manager.js.
 */
export async function createSandboxManager(
  loadRuntime: LoadSandboxRuntime = loadSandboxRuntime,
): Promise<SandboxManagerHandle> {
  const probe = await probeSandbox(loadRuntime);
  const active = probe.supported;
  let sessionP: Promise<SandboxSession> | undefined;
  let resolvedSession: SandboxSession | undefined;

  function refuse(what: string): never {
    throw new SandboxUnavailableError(
      `sandbox unavailable (${probe.errors.join('; ') || probe.platform}): refusing ${what}`,
    );
  }

  /**
   * Resolve the one session, clearing the cache on a transient init REJECT so a later call retries
   * (a bare `??=` cache would pin the rejected promise forever). Records the resolved session so the
   * sync cleanup path can reach the runtime without awaiting.
   */
  async function ensureSession(policy: SandboxPolicy): Promise<SandboxSession> {
    sessionP ??= initSession(policy, loadRuntime, probe.platform);
    try {
      const s = await sessionP;
      resolvedSession = s;
      return s;
    } catch (err: unknown) {
      sessionP = undefined;
      throw err;
    }
  }

  return {
    probe,
    active,

    async wrapCommand(command, policy) {
      if (!active) refuse('gated command');
      return wrapCommandWith(await ensureSession(policy), command, policy, probe.platform);
    },

    async wrapArgv(command, policy) {
      if (!active) refuse('gated command');
      return wrapArgvWith(await ensureSession(policy), command, policy, probe.platform);
    },

    async violationsFor(command) {
      if (!active || !sessionP) return Object.freeze([]);
      return violationsForCommand(await sessionP, command);
    },

    assertGatable(kind) {
      if (isGated(kind) && !active) refuse(`action kind '${kind}'`);
    },

    cleanup() {
      if (active && resolvedSession) cleanupAfterCommand(resolvedSession, probe.platform);
    },
  };
}
