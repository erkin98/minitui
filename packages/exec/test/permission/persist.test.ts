import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGrants, appendGrant } from '../../src/permission/persist.js';
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
    expect(raw).toEqual([rule]);
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
});
