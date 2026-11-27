import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { DispatchContext } from '@minitui/renderer-core';
import type { PermissionRequest } from '@minitui/types';
import { FfmpegSpecError } from '../errors.js';
import { checkHardFloor } from '../permission/hard-floor.js';
import type { Host } from '../permission/shell/host.js';

export interface ResolveOutputDeps {
  /** The router's own injected builder: the one implementation of the path rules. */
  readonly buildPermissionRequest: (ctx: DispatchContext) => PermissionRequest;
  /** The machine the floor reads; tests only. Default: the current machine, as the engine reads it. */
  readonly host?: Host | undefined;
}

// Node's own messages name the path, so every failure to resolve becomes this one phrase.
const UNRESOLVED = 'the output directory cannot be resolved';
const EXISTS = 'the output file already exists';

/**
 * The engine's floor also runs checks that read the output as an argument of the ffmpeg command (a
 * device path), so a spelling of the output is floored as that command, not as a bare path.
 */
function assertFloorAllows(output: string, host: Host | undefined): void {
  const floor = checkHardFloor(
    {
      raw: '',
      roots: [{ name: 'ffmpeg', argv: ['ffmpeg', output] }],
      hasSubstitution: false,
      parseError: false,
    },
    [output],
    host,
  );
  if (floor.blocked) throw new FfmpegSpecError(floor.reason ?? 'blocked by hard floor');
}

/** Refuses any entry at the output name (a file, a directory, a link, a dangling link), never following it. */
async function assertNoEntry(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new FfmpegSpecError(UNRESOLVED);
  }
  throw new FfmpegSpecError(EXISTS);
}

/**
 * Takes the real path of the merge output's directory, so the path shown for approval, the path the
 * engine's checks see, the file the host creates and the path ffmpeg is told to write are one path. The
 * spelling the caller gave is checked first (the request builder's path rules, then the hard floor), so
 * resolving a link can add a refusal and never remove one; the resolved spelling is floored too when it
 * differs. An entry already at the output name is refused here, before the prompt, and the last component
 * is never followed. The handler's exclusive, no-follow create stays the control for a file that appears
 * after this check. Inputs are read inside the sandbox and are left as given.
 */
export async function resolveOutputParent(
  ctx: DispatchContext,
  deps: ResolveOutputDeps,
): Promise<DispatchContext> {
  const output = ctx.resolvedParams.output;
  if (ctx.actionKind !== 'exec-local' || typeof output !== 'string' || !isAbsolute(output)) {
    return ctx; // the request builder keeps its own phrases for a relative or non-text output
  }
  deps.buildPermissionRequest(ctx); // throws on a path the rules refuse; the request itself is not used
  assertFloorAllows(output, deps.host);

  let real: string;
  try {
    real = await realpath(dirname(output));
    if (!(await stat(real)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new FfmpegSpecError(UNRESOLVED);
  }
  const resolved = join(real, basename(output));
  // The floor sees the real path before anything is learnt about the name, so the existence answer is
  // never given for a location the floor protects.
  if (resolved !== output) assertFloorAllows(resolved, deps.host);
  await assertNoEntry(resolved);
  return resolved === output
    ? ctx
    : { ...ctx, resolvedParams: { ...ctx.resolvedParams, output: resolved } };
}
