import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultResolveExecutable } from '../../src/permission/resolve-exec.js';

let dir: string;
let savedPath: string | undefined;

beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), 'minitui-resolve-'))); // realpath: /tmp is itself a symlink on macOS
  savedPath = process.env.PATH;
});
afterEach(async () => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  await rm(dir, { recursive: true, force: true });
});

// POSIX which-semantics + realpath + X_OK. Windows executable resolution (PATHEXT) is not modeled by
// the default — on Windows it returns undefined and the grant safely falls back to name-only match, so
// these POSIX-shaped assertions are skipped there rather than flaking a Windows CI lane (lesson #40).
describe.skipIf(process.platform === 'win32')(
  'defaultResolveExecutable — which-semantics + realpath',
  () => {
    it('resolves a bare name via $PATH to the realpath (symlink collapsed)', async () => {
      const real = join(dir, 'ffmpeg-real');
      await writeFile(real, '#!/bin/sh\n', { mode: 0o755 });
      await symlink(real, join(dir, 'ffmpeg')); // the `ffmpeg` on PATH is a symlink to ffmpeg-real
      process.env.PATH = dir;
      expect(defaultResolveExecutable('ffmpeg')).toBe(real); // realpath collapses the link → stable identity
    });
    it('resolves a path-qualified token directly, without walking $PATH', async () => {
      const bin = join(dir, 'tool');
      await writeFile(bin, '#!/bin/sh\n', { mode: 0o755 });
      process.env.PATH = ''; // empty PATH proves it did not depend on the walk
      expect(defaultResolveExecutable(bin)).toBe(bin);
    });
    it('returns undefined for an unresolvable name (fail-safe → name-only match)', () => {
      process.env.PATH = dir;
      expect(defaultResolveExecutable('no-such-binary-anywhere')).toBeUndefined();
    });
  },
);
