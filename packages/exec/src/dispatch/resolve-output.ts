import { realpath, stat } from 'node:fs/promises';
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

/**
 * Takes the real path of the merge output's directory, so the path shown for approval, the path the
 * engine's checks see, the file the host creates and the path ffmpeg is told to write are one path. The
 * spelling the caller gave is checked first (the request builder's path rules, then the hard floor), so
 * resolving a link can add a refusal and never remove one. The last component is never followed: the
 * exclusive create still refuses a link or an existing file there. Inputs are read inside the sandbox
 * and are left as given.
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
  // The engine's floor also runs checks that read the output as an argument of the ffmpeg command
  // (a device path), so the typed spelling is floored as that command, not as a bare path.
  const floor = checkHardFloor(
    {
      raw: '',
      roots: [{ name: 'ffmpeg', argv: ['ffmpeg', output] }],
      hasSubstitution: false,
      parseError: false,
    },
    [output],
    deps.host,
  );
  if (floor.blocked) throw new FfmpegSpecError(floor.reason ?? 'blocked by hard floor');

  let real: string;
  try {
    real = await realpath(dirname(output));
    if (!(await stat(real)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new FfmpegSpecError(UNRESOLVED);
  }
  const resolved = join(real, basename(output));
  return resolved === output
    ? ctx
    : { ...ctx, resolvedParams: { ...ctx.resolvedParams, output: resolved } };
}
