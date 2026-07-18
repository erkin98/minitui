import { describe, it, expect } from 'vitest';
import {
  JsonValueSchema,
  PointerSchema,
  JsonPatchSchema,
  JsonPatchArraySchema,
  type JsonValue,
  type Pointer,
  type JsonPatch,
} from '../src/pointer.js';

describe('JsonValue', () => {
  it('accepts nested objects, arrays, primitives and null', () => {
    const v: JsonValue = { a: [1, 'x', true, null], b: { c: 2 } };
    expect(JsonValueSchema.parse(v)).toEqual(v);
  });
  it('rejects undefined and functions', () => {
    expect(JsonValueSchema.safeParse(undefined).success).toBe(false);
    expect(JsonValueSchema.safeParse(() => 1).success).toBe(false);
  });
  it('rejects an own __proto__/constructor/prototype member — enumerable or not — and names it in issue.path (ledger §Z100 AMEND)', () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":1},"safe":2}');
    const r = JsonValueSchema.safeParse(hostile);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes('__proto__'))).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JsonValueSchema.safeParse(JSON.parse('{"a":{"constructor":1}}')).success).toBe(false);
    expect(JsonValueSchema.safeParse(JSON.parse('{"prototype":1}')).success).toBe(false);
    // NON-enumerable own key: Object.keys misses it, Reflect.ownKeys catches it.
    const sneaky: Record<string, unknown> = { safe: 1 };
    Object.defineProperty(sneaky, 'constructor', {
      value: 1,
      enumerable: false,
      configurable: true,
    });
    const r2 = JsonValueSchema.safeParse(sneaky);
    expect(r2.success).toBe(false);
    if (!r2.success) expect(r2.error.issues.some((i) => i.path.includes('constructor'))).toBe(true);
    // Positive control: a legit dynamic key is accepted (the guard doesn't over-reject).
    expect(JsonValueSchema.safeParse({ safe: 1, click: 'ok' }).success).toBe(true);
  });
  it('JsonValueSchema deep-freezes nested containers (ledger §Z100)', () => {
    const deepFrozen = (x: unknown): boolean =>
      typeof x !== 'object' || x === null
        ? true
        : Object.isFrozen(x) && Object.values(x).every(deepFrozen);
    expect(deepFrozen(JsonValueSchema.parse({ a: { b: [1, 2] }, c: ['x'] }))).toBe(true);
  });
});

describe('Pointer', () => {
  it('accepts the empty pointer and rooted slash paths', () => {
    expect(PointerSchema.parse('')).toBe('');
    expect(PointerSchema.parse('/inputs/0')).toBe('/inputs/0');
  });
  it('rejects a path that does not start with a slash', () => {
    expect(PointerSchema.safeParse('inputs/0').success).toBe(false);
  });
  it('brands the parsed value so it is assignable to Pointer', () => {
    const p: Pointer = PointerSchema.parse('/merge/progress');
    expect(p).toBe('/merge/progress');
  });
});

describe('JsonPatch (RFC-6902)', () => {
  it('accepts add/replace/remove/move/copy/test ops', () => {
    const ops: JsonPatch[] = [
      { op: 'add', path: '/a', value: 1 },
      { op: 'replace', path: '/a', value: 2 },
      { op: 'remove', path: '/a' },
      { op: 'move', from: '/a', path: '/b' },
      { op: 'copy', from: '/b', path: '/c' },
      { op: 'test', path: '/c', value: 2 },
    ];
    expect(JsonPatchArraySchema.parse(ops)).toEqual(ops);
  });
  it('rejects an unknown op and a move without from', () => {
    expect(JsonPatchSchema.safeParse({ op: 'frobnicate', path: '/a' }).success).toBe(false);
    expect(JsonPatchSchema.safeParse({ op: 'move', path: '/b' }).success).toBe(false);
  });
});
