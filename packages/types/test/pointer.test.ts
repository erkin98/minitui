import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  assertJsonResourceBudget,
  guardedRecord,
  JSON_RESOURCE_LIMITS,
  JsonObjectSchema,
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

describe('JsonValue resource budgets', () => {
  it('exports one frozen canonical budget and checks canonical values without freezing them', () => {
    expect(JSON_RESOURCE_LIMITS).toEqual({
      maxDepth: 256,
      maxNodes: 65_536,
      maxStringCodeUnits: 1_048_576,
      maxPatchOperations: 256,
    });
    expect(Object.isFrozen(JSON_RESOURCE_LIMITS)).toBe(true);
    const value: JsonValue = { mutable: [1] };
    assertJsonResourceBudget(value);
    expect(Object.isFrozen(value)).toBe(false);
  });

  it('checks exact and over-limit node, string, and depth budgets without freezing input', () => {
    const exactNodes: JsonValue = Array.from(
      { length: JSON_RESOURCE_LIMITS.maxNodes - 1 },
      () => null,
    );
    const overNodes: JsonValue = Array.from({ length: JSON_RESOURCE_LIMITS.maxNodes }, () => null);
    const exactStrings: JsonValue = {
      value: 'x'.repeat(JSON_RESOURCE_LIMITS.maxStringCodeUnits - 'value'.length),
    };
    const overStrings: JsonValue = {
      value: 'x'.repeat(JSON_RESOURCE_LIMITS.maxStringCodeUnits - 'value'.length + 1),
    };
    const nest = (depth: number): JsonValue => {
      let value: JsonValue = null;
      for (let index = 0; index < depth; index++) value = [value];
      return value;
    };
    const exactDepth = nest(JSON_RESOURCE_LIMITS.maxDepth);
    const overDepth = nest(JSON_RESOURCE_LIMITS.maxDepth + 1);

    expect(() => assertJsonResourceBudget(exactNodes)).not.toThrow();
    expect(() => assertJsonResourceBudget(overNodes)).toThrow(/max node count/i);
    expect(() => assertJsonResourceBudget(exactStrings)).not.toThrow();
    expect(() => assertJsonResourceBudget(overStrings)).toThrow(/max string code units/i);
    expect(() => assertJsonResourceBudget(exactDepth)).not.toThrow();
    expect(() => assertJsonResourceBudget(overDepth)).toThrow(/max depth/i);
    expect(Object.isFrozen(exactNodes)).toBe(false);
    expect(Object.isFrozen(exactStrings)).toBe(false);
    expect(Object.isFrozen(exactDepth)).toBe(false);
  });

  it('throws when an already-parsed tree aliases the same node twice', () => {
    // A node reachable by two paths is the alias case the cycle guard exists to
    // catch; assertJsonResourceBudget runs on mutated canonical documents where
    // that can arise without a self-referential cycle.
    const shared: JsonValue = { leaf: 1 };
    const aliased: JsonValue = { left: shared, right: shared };
    expect(() => assertJsonResourceBudget(aliased)).toThrow(
      'JsonValue must be a tree without cycles or aliases',
    );
  });

  it('accepts the exact node ceiling and rejects one additional node', () => {
    expect(JsonValueSchema.safeParse(Array.from({ length: 65_535 }, () => null)).success).toBe(
      true,
    );
    expect(JsonValueSchema.safeParse(Array.from({ length: 65_536 }, () => null)).success).toBe(
      false,
    );
  });

  it('accepts the exact object string budget and rejects one additional code unit', () => {
    const exact = 'x'.repeat(JSON_RESOURCE_LIMITS.maxStringCodeUnits - 'value'.length);
    expect(JsonObjectSchema.safeParse({ value: exact }).success).toBe(true);
    expect(JsonObjectSchema.safeParse({ value: `${exact}x` }).success).toBe(false);
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

  it('rejects more than 256 operations before reflecting patch members', () => {
    let ownKeysCalls = 0;
    const oversized = new Proxy(
      Array.from({ length: 257 }, () => ({ op: 'test' as const, path: '', value: null })),
      {
        ownKeys() {
          ownKeysCalls += 1;
          throw new Error('members must not be reflected');
        },
      },
    );

    const result = JsonPatchArraySchema.safeParse(oversized);
    expect(result.success).toBe(false);
    expect(ownKeysCalls).toBe(0);
    expect(
      JsonPatchArraySchema.safeParse(
        Array.from({ length: 256 }, () => ({ op: 'test' as const, path: '', value: null })),
      ).success,
    ).toBe(true);
  });

  it('shares exact string and node budgets across every patch operation', () => {
    const twoOperationStringOverhead =
      2 * ('op'.length + 'add'.length + 'path'.length + 'value'.length);
    const halfStringBudget = 'x'.repeat(
      (JSON_RESOURCE_LIMITS.maxStringCodeUnits - twoOperationStringOverhead) / 2,
    );
    expect(
      JsonPatchArraySchema.safeParse([
        { op: 'add', path: '', value: halfStringBudget },
        { op: 'add', path: '', value: halfStringBudget },
      ]).success,
    ).toBe(true);
    expect(
      JsonPatchArraySchema.safeParse([
        { op: 'add', path: '', value: halfStringBudget },
        { op: 'add', path: '', value: `${halfStringBudget}x` },
      ]).success,
    ).toBe(false);

    const left = Array.from({ length: 32_763 }, () => null);
    const exactRight = Array.from({ length: 32_764 }, () => null);
    const overRight = Array.from({ length: 32_765 }, () => null);
    expect(
      JsonPatchArraySchema.safeParse([
        { op: 'add', path: '/left', value: left },
        { op: 'add', path: '/right', value: exactRight },
      ]).success,
    ).toBe(true);
    expect(
      JsonPatchArraySchema.safeParse([
        { op: 'add', path: '/left', value: left },
        { op: 'add', path: '/right', value: overRight },
      ]).success,
    ).toBe(false);
  });

  it('retains the operation index when operation reflection fails', () => {
    const hostileOperation = new Proxy<Record<string, unknown>>(
      {},
      {
        getPrototypeOf() {
          throw new Error('operation reflection denied');
        },
      },
    );
    const result = JsonPatchArraySchema.safeParse([hostileOperation]);

    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some((issue) => issue.path[0] === 0)).toBe(true);
  });

  // The patch cloner's five structural reject branches. Each is reachable from an
  // ordinary hand-built hostile value, so each is asserted on the message it emits
  // rather than on a generic failure — a branch asserted only as "rejects somehow"
  // stays green when a neighbouring branch swallows it.
  const rejectionMessages = (patch: unknown): readonly string[] => {
    const result = JsonPatchArraySchema.safeParse(patch);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };
  const dataSlot = (value: unknown): PropertyDescriptor => ({
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  const operation = { op: 'test', path: '', value: null };

  it('rejects an operation carrying a reserved or symbol key', () => {
    const reservedKey = { ...operation };
    Object.defineProperty(reservedKey, '__proto__', dataSlot(1));
    expect(rejectionMessages([reservedKey])).toContain('JSON patch operation has an invalid key');

    const symbolKey = { ...operation };
    Object.defineProperty(symbolKey, Symbol('extra'), dataSlot(1));
    expect(rejectionMessages([symbolKey])).toContain('JSON patch operation has an invalid key');
  });

  it('rejects a patch that is not an ordinary array', () => {
    expect(rejectionMessages({ 0: operation, length: 1 })).toContain(
      'JSON patch must be an ordinary array',
    );

    const detachedPrototype = [operation];
    Object.setPrototypeOf(detachedPrototype, null);
    expect(rejectionMessages(detachedPrototype)).toContain('JSON patch must be an ordinary array');
  });

  it('rejects a patch whose length slot is not a non-negative safe integer', () => {
    const negativeLength = new Proxy([operation], {
      getOwnPropertyDescriptor(target, key): PropertyDescriptor | undefined {
        if (key === 'length') {
          return { value: -1, writable: true, enumerable: false, configurable: false };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    expect(rejectionMessages(negativeLength)).toContain('JSON patch array has an invalid length');
  });

  it('rejects a patch array carrying a member that is not a canonical index', () => {
    const namedMember = [operation];
    Object.defineProperty(namedMember, 'extra', dataSlot(operation));
    expect(rejectionMessages(namedMember)).toContain('JSON patch array has a non-index member');

    const symbolMember = [operation];
    Object.defineProperty(symbolMember, Symbol('extra'), dataSlot(operation));
    expect(rejectionMessages(symbolMember)).toContain('JSON patch array has a non-index member');
  });

  it('rejects a sparse patch array', () => {
    // Defining index 1 on an empty array raises length to 2 without creating index 0,
    // so the member count trails the declared length.
    const sparse: unknown[] = [];
    Object.defineProperty(sparse, '1', dataSlot(operation));

    expect(rejectionMessages(sparse)).toContain('JSON patch array must be dense');
  });

  // The patch cloner's four remaining reject branches. Two are reachable from an
  // ordinary hand-built value (a non-enumerable operation slot; an operation with
  // a non-plain prototype); two only fire when a reflection trap throws mid-clone.
  // Each asserts its own message, since a branch checked only for generic failure
  // stays green when a neighbour swallows the parse.
  it('rejects an operation carrying a non-enumerable data slot', () => {
    const nonEnumerableSlot = { op: 'test', path: '' };
    Object.defineProperty(nonEnumerableSlot, 'value', {
      value: null,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    expect(rejectionMessages([nonEnumerableSlot])).toContain(
      'JSON patch operation requires enumerable data properties',
    );
  });

  it('rejects an operation with a non-plain prototype', () => {
    class ExoticOperation {
      op = 'remove';
      path = '';
    }
    expect(rejectionMessages([new ExoticOperation()])).toContain(
      'JSON patch operation must be a plain record',
    );
  });

  it('rejects a patch array whose member descriptor read throws', () => {
    const memberReflectionThrows = new Proxy([operation], {
      getOwnPropertyDescriptor(target, key): PropertyDescriptor | undefined {
        if (key === 'length') return Reflect.getOwnPropertyDescriptor(target, key);
        throw new Error('member descriptor denied');
      },
    });
    expect(rejectionMessages(memberReflectionThrows)).toContain(
      'JSON patch array member reflection failed',
    );
  });

  it('rejects a patch array whose top-level reflection throws', () => {
    const arrayReflectionThrows = new Proxy([operation], {
      getPrototypeOf() {
        throw new Error('array prototype denied');
      },
    });
    expect(rejectionMessages(arrayReflectionThrows)).toContain(
      'JSON patch array reflection failed',
    );
  });

  it('retains the array index without invoking an accessor-backed slot', () => {
    let getterCalls = 0;
    const hostileSlot: unknown[] = [];
    Object.defineProperty(hostileSlot, '0', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('slot access denied');
      },
    });
    const result = JsonPatchArraySchema.safeParse(hostileSlot);

    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some((issue) => issue.path[0] === 0)).toBe(true);
    expect(getterCalls).toBe(0);
  });
});
