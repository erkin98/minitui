import type { ApprovalMode, PermissionRule } from '@minitui/types';
import { createEngine } from './engine.js';
import type { PermissionEngine } from './engine.js';
import { ensureParserReady } from './shell/parser.js';
import { loadGrants, appendGrant } from './persist.js';

export { parseShellCommand } from './shell/roots.js';
export { checkHardFloor } from './hard-floor.js';
export { ensureParserReady } from './shell/parser.js';
// PermissionEngine is exec-owned, defined in engine.ts (Task 13); re-exported here so sibling
// packages (by relative path) resolve it from permission/index.ts, never from '@minitui/types'
// (which does not export it).
export type { PermissionEngine } from './engine.js';
// path-gate surface (Task 11) — cli builds its write-path gate over these.
// `PathRule` is a type, so it re-exports with `export type` (NodeNext verbatimModuleSyntax).
export { checkPathRules } from './path-gate.js';
export type { PathRule } from './path-gate.js';

export interface CreatePermissionEngineOptions {
  readonly mode?: ApprovalMode | undefined;
  readonly persist?: boolean | undefined;
}

// Wires engine + rules + hard-floor + pending + parser into one live PermissionEngine.
// Pays the one-time wasm init here so the SYNCHRONOUS parseShellCommand re-export is usable by
// downstream consumers without each re-initializing. Persisted grants load as user-layer rules;
// new 'always' grants append back when persist is on.
export async function createPermissionEngine(
  opts: CreatePermissionEngineOptions = {},
): Promise<PermissionEngine> {
  await ensureParserReady();
  const persisted = opts.persist ? await loadGrants() : [];
  return createEngine({
    initialRules: { rules: persisted as PermissionRule[] },
    mode: opts.mode,
    onGrant: opts.persist
      ? (rule) => void appendGrant(rule).catch(() => {}) // best-effort persist; the grant is already live in-memory, so a persist I/O error must never crash the session
      : undefined,
  });
}
