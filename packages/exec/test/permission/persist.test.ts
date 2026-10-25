import { describe, it, expect, beforeEach } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadGrants,
  appendGrant,
  readGrants,
  grantsFilePath,
} from '../../src/permission/persist.js';
import type { PermissionRule } from '@minitui/types';

let file: string;
const rule: PermissionRule = { pattern: 'ffmpeg', effect: 'allow', layer: 'user' };

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minitui-grants-'));
  file = join(dir, 'grants.json');
});

describe('grant persistence', () => {
  it('returns [] for a missing file (fails to empty, not to allow)', async () => {
    expect(await loadGrants(file)).toEqual([]);
  });
  it('appends and reloads a grant', async () => {
    await appendGrant(rule, file);
    expect(await loadGrants(file)).toEqual([rule]);
  });
  it('persists only the narrow grant, 0600', async () => {
    await appendGrant(rule, file);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    expect(raw).toEqual({ version: 1, grants: [rule] });
    // POSIX permission bits are not meaningful on win32 (mode & 0o777 !== 0o600 there); assert the
    // 0600 the test name claims only where it applies, so a Windows CI lane does not flake.
    if (process.platform !== 'win32') {
      const { mode } = await stat(file);
      expect(mode & 0o777).toBe(0o600);
    }
  });
  it('de-dupes identical grants', async () => {
    await appendGrant(rule, file);
    await appendGrant(rule, file);
    expect(await loadGrants(file)).toEqual([rule]);
  });
  it('keeps one basename bound to DISTINCT identities distinct, and round-trips identity', async () => {
    const a: PermissionRule = {
      pattern: 'ffmpeg',
      effect: 'allow',
      layer: 'user',
      identity: '/usr/bin/ffmpeg',
    };
    const b: PermissionRule = {
      pattern: 'ffmpeg',
      effect: 'allow',
      layer: 'user',
      identity: '/opt/homebrew/bin/ffmpeg',
    };
    await appendGrant(a, file);
    await appendGrant(a, file); // same identity → de-duped
    await appendGrant(b, file); // different identity → a DISTINCT grant, not de-duped
    expect(await loadGrants(file)).toEqual([a, b]); // identity survived reload (parses through the canonical PermissionRuleSchema)
  });
  it('returns [] for a corrupt file (parseable JSON, wrong shape → fails to empty)', async () => {
    // valid JSON of the wrong shape exercises the safeParse-fail branch — the missing-file test
    // above already covers the catch branch. The reader fails to empty, never to allow-everything.
    await writeFile(file, '{"not":"a grants array"}');
    expect(await loadGrants(file)).toEqual([]);
  });
  it('pins a reloaded grant to the user layer so a tampered file cannot claim managed rank', async () => {
    // a hand-edited/agent-written grants file naming layer:'managed' would otherwise outrank a
    // project/user deny; the loader coerces every reloaded grant to the user layer on read.
    await writeFile(file, JSON.stringify([{ pattern: 'curl', effect: 'allow', layer: 'managed' }]));
    const loaded = await loadGrants(file);
    expect(loaded[0]!.layer).toBe('user');
  });
});

describe('the grants file is read strictly', () => {
  const envelope = (grants: unknown[], extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ version: 1, grants, ...extra });
  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    pattern: 'ffmpeg',
    effect: 'allow',
    layer: 'user',
    ...over,
  });

  it('reports a missing file as absent, and a directory in the way as unreadable', async () => {
    expect((await readGrants(file)).status).toBe('absent');
    await mkdir(file);
    expect((await readGrants(file)).status).toBe('invalid');
  });

  it('accepts the envelope with bare-name rows and exact rows', async () => {
    await writeFile(
      file,
      envelope([row(), row({ pattern: 'rm -rf build', exact: true, identity: '/usr/bin/rm' })]),
    );
    const read = await readGrants(file);
    expect(read.status).toBe('ok');
    expect(read.grants).toHaveLength(2);
  });

  const invalid: Array<[string, string]> = [
    ['text that is not JSON', 'not json'],
    ['a newer version', JSON.stringify({ version: 2, grants: [] })],
    ['an unknown key on the envelope', envelope([], { extra: 1 })],
    ['a star row without exact', envelope([row({ pattern: '*' })])],
    ['a multi-word row without exact', envelope([row({ pattern: 'rm -rf build' })])],
    ['an unknown key on a row', envelope([row({ bogus: 1 })])],
    ['a deny row', envelope([row({ effect: 'deny' })])],
    ['an exact field that is false', envelope([row({ exact: false })])],
  ];
  it.each(invalid)('treats %s as no grants, and refuses to overwrite it', async (_name, text) => {
    await writeFile(file, text);
    const read = await readGrants(file);
    expect(read.status).toBe('invalid');
    expect(read.grants).toEqual([]);
    expect(await loadGrants(file)).toEqual([]);
    await expect(appendGrant(rule, file)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('reads a bare array once: whitespace rows become exact, nothing is dropped', async () => {
    await writeFile(
      file,
      JSON.stringify([row(), row({ pattern: 'rm -rf build' }), row({ pattern: '*' })]),
    );
    const loaded = await loadGrants(file);
    expect(loaded).toHaveLength(3);
    expect(loaded.map((r) => r.exact === true)).toEqual([false, true, true]);
    await appendGrant({ pattern: 'ls', effect: 'allow', layer: 'user' }, file);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.grants).toHaveLength(4);
  });
});

describe('an exact grant and a cascade grant with the same text are two grants', () => {
  it('keeps both through a reload', async () => {
    const cascade: PermissionRule = { pattern: 'ls', effect: 'allow', layer: 'user' };
    const exact: PermissionRule = { pattern: 'ls', effect: 'allow', layer: 'user', exact: true };
    await appendGrant(cascade, file);
    await appendGrant(exact, file);
    expect(await loadGrants(file)).toEqual([cascade, exact]);
  });
});

describe('appends are serialised', () => {
  it('keeps every row of eight overlapping appends', async () => {
    const rows: PermissionRule[] = Array.from({ length: 8 }, (_, i) => ({
      pattern: `tool${i}`,
      effect: 'allow',
      layer: 'user',
    }));
    await Promise.all(rows.map((r) => appendGrant(r, file)));
    const loaded = await loadGrants(file);
    expect(loaded.map((r) => r.pattern).sort()).toEqual(rows.map((r) => r.pattern).sort());
  });

  it('a failed append does not stop the ones behind it', async () => {
    const blocked = join(file, 'inside', 'grants.json'); // file does not exist; its parent cannot be made
    await writeFile(file, 'a file where a directory is needed');
    const failing = appendGrant(rule, blocked);
    const ok = appendGrant(rule, join(file + '-ok', 'grants.json'));
    await expect(failing).rejects.toThrow();
    await expect(ok).resolves.toBeUndefined();
  });
});

describe('the grants file is private', () => {
  it('creates the directory 0700 and the file 0600', async () => {
    if (process.platform === 'win32') return; // POSIX permission bits do not apply there
    const nested = join(file + '-dir', 'a', 'b', 'grants.json');
    await appendGrant(rule, nested);
    expect((await stat(join(file + '-dir', 'a', 'b'))).mode & 0o777).toBe(0o700);
    expect((await stat(nested)).mode & 0o777).toBe(0o600);
  });
});

describe('where the grants file lives', () => {
  const saved = process.env.XDG_DATA_HOME;
  const fallback = join(homedir(), '.local', 'share', 'minitui', 'grants.json');
  const withXdg = (value: string | undefined, run: () => void): void => {
    try {
      if (value === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = value;
      run();
    } finally {
      if (saved === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = saved;
    }
  };

  it('follows an absolute XDG_DATA_HOME', () => {
    withXdg('/data/xdg', () => expect(grantsFilePath()).toBe('/data/xdg/minitui/grants.json'));
  });
  it('ignores a relative, an empty and an unset XDG_DATA_HOME', () => {
    withXdg('relative/dir', () => expect(grantsFilePath()).toBe(fallback));
    withXdg('', () => expect(grantsFilePath()).toBe(fallback));
    withXdg(undefined, () => expect(grantsFilePath()).toBe(fallback));
  });
});

describe('a row that the reader would refuse is never written', () => {
  it('rejects a cascade rule whose pattern holds a space or a star, and leaves the file alone', async () => {
    await appendGrant(rule, file);
    const before = await readFile(file, 'utf8');
    await expect(
      appendGrant({ pattern: 'my tool', effect: 'allow', layer: 'user' }, file),
    ).rejects.toThrow();
    await expect(
      appendGrant({ pattern: 'a*', effect: 'allow', layer: 'user' }, file),
    ).rejects.toThrow();
    await expect(
      appendGrant({ pattern: 'ls', effect: 'deny', layer: 'user' }, file),
    ).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await readGrants(file)).status).toBe('ok');
  });
});
