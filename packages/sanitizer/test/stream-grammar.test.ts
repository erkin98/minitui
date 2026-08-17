import { describe, it, expect } from 'vitest';
import { csiEnd, sequenceEnd, splitTail } from '../src/stream-grammar.js';
import { CSI_SEQUENCE_SOURCE } from '../src/ansi.js';

const ESC = '\x1b';
const ST = '\x1b\\'; // String Terminator (ESC \)
const BEL = '\x07';

// The stream-completeness grammar used to live as nested declarations inside the
// sanitizeStream factory, so every property below could only be asserted
// indirectly through full-stream round trips. These are the direct assertions.

describe('sequenceEnd', () => {
  const cases: ReadonlyArray<{ name: string; buf: string; start?: number; end: number }> = [
    { name: 'lone trailing ESC is incomplete', buf: ESC, end: -1 },
    {
      name: 'doubled ESC ends at the second ESC so it is reconsidered',
      buf: `${ESC}${ESC}`,
      end: 1,
    },
    {
      name: 'ESC followed by a C1 introducer ends at the C1 so it introduces its own string',
      buf: `${ESC}\x9d`,
      end: 1,
    },
    { name: 'ESC + intermediate with no final yet is incomplete', buf: `${ESC}(`, end: -1 },
    { name: 'ESC + intermediates with no final yet is incomplete', buf: `${ESC}(!`, end: -1 },
    { name: 'ESC ( B completes past its final', buf: `${ESC}(B`, end: 3 },
    { name: 'a two-byte ESC escape completes past its final', buf: `${ESC}7`, end: 2 },
    { name: 'CSI completes past a 0x40-0x7e final', buf: `${ESC}[0m`, end: 4 },
    { name: 'C1 CSI (0x9b) completes past its final', buf: '\x9b2J', end: 3 },
    { name: 'CSI with no final yet is incomplete', buf: `${ESC}[1;2`, end: -1 },
    {
      name: 'CSI hitting a byte outside 0x20-0x7e stops at the offending index',
      buf: `${ESC}[1${BEL}m`,
      end: 3,
    },
    { name: 'unterminated OSC is incomplete', buf: `${ESC}]0;x`, end: -1 },
    { name: 'BEL-terminated OSC completes past the BEL', buf: `${ESC}]0;x${BEL}`, end: 6 },
    { name: 'ST-terminated OSC completes past the ST', buf: `${ESC}]0;x${ST}`, end: 7 },
    {
      name: 'unterminated APC is incomplete (BEL is data outside OSC)',
      buf: `${ESC}_d${BEL}`,
      end: -1,
    },
    { name: 'ST-terminated APC completes past the ST', buf: `${ESC}_d${ST}`, end: 5 },
    { name: 'a non-introducer byte advances one position', buf: 'a', end: 1 },
    { name: 'scanning starts at the given offset', buf: `xx${ESC}[0m`, start: 2, end: 6 },
  ];

  for (const { name, buf, start, end } of cases) {
    it(name, () => {
      expect(sequenceEnd(buf, start ?? 0)).toBe(end);
    });
  }
});

describe('splitTail', () => {
  it('emits a clean buffer whole and holds nothing', () => {
    expect(splitTail('hello world')).toEqual({ emit: 'hello world', hold: '' });
  });

  it('holds from a trailing unterminated sequence', () => {
    expect(splitTail(`ab${ESC}]0;x`)).toEqual({ emit: 'ab', hold: `${ESC}]0;x` });
  });

  it('holds from the START of an adjacency chain the cut lands inside', () => {
    // The first sequence ends exactly on the second introducer, so a cut inside
    // the run must carry the whole run.
    expect(splitTail(`${ESC}[m${ESC}]0;x`)).toEqual({ emit: '', hold: `${ESC}[m${ESC}]0;x` });
  });

  it('releases the chain once a sequence ends on a plain byte', () => {
    // Same adjacent pair, but the chain closes on `A`. The later unterminated
    // OSC must hold from ITSELF — a latched offset would hold the whole buffer.
    expect(splitTail(`${ESC}[m${ESC}[mA${ESC}]0;x`)).toEqual({
      emit: `${ESC}[m${ESC}[mA`,
      hold: `${ESC}]0;x`,
    });
  });
});

// The CSI byte grammar is spelled ONCE, in ansi.ts, and every consumer builds
// from that string. This table is the differential: the stream's completeness
// check and the strip's regex must agree on what a well-formed CSI is, byte for
// byte. Three spellings of one grammar is the precondition of the content-loss
// incident already recorded in ansi.ts — `ESC ; Z` silently deleting the Z.
describe('csiEnd agrees with the single CSI grammar source', () => {
  const rows: ReadonlyArray<{ text: string; wellFormed: boolean; offender?: number }> = [
    { text: `${ESC}[m`, wellFormed: true },
    { text: `${ESC}[1;2m`, wellFormed: true },
    { text: `${ESC}[1;2!m`, wellFormed: true },
    { text: '\x9b31m', wellFormed: true },
    // One row per byte-class EDGE, so narrowing any class by a single byte reds
    // this table. Without them the "one grammar source" claim is untested at the
    // boundaries: dropping 0x40 from the final class left the whole suite green.
    { text: `${ESC}[@`, wellFormed: true }, // final, low edge 0x40
    { text: `${ESC}[~`, wellFormed: true }, // final, high edge 0x7e
    { text: `${ESC}[0m`, wellFormed: true }, // parameter, low edge 0x30
    { text: `${ESC}[?m`, wellFormed: true }, // parameter, high edge 0x3f
    { text: `${ESC}[ m`, wellFormed: true }, // intermediate, low edge 0x20
    { text: `${ESC}[/m`, wellFormed: true }, // intermediate, high edge 0x2f
    // Out of order: a parameter byte (0x30-0x3f) AFTER an intermediate (0x20-0x2f).
    // The strip's regex does not match these at all; the stream's loop used to
    // accept them, making it strictly looser than the other two spellings.
    { text: `${ESC}[!1m`, wellFormed: false, offender: 3 },
    { text: `${ESC}[ ;m`, wellFormed: false, offender: 3 },
    { text: `${ESC}[/0H`, wellFormed: false, offender: 3 },
  ];

  for (const { text, wellFormed, offender } of rows) {
    it(`${wellFormed ? 'accepts' : 'rejects'} ${JSON.stringify(text)}`, () => {
      const sticky = new RegExp(CSI_SEQUENCE_SOURCE, 'y');
      sticky.lastIndex = 0;
      const match = sticky.exec(text);
      // The row's own claim is checked against the grammar source first, so the
      // table cannot drift away from the regex it is differentiating against.
      expect(match !== null, 'regex agrees with the row').toBe(wellFormed);
      const bodyStart = text.charCodeAt(0) === 0x1b ? 2 : 1;
      if (match !== null) {
        expect(csiEnd(text, bodyStart)).toBe(match[0].length);
      } else {
        expect(csiEnd(text, bodyStart)).toBe(offender);
      }
    });
  }

  it('still reports -1 when the buffer ends before a final byte', () => {
    expect(csiEnd(`${ESC}[1;2`, 2)).toBe(-1);
  });

  it('still stops at a byte that can never appear in a CSI', () => {
    expect(csiEnd(`${ESC}[1${BEL}m`, 2)).toBe(3);
  });
});
