import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createCapabilityProvider, resolveBin } from '../../src/exec/capabilities.js';
import { BinNotFoundError } from '../../src/errors.js';
import type { SpawnFn } from '../../src/exec/spawn-opts.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, '..', 'fixtures', 'fake-bins', 'ffmpeg-fake.mjs');

// Plant a fake `ffmpeg` in a fresh temporary directory so resolveBin resolves hermetically — the test must
// not depend on a machine-installed ffmpeg. Executable unless a mode says otherwise; the row removes it.
function plantFfmpeg(prefix: string, mode = 0o755): string {
  const binDir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(binDir, 'ffmpeg'), '#!/bin/sh\n', { mode });
  return binDir;
}

// Inject a spawn that always runs the fake ffmpeg script regardless of the resolved bin.
// ESM NodeNext: import spawn at module top, never bare require(). The cast
// narrows node's overload set to the one signature the prober uses — not an `as never`.
const fakeSpawn = ((_cmd: string, args: readonly string[], opts: object) =>
  spawn(process.execPath, [FAKE, ...args], opts)) as SpawnFn;

describe('createCapabilityProvider', () => {
  it('parses and caches encoders / codecs / filters', async () => {
    const binDir = plantFfmpeg('minitui-capbin-');
    try {
      const cap = createCapabilityProvider({ spawn: fakeSpawn, env: { PATH: binDir } });
      const encoders = await cap.listEncoders();
      expect(encoders).toContain('libx264');
      expect(encoders).toContain('aac');
      const codecs = await cap.listCodecs();
      expect(codecs).toContain('h264');
      const filters = await cap.listFilters();
      expect(filters).toContain('concat');
      // second call hits the cache, not a second spawn (same identity)
      expect(await cap.listEncoders()).toBe(encoders);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('statFile reports a real readable file', async () => {
    const dir = plantFfmpeg('minitui-stat-');
    try {
      const cap = createCapabilityProvider({ spawn: fakeSpawn, env: { PATH: dir } });
      const f = join(dir, 'a.mp4');
      writeFileSync(f, 'x');
      const st = await cap.statFile(f);
      expect(st).toEqual({ exists: true, readable: true, isFile: true });
      const missing = await cap.statFile(join(dir, 'nope.mp4'));
      expect(missing.exists).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveBin skips a non-executable plant (which semantics: exec bit required)', () => {
    const binDir = plantFfmpeg('minitui-plant-', 0o644); // no exec bit
    try {
      expect(() => resolveBin('ffmpeg', { PATH: binDir })).toThrow(BinNotFoundError);
      expect(() => resolveBin('ffmpeg', {})).toThrow(BinNotFoundError); // no PATH at all
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('resolveBin ignores a relative PATH entry: a planted ffmpeg there loses to the one in a later absolute entry', () => {
    const planted = plantFfmpeg('minitui-relbin-');
    const trusted = plantFfmpeg('minitui-absbin-');
    try {
      // the planted directory spelled relative to the working directory, first in PATH; nothing is
      // created under the repository and the working directory is not changed
      const rel = relative(process.cwd(), planted);
      expect(isAbsolute(rel)).toBe(false);
      expect(resolveBin('ffmpeg', { PATH: [rel, trusted].join(delimiter) })).toBe(
        join(trusted, 'ffmpeg'),
      );
      // an absolute name is taken as given, PATH unread
      expect(resolveBin(join(trusted, 'ffmpeg'), { PATH: rel })).toBe(join(trusted, 'ffmpeg'));
    } finally {
      rmSync(planted, { recursive: true, force: true });
      rmSync(trusted, { recursive: true, force: true });
    }
  });
});
