import type { ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { CwdError } from '../errors.js';
import { hardenChildEnv } from '../sandbox/manager.js';

/**
 * The ONE spawn signature the runner/prober call — narrower than node's full overload set, so a
 * real injected test double satisfies it with no `as unknown` cast (node's own `spawn`, with all
 * its overloads, is still assignable to this). Returns a plain ChildProcess; the piped stdout/stderr
 * are read via optional chaining at the call sites.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * Returns a NEW env object built from the sandbox seam's allowlist (`hardenChildEnv`: PATH with its
 * absolute entries only, HOME, USER, LOGNAME, SHELL, LANG, TZ, TMPDIR, TERM and every LC_* name), so no
 * host token and no loader or shell-startup variable reaches a child. The ONE list is owned by the
 * sandbox module and exported from `sandbox/manager.ts` (not from the package barrel), so the runner's
 * scrub and the wrap's cannot drift. Never mutates input.
 */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return hardenChildEnv(env);
}

/** Throws CwdError unless cwd is an absolute path to an existing directory. */
export function assertValidCwd(cwd: string): void {
  if (!isAbsolute(cwd)) throw new CwdError(`cwd must be absolute: ${cwd}`);
  let st;
  try {
    st = statSync(cwd);
  } catch {
    throw new CwdError(`cwd does not exist: ${cwd}`);
  }
  if (!st.isDirectory()) throw new CwdError(`cwd is not a directory: ${cwd}`);
}

export interface SpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly windowsHide: true;
  readonly shell: false;
  /** POSIX: child leads its OWN process group so abort can kill the whole tree via kill(-pid). */
  readonly detached: boolean;
  /** A MUTABLE tuple (not `readonly`) so node's SpawnOptions.stdio (a mutable StdioOptions) accepts it. */
  readonly stdio: ['ignore', 'pipe', 'pipe'];
}

/** The ONE place spawn options are built: windowsHide, shell:false, group-detach, scrubbed env, validated cwd. */
export function buildSpawnOptions(args: { cwd: string; env?: NodeJS.ProcessEnv }): SpawnOptions {
  assertValidCwd(args.cwd);
  return {
    cwd: args.cwd,
    env: scrubEnv(args.env ?? process.env),
    windowsHide: true,
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
}
