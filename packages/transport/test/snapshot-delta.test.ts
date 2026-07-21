import { describe, it, expect } from 'vitest';
import { sanitizeStrings, foldSnapshot, foldDelta } from '../src/state/snapshot-delta.js';

// snapshot-delta imports @minitui/sanitizer DIRECTLY (§Z11) — the chokepoint is
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

  it('builds own data properties so a JSON-parsed __proto__ key cannot pollute the clone prototype (§Z100)', () => {
    // Positive control for the defense-in-depth safe clone: a raw model object carrying an own
    // `__proto__` key must clone into OWN data properties, never through the prototype setter.
    const out = foldSnapshot(JSON.parse('{"__proto__":{"x":1},"a":2}')) as Record<string, unknown>;
    const proto: unknown = Object.getPrototypeOf(out);
    expect(proto === Object.prototype || proto === null).toBe(true); // prototype not swapped
    expect(out.x).toBeUndefined(); // no inherited pollution on the clone
    expect(({} as Record<string, unknown>).x).toBeUndefined(); // global Object.prototype clean
  });
});
