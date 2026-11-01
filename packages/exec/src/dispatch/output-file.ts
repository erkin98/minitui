import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';

/**
 * Ends the use of an output file the host made. It is called once, after the run that the file was made
 * for has ended. `keep` is true only for a run that settled: the file is left in place. For any other end
 * the file is removed, but only if the path still names the file that was made.
 */
export type OutputFinish = (keep: boolean) => Promise<void>;

const CREATE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/**
 * Default output-file creation, on the host and outside the sandbox: create it EXCLUSIVELY (an existing
 * file, or a link at the path, is refused and never followed or truncated), at mode 0600. The merge then
 * only ever replaces the empty file made here. O_NOFOLLOW covers the last path component; the parent
 * directory is the sandbox's business.
 *
 * The file stays open until the finisher runs. While the handle is open, no other file on the same file
 * system can be given this file's inode number, so the number identifies the file; once a file is gone
 * and a new one is made at the same path, a file system may hand the new one the same number at once.
 * Descriptors opened by Node are close-on-exec, so a child process does not inherit this one.
 */
export async function createOutputFile(path: string): Promise<OutputFinish> {
  const handle = await open(path, CREATE_FLAGS, 0o600);
  let made;
  try {
    made = await handle.stat({ bigint: true });
  } catch (err) {
    // The file exists and cannot be identified, so it is left, like a removal that failed.
    await handle.close().catch(() => undefined);
    throw err;
  }
  return async (keep) => {
    try {
      if (!keep) {
        // Compare while the handle is still open; closing first would reopen the inode-reuse window.
        const now = await lstat(path, { bigint: true });
        if (now.isFile() && now.dev === made.dev && now.ino === made.ino) await unlink(path);
      }
    } catch {
      // The path is gone or cannot be removed; the outcome of the run stands, and a retry will see the file.
    } finally {
      await handle.close().catch(() => undefined);
    }
  };
}
