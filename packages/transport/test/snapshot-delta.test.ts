import { describe, it, expect } from 'vitest';
import { sanitizeStrings, foldSnapshot, foldDelta } from '../src/state/snapshot-delta.js';
import type { JsonValue } from '../src/state/json-pointer.js';

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
    expect(() => foldSnapshot(JSON.parse('{"__proto__":{"x":1},"a":2}'))).toThrow(/key/i);
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
    expect(() => foldSnapshot(nested(400))).toThrow(/nesting depth/);
    // and via an over-deep delta value too
    expect(() => foldDelta({}, [{ op: 'add', path: '/x', value: nested(400) }])).toThrow(
      /nesting depth/,
    );
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
