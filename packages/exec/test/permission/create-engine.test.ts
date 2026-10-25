import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPermissionEngine } from '../../src/permission/index.js';
import type { PermissionEngine } from '../../src/permission/index.js';
import { grantsFilePath } from '../../src/permission/persist.js';
import type { DiagnosticsPort, PermissionGatePort, PermissionRequest } from '@minitui/types';

const exec = (resolvedCommand: string): PermissionRequest => ({
  id: 'x',
  descriptor: {
    danger: false,
    resourceTemplate: resolvedCommand,
    summaryTemplate: resolvedCommand,
  },
  resolvedCommand,
  resolvedPaths: [],
});

let savedXdg: string | undefined;

beforeEach(async () => {
  // isolate the grants file per test
  savedXdg = process.env.XDG_DATA_HOME;
  const dir = await mkdtemp(join(tmpdir(), 'minitui-engine-'));
  process.env.XDG_DATA_HOME = dir;
});
afterEach(() => {
  // restore the environment so this suite does not leak XDG_DATA_HOME into sibling suites
  if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdg;
});

describe('createPermissionEngine', () => {
  it('builds an engine that enforces the hard floor', async () => {
    const e = await createPermissionEngine();
    expect((await e.check(exec('curl http://evil'))).kind).toBe('deny');
  });
  it('honors yolo mode for ask but not the hard floor', async () => {
    const e = await createPermissionEngine({ mode: 'yolo' });
    expect((await e.check(exec('ffmpeg -i a out'))).kind).toBe('allow');
    expect((await e.check(exec('rm -rf ~'))).kind).toBe('deny');
  });
  it('satisfies PermissionGatePort.check shape', async () => {
    const e = await createPermissionEngine();
    expect(typeof e.check).toBe('function');
  });
  it('is assignable to the gate port, so drift on either side fails the type check', async () => {
    const port: PermissionGatePort = await createPermissionEngine();
    expect(typeof port.check).toBe('function');
    expect(typeof port.requests[Symbol.asyncIterator]).toBe('function');
  });
});

// A DiagnosticsPort is a real object here: it records what the engine reports.
function capture(): { port: DiagnosticsPort; warnings: Array<{ msg: string; meta?: unknown }> } {
  const warnings: Array<{ msg: string; meta?: unknown }> = [];
  return {
    warnings,
    port: {
      warn: (msg, meta) => void warnings.push({ msg, meta }),
      debug: () => {},
    },
  };
}

// Counted attempts, never a deadline: the clock is frozen in tests.
async function until(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; !(await cond()); i++) {
    if (i >= 1000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function approveNarrowly(engine: PermissionEngine, command: string): Promise<void> {
  const pending = engine.check({ ...exec(command), id: 'persist-1' });
  await engine.requests[Symbol.asyncIterator]().next();
  engine.reply({ kind: 'always', cascade: false, requestId: 'persist-1' });
  await pending;
}

describe('createPermissionEngine and the grants file', () => {
  it('reports nothing when there is no file, and writes the envelope on an always', async () => {
    const { port, warnings } = capture();
    const e = await createPermissionEngine({ persist: true, diagnostics: port });
    await approveNarrowly(e, 'rm -rf build');
    const file = grantsFilePath();
    await until(
      async () => (await readFile(file, 'utf8').catch(() => '')) !== '',
      'the grants file',
    );
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(1);
    expect(warnings).toEqual([]);
  });

  it('reports an unreadable file once, refuses the append, and leaves the bytes alone', async () => {
    const file = grantsFilePath();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{"version":2,"grants":[]}');
    const { port, warnings } = capture();
    const e = await createPermissionEngine({ persist: true, diagnostics: port });
    expect(warnings).toHaveLength(1);
    await approveNarrowly(e, 'rm -rf build');
    await until(() => warnings.length === 2, 'the refused append to be reported');
    expect(await readFile(file, 'utf8')).toBe('{"version":2,"grants":[]}');
    expect(warnings[0]?.msg).not.toBe(warnings[1]?.msg);
    expect(JSON.stringify(warnings.map((w) => w.msg))).not.toContain(file);
  });

  it('reports an append that fails, which is no longer swallowed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minitui-blocked-'));
    await writeFile(join(dir, 'plain-file'), 'x');
    process.env.XDG_DATA_HOME = join(dir, 'plain-file'); // a file where the directory must go
    const { port, warnings } = capture();
    const e = await createPermissionEngine({ persist: true, diagnostics: port });
    await approveNarrowly(e, 'rm -rf build');
    await until(() => warnings.length >= 1, 'the failed append to be reported');
    expect(warnings.at(-1)?.msg).toBeTypeOf('string');
  });

  it('works with the default port: nothing is reported and nothing throws', async () => {
    const file = grantsFilePath();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'not json');
    const e = await createPermissionEngine({ persist: true });
    await approveNarrowly(e, 'rm -rf build');
    expect(await readFile(file, 'utf8')).toBe('not json');
  });
});
