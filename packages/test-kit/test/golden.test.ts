import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { matchGolden } from '../src/golden/golden.js';

let path: string;
let dir: URL;
beforeEach(() => {
  path = mkdtempSync(join(tmpdir(), 'golden-'));
  dir = pathToFileURL(`${path}/`);
  delete process.env.UPDATE_GOLDEN;
});
afterEach(() => {
  rmSync(path, { recursive: true, force: true });
  delete process.env.UPDATE_GOLDEN;
});

const seed = (name: string, text: string): void => writeFileSync(join(path, `${name}.ansi`), text);

describe('matchGolden (callers assert on .pass)', () => {
  it('fails on a missing golden and writes nothing', () => {
    const r = matchGolden('frame-a', 'Count: 0', { dir });
    expect(r.pass).toBe(false);
    expect(r.diff).toContain('missing golden');
    expect(existsSync(join(path, 'frame-a.ansi'))).toBe(false);
  });

  it('UPDATE_GOLDEN=1 writes a missing golden and passes', () => {
    process.env.UPDATE_GOLDEN = '1';
    const r = matchGolden('frame-b', 'Count: 0', { dir });
    expect(r).toEqual({ pass: true, created: true });
    expect(readFileSync(join(path, 'frame-b.ansi'), 'utf8')).toBe('Count: 0');
  });

  it('passes when the actual matches the stored golden', () => {
    seed('frame-c', 'Merge [ Run ]');
    expect(matchGolden('frame-c', 'Merge [ Run ]', { dir })).toEqual({ pass: true });
  });

  it('fails with a line diff when the actual drifts', () => {
    seed('frame-d', 'one');
    const r = matchGolden('frame-d', 'two', { dir });
    expect(r.pass).toBe(false);
    expect(r.diff).toContain('-one');
    expect(r.diff).toContain('+two');
  });

  it('UPDATE_GOLDEN=1 overwrites an existing golden', () => {
    seed('frame-e', 'old');
    process.env.UPDATE_GOLDEN = '1';
    expect(matchGolden('frame-e', 'new', { dir })).toEqual({ pass: true, created: true });
    expect(readFileSync(join(path, 'frame-e.ansi'), 'utf8')).toBe('new');
  });

  it('strips non-determinism before comparing by default', () => {
    seed('frame-f', 'run <uuid> x');
    expect(matchGolden('frame-f', 'run ffffffff-ffff-ffff-ffff-ffffffffffff x', { dir }).pass).toBe(
      true,
    );
  });

  it('raw: true compares the text as given', () => {
    seed('frame-g', 'run abcdef01-2345-6789-abcd-ef0123456789 x');
    const r = matchGolden('frame-g', 'run ffffffff-ffff-ffff-ffff-ffffffffffff x', {
      dir,
      raw: true,
    });
    expect(r.pass).toBe(false);
  });

  it('does not depend on the working directory', () => {
    seed('frame-h', 'stable');
    // Deep enough that a path made relative to the old working directory cannot land back on the right
    // place by climbing to the root.
    const deep = join(path, 'a', 'b', 'c', 'd', 'e');
    mkdirSync(deep, { recursive: true });
    const before = process.cwd();
    process.chdir(deep);
    try {
      expect(matchGolden('frame-h', 'stable', { dir }).pass).toBe(true);
    } finally {
      process.chdir(before);
    }
  });
});
