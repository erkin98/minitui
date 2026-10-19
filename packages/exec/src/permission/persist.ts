import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PermissionRuleSchema, type PermissionRule } from '@minitui/types';
import { isBareCommandName } from './rules.js';
import { storeDir } from './secret-paths.js';

export function grantsFilePath(): string {
  return join(storeDir(process.env, homedir()), 'grants.json');
}

// On disk: `{ "version": 1, "grants": PermissionRule[] }`.
const FILE_VERSION = 1;

// The row schema is derived from the CANONICAL permission-rule schema, never a second hand-written
// object: the inner object of its readonly wrapper, made strict, so a key the canonical schema does not
// know is a refusal and a future optional canonical field flows in automatically.
const RowSchema = PermissionRuleSchema.unwrap().strict();
type Row = z.infer<typeof RowSchema>;

const EnvelopeSchema = z
  .object({ version: z.literal(FILE_VERSION), grants: z.array(RowSchema) })
  .strict();

// A grant row is an allow. A cascade grant (no `exact`) names a bare command: no whitespace and no `*`,
// so a persisted row can never widen into a wildcard. A narrow grant carries `exact: true` and is compared
// by string equality.
const isGrantRow = (row: Row): boolean =>
  row.effect === 'allow' && (row.exact === true || isBareCommandName(row.pattern));

// Every reloaded grant is pinned to the user layer, so a tampered file cannot claim managed rank over a
// live project or user deny.
const asUserGrant = (row: Row): PermissionRule => ({ ...row, layer: 'user' });

export type GrantsRead =
  | { readonly status: 'absent'; readonly grants: readonly [] }
  | { readonly status: 'ok'; readonly grants: readonly PermissionRule[] }
  | { readonly status: 'invalid'; readonly reason: string; readonly grants: readonly [] };

const ABSENT: GrantsRead = { status: 'absent', grants: [] };
const invalid = (reason: string): GrantsRead => ({ status: 'invalid', reason, grants: [] });

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ENOTDIR');

// The form before versions: a bare array. Read once. A row whose pattern is not a bare name is taken as
// an exact grant for that literal text, so nothing is dropped and nothing widens; the next append
// writes the envelope.
function fromLegacy(json: unknown): GrantsRead {
  const parsed = z.array(RowSchema).safeParse(json);
  if (!parsed.success) return invalid('the file does not hold grant rows');
  const rows = parsed.data.map((row) =>
    row.exact === true || isBareCommandName(row.pattern) ? row : { ...row, exact: true as const },
  );
  return rows.every(isGrantRow)
    ? { status: 'ok', grants: rows.map(asUserGrant) }
    : invalid('a grant row breaks the rules');
}

function fromEnvelope(json: unknown): GrantsRead {
  const parsed = EnvelopeSchema.safeParse(json);
  if (!parsed.success) return invalid('unknown version or shape');
  return parsed.data.grants.every(isGrantRow)
    ? { status: 'ok', grants: parsed.data.grants.map(asUserGrant) }
    : invalid('a grant row breaks the rules');
}

// Read the grants file and say what was found. "No file" is no grants. Anything that is not a valid
// file (unreadable, not JSON, a newer version, an unknown key, a row that breaks the rules) is also no
// grants, but it is reported as invalid so that a caller can warn and an append can refuse to overwrite it.
export async function readGrants(file = grantsFilePath()): Promise<GrantsRead> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    return isMissing(error) ? ABSENT : invalid('unreadable file');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return invalid('not JSON');
  }
  return Array.isArray(json) ? fromLegacy(json) : fromEnvelope(json);
}

export async function loadGrants(file = grantsFilePath()): Promise<readonly PermissionRule[]> {
  return (await readGrants(file)).grants;
}

function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  // identity and exact are part of the key — two grants for one basename bound to distinct realpaths
  // are DISTINCT grants, and an exact grant is distinct from a cascade grant with the same text.
  return (
    a.pattern === b.pattern &&
    a.effect === b.effect &&
    a.layer === b.layer &&
    a.identity === b.identity &&
    a.exact === b.exact
  );
}

async function writeGrant(rule: PermissionRule, file: string): Promise<void> {
  // a row the reader would refuse is never written: it would make the whole file unreadable
  if (!isGrantRow(rule)) throw new Error('the grant breaks the rules for a saved grant');
  const read = await readGrants(file);
  if (read.status === 'invalid') throw new Error(`the grants file is not valid: ${read.reason}`);
  if (read.grants.some((r) => sameRule(r, rule))) return; // de-dupe
  const next = { version: FILE_VERSION, grants: [...read.grants, rule] };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // symlink-safe + cross-fs-safe: write a fresh temp file IN THE TARGET DIR (same filesystem as
  // `file`), then atomically rename over the target. A tmpdir() temp would rename across devices on
  // a tmpfs-/tmp + volume-home topology and throw EXDEV — the ordinary "always" grant would then
  // reject an unhandled promise and crash the process.
  const tmp = join(dirname(file), `.grants-${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(tmp, file);
}

// One write in flight at a time: each append reads the file and writes it back, so two overlapping
// appends would each start from the same rows and the later rename would drop the earlier row. A failed
// append is reported to its own caller and does not stop the ones queued behind it.
let queue: Promise<void> = Promise.resolve();

export function appendGrant(rule: PermissionRule, file = grantsFilePath()): Promise<void> {
  const run = queue.then(() => writeGrant(rule, file));
  queue = run.catch(() => {});
  return run;
}
