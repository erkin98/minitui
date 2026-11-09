import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The built bin, run as a person runs it. It needs the build (`pnpm build`): the pre-push hook builds
// first, and a run without the build fails on the first row with that message.
const at = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const BIN = at('../../apps/cli/bin/minitui.mjs');
const DIST = at('../../apps/cli/dist/cli.js');
const KEY = 'sk-ant-smoke-0123456789abcdefghijklmnop';
const home = mkdtempSync(join(tmpdir(), 'minitui-smoke-'));

// The environment is spelled out, so a key or a setting of the machine running the test never reaches it.
function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: home, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('the built bin', () => {
  it('exists: build first with pnpm build', () => {
    expect(existsSync(DIST)).toBe(true);
  });

  it('--version prints a version and exits 0', () => {
    const result = run(['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.stderr).toBe('');
  });

  it('--help prints the usage and exits 0', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('usage: minitui');
  });

  it('prints no escape sequence on a dumb terminal', () => {
    const result = run(['--version'], { TERM: 'dumb' });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(String.fromCharCode(27));
  });

  it('an unknown flag exits 2 and names the flag', () => {
    const result = run(['--accesible', 'merge']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--accesible');
    expect(result.stderr).toContain('usage: minitui');
  });

  it('no intent exits 2', () => {
    expect(run([]).status).toBe(2);
  });

  it('a missing API key exits 1 with one clear line', () => {
    const result = run(['merge']);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('minitui: ANTHROPIC_API_KEY is not set');
    expect(result.stdout).toBe('');
  });

  it('without a terminal it exits 1 and the key appears nowhere in the output', () => {
    const result = run(['merge'], { ANTHROPIC_API_KEY: KEY });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires an interactive terminal');
    expect(result.stdout + result.stderr).not.toContain(KEY);
  });
});

describe('the bin shim', () => {
  it('settles the colour environment before it loads the program', () => {
    const source = readFileSync(BIN, 'utf8');
    const settled = source.indexOf("process.env.FORCE_COLOR = '0'");
    const loaded = source.indexOf("import('@minitui/cli')");
    expect(settled).toBeGreaterThan(-1);
    expect(loaded).toBeGreaterThan(-1);
    expect(settled).toBeLessThan(loaded);
  });
});
