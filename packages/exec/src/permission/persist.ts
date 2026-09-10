import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PermissionRuleSchema, type PermissionRule } from '@minitui/types';

// The persist boundary parses reloaded grants through the CANONICAL PermissionRuleSchema, never
// a hand-copied one. A future optional canonical field (a grant could BROADEN on reload) would be silently
// stripped by a parallel z.object; using the canonical schema flows every field here automatically.
const GrantsSchema = z.array(PermissionRuleSchema);

export function grantsFilePath(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'minitui', 'grants.json');
}

export async function loadGrants(file = grantsFilePath()): Promise<readonly PermissionRule[]> {
  try {
    const parsed = GrantsSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return parsed.success ? parsed.data : []; // corrupt => empty, never allow-everything
  } catch {
    return []; // missing => empty
  }
}

function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  // identity is part of the key — two grants for one basename bound to distinct realpaths
  // are DISTINCT grants and both persist.
  return (
    a.pattern === b.pattern &&
    a.effect === b.effect &&
    a.layer === b.layer &&
    a.identity === b.identity
  );
}

// ponytail: single-writer model — last-writer-wins is acceptable for one local instance;
// file-locking deferred until multi-instance demands it (matches library/atomic-io.ts policy).
export async function appendGrant(rule: PermissionRule, file = grantsFilePath()): Promise<void> {
  const existing = await loadGrants(file);
  if (existing.some((r) => sameRule(r, rule))) return; // de-dupe
  const next = [...existing, rule];
  await mkdir(dirname(file), { recursive: true });
  // symlink-safe + cross-fs-safe: write a fresh temp file IN THE TARGET DIR (same filesystem as
  // `file`), then atomically rename over the target. A tmpdir() temp would rename across devices on
  // a tmpfs-/tmp + volume-home topology and throw EXDEV — the ordinary "always" grant would then
  // reject an unhandled promise and crash the process.
  const tmp = join(dirname(file), `.grants-${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(tmp, file);
}
