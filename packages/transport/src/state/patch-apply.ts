import fastJsonPatch, { type Operation } from 'fast-json-patch';
import { JsonPatchArraySchema, JsonValueSchema, type JsonPatch } from '@minitui/types';
import { formatUnknown } from '../format-unknown.js';
import {
  assertCanonicalStateValue,
  isArrayValue,
  isObject,
  parseArrayIndexToken,
  parseStatePointer,
  type JsonValue,
} from './json-pointer.js';

const { applyOperation, deepClone } = fastJsonPatch;

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

function resolveExisting(doc: JsonValue, tokens: readonly string[]): JsonValue {
  let current = doc;
  for (const token of tokens) {
    if (isArrayValue(current)) {
      const index = parseArrayIndexToken(token);
      if (index === undefined || index === '-' || index >= current.length) {
        throw new Error(`array member does not exist: ${JSON.stringify(token)}`);
      }
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
  if (isArrayValue(parent)) {
    const index = parseArrayIndexToken(token);
    if (index === undefined || index === '-' || index >= parent.length) {
      throw new Error(`array member does not exist: ${JSON.stringify(token)}`);
    }
  } else if (isObject(parent)) {
    if (!Object.hasOwn(parent, token)) throw new Error(`object member does not exist: ${token}`);
  } else {
    throw new Error('patch target parent is a primitive');
  }
}

function isStrictPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  return prefix.length < value.length && prefix.every((token, index) => value[index] === token);
}

function preflight(doc: JsonValue, operation: JsonPatch): void {
  const path = parseStatePointer(operation.path);
  if ('value' in operation) assertCanonicalStateValue(operation.value);
  switch (operation.op) {
    case 'add':
      assertAddTarget(doc, path);
      return;
    case 'replace':
    case 'test':
      assertExistingTarget(doc, path);
      return;
    case 'remove':
      assertExistingTarget(doc, path, false);
      return;
    case 'copy': {
      const from = parseStatePointer(operation.from);
      resolveExisting(doc, from);
      assertAddTarget(doc, path);
      return;
    }
    case 'move': {
      const from = parseStatePointer(operation.from);
      resolveExisting(doc, from);
      if (isStrictPrefix(from, path)) throw new Error('move source cannot contain its destination');
      assertAddTarget(doc, path);
    }
  }
}

export function applyStatePatch(state: JsonValue, delta: unknown): JsonValue {
  const parsedPatch = JsonPatchArraySchema.safeParse(delta);
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
    doc = deepClone(parsedState.data) as JsonValue;
  } catch (error) {
    throw new PatchError(`invalid state delta: ${formatUnknown(error)}`, -1);
  }

  for (let index = 0; index < parsedPatch.data.length; index++) {
    const operation = parsedPatch.data[index]!;
    try {
      preflight(doc, operation);
      doc = applyOperation(
        doc,
        deepClone(operation) as Operation,
        true,
        true,
        true,
        index,
      ).newDocument;
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
