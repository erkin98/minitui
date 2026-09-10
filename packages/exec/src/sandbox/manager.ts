// The wrap-don't-own core over the single process-global sandbox runtime. No top-level runtime
// import — all access flows through the dynamic loader (a missing dep must fail closed, not crash
// module load); the loaded runtime is kept ON the session so wraps and cleanup use the exact
// object the loader returned (injected-loader-safe), never a re-load.
import { SandboxUnavailableError } from '../errors.js';
import { buildSandboxConfig, type SandboxPolicy } from './config.js';
import {
  loadSandboxRuntime,
  type LoadSandboxRuntime,
  type SandboxRuntimeLike,
} from './platform.js';
import { parseViolationLine, type SandboxViolation } from './violation.js';

export interface WrappedArgv {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

/**
 * The one global runtime session. Carries the initialized egress allowlist (egress is filtered
 * from the single init-time config, never per wrap — a per-call divergence must fail closed) and
 * the loaded runtime (so wraps + cleanup run against the same injected object).
 */
export interface SandboxSession {
  readonly initialized: true;
  readonly allowEgress: readonly string[];
  readonly runtime: SandboxRuntimeLike;
}

let currentSession: SandboxSession | undefined;
let initPromise: Promise<SandboxSession> | undefined;

/**
 * Initialize the single global sandbox exactly once per process. This first slice never opens
 * egress interactively, so the ask callback denies every connection — a second belt next to the
 * config's strict allowlist. The log monitor is the only producer of the violation store and only
 * runs on macOS, so it is enabled solely on darwin (elsewhere the store stays empty by construction).
 */
export function initSession(
  policy: SandboxPolicy,
  loadRuntime: LoadSandboxRuntime = loadSandboxRuntime,
  platform: NodeJS.Platform = process.platform,
): Promise<SandboxSession> {
  if (currentSession) return Promise.resolve(currentSession);
  initPromise ??= (async () => {
    const runtime = await loadRuntime();
    await runtime.SandboxManager.initialize(
      buildSandboxConfig(policy),
      () => Promise.resolve(false),
      platform === 'darwin',
    );
    currentSession = { initialized: true, allowEgress: [...policy.allowEgress], runtime };
    return currentSession;
  })().catch((err: unknown) => {
    initPromise = undefined; // transient init failure: clear so a later call retries (still rejects now)
    throw err;
  });
  return initPromise;
}

/**
 * Fail closed when the per-call egress allowlist differs from the one the session was initialized
 * with. The underlying sandbox filters egress from the single global config set at init time, not
 * from a per-wrap override, so a divergent per-call allowlist would silently NOT take effect —
 * refusing is the only safe answer. Set comparison is order-insensitive.
 */
function assertEgressMatchesSession(session: SandboxSession, policy: SandboxPolicy): void {
  const want = new Set(policy.allowEgress);
  const have = new Set(session.allowEgress);
  if (want.size !== have.size || [...want].some((host) => !have.has(host))) {
    throw new SandboxUnavailableError('egress allowlist differs from the initialized session');
  }
}

/**
 * @deprecated Prefer `wrapArgvWith` on every platform: the argv path keeps command bytes off the
 * host shell everywhere and is the only path that carries the child-env hardening. Retained solely
 * for a caller embedding a sandboxed shell string into an existing shell invocation.
 *
 * macOS/Linux shell-string wrap. The underlying string wrap throws on Windows by design (the
 * shell:false boundary keeps command bytes off the host shell) — refuse there with the typed error,
 * pointing callers at the argv path.
 */
export async function wrapCommandWith(
  session: SandboxSession,
  command: string,
  policy: SandboxPolicy,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (platform === 'win32') {
    throw new SandboxUnavailableError(
      'wrapCommand is a posix shell-string wrap; on win32 use wrapArgv (shell:false spawn)',
    );
  }
  assertEgressMatchesSession(session, policy);
  return session.runtime.SandboxManager.wrapWithSandbox(
    command,
    '/bin/sh',
    buildSandboxConfig(policy),
  );
}

/**
 * Loader-injection env vars a child must never inherit (LD_PRELOAD/LD_* and DYLD_*). The argv wrap
 * hands back the live process env BY REFERENCE, so without a fresh copy a host loader var would
 * ride straight into the sandboxed child. Returns a FRESH env (never mutates the source) and strips
 * both prefixes on every platform.
 */
function hardenChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('LD_') || key.startsWith('DYLD_')) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

/**
 * UNIFORM spawn path on ALL platforms (the canonical argv wrap): host-gated command string in,
 * {argv, env} out. Windows sandboxes via its network-filter path; macOS/Linux return
 * [binShell, '-c', wrapped]. Spawn the result with {shell:false, env}. binShell is undefined on
 * win32 (the underlying wrap selects the Windows default there) and '/bin/sh' on posix. The
 * returned env is hardened (loader-injection vars stripped) because the wrap returns the live
 * process env by reference.
 */
export async function wrapArgvWith(
  session: SandboxSession,
  command: string,
  policy: SandboxPolicy,
  platform: NodeJS.Platform = process.platform,
): Promise<WrappedArgv> {
  assertEgressMatchesSession(session, policy);
  const binShell = platform === 'win32' ? undefined : '/bin/sh';
  const { argv, env } = await session.runtime.SandboxManager.wrapWithSandboxArgv(
    command,
    binShell,
    buildSandboxConfig(policy),
  );
  return { argv, env: hardenChildEnv(env) };
}

/**
 * Host-resolved violations the sandbox recorded for a wrapped command, read from the runtime's own
 * violation store and mapped through the structured parser — no stderr re-parsing. macOS only: the
 * store's sole producer is the macOS log monitor, so this returns [] by construction on Linux/Windows.
 */
export function violationsForCommand(
  session: SandboxSession,
  command: string,
): readonly SandboxViolation[] {
  const events =
    session.runtime.SandboxManager.getSandboxViolationStore().getViolationsForCommand(command);
  return Object.freeze(events.map((event) => parseViolationLine(event.line)));
}

/** Linux post-command mount cleanup routed through the session's own runtime; no-op elsewhere. */
export function cleanupAfterCommand(
  session: SandboxSession,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'linux') return;
  session.runtime.SandboxManager.cleanupAfterCommand?.();
}

/** Test seam: reset the module-level singleton so each case starts from a clean session. */
export function resetSessionForTest(): void {
  currentSession = undefined;
  initPromise = undefined;
}
