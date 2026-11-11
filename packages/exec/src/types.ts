import type { SpawnFn } from './exec/spawn-opts.js';
import type { SandboxManagerHandle, SandboxPolicy } from './sandbox/index.js';
import type { ParsedCommand, DiagnosticsPort } from '@minitui/types';

/**
 * Events streamed by local-runner.run() — exec-INTERNAL (the rich form: started/signal/nullable code).
 * stdout/stderr text is ALREADY sanitized. exec-local-handler maps this to the canonical wire
 * type `ExecEvent` (owned by @minitui/types) at the port boundary — never yields RunnerEvent to consumers.
 */
export type RunnerEvent =
  | { readonly kind: 'started'; readonly argv: readonly string[]; readonly cwd: string }
  | { readonly kind: 'stdout'; readonly text: string }
  | { readonly kind: 'stderr'; readonly text: string }
  | { readonly kind: 'progress'; readonly progress: number; readonly message: string }
  | { readonly kind: 'exit'; readonly code: number | null; readonly signal: NodeJS.Signals | null };

/** A single resolved process to run. command is an ABSOLUTE path; args are pre-resolved. */
export interface RunSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /**
   * The write/egress allowlist the runner hands to sandbox.wrapArgv for THIS run.
   * Required — every runner spawn is sandbox-wrapped; there is no policy-less path.
   */
  readonly sandboxPolicy: SandboxPolicy;
  /** Parses one stderr/stdout line into a progress event; null if the line is not progress. */
  readonly progressParser?:
    | ((line: string) => { progress: number; message: string } | null)
    | undefined;
}

/** Declarative merge request. inputs/output are ABSOLUTE, host-resolved paths (never agent templates). */
export interface MergeSpec {
  readonly inputs: readonly string[];
  readonly output: string;
  readonly codec?: string | undefined;
  readonly mode: 'concat-demux' | 'filter-concat';
}

export interface RunnerDeps {
  readonly sandbox: SandboxManagerHandle;
  /**
   * The non-overridable hard-floor (same exported signature). RE-RUN at exec time on the
   * RESOLVED absolute argv[0] immediately before spawn (the exec-time re-gate: policy is re-checked with
   * the resolved path, since a static text parse can only see the script text, not the final resolved
   * executable path). A cheap TOCTOU backstop BEHIND the
   * OS sandbox (the real enforcement), NOT a substitute for it. Synchronous — no parser init at spawn.
   */
  readonly checkHardFloor: (
    parsed: ParsedCommand,
    paths?: readonly string[],
  ) => { blocked: boolean; reason?: string };
  /** Injectable for tests; defaults to node:child_process spawn. */
  readonly spawn?: SpawnFn | undefined;
  /**
   * The optional diagnostics sink injected by the composition root. The runner warns
   * through it when the child is killed by SIGSYS (a likely OS-sandbox/seccomp denial) — the
   * runner-side sandbox swallow-site. No-op default when absent (noopDiagnostics upstream).
   */
  readonly diagnostics?: DiagnosticsPort | undefined;
}
