// No top-level VALUE import of '@anthropic-ai/sandbox-runtime' — the dynamic import below IS the
// fail-closed loading seam. A static import would crash the whole package when the runtime is
// absent, which is the opposite of failing closed. The type-only import is erased at emit and
// carries no runtime dependency.
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { applyAsrtVendorEnv } from './vendor-env.js';

type SandboxRuntimeModule = typeof import('@anthropic-ai/sandbox-runtime');

/**
 * Minimal structural slice of the sandbox runtime module — ONLY the SandboxManager members this
 * slice calls. The real memoized loader returns the full module (structurally assignable here); a
 * unit test injects a REAL object implementing just these members, driving every branch through the
 * production seam instead of replacing the module.
 */
export interface SandboxRuntimeLike {
  readonly SandboxManager: {
    isSupportedPlatform(): boolean;
    checkDependencies(ripgrep?: { command: string; args?: string[] }): {
      errors: string[];
      warnings: string[];
    };
    initialize(
      config: SandboxRuntimeConfig,
      askCallback?: (c: { host: string; port: number | undefined }) => Promise<boolean>,
      enableLogMonitor?: boolean,
    ): Promise<void>;
    wrapWithSandbox(
      command: string,
      binShell?: string,
      customConfig?: Partial<SandboxRuntimeConfig>,
      abortSignal?: AbortSignal,
    ): Promise<string>;
    wrapWithSandboxArgv(
      command: string,
      binShell?: string,
      customConfig?: Partial<SandboxRuntimeConfig>,
      abortSignal?: AbortSignal,
    ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
    getSandboxViolationStore(): {
      getViolationsForCommand(command: string): ReadonlyArray<{ line: string; timestamp?: Date }>;
    };
    // Linux post-command mount cleanup, carried on the session's loaded runtime so an injected fake
    // can observe it through the production seam. Optional here; the real runtime always provides it.
    cleanupAfterCommand?(): void;
  };
}

/** The injectable loader seam: the memoized dynamic import in production, a REAL fake in unit tests. */
export type LoadSandboxRuntime = () => Promise<SandboxRuntimeLike>;

let loaded: SandboxRuntimeModule | undefined;

/**
 * Memoized dynamic import — a missing or broken runtime rejects HERE, inside a catchable promise,
 * never at module load. This is the DEFAULT LoadSandboxRuntime seam: the full module's
 * SandboxManager is structurally assignable to SandboxRuntimeLike, so it satisfies the injectable
 * loader type without a cast.
 */
export async function loadSandboxRuntime(): Promise<SandboxRuntimeModule> {
  if (!loaded) loaded = await import('@anthropic-ai/sandbox-runtime');
  return loaded;
}

export interface SandboxProbe {
  /** module loadable AND isSupportedPlatform() AND no fatal dependency errors */
  readonly supported: boolean;
  /** load failure / fatal dependency errors — the sandbox genuinely cannot run here */
  readonly errors: readonly string[];
  /**
   * Non-fatal dependency warnings (degraded but usable). This probe runs the dependency check
   * BEFORE the session initializes, so it cannot yet see a staged seccomp helper path (that path is
   * only known at config/initialize time). On a staged-vendor Linux install a stale "seccomp helper
   * missing" warning can therefore appear here even though the helper resolves at wrap time; a
   * diagnostics surface that shows warnings should re-run the dependency check after the session
   * initializes.
   */
  readonly warnings: readonly string[];
  readonly platform: NodeJS.Platform;
}

/** Stringify a thrown value without tripping the base-to-string check on an object. */
function formatUnknown(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return `non-error thrown (${typeof err})`;
}

/**
 * Adapts the runtime's checkDependencies() + isSupportedPlatform() into one probe. Does NOT
 * reimplement the OS/bubblewrap probe. Fail-closed: a failed module load or any throw →
 * supported:false; never throws itself. isSupportedPlatform() is true on macOS/Windows/Linux —
 * false only for WSL1/unknown. On Linux, ripgrep (rg) on PATH is a fatal runtime prerequisite
 * (alongside bwrap and socat): a missing rg surfaces here as a dependency error and folds to
 * supported:false — the fail-closed-correct direction for a binary or curl-piped install that did
 * not stage it. `loadRuntime` defaults to the memoized dynamic import; a unit test injects a REAL
 * fake loader (throwing / unsupported / fatal-deps) to drive the fail-closed branches through the
 * production seam instead of replacing the module.
 */
export async function probeSandbox(
  loadRuntime: LoadSandboxRuntime = loadSandboxRuntime,
): Promise<SandboxProbe> {
  const platform = process.platform;
  // Honor a staged runtime vendor dir BEFORE the dynamic import, so the win32 dependency check sees
  // SRT_WIN_PATH. No-op on posix (the runtime exposes no seccomp env hook — the Linux consumer is
  // the seccomp.applyPath config field emitted at initialize).
  applyAsrtVendorEnv(platform);
  let SandboxManager: SandboxRuntimeLike['SandboxManager'];
  try {
    const runtime = await loadRuntime();
    SandboxManager = runtime.SandboxManager;
  } catch (err) {
    return {
      supported: false,
      errors: Object.freeze([`sandbox runtime failed to load: ${formatUnknown(err)}`]),
      warnings: Object.freeze([]),
      platform,
    };
  }
  try {
    const supportedPlatform = SandboxManager.isSupportedPlatform();
    const { errors, warnings } = SandboxManager.checkDependencies();
    return {
      supported: supportedPlatform && errors.length === 0,
      errors: Object.freeze([...errors]),
      warnings: Object.freeze([...warnings]),
      platform,
    };
  } catch (err) {
    return {
      supported: false,
      errors: Object.freeze([`sandbox dependency probe failed: ${formatUnknown(err)}`]),
      warnings: Object.freeze([]),
      platform,
    };
  }
}
