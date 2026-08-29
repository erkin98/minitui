import type { JsonValue } from '@minitui/types';

// Single source of truth lives in @minitui/types — re-export, never redefine.
export type { ActionKind, PermissionDescriptor } from '@minitui/types';

// RFC-6901: resolve one /-rooted pointer to its value in the document.
// Exported for this package's own semantic validation ({ $state } bindings) —
// catalog-internal. A DAG-external caller (e.g. runtime-host's per-hole
// resolvedPaths consent resolution) is outside this package's allowed edges and
// needs its own copy, not an import of this export (exec ships its own DAG-forced
// local resolvePointer).
export function resolvePointer(doc: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer === '') return doc;
  // Drop the leading empty segment ONLY for a canonical /-rooted pointer; a slashless
  // pointer is a single relative segment, matching the runtime parseJsonPointer/getByPath
  // (`'missing'` → `['missing']`, read against the document root). Unconditional slice(1)
  // would turn a slashless pointer into `[]` = the whole document (always defined), hiding
  // a wires-to-nothing binding from the bad-binding check.
  const segments = pointer.split('/');
  const tokens = (segments[0] === '' ? segments.slice(1) : segments).map((t) =>
    t.replace(/~1/g, '/').replace(/~0/g, '~'),
  );
  let cur: JsonValue | undefined = doc;
  for (const tok of tokens) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      // Strict RFC-6901 array index: 0 or a leading-digit run only. Number() would
      // leniently accept exponent/hex/leading-zero/whitespace forms; a token outside
      // the canonical shape is unresolved (defense-in-depth against a lenient index).
      cur = /^(0|[1-9][0-9]*)$/.test(tok) ? (cur as readonly JsonValue[])[Number(tok)] : undefined;
    } else if (typeof cur === 'object') {
      cur = (cur as { readonly [k: string]: JsonValue })[tok];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Resolve a PermissionDescriptor.resourceTemplate's ${/pointer} holes against the
 * HOST-controlled state document. A hole whose pointer is missing or resolves to a
 * non-string value is left literally in place — the caller treats a residual `${`
 * as an unresolved-template error and never runs the command.
 */
export function applyResourceTemplate(template: string, state: JsonValue): string {
  return template.replace(/\$\{(\/[^}]*)\}/g, (whole, pointer: string) => {
    const value = resolvePointer(state, pointer);
    return typeof value === 'string' ? value : whole;
  });
}
