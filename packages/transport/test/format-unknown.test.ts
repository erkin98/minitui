import { describe, it, expect } from 'vitest';
import { formatUnknown } from '../src/format-unknown.js';

// The total formatter for caught-unknown diagnostics: it must never throw and must
// always return a string — including when a value is observed more than once.
describe('formatUnknown', () => {
  it('returns an Error message', () => {
    expect(formatUnknown(new Error('boom'))).toBe('boom');
  });

  it('stringifies a non-Error', () => {
    expect(formatUnknown(42)).toBe('42');
    expect(formatUnknown('bare')).toBe('bare');
  });

  it('stays a string under a non-idempotent Error message getter (single observation)', () => {
    const e = new Error('init');
    let reads = 0;
    Object.defineProperty(e, 'message', {
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? 'first' : 42; // flips to a non-string on the second read
      },
    });
    const out = formatUnknown(e);
    expect(typeof out).toBe('string');
    expect(out).toBe('first'); // the one observed value, not the flipped non-string
  });

  it('falls back when primitive conversion throws', () => {
    const hostile = {
      [Symbol.toPrimitive]() {
        throw new Error('no');
      },
    };
    expect(formatUnknown(hostile, 'fallback')).toBe('fallback');
  });
});
