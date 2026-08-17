import { sanitize } from '@minitui/sanitizer';
import { assertCanonicalStateKey, isArrayValue, isObject, type JsonValue } from './json-pointer.js';
import { applyStatePatch, type JsonPatchOp } from './patch-apply.js';

const MAX_STATE_DEPTH = 256;

// This walker and the sanitizer's own `sanitizeSpecStrings` cover the same three
// concerns at the same ceiling (256), with deliberately OPPOSITE conventions on
// two of them. Both are locked by separate package surface goldens, so nothing is
// confused today, but the divergence is intentional and worth stating:
//
//   depth overflow — here: throws. sanitizer: returns null, truncating the
//     subtree to an inert value and continuing.
//   non-canonical keys — here: throws via `assertCanonicalStateKey`. sanitizer:
//     rewrites the key through `sanitize()` and keeps going.
//   reserved keys — both throw. (Not a divergence; listed so a reader does not
//     infer one from the two above.)
//
// The asymmetry is the point: a state document that cannot be canonicalized must
// fail the write, not silently become a smaller or differently-keyed document. A
// spec being rendered can degrade; a state document being committed cannot.
function sanitizeValue(value: JsonValue, depth: number): JsonValue {
  if (depth > MAX_STATE_DEPTH) {
    throw new Error(`state document exceeds max nesting depth (${MAX_STATE_DEPTH})`);
  }
  if (typeof value === 'string') return sanitize(value);
  if (isArrayValue(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  if (isObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      assertCanonicalStateKey(key);
      Object.defineProperty(out, key, {
        value: sanitizeValue(item, depth + 1),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

export function sanitizeStrings(value: JsonValue): JsonValue {
  return sanitizeValue(value, 0);
}

export function foldSnapshot(snapshot: JsonValue): JsonValue {
  return sanitizeStrings(snapshot);
}

export function foldDelta(state: JsonValue, delta: readonly JsonPatchOp[]): JsonValue {
  const cleaned = delta.map((operation) =>
    'value' in operation ? { ...operation, value: sanitizeStrings(operation.value) } : operation,
  );
  return applyStatePatch(state, cleaned);
}
