// The wrap-don't-own core over the single process-global sandbox runtime. No top-level runtime
// import — all access flows through the dynamic loader (a missing dep must fail closed, not crash
// module load); the loaded runtime is kept ON the session so wraps and cleanup use the exact
// object the loader returned (injected-loader-safe), never a re-load.
import { delimiter, isAbsolute } from 'node:path';
import { SandboxUnavailableError } from '../errors.js';
import { buildSandboxConfig, type SandboxPolicy } from './config.js';
import {
  loadSandboxRuntime,
  WIN32_GATED_REFUSAL,
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
/** The last release, settled either way: a new session waits for it (see releaseSession). */
let pendingRelease: Promise<void> | undefined;

/**
 * Initialize the single global sandbox exactly once per process. This version never opens
 * egress interactively, so the ask callback denies every connection — a second belt next to the
 * config's strict allowlist. The log monitor is the only producer of the violation store and only
 * runs on macOS, so it is enabled solely on darwin (elsewhere the store stays empty by construction).
 * A new session first waits for a release still running.
 */
export function initSession(
  policy: SandboxPolicy,
  loadRuntime: LoadSandboxRuntime = loadSandboxRuntime,
  platform: NodeJS.Platform = process.platform,
): Promise<SandboxSession> {
  if (currentSession) return Promise.resolve(currentSession);
  initPromise ??= (async () => {
    await pendingRelease;
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
 * Release the session a handle holds through that session's own runtime, never a fresh load. It
 * first waits for a pending initialise (a failed one is swallowed and nothing is reset): the
 * initialise writes the module memo when it resolves, so a memo cleared before then would hand the
 * next handle a reset runtime. The memo is cleared only if it still holds this session, in the same
 * step that starts the reset. `initSession` waits for this release because the runtime's
 * `initialize` returns early while its own initialisation is set, and its `reset` clears that only
 * after the bridge processes are killed. A rejected reset reaches the caller; the wait only orders.
 */
export async function releaseSession(held: Promise<SandboxSession>): Promise<void> {
  const session = await held.catch(() => undefined);
  if (!session) return;
  if (currentSession === session) {
    currentSession = undefined;
    initPromise = undefined;
  }
  const reset = session.runtime.SandboxManager.reset();
  pendingRelease = reset.then(
    () => undefined,
    () => undefined,
  );
  return reset;
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
 * @deprecated Prefer `wrapArgvWith`: the argv path keeps command bytes off the host shell and is
 * the only path that carries the child-env allowlist. Retained solely for a caller embedding a
 * sandboxed shell string into an existing shell invocation.
 *
 * macOS/Linux shell-string wrap. On win32 both wraps refuse with the typed error before the runtime
 * is reached: gated commands are parsed as bash, and the runtime would run them under cmd.exe.
 */
export async function wrapCommandWith(
  session: SandboxSession,
  command: string,
  policy: SandboxPolicy,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (platform === 'win32') throw new SandboxUnavailableError(WIN32_GATED_REFUSAL);
  assertEgressMatchesSession(session, policy);
  const wrapped = await session.runtime.SandboxManager.wrapWithSandbox(
    command,
    '/bin/sh',
    buildSandboxConfig(policy),
  );
  if (wrapped === command) refuseUnwrapped();
  return wrapped;
}

/** A runtime that hands the command back unwrapped must never get it run: fail closed. */
function refuseUnwrapped(): never {
  throw new SandboxUnavailableError(
    'sandbox runtime returned the command unwrapped: refusing gated command',
  );
}

/** The variables a sandboxed child inherits, besides every `LC_*` locale variable. */
const CHILD_ENV_NAMES: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TZ',
  'TMPDIR',
  'TERM',
]);

/**
 * The environment a sandboxed child receives, built from an allowlist: no host token (the model API
 * key included) and no loader or shell-startup variable reaches it. PATH keeps only its absolute
 * entries, in order: a relative or empty entry resolves against the child's working directory, which
 * can be a write root. The argv wrap hands back the live process env BY REFERENCE, so this returns a
 * FRESH object and never mutates the source.
 */
export function hardenChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!CHILD_ENV_NAMES.has(name) && !name.startsWith('LC_')) continue;
    kept[name] = name === 'PATH' && value !== undefined ? absolutePathEntries(value) : value;
  }
  return kept;
}

function absolutePathEntries(path: string): string {
  return path
    .split(delimiter)
    .filter((entry) => isAbsolute(entry))
    .join(delimiter);
}

/**
 * The canonical argv wrap on macOS and Linux: host-gated command string in, {argv, env} out, argv
 * being ['/bin/sh', '-c', wrapped]. Spawn the result with {shell:false, env}. On win32 it refuses
 * before the runtime is reached: gated commands are parsed as bash, and the runtime would run them
 * under cmd.exe. The returned env is built from an allowlist (hardenChildEnv) because the wrap
 * returns the live process env by reference.
 */
export async function wrapArgvWith(
  session: SandboxSession,
  command: string,
  policy: SandboxPolicy,
  platform: NodeJS.Platform = process.platform,
): Promise<WrappedArgv> {
  if (platform === 'win32') throw new SandboxUnavailableError(WIN32_GATED_REFUSAL);
  assertEgressMatchesSession(session, policy);
  const { argv, env } = await session.runtime.SandboxManager.wrapWithSandboxArgv(
    command,
    '/bin/sh',
    buildSandboxConfig(policy),
  );
  if (argv.length === 0 || argv[2] === command) refuseUnwrapped();
  return { argv, env: hardenChildEnv(env) };
}

/**
 * Host-resolved violations the sandbox recorded for a wrapped command, read from the runtime's own
 * violation store and mapped through the structured parser — no stderr re-parsing. macOS only: the
 * store's sole producer is the macOS log monitor, so this returns [] by construction on Linux.
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
  pendingRelease = undefined;
}
