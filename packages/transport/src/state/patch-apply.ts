import fastJsonPatch, { type Operation } from 'fast-json-patch';
import {
  assertJsonResourceBudget,
  JsonPatchArraySchema,
  JsonValueSchema,
  type JsonPatch,
} from '@minitui/types';
import { formatUnknown } from '../format-unknown.js';
import {
  assertCanonicalStateValue,
  isArrayValue,
  isObject,
  parseArrayIndexToken,
  parseStatePointer,
  type JsonValue,
} from './json-pointer.js';

const { applyOperation } = fastJsonPatch;

export type JsonPatchOp = JsonPatch;

export class PatchError extends Error {
  readonly opIndex: number;

  constructor(message: string, opIndex: number) {
    super(message);
    this.name = 'PatchError';
    this.opIndex = opIndex;
  }
}

function issueIndex(error: {
  readonly issues: readonly { readonly path: PropertyKey[] }[];
}): number {
  for (const issue of error.issues) {
    for (const segment of issue.path) if (typeof segment === 'number') return segment;
  }
  return -1;
}

// The member-existence rules for a single pointer token, in one place: an array
// index must parse, must not be '-', and must be in range; an object member must
// be an own property; anything else is a primitive and cannot be traversed. Shared
// by the walk below and by `assertExistingTarget` so a rule change cannot land in
// one and silently miss the other. Only the primitive-case wording differs between
// the two callers, so it is passed in. `resolveExistingAfterRemoval` deliberately
// does NOT route through here — its index arithmetic projects a pending removal.
function memberOf(container: JsonValue, token: string, primitiveMessage: string): JsonValue {
  if (isArrayValue(container)) {
    const index = parseArrayIndexToken(token);
    if (index === undefined || index === '-' || index >= container.length) {
      throw new Error(`array member does not exist: ${JSON.stringify(token)}`);
    }
    return container[index]!;
  }
  if (isObject(container)) {
    if (!Object.hasOwn(container, token)) throw new Error(`object member does not exist: ${token}`);
    return container[token]!;
  }
  throw new Error(primitiveMessage);
}

function resolveExisting(doc: JsonValue, tokens: readonly string[]): JsonValue {
  let current = doc;
  for (const token of tokens)
    current = memberOf(current, token, 'patch path traverses a primitive');
  return current;
}

function resolveParent(
  doc: JsonValue,
  tokens: readonly string[],
): { readonly parent: JsonValue; readonly token: string } {
  const token = tokens.at(-1);
  if (token === undefined) throw new Error('root pointer has no parent');
  return { parent: resolveExisting(doc, tokens.slice(0, -1)), token };
}

function assertAddTarget(doc: JsonValue, tokens: readonly string[]): void {
  if (tokens.length === 0) return;
  const { parent, token } = resolveParent(doc, tokens);
  if (isArrayValue(parent)) {
    const index = parseArrayIndexToken(token);
    if (index === undefined || (index !== '-' && index > parent.length)) {
      throw new Error(`invalid add array index: ${JSON.stringify(token)}`);
    }
  } else if (!isObject(parent)) {
    throw new Error('patch target parent is a primitive');
  }
}

function assertExistingTarget(doc: JsonValue, tokens: readonly string[], allowRoot = true): void {
  if (tokens.length === 0) {
    if (!allowRoot) throw new Error('operation cannot remove the document root');
    return;
  }
  const { parent, token } = resolveParent(doc, tokens);
  memberOf(parent, token, 'patch target parent is a primitive');
}

function isStrictPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  return prefix.length < value.length && prefix.every((token, index) => value[index] === token);
}

// Walks `tokens` from `doc` as if `removedParent`'s member at `removedIndex` had already been
// removed, without materializing that document. Only the one container the removal came from can
// possibly change shape (a shorter array, with later indices shifted down by one); every other
// container along the walk is read exactly as `resolveExisting` reads it today.
function resolveExistingAfterRemoval(
  doc: JsonValue,
  tokens: readonly string[],
  removedParent: JsonValue,
  removedIndex: number | undefined,
): JsonValue {
  let current = doc;
  for (const token of tokens) {
    if (isArrayValue(current)) {
      const raw = parseArrayIndexToken(token);
      if (raw === undefined || raw === '-') {
        throw new Error(`array member does not exist: ${JSON.stringify(token)}`);
      }
      let length = current.length;
      let index = raw;
      if (current === removedParent && removedIndex !== undefined) {
        length -= 1;
        if (raw >= removedIndex) index = raw + 1;
      }
      if (raw >= length) throw new Error(`array member does not exist: ${JSON.stringify(token)}`);
      current = current[index]!;
    } else if (isObject(current)) {
      if (!Object.hasOwn(current, token)) throw new Error(`object member does not exist: ${token}`);
      current = current[token]!;
    } else {
      throw new Error('patch path traverses a primitive');
    }
  }
  return current;
}

// A `move` validates its add target against the document as it reads AFTER the source is
// removed (RFC-6902), since a same-array destination index can shift into or out of bounds.
// Re-deriving that post-removal document with a full-document structuredClone + adopted-engine
// apply + schema parse on every move operation would make an untrusted delta with many moves
// cost proportional to move-count times document size. Since removal can only change the shape of
// the one container it came from, that container is resolved once (by reference) and its effect
// is projected on the fly while walking the target path — no document-sized work per move.
function assertAddTargetAfterRemoval(
  doc: JsonValue,
  tokens: readonly string[],
  removeFrom: readonly string[],
): void {
  if (tokens.length === 0) return;
  const token = tokens.at(-1);
  if (token === undefined) throw new Error('root pointer has no parent');
  const removedParent = resolveExisting(doc, removeFrom.slice(0, -1));
  const removedLastToken = removeFrom.at(-1);
  const removedRawIndex =
    removedLastToken !== undefined && isArrayValue(removedParent)
      ? parseArrayIndexToken(removedLastToken)
      : undefined;
  const removedIndex = typeof removedRawIndex === 'number' ? removedRawIndex : undefined;

  const parent = resolveExistingAfterRemoval(doc, tokens.slice(0, -1), removedParent, removedIndex);
  if (isArrayValue(parent)) {
    const index = parseArrayIndexToken(token);
    const length =
      parent === removedParent && removedIndex !== undefined ? parent.length - 1 : parent.length;
    if (index === undefined || (index !== '-' && index > length)) {
      throw new Error(`invalid add array index: ${JSON.stringify(token)}`);
    }
  } else if (!isObject(parent)) {
    throw new Error('patch target parent is a primitive');
  }
}

function prepareEngineOperation(doc: JsonValue, operation: JsonPatch): Operation {
  const path = parseStatePointer(operation.path);
  if ('value' in operation) assertCanonicalStateValue(operation.value);
  switch (operation.op) {
    case 'add':
      assertAddTarget(doc, path);
      break;
    case 'replace':
    case 'test':
      assertExistingTarget(doc, path);
      break;
    case 'remove':
      assertExistingTarget(doc, path);
      break;
    case 'copy': {
      const from = parseStatePointer(operation.from);
      const value = structuredClone(resolveExisting(doc, from));
      assertAddTarget(doc, path);
      return { op: 'add', path: operation.path, value };
    }
    case 'move': {
      const from = parseStatePointer(operation.from);
      resolveExisting(doc, from);
      if (isStrictPrefix(from, path)) throw new Error('move source cannot contain its destination');
      assertAddTargetAfterRemoval(doc, path, from);
    }
  }
  return structuredClone(operation) as Operation;
}

export function applyStatePatch(state: JsonValue, delta: unknown): JsonValue {
  let parsedPatch: ReturnType<typeof JsonPatchArraySchema.safeParse>;
  try {
    parsedPatch = JsonPatchArraySchema.safeParse(delta);
  } catch (error) {
    throw new PatchError(`invalid state delta: ${formatUnknown(error)}`, -1);
  }
  if (!parsedPatch.success) {
    throw new PatchError(
      'invalid state delta: patch schema rejected',
      issueIndex(parsedPatch.error),
    );
  }
  const parsedState = JsonValueSchema.safeParse(state);
  if (!parsedState.success)
    throw new PatchError('invalid state delta: state is not canonical JSON', -1);

  let doc: JsonValue;
  try {
    assertCanonicalStateValue(parsedState.data);
    // Not a redundant defensive copy: JsonValueSchema wraps its output in zod
    // `.readonly()`, which freezes the parsed tree, and the adopted engine runs
    // with mutateDocument = true. Without this clone the first mutating
    // operation throws on a frozen object.
    doc = structuredClone(parsedState.data);
  } catch (error) {
    throw new PatchError(`invalid state delta: ${formatUnknown(error)}`, -1);
  }

  for (let index = 0; index < parsedPatch.data.length; index++) {
    const operation = parsedPatch.data[index]!;
    try {
      const engineOperation = prepareEngineOperation(doc, operation);
      doc = applyOperation(
        doc,
        engineOperation,
        /* validateOperation */ true,
        /* mutateDocument */ true,
        /* banPrototypeModifications */ true,
        index,
      ).newDocument;
      assertJsonResourceBudget(doc);
    } catch (error) {
      throw new PatchError(`invalid state delta: ${formatUnknown(error)}`, index);
    }
  }

  const result = JsonValueSchema.safeParse(doc);
  if (!result.success) {
    throw new PatchError(
      'invalid state delta: result is not canonical JSON',
      parsedPatch.data.length - 1,
    );
  }
  try {
    assertCanonicalStateValue(result.data);
  } catch (error) {
    throw new PatchError(
      `invalid state delta: ${formatUnknown(error)}`,
      parsedPatch.data.length - 1,
    );
  }
  return result.data;
}
