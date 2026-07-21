import { describe, it, expect } from 'vitest';
import { parsePointer, getIn, setIn, removeIn } from '../src/state/json-pointer.js';

describe('json-pointer (RFC-6901)', () => {
  it('parses tokens and unescapes ~1 and ~0', () => {
    expect(parsePointer('/a/b')).toEqual(['a', 'b']);
    expect(parsePointer('/m~1n/o~0p')).toEqual(['m/n', 'o~p']);
    expect(parsePointer('')).toEqual([]);
  });

  it('getIn resolves nested values and returns undefined for missing', () => {
    const doc = { a: { b: [10, 20] } };
    expect(getIn(doc, '/a/b/1')).toBe(20);
    expect(getIn(doc, '/a/x')).toBeUndefined();
  });

  it('setIn returns a new doc and never mutates the input', () => {
    const doc = { a: { b: 1 } };
    const next = setIn(doc, '/a/b', 2) as { a: { b: number } };
    expect(next).toEqual({ a: { b: 2 } });
    expect(doc).toEqual({ a: { b: 1 } }); // original untouched
    expect(next).not.toBe(doc);
    expect(next.a).not.toBe(doc.a);
  });

  it('setIn creates intermediate objects for missing path segments', () => {
    expect(setIn({}, '/x/y', 5)).toEqual({ x: { y: 5 } });
  });

  it('removeIn drops a key immutably', () => {
    const doc = { a: 1, b: 2 };
    const next = removeIn(doc, '/b');
    expect(next).toEqual({ a: 1 });
    expect(doc).toEqual({ a: 1, b: 2 });
  });
});

// C05 + opus correctness-transport-state-01/02/04. PIN-POINTER: the pointer
// helpers reject malformed array tokens and reserved keys, never Number()-coerce
// to a wrong element, never materialize null on a missing remove, never write a
// sparse hole. A malformed pointer is a typed throw (this file's fail-closed
// contract — parsePointer already throws).
describe('json-pointer hardening (PIN-POINTER, C05)', () => {
  it('rejects a reserved-key read instead of returning the live constructor (state-01)', () => {
    expect(() => getIn({}, '/constructor')).toThrow(/reserved/i);
    expect(() => getIn({ a: {} }, '/a/constructor')).toThrow(/reserved/i);
    expect(() => getIn({}, '/__proto__')).toThrow(/reserved/i);
    expect(() => getIn({}, '/prototype')).toThrow(/reserved/i);
  });

  it('reads own properties only — an inherited member reads as missing, not the live fn', () => {
    expect(getIn({}, '/toString')).toBeUndefined();
    expect(getIn({}, '/hasOwnProperty')).toBeUndefined();
  });

  it('rejects malformed array-index reads (no Number() coercion) (state-04)', () => {
    const arr = ['zero', 'one', 'two'];
    expect(() => getIn(arr, '/01')).toThrow(/index/i); // leading zero
    expect(() => getIn(arr, '/ 1')).toThrow(/index/i); // whitespace
    expect(() => getIn(arr, '/+1')).toThrow(/index/i); // leading plus
    expect(() => getIn(arr, '/0x1')).toThrow(/index/i); // hex
    expect(() => getIn(arr, '/x')).toThrow(/index/i); // not a number
    // canonical index and out-of-bounds still behave
    expect(getIn(arr, '/1')).toBe('one');
    expect(getIn(arr, '/5')).toBeUndefined();
  });

  it('rejects a malformed removeIn index instead of splicing the wrong element (state-02)', () => {
    expect(() => removeIn(['a', 'b', 'c'], '/not-an-index')).toThrow(/index/i);
    expect(() => removeIn(['a', 'b', 'c'], '/-1')).toThrow(/index/i);
    expect(() => removeIn(['a', 'b', 'c'], '/01')).toThrow(/index/i);
    // a valid remove still works and an out-of-bounds one is a no-op
    expect(removeIn(['a', 'b', 'c'], '/1')).toEqual(['a', 'c']);
    expect(removeIn(['a', 'b', 'c'], '/9')).toEqual(['a', 'b', 'c']);
  });

  it('removeIn on a missing intermediate is a no-op, never materializes null', () => {
    expect(removeIn({ rows: {} }, '/rows/missing/value')).toEqual({ rows: {} });
    expect(removeIn({ a: 1 }, '/b/c')).toEqual({ a: 1 });
  });

  it('rejects a malformed setIn array index (no hidden non-index property)', () => {
    expect(() => setIn(['a', 'b', 'c'], '/not-an-index', 'hidden')).toThrow(/index/i);
  });

  it('rejects an out-of-range setIn array index (no sparse holes), but appends at length', () => {
    expect(() => setIn(['a', 'b', 'c'], '/5', 'x')).toThrow(/index/i);
    expect(setIn(['a'], '/1', 'b')).toEqual(['a', 'b']); // append at length
    expect(setIn(['a'], '/-', 'b')).toEqual(['a', 'b']); // RFC-6902 append token
  });

  it('rejects a reserved-key write on setIn and removeIn', () => {
    expect(() => setIn({}, '/constructor', 'evil')).toThrow(/reserved/i);
    expect(() => setIn({}, '/__proto__', 'evil')).toThrow(/reserved/i);
    expect(() => removeIn({}, '/constructor')).toThrow(/reserved/i);
  });

  it("treats '-' as a normal object key, not an array token", () => {
    expect(setIn({}, '/-', 5)).toEqual({ '-': 5 });
    expect(getIn({ '-': 5 }, '/-')).toBe(5);
    expect(removeIn({ '-': 5, x: 1 }, '/-')).toEqual({ x: 1 });
  });
});

// PIN-DEPTH (C07): the recursive walkers (setIn/removeIn recurse once per pointer
// token) fail CLOSED at a 256 ceiling with a typed throw, never an uncaught
// RangeError through the fail-closed boundary.
describe('json-pointer depth ceiling (PIN-DEPTH, C07)', () => {
  const deep = (n: number) => '/' + Array.from({ length: n }, () => 'a').join('/');

  it('setIn rejects an over-deep pointer with a typed throw, not a RangeError', () => {
    let err: unknown;
    try {
      setIn({}, deep(257), 1);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/depth/i);
    expect((err as Error).message).not.toMatch(/call stack/i);
  });

  it('removeIn rejects an over-deep pointer with a typed throw', () => {
    expect(() => removeIn({}, deep(257))).toThrow(/depth/i);
  });

  it('accepts a pointer at the 256 depth ceiling', () => {
    expect(() => setIn({}, deep(256), 1)).not.toThrow();
  });

  it('turns a would-be stack overflow into a clean typed throw', () => {
    // 50k tokens would blow the native stack (RangeError) without the ceiling.
    expect(() => setIn({}, deep(50000), 1)).toThrow(/depth/i);
    expect(() => removeIn({}, deep(50000))).toThrow(/depth/i);
  });
});
