import { realpathSync, accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export type ResolveExecutable = (name: string) => string | undefined;

// resolve a command token to the absolute realpath that WOULD be spawned, so a grant can be bound to
// a stable executable identity. which-semantics: a path-qualified token resolves directly; a bare
// name walks $PATH like `which`. realpathSync collapses symlinks so a swapped link is caught by the
// identity compare. Returns undefined when nothing resolves — the grant then stays name-only and the
// exec-time re-gate + the OS sandbox are the backstops (fail-safe, never fail-open).
// ponytail: POSIX which. Windows PATHEXT expansion is not modeled — a bare `foo` won't find `foo.exe`,
// so this returns undefined there and the grant keeps name-only match; inject a PATHEXT-aware resolver
// via EngineOptions.resolveExecutable if Windows identity-binding is later required.
export const defaultResolveExecutable: ResolveExecutable = (name) => {
  if (name === '') return undefined;
  // path-qualified — resolve directly, no PATH walk
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    try {
      return realpathSync(resolve(name));
    } catch {
      return undefined;
    }
  }
  // bare name — walk $PATH for the first executable match
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      /* not here — keep walking */
    }
  }
  return undefined;
};
