import { describe, it, expect } from 'vitest';
import {
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createOutputFile } from '../../src/dispatch/output-file.js';
import { inTempDir } from './doubles.js';

/** The link targets of this process's open descriptors (Linux). */
function fdTargets(): Map<string, string> {
  const targets = new Map<string, string>();
  for (const fd of readdirSync('/proc/self/fd')) {
    try {
      targets.set(fd, readlinkSync(`/proc/self/fd/${fd}`));
    } catch {
      // the descriptor used to list the directory is already closed
    }
  }
  return targets;
}

/** The descriptor whose link names exactly this path, if any. */
function fdNaming(path: string): string | undefined {
  for (const [fd, target] of fdTargets()) if (target === path) return fd;
  return undefined;
}

describe('createOutputFile', () => {
  it('refuses a path that already exists and leaves it untouched', async () => {
    await inTempDir(async (dir) => {
      const output = join(dir, 'out.mp4');
      writeFileSync(output, 'PRECIOUS');
      await expect(createOutputFile(output)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(readFileSync(output, 'utf8')).toBe('PRECIOUS');
    });
  });

  it('creates an empty private file, and finish(true) leaves it in place', async () => {
    await inTempDir(async (dir) => {
      const output = join(dir, 'out.mp4');
      const finish = await createOutputFile(output);
      expect(statSync(output).size).toBe(0);
      expect(statSync(output).mode & 0o777).toBe(0o600);
      await finish(true);
      expect(existsSync(output)).toBe(true);
    });
  });

  it('finish(false) on a path that has vanished resolves and does not throw', async () => {
    await inTempDir(async (dir) => {
      const output = join(dir, 'out.mp4');
      const finish = await createOutputFile(output);
      rmSync(output);
      await expect(finish(false)).resolves.toBeUndefined();
      expect(existsSync(output)).toBe(false);
    });
  });

  it.skipIf(process.platform !== 'linux')(
    'holds the file open without letting a child inherit it, and closes it on every branch',
    async () => {
      const cloexec = 0o2000000;
      for (const branch of ['keep', 'discard', 'vanished'] as const) {
        await inTempDir(async (dir) => {
          const output = join(dir, `${branch}.mp4`);
          const finish = await createOutputFile(output);
          const fd = fdNaming(output);
          expect(fd).toBeDefined();
          const info = readFileSync(`/proc/self/fdinfo/${String(fd)}`, 'utf8');
          const flags = parseInt(/flags:\s*(\d+)/.exec(info)?.[1] ?? '0', 8);
          expect(flags & cloexec).toBe(cloexec);
          if (branch === 'vanished') rmSync(output);
          await finish(branch === 'keep');
          // by target, not by count: other descriptors may open and close in the worker
          const left = [...fdTargets().values()].filter((target) => target.startsWith(output));
          expect(left).toEqual([]);
        });
      }
    },
  );
});
