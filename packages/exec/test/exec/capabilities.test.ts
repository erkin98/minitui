import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createCapabilityProvider, resolveBin } from '../../src/exec/capabilities.js';
import { BinNotFoundError } from '../../src/errors.js';
import type { SpawnFn } from '../../src/exec/spawn-opts.js';
import { storeDir } from '../../src/permission/secret-paths.js';
import type { Host } from '../../src/permission/shell/host.js';

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

describe('createCapabilityProvider: statFile answers missing for a path the hard floor protects', () => {
  const MISSING = { exists: false, readable: false, isFile: false };

  interface Home {
    readonly root: string;
    readonly home: string;
    readonly host: Host;
    readonly cap: ReturnType<typeof createCapabilityProvider>;
  }

  // A temporary home under its REAL path (on macOS the temporary directory sits behind a link), so a
  // typed path and its real path agree unless a row plants a link itself.
  async function inHome(row: (h: Home) => Promise<void>): Promise<void> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'minitui-statfloor-')));
    const home = join(root, 'home');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    const host: Host = { home, platform: process.platform, store: storeDir({}, home) };
    try {
      await row({ root, home, host, cap: createCapabilityProvider({ host }) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('a real private key under the home answers missing', () =>
    inHome(async ({ home, cap }) => {
      writeFileSync(join(home, '.ssh', 'id_rsa'), 'x');
      expect(await cap.statFile(join(home, '.ssh', 'id_rsa'))).toEqual(MISSING);
    }));

  it('an ordinary file in the same home exists', () =>
    inHome(async ({ home, cap }) => {
      writeFileSync(join(home, 'notes.txt'), 'x');
      expect(await cap.statFile(join(home, 'notes.txt'))).toEqual({
        exists: true,
        readable: true,
        isFile: true,
      });
    }));

  it('a relative spelling of a real file answers missing', () =>
    inHome(async ({ root, cap }) => {
      writeFileSync(join(root, 'rel.txt'), 'x');
      const rel = relative(process.cwd(), join(root, 'rel.txt'));
      expect(isAbsolute(rel)).toBe(false);
      expect(await cap.statFile(rel)).toEqual(MISSING);
    }));

  it('a link from an ordinary name into the key directory answers missing (the real path is floored)', () =>
    inHome(async ({ root, home, cap }) => {
      writeFileSync(join(home, '.ssh', 'notes.txt'), 'x');
      symlinkSync(join(home, '.ssh'), join(root, 'ok'));
      expect(await cap.statFile(join(root, 'ok', 'notes.txt'))).toEqual(MISSING);
    }));

  it('the home directory itself still exists', () =>
    inHome(async ({ home, cap }) => {
      expect(await cap.statFile(home)).toMatchObject({ exists: true, isFile: false });
    }));

  it("a file in the injected host's store answers missing, and exists through a provider on another host", () =>
    inHome(async ({ root, host, cap }) => {
      mkdirSync(host.store, { recursive: true });
      const state = join(host.store, 'state.json');
      writeFileSync(state, '{}');
      expect(await cap.statFile(state)).toEqual(MISSING);
      const otherHome = join(root, 'other');
      const other = createCapabilityProvider({
        host: { home: otherHome, platform: process.platform, store: storeDir({}, otherHome) },
      });
      expect(await other.statFile(state)).toMatchObject({ exists: true, isFile: true });
    }));

  it('a protected typed name over an ordinary real directory answers missing (the typed path is floored)', () =>
    inHome(async ({ root, cap }) => {
      mkdirSync(join(root, 'plain'));
      writeFileSync(join(root, 'plain', 'notes.txt'), 'x');
      symlinkSync(join(root, 'plain'), join(root, '.ssh'));
      expect(await cap.statFile(join(root, '.ssh', 'notes.txt'))).toEqual(MISSING);
    }));

  it("a link into the injected host's store answers missing (the real path is floored with that host)", () =>
    inHome(async ({ root, host, cap }) => {
      mkdirSync(host.store, { recursive: true });
      writeFileSync(join(host.store, 'state.json'), '{}');
      symlinkSync(host.store, join(root, 'ok2'));
      expect(await cap.statFile(join(root, 'ok2', 'state.json'))).toEqual(MISSING);
    }));
});
