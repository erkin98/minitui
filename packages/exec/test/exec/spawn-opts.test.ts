import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSpawnOptions, scrubEnv, assertValidCwd } from '../../src/exec/spawn-opts.js';

describe('spawn-opts', () => {
  it('scrubEnv drops injection vectors and returns a new object', () => {
    const input = {
      PATH: '/usr/bin',
      LD_PRELOAD: '/evil.so',
      DYLD_INSERT_LIBRARIES: '/x',
      HOME: '/home/u',
    };
    const out = scrubEnv(input);
    expect(out).not.toBe(input);
    expect(out.LD_PRELOAD).toBeUndefined();
    expect(out.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/u');
    expect(input.LD_PRELOAD).toBe('/evil.so'); // input not mutated
  });

  it('buildSpawnOptions pins windowsHide, shell:false, own-process-group detach and a piped stdio', () => {
    const dir = mkdtempSync(join(tmpdir(), 'minitui-spawn-'));
    try {
      const opts = buildSpawnOptions({ cwd: dir, env: { PATH: '/usr/bin', LD_PRELOAD: '/evil' } });
      expect(opts.windowsHide).toBe(true);
      expect(opts.shell).toBe(false);
      expect(opts.detached).toBe(true); // own group -> abort kills the TREE
      expect(opts.cwd).toBe(dir);
      expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
      expect(opts.env.LD_PRELOAD).toBeUndefined();
      // without an env the host's is taken, through the same scrub
      expect(buildSpawnOptions({ cwd: dir }).env).toEqual(scrubEnv(process.env));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('assertValidCwd throws on a non-absolute, missing or non-directory cwd', () => {
    expect(() => assertValidCwd('relative/dir')).toThrow(/absolute/i);
    expect(() => assertValidCwd('/no/such/minitui/dir/xyz')).toThrow(/exist/i);
    const dir = mkdtempSync(join(tmpdir(), 'minitui-cwd-'));
    try {
      const file = join(dir, 'a-file');
      writeFileSync(file, 'x');
      expect(() => assertValidCwd(file)).toThrow(/not a directory/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
