import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  guardedRecord,
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
  it('rejects reserved own members, enumerable or not, and reports their path', () => {
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
  it('deep-freezes nested JsonValue containers', () => {
    const deepFrozen = (x: unknown): boolean =>
      typeof x !== 'object' || x === null
        ? true
        : Object.isFrozen(x) && Object.values(x).every(deepFrozen);
    expect(deepFrozen(JsonValueSchema.parse({ a: { b: [1, 2] }, c: ['x'] }))).toBe(true);
  });

  it('is total for unsupported and hostile object shapes without invoking accessors', () => {
    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get() {
        getterCalls++;
        return 1;
      },
    });
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('reflection denied');
        },
      },
    );
    class RecordLike {
      readonly value = 1;
    }
    const candidates: readonly unknown[] = [
      new Uint8Array([1]),
      Promise.resolve(1),
      new Date(0),
      new RecordLike(),
      accessor,
      hostile,
    ];
    for (const candidate of candidates) {
      expect(() => JsonValueSchema.safeParse(candidate)).not.toThrow();
      expect(JsonValueSchema.safeParse(candidate).success).toBe(false);
    }
    expect(getterCalls).toBe(0);
  });

  it('accepts only dense, data-property JSON trees and rejects repeated identity', () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    const symbolMember = { ok: 1 };
    Object.defineProperty(symbolMember, Symbol('hidden'), { value: 2, enumerable: true });
    const hiddenMember = { ok: 1 };
    Object.defineProperty(hiddenMember, 'hidden', { value: 2, enumerable: false });
    const shared = { leaf: 1 };
    const aliased = { left: shared, right: shared };
    for (const candidate of [sparse, symbolMember, hiddenMember, aliased]) {
      expect(() => JsonValueSchema.safeParse(candidate)).not.toThrow();
      expect(JsonValueSchema.safeParse(candidate).success).toBe(false);
    }
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(nullPrototype, 'safe', { value: [1, 2], enumerable: true });
    expect(JsonValueSchema.parse(nullPrototype)).toEqual({ safe: [1, 2] });
  });

  it('rejects non-finite numbers as non-JSON scalars', () => {
    expect(JsonValueSchema.safeParse(Number.NaN).success).toBe(false);
    expect(JsonValueSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });
});

describe('guardedRecord shallow-readonly contract', () => {
  it('freezes the parsed top record while preserving unknown value identity and mutability', () => {
    const nested = { mutable: true };
    const parsed = guardedRecord(z.unknown()).parse({ nested });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.nested).toBe(nested);
    expect(Object.isFrozen(nested)).toBe(false);
  });

  it('is total and descriptor-safe for hostile record inputs', () => {
    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get() {
        getterCalls++;
        return 1;
      },
    });
    const throwingProxy = new Proxy(
      { value: 1 },
      {
        getOwnPropertyDescriptor() {
          throw new Error('descriptor denied');
        },
      },
    );
    const schema = guardedRecord(z.unknown());
    for (const candidate of [accessor, throwingProxy, new Uint8Array([1]), Promise.resolve(1)]) {
      expect(() => schema.safeParse(candidate)).not.toThrow();
      expect(schema.safeParse(candidate).success).toBe(false);
    }
    expect(getterCalls).toBe(0);
  });
});

// Values beyond the nesting ceiling and cyclic graphs fail with validation
// issues rather than leaking RangeError through safeParse.
describe('JsonValue depth ceiling', () => {
  const nest = (depth: number): unknown => {
    let v: unknown = 0;
    for (let i = 0; i < depth; i++) v = { a: v };
    return v;
  };

  it('rejects an over-deep value with an issue instead of throwing RangeError', () => {
    const deep = nest(50_000);
    expect(() => JsonValueSchema.safeParse(deep)).not.toThrow();
    const r = JsonValueSchema.safeParse(deep);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /depth/i.test(i.message))).toBe(true);
  });

  it('rejects a cyclic value with an issue instead of hanging or throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => JsonValueSchema.safeParse(cyclic)).not.toThrow();
    expect(JsonValueSchema.safeParse(cyclic).success).toBe(false);
  });

  it('still accepts values nested within the ceiling (does not over-reject)', () => {
    // 200 is above any real spec/state nesting yet under the 256 ceiling.
    expect(JsonValueSchema.safeParse(nest(200)).success).toBe(true);
    // Boundary lock on the 256 constant: at the ceiling parses, one past rejects.
    expect(JsonValueSchema.safeParse(nest(256)).success).toBe(true);
    expect(JsonValueSchema.safeParse(nest(257)).success).toBe(false);
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
  it('accepts a malformed ~ escape by design under the loose partial brand', () => {
    // RFC-6901's ~0/~1 escape grammar is intentionally NOT enforced — locking the
    // Loose acceptance is part of this boundary's compatibility contract.
    expect(PointerSchema.safeParse('/bad~2escape').success).toBe(true);
    expect(PointerSchema.safeParse('/trailing~').success).toBe(true);
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
