import { describe, it, expect } from 'vitest';
import { CSI_SEQUENCE_SOURCE } from '../src/ansi.js';
import { escEscapeEnd, isIntroducer, sequenceEnd } from '../src/stream-grammar.js';
import { INK_BYTE_CLASSES, INK_INTRODUCERS, INK_TERMINATORS, inClass } from './ink-grammar.js';

const ESC = '\x1b';

// Drift gate. Every byte class this package uses is diffed, byte by byte across
// the whole 0x00-0xff space, against the vendored copy of ink's tokenizer
// classes. Widening or narrowing any class on either side reds this file.
// See ink-grammar.ts for why the reference is vendored rather than imported.

function csiMatchLength(text: string): number | undefined {
  const sticky = new RegExp(CSI_SEQUENCE_SOURCE, 'y');
  sticky.lastIndex = 0;
  const match = sticky.exec(text);
  return match === null ? undefined : match[0].length;
}

describe('CSI byte classes match ink', () => {
  it('accepts a byte as a CSI final exactly when ink does', () => {
    for (let code = 0x00; code <= 0xff; code++) {
      const text = `${ESC}[${String.fromCharCode(code)}`;
      expect(csiMatchLength(text), `final 0x${code.toString(16)}`).toBe(
        inClass(code, 'csiFinal') ? 3 : undefined,
      );
    }
  });

  it('accepts a byte before a final exactly when ink calls it a parameter or intermediate', () => {
    for (let code = 0x00; code <= 0xff; code++) {
      const text = `${ESC}[${String.fromCharCode(code)}m`;
      // A byte that is itself a final ends the sequence at length 3; a parameter
      // or intermediate carries on to the `m` at length 4; anything else is not
      // a CSI at all. Asserting the LENGTH separates the three cases, which a
      // bare matched/not-matched assertion cannot.
      const expected = inClass(code, 'csiFinal')
        ? 3
        : inClass(code, 'csiParameter') || inClass(code, 'csiIntermediate')
          ? 4
          : undefined;
      expect(csiMatchLength(text), `body 0x${code.toString(16)}`).toBe(expected);
    }
  });
});

describe('ESC escape byte classes match ink', () => {
  it('completes a two-byte escape exactly on ink escape finals, and holds on ink intermediates', () => {
    for (let code = 0x00; code <= 0xff; code++) {
      const buf = `${ESC}${String.fromCharCode(code)}`;
      const expected =
        code === INK_INTRODUCERS.escape || inClass(code, 'c1Control')
          ? 1 // an introducer in its own right: hold the ESC and reconsider it
          : inClass(code, 'escapeIntermediate')
            ? -1 // intermediates seen, final not yet arrived
            : inClass(code, 'escapeFinal')
              ? 2 // complete two-byte escape
              : 1; // malformed: reconsider the byte after ESC
      expect(escEscapeEnd(buf, 0), `escape 0x${code.toString(16)}`).toBe(expected);
    }
  });
});

describe('introducer set matches ink', () => {
  it('treats exactly ink’s escape and C1 introducers as introducers', () => {
    const introducers = new Set<number>(Object.values(INK_INTRODUCERS));
    for (let code = 0x00; code <= 0xff; code++) {
      expect(isIntroducer(code), `code point 0x${code.toString(16)}`).toBe(introducers.has(code));
    }
  });
});

describe('terminators match ink', () => {
  it('ends an OSC at ink’s bell, treats it as data elsewhere, and honours the C1 ST everywhere', () => {
    const bell = String.fromCharCode(INK_TERMINATORS.bell);
    const st = String.fromCharCode(INK_TERMINATORS.stringTerminator);
    expect(sequenceEnd(`${ESC}]x${bell}`, 0), 'BEL ends an OSC').toBe(4);
    expect(sequenceEnd(`${ESC}_x${bell}`, 0), 'BEL is data inside an APC').toBe(-1);
    expect(sequenceEnd(`${ESC}]x${st}`, 0), 'C1 ST ends an OSC').toBe(4);
    expect(sequenceEnd(`${ESC}_x${st}`, 0), 'C1 ST ends an APC').toBe(4);
  });
});

describe('the vendored reference itself is well formed', () => {
  it('states every class as a non-empty ascending range', () => {
    for (const [name, [low, high]] of Object.entries(INK_BYTE_CLASSES)) {
      expect(low, `${name} low`).toBeLessThanOrEqual(high);
      expect(low, `${name} low`).toBeGreaterThanOrEqual(0);
      expect(high, `${name} high`).toBeLessThanOrEqual(0xff);
    }
  });
});
