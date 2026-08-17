import { sanitize } from '@minitui/sanitizer';
import type { JsonValue, Pointer } from '@minitui/types';

export type { JsonValue, Pointer };

// Deliberately a third copy of this literal. `@minitui/sanitizer` keeps its own
// because it is a zero-dependency leaf that cannot import anything, and
// `@minitui/types`' RESERVED_JSON_KEYS is module-private, so consuming it would
// mean growing that package's public surface. Unifying is not free.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_POINTER_DEPTH = 256;

function unescape(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * The raw RFC-6901 tokenizer: no depth ceiling, no reserved-key check, no
 * canonical-key check. It is the barrel's public pointer primitive, for callers
 * doing pure pointer arithmetic. Every document-touching entry point here
 * (`getIn`, `setIn`, `removeIn`, and `applyStatePatch` in patch-apply.ts) routes
 * through the guarded `parseStatePointer` instead — never through this.
 */
export function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (pointer[0] !== '/') throw new Error(`invalid JSON pointer: ${pointer}`);
  return pointer.slice(1).split('/').map(unescape);
}

export function isArrayValue(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function isObject(
  value: JsonValue | undefined,
): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseArrayIndexToken(token: string): number | '-' | undefined {
  if (token === '-') return '-';
  if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
  const index = Number(token);
  return Number.isSafeInteger(index) ? index : undefined;
}

export function assertCanonicalStateKey(key: string): void {
  if (RESERVED_KEYS.has(key)) throw new Error(`reserved state key not allowed: ${key}`);
  if (sanitize(key) !== key) throw new Error(`state key is not canonical: ${JSON.stringify(key)}`);
}

/** The guarded parser every document-touching path uses: depth-capped, reserved-key
 *  and canonical-key checked. Module-private on purpose — see `parsePointer` above. */
export function parseStatePointer(pointer: string): string[] {
  let separators = 0;
  for (let index = 0; index < pointer.length; index++) {
    if (pointer.charCodeAt(index) === 0x2f && ++separators > MAX_POINTER_DEPTH) {
      throw new Error(`JSON pointer exceeds max depth ${MAX_POINTER_DEPTH}`);
    }
  }
  const tokens = parsePointer(pointer);
  if (tokens.length > MAX_POINTER_DEPTH) {
    throw new Error(`JSON pointer exceeds max depth ${MAX_POINTER_DEPTH}`);
  }
  for (const token of tokens) assertCanonicalStateKey(token);
  return tokens;
}

export function assertCanonicalStateValue(value: JsonValue): void {
  const pending: JsonValue[] = [value];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (isArrayValue(current)) {
      for (const item of current) pending.push(item);
    } else if (isObject(current)) {
      for (const [key, item] of Object.entries(current)) {
        assertCanonicalStateKey(key);
        pending.push(item);
      }
    }
  }
}

export function getIn(doc: JsonValue, pointer: string): JsonValue | undefined {
  const tokens = parseStatePointer(pointer);
  let current: JsonValue | undefined = doc;
  for (const token of tokens) {
    if (isArrayValue(current)) {
      const index = parseArrayIndexToken(token);
      if (index === undefined) throw new Error(`invalid array index: ${JSON.stringify(token)}`);
      current = index === '-' ? undefined : current[index];
    } else if (isObject(current)) {
      current = Object.hasOwn(current, token) ? current[token] : undefined;
    } else {
      return undefined;
    }
  }
  return current;
}

function setTokens(
  doc: JsonValue,
  tokens: readonly string[],
  offset: number,
  value: JsonValue,
): JsonValue {
  if (offset === tokens.length) return value;
  const token = tokens[offset];
  if (token === undefined) return value;
  if (isArrayValue(doc)) {
    const index = parseArrayIndexToken(token);
    if (index === undefined) throw new Error(`invalid array index: ${JSON.stringify(token)}`);
    const target = index === '-' ? doc.length : index;
    if (target > doc.length) {
      throw new Error(`array index out of range (would create a sparse hole): ${token}`);
    }
    const next = doc.slice();
    next[target] = setTokens(target < doc.length ? doc[target]! : null, tokens, offset + 1, value);
    return next;
  }
  const base = isObject(doc) ? doc : {};
  const child = Object.hasOwn(base, token) ? base[token]! : null;
  return { ...base, [token]: setTokens(child, tokens, offset + 1, value) };
}

export function setIn(doc: JsonValue, pointer: string, value: JsonValue): JsonValue {
  return setTokens(doc, parseStatePointer(pointer), 0, value);
}

function removeTokens(doc: JsonValue, tokens: readonly string[], offset: number): JsonValue {
  if (offset === tokens.length) return doc;
  const token = tokens[offset];
  if (token === undefined) return doc;
  const leaf = offset === tokens.length - 1;
  if (isArrayValue(doc)) {
    const index = parseArrayIndexToken(token);
    if (index === undefined) throw new Error(`invalid array index: ${JSON.stringify(token)}`);
    if (index === '-' || index >= doc.length) return doc;
    const next = doc.slice();
    if (leaf) {
      next.splice(index, 1);
    } else {
      next[index] = removeTokens(doc[index]!, tokens, offset + 1);
    }
    return next;
  }
  if (!isObject(doc) || !Object.hasOwn(doc, token)) return doc;
  if (leaf) {
    const { [token]: _removed, ...remaining } = doc;
    return remaining;
  }
  return { ...doc, [token]: removeTokens(doc[token]!, tokens, offset + 1) };
}

export function removeIn(doc: JsonValue, pointer: string): JsonValue {
  return removeTokens(doc, parseStatePointer(pointer), 0);
}
