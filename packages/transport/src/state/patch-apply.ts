import fastJsonPatch, { type Operation } from 'fast-json-patch';
import { type JsonValue, isArrayValue, isObject } from './json-pointer.js';
import type { JsonPatch } from '@minitui/types';

// fast-json-patch ships CJS whose named exports are built via `Object.assign(exports, …)`
// (index.js), which Node's cjs-module-lexer cannot statically detect — a named ESM import
// crashes at runtime for a real ESM consumer of the built dist. The default export carries the
// same surface and IS lexer-safe, so the values are destructured from it.
const { applyOperation, deepClone } = fastJsonPatch;

// Canonical RFC-6902 op is owned by @minitui/types (§Z11). `Operation` stays only
// as the cast at the fast-json-patch apply boundary below (adopt-library seam).
export type JsonPatchOp = JsonPatch;

export class PatchError extends Error {
  readonly opIndex: number;
  constructor(message: string, opIndex: number) {
    super(message);
    this.name = 'PatchError';
    this.opIndex = opIndex;
  }
}

// A copy/move op READS its `from` pointer. fast-json-patch's banPrototypeModifications guards
// WRITE paths only, so `from: '/constructor'` (or any inherited member — '/toString', '/valueOf',
// an array's '/map') resolves to a live host function that gets injected into JsonValue-typed
// canonical state. We resolve `from` over OWN members only and reject anything that would read an
// inherited or absent member — defense-in-depth alongside the DataStore's fail-closed re-parse.
function fromReadsOwnMember(doc: JsonValue, from: unknown): boolean {
  if (typeof from !== 'string') return false;
  if (from === '') return true; // whole-document reference is own by definition
  if (from[0] !== '/') return false;
  let cur: JsonValue = doc;
  for (const raw of from.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (isArrayValue(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return false; // non-canonical index (rejects 'map'/'length')
      const el = cur[Number(token)];
      if (el === undefined) return false; // out of bounds
      cur = el;
    } else if (isObject(cur)) {
      if (!Object.prototype.hasOwnProperty.call(cur, token)) return false; // inherited or absent
      const el = cur[token];
      if (el === undefined) return false;
      cur = el;
    } else {
      return false; // cannot descend into a primitive
    }
  }
  return true;
}

function readsInheritedFrom(op: unknown, doc: JsonValue): boolean {
  if (typeof op !== 'object' || op === null) return false;
  const { op: kind, from } = op as { op?: unknown; from?: unknown };
  if (kind !== 'copy' && kind !== 'move') return false;
  return !fromReadsOwnMember(doc, from);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Apply an RFC-6902 delta from an UNTRUSTED source (agent STATE_DELTA).
 * AG-UI's exact call shape: validateOperation=true, banPrototypeModifications=true.
 * Applied one op at a time against a private up-front clone of the document, so that:
 *  - the caller's `state` is never mutated (the clone is);
 *  - each op is cloned before it is applied, so a later op can never reach back into the
 *    caller's own operand objects (fast-json-patch inserts `value` by reference);
 *  - the reported failing-op index is the real one (fast-json-patch hardcodes 0 into its
 *    internal validator calls, so its `err.index` is unreliable — we track our own).
 * Malformed, prototype-polluting, or inherited-member-reading ops throw a PatchError
 * (never after partial corruption).
 */
export function applyStatePatch(state: JsonValue, delta: unknown): JsonValue {
  if (!Array.isArray(delta)) {
    throw new PatchError('invalid state delta: patch is not an array', -1);
  }
  let doc: JsonValue;
  try {
    // Clone the document ONCE; each op then mutates this private clone in place.
    // PIN-DEPTH (fold): bounded fail-closed, not RangeError — a stack-exhausting document is
    // caught here and surfaced as a PatchError, never an uncaught crash.
    doc = deepClone(state) as JsonValue;
  } catch (err) {
    throw new PatchError(`invalid state delta: ${errText(err)}`, -1);
  }
  for (let i = 0; i < delta.length; i++) {
    const op: unknown = delta[i];
    if (readsInheritedFrom(op, doc)) {
      throw new PatchError('invalid state delta: `from` must reference an own member', i);
    }
    try {
      const result = applyOperation(
        doc,
        deepClone(op) as Operation, // clone the whole op so applying it can't mutate the operand
        /* validateOperation */ true,
        /* mutateDocument */ true, // `doc` is already our private clone
        /* banPrototypeModifications */ true,
        i,
      );
      doc = result.newDocument;
    } catch (err) {
      // Our loop counter `i` is the true failing-op index (not the library's `err.index`).
      throw new PatchError(`invalid state delta: ${errText(err)}`, i);
    }
  }
  return doc;
}
