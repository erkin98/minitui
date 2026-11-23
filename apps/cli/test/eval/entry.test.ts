import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProcessPort } from '../../src/boot.js';
import { guardCrashes, isEntryModule } from '../../eval/main.js';
import { tempDirs } from '../support/eval-run.js';

// The two things the entry does outside evalMain: decide whether this module is the program, and answer
// a crash that evalMain's own catch cannot see. Both are reached here without starting a process.

const dirs = tempDirs();
afterAll(() => dirs.cleanup());

describe('isEntryModule', () => {
  // the module, another file, a symlink to the module, and a symlink to the directory that holds it
  function layout() {
    const dir = dirs.make();
    const module = join(dir, 'main.ts');
    writeFileSync(module, '');
    writeFileSync(join(dir, 'other.ts'), '');
    symlinkSync(module, join(dir, 'link.ts'));
    mkdirSync(join(dir, 'sub'));
    symlinkSync(dir, join(dir, 'sub', 'dir-link'));
    return { dir, module, moduleUrl: pathToFileURL(module).href };
  }

  it('the module’s own path is the entry', () => {
    const { module, moduleUrl } = layout();
    expect(isEntryModule(module, moduleUrl)).toBe(true);
  });

  it('a path through a symlink to the module is the entry', () => {
    const { dir, moduleUrl } = layout();
    expect(isEntryModule(join(dir, 'link.ts'), moduleUrl)).toBe(true);
  });

  it('a path that crosses a symlinked directory is the entry', () => {
    const { dir, moduleUrl } = layout();
    expect(isEntryModule(join(dir, 'sub', 'dir-link', 'main.ts'), moduleUrl)).toBe(true);
  });

  it('another file is not the entry, a symlink to it included', () => {
    const { dir, moduleUrl } = layout();
    symlinkSync(join(dir, 'other.ts'), join(dir, 'other-link.ts'));
    expect(isEntryModule(join(dir, 'other.ts'), moduleUrl)).toBe(false);
    expect(isEntryModule(join(dir, 'other-link.ts'), moduleUrl)).toBe(false);
  });

  it('no path, and a path with nothing at it, are not the entry and do not throw', () => {
    const { dir, moduleUrl } = layout();
    expect(isEntryModule(undefined, moduleUrl)).toBe(false);
    expect(isEntryModule(join(dir, 'missing.ts'), moduleUrl)).toBe(false);
  });
});

describe('guardCrashes', () => {
  // A real implementation of the process port that keeps the crash listener, so a test fires a crash by hand.
  function crashPort() {
    const listeners: Array<(reason: unknown) => void> = [];
    const exits: number[] = [];
    const proc: ProcessPort = {
      pid: 1,
      onExit: () => {},
      onSignal: () => {},
      onCrash: (listener) => {
        listeners.push(listener);
      },
      raise: () => {},
      exit: (code) => {
        exits.push(code);
      },
    };
    return { proc, exits, crash: (reason: unknown) => listeners.forEach((l) => l(reason)) };
  }
  const ESC = String.fromCharCode(27);
  const KEY = 'sk-ant-api03-Pl4nt3dCrashKey0123456789';

  it('registers one crash listener, and nothing happens until a crash', () => {
    const { proc, exits } = crashPort();
    const lines: string[] = [];
    guardCrashes(proc, (line) => lines.push(line));
    expect([lines, exits]).toEqual([[], []]);
  });

  it('a crash prints one fixed line and exits 1; the error’s own text is nowhere in it', () => {
    const { proc, exits, crash } = crashPort();
    const lines: string[] = [];
    guardCrashes(proc, (line) => lines.push(line));
    crash(new Error(`request failed for ${KEY} ${ESC}[2J`));
    expect(lines).toEqual(['model-eval: stopped by an unexpected error']);
    expect(exits).toEqual([1]);
    // the control: a rejection with no error in it prints the same line
    crash('a string');
    expect(lines[1]).toBe(lines[0]);
  });

  it('exits 1 even when the line cannot be written', () => {
    const { proc, exits, crash } = crashPort();
    guardCrashes(proc, () => {
      throw new Error('EPIPE');
    });
    expect(() => crash(new Error('boom'))).not.toThrow();
    expect(exits).toEqual([1]);
  });
});
