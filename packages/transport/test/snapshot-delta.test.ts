import { describe, it, expect } from 'vitest';
import { sanitizeStrings, foldSnapshot, foldDelta } from '../src/state/snapshot-delta.js';
import type { JsonValue } from '../src/state/json-pointer.js';
import { PatchError } from '../src/state/patch-apply.js';

function nested(n: number): JsonValue {
  let v: JsonValue = { leaf: 'x' };
  for (let i = 0; i < n; i++) v = { next: v };
  return v;
}

// snapshot-delta imports @minitui/sanitizer directly so the chokepoint is
// machine-checkable, not an injected closure. These tests drive the REAL sanitizer:
// raw model ANSI/CSI bytes must never survive the transport state-seam.
const ESC = '\u001b'; // real ESC byte (0x1b), the CSI introducer the sanitizer strips

describe('snapshot-delta sanitize ingress', () => {
  it('deep-strips model ANSI from every string value in a snapshot, immutably', () => {
    const snap = { title: `${ESC}[31mhi${ESC}[0m`, nested: { name: `x${ESC}[1my` }, n: 5 };
    const out = foldSnapshot(snap);
    expect(out).toEqual({ title: 'hi', nested: { name: 'xy' }, n: 5 }); // CSI stripped at every depth
    expect(snap.title).toBe(`${ESC}[31mhi${ESC}[0m`); // input untouched
  });

  it('sanitizeStrings cleans string leaves and leaves non-strings alone', () => {
    expect(sanitizeStrings([1, true, null, `a${ESC}[0mb`])).toEqual([1, true, null, 'ab']);
  });

  it('foldDelta strips ANSI from add/replace string values before applying', () => {
    const next = foldDelta({ label: '' }, [
      { op: 'replace', path: '/label', value: `evil${ESC}[5mx` },
    ]);
    expect(next).toEqual({ label: 'evilx' }); // CSI gone after fold
  });

  it('foldDelta passes non-string delta values through unchanged', () => {
    const next = foldDelta({ progress: 0 }, [{ op: 'replace', path: '/progress', value: 73 }]);
    expect(next).toEqual({ progress: 73 });
  });

  it('rejects reserved state keys rather than copying or rewriting identity', () => {
    expect(() => foldSnapshot(JSON.parse('{"__proto__":{"x":1},"a":2}'))).toThrow(
      'state snapshot is not canonical JSON',
    );
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('rejects state keys that sanitization would rewrite', () => {
    expect(() => foldSnapshot({ [`na${ESC}[31mme`]: 'value' })).toThrow(/canonical/i);
  });

  it('exports a one-argument boundary that ignores attempted depth injection', () => {
    expect(sanitizeStrings.length).toBe(1);
    expect(() => Reflect.apply(sanitizeStrings, undefined, [nested(400), -1000])).toThrow(
      /nesting depth/,
    );
  });

  it('fails closed with a typed error past the depth ceiling', () => {
    // within the 256-level ceiling: a normal deep document is cleaned without complaint
    expect(() => foldSnapshot(nested(200))).not.toThrow();
    // beyond it: a clean typed rejection the store can catch and drop, not an uncaught stack crash
    expect(() => sanitizeStrings(nested(400))).toThrow(/nesting depth/);
    // the public folds read the schema first, which rejects the over-deep value before the walk
    expect(() => foldSnapshot(nested(400))).toThrow('state snapshot is not canonical JSON');
    // and an over-deep delta value fails as the indexed patch error of the patch engine
    try {
      foldDelta({}, [{ op: 'add', path: '/x', value: nested(400) }]);
      throw new Error('expected a patch error');
    } catch (error) {
      expect(error).toBeInstanceOf(PatchError);
      expect((error as PatchError).message).toBe('invalid state delta: patch schema rejected');
      expect((error as PatchError).opIndex).toBe(0);
    }
    // the thrown error is not the raw stack RangeError
    try {
      sanitizeStrings(nested(400));
    } catch (e) {
      expect(e).not.toBeInstanceOf(RangeError);
    }
  });

  it('sanitizes a `test`-op value on the same footing as stored state so a precondition still matches', () => {
    // Canonical state is always stored sanitized. A `test` precondition carrying the same raw wire
    // bytes must therefore be sanitized too, or it could never match its own (already-stripped)
    // state — the RFC-6902 comparison stays consistent, and the guarded `replace` proceeds.
    const next = foldDelta({ x: 'red' }, [
      { op: 'test', path: '/x', value: `red${ESC}[0m` },
      { op: 'replace', path: '/x', value: 'green' },
    ]);
    expect(next).toEqual({ x: 'green' });
  });
});

// The public folds read their argument through the canonical-JSON schema BEFORE any walk, so a value
// that is not plain JSON (an accessor, a Date, an own __proto__ key) is refused without being invoked
// or traversed, and a bad delta fails as the same indexed patch error the patch engine raises.
describe('public folds canonicalise before they sanitise', () => {
  const NOT_CANONICAL = 'state snapshot is not canonical JSON';

  function accessorObject(): { value: unknown; calls: () => number } {
    let calls = 0;
    const value: unknown = Object.defineProperty({}, 'trap', {
      enumerable: true,
      get() {
        calls++;
        return 1;
      },
    });
    return { value, calls: () => calls };
  }

  it('foldSnapshot rejects a Date and an accessor object without invoking the accessor', () => {
    const date: unknown = new Date(0);
    expect(() => Reflect.apply(foldSnapshot, undefined, [date])).toThrow(NOT_CANONICAL);
    const { value, calls } = accessorObject();
    expect(() => Reflect.apply(foldSnapshot, undefined, [value])).toThrow(NOT_CANONICAL);
    expect(calls()).toBe(0);
  });

  it('foldSnapshot refuses an own __proto__ key with the fixed message', () => {
    const hostile: unknown = JSON.parse('{"__proto__":{}}');
    expect(() => Reflect.apply(foldSnapshot, undefined, [hostile])).toThrow(
      new Error(NOT_CANONICAL),
    );
  });

  it('foldDelta does not invoke an accessor in a delta value', () => {
    const { value, calls } = accessorObject();
    const delta: unknown = [{ op: 'add', path: '/x', value }];
    expect(() => Reflect.apply(foldDelta, undefined, [{}, delta])).toThrow(PatchError);
    expect(calls()).toBe(0);
  });

  it('foldDelta fails a delta that is not an array as a patch error at index -1', () => {
    const notAnArray: unknown = { op: 'add', path: '/x', value: 1 };
    try {
      Reflect.apply(foldDelta, undefined, [{}, notAnArray]);
      throw new Error('expected a patch error');
    } catch (error) {
      expect(error).toBeInstanceOf(PatchError);
      expect((error as PatchError).opIndex).toBe(-1);
    }
  });

  it('foldDelta fails a bad member as a patch error at its own index', () => {
    const delta: unknown = [{ op: 'add', path: '/x', value: 1 }, null];
    try {
      Reflect.apply(foldDelta, undefined, [{}, delta]);
      throw new Error('expected a patch error');
    } catch (error) {
      expect(error).toBeInstanceOf(PatchError);
      expect((error as PatchError).opIndex).toBe(1);
    }
  });

  it('still strips escape text from a plain snapshot and a three-operation delta', () => {
    expect(foldSnapshot({ a: `x${ESC}[31my` })).toEqual({ a: 'xy' });
    const next = foldDelta({ a: '', b: [1] }, [
      { op: 'replace', path: '/a', value: `p${ESC}[0mq` },
      { op: 'add', path: '/b/-', value: 2 },
      { op: 'add', path: '/c', value: `r${ESC}[1ms` },
    ]);
    expect(next).toEqual({ a: 'pq', b: [1, 2], c: 'rs' });
  });

  it('keeps copy and move results and returns the state for an empty delta', () => {
    expect(foldDelta({ a: 1 }, [{ op: 'copy', from: '/a', path: '/b' }])).toEqual({ a: 1, b: 1 });
    expect(foldDelta({ a: 1 }, [{ op: 'move', from: '/a', path: '/b' }])).toEqual({ b: 1 });
    expect(foldDelta({ a: 1 }, [])).toEqual({ a: 1 });
  });
});

// The state-depth ceiling is 256 levels, counted to the deepest value (nested(n) puts its leaf string
// n + 1 levels below the root).
describe('transport state depth ceiling', () => {
  it('accepts a document whose deepest value sits at depth 256', () => {
    expect(() => sanitizeStrings(nested(255))).not.toThrow();
    expect(() => foldSnapshot(nested(255))).not.toThrow();
  });

  it('rejects a document whose deepest value sits at depth 257', () => {
    expect(() => sanitizeStrings(nested(256))).toThrow(/nesting depth/);
  });
});
