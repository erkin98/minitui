import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPermissionEngine } from '../../src/permission/index.js';
import type { PermissionRequest } from '@minitui/types';

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
});
