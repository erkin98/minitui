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

export function getIn(doc: JsonValue, pointer: string): JsonValue | undefined {
  let cur: JsonValue | undefined = doc;
  for (const token of parsePointer(pointer)) {
    if (isArrayValue(cur)) cur = cur[Number(token)];
    else if (isObject(cur)) cur = cur[token];
    else return undefined;
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
  if (tokens.length === 0) return value;
  const [head, ...rest] = tokens;
  if (head === undefined) return value;
  if (isArrayValue(doc)) {
    const next = doc.slice();
    const idx = Number(head);
    next[idx] = setIn(next[idx] ?? null, rejoin(rest), value);
    return next;
  }
  const base = isObject(doc) ? doc : {};
  return { ...base, [head]: setIn(base[head] ?? null, rejoin(rest), value) };
}

export function removeIn(doc: JsonValue, pointer: string): JsonValue {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0) return doc;
  const [head, ...rest] = tokens;
  if (head === undefined) return doc;
  if (isArrayValue(doc)) {
    const next = doc.slice();
    const idx = Number(head);
    if (rest.length === 0) {
      next.splice(idx, 1);
      return next;
    }
    next[idx] = removeIn(next[idx] ?? null, rejoin(rest));
    return next;
  }
  if (!isObject(doc)) return doc;
  if (rest.length === 0) {
    const { [head]: _drop, ...keep } = doc;
    return keep;
  }
  return { ...doc, [head]: removeIn(doc[head] ?? null, rejoin(rest)) };
}
