import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createRunRoot } from '../../eval/harness/fixtures.js';

const uid = (): number => {
  if (process.getuid === undefined) throw new Error('these rows run where process.getuid exists');
  return process.getuid();
};

describe('the run root', () => {
  it('is a private directory under the temporary directory whose name says nothing of the case', async () => {
    const root = await createRunRoot();
    try {
      const info = await stat(root.path);
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o777).toBe(0o700);
      expect(dirname(root.path)).toBe(tmpdir());
      expect(basename(root.path)).toMatch(/^minitui-run-/);
    } finally {
      await root.dispose();
    }
  });

  it("names a case's directory c<nn> by its position, never by its id", async () => {
    const root = await createRunRoot();
    try {
      expect(root.dirFor(1)).toBe(join(root.path, 'c01'));
      expect(root.dirFor(9)).toBe(join(root.path, 'c09'));
      expect(root.dirFor(42)).toBe(join(root.path, 'c42'));
      expect(() => root.dirFor(0)).toThrow(/position/);
      expect(() => root.dirFor(1.5)).toThrow(/position/);
    } finally {
      await root.dispose();
    }
  });

  it('refill empties the directory, then creates the files empty, and returns the directory', async () => {
    const root = await createRunRoot();
    try {
      const first = await root.refill(3, ['a.mp4', 'b.mp4']);
      expect(first).toBe(root.dirFor(3));
      // what a trial left behind: an output, a changed input, a subdirectory
      await writeFile(join(first, 'out.mp4'), 'merged');
      await writeFile(join(first, 'a.mp4'), 'changed');
      await mkdir(join(first, 'left'));
      await writeFile(join(first, 'left', 'x'), 'x');

      const again = await root.refill(3, ['a.mp4', 'b.mp4']);
      expect(again).toBe(first);
      expect((await readdir(again)).sort()).toEqual(['a.mp4', 'b.mp4']);
      expect(await readFile(join(again, 'a.mp4'), 'utf8')).toBe('');
      expect(await readFile(join(again, 'b.mp4'), 'utf8')).toBe('');
      expect((await stat(again)).mode & 0o777).toBe(0o700);
    } finally {
      await root.dispose();
    }
  });

  it('dispose removes the whole root', async () => {
    const root = await createRunRoot();
    await root.refill(1, ['a.mp4']);
    await root.dispose();
    await expect(stat(root.path)).rejects.toThrow(/ENOENT/);
  });
});

// The fixture row of the "never" table: a directory that is a symlink or another user's is never emptied.
describe('refill never empties a directory it does not own', () => {
  it('control: a plain directory owned by the given uid is emptied', async () => {
    const root = await createRunRoot({ uid: uid() });
    try {
      await mkdir(root.dirFor(1));
      await writeFile(join(root.dirFor(1), 'stale.txt'), 'stale');
      await root.refill(1, ['a.mp4']);
      expect(await readdir(root.dirFor(1))).toEqual(['a.mp4']);
    } finally {
      await root.dispose();
    }
  });

  it('refuses the same directory when another uid is the one it may empty, and leaves it as it was', async () => {
    const root = await createRunRoot({ uid: uid() + 1 });
    try {
      await mkdir(root.dirFor(1));
      await writeFile(join(root.dirFor(1), 'stale.txt'), 'stale');
      await expect(root.refill(1, ['a.mp4'])).rejects.toThrow(/owner/);
      expect(await readdir(root.dirFor(1))).toEqual(['stale.txt']);
      expect(await readFile(join(root.dirFor(1), 'stale.txt'), 'utf8')).toBe('stale');
    } finally {
      await root.dispose();
    }
  });

  it('refuses a symlinked directory and leaves its target untouched', async () => {
    const root = await createRunRoot({ uid: uid() });
    const target = await mkdtemp(join(tmpdir(), 'minitui-fixture-target-'));
    try {
      await writeFile(join(target, 'keep.txt'), 'keep');
      await symlink(target, root.dirFor(1));
      await expect(root.refill(1, ['a.mp4'])).rejects.toThrow(/symlink/);
      expect(await readdir(target)).toEqual(['keep.txt']);
      expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('keep');
    } finally {
      await root.dispose();
      await rm(target, { recursive: true, force: true });
    }
  });

  it('refuses a plain file where the directory should be', async () => {
    const root = await createRunRoot({ uid: uid() });
    try {
      await writeFile(root.dirFor(1), 'a file');
      await expect(root.refill(1, ['a.mp4'])).rejects.toThrow(/not a directory/);
      expect(await readFile(root.dirFor(1), 'utf8')).toBe('a file');
    } finally {
      await root.dispose();
    }
  });
});
