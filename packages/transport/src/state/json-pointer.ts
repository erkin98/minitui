import type { JsonValue, Pointer } from '@minitui/types';
export type { JsonValue, Pointer }; // canonical owners are @minitui/types (§Z11); re-exported so transport keeps one import site AND one Pointer brand

function unescape(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (pointer[0] !== '/') throw new Error(`invalid JSON pointer: ${pointer}`);
  return pointer.slice(1).split('/').map(unescape);
}

// Typed guards over the READONLY JsonValue members: a bare Array.isArray narrows a
// `readonly JsonValue[]` union member to `any[]` (readonly arrays are not assignable
// to the guard's `any[]`), leaking `any` into every element access downstream.
export function isArrayValue(v: JsonValue | undefined): v is readonly JsonValue[] {
  return Array.isArray(v);
}

export function isObject(v: JsonValue | undefined): v is { [k: string]: JsonValue } {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Reserved keys (§Z100) — rejected on READ and WRITE so a pointer can never reach
// a prototype member (getIn '/constructor' → the live ctor) or write a key
// JsonValueSchema itself rejects. Own-property-only reads (below) cover every
// other inherited member (toString, …) as "missing".
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// PIN-DEPTH (fold): bounded fail-closed, not RangeError. setIn/removeIn recurse
// once per pointer token; 256 is far above any real state nesting and far below
// stack exhaustion, so an over-deep pointer is rejected before it can overflow.
const MAX_POINTER_DEPTH = 256;

// RFC-6901/6902 array-index token: a canonical non-negative integer (String(n)
// must round-trip — no leading '+'/'0'/'0x'/whitespace) or '-' (RFC-6902 append).
// Anything else is malformed → the caller rejects; NEVER Number()-coerce a
// malformed token (NaN → splice(0), '01' → wrong element, whitespace → coerced).
function arrayIndex(token: string): number | '-' | undefined {
  if (token === '-') return '-';
  if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
  const n = Number(token);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function getIn(doc: JsonValue, pointer: string): JsonValue | undefined {
  let cur: JsonValue | undefined = doc;
  for (const token of parsePointer(pointer)) {
    if (isArrayValue(cur)) {
      const idx = arrayIndex(token);
      if (idx === undefined) throw new Error(`invalid array index: ${JSON.stringify(token)}`);
      cur = idx === '-' ? undefined : cur[idx];
    } else if (isObject(cur)) {
      if (RESERVED_KEYS.has(token)) throw new Error(`reserved key not allowed: ${token}`);
      cur = Object.hasOwn(cur, token) ? cur[token] : undefined; // own-property only
    } else return undefined;
  }
  return cur;
}

function rejoin(rest: string[]): string {
  return rest.length
    ? '/' + rest.map((t) => t.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')
    : '';
}

export function setIn(doc: JsonValue, pointer: string, value: JsonValue): JsonValue {
  const tokens = parsePointer(pointer);
  if (tokens.length > MAX_POINTER_DEPTH)
    throw new Error(`JSON pointer exceeds max depth ${MAX_POINTER_DEPTH}`);
  if (tokens.length === 0) return value;
  const [head, ...rest] = tokens;
  if (head === undefined) return value;
  if (isArrayValue(doc)) {
    const idx = arrayIndex(head);
    if (idx === undefined) throw new Error(`invalid array index: ${JSON.stringify(head)}`);
    const target = idx === '-' ? doc.length : idx;
    if (target > doc.length)
      throw new Error(`array index out of range (would create a sparse hole): ${head}`);
    const next = doc.slice();
    next[target] = setIn(next[target] ?? null, rejoin(rest), value);
    return next;
  }
  const base = isObject(doc) ? doc : {};
  if (RESERVED_KEYS.has(head)) throw new Error(`reserved key not allowed: ${head}`);
  return { ...base, [head]: setIn(base[head] ?? null, rejoin(rest), value) };
}

export function removeIn(doc: JsonValue, pointer: string): JsonValue {
  const tokens = parsePointer(pointer);
  if (tokens.length > MAX_POINTER_DEPTH)
    throw new Error(`JSON pointer exceeds max depth ${MAX_POINTER_DEPTH}`);
  if (tokens.length === 0) return doc;
  const [head, ...rest] = tokens;
  if (head === undefined) return doc;
  if (isArrayValue(doc)) {
    const idx = arrayIndex(head);
    if (idx === undefined) throw new Error(`invalid array index: ${JSON.stringify(head)}`);
    if (idx === '-' || idx >= doc.length) return doc; // nothing to remove: no-op
    const next = doc.slice();
    if (rest.length === 0) {
      next.splice(idx, 1);
      return next;
    }
    next[idx] = removeIn(next[idx] ?? null, rejoin(rest));
    return next;
  }
  if (!isObject(doc)) return doc;
  if (RESERVED_KEYS.has(head)) throw new Error(`reserved key not allowed: ${head}`);
  if (!Object.hasOwn(doc, head)) return doc; // missing intermediate: no-op, never materialize null
  if (rest.length === 0) {
    const { [head]: _drop, ...keep } = doc;
    return keep;
  }
  return { ...doc, [head]: removeIn(doc[head] ?? null, rejoin(rest)) };
}
