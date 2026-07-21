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
