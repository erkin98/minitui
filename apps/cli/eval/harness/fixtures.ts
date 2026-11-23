import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RunRoot {
  readonly path: string; // mkdtemp(join(tmpdir(), 'minitui-run-')), then chmod 0700
  /** The case's directory, `<root>/c<nn>` by the case's 1-based position in the case file. */
  readonly dirFor: (position: number) => string;
  /** Empties the case's directory, then creates its files empty; returns the directory. */
  readonly refill: (position: number, files: readonly string[]) => Promise<string>;
  readonly dispose: () => Promise<void>;
}

// What is at the case's directory before refill touches it: nothing, or a real directory the run's uid
// owns. A symlink, a file or another user's directory is refused before anything is removed.
async function checkOwned(dir: string, uid: number): Promise<boolean> {
  const info = await lstat(dir).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (info === null) return false;
  if (info.isSymbolicLink()) throw new Error('refill refuses a case directory that is a symlink');
  if (!info.isDirectory())
    throw new Error('refill refuses a case directory that is not a directory');
  if (info.uid !== uid) throw new Error('refill refuses a case directory with another owner');
  return true;
}

/**
 * One private root per run. The trials of a case share its directory, so they run one at a time; the
 * directory is named by position and the root's prefix names no eval, so the working directory in the
 * prompt tells the model nothing about the case.
 */
export async function createRunRoot(opts?: { readonly uid?: number }): Promise<RunRoot> {
  // Where there is no getuid (Windows) the owner check cannot be made, so no run starts.
  if (process.getuid === undefined)
    throw new Error('the eval needs process.getuid to check owners');
  const uid = opts?.uid ?? process.getuid();
  const path = await mkdtemp(join(tmpdir(), 'minitui-run-'));
  await chmod(path, 0o700);
  const dirFor = (position: number): string => {
    if (!Number.isInteger(position) || position < 1) {
      throw new Error('a case position is a whole number from 1');
    }
    return join(path, `c${String(position).padStart(2, '0')}`);
  };
  return {
    path,
    dirFor,
    refill: async (position, files) => {
      const dir = dirFor(position);
      if (await checkOwned(dir, uid)) await rm(dir, { recursive: true });
      await mkdir(dir, { mode: 0o700 });
      for (const file of files) await writeFile(join(dir, file), '', { flag: 'wx' });
      return dir;
    },
    dispose: () => rm(path, { recursive: true, force: true }),
  };
}
