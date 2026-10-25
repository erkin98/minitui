import fastJsonPatch, { type Operation } from 'fast-json-patch';
import {
  assertJsonResourceBudget,
  JsonObjectSchema,
  JsonPatchArraySchema,
  type JsonPatch,
  type JsonValue,
} from '@minitui/types';
import { sanitize } from '@minitui/sanitizer';

const { applyOperation, JsonPatchError } = fastJsonPatch;
const RESERVED_STATE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_STATE_POINTER_DEPTH = 256;

// Every message below is a fixed string. A pointer, a token, a key or a value of the patch is agent
// text, so none is ever interpolated; the position of the failing operation travels in `opIndex`.
const TEST_FAILED = 'invalid state delta: test operation failed';
const ENGINE_REJECTED = 'invalid state delta: patch engine rejected the operation';

function atIndex(error: Error, opIndex: number): Error {
  return Object.assign(error, { opIndex });
}

function parseCanonicalPointer(pointer: string): string[] {
  let separators = 0;
  for (let offset = 0; offset < pointer.length; offset++) {
    if (pointer.charCodeAt(offset) === 0x2f && ++separators > MAX_STATE_POINTER_DEPTH) {
      throw new Error(`JSON pointer exceeds max depth ${MAX_STATE_POINTER_DEPTH}`);
    }
  }
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error('invalid JSON pointer');
  const tokens = pointer
    .slice(1)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  for (const token of tokens) {
    if (RESERVED_STATE_KEYS.has(token)) throw new Error(`reserved state key not allowed: ${token}`);
    if (sanitize(token) !== token) throw new Error('state key is not canonical');
  }
  return tokens;
}

function isArrayValue(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function isObjectValue(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseArrayIndexToken(token: string): number | '-' | undefined {
  if (token === '-') return '-';
  if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
  const index = Number(token);
  return Number.isSafeInteger(index) ? index : undefined;
}

function assertCanonicalStateValue(value: JsonValue): void {
  const pending: JsonValue[] = [value];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (isArrayValue(current)) {
      for (const item of current) pending.push(item);
    } else if (isObjectValue(current)) {
      for (const [key, item] of Object.entries(current)) {
        if (RESERVED_STATE_KEYS.has(key)) throw new Error(`reserved state key not allowed: ${key}`);
        if (sanitize(key) !== key) throw new Error('state key is not canonical');
        pending.push(item);
      }
    }
  }
}

function resolveExisting(document: JsonValue, tokens: readonly string[]): JsonValue {
  let current = document;
  for (const token of tokens) {
    if (isArrayValue(current)) {
      const index = parseArrayIndexToken(token);
      if (index === undefined) throw new Error('invalid array index');
      if (index === '-' || index >= current.length) throw new Error('array member does not exist');
      current = current[index]!;
    } else if (isObjectValue(current)) {
      if (!Object.hasOwn(current, token)) throw new Error('object member does not exist');
      current = current[token]!;
    } else {
      throw new Error('patch path traverses a primitive');
    }
  }
  return current;
}

function resolveParent(
  document: JsonValue,
  tokens: readonly string[],
): { readonly parent: JsonValue; readonly token: string } {
  const token = tokens.at(-1);
  if (token === undefined) throw new Error('root pointer has no parent');
  return { parent: resolveExisting(document, tokens.slice(0, -1)), token };
}

function assertAddTarget(document: JsonValue, tokens: readonly string[]): void {
  if (tokens.length === 0) return;
  const { parent, token } = resolveParent(document, tokens);
  if (isArrayValue(parent)) {
    const index = parseArrayIndexToken(token);
    if (index === undefined || (index !== '-' && index > parent.length)) {
      throw new Error('invalid add array index');
    }
  } else if (!isObjectValue(parent)) {
    throw new Error('patch target parent is a primitive');
  }
}

function assertExistingTarget(document: JsonValue, tokens: readonly string[]): void {
  if (tokens.length === 0) return;
  const { parent, token } = resolveParent(document, tokens);
  if (isArrayValue(parent)) {
    // A malformed token (leading zero, sign, non-digits) is a different defect than a
    // well-formed index that is out of range; name each precisely.
    const index = parseArrayIndexToken(token);
    if (index === undefined) throw new Error('invalid array index');
    if (index === '-' || index >= parent.length) throw new Error('array member does not exist');
  } else if (isObjectValue(parent)) {
    if (!Object.hasOwn(parent, token)) throw new Error('object member does not exist');
  } else {
    throw new Error('patch target parent is a primitive');
  }
}

function isStrictPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  return prefix.length < value.length && prefix.every((token, index) => value[index] === token);
}

// The one call into the adopted engine. Its own error carries the operation and the document in its
// message; here it becomes one of two fixed messages, told apart by the engine's error name (never by
// its message text), with the operation's index.
export function applyEngineOperation(
  document: JsonValue,
  operation: Operation,
  index: number,
): JsonValue {
  try {
    return applyOperation(document, operation, true, true, true, index).newDocument;
  } catch (error) {
    if (error instanceof JsonPatchError) {
      throw atIndex(
        new Error(error.name === 'TEST_OPERATION_FAILED' ? TEST_FAILED : ENGINE_REJECTED),
        index,
      );
    }
    throw error;
  }
}

// `document` is the private working copy of one patch: it is never published when an operation
// throws, so a failed step may leave it half changed.
function applyMove(
  document: JsonValue,
  operation: JsonPatch & { op: 'move' },
  index: number,
): JsonValue {
  const from = parseCanonicalPointer(operation.from);
  const path = parseCanonicalPointer(operation.path);
  if (isStrictPrefix(from, path)) throw new Error('move source cannot contain its destination');
  const value = resolveExisting(document, from);
  const afterRemoval = applyEngineOperation(
    document,
    { op: 'remove', path: operation.from },
    index,
  );
  assertAddTarget(afterRemoval, path);
  return applyEngineOperation(afterRemoval, { op: 'add', path: operation.path, value }, index);
}

function applyCopy(
  document: JsonValue,
  operation: JsonPatch & { op: 'copy' },
  index: number,
): JsonValue {
  const path = parseCanonicalPointer(operation.path);
  const from = parseCanonicalPointer(operation.from);
  const value = structuredClone(resolveExisting(document, from));
  assertAddTarget(document, path);
  return applyEngineOperation(document, { op: 'add', path: operation.path, value }, index);
}

function applyCanonicalOperation(
  document: JsonValue,
  operation: JsonPatch,
  index: number,
): JsonValue {
  if (operation.op === 'move') return applyMove(document, operation, index);
  if (operation.op === 'copy') return applyCopy(document, operation, index);
  const path = parseCanonicalPointer(operation.path);
  if ('value' in operation) assertCanonicalStateValue(operation.value);
  if (operation.op === 'add') assertAddTarget(document, path);
  if (operation.op === 'replace' || operation.op === 'remove' || operation.op === 'test') {
    assertExistingTarget(document, path);
  }
  return applyEngineOperation(document, structuredClone(operation) as Operation, index);
}

export interface StateIo {
  readonly getSnapshot: () => Record<string, unknown>;
  readonly setSnapshot: (next: Record<string, unknown>) => void;
}

// FULL RFC-6902 per the renderer-core contract — move/copy/test included. Parse first, then mutate
// only one private clone; nothing is published unless every operation succeeded. The local preflight
// mirrors the transport-side patch semantics without introducing the forbidden renderer→transport
// edge. Keep intermediate documents mutable: readonly schemas freeze parsed containers, so the final
// object parse belongs after the complete sequence.
export function applyStatePatchTo(io: StateIo, patch: readonly JsonPatch[]): void {
  const parsed = JsonPatchArraySchema.parse(patch);
  const initial = JsonObjectSchema.parse(io.getSnapshot());
  assertCanonicalStateValue(initial);
  let document: JsonValue = structuredClone(initial);
  for (let index = 0; index < parsed.length; index++) {
    try {
      document = applyCanonicalOperation(document, parsed[index]!, index);
      assertJsonResourceBudget(document);
    } catch (error) {
      throw error instanceof Error && !('opIndex' in error) ? atIndex(error, index) : error;
    }
  }
  // A generic patch may produce null at the root; json-render's state model may not.
  // Parse before the sole write so rejection is atomic.
  const next = JsonObjectSchema.parse(document);
  assertCanonicalStateValue(next);
  io.setSnapshot(next);
}
