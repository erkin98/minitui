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
export const HOME_SECRET_FILES: readonly string[] = [
  '.netrc',
  '.npmrc',
  '.git-credentials',
  '.pgpass',
  '.pypirc',
  '.vault-token',
];

// File names that are secret wherever they sit, matched against a whole path component or the part of
// one after an `=`: private keys and `credentials`. Floor only.
export const SECRET_FILE_NAMES: readonly string[] = [
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'credentials',
];

// `.env` and every `.env.<suffix>` name, wherever it sits. Floor only.
export const ENV_FILE_NAME = '.env';

// Endings that make a file secret wherever it sits: certificates and private keys. A document that
// merely ends in `.key` (a presentation file, an HLS key file) is floored too; recorded cost. Floor only.
export const SECRET_SUFFIXES: readonly string[] = ['.pem', '.p12', '.pfx', '.key'];

// Whether one path component names a secret file: the component, or the part of it after any `=`
// (`dd if=id_rsa`), is a listed name or a `.env` name, or the component ends in a listed ending. Each
// part is compared in place and an ending is tested once per component, so the work is linear in the
// component however many `=` it holds.
export function isSecretFileName(component: string): boolean {
  if (SECRET_SUFFIXES.some((suffix) => component.endsWith(suffix))) return true;
  for (let start = 0; ; ) {
    const rest = component.length - start;
    if (
      SECRET_FILE_NAMES.some((name) => rest === name.length && component.startsWith(name, start))
    ) {
      return true;
    }
    if (
      component.startsWith(ENV_FILE_NAME, start) &&
      (rest === ENV_FILE_NAME.length || component[start + ENV_FILE_NAME.length] === '.')
    ) {
      return true;
    }
    const eq = component.indexOf('=', start);
    if (eq === -1) return false;
    start = eq + 1;
  }
}

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
