import { sanitize } from '@minitui/sanitizer';
import { assertCanonicalStateKey, isArrayValue, isObject, type JsonValue } from './json-pointer.js';
import { applyStatePatch, type JsonPatchOp } from './patch-apply.js';

const MAX_STATE_DEPTH = 256;

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
