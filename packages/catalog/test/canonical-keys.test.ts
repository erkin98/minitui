import { describe, it, expect } from 'vitest';
import { hasCanonicalKeys } from '../src/sanitize/index.js';

const ESC = '\u001b';

describe('hasCanonicalKeys', () => {
  it('accepts plain ASCII keys', () => {
    expect(
      hasCanonicalKeys({ root: 'a', elements: { a: { type: 'Box', props: { width: 3 } } } }),
    ).toBe(true);
  });

  it('accepts keys in other scripts, keys with tab, CR or LF, and keys with zero-width and bidi characters', () => {
    expect(hasCanonicalKeys({ Да: 1, 漢字: 2 })).toBe(true);
    expect(hasCanonicalKeys({ 'a\tb': 1, 'c\rd': 2, 'e\nf': 3 })).toBe(true);
    expect(hasCanonicalKeys({ 'a​b': 1, 'c‮d': 2 })).toBe(true);
  });

  it('refuses a key holding an escape sequence and a NUL in a nested key', () => {
    expect(hasCanonicalKeys({ [`${ESC}[31mred`]: 1 })).toBe(false);
    expect(hasCanonicalKeys({ outer: { inner: [{ ['a\u0000b']: 1 }] } })).toBe(false);
  });

  it('refuses a reserved key', () => {
    expect(hasCanonicalKeys(JSON.parse('{"__proto__":{"x":1}}'))).toBe(false);
  });

  it('refuses a cyclic value', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(hasCanonicalKeys(cyclic)).toBe(false);
  });

  it('refuses a 20-level shared-reference graph and returns', () => {
    let level: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i++) level = { a: level, b: level };
    expect(hasCanonicalKeys(level)).toBe(false);
  });
});
