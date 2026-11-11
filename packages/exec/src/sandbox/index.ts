import { statSync, type Stats } from 'node:fs';
import type { ActionKind } from '@minitui/types';
import { SandboxUnavailableError } from '../errors.js';
import { rejectWriteRoot, type SandboxPolicy } from './config.js';
import {
  probeSandbox,
  loadSandboxRuntime,
  type SandboxProbe,
  type LoadSandboxRuntime,
} from './platform.js';
import { type SandboxViolation } from './violation.js';
import {
  initSession,
  releaseSession,
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
  /**
   * Release the one global session this handle started or joined (its bridge processes and
   * proxies), so the process can exit. Final: every later wrap on this handle rejects with
   * SandboxUnavailableError. Every call returns the first call's promise.
   */
  dispose(): Promise<void>;
}

/** Only render-local is gatable without a live sandbox (state-only, no side effects). */
function isGated(kind: ActionKind): boolean {
  return kind !== 'render-local';
}

/**
 * The write-root rule that needs the filesystem: every root exists now, as a directory or a regular
 * file (on Linux the runtime silently skips a root that does not exist). The lexical rules run in
 * buildSandboxConfig; this one runs before any session work, so a rejected policy never reaches
 * initialize.
 */
function assertWriteRootsExist(roots: readonly string[]): void {
  for (const root of roots) {
    const stats = statWriteRoot(root);
    if (!stats || !(stats.isDirectory() || stats.isFile())) {
      rejectWriteRoot(root, 'does not exist as a directory or a regular file');
    }
  }
}

/**
 * A missing root reads as undefined; any other stat error (an over-long name, a permission error)
 * is a policy rejection, never a raw error.
 */
function statWriteRoot(root: string): Stats | undefined {
  try {
    return statSync(root, { throwIfNoEntry: false });
  } catch {
    return rejectWriteRoot(root, 'cannot be checked');
  }
}

/**
 * Thin adapter over the single global sandbox runtime. FAIL-CLOSED: on an unloadable runtime, a
 * genuinely-unsupported OS, or fatal dependency errors, `active` is false and every gated path
 * throws — a gated command is NEVER returned unwrapped. Async because the probe dynamic-imports the
 * runtime (a static import could not fail closed). `loadRuntime` defaults to the memoized dynamic
 * import and is threaded into BOTH the probe and the one init call, so a unit test injects ONE real
 * fake loader to drive supported/fail-closed without replacing platform.js/manager.js. `platform`
 * defaults to the host's and goes to the probe; the session, wraps and cleanup use `probe.platform`.
 */
export async function createSandboxManager(
  loadRuntime: LoadSandboxRuntime = loadSandboxRuntime,
  platform: NodeJS.Platform = process.platform,
): Promise<SandboxManagerHandle> {
  const probe = await probeSandbox(loadRuntime, platform);
  const active = probe.supported;
  let sessionP: Promise<SandboxSession> | undefined;
  let resolvedSession: SandboxSession | undefined;
  let disposed = false;
  let disposal: Promise<void> | undefined;

  function refuse(what: string): never {
    throw new SandboxUnavailableError(
      `sandbox unavailable (${probe.errors.join('; ') || probe.platform}): refusing ${what}`,
    );
  }

  /** After dispose every wrap on this handle is refused, one already in flight included. */
  function assertLive(): void {
    if (disposed) {
      throw new SandboxUnavailableError('sandbox handle disposed: refusing gated command');
    }
  }

  /** Drop this handle's session memo, then release the session it started or joined, if any. */
  function release(): Promise<void> {
    const held = sessionP;
    sessionP = undefined;
    resolvedSession = undefined;
    return held ? releaseSession(held) : Promise.resolve();
  }

  /**
   * Resolve the one session, clearing the cache on a transient init REJECT so a later call retries
   * (a bare `??=` cache would pin the rejected promise forever). Records the resolved session so the
   * sync cleanup path can reach the runtime without awaiting. An init failure reaches the caller as
   * SandboxUnavailableError with the original error as its cause; one that already is a
   * SandboxUnavailableError is rethrown unchanged.
   */
  async function ensureSession(policy: SandboxPolicy): Promise<SandboxSession> {
    sessionP ??= initSession(policy, loadRuntime, probe.platform);
    let s: SandboxSession;
    try {
      s = await sessionP;
    } catch (err: unknown) {
      sessionP = undefined;
      if (err instanceof SandboxUnavailableError) throw err;
      throw new SandboxUnavailableError(
        'sandbox session failed to initialize: refusing gated command',
        { cause: err },
      );
    }
    assertLive(); // dispose ran while this wrap waited: record no session
    resolvedSession = s;
    return s;
  }

  return {
    probe,
    active,

    async wrapCommand(command, policy) {
      if (!active) refuse('gated command');
      assertLive();
      assertWriteRootsExist(policy.allowWrite);
      const session = await ensureSession(policy);
      const wrapped = await wrapCommandWith(session, command, policy, probe.platform);
      assertLive();
      return wrapped;
    },

    async wrapArgv(command, policy) {
      if (!active) refuse('gated command');
      assertLive();
      assertWriteRootsExist(policy.allowWrite);
      const session = await ensureSession(policy);
      const wrapped = await wrapArgvWith(session, command, policy, probe.platform);
      assertLive();
      return wrapped;
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

    dispose() {
      disposed = true;
      disposal ??= release();
      return disposal;
    },
  };
}
