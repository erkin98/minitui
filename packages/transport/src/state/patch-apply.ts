import fastJsonPatch, { type Operation } from 'fast-json-patch';
import type { JsonValue } from './json-pointer.js';
import type { JsonPatch } from '@minitui/types';

// fast-json-patch ships CJS whose named exports are built via `Object.assign(exports, …)`
// (index.js), which Node's cjs-module-lexer cannot statically detect — a named ESM import
// of `applyPatch` crashes at runtime for a real ESM consumer of the built dist. The
// default export (declared `export default _default` in index.d.ts) carries the same
// surface and IS lexer-safe, so the value is destructured from it.
const { applyPatch } = fastJsonPatch;

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

/**
 * Apply an RFC-6902 delta from an UNTRUSTED source (agent STATE_DELTA).
 * AG-UI's exact call shape: validateOperation=true, mutateDocument=false,
 * banPrototypeModifications=true. Malformed or prototype-polluting ops throw
 * at apply time (never after partial corruption).
 */
export function applyStatePatch(state: JsonValue, delta: unknown): JsonValue {
  try {
    const result = applyPatch(
      state,
      delta as Operation[],
      /* validateOperation */ true,
      /* mutateDocument */ false,
      /* banPrototypeModifications */ true,
    );
    return result.newDocument;
  } catch (err) {
    const index =
      typeof err === 'object' && err !== null && 'index' in err
        ? Number((err as { index: unknown }).index)
        : -1;
    const reason = err instanceof Error ? err.message : String(err);
    throw new PatchError(`invalid state delta: ${reason}`, index);
  }
}
