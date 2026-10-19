import { noopDiagnostics } from '@minitui/types';
import type { ApprovalMode, DiagnosticsPort, PermissionRule } from '@minitui/types';
import { createEngine } from './engine.js';
import type { PermissionEngine } from './engine.js';
import { ensureParserReady } from './shell/parser.js';
import { appendGrant, grantsFilePath, readGrants } from './persist.js';

export { parseShellCommand } from './shell/roots.js';
export { checkHardFloor } from './hard-floor.js';
export { ensureParserReady } from './shell/parser.js';
// PermissionEngine is exec-owned, defined in engine.ts; re-exported here so sibling
// packages (by relative path) resolve it from permission/index.ts, never from '@minitui/types'
// (which does not export it).
export type { PermissionEngine } from './engine.js';
// path-gate surface — cli builds its write-path gate over these.
// `PathRule` is a type, so it re-exports with `export type` (NodeNext verbatimModuleSyntax).
export { checkPathRules } from './path-gate.js';
export type { PathRule } from './path-gate.js';

export interface CreatePermissionEngineOptions {
  readonly mode?: ApprovalMode | undefined;
  readonly persist?: boolean | undefined;
  // where the engine reports a grants file it ignored and a grant it could not save; default: nowhere
  readonly diagnostics?: DiagnosticsPort | undefined;
}

// Fixed phrases: the path and the reason travel in the meta, never in the message.
const GRANTS_IGNORED = 'saved grants ignored: the grants file is not valid';
const GRANT_NOT_SAVED = 'grant not saved to the grants file';

// A sink that throws must not break the session that is reporting to it.
function report(diagnostics: DiagnosticsPort, msg: string, meta: Record<string, unknown>): void {
  try {
    diagnostics.warn(msg, meta);
  } catch {
    // the report is best effort
  }
}

// Wires engine + rules + hard-floor + pending + parser into one live PermissionEngine.
// Pays the one-time wasm init here so the SYNCHRONOUS parseShellCommand re-export is usable by
// downstream consumers without each re-initializing. Persisted grants load as user-layer rules;
// new 'always' grants append back when persist is on.
export async function createPermissionEngine(
  opts: CreatePermissionEngineOptions = {},
): Promise<PermissionEngine> {
  await ensureParserReady();
  const diagnostics = opts.diagnostics ?? noopDiagnostics;
  let persisted: readonly PermissionRule[] = [];
  if (opts.persist) {
    const read = await readGrants();
    if (read.status === 'invalid') {
      report(diagnostics, GRANTS_IGNORED, { path: grantsFilePath(), reason: read.reason });
    }
    persisted = read.grants;
  }
  return createEngine({
    initialRules: { rules: [...persisted] },
    mode: opts.mode,
    // the grant is already live in memory, so a failed save is reported and never crashes the session
    onGrant: opts.persist
      ? (rule) => {
          void appendGrant(rule).catch((error: unknown) =>
            report(diagnostics, GRANT_NOT_SAVED, {
              path: grantsFilePath(),
              reason: error instanceof Error ? error.message : 'unknown error',
            }),
          );
        }
      : undefined,
  });
}
