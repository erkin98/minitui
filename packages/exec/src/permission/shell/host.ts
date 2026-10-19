import { homedir } from 'node:os';
import { posix } from 'node:path';

// What the floor and the extractor need to know about the machine a command will run on. Both take it
// as an optional trailing parameter whose default is read at CALL time, so a test injects a host and
// the product reads the real one.
export interface Host {
  readonly home: string;
  readonly platform: string;
}

export const currentHost = (): Host => ({ home: homedir(), platform: process.platform });

// Case folding for a file system that matches names without regard to case. Lower-casing alone leaves
// characters such as U+017F (long s) apart from the ASCII letter they are the same name as; going
// through upper case first joins them.
export const foldCase = (text: string): string => text.toUpperCase().toLowerCase();

// File systems that match names without regard to case.
export const foldsCase = (platform: string): boolean =>
  platform === 'darwin' || platform === 'win32';

// The directories a recursive delete must never reach: the home directory, its parent (unless that is
// the root), and the two literal parents of home directories, so a host whose home is `/root` still
// floors `/home`. Returned as written; a caller folds case when the host does.
export function homeRoots(home: string, platform: string): ReadonlySet<string> {
  const roots = new Set<string>(['/home', '/Users']);
  const trimmed = home.replace(/\/+$/, '');
  if (trimmed !== '') {
    roots.add(trimmed);
    // a Windows home is not a POSIX path and no Windows grammar is modelled: no parent is derived
    const parent = platform === 'win32' ? '' : posix.dirname(trimmed);
    if (parent.startsWith('/') && parent !== '/') roots.add(parent);
  }
  return roots;
}
