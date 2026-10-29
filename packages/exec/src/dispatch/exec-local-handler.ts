import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { sanitize } from '../sanitize/index.js';
import { buildFfmpegRun, type FfmpegRun } from '../exec/ffmpeg.js';
import { readMergeSlots } from '../permission/resolve-request.js';
import type { LocalRunner } from '../exec/local-runner.js';
import type { SandboxManagerHandle } from '../sandbox/index.js';
import type { MergeSpec, RunnerEvent } from '../types.js';
import type { ExecEvent, Decision } from '@minitui/types';
import type { DispatchContext, ActionOutcome } from '@minitui/renderer-core';

/**
 * The window of stderr kept for the fault excerpt and the denial scan: a runaway child cannot balloon it.
 * Exec sanitises and windows the text; the model-facing observation router redacts the window and only
 * then cuts it to its own, smaller bound.
 */
const STDERR_TAIL_CAP = 16384;

/** Every fault text exec builds goes through here: escapes and controls removed, then the tail window. */
export function boundFaultText(text: string): string {
  return sanitize(text, { allow: 'none' }).slice(-STDERR_TAIL_CAP);
}

/** Stderr markers of a sandbox block (`bad system call` is the strerror text of a seccomp kill). */
const SANDBOX_DENIED_KEYWORDS = [
  'operation not permitted',
  'permission denied',
  'read-only file system',
  'seccomp',
  'landlock',
  'sandbox',
  'failed to write file',
  'bad system call',
] as const;

/**
 * Was this nonzero exit LIKELY a sandbox block rather than an ordinary failure? A stderr keyword scan plus
 * the two observable forms of a seccomp kill. When node's direct child is killed by SIGSYS, node reports
 * `signal: 'SIGSYS'`; but the sandbox wrap runs the workload under `[sh, -c, <wrapper>]`, so a workload
 * SIGSYS surfaces as the wrapper exiting 128+31 = 159 with no signal, the only form observable on Linux.
 * It fires even when the runtime's violation store is empty (a bare EPERM). A best-effort hint for the
 * escalation text, never an enforcement decision. `platform` is injectable so a test can drive the Linux
 * exit-159 branch on any host.
 */
export function isLikelySandboxDenied(
  input: {
    readonly stderr: string;
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  },
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (input.exitCode === 0 && input.signal === null) return false;
  const lower = input.stderr.toLowerCase();
  if (SANDBOX_DENIED_KEYWORDS.some((needle) => lower.includes(needle))) return true;
  return input.signal === 'SIGSYS' || (platform === 'linux' && input.exitCode === 128 + 31);
}

export interface ExecLocalDeps {
  readonly runner: LocalRunner;
  /** The sandbox handle. The runner wraps every spawn with it; the router calls its assertGatable. */
  readonly sandbox: SandboxManagerHandle;
  /** Path gate for the resolved list-file path, consulted BEFORE the file is written. */
  readonly checkPath: (path: string) => Promise<Decision>;
  /** Receives the canonical wire event (the runner's internal event, mapped at this boundary). */
  readonly onEvent: (ev: ExecEvent) => void;
  readonly signal: AbortSignal;
  /** Planning-only builder seam (default: the real one), so a test drives a real in-memory planner. */
  readonly buildFfmpegRun?: typeof buildFfmpegRun | undefined;
  /**
   * Creates the output file after consent and before the wrap, so the sandbox write root (the file, not
   * its directory) exists when the policy is checked. Default: exclusive create on the host.
   */
  readonly ensureOutputFile?: ((path: string) => Promise<void>) | undefined;
}

/**
 * Default output-file creation, on the host and outside the sandbox: create it EXCLUSIVELY (an existing
 * file, or a link at the path, is refused and never followed or truncated), then close. The merge then only
 * ever replaces the empty file made here. O_NOFOLLOW covers the last path component; the parent directory
 * is the sandbox's business.
 */
async function createOutputFile(path: string): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const handle = await open(path, flags, 0o600);
  await handle.close();
}

/** The run reads the same slots the consent text was built from (one reader, no coercion). */
function readMergeSpec(ctx: DispatchContext): MergeSpec {
  const mode = ctx.resolvedParams.mode === 'filter-concat' ? 'filter-concat' : 'concat-demux';
  return { ...readMergeSlots(ctx.resolvedParams), mode };
}

/** Maps the exec-internal event to the canonical wire event; `started` is not part of the wire shape. */
function toExecEvent(ev: RunnerEvent): ExecEvent | null {
  switch (ev.kind) {
    case 'stdout':
      return { kind: 'stdout', chunk: ev.text };
    case 'stderr':
      return { kind: 'stderr', chunk: ev.text };
    case 'progress':
      return { kind: 'progress', value: ev.progress, message: ev.message };
    case 'exit':
      return { kind: 'exit', code: ev.code ?? -1 };
    case 'started':
      return null;
  }
}

function failed(actionKey: string, exitCode: number, stderrExcerpt: string): ActionOutcome {
  return { status: 'failed', fault: { actionKey, exitCode, stderrExcerpt } };
}

/**
 * Everything that touches the disk before the run, in the order that keeps consent first: gate the
 * resolved list path, write the list only on an allow, then create the output. Returns the outcome that
 * ends the action, or null to go on. The abort is checked again after the gate, which may have waited on
 * a person: a cancelled action writes and creates nothing.
 */
async function prepareDisk(
  built: FfmpegRun,
  merge: MergeSpec,
  deps: ExecLocalDeps,
  cancelled: ActionOutcome,
): Promise<ActionOutcome | null> {
  if (built.listFile !== undefined) {
    // The lexical path gate is advisory defence in depth; the OS sandbox is the real containment. The
    // agent never names a raw write path: every path here is host-resolved.
    const verdict = await deps.checkPath(built.listFile);
    if (verdict.kind === 'deny') return { status: 'denied', reason: verdict.reason };
    // Fail-closed backstop: the composition root resolves consent inside checkPath, so a live 'ask'
    // should not arrive; if one does, nothing is written or run.
    if (verdict.kind === 'ask') {
      return { status: 'denied', reason: 'write path approval did not resolve' };
    }
    if (deps.signal.aborted) return cancelled;
    await built.writeList();
  }
  if (deps.signal.aborted) return cancelled;
  await (deps.ensureOutputFile ?? createOutputFile)(merge.output);
  return null;
}

/** Streams the run, forwards each mapped event to both sinks, and settles on the exit code. */
async function streamRun(
  ctx: DispatchContext,
  built: FfmpegRun,
  merge: MergeSpec,
  deps: ExecLocalDeps,
): Promise<ActionOutcome> {
  let exitCode: number | null = null; // a stream that never reports an exit is not a success
  let exitSignal: NodeJS.Signals | null = null;
  let stderrTail = '';
  // The runner awaits the sandbox wrap itself; a fail-closed wrap throws before any spawn and the router
  // maps that throw to a failed outcome.
  for await (const ev of deps.runner.run(built.run, deps.signal)) {
    const wire = toExecEvent(ev);
    if (wire) {
      deps.onEvent(wire);
      ctx.onEvent?.(wire);
    }
    if (ev.kind === 'stderr') stderrTail = (stderrTail + ev.text + '\n').slice(-STDERR_TAIL_CAP);
    if (ev.kind === 'exit') {
      exitCode = ev.code;
      exitSignal = ev.signal;
    }
  }
  if (exitCode === 0) return { status: 'settled', result: { output: merge.output } };
  // The marker sits at the END of the excerpt because the observation router keeps the tail when it cuts.
  const safeTail = boundFaultText(stderrTail);
  const denied = isLikelySandboxDenied({ stderr: stderrTail, exitCode, signal: exitSignal });
  return failed(
    ctx.actionName,
    exitCode ?? -1,
    denied ? `${safeTail}\n[sandbox-denied]` : safeTail,
  );
}

/**
 * The exec-local execute step, after the router's sandbox guard and permission gate: plan the run (no disk
 * write), gate and write the list, create the output, then stream the run the runner wraps. Fail-closed:
 * a denied or unresolved path, or an abort at any point before the run, writes and runs nothing.
 */
export async function handleExecLocal(
  ctx: DispatchContext,
  deps: ExecLocalDeps,
): Promise<ActionOutcome> {
  const cancelled = failed(ctx.actionName, -1, 'cancelled before start');
  if (deps.signal.aborted) return cancelled;
  const merge = readMergeSpec(ctx);
  const built = (deps.buildFfmpegRun ?? buildFfmpegRun)(merge, {});
  try {
    const stop = await prepareDisk(built, merge, deps, cancelled);
    return stop ?? (await streamRun(ctx, built, merge, deps));
  } finally {
    await built.cleanup();
  }
}
