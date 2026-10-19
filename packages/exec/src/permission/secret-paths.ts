import { isAbsolute, join } from 'node:path';

// The one list of locations a gated command must never touch. The hard floor reads all of it; the
// sandbox builds its read and write denies from the home lists, the sandbox-only list and storeDir().
// Package-internal: no barrel re-exports it, and it imports nothing from persist or sandbox.

// Directories under the home directory, written relative to it. `.config/gh` is a nested entry.
export const HOME_SECRET_DIRS: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.azure',
  '.config/gh',
];

// Single files under the home directory.
export const HOME_SECRET_FILES: readonly string[] = ['.netrc', '.npmrc', '.git-credentials'];

// File names that are secret wherever they sit: private keys, `.env` and `.env.*`, `credentials`,
// `*.pem`. Each pattern is tested against one path component. Floor only.
export const SECRET_BASENAME_PATTERNS: readonly RegExp[] = [
  /^id_rsa$/,
  /^id_ed25519$/,
  /^\.env(\..*)?$/,
  /^credentials$/,
  /\.pem$/,
];

// Denied for read inside the sandbox but deliberately not floored: the floor has no broad directory
// pattern, so `ls ~/.config` stays an ordinary command.
export const SANDBOX_ONLY_READ_DENY: readonly string[] = ['.config'];

// Where the program keeps its own state: `$XDG_DATA_HOME/minitui` when that variable is an absolute
// path, `<home>/.local/share/minitui` otherwise. A relative or empty value is ignored.
export function storeDir(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const xdg = env.XDG_DATA_HOME;
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, '.local', 'share');
  return join(base, 'minitui');
}
