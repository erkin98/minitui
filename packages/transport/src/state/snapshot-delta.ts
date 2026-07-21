import { type JsonValue, isArrayValue, isObject } from './json-pointer.js';
import { applyStatePatch, type JsonPatchOp } from './patch-apply.js';
import { sanitize } from '@minitui/sanitizer';

// §Z11: `sanitize` is imported DIRECTLY (never injected). This module is the
// transport state-seam chokepoint that the import lint / tsc composite refs /
// bundle-leak test can now SEE — a composition root can no longer wire the wrong
// or a missing sanitize fn here.
// PIN-DEPTH (fold): bounded fail-closed, not RangeError. 256 is far above any real widget-state
// nesting and far below the native stack limit; an over-deep (or cyclic) document is rejected with
// a typed error the DataStore catches and drops, never an uncaught stack RangeError.
const MAX_STATE_DEPTH = 256;

export function sanitizeStrings(value: JsonValue, depth = 0): JsonValue {
  if (depth > MAX_STATE_DEPTH) {
    throw new Error(`state document exceeds max nesting depth (${MAX_STATE_DEPTH})`);
  }
  if (typeof value === 'string') return sanitize(value);
  if (isArrayValue(value)) return value.map((v) => sanitizeStrings(v, depth + 1));
  if (isObject(value)) {
    // §Z100 defense-in-depth: assign each cloned key as an OWN data property via
    // Object.defineProperty. A raw model object can carry an own `__proto__` key (JSON.parse makes
    // it an own property); a bare `out['__proto__'] = …` would invoke the prototype SETTER and
    // pollute this clone's prototype (a witnessed object-local prototype-pollution). defineProperty
    // writes data and never triggers the setter — the shallow-record policy still stands.
    const out: { [k: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value)) {
      Object.defineProperty(out, k, {
        value: sanitizeStrings(v, depth + 1),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

export function foldSnapshot(snapshot: JsonValue): JsonValue {
  return sanitizeStrings(snapshot);
}

export function foldDelta(state: JsonValue, delta: readonly JsonPatchOp[]): JsonValue {
  const cleaned = delta.map((op) =>
    'value' in op ? { ...op, value: sanitizeStrings(op.value) } : op,
  );
  return applyStatePatch(state, cleaned);
}
